# Candidate directory operations

This runbook is the release boundary for the Cloudflare Worker, D1 database, and Queue. It deliberately separates local verification from Cloudflare mutations.

## Authorization boundary

Do not run a command in a **mutation** block until an operator explicitly authorizes that exact environment and block. Creating a D1 database or Queue; applying a migration; writing a secret; deploying or rolling back a Worker; changing traffic; running the write canary; and triggering a Hacker News ingest or setting a suppression tombstone are all external mutations. Staging approval does not authorize production. A deploy approval does not authorize a canary or rollback.

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

4. Copy `wrangler.toml` to the temporary config named in the table. Do not commit it. Set the environment-specific Worker and resource names. For this local-only check, replace the all-zero D1 ID with the syntactically valid placeholder `11111111-1111-1111-1111-111111111111`. Preserve these bindings exactly: `ASSETS`, `DB`, and `SUBMISSION_QUEUE`, plus the `[triggers]` cron schedule that drives Hacker News ingestion.
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

This is DDL and must be run by the authorized human operator, never by an agent. `migrations/0002_hacker_news_ingest.sql` rebuilds `submissions`, `jobs`, and `profile_revisions` to widen CHECK constraints SQLite cannot alter in place, so export the database first on any environment that already holds rows:

```sh
wrangler d1 export hn-candidate-directory-staging --remote --output /tmp/claude/hn-candidate-directory-staging-pre-0002.sql --config wrangler.staging.toml
wrangler d1 migrations list hn-candidate-directory-staging --remote --config wrangler.staging.toml
wrangler d1 migrations apply hn-candidate-directory-staging --remote --config wrangler.staging.toml
wrangler d1 migrations list hn-candidate-directory-staging --remote --config wrangler.staging.toml
```

Confirm `migrations/0001_review_drafts.sql`, `migrations/0002_hacker_news_ingest.sql`, and `migrations/0003_abuse_controls.sql` are each applied exactly once, and that the pre-migration row counts for `submissions`, `jobs`, and `profile_revisions` survived the rebuild. Do not deploy against an empty or partially migrated database. Migrations are forward-only; a failed rebuild is recovered by restoring the export, never by reversing the migration or hand-editing the schema.

### 3. Deploy the staging code — mutation

Capture the currently active version first if the Worker already exists:

```sh
wrangler deployments status --config wrangler.staging.toml
wrangler deploy --config wrangler.staging.toml
wrangler deployments status --config wrangler.staging.toml
```

Record the pre-deploy version, new version, staging URL, resource names, D1 ID, commit SHA, and UTC time. Confirm the bindings (`ASSETS`, `DB`, `SUBMISSION_QUEUE`, `RATE_LIMITER`) and the `17 */6 * * *` cron trigger in deploy output before continuing. `0003_abuse_controls.sql` must already be applied: the write quotas live in D1 and fail closed, so deploying this code against a database without `rate_limits` and `service_state` answers `503 rate_limit_unavailable` to every submission. The deploy arms that schedule, so treat it as authorizing outbound Hacker News requests and ingest writes on this environment.

### 4. Write the staging secrets — mutation and immediate deploy

`wrangler secret put` creates a new Worker version and deploys it immediately. Treat each one as a deploy, obtain a separate authorization, and re-record the active version afterward. Wrangler prompts for the value securely. `HN_INGEST_TOKEN` gates `POST /api/admin/ingest/hn`, `POST /api/admin/profiles/hn`, and `GET /api/admin/profiles/hn/pending`; generate a fresh random value per environment and never reuse the staging value in production:

```sh
wrangler secret put UNBLOCKER_ORG_API_KEY --config wrangler.staging.toml
wrangler secret put HN_INGEST_TOKEN --config wrangler.staging.toml
wrangler deployments status --config wrangler.staging.toml
```

`HN_INGEST_TOKEN` must be at least 32 characters; generate it with `openssl rand -hex 32`. A missing, blank, or shorter value is treated as *not configured*, not as *no auth required*: the on-demand route answers `503 ingest_not_configured` for every caller, authenticated or not. The scheduled trigger still runs, so the secret gates the manual endpoint only. Do not pass either value on the command line or place it in `.dev.vars`, config files, logs, or the change record. If the operator uses Wrangler's versioned-secret workflow instead, create the secret-bearing version with `wrangler versions secret put` and explicitly authorize the later `wrangler versions deploy`; creating the version does not itself authorize traffic changes.

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

### 8. First Hacker News ingest — mutation and externally visible traffic

The cron trigger fills the directory on its own within six hours. Run this block only to seed it immediately. It contacts the Hacker News Algolia API and publishes real people's public comments, so it needs its own authorization on each environment.

Preview extraction coverage first. This is read-only, touches no Cloudflare resource, and needs no deploy:

```sh
bun run preview:hn -- 1
```

Confirm the reported thread month, comment count, and per-field coverage look plausible before writing anything. Then trigger the ingest with the secret from step 4:

```sh
curl -sS -X POST https://<STAGING_WORKER_HOST>/api/admin/ingest/hn -H "Authorization: Bearer $HN_INGEST_TOKEN"
```

A `202` returns `{"threads":N,"queued":N,"skipped":N}`; the Queue consumer performs the writes, so published profiles appear over the following minutes. Re-running is safe and idempotent — a second call reports the same comments as skipped. Confirm afterwards that `/api/candidates` returns rows whose `sourceUrl` points at `news.ycombinator.com/item?id=<id>` and that no email address, phone number, or other redacted value appears in the response.

To suppress a specific ingested profile on request, an operator sets its tombstone. This is a data mutation requiring its own authorization, and it is the current manual stand-in until the removal endpoint ships:

```sh
wrangler d1 execute hn-candidate-directory-staging --remote --config wrangler.staging.toml \
  --command "UPDATE hn_ingests SET suppressed_at = datetime('now'), suppressed_reason = 'removal request', updated_at = datetime('now') WHERE hn_item_id = '<HN_ITEM_ID>'"
```

The row is never deleted. Suppression keyed on the Hacker News item id is what stops a later ingest from resurrecting the profile, so deleting the record instead would undo the removal on the next scheduled run.

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

After separate approvals, export the database and apply and verify the production migrations. The export is not optional: `0002` rebuilds three tables and copies their rows, and the only recovery from a failed rebuild is that file. `0003_abuse_controls.sql` only adds `rate_limits`, `service_state`, and one index, but it must land **before** the deploy — the write quotas fail closed without those tables.

```sh
wrangler d1 export hn-candidate-directory --remote --output /tmp/claude/hn-candidate-directory-pre-0002.sql --config wrangler.production.toml
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

With a separate secret-write/deploy authorization, enter the production values at Wrangler's prompt. Use a freshly generated `HN_INGEST_TOKEN`, not the staging one:

```sh
wrangler secret put UNBLOCKER_ORG_API_KEY --config wrangler.production.toml
wrangler secret put HN_INGEST_TOKEN --config wrangler.production.toml
wrangler deployments status --config wrangler.production.toml
```

Then obtain approval for read-only production traffic and run the smoke against the exact production host. A production write canary requires its own approval and follows the same synthetic publish/withdraw flow as staging.

```sh
bun run smoke:staging -- https://<PRODUCTION_WORKER_HOST>
```

Seeding the production directory immediately is a separate authorization again, and it publishes real comments. Preview first, then trigger once:

```sh
bun run preview:hn -- 1
curl -sS -X POST https://<PRODUCTION_WORKER_HOST>/api/admin/ingest/hn -H "Authorization: Bearer $HN_INGEST_TOKEN"
```

Skipping this block is safe; the cron trigger performs the same work within six hours.

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

## Abuse controls

The public upload endpoints are unauthenticated, so every write passes a quota before it reaches D1 or the Queue. All of it runs on the Cloudflare free tier.

| Control | Bucket | Limit |
| --- | --- | --- |
| Submission burst | per client address | 10 / 60s |
| Submission daily | per client address | 40 / 24h |
| Submission global | whole service | 3,000 / 6h |
| Authorization failure | per client address | 20 / 10m |
| Ingest request | per client address | 10 / 10m |
| Ingest run | whole service | 1 / 15m |

Counters live in the D1 `rate_limits` table as fixed windows, keyed on a salted hash of `cf-connecting-ip`. The `RATE_LIMITER` binding in `wrangler.toml` is a free per-colo pre-filter in front of those counters; it is best effort and never authoritative, so removing it costs throughput, not safety.

**These limits fail closed.** If D1 cannot serve the counter, submissions answer `503 rate_limit_unavailable` and nothing is written. A `503 rate_limit_unavailable` in production means the database is unreachable or migration `0003` has not been applied — it is not a tuning problem, and it must never be resolved by weakening the limiter.

Storage is bounded by a 5,000-row pending-submission cap and a 30-day expiry of abandoned `submitted` and `failed` rows, both maintained by the existing 6-hour cron. A full service answers `503 submission_capacity_reached`. Raising the cap is a reviewed code change, not a console edit.

Two optional plain vars tune this. Neither is required:

- `RATE_LIMIT_SALT` — salts the client-address hash so stored buckets are not reversible to raw addresses. Set a per-environment random value; defaults to a fixed string.
- `ALLOWED_ORIGINS` — comma-separated extra origins permitted to send writes. The Worker's own origin is always allowed and a browser write from any other origin is rejected `403 cross_origin_request_blocked`. Leave unset for the same-origin app.

```sh
wrangler secret put RATE_LIMIT_SALT --config wrangler.staging.toml
```

Paid upgrade path, if the free-tier controls stop being enough: a WAF rate-limiting rule enforces at the edge before the request reaches the Worker, Turnstile adds a challenge to the submission form, and Bot Management scores traffic. All three are paid and none are configured here.

## Failure playbooks

### Rate limiting or capacity rejections

- `429 rate_limited` is the control working. Confirm the source distribution before touching a limit; a single abusive address is expected to see this.
- `503 rate_limit_unavailable` is a D1 fault or a missing `0003` migration. Fix the database, do not relax the limiter.
- `503 submission_capacity_reached` means the pending backlog is at its cap. Check that the queue consumer is draining and that the 6-hour cron is firing before considering a cap change.
- Never disable a quota to clear a backlog. That converts a throttled incident into an unbounded write incident.

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

### Hacker News ingestion faults

- A wrong or bad-shaped Algolia response ends the run with `502 ingest_failed` and writes nothing. The next scheduled run retries; no manual cleanup is needed.
- Repeated ingest runs are idempotent, so a partially completed run is safe to repeat. Never clear `hn_ingests` to force a re-ingest: the recorded hashes are the deduplication key, and the suppression tombstones live in the same table.
- An extraction fix does not reach already-ingested profiles on its own, because their comment text is unchanged. Bump `HN_EXTRACTION_VERSION` in `worker.js` in the same PR as the fix; the next run re-derives every non-suppressed comment it discovers, updates the published rows in place, and the run after that skips them again. Suppressed rows stay suppressed at any version. A bumped run queues one message and roughly three D1 writes per comment in the two threads discovery returns, so treat it as a first ingest of those threads rather than a routine run.
- If a profile someone asked to remove reappears, that is an incident, not a retry. Confirm `suppressed_at` is set for its `hn_item_id` before doing anything else, and preserve the row.
- To stop ingestion entirely, remove the `[triggers]` block and deploy; that is an ordinary reviewed code change, not a console edit.

### Externally-extracted profiles

The scheduled ingest reads only labelled `Field: value` lines, which is why employer and education
coverage is near zero: that history is almost always in the unlabelled prose, and three quarters of
comments link a resume the Worker cannot read at all. A better extractor therefore runs outside the
Worker and pushes its results back through `POST /api/admin/profiles/hn`, gated on the same
`HN_INGEST_TOKEN`. `GET /api/admin/profiles/hn/pending?extractor=<id>` lists what it has not yet
improved.

Run the repository-local `$extract-hn-profiles` skill from this repository's root for the manual
extraction pass. Its helpers live under `scripts/extract-hn-profiles/`; the skill keeps the ingest
credential out of the model context and requires a review before the first push in a session.

Migration `0004_external_extraction.sql` must be applied **before** this code is deployed. The
scheduled ingest writes the new columns too, so a deploy that runs ahead of the migration breaks
ordinary ingestion, not just the new endpoint. It is additive (`ALTER TABLE ADD COLUMN`), so it does
not rebuild a table or disturb existing rows:

```bash
wrangler d1 migrations apply hn-candidate-directory --remote --config wrangler.production.toml
```

- Precedence, not recency, decides who wins. `profile_revisions.extractor_rank` blocks a lower-ranked
  extractor from overwriting a higher-ranked one, which is what stops an `HN_EXTRACTION_VERSION` bump
  from silently reverting every pushed profile to deterministic output.
- **Escape hatch:** to hand a profile back to the scheduled extractor, set its
  `profile_revisions.extractor_rank` to `0`. It will be re-derived on the next bumped run.
- A push writes the same `comment_hash` the scheduled path would, so an ordinary run afterwards
  reports `queued: 0` and a genuine comment edit still re-queues. An edited comment resets
  `hn_ingests.extractor_rank`, returning it to the pending set while its existing profile stays
  published — stale and good beats fresh and bad on a directory card.
- Pushes are rate-limited separately from the ingest run reservation, so a backfill of dozens of
  requests cannot starve the scheduled ingest.
- The endpoint re-validates, redacts, and bounds every draft server-side and refuses to resurrect a
  suppressed candidate, so a compromised or buggy extractor cannot widen what reaches the database.
  `hn_permalink` is always derived from the item id and never accepted from the caller.
- **TODO:** the extractor is invoked by hand today. Wire it to a scheduled refresh once it has proven
  out over a few manual runs.

### Pilot feedback

`POST /api/feedback` stores what the directory's feedback dialog collects. Migration
`0005_launch_feedback.sql` must be applied **before** the code is deployed; until the table exists
the endpoint answers `503` and the dialog reports the failure to the reader:

```bash
wrangler d1 migrations apply hn-candidate-directory --remote --config wrangler.production.toml
```

There is deliberately no route that reads the table back, so reports are only readable here:

```bash
wrangler d1 execute hn-candidate-directory --remote --config wrangler.production.toml \
  --command "SELECT created_at, contact, candidate_id, message FROM launch_feedback ORDER BY created_at DESC LIMIT 50"
```

- A report can name a person or quote a private detail, which is why it is write-only from the edge
  and never rendered anywhere in the directory.
- Ten reports per hour per client address, on the same fixed-window limiter as every other bucket.
- Removal is not feedback. The dialog points a candidate at the immediate self-serve removal instead,
  so a takedown never waits on someone reading this table.

### Sensitive-data exposure

- Treat a review token, source text, resume content, secret, email, phone, or private status on a public response or in logs as an incident.
- Stop canaries and promotion. Preserve restricted evidence without reposting the sensitive value.
- Roll back code only with explicit authorization; revoke or rotate an exposed secret through the separately authorized secret workflow.
- Verify the public endpoint is `Cache-Control: no-store`, contains only the documented candidate shape, and excludes non-published revisions before reopening traffic.
