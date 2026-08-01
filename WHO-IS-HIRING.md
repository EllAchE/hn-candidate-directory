# Who wants to be hired directory

This is a public, static MVP for a searchable directory of candidates from Hacker News hiring threads.

## Document enrichment

The page intentionally separates the expensive document path from the directory UI:

1. A candidate provides a resume, LinkedIn URL, or source text.
2. A server-side adapter fetches URLs through String's Web Access API (`POST /v1/fetch`).
3. A processing queue extracts normalized universities, companies, skills, dates, and locations.
4. The candidate reviews the result before it becomes searchable.

`document-enrichment-worker.js` is an open-source Cloudflare Worker-shaped adapter. It keeps `UNBLOCKER_ORG_API_KEY` server-side and returns a small extraction preview. Set `window.HN_ENRICH_ENDPOINT` in the deployed page to connect it. The current page falls back to local parsing when that endpoint is unset, so the public demo remains usable on GitHub Pages.

Production follow-ups should add candidate consent, URL allowlisting/SSRF controls, an async job queue, byte/page budgets, deduplication, redaction of sensitive fields, and email verification for update/removal requests.

## Local demo

Open `who-is-hiring.html` directly. Search and filters work client-side. Imported candidates and update requests are stored in `localStorage` for the demo only.
