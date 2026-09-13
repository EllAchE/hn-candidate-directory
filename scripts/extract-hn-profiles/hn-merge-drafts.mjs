#!/usr/bin/env node
// Folds a second-pass draft set over the first. The second pass saw the resume, so it usually
// knows more, but "usually" is not a rule: the over draft wins only when it fills at least as
// many fields as the base, and it never retires an item the first pass kept. An injection flag
// set by either pass sticks, because it is a property of the source text, not of the pass.
//
//   hn-merge-drafts.mjs --base <drafts.json> --over <drafts.json> --out <merged.json>

import { readFileSync, writeFileSync } from 'node:fs';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) args[token.slice(2)] = argv[i + 1]?.startsWith('--') ? true : argv[++i];
  }
  return args;
}

const filled = (value) => (Array.isArray(value) ? value.length > 0 : typeof value === 'string' && value.trim() !== '');
const retired = (entry) => !entry?.draft || entry.draft.summary === null;

export function score(entry) {
  if (retired(entry)) return -1;
  return Object.values(entry.draft).filter(filled).length;
}

export function mergeDrafts(base, over) {
  const merged = new Map(base.map((entry) => [entry.nonce, entry]));
  for (const candidate of over) {
    const current = merged.get(candidate.nonce);
    if (!current) {
      merged.set(candidate.nonce, candidate);
      continue;
    }
    if (retired(candidate) && !retired(current)) continue;
    const chosen = score(candidate) >= score(current) ? candidate : current;
    merged.set(candidate.nonce, { ...chosen, injection: Boolean(current.injection || candidate.injection) });
  }
  return [...merged.values()];
}

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.base || !args.over || !args.out) {
    console.error('usage: hn-merge-drafts.mjs --base <drafts.json> --over <drafts.json> --out <merged.json>');
    process.exit(2);
  }
  const load = (path) => {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    return Array.isArray(raw) ? raw : raw.profiles || [];
  };
  const base = load(args.base);
  const over = load(args.over);
  const merged = mergeDrafts(base, over);
  writeFileSync(args.out, JSON.stringify(merged, null, 2));
  const replaced = over.filter((entry) => merged.find((m) => m.nonce === entry.nonce)?.draft === entry.draft).length;
  process.stdout.write(`${JSON.stringify({ base: base.length, over: over.length, merged: merged.length, replaced })}\n`);
}
