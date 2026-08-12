#!/usr/bin/env node
// Turns a pending list into sealed batches. Identity lives in the .map.json sidecar,
// which is never shown to a model: the batch a subagent reads carries a nonce and text,
// so "also update item 12345" has nothing to select.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { delimiter, htmlToText, neutralize, nonce, screenedLinks } from './hn-untrusted.mjs';

const ALGOLIA_THREAD = 'https://hn.algolia.com/api/v1/search';
const PAGE_SIZE = 100;
const MAX_BATCH = 25;

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) args[token.slice(2)] = argv[i + 1]?.startsWith('--') ? true : argv[++i];
    else args._.push(token);
  }
  return args;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

// The Algolia HN API is a public, documented, unauthenticated JSON endpoint, so a direct
// request is correct here; the unblocker is for the scraping targets in hn-resume-text.
// `story_<id>` is the tag that selects a thread's descendants, matching the Worker's
// fetchHnThreadComments. `parent_<id>` is not an Algolia tag and silently returns zero hits.
async function fetchThread(threadId) {
  const hits = [];
  for (let page = 0; page < 12; page += 1) {
    const url = `${ALGOLIA_THREAD}?tags=comment,story_${threadId}&hitsPerPage=${PAGE_SIZE}&page=${page}`;
    const response = await fetch(url, { headers: { accept: 'application/json' } });
    if (!response.ok) fail(`algolia returned ${response.status} for thread ${threadId}`);
    const body = await response.json();
    const pageHits = body.hits || [];
    hits.push(...pageHits);
    if (pageHits.length < PAGE_SIZE) break;
    if (Number.isInteger(body.nbPages) && page + 1 >= body.nbPages) break;
  }
  return new Map(hits.map((hit) => [String(hit.objectID), hit]));
}

const args = parseArgs(process.argv.slice(2));
if (!args.pending || !args.out) fail('usage: hn-prepare-batch.mjs --pending <pending.json> --out <dir> [--limit N] [--batch N] [--isolate]');

const pending = JSON.parse(readFileSync(args.pending, 'utf8'));
const items = (pending.items || []).slice(0, Number(args.limit) || Infinity);
if (!items.length) fail('nothing pending — no batches written');

const size = args.isolate ? 1 : Math.min(Number(args.batch) || MAX_BATCH, MAX_BATCH);
mkdirSync(args.out, { recursive: true });

const threads = new Map();
for (const item of items) {
  if (!threads.has(item.threadId)) threads.set(item.threadId, await fetchThread(item.threadId));
}

const prepared = [];
const missing = [];
for (const item of items) {
  const hit = threads.get(item.threadId)?.get(String(item.hnItemId));
  if (!hit?.comment_text) {
    missing.push(item.hnItemId);
    continue;
  }
  const text = neutralize(htmlToText(hit.comment_text));
  if (!text) {
    missing.push(item.hnItemId);
    continue;
  }
  prepared.push({
    nonce: nonce(),
    text,
    links: screenedLinks(hit.comment_text),
    comment: {
      objectID: String(hit.objectID),
      author: hit.author,
      comment_text: hit.comment_text,
      created_at: hit.created_at,
      threadId: item.threadId,
      threadMonth: item.threadMonth
    }
  });
}

const written = [];
for (let start = 0, batch = 1; start < prepared.length; start += size, batch += 1) {
  const slice = prepared.slice(start, start + size);
  const batchPath = join(args.out, `batch-${batch}.json`);
  const mapPath = join(args.out, `batch-${batch}.map.json`);

  writeFileSync(
    batchPath,
    JSON.stringify(
      {
        batch,
        delimiter: delimiter(),
        items: slice.map(({ nonce: id, text, links }) => ({ nonce: id, text, links }))
      },
      null,
      2
    )
  );
  writeFileSync(
    mapPath,
    JSON.stringify(Object.fromEntries(slice.map(({ nonce: id, comment }) => [id, comment])), null, 2)
  );
  written.push({ batch, path: batchPath, map: mapPath, items: slice.length });
}

process.stdout.write(`${JSON.stringify({ prepared: prepared.length, missing, batches: written }, null, 2)}\n`);
