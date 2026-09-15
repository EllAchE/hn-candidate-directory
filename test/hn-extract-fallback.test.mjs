#!/usr/bin/env node
// The quota fallback is behaviour, not a string: it runs the real devbox-extract-batch.sh against
// stub extractors, because what matters is which one it invokes and when it declines to.

import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import test from 'node:test';

const script = fileURLToPath(new URL('../scripts/extract-hn-profiles/devbox-extract-batch.sh', import.meta.url));
const QUOTA = "You've hit your weekly limit · resets 12am (UTC)";

const basename = (p) => p.split('/').pop();

// A stub stands in for the extractor CLI and records that it ran, so a fallback that never fired and
// one that fired and failed are distinguishable. The codex stub keeps its .mjs name with a bash
// shebang because the script execs that path directly rather than handing it to node.
function stub(path, { message, exit, drafts }) {
  const lines = ['#!/usr/bin/env bash', `touch "$RAN_DIR/${basename(path)}.ran"`];
  if (message) lines.push(`echo ${JSON.stringify(message)}`);
  if (drafts) lines.push(`printf '%s' ${JSON.stringify(JSON.stringify(drafts))} >"$STUB_OUT"`);
  lines.push(`exit ${exit}`);
  writeFileSync(path, lines.join('\n') + '\n');
  chmodSync(path, 0o755);
}

// The codex arm shells out to ./scripts/extract-hn-profiles/hn-codex-extract-batch.mjs relative to
// HNCD_REPO, so the fake repo only needs that one path to exist. Setup is separate from the run
// because a batch with a drafts file is skipped as already extracted -- reusing one harness for two
// invocations measures that skip instead of the fallback.
function harness({ claude, codex }) {
  const root = mkdtempSync(join(tmpdir(), 'hncd-fallback-'));
  const dir = join(root, 'run');
  const bin = join(root, 'bin');
  const repo = join(root, 'repo', 'scripts', 'extract-hn-profiles');
  mkdirSync(dir, { recursive: true });
  mkdirSync(bin, { recursive: true });
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(dir, 'batch-1.json'), JSON.stringify({ batch: 1, delimiter: 'HNCD-AAAABBBB', items: [] }));
  stub(join(bin, 'claude'), claude);
  stub(join(repo, 'hn-codex-extract-batch.mjs'), codex);

  const run = (extraEnv = {}) =>
    spawnSync('bash', [script, '1', dir], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        HNCD_REPO: join(root, 'repo'),
        HNCD_BATCH_TIMEOUT: '30',
        RAN_DIR: root,
        STUB_OUT: join(dir, 'drafts-1.json'),
        ...extraEnv
      }
    });

  return {
    run,
    dir,
    ran: (name) => existsSync(join(root, `${name}.ran`)),
    cleanup: () => rmSync(root, { recursive: true, force: true })
  };
}

const ONE_DRAFT = [{ nonce: '0123456789abcdef01', name: 'A. Candidate' }];

test('A claude quota refusal falls back to codex and keeps the refusal log', () => {
  const h = harness({
    claude: { message: QUOTA, exit: 1 },
    codex: { exit: 0, drafts: ONE_DRAFT }
  });
  try {
    const res = h.run();
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.ok(h.ran('claude'), 'claude should have been tried first');
    assert.ok(h.ran('hn-codex-extract-batch.mjs'), 'codex should have been the fallback');
    assert.match(res.stdout, /falling back to codex/);
    assert.match(res.stdout, /extractor=codex/);
    // run_codex reuses the log; the reset time only survives if the refusal was copied aside.
    assert.match(readFileSync(join(h.dir, 'logs', 'batch-1.log.claude-quota'), 'utf8'), /weekly limit/);
    assert.equal(readFileSync(join(h.dir, 'logs', 'batch-1.extractor'), 'utf8').trim(), 'codex');
  } finally {
    h.cleanup();
  }
});

test('A non-quota claude failure stays a failure instead of burning a codex run', () => {
  const h = harness({
    claude: { message: 'extractor unavailable', exit: 1 },
    codex: { exit: 0, drafts: ONE_DRAFT }
  });
  try {
    const res = h.run();
    assert.equal(res.status, 1);
    assert.ok(h.ran('claude'));
    assert.equal(h.ran('hn-codex-extract-batch.mjs'), false, 'codex must not run for a non-quota failure');
    assert.match(res.stdout, /FAILED \(rc=1\)/);
    assert.equal(existsSync(join(h.dir, 'logs', 'batch-1.extractor')), false);
  } finally {
    h.cleanup();
  }
});

test('HNCD_NO_FALLBACK keeps a quota-exhausted batch a clean zero-draft failure', () => {
  const h = harness({
    claude: { message: QUOTA, exit: 1 },
    codex: { exit: 0, drafts: ONE_DRAFT }
  });
  try {
    const res = h.run({ HNCD_NO_FALLBACK: '1' });
    assert.equal(res.status, 1);
    assert.equal(h.ran('hn-codex-extract-batch.mjs'), false, 'opt-out must suppress the fallback');
    assert.match(res.stdout, /FAILED/);
  } finally {
    h.cleanup();
  }
});

test('A codex failure never falls back to claude', () => {
  const h = harness({
    claude: { exit: 0, drafts: ONE_DRAFT },
    codex: { message: QUOTA, exit: 1 }
  });
  try {
    const res = h.run({ HNCD_EXTRACTOR: 'codex' });
    assert.equal(res.status, 1);
    assert.equal(h.ran('claude'), false, 'the opted-out extractor must stay unused');
  } finally {
    h.cleanup();
  }
});

test('A successful claude run records itself and never invokes codex', () => {
  const h = harness({
    claude: { exit: 0, drafts: ONE_DRAFT },
    codex: { exit: 0, drafts: ONE_DRAFT }
  });
  try {
    const res = h.run();
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.equal(h.ran('hn-codex-extract-batch.mjs'), false);
    assert.match(res.stdout, /extractor=claude/);
    assert.equal(readFileSync(join(h.dir, 'logs', 'batch-1.extractor'), 'utf8').trim(), 'claude');
  } finally {
    h.cleanup();
  }
});
