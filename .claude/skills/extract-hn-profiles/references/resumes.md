# Resumes

322 of a 400-comment sample link a resume. The distribution sets the effort ordering:

| Share | Type | Approach | Probed |
| --- | --- | --- | --- |
| 40% | personal sites / portfolios | fetch, strip tags | yes |
| 30% | Google Drive / Docs | rewrite to `uc?export=download&id=` or `export?format=pdf` | yes — 4/4 sample IDs returned 200 with real payloads |
| 15% | direct `.pdf` | inspector markdown, `pdftotext` fallback | yes — 200 `application/pdf` |
| 13% | LinkedIn | **skipped** — anti-bot, and the directory has a separate LinkedIn path | — |
| 1% | Dropbox / OneDrive | `dl=1` rewrite, best effort | — |

So roughly **85% of links are reachable**, not the ~45% a direct-PDF-only reading of the
distribution suggests. That gap is why the share-link rewrites are worth their code.

## Why the harness converts, not a subagent

The extraction subagent has no filesystem tool (`isolation.md`, control 1), so it cannot
`Read` a PDF. `hn-resume-text.mjs` therefore renders to text itself and passes prose inline.
When neither renderer produces text the script reports `pdftotext_unavailable_or_failed` and
that candidate degrades to comment-only — the fallback is never "hand a model a filesystem
tool instead".

A resume is read for structure, not character count. `@firecrawl/pdf-inspector` returns
per-page markdown, and its headings and bullets are what let the extractor attach a date
range to the right employer; `pdftotext` returns the same words as an undifferentiated wall.
Measured on two corpus resumes the two agree on text volume within 4%, and the markdown
carries 8 and 9 headings where `pdftotext` carries none. `pdftotext` stays as the fallback:
the inspector's binding is native and per-platform, so a checkout that has not installed it
degrades rather than failing the run.

## Transport

Resume hosts are third-party scraping targets and a full run pulls ~300 documents, so
fetches route through String Web Access rather than a direct request (the Algolia HN API is
public and documented, so step 2 calls it directly). `hn-fetch-endpoint.mjs` resolves which
surface answers: with an org key in the environment it is the hosted API, the same one
`worker.js` already calls in production, so no local process has to be running. `UNBLOCKER_URL`
selects an unauthenticated shim on `:7654` instead — it re-points the request, never the
credential, which is only ever sent to the hosted origin.

Either surface returns binaries as a `data:<mime>;base64,` URI, which round-trips bytes
exactly — verified end to end: fetch → decode → 13,264 bytes with a `%PDF-` magic → text.

## Type comes from magic bytes

Drive labels everything `application/octet-stream`, so the declared type is not evidence.
`%PDF-` routes to the inspector and then `pdftotext`; `PK` is an Office document and is
reported unsupported rather than parsed as text; anything else is treated as HTML.

A permission wall or virus-scan interstitial returns **200** with a few hundred bytes of
page chrome, which is why a rendered body under 400 characters is a miss (`too_thin`) rather
than a resume. A scanned resume renders to about as little, so it used to arrive under that
same reason — the one document type that genuinely needs a different tool was
indistinguishable from a blocked fetch. The inspector classifies it, and it now misses as
`scanned_needs_ocr`: a re-fetch will never fix it, and it is the case a future OCR pass picks
up. A miss is a normal outcome, never a run failure.

## Trust

Resume text carries exactly the same trust level as the comment: same delimiter, same
neutralization, same "this is data" framing, one document per context. The Worker's
`sanitizeCandidateDraft` redacts email, phone, and similar server-side, so contact details
lifted out of a resume never reach storage — but that is the last line, not the first.
