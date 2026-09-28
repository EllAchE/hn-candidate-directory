#!/usr/bin/env node
// A run dir is re-entered by every retry of a page, and the tail stages address batches by number,
// so what the previous run left behind is indistinguishable from what this one produced.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import test from 'node:test';

const script = fileURLToPath(new URL('../scripts/extract-hn-profiles/devbox-run-page.sh', import.meta.url));
const PAGE = 'testpage';

// One `node` stub dispatches on the script name the real run would have invoked, so the page script
// executes its own control flow rather than a reimplementation of it. `gcloud` fails on purpose:
// that aborts the run at the first remote extract, just past the region under test -- unless
// `extracted` is given, in which case the box "returns" those drafts and the run goes on to push.
function harness({ batchesReported, batchFilesWritten, missing = [], sources = null, extracted = null }) {
  const dir = mkdtempSync(join(tmpdir(), 'hncd-rundir-'));
  const bin = join(dir, 'bin');
  const run = join(dir, 'run', PAGE);
  const attachLog = join(dir, 'attach.log');
  const pushes = join(dir, 'pushes');
  const box = join(dir, 'box');
  mkdirSync(bin, { recursive: true });
  mkdirSync(run, { recursive: true });
  mkdirSync(pushes, { recursive: true });
  mkdirSync(box, { recursive: true });
  const pending = { remaining: 10, items: missing.map((hnItemId) => ({ hnItemId, threadId: '1' })) };
  if (extracted) writeFileSync(join(box, 'drafts-1.json'), JSON.stringify(extracted.drafts));

  const batches = Array.from({ length: batchesReported }, () => ({ items: 5 }));
  writeFileSync(join(bin, 'node'), `#!/usr/bin/env bash
case "$(basename "$1")" in
  hncd-api.mjs)
    if [ "$2" = push ]; then
      cp "$4" "${pushes}/$(ls "${pushes}" | wc -l | tr -d ' ').json"
      echo '{"pending":7,"results":[]}'
    else
      printf '%s' ${JSON.stringify(JSON.stringify(pending))}
    fi
    ;;
  hn-prepare-batch.mjs)
    for i in $(seq 1 ${batchFilesWritten}); do
      printf '%s' ${JSON.stringify(JSON.stringify({ delimiter: 'HNCD-TEST', items: Object.keys(extracted?.map ?? {}).map((nonce) => ({ nonce })) }))} >"${run}/batch-$i.json"
      printf '%s' ${JSON.stringify(JSON.stringify(extracted?.map ?? {}))} >"${run}/batch-$i.map.json"
    done
    printf '%s' ${JSON.stringify(JSON.stringify({ batches, missing }))}
    ;;
  hn-check-sources.mjs) printf '%s' ${sources === false ? "''" : JSON.stringify(JSON.stringify(sources ?? {}))} >"$5"; echo '{}' ;;
  hn-check-drafts.mjs) printf '%s' ${JSON.stringify(JSON.stringify({ flagged: extracted?.flagged ?? [] }))} >"$7"; echo '{}' ;;
  hn-screen-pronouns.mjs) cp "$5" "$7"; echo '{"dropped":[]}' ;;
  hn-assemble-push.mjs)
    # Every screened draft whose nonce the map knows becomes a push entry, as the real assembly does.
    jq -c --slurpfile m "\${3%.json}.map.json" '{extractor:"claude-skill-v2", profiles:[.[] | select($m[0][.nonce] != null) | {comment:$m[0][.nonce], draft}]}' "$5" >"$9"
    [ "$(jq '.profiles | length' "$9")" -gt 0 ] || rm -f "$9"
    echo '{"profiles":0,"rejected":[],"trimmed":[],"skipped":[]}'
    ;;
  hn-attach-resumes.mjs) echo x >>"${attachLog}"; echo '{"attached":1,"fetched":1,"misses":{}}' ;;
  hn-page-state.mjs) exec "${process.execPath}" "$@" ;;
  *) echo '{}' ;;
esac
exit 0
`);
  writeFileSync(
    join(bin, 'gcloud'),
    // Answers each remote step the way a healthy box would: nothing running, launched, extracted, packed.
    extracted
      ? `#!/usr/bin/env bash
if [ "$2" = scp ]; then case "\${@: -1}" in */d.tgz) tar czf "\${@: -1}" -C "${box}" drafts-1.json ;; esac; exit 0; fi
for a in "$@"; do case "$a" in --command=*) cmd="\${a#--command=}" ;; esac; done
case "$cmd" in
  *"tmux new-session"*) echo launched ;;
  "for i in"*) echo "extracted 1/1" ;;
  *"tar czf"*) echo packed ;;
  *) echo stopped ;;
esac
exit 0
`
      : '#!/usr/bin/env bash\nexit 1\n'
  );
  chmodSync(join(bin, 'node'), 0o755);
  chmodSync(join(bin, 'gcloud'), 0o755);

  const stale = (n, body = '[]') => writeFileSync(join(run, n), body);
  return {
    run,
    stale,
    pushed: () =>
      readdirSync(pushes)
        .sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10))
        .map((name) => JSON.parse(readFileSync(join(pushes, name), 'utf8'))),
    attachCalls: () => (existsSync(attachLog) ? readFileSync(attachLog, 'utf8').split('\n').filter(Boolean).length : 0),
    exec: (extraEnv = {}) => {
      try {
        return execFileSync('bash', [script, PAGE], {
          env: {
            ...process.env,
            HNCD_PASSES: '1',
            ...extraEnv,
            PATH: `${bin}:${process.env.PATH}`,
            HNCD_HOST: 'https://example.invalid',
            HNCD_RUN_ROOT: join(dir, 'run')
          },
          stdio: 'pipe',
          encoding: 'utf8'
        });
      } catch (error) {
        // The gcloud stub makes the remote extract fail, so a non-zero exit is the expected end.
        return error.stdout ?? '';
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
    h.stale('retire-1.json');
    h.stale('hold-1.json');
    mkdirSync(join(h.run, 'pass2'), { recursive: true });
    h.stale('pass2/batch-9.json', '{}');
    // A content-keyed resume fetch is the expensive part of a page and is safe to reuse.
    h.stale('resume-deadbeef.txt', 'resume text');

    h.exec();

    for (const gone of ['screened-9.json', 'check-9.json', 'push-1.json', 'drafts-9.json', 'retire-1.json', 'hold-1.json']) {
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

test('the tarball carries every file that frames the model, and still no identity map', () => {
  // The codex arm reads its instructions from the module and the agent definition rather than from
  // the batch script, so shipping only the batch script left codex framed by the box's own clone.
  const h = harness({ batchesReported: 1, batchFilesWritten: 1 });
  try {
    h.exec();
    const shipped = execFileSync('tar', ['tzf', join(h.run, 'ship.tgz')], { encoding: 'utf8' })
      .split('\n').filter(Boolean).map((n) => n.replace(/^\.\//, ''));
    for (const needed of ['devbox-extract-batch.sh', 'hn-codex-extract-batch.mjs', 'hn-profile-extractor.md']) {
      assert.ok(shipped.includes(needed), `${needed} did not travel with the batches`);
    }
    assert.equal(shipped.some((n) => n.includes('.map.')), false, 'a nonce->id map reached the tarball');
  } finally {
    h.cleanup();
  }
});

test('an item prepare dropped is retired by id once its source is confirmed gone, and held otherwise', () => {
  // 222 is absent from Algolia but Firebase could not be reached, so nothing proves it was deleted;
  // 444 is alive on Firebase and only missing from the thread listing. Neither may be retired, and
  // neither may stay pending, where it would head every later page.
  const page = {
    batchesReported: 1,
    batchFilesWritten: 1,
    missing: ['111', '222', '444'],
    sources: { ids: { 111: 'deleted' }, unreachableIds: ['222'] }
  };
  const retirement = { extractor: 'claude-skill-v2', profiles: [{ hnItemId: '111', draft: null, reason: 'deleted' }] };
  // The box is down: the retirement is written and kept for the push stage, not sent ahead of it.
  const down = harness(page);
  const up = harness({
    ...page,
    extracted: { map: { n1: { objectID: '333' } }, drafts: [{ nonce: 'n1', draft: {} }], flagged: [] }
  });
  try {
    down.exec();
    assert.deepEqual(down.pushed(), []);
    assert.deepEqual(JSON.parse(readFileSync(join(down.run, 'retire-1.json'), 'utf8')), retirement);
    const checked = JSON.parse(readFileSync(join(down.run, 'dropped.json'), 'utf8'));
    assert.deepEqual(checked.items.map((item) => item.hnItemId), ['111', '222', '444']);

    const out = up.exec();
    assert.deepEqual(up.pushed(), [
      retirement,
      { extractor: 'claude-skill-v2', profiles: [{ comment: { objectID: '333' }, draft: {} }] },
      {
        extractor: 'claude-skill-v2',
        profiles: [
          { hnItemId: '222', hold: true, reason: 'source_unreachable' },
          { hnItemId: '444', hold: true, reason: 'source_alive' }
        ]
      }
    ]);
    assert.match(out, /outcomes \{"page":4,"drafted":1,"retired":1,"held":2,"no_draft_batch":0,"source_alive":1,"source_unreachable":1,"draft_missing":0,"flagged":0,"other":0\}/);
  } finally {
    down.cleanup();
    up.cleanup();
  }
});

test('a page of nothing but deletions retires them and finishes the tag', () => {
  const h = harness({ batchesReported: 0, batchFilesWritten: 0, missing: ['111'], sources: { ids: { 111: 'deleted' } } });
  try {
    h.exec();
    assert.deepEqual(h.pushed(), [{ extractor: 'claude-skill-v2', profiles: [{ hnItemId: '111', draft: null, reason: 'deleted' }] }]);
    assert.equal(existsSync(join(h.run, 'state', 'pushed')), true);
    h.exec();
    assert.equal(h.pushed().length, 1, 'a finished retirement-only tag pushed again');
  } finally {
    h.cleanup();
  }
});

test('a page with no batches holds a dropped item that is alive, and waits when the check failed', () => {
  const alive = harness({
    batchesReported: 0,
    batchFilesWritten: 0,
    missing: ['111', '222'],
    sources: { ids: { 111: 'deleted' }, unreachableIds: [] }
  });
  // `false` leaves the answer file empty, which reads as a failed check: nothing to push yet, so the
  // next run asks again rather than hold what may be retirable.
  const unchecked = harness({ batchesReported: 0, batchFilesWritten: 0, missing: ['111'], sources: false });
  try {
    alive.exec();
    assert.deepEqual(alive.pushed(), [
      { extractor: 'claude-skill-v2', profiles: [{ hnItemId: '111', draft: null, reason: 'deleted' }] },
      { extractor: 'claude-skill-v2', profiles: [{ hnItemId: '222', hold: true, reason: 'source_alive' }] }
    ]);
    assert.equal(existsSync(join(alive.run, 'state', 'pushed')), true);

    unchecked.exec();
    assert.deepEqual(unchecked.pushed(), []);
    assert.equal(existsSync(join(unchecked.run, 'state', 'assembled')), false);
  } finally {
    alive.cleanup();
    unchecked.cleanup();
  }
});

const threeFlags = () => ({
  map: { n1: { objectID: '333' }, n2: { objectID: '444' }, n3: { objectID: '555' } },
  drafts: [{ nonce: 'n1', draft: { name: '' } }, { nonce: 'n3', draft: { name: '' } }],
  // n2 never came back from the box, and n3's draft is malformed: harness misses, not verdicts.
  flagged: [
    { nonce: 'n1', missing: ['name'] },
    { nonce: 'n2', missing: ['draft'] },
    { nonce: 'n3', missing: ['malformed'] }
  ]
});
// [id, reason] pairs, in payload order.
const holds = (...entries) => ({
  extractor: 'claude-skill-v2',
  profiles: entries.map(([hnItemId, reason]) => ({ hnItemId, hold: true, reason }))
});

test('with HNCD_HOLD_MISSES a flagged item is pushed as a hold, never as a draft', () => {
  const h = harness({ batchesReported: 1, batchFilesWritten: 1, extracted: threeFlags() });
  try {
    const out = h.exec({ HNCD_HOLD_MISSES: '1' });
    // 444 has no draft at all and 555's is malformed: held as well, or they head the next page.
    assert.deepEqual(h.pushed(), [holds(['333', 'flagged'], ['444', 'draft_missing'], ['555', 'draft_missing'])]);
    assert.deepEqual(JSON.parse(readFileSync(join(h.run, 'screened-1.json'), 'utf8')), []);
    assert.match(out, /"held":3,.*"draft_missing":2,"flagged":1,"other":0/);
  } finally {
    h.cleanup();
  }
});

test('without HNCD_HOLD_MISSES a flagged draft is published and an item with no draft is still held', () => {
  const h = harness({ batchesReported: 1, batchFilesWritten: 1, extracted: threeFlags() });
  try {
    const out = h.exec({ HNCD_HOLD_MISSES: '0' });
    const [drafts, held, ...rest] = h.pushed();
    assert.deepEqual(rest, []);
    assert.deepEqual(drafts.profiles.map((p) => p.comment.objectID), ['333', '555']);
    assert.deepEqual(held, holds(['444', 'draft_missing']));
    assert.match(out, /"drafted":2,"retired":0,"held":1,.*"draft_missing":1,"flagged":0/);
  } finally {
    h.cleanup();
  }
});

test('a page that is almost all holds splits them at the push batch limit instead of dropping any', () => {
  const ids = Array.from({ length: 27 }, (_, index) => String(9000 + index));
  const extracted = {
    map: Object.fromEntries(ids.map((id) => [`n${id}`, { objectID: id }])),
    drafts: ids.map((id) => ({ nonce: `n${id}`, draft: {} })),
    flagged: ids.map((id) => ({ nonce: `n${id}`, missing: ['companies'] }))
  };
  const h = harness({ batchesReported: 1, batchFilesWritten: 1, extracted });
  try {
    h.exec({ HNCD_HOLD_MISSES: '1' });
    const pushed = h.pushed();
    assert.deepEqual(pushed.map((payload) => payload.profiles.length), [25, 2]);
    assert.deepEqual(pushed.flatMap((payload) => payload.profiles.map((entry) => entry.hnItemId)).sort(), ids);
  } finally {
    h.cleanup();
  }
});
