import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { checkDrafts, expectedFields } from '../scripts/extract-hn-profiles/hn-check-drafts.mjs';
import { pageOutcomes } from '../scripts/extract-hn-profiles/hn-page-state.mjs';

const draft = {
  name: 'Synthetic Student', role: 'Engineer', summary: 'Seeking a first engineering role.',
  location: '', workMode: '', availability: '', universities: ['Example University'],
  companies: [], skills: [], dateRanges: []
};
const firstJob = 'Synthetic Student\nEducation: BSc from Example University. Seeking first job; no employment history.';
const report = (resume, text = '', changes = {}) => checkDrafts(
  { batch: 1, items: [{ nonce: 'student', text, resume }] },
  [{ nonce: 'student', draft: { ...draft, ...changes } }]
);

test('explicit absence of employment is not a company extraction miss', () => {
  for (const resume of [
    firstJob,
    'Synthetic Graduate\nNo prior work experience. Education: Example University, 2022-2026.',
    'Synthetic Student\nNo paid professional experience. Independent projects and volunteering.',
    'Synthetic Graduate\nNever been employed. Applying for a first job.',
    'Synthetic Graduate\nEmployment history:\nNone.'
  ]) {
    assert.deepEqual(expectedFields({ resume }), ['role', 'summary', 'name']);
    assert.deepEqual(report(resume).missing, {});
    assert.deepEqual(report(resume).flagged, []);
  }
});

test('explicit employment absence does not waive name, role or summary completeness', () => {
  assert.deepEqual(report(firstJob, '', { name: '' }).flagged[0].missing, ['name']);
  assert.equal(report(firstJob, '', { name: '' }).flagged[0].retry, true);
  assert.deepEqual(report(firstJob, '', { role: '', summary: '' }).flagged[0].missing, ['role', 'summary']);
});

test('unknown experience and demonstrated employers retain company retries', () => {
  for (const resume of [
    'Synthetic Graduate\nEducation: Example University. Seeking a first full-time job.',
    'Synthetic Student\nWorked at Example Company from 2022 to 2024.',
    'Synthetic Engineer\nExample Corp 2019-2023',
    'Synthetic Engineer\nNo experience with TypeScript. Engineer at Example Company.',
    'Synthetic Engineer\nNo professional experience with TypeScript.',
    'Synthetic Engineer\nNo work experience in finance.'
  ]) {
    assert.deepEqual(report(resume).flagged, [{ nonce: 'student', resume: true, missing: ['companies'], retry: true }]);
  }
});

test('conflicting employment cues override absence in either source', () => {
  for (const [resume, text] of [
    [`${firstJob}\nInternship at Example Company, summer 2025.`, ''],
    [`${firstJob}\nWork Experience\nExample Company, Engineer`, ''],
    [`${firstJob}\nCompany: Example Company`, ''],
    [`${firstJob}\nExample Corp 2023-2024`, ''],
    [firstJob, 'Previously worked for Example Company.'],
    ['Synthetic Student\nEmployed by Example Company.', 'No previous employment history.']
  ]) {
    assert.deepEqual(report(resume, text).flagged[0].missing, ['companies']);
    assert.equal(report(resume, text).flagged[0].retry, true);
  }
});

test('first-job profile survives the page runner hold-misses filter and assembly', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hncd-employment-absence-'));
  const write = (name, value) => writeFileSync(join(dir, name), JSON.stringify(value));
  const script = (name) => new URL(`../scripts/extract-hn-profiles/${name}`, import.meta.url).pathname;
  try {
    write('pending.json', { items: [{ hnItemId: '900001' }] });
    write('batch-1.json', { batch: 1, items: [{ nonce: 'student', text: '', resume: firstJob }] });
    write('batch-1.map.json', { student: {
      objectID: '900001', itemId: '900001', author: 'synthetic_student', threadId: '900000',
      threadMonth: '2026-10', createdAt: '2026-10-01T00:00:00Z', commentText: 'Seeking first job.'
    } });
    write('drafts-1.json', [{ nonce: 'student', injection: false, draft }]);
    execFileSync(process.execPath, [script('hn-check-drafts.mjs'), '--batch', join(dir, 'batch-1.json'),
      '--drafts', join(dir, 'drafts-1.json'), '--out', join(dir, 'check-1.json')]);
    const kept = execFileSync('jq', ['--slurpfile', 'c', join(dir, 'check-1.json'),
      '[.[] | select(.nonce as $x | ($c[0].flagged | map(.nonce) | index($x)) == null)]', join(dir, 'drafts-1.json')]);
    writeFileSync(join(dir, 'screened-1.json'), kept);
    execFileSync(process.execPath, [script('hn-assemble-push.mjs'), '--batch', join(dir, 'batch-1.json'),
      '--drafts', join(dir, 'screened-1.json'), '--out', join(dir, 'push-1.json')]);
    const pushed = JSON.parse(readFileSync(join(dir, 'push-1.json'), 'utf8'));
    assert.equal(pushed.profiles.length, 1);
    assert.deepEqual(pushed.profiles[0].draft.companies, []);
    const outcomes = pageOutcomes({ runDir: dir, batches: 1 });
    assert.equal(outcomes.pushed, 1);
    assert.deepEqual(outcomes.held, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
