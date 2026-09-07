#!/usr/bin/env node
// Re-attaches identity to model output and enforces the draft schema locally. A draft that
// fails is dropped whole — never coerced, truncated, or repaired into something publishable.
//
// One narrow exception, below: `&amp;` is decoded to `&`. The comment reaches the model with
// entities already decoded by htmlToText, and the model re-encodes them in its own output;
// nothing downstream decodes again, so `&` reaches the page as a literal `&amp;`. Decoding
// only this one entity cannot introduce a `<`, `>`, or quote that was not already literally
// present, so it cannot turn an escaped payload into markup — `&amp;lt;script&amp;gt;`
// becomes `&lt;script&gt;`, which is still inert text, and the Worker escapes on render
// regardless. `&lt;` and `&gt;` are deliberately left encoded.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const TEXT_LIMITS = { name: 200, role: 300, summary: 2_000, location: 300, workMode: 100, availability: 100 };
const LIST_FIELDS = ['universities', 'companies', 'skills', 'dateRanges'];
const LIST_ITEM_LIMIT = 200;
const LIST_LIMIT = 50;

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) args[token.slice(2)] = argv[i + 1]?.startsWith('--') ? true : argv[++i];
    else args._.push(token);
  }
  return args;
}

// Single pass, and `&amp;` only. See the note at the top of this file for why this one is
// safe when a general entity decode here would not be.
const decodeAmp = (text) => text.replace(/&amp;/g, '&');

function validateDraft(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const draft = {};
  for (const [field, limit] of Object.entries(TEXT_LIMITS)) {
    const text = value[field];
    if (typeof text !== 'string') return null;
    const trimmed = decodeAmp(text.trim());
    if (trimmed.length > limit) return null;
    draft[field] = trimmed;
  }
  for (const field of LIST_FIELDS) {
    const list = value[field];
    if (!Array.isArray(list) || list.length > LIST_LIMIT) return null;
    const items = list.map((entry) => (typeof entry === 'string' ? decodeAmp(entry.trim()) : null));
    if (items.some((entry) => entry === null || entry.length > LIST_ITEM_LIMIT)) return null;
    draft[field] = [...new Set(items.filter(Boolean))];
  }
  return draft;
}

const args = parseArgs(process.argv.slice(2));
if (!args.batch || !args.drafts || !args.out) {
  console.error('usage: hn-assemble-push.mjs --batch <batch.json> --drafts <drafts.json> --out <push.json> [--extractor <id>]');
  process.exit(2);
}

const batchPath = args.batch;
const identities = JSON.parse(readFileSync(batchPath.replace(/\.json$/, '.map.json'), 'utf8'));
const drafts = JSON.parse(readFileSync(args.drafts, 'utf8'));
const entries = Array.isArray(drafts) ? drafts : drafts.profiles || [];
const resumeDir = dirname(batchPath);

const profiles = [];
const rejected = [];
const claimed = new Set();

for (const entry of entries) {
  const id = entry?.nonce;
  // An unknown nonce means the model invented an item; a repeated one means it tried to
  // write the same record twice. Both are dropped rather than reconciled.
  if (typeof id !== 'string' || !Object.hasOwn(identities, id) || claimed.has(id)) {
    rejected.push({ nonce: id ?? null, reason: claimed.has(id) ? 'duplicate_nonce' : 'unknown_nonce' });
    continue;
  }
  claimed.add(id);

  if (entry.draft === null) {
    profiles.push({ comment: identities[id], draft: null });
    continue;
  }

  const draft = validateDraft(entry.draft);
  if (!draft) {
    rejected.push({ nonce: id, reason: 'invalid_draft' });
    continue;
  }

  const profile = { comment: identities[id], draft };
  const resumePath = join(resumeDir, `resume-${id}.json`);
  if (existsSync(resumePath)) {
    const resume = JSON.parse(readFileSync(resumePath, 'utf8'));
    profile.resumeUrl = resume.resumeUrl;
    profile.resumeFetchedAt = resume.resumeFetchedAt;
  }
  profiles.push(profile);
}

const skipped = Object.keys(identities).filter((id) => !claimed.has(id));
if (profiles.length) {
  writeFileSync(args.out, JSON.stringify({ extractor: args.extractor || 'claude-skill-v1', profiles }, null, 2));
}

// The report prints on both paths: a batch where everything was rejected is the case an
// operator most needs the reasons for, and exiting silently hides them.
process.stdout.write(
  `${JSON.stringify({ out: profiles.length ? args.out : null, profiles: profiles.length, rejected, skipped }, null, 2)}\n`
);
if (!profiles.length) {
  console.error(`no valid profiles in ${args.drafts}; nothing written`);
  process.exit(1);
}
