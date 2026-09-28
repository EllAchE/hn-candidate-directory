#!/usr/bin/env node
// The backfill re-sends step-outs that already landed, only to name their reason, so its dry run has to
// show exactly what it would send and send nothing.

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import test from 'node:test';

import { retireReasons } from '../scripts/extract-hn-profiles/hn-page-state.mjs';

const script = fileURLToPath(new URL('../scripts/extract-hn-profiles/backfill-step-outs.mjs', import.meta.url));

function tree(files) {
  const root = mkdtempSync(join(tmpdir(), 'hncd-backfill-'));
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(join(root, name, '..'), { recursive: true });
    writeFileSync(join(root, name), typeof body === 'string' ? body : JSON.stringify(body));
  }
  return root;
}

const hold = (...ids) => ({ extractor: 'claude-skill-v2', profiles: ids.map((hnItemId) => ({ hnItemId, hold: true })) });

test('retire reasons use the Worker vocabulary and leave an unknown verdict out', () => {
  assert.deepEqual(retireReasons({ ids: { 1: 'deleted', 2: 'no_text', 3: 'dead', 4: 'missing', 5: 'alive' } }), {
    1: 'deleted',
    2: 'textless',
    3: 'dead',
    4: 'missing'
  });
  assert.deepEqual(retireReasons(undefined), {});
});

test('dry run prints the restatements for landed step-outs only, newest tag first, and sends nothing', () => {
  const root = tree({
    // Finished, with a recorded holds.json. hold-2 never landed, so its id is not restated.
    '20260928-p17/state/pushed': '',
    '20260928-p17/state/pushed-retire-1': '',
    '20260928-p17/state/pushed-hold-1': '',
    '20260928-p17/retire-1.json': { extractor: 'claude-skill-v2', profiles: [{ hnItemId: '101', draft: null }, { hnItemId: '102', draft: null }] },
    '20260928-p17/sources.json': { ids: { 101: 'deleted', 102: 'no_text' }, unreachableIds: [] },
    '20260928-p17/hold-1.json': hold('201', '202', '301'),
    '20260928-p17/hold-2.json': hold('299'),
    '20260928-p17/holds.json': { heldBy: { 201: 'flagged', 202: 'draft_missing', 299: 'other' } },
    // Before step-outs: no state, so the holds are derived. 301 was re-read by p17 and keeps p17's answer.
    '20260920-p15/prepare.json': { batches: [{}], missing: [] },
    '20260920-p15/pending.json': { items: [{ hnItemId: '301' }, { hnItemId: '302' }] },
    '20260920-p15/batch-1.map.json': { a: { objectID: '301' }, b: { objectID: '302' } },
    '20260920-p15/push-1.json': { extractor: 'claude-skill-v2', profiles: [] },
    // Still running: never read.
    '20260928-p18/state/prepared': '',
    '20260928-p18/hold-1.json': hold('401'),
    // Not a page tag.
    '20260920-p15-pass1/hold-1.json': hold('501')
  });
  try {
    const run = spawnSync(process.execPath, [script, '--root', root], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stderr, /"tag":"20260928-p18","skipped":"not finished"/);
    assert.match(run.stderr, /dry run, 1 payload\(s\); nothing sent/);
    const payloads = run.stdout.trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(payloads, [
      {
        extractor: 'claude-skill-v2',
        profiles: [
          { hnItemId: '101', draft: null, reason: 'deleted', restate: true },
          { hnItemId: '102', draft: null, reason: 'textless', restate: true },
          { hnItemId: '201', hold: true, reason: 'flagged', restate: true },
          { hnItemId: '202', hold: true, reason: 'draft_missing', restate: true },
          { hnItemId: '301', hold: true, reason: 'unrecorded', restate: true },
          { hnItemId: '302', hold: true, reason: 'no_draft_batch', restate: true }
        ]
      }
    ]);
    // Never a draft: a restatement cannot write a profile.
    assert.ok(payloads.every((payload) => payload.profiles.every((entry) => entry.hold === true || entry.draft === null)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('--send without --host is refused before anything is read', () => {
  const run = spawnSync(process.execPath, [script, '--root', '/nonexistent', '--send'], { encoding: 'utf8' });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /usage/);
});
