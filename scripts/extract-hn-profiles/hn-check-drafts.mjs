#!/usr/bin/env node
// Completeness cues over one batch's drafts. Role and summary are expected for candidates;
// labelled location/remote fields and resumes add retry cues. Explicitly absent employment
// should not exclude first-job candidates for an empty company list. This is not a check that
// extracted claims are supported by the source. The wrapper decides what happens to flags.
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
// Resume omissions are worth a second pass unless the source explicitly answers with absence.
const RESUME_FIELDS = ['name', 'companies'];
const FIELDS = ['name', 'role', 'summary', 'location', 'workMode', 'companies', 'universities', 'skills', 'dateRanges'];
const NO_EMPLOYMENT = /\bno\s+(?:(?:prior|previous|professional|paid|formal)\s+)*(?:employment|work|professional)\s+(?:experience|history)\b(?=[ \t]*(?:[.!?;,\n]|$))|\bnever\s+(?:been\s+)?employed\b(?=[ \t]*(?:[.!?;,\n]|$))|\b(?:employment|work|professional)\s+(?:experience|history)\s*:\s*none\b(?=[ \t]*(?:[.!?;,\n]|$))/gi;
const EMPLOYER_STATEMENT = /\b(?:worked|working|employed|interned)\s+(?:at|for|by)\b|\b(?:internship|employment|experience)\s+(?:at|with|for)\b|\b(?:engineer|developer|designer|manager|analyst|consultant|intern|researcher)\s+(?:at|for)\b/i;
const EMPLOYMENT_SECTION = /(?:^|\n)[ \t]*(?:#{1,6}[ \t]*)?(?:employment|work|professional)\s+(?:experience|history)[ \t]*(?::[ \t]*[^\n]+|\n[ \t]*\S)/i;
const EMPLOYER_LABEL = /(?:^|\n)[ \t]*(?:employer|company)[ \t]*:[ \t]*(?!none\b|no(?:[ \t]|$)|n\/?a\b)\S/i;
const DATED_EMPLOYER = /\b(?:corp(?:oration)?|company|inc|ltd|llc|gmbh)\b[^\n]{0,100}\b(?:19|20)\d{2}\b/i;

function explicitlyNoEmployment(item) {
  const source = `${item.text || ''}\n${item.resume || ''}`;
  const remaining = source.replace(NO_EMPLOYMENT, '');
  if (remaining === source) return false;
  // These are conservative retry cues, not proof of a claim. Conflicting work history wins.
  return ![EMPLOYER_STATEMENT, EMPLOYMENT_SECTION, EMPLOYER_LABEL, DATED_EMPLOYER].some((cue) => cue.test(remaining));
}

const filled = (value) => (Array.isArray(value) ? value.length > 0 : typeof value === 'string' && value.trim() !== '');

export function expectedFields(item) {
  const expected = ['role', 'summary'];
  if (LOCATION_LINE.test(item.text || '')) expected.push('location');
  if (REMOTE_LINE.test(item.text || '')) expected.push('workMode');
  if (item.resume) {
    expected.push('name');
    if (!explicitlyNoEmployment(item)) expected.push('companies');
  }
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
