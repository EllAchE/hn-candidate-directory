import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { mergeDrafts } from '../scripts/extract-hn-profiles/hn-merge-drafts.mjs';

const completeDraft = (changes = {}) => ({
  name: '', role: 'Engineer', summary: 'Builds systems.', location: '', workMode: '', availability: '',
  universities: [], companies: [], skills: [], dateRanges: [], ...changes
});

test('a complete second pass may remove unsupported facts even when it fills fewer fields', () => {
  const first = { nonce: 'a', injection: false, draft: completeDraft({ universities: ['Example University'], companies: ['Example Company'], skills: ['TypeScript'] }) };
  const corrected = { nonce: 'a', injection: false, draft: completeDraft() };
  const merged = mergeDrafts([first], [corrected]);
  assert.deepEqual(merged[0].draft, corrected.draft);
  assert.equal(merged[0].draft.universities.length, 0);
  assert.equal(merged[0].draft.companies.length, 0);
  assert.equal(merged[0].draft.skills.length, 0);
});

test('resume enrichment replaces a first pass and can fill a missing first-pass result', () => {
  const base = [{ nonce: 'a', injection: false, draft: completeDraft() }];
  const over = [
    { nonce: 'a', injection: false, draft: completeDraft({ name: 'Example Person', companies: ['Example Company'] }) },
    { nonce: 'b', injection: false, draft: completeDraft({ role: 'Designer' }) }
  ];
  const merged = Object.fromEntries(mergeDrafts(base, over).map((entry) => [entry.nonce, entry]));
  assert.equal(merged.a.draft.name, 'Example Person');
  assert.equal(merged.b.draft.role, 'Designer');
});

test('malformed or retired second-pass output cannot discard the complete first draft', () => {
  const first = { nonce: 'a', injection: false, draft: completeDraft({ universities: ['Example University'] }) };
  const invalid = [
    null, { nonce: 'a' }, { nonce: 'a', draft: null },
    { nonce: 'a', draft: { ...completeDraft(), summary: null } },
    { nonce: 'a', draft: { name: 'Partial', summary: 'Incomplete.' } },
    { nonce: 'a', draft: completeDraft({ universities: [42] }) },
    { nonce: 'a', draft: completeDraft({ companies: 'Example Company' }) },
    { nonce: 'a', draft: completeDraft({ summary: 'x'.repeat(2_001) }) },
    { nonce: 'a', draft: completeDraft({ skills: ['x'.repeat(201)] }) }
  ];
  for (const candidate of invalid) assert.deepEqual(mergeDrafts([first], [candidate])[0].draft, first.draft);
  assert.deepEqual(mergeDrafts([], [{ nonce: 'missing', draft: {} }]), []);
});

test('source-injection findings survive corrections and malformed or retired retries', () => {
  const safe = { nonce: 'a', injection: false, draft: completeDraft() };
  for (const draft of [null, {}, completeDraft()]) {
    assert.equal(mergeDrafts([safe], [{ nonce: 'a', injection: true, draft }])[0].injection, true);
  }
  assert.equal(mergeDrafts([{ ...safe, injection: true }], [{ ...safe, injection: false }])[0].injection, true);
});

test('correction survives assembly while a foreign retry nonce remains rejected', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hncd-merge-assembly-'));
  try {
    const first = { nonce: 'known', injection: false, draft: completeDraft({ universities: ['Example University'] }) };
    const over = [
      { nonce: 'known', injection: false, draft: completeDraft() },
      { nonce: 'foreign', injection: false, draft: completeDraft({ universities: ['Unrelated Institute'] }) }
    ];
    const batch = join(dir, 'batch-1.json');
    const drafts = join(dir, 'drafts-1.json');
    const out = join(dir, 'push.json');
    writeFileSync(batch, JSON.stringify({ items: [{ nonce: 'known' }] }));
    writeFileSync(join(dir, 'batch-1.map.json'), JSON.stringify({ known: {
      itemId: '900001', author: 'synthetic_handle', threadId: '900000', threadMonth: '2026-10',
      createdAt: '2026-10-01T00:00:00Z', commentText: 'Self-taught engineer. No university attendance.'
    } }));
    writeFileSync(drafts, JSON.stringify(mergeDrafts([first], over)));
    const report = JSON.parse(execFileSync(process.execPath, [
      new URL('../scripts/extract-hn-profiles/hn-assemble-push.mjs', import.meta.url).pathname,
      '--batch', batch, '--drafts', drafts, '--out', out
    ], { encoding: 'utf8' }));
    const pushed = JSON.parse(readFileSync(out, 'utf8'));
    assert.equal(pushed.profiles.length, 1);
    assert.deepEqual(pushed.profiles[0].draft.universities, []);
    assert.equal(pushed.profiles[0].comment.itemId, '900001');
    assert.deepEqual(report.rejected, [{ nonce: 'foreign', reason: 'unknown_nonce' }]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

