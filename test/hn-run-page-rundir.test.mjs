#!/usr/bin/env node
// A run dir is re-entered by every retry of a page, and the tail stages address batches by number,
// so what the previous run left behind is indistinguishable from what this one produced.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import test from 'node:test';

const script = fileURLToPath(new URL('../scripts/extract-hn-profiles/devbox-run-page.sh', import.meta.url));
const PAGE = 'testpage';

// One `node` stub dispatches on the script name the real run would have invoked, so the page script
// executes its own control flow rather than a reimplementation of it. `gcloud` fails on purpose:
// that aborts the run at the first remote extract, just past the region under test.
function harness({ batchesReported, batchFilesWritten }) {
  const dir = mkdtempSync(join(tmpdir(), 'hncd-rundir-'));
  const bin = join(dir, 'bin');
  const run = join(dir, 'run', PAGE);
  const attachLog = join(dir, 'attach.log');
  mkdirSync(bin, { recursive: true });
  mkdirSync(run, { recursive: true });

  const batches = Array.from({ length: batchesReported }, () => ({ items: 5 }));
  writeFileSync(join(bin, 'node'), `#!/usr/bin/env bash
case "$(basename "$1")" in
  hncd-api.mjs) echo '{"remaining":10}' ;;
  hn-prepare-batch.mjs)
    for i in $(seq 1 ${batchFilesWritten}); do
      printf '%s' '{"delimiter":"HNCD-TEST","items":[]}' >"${run}/batch-$i.json"
      printf '%s' '{}' >"${run}/batch-$i.map.json"
    done
    printf '%s' ${JSON.stringify(JSON.stringify({ batches, missing: [] }))}
    ;;
  hn-attach-resumes.mjs) echo x >>"${attachLog}"; echo '{"attached":1,"fetched":1,"misses":{}}' ;;
  *) echo '{}' ;;
esac
exit 0
`);
  writeFileSync(join(bin, 'gcloud'), '#!/usr/bin/env bash\nexit 1\n');
  chmodSync(join(bin, 'node'), 0o755);
  chmodSync(join(bin, 'gcloud'), 0o755);

  const stale = (n, body = '[]') => writeFileSync(join(run, n), body);
  return {
    run,
    stale,
    attachCalls: () => (existsSync(attachLog) ? readFileSync(attachLog, 'utf8').split('\n').filter(Boolean).length : 0),
    exec: () => {
      try {
        execFileSync('bash', [script, PAGE], {
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH}`,
            HNCD_HOST: 'https://example.invalid',
            HNCD_RUN_ROOT: join(dir, 'run')
          },
          stdio: 'pipe'
        });
      } catch {
        // The gcloud stub makes the remote extract fail, so a non-zero exit is the expected end.
      }
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true })
  };
}

test('a re-run clears every per-batch artefact the previous run left, not just drafts', () => {
  const h = harness({ batchesReported: 2, batchFilesWritten: 2 });
  try {
    // Batch 9 belongs to a longer previous run: this one prepares 2, so nothing downstream
    // regenerates 9 and its screened/check files would be read as though this run wrote them.
    h.stale('screened-9.json');
    h.stale('check-9.json', '{"flagged":[]}');
    h.stale('push-1.json');
    h.stale('drafts-9.json');
    mkdirSync(join(h.run, 'pass2'), { recursive: true });
    h.stale('pass2/batch-9.json', '{}');
    // A content-keyed resume fetch is the expensive part of a page and is safe to reuse.
    h.stale('resume-deadbeef.txt', 'resume text');

    h.exec();

    for (const gone of ['screened-9.json', 'check-9.json', 'push-1.json', 'drafts-9.json']) {
      assert.equal(existsSync(join(h.run, gone)), false, `${gone} survived the re-run`);
    }
    assert.equal(existsSync(join(h.run, 'pass2', 'batch-9.json')), false, 'stale pass2 batch survived');
    assert.equal(existsSync(join(h.run, 'resume-deadbeef.txt')), true, 'resume cache was cleared');
  } finally {
    h.cleanup();
  }
});

test('the batch count comes from prepare output, not from what is on disk', () => {
  // Prepare writes a third batch file it does not report -- a stray or half-written file. The glob
  // this replaced would have looped 3 batches and then polled the box for a draft never requested.
  const h = harness({ batchesReported: 2, batchFilesWritten: 3 });
  try {
    h.exec();
    assert.equal(h.attachCalls(), 2, 'resume pass 1 did not follow the reported batch count');
  } finally {
    h.cleanup();
  }
});
