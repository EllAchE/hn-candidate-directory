#!/usr/bin/env node
// Fetches one resume and renders it to plain text. The caller chose an index, never a URL,
// and this module re-screens the URL it resolves that index to before any request. It also
// converts PDFs itself, so the subagent that reads resume prose needs no filesystem tool.
// `resumeText` is the function; the CLI below wraps it for a hand-run of a single item.

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { resolveFetchTarget } from './hn-fetch-endpoint.mjs';
import { needsOcr, renderStructured } from './hn-pdf-text.mjs';
import { RESUME_CAP, decodeEntities, htmlToText, neutralize, screenUrl } from './hn-untrusted.mjs';

// A permission wall or virus-scan interstitial returns 200 with a few hundred bytes of chrome,
// and a scanned page renders to about as little. One threshold decides both "prefer pdftotext to
// this markdown" and "call the whole document a miss".
const MIN_USEFUL = 400;

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) args[token.slice(2)] = argv[i + 1]?.startsWith('--') ? true : argv[++i];
    else args._.push(token);
  }
  return args;
}

const miss = (reason, url = '') => ({ ok: false, reason, url });

const DOCUMENT_HREF = /\.pdf(?:[?#]|$)|drive\.google\.com\/(?:uc|file|open)|docs\.google\.com\/(?:document|presentation)\/|dropbox\.com\//i;
const SHORTENER_HOST = /^(?:www\.)?(?:bit\.ly|bitly\.com|tinyurl\.com|t\.co|rb\.gy|shorturl\.at|cutt\.ly|tiny\.cc|is\.gd)$/i;
const SOCIAL_HOST = /(?:^|\.)(?:x\.com|twitter\.com|instagram\.com|facebook\.com|linkedin\.com|youtube\.com)$/i;
const ANCHOR = /<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a>/gi;

const strip = (html) => decodeEntities(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

// A resume link often lands on something that is not the resume: a personal site's index of
// several downloadable versions, or a shortener's preview page. One hop from there reaches the
// document; the page's own anchors say where. Anchors are ranked by the words around them, so
// "General CV — comprehensive" beats a role-specific variant listed above it.
export function documentToFollow(html, pageUrl) {
  const page = new URL(pageUrl);
  const links = [];
  // The words that describe a link sit between it and the previous anchor: a heading and a
  // blurb for this document, not the tail of the previous one's.
  let previousEnd = 0;
  for (const match of html.matchAll(ANCHOR)) {
    const context = strip(html.slice(previousEnd, match.index));
    previousEnd = match.index + match[0].length;
    let url;
    try {
      url = new URL(decodeEntities(match[1] ?? match[2]), pageUrl);
    } catch {
      continue;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') continue;
    links.push({ url: url.href, host: url.hostname, label: strip(match[3]), context });
  }

  if (SHORTENER_HOST.test(page.hostname)) {
    const destination = links.find((link) => !SHORTENER_HOST.test(link.host) && !SOCIAL_HOST.test(link.host) && link.host !== page.hostname);
    return destination?.url ?? null;
  }

  const documents = links.filter((link) => DOCUMENT_HREF.test(link.url));
  if (!documents.length) return null;
  const score = (link) => {
    const words = `${link.context} ${link.label}`;
    return (/general|comprehensive|complete|full/i.test(words) ? 2 : 0) + (/\bcv\b|r[eé]sum[eé]|curriculum/i.test(words) ? 1 : 0);
  };
  documents.sort((a, b) => score(b) - score(a));
  return documents[0].url;
}

// A code-hosting profile is a landing page too, but one with nothing to follow: the model
// picked it because the comment offered nothing better, and the comment alone wins.
function isProfilePage(url) {
  const parsed = new URL(url);
  return /^(?:www\.)?(?:github|gitlab)\.com$/i.test(parsed.hostname) && parsed.pathname.split('/').filter(Boolean).length <= 1;
}

// Share links render a viewer page, not the document. Rewriting to the download surface is
// what makes ~30% of the corpus reachable at all.
function directDownload(url) {
  const parsed = new URL(url);
  const host = parsed.hostname.toLowerCase();
  if (host === 'drive.google.com') {
    const id = parsed.pathname.match(/\/file\/d\/([^/]+)/)?.[1] || parsed.searchParams.get('id');
    return id ? `https://drive.google.com/uc?export=download&id=${id}` : url;
  }
  if (host === 'docs.google.com') {
    const id = parsed.pathname.match(/\/d\/([^/]+)/)?.[1];
    const kind = parsed.pathname.split('/')[1];
    return id ? `https://docs.google.com/${kind}/d/${id}/export?format=pdf` : url;
  }
  if (host.endsWith('dropbox.com')) {
    parsed.searchParams.set('dl', '1');
    return parsed.href;
  }
  if (host === '1drv.ms' || host.endsWith('onedrive.live.com')) return url;
  return url;
}

// Every failure is reported as a miss rather than thrown. An unreachable endpoint used to
// reject out of the top-level await and take the whole run down with it, which is what made a
// shim that was simply not running look like 18 unreadable resumes.
async function fetchBody(url) {
  const { endpoint, headers } = resolveFetchTarget();
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({ url, method: 'GET', format: 'raw' })
    });
    if (!response.ok) return { text: null, reason: `fetch_failed_${response.status}` };
    return { text: await response.text(), reason: null };
  } catch {
    return { text: null, reason: 'fetch_unreachable' };
  }
}

// The unblocker hands binaries back as a data URI, and Drive labels everything
// application/octet-stream, so the type comes from the magic bytes, never the header.
function decodeBody(body) {
  const dataUri = /^data:([^;,]*)(;base64)?,/.exec(body);
  if (!dataUri) return { bytes: Buffer.from(body, 'utf8'), declared: 'text/html' };
  const payload = body.slice(dataUri[0].length);
  return {
    bytes: dataUri[2] ? Buffer.from(payload, 'base64') : Buffer.from(decodeURIComponent(payload), 'utf8'),
    declared: dataUri[1] || 'application/octet-stream'
  };
}

// Structure first, characters second. `pdftotext` stays as the fallback for a checkout without
// the native binding, and as the second opinion when the markdown comes back thin.
async function renderPdf(bytes, out) {
  const structured = await renderStructured(bytes);
  if (structured.text && structured.text.length >= MIN_USEFUL) {
    return { text: structured.text, source: 'markdown', structured };
  }

  const pdfPath = join(out, 'resume.pdf');
  writeFileSync(pdfPath, bytes);
  try {
    const text = execFileSync('pdftotext', ['-q', '-enc', 'UTF-8', pdfPath, '-'], { encoding: 'utf8', maxBuffer: 32 << 20 });
    return { text, source: 'pdftotext', structured };
  } catch {
    return { text: structured.text, source: structured.text ? 'markdown' : null, structured };
  }
}

// Fetches one URL and renders it to text; `html` is kept for a landing page's anchors.
async function readDocument(url, out) {
  const fetched = await fetchBody(url);
  if (fetched.text === null) return miss(fetched.reason, url);

  const { bytes } = decodeBody(fetched.text);
  const magic = bytes.subarray(0, 5).toString('latin1');

  if (magic.startsWith('%PDF-')) {
    mkdirSync(out, { recursive: true });
    const rendered = await renderPdf(bytes, out);
    const documentType = rendered.structured.documentType;
    // A document with no usable text layer will not read on a retry, so it gets its own reason
    // rather than the `too_thin` a permission wall also produces.
    if (needsOcr(documentType, rendered.structured.pagesNeedingOcr, rendered.structured.pageCount)) {
      if (!rendered.text || rendered.text.length < MIN_USEFUL) return miss('scanned_needs_ocr', url);
    }
    if (rendered.text === null) return miss('pdftotext_unavailable_or_failed', url);
    return { ok: true, text: neutralize(rendered.text, RESUME_CAP), documentType, html: null };
  }
  if (magic.startsWith('PK')) return miss('office_document_unsupported', url);
  const html = bytes.toString('utf8');
  return { ok: true, text: neutralize(htmlToText(html), RESUME_CAP), documentType: null, html };
}

// Resolves one item's chosen link index against the sealed batch, fetches it, renders it, and
// writes resume-<nonce>.txt plus a .json provenance sidecar into `out`. Returns the rendered text
// on a hit and `{ ok: false, reason }` on every kind of miss; it never throws for a bad document.
export async function resumeText({ batch, nonce, link, out }) {
  const item = (batch.items || []).find((entry) => entry.nonce === nonce);
  if (!item) return miss('unknown_nonce');

  const index = Number(link);
  const chosen = (item.links || []).find((candidate) => candidate.index === index);
  if (!chosen) return miss('no_such_link');

  const screened = screenUrl(directDownload(chosen.url));
  if (!screened) return miss('blocked_url', chosen.url);
  if (isProfilePage(screened)) return miss('profile_page', screened);

  let read = await readDocument(screened, out);
  if (!read.ok) return read;
  let documentUrl = null;

  // One hop only. The linked document wins when it reads as a usable resume and says at least
  // as much as the page that pointed at it; otherwise the page stands as it was. A shortener's
  // preview page is never the resume, so there the destination's result stands, miss included.
  const next = read.html ? documentToFollow(read.html, screened) : null;
  const target = next ? screenUrl(directDownload(next)) : null;
  if (target && target !== screened) {
    const followed = await readDocument(target, out);
    if (SHORTENER_HOST.test(new URL(screened).hostname)) {
      if (!followed.ok) return followed;
      read = followed;
      documentUrl = next;
    } else if (followed.ok && followed.text.length >= MIN_USEFUL && followed.text.length >= read.text.length) {
      read = followed;
      documentUrl = next;
    }
  }

  const rendered = read.text;
  // A permission wall or virus-scan interstitial returns 200 with a few hundred bytes of
  // chrome. Treat a thin body as a miss so comment-only extraction wins instead.
  if (rendered.length < MIN_USEFUL) return miss('too_thin', documentUrl || screened);

  mkdirSync(out, { recursive: true });
  const textPath = join(out, `resume-${nonce}.txt`);
  writeFileSync(textPath, rendered);
  writeFileSync(
    join(out, `resume-${nonce}.json`),
    JSON.stringify(
      { resumeUrl: chosen.url, documentUrl, resumeFetchedAt: new Date().toISOString(), chars: rendered.length, documentType: read.documentType },
      null,
      2
    )
  );

  return { ok: true, url: chosen.url, documentUrl, path: textPath, chars: rendered.length, text: rendered };
}

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.batch || !args.nonce || !args.out) {
    console.error('usage: hn-resume-text.mjs --batch <batch.json> --nonce <nonce> --link <index> --out <dir>');
    process.exit(2);
  }
  const batch = JSON.parse(readFileSync(args.batch, 'utf8'));
  const { text: _text, ...report } = await resumeText({ batch, nonce: args.nonce, link: args.link, out: args.out });
  process.stdout.write(`${JSON.stringify(report)}\n`);
}
