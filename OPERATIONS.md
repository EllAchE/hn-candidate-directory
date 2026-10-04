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

`wrangler secret put` creates a new Worker version and deploys it immediately. Treat each one as a deploy, obtain a separate authorization, and re-record the active version afterward. Wrangler prompts for the value securely. `HN_INGEST_TOKEN` gates `POST /api/admin/ingest/hn`, `POST /api/admin/profiles/hn`, `GET /api/admin/profiles/hn/pending`, `POST /api/ingest/requeue`, and `GET /api/ingest/step-outs`; generate a fresh random value per environment and never reuse the staging value in production:

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
- Two step-outs take a row off the pending head without writing a profile, addressed by
  `hnItemId`: `draft: null` retires a comment whose text Algolia no longer serves, and `hold: true`
  parks one whose draft the operator will not publish. Both raise `hn_ingests.extractor_rank`, so an
  already-published profile stays published, and registering a newer extractor re-queues them. Each
  one is recorded, not discarded: see "Step-outs" below. Deploy the Worker before running a
  `devbox-run-page.sh` that sends them: an older Worker answers each one `invalid_comment` and the
  row stays pending.
- Pushes are rate-limited separately from the ingest run reservation, so a backfill of dozens of
  requests cannot starve the scheduled ingest.
- The endpoint re-validates, redacts, and bounds every draft server-side and refuses to resurrect a
  suppressed candidate, so a compromised or buggy extractor cannot widen what reaches the database.
  `hn_permalink` is always derived from the item id and never accepted from the caller.
- `workMode` and `availability` are **coerced, not accepted**, on every write path — see "Facet
  vocabularies" below. An extractor is free to send whatever a comment says; only the canonical value
  is stored.
- **TODO:** the extractor is invoked by hand today. Wire it to a scheduled refresh once it has proven
  out over a few manual runs.

#### Step-outs

Every hold and retirement is recorded on its `hn_ingests` row, so a row the page run set aside can be
found and retried later instead of waiting for a new extractor:

| Column | Meaning |
| --- | --- |
| `step_out` | `held`, `retired`, `requeued`, or `NULL` (never stepped out, or a draft since reached it) |
| `step_out_reason` | why, from the vocabulary below; kept through a requeue and cleared by a draft |
| `step_out_at` | when the step-out was recorded |
| `step_out_extractor` | the extractor that stepped it out; kept after a draft lands |
| `step_out_count` | how many times the row has stepped out; never reset |

Reasons are validated per kind; anything else is answered `invalid_reason` and changes nothing.
Holds: `no_draft_batch`, `draft_missing`, `source_alive`, `source_unreachable`, `flagged`, `other`.
Retirements: `deleted`, `dead`, `missing`, `textless`, and `not_a_candidate` (the extractor returned no
draft because the comment is not a candidate post). A step-out sent without a reason is stored as
`unrecorded`. `devbox-run-page.sh` sends the reason on every hold (from `holds.json`) and every
retirement (from `sources.json`).

A step-out that carries `restate: true` only records a reason: it fills in `unrecorded` or a missing
record, never overwrites a recorded reason, never moves the rank, and answers `not_stepped_out` for
a row that is back in the queue and `already_drafted` for one a draft has reached. That is what makes
the backfill below safe to re-run.

**Deploy order.** Each step depends on the one before it:

1. A human applies migration `0007_step_outs.sql` (additive `ADD COLUMN`s and one index). The new
   Worker reads these columns on every push, so it must not run ahead of the migration:

   ```bash
   wrangler d1 migrations list hn-candidate-directory --remote --config wrangler.production.toml
   wrangler d1 migrations apply hn-candidate-directory --remote --config wrangler.production.toml
   ```

2. Deploy the Worker.
3. Name the reasons for the step-outs that earlier page runs already made. The backfill reads the run
   directories under `/tmp/claude/hncd/` on the machine that ran them, skips a tag that is still
   running, and restates only payloads whose `pushed-*` marker exists. Dry-run first and read the
   per-tag report on stderr:

   ```bash
   node scripts/extract-hn-profiles/backfill-step-outs.mjs
   node scripts/extract-hn-profiles/backfill-step-outs.mjs --send --host "$HNCD_HOST"
   ```

4. Mark the rest. Rows stepped out before `0007` that no run directory names (other machines, deleted
   directories) still look like ordinary processed rows. The manual SQL marks every unsuppressed row
   that a model extractor reached (`extractor_rank >= 1`) but that has no published model-written
   revision (`profile_revisions.extractor_rank >= 1`) and no recorded step-out as `held` /
   `unrecorded`. That is wider than "no published revision": a held item whose deterministic rank-0
   profile is public was still held by the model pass, and belongs here. It is idempotent, and either
   order with step 3 is safe, since a restatement upgrades an `unrecorded` reason it can name; running
   it after step 3 just leaves less to upgrade:

   ```bash
   wrangler d1 execute hn-candidate-directory --remote --config wrangler.production.toml \
     --file migrations/manual/2026-09-28-backfill-unrecorded-step-outs.sql
   ```

   `migrations/manual/` is outside what `migrations apply` reads, so this never runs by accident.

**Reading them.** `GET /api/ingest/step-outs` (same `HN_INGEST_TOKEN`) returns `counts` grouped by
`stepOut` and `reason`, and `recovered`, the rows a later draft brought back. Add `reason=<reason>`
to list those items 100 at a time (`stepOut=held|retired|requeued` to narrow, `after=<nextAfter>` to
page):

```bash
node scripts/extract-hn-profiles/hncd-api.mjs step-outs
node scripts/extract-hn-profiles/hncd-api.mjs step-outs --reason draft_missing --step-out held
```

**Retrying them.** `POST /api/ingest/requeue` puts rows back on the pending page. The body is
`{"reason": "<reason>"}`, `{"hnItemIds": ["<id>", ...]}` (at most 25), or both, which requeues only
the listed ids that have that reason. A requeued row gets `step_out = 'requeued'` and
`extractor_rank = MIN(extractor_rank, 1)`: it is pending for the current extractor again, keeps its
Processed badge, and any published profile stays published. The reason is kept, so a second requeue
of the same reason is a no-op; if the row steps out again the count goes up and the new reason
replaces it.

```bash
node scripts/extract-hn-profiles/hncd-api.mjs requeue --reason no_draft_batch
node scripts/extract-hn-profiles/hncd-api.mjs requeue --ids 41234567,41234568
```

- A reason alone reaches `held` rows only; its response counts the matching `retired` rows in
  `retiredNotRequeued`. A retired comment is gone at the source, so it comes back by id or not at all.
- By id, every id lands in exactly one bucket: `requeued`, `alreadyRequeued`, `notSteppedOut`,
  `reasonMismatch`, `suppressed`, or `unknown`. A suppressed row is never requeued.
- The response ends with `pending`, the queue length afterwards. Requeued rows head the next pages,
  so requeue one reason at a time and let a page run drain it.

### Facet vocabularies

`workMode` and `availability` drive the directory's filters, so they hold a closed vocabulary rather
than whatever a comment happens to say. `HN_WORK_MODES` is `Remote` / `Hybrid` / `On-site` /
`Flexible`; `HN_AVAILABILITIES` is `Immediately` / `Notice period` / `Future date`. Anything
unrecognized becomes `Not specified` — the sentence itself survives verbatim in `summary`, which is
what a reader actually wants, and is not lost.

This is a data-quality control, not a display preference. Before it, both fields stored the stated
text verbatim, so one meaning became several filter options: `Immediately`,
`immediate — open to contract or full-time` and `Immediately | Full-time or contract` each appeared
as its own choice, and `mode` offered seven values for four arrangements. A filter that does not
group is worse than no filter.

- **Enforced in `validateDraft`, not only in the deterministic pass.** The push endpoint exists to
  overwrite that pass, so normalizing one side alone would last exactly until the first backfill ran.
- **The review form is unaffected.** Its `Needs review` placeholder is built before validation, so a
  reviewer still sees the prompt; the value is canonicalized when the profile publishes, so the
  placeholder never becomes a public filter option.
- **Changing a vocabulary is an `HN_EXTRACTION_VERSION` bump**, same as any other extraction change.
  Already-published rows keep their old value until a bumped run re-derives them.

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

### Profile links and the HN handle

`profile_revisions` carries `hn_username`, `linkedin_url`, `github_url` and `personal_url`. Migration
`0006_profile_links.sql` must be applied **before** this code is deployed: the scheduled ingest writes
all four columns, so a deploy that runs ahead of it breaks ordinary ingestion rather than just the new
fields. It is additive (`ALTER TABLE ADD COLUMN`), so no table is rebuilt and no existing row moves:

```bash
wrangler d1 migrations apply hn-candidate-directory --remote --config wrangler.production.toml
```

- `hn_username` is **derived, never accepted** — the Worker overwrites whatever a caller sends with the
  comment's own author, for the same reason `hn_permalink` is derived from the item id. Otherwise
  anyone holding `HN_INGEST_TOKEN` could attribute a profile to someone else's HN identity on a public
  card. It also separates the handle from `name`, which until now held the handle whenever a comment
  carried no labelled name line. The review form deliberately does not offer the field: a
  self-submitted profile has no HN comment behind it, so a handle typed there would be an unverified
  claim rendered exactly like an ingested one.
- Links are stored **canonicalized**, not as written: https only, credentials and port rejected,
  query and fragment dropped, LinkedIn folded to `https://www.linkedin.com/in/<slug>` and GitHub to
  `https://github.com/<login>`. A query string on a profile link is tracking or a session, never part
  of the destination, so removing it removes the surface rather than filtering it.
- The three link columns are **disjoint by construction**: a LinkedIn or GitHub URL is refused for
  `personal_url`, so a company page cannot end up presented as somebody's own website.
- A URL whose *path* spells out a contact detail is **rejected, not redacted** — everywhere else the
  draft is redacted, but `[redacted]` inside an `href` yields a broken link rather than a private one.
- Omitting a link field in a push means "I did not look", and the Worker fills it from the links the
  deterministic pass reads out of the comment. Sending `""` means "this person has no LinkedIn" and
  clears it. Without that distinction an extractor written against the previous draft shape would
  blank links on every profile it touched, because the rank guard only stops a *lower*-ranked writer.

### Sensitive-data exposure

- Treat a review token, source text, resume content, secret, email, phone, or private status on a public response or in logs as an incident.
- Stop canaries and promotion. Preserve restricted evidence without reposting the sensitive value.
- Roll back code only with explicit authorization; revoke or rotate an exposed secret through the separately authorized secret workflow.
- Verify the public endpoint is `Cache-Control: no-store`, contains only the documented candidate shape, and excludes non-published revisions before reopening traffic.

### Professional experience

`experience` is either `null` (unknown) or `{ minYears, maxYears }`. Exact values have equal bounds;
ranges preserve both bounds; a stated lower bound such as 5+ uses `maxYears: null`. Values are numeric
years from 0 through 80. Only explicit totals are extracted; education dates and skill-specific
durations do not establish a professional total, and the current untyped date ranges are not summed.
Conflicting explicit totals remain unknown. Reviewers can enter 5, 5+, or 3–5, or clear the value.

Filters use established lower bounds: 5+ years matches a profile stating 5–7 or 5+, while 3–7 does
not establish at least five. Under 2 requires a known upper bound below two. Unknown and Experience
provided are explicit choices. Selections within this facet are OR; other facets combine with AND.
An account's newest source supplies its experience; older submissions do not silently fill a missing
current total. Existing rows remain unknown until individually enriched; no extraction-version bump
or blanket requeue accompanies this feature.

A human must apply `0008_experience.sql` before deploying code that reads/writes `experience_json`:

```sh
wrangler d1 migrations apply hn-candidate-directory --remote --config wrangler.production.toml
```

Migration execution, release, and historical enrichment are separate operations. Review the pending
migration list and obtain the required exact production scope before release.

### Organization logos

Cards, profile pages, and profile dialogs show small site icons beside matched company and university
names. Google’s favicon service supplies 64-pixel images for curated official domains; it can redirect
to Google’s static-image hosts. Text remains the authoritative label. Images are decorative, fixed-size,
lazy-loaded, asynchronously decoded, and sent without a referrer. A failed image is removed and its URL
is not retried on each filter change. Missing and ambiguous matches render text without an image.

The initial mappings were checked against the organizations’ own websites:

| Organization | Official website |
| --- | --- |
| Google | https://about.google/ (product domain google.com) |
| Microsoft | https://www.microsoft.com/ |
| Meta | https://www.meta.com/about/ |
| Stripe | https://stripe.com/ |
| Stanford University | https://www.stanford.edu/ |
| Massachusetts Institute of Technology | https://www.mit.edu/ |
| University of Waterloo | https://uwaterloo.ca/ |
| Georgia Institute of Technology | https://www.gatech.edu/ |
| Carnegie Mellon University | https://www.cmu.edu/ |

`organization-logos.js` owns exact aliases and official domains, separately for companies and schools.
Case and whitespace normalize, but substrings, URLs, and fuzzy names do not match. Ambiguous initials
such as CMU and UW have no mapping. Add an alias only after verifying its institution and domain;
a logo is not evidence that a candidate attended or worked there. This presentation layer does not
change extraction, employment/attendance checks, stored names, or filters. No credentials or candidate
content are included in icon URLs. If the provider is unavailable, browsing continues with text labels.
