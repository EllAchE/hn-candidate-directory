#!/usr/bin/env node
// Strict miss check over one batch's drafts. Every candidate states a role and deserves a
// summary; a comment with a `Location:` or `Remote:` line has answered those questions; and a
// resume the model actually read carries a name and an employer history. An empty field where
// the source demonstrably has the answer is an extraction miss, not an absence, and is reported
// as one. The check only reports: what happens to a flagged item is the wrapper's decision.
//
//   hn-check-drafts.mjs --batch <batch.json> --drafts <drafts.json> --out <check.json>

import { readFileSync, writeFileSync } from 'node:fs';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) args[token.slice(2)] = argv[i + 1]?.startsWith('--') ? true : argv[++i];
  }
  return args;
}

const LOCATION_LINE = /^\s*location\s*:/im;
const REMOTE_LINE = /^\s*remote\s*:/im;
// Fields that read the resume: an empty one with a resume attached is worth a second pass.
const RESUME_FIELDS = ['name', 'companies'];
const FIELDS = ['name', 'role', 'summary', 'location', 'workMode', 'companies', 'universities', 'skills', 'dateRanges'];

const filled = (value) => (Array.isArray(value) ? value.length > 0 : typeof value === 'string' && value.trim() !== '');

export function expectedFields(item) {
  const expected = ['role', 'summary'];
  if (LOCATION_LINE.test(item.text || '')) expected.push('location');
  if (REMOTE_LINE.test(item.text || '')) expected.push('workMode');
  if (item.resume) expected.push(...RESUME_FIELDS);
  return expected;
}

export function checkDrafts(batch, drafts) {
  const byNonce = new Map(drafts.map((entry) => [entry.nonce, entry]));
  const missing = {};
  const coverage = Object.fromEntries(FIELDS.map((field) => [field, 0]));
  const flagged = [];
  let withResume = 0;
  let retired = 0;

  for (const item of batch.items || []) {
    const hasResume = Boolean(item.resume);
    if (hasResume) withResume += 1;
    const entry = byNonce.get(item.nonce);
    const draft = entry?.draft;

    if (!entry) {
      missing.draft = (missing.draft || 0) + 1;
      flagged.push({ nonce: item.nonce, resume: hasResume, missing: ['draft'], retry: hasResume });
      continue;
    }
    // A subagent sometimes answers with the fields at the top level and no `draft` wrapper.
    // Assembly drops that as invalid, so it is worth one more pass regardless of resume, and
    // it must not be counted as "role missing" when the role is right there under the wrong key.
    if (draft === undefined && ('summary' in entry || 'role' in entry)) {
      missing.malformed = (missing.malformed || 0) + 1;
      flagged.push({ nonce: item.nonce, resume: hasResume, missing: ['malformed'], retry: true });
      continue;
    }
    // A retired draft is the model's call on a comment that is not a candidate, not a miss.
    if (draft === null || draft?.summary === null) {
      retired += 1;
      continue;
    }

    for (const field of FIELDS) if (filled(draft?.[field])) coverage[field] += 1;
    const gaps = expectedFields(item).filter((field) => !filled(draft?.[field]));
    if (!gaps.length) continue;
    for (const field of gaps) missing[field] = (missing[field] || 0) + 1;
    flagged.push({
      nonce: item.nonce,
      resume: hasResume,
      missing: gaps,
      retry: hasResume && gaps.some((field) => RESUME_FIELDS.includes(field))
    });
  }

  return { batch: batch.batch, items: (batch.items || []).length, withResume, retired, coverage, missing, flagged };
}

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.batch || !args.drafts || !args.out) {
    console.error('usage: hn-check-drafts.mjs --batch <batch.json> --drafts <drafts.json> --out <check.json>');
    process.exit(2);
  }
  const batch = JSON.parse(readFileSync(args.batch, 'utf8'));
  const raw = JSON.parse(readFileSync(args.drafts, 'utf8'));
  const drafts = Array.isArray(raw) ? raw : raw.profiles || [];
  const report = checkDrafts(batch, drafts);
  writeFileSync(args.out, JSON.stringify(report, null, 2));
  const { flagged, coverage: _coverage, ...summary } = report;
  process.stdout.write(`${JSON.stringify({ ...summary, flagged: flagged.length, retry: flagged.filter((f) => f.retry).length })}\n`);
}
