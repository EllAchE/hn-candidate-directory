# Who wants to be hired directory

This repository is building a candidate-controlled, searchable directory from Hacker News “Who wants to be hired?” posts. The current flow supports private source-text and allowlisted LinkedIn URL ingestion, candidate review, explicit consent, refusal, publication, and token-verified update/removal management. Resume uploads and outbound email delivery are intentionally not part of this slice.

## What works

The same-origin Cloudflare Worker serves the static directory and six API route groups:

- `POST /api/submissions/text` accepts up to 100,000 UTF-8 bytes, writes a `submitted` D1 record with a hashed review token, creates a queued extraction job, and returns the one-time raw review token to the submitting tab.
- `POST /api/submissions/url` accepts one public HTTPS LinkedIn `/in/<slug>` URL, retrieves it through the fixed server-side String Web Access `/v1/fetch` transport, then writes the fetched text into the same private Queue and D1 path as source text. The endpoint rejects credentials, fragments, queries, non-HTTPS schemes, nonstandard ports, IP literals, localhost/private/link-local/metadata hosts, non-LinkedIn hosts, and non-profile paths before making the upstream request.
- `GET` and `PATCH /api/reviews/:submissionId` require that token, expose the asynchronous `review_ready` draft, and allow edits without publishing it.
- `POST /api/reviews/:submissionId/decision` requires the same token and an explicit `publish` or `refuse` decision. Publication accepts the exact reviewed draft in the request, atomically makes that revision public, and stamps `published_at`. Refusal archives a private draft; the same action withdraws a published profile. Repeated identical decisions are safe, while an archived revision cannot be published later.
- `POST /api/candidates/:candidateId/manage` accepts `update` or `remove` only after the bearer token matches the submission that owns that exact profile revision. Starting an update moves the published revision back to private `review_ready` state and hides it during editing; the candidate must review and explicitly consent again before it becomes searchable. Removal archives the revision immediately. Safe retries return the current state, while an archived profile cannot start another update.
- `GET /api/candidates` reads only revisions whose status is `published`. `submitted`, `processing`, `review_ready`, `archived`, and `failed` records cannot enter public search.

The Queue consumer extracts normalized locations, work modes, availability, universities, companies, skills, and date ranges. It clears the source text after successful processing and acknowledges redelivery of an already-ready draft without replacing it. The browser polls for the private draft and renders an editable review form. Saving remains separate from the consent checkbox and publish action. The raw management token is returned once, kept only in page memory, and never written to `localStorage`; D1 stores only its SHA-256 hash. Candidates may use that token to reopen a published profile for private editing or archive it. When the API is unavailable, the static demo can perform an in-tab source-text preview that cannot publish or manage a listing; URL retrieval has no browser-side fallback.

## URL retrieval controls

`worker.js` sends exactly one `GET` page request per accepted URL to `https://request.usestring.ai/v1/fetch` with `format: "json"`, `executeJS: false`, and CAPTCHA solving disabled. `UNBLOCKER_ORG_API_KEY` is read only from the Worker environment and sent only to that fixed service origin. The browser never receives it.

The application validates the narrow LinkedIn entry allowlist before retrieval and accepts only a valid 2xx String Web Access envelope. String Web Access owns DNS resolution and redirect-hop SSRF enforcement; the application neither follows redirects itself nor accepts a returned 3xx envelope. The adapter aborts after 12 seconds, reads no more than 750,000 response-envelope bytes, and accepts no more than 100,000 UTF-8 source bytes. Client failures contain stable error codes only: upstream response bodies, target details, bearer keys, and thrown transport messages are neither returned nor logged.

No schema change is needed for this increment. URL content enters the existing `source_kind = 'text'` pipeline, the submitted URL is not persisted, and fetched content is cleared after extraction. A canonical URL derives a deterministic 128-bit submission ID. D1's primary key provides durable and concurrent deduplication even after source clearing; a preflight lookup avoids a second billable retrieval for known submissions. Only a `failed` URL submission may be reset with a new token and queued again, which lets a transient Queue or extraction failure recover without weakening deduplication for active, review-ready, published, or archived submissions.

## Local verification

The automated tests use a dependency-free in-memory D1-shaped adapter and stub String Web Access; they make no live external requests and do not create or migrate a database.

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
- Queue producer `SUBMISSION_QUEUE`
- Queue consumer `hn-candidate-submissions`
- Static asset binding `ASSETS`

Before a future deployment, create the D1 database and queue, replace the placeholder database ID, apply `migrations/0001_review_drafts.sql`, set `UNBLOCKER_ORG_API_KEY` as a Worker secret, and verify the Worker routes on a non-production environment. No deployment, secret write, or production data write is part of this increment.
