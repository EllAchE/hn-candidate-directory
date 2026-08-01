# Who wants to be hired directory

This repository is building a candidate-controlled, searchable directory from Hacker News “Who wants to be hired?” posts. The current flow supports private source-text, plain-text resume, and allowlisted LinkedIn URL ingestion, candidate review, explicit consent, refusal, publication, and token-verified update/removal management. Outbound email delivery is intentionally not part of this slice.

## What works

The same-origin Cloudflare Worker serves the static directory and seven API route groups:

- `POST /api/submissions/text` accepts up to 100,000 UTF-8 bytes, writes a `submitted` D1 record with a hashed review token, creates a queued extraction job, and returns the one-time raw review token to the submitting tab.
- `POST /api/submissions/url` accepts one public HTTPS LinkedIn `/in/<slug>` URL, retrieves it through the fixed server-side String Web Access `/v1/fetch` transport, then writes the fetched text into the same private Queue and D1 path as source text. The endpoint rejects credentials, fragments, queries, non-HTTPS schemes, nonstandard ports, IP literals, localhost/private/link-local/metadata hosts, non-LinkedIn hosts, and non-profile paths before making the upstream request.
- `POST /api/submissions/resume` accepts the raw bytes of one UTF-8 `text/plain` `.txt` resume with a simple ASCII filename. It stages the exact validated bytes in private R2, enters the extracted text into the same D1 and Queue path, and returns no filename, object key, bucket detail, or source content. PDF, Word, HTML, archives, executables, and other binary formats are not supported.
- `GET` and `PATCH /api/reviews/:submissionId` require that token, expose the asynchronous `review_ready` draft, and allow edits without publishing it.
- `POST /api/reviews/:submissionId/decision` requires the same token and an explicit `publish` or `refuse` decision. Publication accepts the exact reviewed draft in the request, atomically makes that revision public, and stamps `published_at`. Refusal archives a private draft; the same action withdraws a published profile. Repeated identical decisions are safe, while an archived revision cannot be published later.
- `POST /api/candidates/:candidateId/manage` accepts `update` or `remove` only after the bearer token matches the submission that owns that exact profile revision. Starting an update moves the published revision back to private `review_ready` state and hides it during editing; the candidate must review and explicitly consent again before it becomes searchable. Removal archives the revision immediately. Safe retries return the current state, while an archived profile cannot start another update.
- `GET /api/candidates` reads only revisions whose status is `published`. `submitted`, `processing`, `review_ready`, `archived`, and `failed` records cannot enter public search.

The Queue consumer extracts normalized locations, work modes, availability, universities, companies, skills, and date ranges. One deterministic safety policy redacts extracted sensitive values before any source becomes a private review draft. It clears D1 source text and attempts to delete a staged resume object after successful processing, then acknowledges redelivery of an already-ready draft without replacing it. The browser polls for the private draft and renders an editable review form. Saving remains separate from the consent checkbox and publish action. The raw management token is returned once, kept only in page memory, and never written to `localStorage`; D1 stores only its SHA-256 hash. Candidates may use that token to reopen a published profile for private editing or archive it. When the API is unavailable, the static demo uses the same policy for an in-tab source-text preview that cannot publish or manage a listing; URL and resume ingestion have no browser-side fallback.

## Sensitive-field policy

The shared policy replaces detected values with the visible marker `[redacted]`; it never includes the detected value in an error or log. High-confidence matches cover email addresses, formatted or explicitly labeled phone numbers, SSNs, Luhn-valid 13–19 digit payment-card-like numbers, recognized private-key blocks even when truncated, credential/password/secret assignments, bearer/JWT and common provider-token shapes, and URLs carrying user information or secret-bearing query/fragment parameters. The policy is idempotent, so a candidate may save and approve an extracted draft that already contains the marker without another transformation.

The policy deliberately leaves professional names, roles, companies, schools, skills, ordinary locations, years/date ranges, software versions, compliance identifiers, postal codes, and clean public portfolio, GitHub, and LinkedIn URLs byte-for-byte unchanged. A candidate edit containing newly detected sensitive material is rejected with the stable `sensitive_review_draft` error rather than silently changed; the candidate therefore approves the same safe revision that is persisted and published. Private review serialization, publication decision responses, and `GET /api/candidates` apply the policy again so a pre-existing or otherwise persisted sensitive value cannot leak while it awaits cleanup.

Raw source handling is unchanged. D1 source text is private and cleared after successful extraction, while exact resume bytes remain in private R2 only through processing/retry and the configured 24-hour lifecycle backstop. The redacted fields, rather than the raw source, enter review and public serialization.

## Resume upload controls

Resume uploads use a raw request body so the Worker can reject a declared `Content-Length` above 100,000 bytes before reading and stop a chunked body as soon as buffering crosses the same limit. The endpoint requires `text/plain` with an optional UTF-8 charset plus a single-extension ASCII `.txt` filename. The filename is validated but never persisted or copied into R2 metadata.

Validation uses fatal UTF-8 decoding and rejects empty input, NUL and binary control characters, HTML markup, and leading signatures associated with PDF, ZIP and other archives, Windows/ELF/Mach-O/Java/WebAssembly executables, and common image formats. These checks deliberately define a plain-text first slice; they do not claim safe PDF or Word parsing.

SHA-256 of the exact file bytes derives the D1 submission ID. The D1 primary key establishes the race-safe deduplication winner before that request may write R2, so concurrent duplicate losers never stage, delete, or receive a review token. A separate domain-derived hash creates the server-only `resume-staging/` object key; clients choose neither bucket nor key, and the bucket has no public URL in the application.

R2 is transient staging rather than the extraction source of record. The existing `source_kind = 'text'` D1 row lets the current Queue consumer and a rolled-back Worker process the validated resume text without a migration. Successful extraction clears D1 text and best-effort deletes R2. Processing failures retain both copies for Queue retry; setup and Queue-send failures attempt object cleanup and return only stable errors. An R2 deletion failure does not turn a completed private draft into failed work because the lifecycle policy below is the cleanup backstop.

## URL retrieval controls

`worker.js` sends exactly one `GET` page request per accepted URL to `https://request.usestring.ai/v1/fetch` with `format: "json"`, `executeJS: false`, and CAPTCHA solving disabled. `UNBLOCKER_ORG_API_KEY` is read only from the Worker environment and sent only to that fixed service origin. The browser never receives it.

The application validates the narrow LinkedIn entry allowlist before retrieval and accepts only a valid 2xx String Web Access envelope. String Web Access owns DNS resolution and redirect-hop SSRF enforcement; the application neither follows redirects itself nor accepts a returned 3xx envelope. The adapter aborts after 12 seconds, reads no more than 750,000 response-envelope bytes, and accepts no more than 100,000 UTF-8 source bytes. Client failures contain stable error codes only: upstream response bodies, target details, bearer keys, and thrown transport messages are neither returned nor logged.

No schema change is needed for this increment. URL content enters the existing `source_kind = 'text'` pipeline, the submitted URL is not persisted, and fetched content is cleared after extraction. A canonical URL derives a deterministic 128-bit submission ID. D1's primary key provides durable and concurrent deduplication even after source clearing; a preflight lookup avoids a second billable retrieval for known submissions. Only a `failed` URL submission may be reset with a new token and queued again, which lets a transient Queue or extraction failure recover without weakening deduplication for active, review-ready, published, or archived submissions.

## Local verification

The automated tests use dependency-free in-memory D1, Queue, R2, and String Web Access doubles; they make no live cloud requests and do not create or migrate a database.

```sh
bun test
bun run check
```

To exercise real local D1 and Queue bindings, install Wrangler separately, replace the placeholder D1 ID in `wrangler.toml`, and have an operator run:

```sh
wrangler d1 migrations apply hn-candidate-directory --local
wrangler dev
```

The first command applies DDL, so agents must surface it for a human rather than running it. Open the URL printed by Wrangler, submit labeled source text, and keep the tab open while the local queue produces the token-gated review draft.

## Cloudflare resources

`wrangler.toml` declares these bindings:

- D1 database `DB`
- private R2 bucket `RESUME_STAGING`
- Queue producer `SUBMISSION_QUEUE`
- Queue consumer `hn-candidate-submissions`
- Static asset binding `ASSETS`

Before a future deployment, an operator must create the D1 database, Queue, and private R2 bucket; replace the placeholder database ID; apply `migrations/0001_review_drafts.sql`; set `UNBLOCKER_ORG_API_KEY` as a Worker secret; and verify the Worker routes on a non-production environment. Configure the R2 bucket with no public/custom domain and a lifecycle rule that deletes the `resume-staging/` prefix after 24 hours. That short retention is the backstop for terminal Queue failures, interrupted setup, deletion errors, and rollback to a Worker version that does not know about R2.

No new D1 migration is needed for resume uploads or sensitive-field redaction. Roll out the private bucket binding and lifecycle before deploying this Worker. A rollback may restore the previous Worker immediately: validated resume text already resides in the old `source_kind = 'text'` path, and the 24-hour lifecycle removes the staging object that the older Queue consumer will not delete. The serialization boundary in this version protects older persisted rows without a backfill. No deployment, bucket creation/configuration, DDL, secret write, or production/client data write was performed in this increment.
