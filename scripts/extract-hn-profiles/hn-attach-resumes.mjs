#!/usr/bin/env node
// Fetches each item's resume and seals the text into the batch, so the extractor reads the
// resume on its first pass instead of only ever naming which link it would have liked to read.
//
// Two ways to pick the link, both an index into the item's screened list, never a URL:
//   - before extraction, `resumeHint` (the link on the comment's own `Résumé/CV:` line);
//   - after a pass, the draft's `resumeLinkIndex`, when the model chose one the hint missed.
// The batch on disk is updated in place, which is what lets the pronoun screen and assembly see
// the same resume the model saw. `--write` additionally emits a subset batch of only the items
// that gained a resume or are marked for retry, for a targeted second extraction pass.
//
//   hn-attach-resumes.mjs --batch <batch.json> --out <run-dir>
//     [--drafts <drafts.json>] [--retry <check.json>] [--write <subset.json>] [--concurrency 3]

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { resumeText } from './hn-resume-text.mjs';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) args[token.slice(2)] = argv[i + 1]?.startsWith('--') ? true : argv[++i];
  }
  return args;
}

function fail(message) {
  console.error(message);
  process.exit(2);
}

const validIndex = (value) => (Number.isInteger(value) && value > 0 ? value : null);

// The model's pick wins over the label when the two disagree: the label is a template guess,
// the pick came from reading the comment.
export function chooseIndex(item, draftEntry) {
  return validIndex(draftEntry?.resumeLinkIndex) ?? validIndex(item.resumeHint);
}

// A resume already rendered for this nonce is reused only when it came from the same URL; a
// different index is a different document and gets its own fetch.
function cached(out, item, link) {
  const sidecar = join(out, `resume-${item.nonce}.json`);
  const text = join(out, `resume-${item.nonce}.txt`);
  if (!existsSync(sidecar) || !existsSync(text)) return null;
  const meta = JSON.parse(readFileSync(sidecar, 'utf8'));
  if (meta.resumeUrl !== link.url) return null;
  return readFileSync(text, 'utf8');
}

async function pool(items, size, work) {
  const queue = [...items];
  const results = [];
  const lanes = Array.from({ length: Math.max(1, size) }, async () => {
    while (queue.length) results.push(await work(queue.shift()));
  });
  await Promise.all(lanes);
  return results;
}

export async function attachResumes({ batch, out, drafts = [], retry = new Set(), concurrency = 3 }) {
  const byNonce = new Map(drafts.map((entry) => [entry.nonce, entry]));
  const misses = {};
  const selected = new Set();
  let fetched = 0;

  await pool(batch.items || [], concurrency, async (item) => {
    const index = chooseIndex(item, byNonce.get(item.nonce));
    const link = index ? (item.links || []).find((candidate) => candidate.index === index) : null;
    if (!link) {
      if (retry.has(item.nonce)) selected.add(item.nonce);
      return;
    }
    // The same document, already sealed into the item: nothing to fetch, and the item only
    // goes into the subset when the miss check asked for it.
    if (item.resume && item.resumeUrl === link.url) {
      if (retry.has(item.nonce)) selected.add(item.nonce);
      return;
    }

    let text = cached(out, item, link);
    let source = 'cache';
    if (text === null) {
      const result = await resumeText({ batch, nonce: item.nonce, link: index, out });
      fetched += 1;
      if (!result.ok) {
        misses[result.reason] = (misses[result.reason] || 0) + 1;
        if (retry.has(item.nonce)) selected.add(item.nonce);
        return;
      }
      text = result.text;
      source = index === validIndex(item.resumeHint) && !validIndex(byNonce.get(item.nonce)?.resumeLinkIndex) ? 'label' : 'model';
    }

    item.resume = text;
    item.resumeUrl = link.url;
    item.resumeIndex = index;
    item.resumeSource = source === 'cache' ? item.resumeSource || 'label' : source;
    selected.add(item.nonce);
  });

  const attached = (batch.items || []).filter((item) => item.resume).length;
  return { attached, fetched, misses, selected };
}

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.batch || !args.out) {
    fail('usage: hn-attach-resumes.mjs --batch <batch.json> --out <run-dir> [--drafts <drafts.json>] [--retry <check.json>] [--write <subset.json>]');
  }

  const batch = JSON.parse(readFileSync(args.batch, 'utf8'));
  const drafts = args.drafts ? JSON.parse(readFileSync(args.drafts, 'utf8')) : [];
  const check = args.retry ? JSON.parse(readFileSync(args.retry, 'utf8')) : { flagged: [] };
  const retry = new Set((check.flagged || []).filter((entry) => entry.retry).map((entry) => entry.nonce));
  const concurrency = Number(args.concurrency) || 3;

  const { attached, fetched, misses, selected } = await attachResumes({ batch, out: args.out, drafts, retry, concurrency });
  writeFileSync(args.batch, JSON.stringify(batch, null, 2));

  let written = 0;
  if (args.write) {
    const items = (batch.items || []).filter((item) => selected.has(item.nonce));
    written = items.length;
    if (written) {
      mkdirSync(dirname(args.write), { recursive: true });
      // A retried item carries what the previous pass left empty, so the framing can say what
      // the resume is expected to answer. A malformed or absent draft names no field: that
      // item simply runs again.
      const FIELD = (name) => name !== 'malformed' && name !== 'draft';
      const expected = new Map((check.flagged || []).map((entry) => [entry.nonce, entry.missing.filter(FIELD)]));
      const subset = items.map((item) => ({ ...item, expected: expected.get(item.nonce) || [] }));
      writeFileSync(args.write, JSON.stringify({ ...batch, items: subset }, null, 2));
    }
  }

  process.stdout.write(
    `${JSON.stringify({ batch: batch.batch, items: (batch.items || []).length, attached, fetched, misses, written })}\n`
  );
}
