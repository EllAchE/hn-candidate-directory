# Who wants to be hired directory

This repository is building a candidate-controlled, searchable directory from Hacker News “Who wants to be hired?” posts. The current flow supports private source-text ingestion, candidate review, explicit consent, refusal, publication, and withdrawal. Resume uploads, URL retrieval, email verification, and verified update/removal requests are intentionally not part of this slice.

## What works

The same-origin Cloudflare Worker serves the static directory and four API routes:

- `POST /api/submissions/text` accepts up to 100,000 UTF-8 bytes, writes a `submitted` D1 record with a hashed review token, creates a queued extraction job, and returns the one-time raw review token to the submitting tab.
- `GET` and `PATCH /api/reviews/:submissionId` require that token, expose the asynchronous `review_ready` draft, and allow edits without publishing it.
- `POST /api/reviews/:submissionId/decision` requires the same token and an explicit `publish` or `refuse` decision. Publication accepts the exact reviewed draft in the request, atomically makes that revision public, and stamps `published_at`. Refusal archives a private draft; the same action withdraws a published profile. Repeated identical decisions are safe, while an archived revision cannot be published later.
- `GET /api/candidates` reads only revisions whose status is `published`. `submitted`, `processing`, `review_ready`, `archived`, and `failed` records cannot enter public search.

The Queue consumer extracts normalized locations, work modes, availability, universities, companies, skills, and date ranges. It clears the source text after successful processing and acknowledges redelivery of an already-ready draft without replacing it. The browser polls for the private draft and renders an editable review form. Saving remains separate from the consent checkbox and publish action. Candidates may decline before publication or withdraw afterward; both states stay outside public search. When the API is unavailable, the static demo performs an in-tab preview that cannot publish.

`worker.js` contains no String Web Access or other service credential. Later URL ingestion will add the server-side String Web Access adapter and its allowlisting, SSRF, redirect, page, byte, deduplication, and redaction controls as a separate reviewable increment.

## Local verification

The automated tests use a dependency-free in-memory D1-shaped adapter; they do not create or migrate a database.

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

Before a future deployment, create the D1 database and queue, replace the placeholder database ID, apply `migrations/0001_review_drafts.sql`, and verify the Worker routes on a non-production environment. No deployment or production data write is part of this increment.
