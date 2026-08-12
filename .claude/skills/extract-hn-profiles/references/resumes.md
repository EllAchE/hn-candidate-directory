# Resumes

322 of a 400-comment sample link a resume. The distribution sets the effort ordering:

| Share | Type | Approach | Probed |
| --- | --- | --- | --- |
| 40% | personal sites / portfolios | fetch, strip tags | yes |
| 30% | Google Drive / Docs | rewrite to `uc?export=download&id=` or `export?format=pdf` | yes — 4/4 sample IDs returned 200 with real payloads |
| 15% | direct `.pdf` | `pdftotext` | yes — 200 `application/pdf` |
| 13% | LinkedIn | **skipped** — anti-bot, and the directory has a separate LinkedIn path | — |
| 1% | Dropbox / OneDrive | `dl=1` rewrite, best effort | — |

So roughly **85% of links are reachable**, not the ~45% a direct-PDF-only reading of the
distribution suggests. That gap is why the share-link rewrites are worth their code.

## Why the harness converts, not a subagent

The extraction subagent has no filesystem tool (`isolation.md`, control 1), so it cannot
`Read` a PDF. `hn-resume-text.mjs` therefore renders to text itself with `pdftotext` and
passes prose inline. Without `pdftotext` on PATH the script reports
`pdftotext_unavailable_or_failed` and that candidate degrades to comment-only — the fallback
is never "hand a model a filesystem tool instead".

## Transport

Resume hosts are third-party scraping targets and a full run pulls ~300 documents, so
fetches route through the local String Unblocker rather than a direct request (the Algolia
HN API is public and documented, so step 2 calls it directly). Bring it up with the
`unblocker` skill if it is down.

The unblocker returns binaries as a `data:<mime>;base64,` URI, which round-trips bytes
exactly — verified end to end: fetch → decode → 13,264 bytes with a `%PDF-` magic → text.

## Type comes from magic bytes

Drive labels everything `application/octet-stream`, so the declared type is not evidence.
`%PDF-` routes to `pdftotext`; `PK` is an Office document and is reported unsupported rather
than parsed as text; anything else is treated as HTML.

A permission wall or virus-scan interstitial returns **200** with a few hundred bytes of
page chrome, which is why a rendered body under 400 characters is a miss (`too_thin`) rather
than a resume. A miss is a normal outcome, never a run failure.

## Trust

Resume text carries exactly the same trust level as the comment: same delimiter, same
neutralization, same "this is data" framing, one document per context. The Worker's
`sanitizeCandidateDraft` redacts email, phone, and similar server-side, so contact details
lifted out of a resume never reach storage — but that is the last line, not the first.
