#!/usr/bin/env node
// A resume pass can correct an unsupported fact by returning fewer filled fields. Completeness
// cannot decide which draft is more accurate. Keep its complete correction, with the first pass
// as fallback for malformed output, and preserve source-injection findings from either pass.

import { validExperience } from '../../sensitive-data.js';
import { readFileSync, writeFileSync } from 'node:fs';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) args[token.slice(2)] = argv[i + 1]?.startsWith('--') ? true : argv[++i];
  }
  return args;
}

const TEXT_LIMITS = { name: 200, role: 300, summary: 2_000, location: 300, workMode: 100, availability: 100 };
const LIST_FIELDS = ['universities', 'companies', 'skills', 'dateRanges'];
const LIST_ITEM_LIMIT = 200;

const assembledTextLength = (value) => value.trim().replace(/&amp;/g, '&').length;

function wellFormedDraft(draft) {
  if (!draft || typeof draft !== 'object' || Array.isArray(draft)) return false;
  return (draft.experience === undefined || validExperience(draft.experience))
    && Object.entries(TEXT_LIMITS).every(([field, limit]) => typeof draft[field] === 'string' && assembledTextLength(draft[field]) <= limit)
    && LIST_FIELDS.every((field) => Array.isArray(draft[field])
      && draft[field].every((value) => typeof value === 'string' && assembledTextLength(value) <= LIST_ITEM_LIMIT));
}

export function mergeDrafts(base, over) {
  const merged = new Map(base.map((entry) => [entry.nonce, entry]));
  for (const candidate of over) {
    if (!candidate || typeof candidate.nonce !== 'string') continue;
    const current = merged.get(candidate.nonce);
    const wellFormed = wellFormedDraft(candidate.draft);
    if (!current) {
      if (wellFormed || candidate.draft === null) merged.set(candidate.nonce, candidate);
      continue;
    }
    const chosen = wellFormed ? candidate : current;
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
  const replaced = over.filter((entry) => wellFormedDraft(entry?.draft)
    && merged.find((item) => item.nonce === entry.nonce)?.draft === entry.draft).length;
  process.stdout.write(`${JSON.stringify({ base: base.length, over: over.length, merged: merged.length, replaced })}\n`);
}
