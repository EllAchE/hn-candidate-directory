# Candidate directory operations

This runbook is the release boundary for the Cloudflare Worker, D1 database, and Queue. It deliberately separates local verification from Cloudflare mutations.

## Authorization boundary

Do not run a command in a **mutation** block until an operator explicitly authorizes that exact environment and block. Creating a D1 database or Queue; applying a migration; writing a secret; deploying or rolling back a Worker; changing traffic; and running the write canary are all external mutations. Staging approval does not authorize production. A deploy approval does not authorize a canary or rollback.

The commands below are instructions for a human operator. They were not run while this runbook was authored. Never paste a secret into a command argument, commit a generated environment config, or delete durable resources as part of a code rollback.

## Topology and names

| Component | Staging | Production |
| --- | --- | --- |
| Worker | `hn-candidate-directory-staging` | `hn-candidate-directory` |
| D1 | `hn-candidate-directory-staging` | `hn-candidate-directory` |
| Queue | `hn-candidate-submissions-staging` | `hn-candidate-submissions` |
| Temporary config | `wrangler.staging.toml` | `wrangler.production.toml` |

Uploaded resume content is held only as `submissions.source_text` in D1 and is cleared on successful extraction. The deployment requires no object storage.

## Prerequisites and local release gate

1. Start from a clean, reviewed commit. Record the signed commit SHA and PR URL in the change record.
2. Use an operator-approved, pinned Wrangler version and an authenticated Cloudflare account with access only to the intended account. Confirm the account before any mutation with `wrangler whoami`.
3. Run the local gate:

   ```sh
   bun run check
   git diff --check
   ```

4. Copy `wrangler.toml` to the temporary config named in the table. Do not commit it. Set the environment-specific Worker and resource names. For this local-only check, replace the all-zero D1 ID with the syntactically valid placeholder `11111111-1111-1111-1111-111111111111`. Preserve these bindings exactly: `ASSETS`, `DB`, and `SUBMISSION_QUEUE`.
5. Inspect the deploy bundle without contacting a live Worker:

   ```sh
   wrangler deploy --dry-run --outdir /tmp/claude/hn-candidate-directory-dry-run --config wrangler.<ENVIRONMENT>.toml
   ```

   Review the output before proceeding. The committed `[assets]` directory is `.`; confirm the asset manifest contains only intentionally public static assets. Stop if private data, credentials, generated environment configs, operator documentation, scripts, tests, migrations, Worker source, or local artifacts appear.

   `test/assets-manifest.test.js` pins the publishable set to `sensitive-data.js`, `who-is-hiring.css`, `who-is-hiring.html`, and `who-is-hiring.js`, so `bun run check` in step 3 already fails on a stray artifact. The dry-run review stays the authority: it sees the working tree the deploy will actually upload, including files created after the gate ran.

Before any deploy, the environment config must have this effective shape:

```toml
name = "<WORKER_NAME>"
main = "worker.js"
compatibility_date = "2026-08-01"

[assets]
directory = "."
binding = "ASSETS"
run_worker_first = true

[[d1_databases]]
binding = "DB"
database_name = "<D1_NAME>"
database_id = "<D1_ID_FROM_CREATE>"
migrations_dir = "migrations"

[[queues.producers]]
binding = "SUBMISSION_QUEUE"
queue = "<QUEUE_NAME>"

[[queues.consumers]]
queue = "<QUEUE_NAME>"
max_batch_size = 10
max_batch_timeout = 5
max_retries = 3
```

## Staging rollout

Obtain separate operator approval for each mutation block. Stop on any unexpected account, identifier, binding, or command output.

### 1. Create staging resources — mutation

```sh
wrangler d1 create hn-candidate-directory-staging --config wrangler.staging.toml --update-config=false
wrangler queues create hn-candidate-submissions-staging --config wrangler.staging.toml
```

Copy the returned D1 database ID into `wrangler.staging.toml`, replacing the local-only placeholder. Do not substitute the database name where the config requires an ID.

Inspect the deploy bundle locally before another mutation:

```sh
wrangler deploy --dry-run --outdir /tmp/claude/hn-candidate-directory-staging-dry-run --config wrangler.staging.toml
```

Confirm the result matches the pre-creation dry run before proceeding.

### 2. Apply the staging schema — mutation

This is DDL and must be run by the authorized human operator, never by an agent:

```sh
wrangler d1 migrations list hn-candidate-directory-staging --remote --config wrangler.staging.toml
wrangler d1 migrations apply hn-candidate-directory-staging --remote --config wrangler.staging.toml
wrangler d1 migrations list hn-candidate-directory-staging --remote --config wrangler.staging.toml
```

Confirm `migrations/0001_review_drafts.sql` is applied exactly once. Do not deploy against an empty or partially migrated database.

### 3. Deploy the staging code — mutation

Capture the currently active version first if the Worker already exists:

```sh
wrangler deployments status --config wrangler.staging.toml
wrangler deploy --config wrangler.staging.toml
wrangler deployments status --config wrangler.staging.toml
```

Record the pre-deploy version, new version, staging URL, resource names, D1 ID, commit SHA, and UTC time. Confirm the three bindings in deploy output before continuing.

### 4. Write the staging Web Access secret — mutation and immediate deploy

`wrangler secret put` creates a new Worker version and deploys it immediately. Treat it as a deploy, obtain a separate authorization, and re-record the active version afterward. Wrangler prompts for the value securely:

```sh
wrangler secret put UNBLOCKER_ORG_API_KEY --config wrangler.staging.toml
wrangler deployments status --config wrangler.staging.toml
```

Do not pass the value on the command line or place it in `.dev.vars`, config files, logs, or the change record. If the operator uses Wrangler's versioned-secret workflow instead, create the secret-bearing version with `wrangler versions secret put` and explicitly authorize the later `wrangler versions deploy`; creating the version does not itself authorize traffic changes.

### 5. Read-only staging smoke — externally visible traffic

After explicit authorization to contact the staging URL, run:

```sh
bun run smoke:staging -- https://<STAGING_WORKER_HOST>
```

The dependency-free smoke performs bounded same-origin `GET` requests only. It rejects redirects, non-HTTPS non-loopback targets, cross-origin assets, slow or oversized bodies, wrong content types, non-2xx responses, cacheable candidate JSON, malformed public shapes, and recursively exposed private keys. It never submits or changes candidate data.

Expected output resembles:

```text
Staging smoke passed: 2 assets, 0 public candidates
```

An existing staging directory may report a nonzero candidate count. Any failure blocks rollout.

### 6. Observe before canary

With read-only access authorized, inspect Worker logs, request/error rates, Queue backlog and consumer failures, and D1 errors and latency. Keep a tail open only for the bounded observation window:

```sh
wrangler tail --config wrangler.staging.toml
```

No secret, review token, source text, resume content, or authorization header may appear in logs. Stop and enter incident handling if it does.

### 7. Controlled staging canary — mutation

Obtain explicit canary authorization. In a private browser window, use the staging UI to perform one synthetic flow with unmistakably fictional data:

1. Submit source text; do not use a real resume or LinkedIn profile.
2. Record the submission ID and review token in an approved ephemeral secret store, not chat or the change record.
3. Confirm the candidate is absent from `/api/candidates` while queued and review-ready.
4. Confirm Queue processing produces a private draft and clears stored source text.
5. Edit the draft, explicitly publish it, and confirm only the documented public fields appear.
6. Use the same private token to withdraw the candidate. Confirm it disappears from the public endpoint.
7. Confirm no sensitive value reached logs.

Delete no durable resource after the canary. Retain only the non-sensitive evidence: timestamps, HTTP status classes, and pass/fail results.

## Production promotion

Production is a fresh authorization boundary. Repeat the staging sequence with `wrangler.production.toml` and the production names in the topology table; never point production at staging resources.

### Production resource creation — mutation

Run these only if the corresponding production resources do not already exist:

```sh
wrangler d1 create hn-candidate-directory --config wrangler.production.toml --update-config=false
wrangler queues create hn-candidate-submissions --config wrangler.production.toml
```

If a resource exists, inspect and reuse it only after its ownership and data-retention policy are verified. Never recreate, replace, or delete it to make a command pass.

### Production schema, deploy, and secret — separate mutations

After separate approvals, apply and verify the production migration:

```sh
wrangler d1 migrations list hn-candidate-directory --remote --config wrangler.production.toml
wrangler d1 migrations apply hn-candidate-directory --remote --config wrangler.production.toml
wrangler d1 migrations list hn-candidate-directory --remote --config wrangler.production.toml
```

Record the current version, deploy the reviewed commit, and record the new version:

```sh
wrangler deployments status --config wrangler.production.toml
wrangler deploy --config wrangler.production.toml
wrangler deployments status --config wrangler.production.toml
```

With a separate secret-write/deploy authorization, enter the production value at Wrangler's prompt:

```sh
wrangler secret put UNBLOCKER_ORG_API_KEY --config wrangler.production.toml
wrangler deployments status --config wrangler.production.toml
```

Then obtain approval for read-only production traffic and run the smoke against the exact production host. A production write canary requires its own approval and follows the same synthetic publish/withdraw flow as staging.

```sh
bun run smoke:staging -- https://<PRODUCTION_WORKER_HOST>
```

Promote only after staging smoke, staging canary, production smoke, binding verification, and the observation window all pass. Record operator, approvals, version IDs, resource IDs, commit SHA, UTC times, and rollback target without recording private values.

## Rollback checklist

A rollback changes live traffic immediately and requires explicit authorization for the exact environment and target version.

1. Freeze further deploys and write canaries. Record symptoms, first failure time, active version, intended target version, Queue backlog, and whether messages are in flight.
2. Verify the target version predates the regression and is compatible with the current D1 schema and bindings.
3. Authorize and run the environment-specific rollback:

   ```sh
   wrangler rollback <KNOWN_GOOD_VERSION_ID> --config wrangler.<ENVIRONMENT>.toml
   wrangler deployments status --config wrangler.<ENVIRONMENT>.toml
   ```

4. With read-only traffic authorized, run the smoke against that environment and observe logs, Queue processing, and D1.
5. Do not delete, recreate, empty, or rename D1 or the Queue during code rollback. Worker rollback does not revert durable resources, migrations, secrets, queued/in-flight messages, lifecycle rules, or candidate data.
6. Do not reverse a D1 migration. If an older Worker is not forward-compatible with the current schema, keep traffic on a compatible version and prepare a reviewed forward fix.
7. Close the incident only after public reads, private review isolation, Queue drain, and redaction checks are healthy.

## Failure playbooks

### Queue backlog, retries, or consumer failure

- Stop write canaries and new promotions; public directory reads may remain available if healthy.
- Record backlog, oldest-message age, consumer errors, active Worker version, and in-flight work.
- Do not purge or recreate the Queue. Messages can be retried, so preserve submission idempotency and expect duplicate delivery.
- Fix the consumer or roll back code only after checking schema compatibility. Observe until backlog and retry rate return to normal.
- Sample logs by submission ID only. Never log or copy source text or review tokens.

### D1 errors or migration mismatch

- Stop write canaries and promotion. Preserve the database and capture the migration list, query error class, active Worker version, and Queue backlog.
- Do not run ad hoc DDL, reverse migrations, delete rows, or recreate the database.
- If public reads fail, authorize a code rollback only to a version compatible with the current schema. Otherwise ship a reviewed forward-compatible fix.
- Resume consumers cautiously after verifying writes are idempotent and all expected tables and indexes exist.

### Sensitive-data exposure

- Treat a review token, source text, resume content, secret, email, phone, or private status on a public response or in logs as an incident.
- Stop canaries and promotion. Preserve restricted evidence without reposting the sensitive value.
- Roll back code only with explicit authorization; revoke or rotate an exposed secret through the separately authorized secret workflow.
- Verify the public endpoint is `Cache-Control: no-store`, contains only the documented candidate shape, and excludes non-published revisions before reopening traffic.
