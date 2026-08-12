#!/usr/bin/env node
// Fetches one resume and renders it to plain text. The model chose an index, never a URL,
// and this script re-screens the URL it resolves that index to before any request. It also
// converts PDFs itself, so the subagent that reads resume prose needs no filesystem tool.

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { RESUME_CAP, htmlToText, neutralize, screenUrl } from './hn-untrusted.mjs';

const UNBLOCKER = process.env.UNBLOCKER_URL || 'http://localhost:7654';

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) args[token.slice(2)] = argv[i + 1]?.startsWith('--') ? true : argv[++i];
    else args._.push(token);
  }
  return args;
}

function miss(reason, url = '') {
  process.stdout.write(`${JSON.stringify({ ok: false, reason, url })}\n`);
  process.exit(0);
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

async function fetchBody(url) {
  const response = await fetch(`${UNBLOCKER}/fetch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url, method: 'GET', format: 'raw' })
  });
  if (!response.ok) return null;
  return response.text();
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

function renderPdf(bytes, out) {
  const pdfPath = join(out, 'resume.pdf');
  writeFileSync(pdfPath, bytes);
  try {
    return execFileSync('pdftotext', ['-q', '-enc', 'UTF-8', pdfPath, '-'], { encoding: 'utf8', maxBuffer: 32 << 20 });
  } catch {
    return null;
  }
}

const args = parseArgs(process.argv.slice(2));
if (!args.batch || !args.nonce || !args.out) {
  console.error('usage: hn-resume-text.mjs --batch <batch.json> --nonce <nonce> --link <index> --out <dir>');
  process.exit(2);
}

const batch = JSON.parse(readFileSync(args.batch, 'utf8'));
const item = (batch.items || []).find((entry) => entry.nonce === args.nonce);
if (!item) miss('unknown_nonce');

const index = Number(args.link);
const chosen = item.links.find((link) => link.index === index);
if (!chosen) miss('no_such_link');

const screened = screenUrl(directDownload(chosen.url));
if (!screened) miss('blocked_url', chosen.url);

const body = await fetchBody(screened);
if (body === null) miss('fetch_failed', screened);

const { bytes } = decodeBody(body);
const magic = bytes.subarray(0, 5).toString('latin1');

let text;
if (magic.startsWith('%PDF-')) {
  mkdirSync(args.out, { recursive: true });
  text = renderPdf(bytes, args.out);
  if (text === null) miss('pdftotext_unavailable_or_failed', screened);
} else if (magic.startsWith('PK')) {
  miss('office_document_unsupported', screened);
} else {
  text = htmlToText(bytes.toString('utf8'));
}

const rendered = neutralize(text, RESUME_CAP);
// A permission wall or virus-scan interstitial returns 200 with a few hundred bytes of
// chrome. Treat a thin body as a miss so comment-only extraction wins instead.
if (rendered.length < 400) miss('too_thin', screened);

mkdirSync(args.out, { recursive: true });
const textPath = join(args.out, `resume-${args.nonce}.txt`);
writeFileSync(textPath, rendered);
writeFileSync(
  join(args.out, `resume-${args.nonce}.json`),
  JSON.stringify({ resumeUrl: chosen.url, resumeFetchedAt: new Date().toISOString(), chars: rendered.length }, null, 2)
);

process.stdout.write(`${JSON.stringify({ ok: true, url: chosen.url, path: textPath, chars: rendered.length })}\n`);
