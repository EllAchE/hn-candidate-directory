#!/usr/bin/env node
// A page run that dies partway -- a killed runner, a slept Mac, a dropped tunnel -- must be picked
// up by re-running its tag without losing model work, and without letting a draft from a different
// prepare anywhere near assembly.

import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import test from 'node:test';

import { bindDrafts, planRun } from '../scripts/extract-hn-profiles/hn-page-state.mjs';

const script = fileURLToPath(new URL('../scripts/extract-hn-profiles/devbox-run-page.sh', import.meta.url));

// --- the decision and the binding, directly ------------------------------------------------

function runDir(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'hncd-plan-'));
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), typeof body === 'string' ? body : JSON.stringify(body));
  }
  return dir;
}

const prepared = (extra = {}) => ({
  'state/prepared': '',
  'prepare.json': { batches: [{ batch: 1 }, { batch: 2 }], missing: [] },
  'batch-1.json': { items: [{ nonce: 'a' }] },
  'batch-1.map.json': { a: {} },
  'batch-2.json': { items: [{ nonce: 'b' }] },
  'batch-2.map.json': { b: {} },
  ...extra
});

test('plan: an empty run dir starts fresh', () => {
  const dir = runDir();
  try {
    assert.equal(planRun({ runDir: dir }).action, 'fresh');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('plan: a completed prepare resumes, and HNCD_FRESH overrides it', () => {
  const dir = runDir(prepared({ 'state/extracted-p1': '' }));
  try {
    const plan = planRun({ runDir: dir });
    assert.equal(plan.action, 'resume');
    assert.equal(plan.batches, 2);
    assert.ok(plan.stages.includes('extracted-p1'));
    assert.equal(planRun({ runDir: dir, fresh: true }).action, 'fresh');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('plan: batches without the prepared marker, or a lost map, are not resumed', () => {
  const unmarked = runDir(Object.fromEntries(Object.entries(prepared()).filter(([k]) => k !== 'state/prepared')));
  const lostMap = runDir(Object.fromEntries(Object.entries(prepared()).filter(([k]) => k !== 'batch-2.map.json')));
  try {
    assert.equal(planRun({ runDir: unmarked }).action, 'fresh');
    const plan = planRun({ runDir: lostMap });
    assert.equal(plan.action, 'fresh');
    assert.match(plan.reason, /batch-2\.map\.json/);
  } finally {
    rmSync(unmarked, { recursive: true, force: true });
    rmSync(lostMap, { recursive: true, force: true });
  }
});

test('plan: a tag that pushed refuses, even under HNCD_FRESH', () => {
  const done = runDir(prepared({ 'state/pushed': '' }));
  const partial = runDir(prepared({ 'state/pushed-1': '' }));
  const partialLost = runDir(prepared({ 'state/pushed-1': '', 'prepare.json': '{}' }));
  try {
    assert.equal(planRun({ runDir: done }).action, 'refuse');
    assert.equal(planRun({ runDir: done, fresh: true }).action, 'refuse');
    // Some batches landed: resuming pushes the rest, starting over would re-read a changed pending.
    assert.equal(planRun({ runDir: partial }).action, 'resume');
    assert.deepEqual(planRun({ runDir: partial }).pushed, ['1']);
    assert.equal(planRun({ runDir: partial, fresh: true }).action, 'refuse');
    assert.equal(planRun({ runDir: partialLost }).action, 'refuse');
  } finally {
    for (const d of [done, partial, partialLost]) rmSync(d, { recursive: true, force: true });
  }
});

test('bind: only drafts whose every nonce this prepare minted are kept', () => {
  const batch = { items: [{ nonce: 'n1' }, { nonce: 'n2' }] };
  const map = { n1: {}, n2: {} };
  assert.equal(bindDrafts({ batch, map, drafts: [{ nonce: 'n1', draft: {} }] }).bound, true);
  assert.equal(bindDrafts({ batch, map, drafts: { profiles: [{ nonce: 'n2' }] } }).bound, true);
  const stale = bindDrafts({ batch, map, drafts: [{ nonce: 'n1' }, { nonce: 'old' }] });
  assert.equal(stale.bound, false);
  assert.equal(stale.reason, 'foreign_nonce');
  assert.deepEqual(stale.unknown, ['old']);
  assert.equal(bindDrafts({ batch, map, drafts: [] }).reason, 'empty');
  assert.equal(bindDrafts({ batch, map, drafts: undefined }).reason, 'unreadable');
  assert.equal(bindDrafts({ batch, map, drafts: [{ draft: {} }] }).bound, false);
  // A pass-2 subset batch that somehow carries a nonce the map never had still does not bind.
  assert.equal(bindDrafts({ batch: { items: [{ nonce: 'x' }] }, map, drafts: [{ nonce: 'x' }] }).bound, false);
});

// --- the page script against a fake box ------------------------------------------------------
// gcloud runs each ssh command locally with HOME pointed at a fake box, tmux runs the pool in the
// foreground, and claude writes one draft per item. Everything between -- binding, check, screen,
// assemble -- is the real code; only the network ends (pending, prepare, resumes, push) are stubs.

const NB = 2;

// `missing` are ids prepare drops and `sources` is what the Firebase check answers for them.
function harness(page, { missing = [], sources = {}, batches: NB = 2 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'hncd-resume-'));
  const bin = join(dir, 'bin');
  const box = join(dir, 'box');
  const boxTmp = join(dir, 'boxtmp');
  const flags = join(dir, 'flags');
  const calls = join(dir, 'calls.log');
  for (const d of [bin, box, boxTmp, flags, join(box, 'hn-candidate-directory')]) mkdirSync(d, { recursive: true });

  const stub = (name, body) => {
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}`);
    chmodSync(join(bin, name), 0o755);
  };

  stub('node', `
case "$(basename "$1")" in
  hncd-api.mjs)
    if [ "$2" = pending ]; then echo pending >>"${calls}"; printf '%s\\n' ${JSON.stringify(JSON.stringify({ remaining: 10, items: missing.map((hnItemId) => ({ hnItemId })) }))}; exit 0; fi
    file="$4"; n=$(basename "$file" .json); n=\${n#push-}
    [ -e "${flags}/fail-push-$n" ] && exit 1
    echo "push $n" >>"${calls}"
    jq -c '{pending:0, results:[.profiles[] | {outcome:(if .hold then "held" elif (has("draft") and .draft == null) then "retired" else "updated" end)}]}' "$file"
    ;;
  hn-prepare-batch.mjs)
    echo prepare >>"${calls}"
    out="$5"; stamp="$RANDOM$RANDOM"
    for b in $(seq 1 ${NB}); do
      jq -n --arg s "$stamp" --argjson b "$b" '{batch:$b, delimiter:"HNCD-TEST", items:[range(2) | {nonce:"n\\($s)-\\($b)-\\(.)", text:"Location: Berlin\\nI build compilers.", links:[]}]}' >"$out/batch-$b.json"
      jq '[.items[] | {key:.nonce, value:{objectID:.nonce, author:"someone", comment_text:.text, created_at:"2026-01-01T00:00:00Z", threadId:1, threadMonth:"2026-01"}}] | from_entries' "$out/batch-$b.json" >"$out/batch-$b.map.json"
    done
    jq -n '{prepared:${NB * 2}, missing:${JSON.stringify(missing)}, batches:[range(${NB}) | {items:2}]}'
    ;;
  hn-check-sources.mjs)
    echo sources >>"${calls}"
    printf '%s' ${JSON.stringify(JSON.stringify(sources))} >"$5"; echo '{}'
    ;;
  hn-check-drafts.mjs)
    # flag-<batch file> makes the miss check flag every item in that batch for an empty employer.
    if [ -e "${flags}/flag-$(basename "$3")" ]; then
      jq '{items:(.items|length), withResume:0, retired:0, flagged:[.items[] | {nonce, missing:["companies"]}], missing:{companies:(.items|length)}}' "$3" >"$7"
      echo '{"items":2,"flagged":2}'
    else exec "${process.execPath}" "$@"; fi
    ;;
  hn-attach-resumes.mjs)
    batch="$3"; write=""; prev=""
    for a in "$@"; do [ "$prev" = --write ] && write="$a"; prev="$a"; done
    written=0
    if [ -n "$write" ]; then
      echo "p2prep $(basename "$batch")" >>"${calls}"
      if [ -e "${flags}/retry-$(basename "$batch")" ]; then mkdir -p "$(dirname "$write")"; cp "$batch" "$write"; written=2; fi
    fi
    echo '{"attached":0,"fetched":0,"misses":{},"written":'"$written"'}'
    ;;
  *) exec "${process.execPath}" "$@" ;;
esac
`);

  stub('gcloud', `
[ "$2" = scp ] && {
  src="\${@: -2:1}"; dst="\${@: -1}"
  [ -e "${flags}/fail-pull" ] && [[ "$src" == dev-vm:/tmp/d-* ]] && exit 1
  [ -e "${flags}/fail-pull-p2" ] && [[ "$src" == dev-vm:/tmp/d-*-p2.tgz ]] && exit 1
  src="\${src/#dev-vm:\\/tmp\\//${boxTmp}/}"; dst="\${dst/#dev-vm:\\/tmp\\//${boxTmp}/}"
  exec cp "$src" "$dst"
}
for a in "$@"; do case "$a" in --command=*) cmd="\${a#--command=}" ;; esac; done
cmd="\${cmd//\\/tmp\\//${boxTmp}/}"
[ -e "${flags}/hang-poll" ] && [[ "$cmd" == "for i in"* ]] && { sleep 60; exit 0; }
HOME="${box}" exec bash -c "$cmd"
`);

  stub('tmux', `
case "$1" in
  # A real new-session returns once the session starts, whatever the pool inside it later does.
  new-session) shift 4; echo "pool $*" >>"${calls}"; bash -c "$1" || true ;;
  has-session) [ -e "${flags}/tmux-$3" ] ;;
  kill-session) rm -f "${flags}/tmux-$3" ;;
esac
`);

  // nodraft-<batch file>: the model answers nothing for that batch. partial-: only its first item.
  // gender-: its first summary genders a candidate the comment never did, which the screen drops.
  stub('claude', `
batch=$(grep -oE 'Read [^ ]+batch-[0-9]+\\.json' <<<"$2" | head -1 | cut -d' ' -f2)
n=$(basename "$batch" .json); n=\${n#batch-}
echo "claude $n" >>"${calls}"
[ -e "${flags}/nodraft-batch-$n.json" ] && exit 1
keep=1000; [ -e "${flags}/partial-batch-$n.json" ] && keep=1
he=""; [ -e "${flags}/gender-batch-$n.json" ] && he=0
jq --argjson keep "$keep" --arg he "$he" '[.items[:$keep] | to_entries[] | {nonce:.value.nonce, injection:false, draft:{name:"Ada", role:"Compiler engineer", summary:(if ($he != "" and .key == ($he|tonumber)) then "She builds compilers." else "Builds compilers." end), location:"Berlin", workMode:"", availability:"", companies:[], universities:[], skills:[], dateRanges:[]}}]' "$batch" >"\${batch%batch-$n.json}drafts-$n.json"
`);

  const run = join(dir, 'run', page);
  const remote = join(box, 'hncd-backfill', page);
  return {
    run,
    remote,
    flagPath: (name) => join(flags, name),
    flag: (name, on = true) => (on ? writeFileSync(join(flags, name), '') : rmSync(join(flags, name), { force: true })),
    calls: () => (existsSync(calls) ? readFileSync(calls, 'utf8').split('\n').filter(Boolean) : []),
    resetCalls: () => rmSync(calls, { force: true }),
    state: () => (existsSync(join(run, 'state')) ? readdirSync(join(run, 'state')) : []),
    nonces: (n) => JSON.parse(readFileSync(join(run, `batch-${n}.json`), 'utf8')).items.map((i) => i.nonce),
    exec: (env = {}) => {
      const started = Date.now();
      const result = spawnSync('bash', [script, page], {
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          HNCD_HOST: 'https://example.invalid',
          HNCD_RUN_ROOT: join(dir, 'run'),
          HNCD_POLL_INTERVAL: '1',
          HNCD_HOLD_MISSES: '0',
          HNCD_FRESH: '',
          ...env
        },
        encoding: 'utf8'
      });
      return { ...result, seconds: (Date.now() - started) / 1000 };
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true })
  };
}

const count = (calls, prefix) => calls.filter((c) => c.startsWith(prefix)).length;

test('a finished page pushes once and then refuses to run again', { timeout: 60_000 }, () => {
  const h = harness('t-done');
  try {
    const first = h.exec();
    assert.equal(first.status, 0, first.stderr);
    assert.deepEqual(h.calls().filter((c) => /^(pending|prepare|push)/.test(c)), ['pending', 'prepare', 'push 1', 'push 2']);
    assert.equal(count(h.calls(), 'claude'), NB);
    assert.ok(h.state().includes('pushed'));

    h.resetCalls();
    const again = h.exec();
    assert.notEqual(again.status, 0);
    assert.match(again.stderr, /refusing/);
    assert.deepEqual(h.calls(), []);
    assert.notEqual(h.exec({ HNCD_FRESH: '1' }).status, 0, 'HNCD_FRESH reopened a pushed tag');
  } finally {
    h.cleanup();
  }
});

test('a run that dies after extraction resumes from the drafts on the box, with no new prepare', { timeout: 60_000 }, () => {
  const h = harness('t-resume');
  try {
    h.flag('fail-pull');
    const first = h.exec();
    assert.notEqual(first.status, 0);
    const nonces = [h.nonces(1), h.nonces(2)];
    assert.ok(existsSync(join(h.remote, 'drafts-1.json')), 'the box never extracted');
    assert.equal(h.calls().includes('push 1'), false);

    h.flag('fail-pull', false);
    h.resetCalls();
    const second = h.exec();
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /resuming/);
    assert.deepEqual([h.nonces(1), h.nonces(2)], nonces, 'the batches were prepared again');
    assert.equal(count(h.calls(), 'prepare'), 0);
    assert.equal(count(h.calls(), 'pending'), 0, 'a resumed run re-read pending');
    assert.equal(count(h.calls(), 'claude'), 0, 'finished batches were extracted again');
    assert.deepEqual(h.calls().filter((c) => c.startsWith('push')), ['push 1', 'push 2']);
    const pushed = JSON.parse(readFileSync(join(h.run, 'push-1.json'), 'utf8'));
    assert.deepEqual(pushed.profiles.map((p) => p.comment.objectID).sort(), [...nonces[0]].sort());
  } finally {
    h.cleanup();
  }
});

test('a draft from a different prepare is discarded and its batch extracted again', { timeout: 60_000 }, () => {
  const h = harness('t-stale');
  try {
    h.flag('fail-pull');
    h.exec();
    h.flag('fail-pull', false);
    // The p13 shape: the box holds a non-empty draft for batch 1 whose nonces this prepare never minted.
    writeFileSync(join(h.remote, 'drafts-1.json'), JSON.stringify([{ nonce: 'from-an-older-prepare', draft: null }]));
    writeFileSync(join(h.run, 'drafts-1.json'), JSON.stringify([{ nonce: 'from-an-older-prepare', draft: null }]));

    h.resetCalls();
    const second = h.exec();
    assert.equal(second.status, 0, second.stderr);
    assert.deepEqual(h.calls().filter((c) => c.startsWith('claude')), ['claude 1']);
    const drafts = JSON.parse(readFileSync(join(h.run, 'drafts-1.json'), 'utf8'));
    assert.deepEqual(drafts.map((d) => d.nonce).sort(), [...h.nonces(1)].sort());
    const pushed = JSON.parse(readFileSync(join(h.run, 'push-1.json'), 'utf8'));
    assert.equal(pushed.profiles.some((p) => p.comment.objectID === 'from-an-older-prepare'), false);
  } finally {
    h.cleanup();
  }
});

test('HNCD_FRESH prepares again and clears the box before shipping', { timeout: 60_000 }, () => {
  const h = harness('t-fresh');
  try {
    h.flag('fail-pull');
    h.exec();
    const old = h.nonces(1);
    h.flag('fail-pull', false);
    writeFileSync(join(h.remote, 'drafts-9.json'), '[{"nonce":"leftover"}]');

    h.resetCalls();
    const fresh = h.exec({ HNCD_FRESH: '1' });
    assert.equal(fresh.status, 0, fresh.stderr);
    assert.equal(count(h.calls(), 'prepare'), 1);
    assert.notDeepEqual(h.nonces(1), old);
    assert.equal(count(h.calls(), 'claude'), NB);
    assert.equal(existsSync(join(h.remote, 'drafts-9.json')), false, 'the box kept a previous prepare\'s draft');
  } finally {
    h.cleanup();
  }
});

test('a poll that hangs is cut off locally, retried a bounded number of times, and then resumable', { timeout: 60_000 }, () => {
  const h = harness('t-hang');
  try {
    h.flag('hang-poll');
    // The fake box runs the whole pool inside the launch call, so that call needs a few seconds.
    const hung = h.exec({ HNCD_SSH_TIMEOUT: '4', HNCD_POLL_SECONDS: '1', HNCD_POLL_TRIES: '2' });
    assert.notEqual(hung.status, 0);
    assert.ok(hung.seconds < 30, `the hung poll held the run for ${hung.seconds}s`);
    assert.match(hung.stderr, /poll 2\/2 ended without an answer/);
    assert.equal(count(h.calls(), 'push'), 0, 'a page with unconfirmed drafts was pushed');
    assert.equal(h.state().includes('extracted-p1'), false);

    h.flag('hang-poll', false);
    h.resetCalls();
    const second = h.exec();
    assert.equal(second.status, 0, second.stderr);
    assert.equal(count(h.calls(), 'prepare'), 0);
    assert.equal(count(h.calls(), 'claude'), 0);
    assert.equal(count(h.calls(), 'push'), NB);
  } finally {
    h.cleanup();
  }
});

test('a pool the last runner left running is waited on, not launched twice', { timeout: 60_000 }, () => {
  const h = harness('t-live');
  try {
    h.flag('fail-pull');
    h.exec();
    h.flag('fail-pull', false);
    rmSync(join(h.remote, 'drafts-2.json'));
    // The pool is still alive on the box and finishes batch 2 on its own.
    h.flag('tmux-hncd-t-live');
    execFileSync('bash', ['-c', `(sleep 2; rm -f "${h.flagPath('tmux-hncd-t-live')}") >/dev/null 2>&1 &`]);

    h.resetCalls();
    const second = h.exec({ HNCD_POLL_SECONDS: '10' });
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /still running on the box/);
    // The pool died without writing batch 2, so exactly one new pool extracts exactly batch 2.
    assert.deepEqual(h.calls().filter((c) => c.startsWith('claude')), ['claude 2']);
    assert.equal(count(h.calls(), 'pool'), 1);
  } finally {
    h.cleanup();
  }
});

test('a push that fails is retried alone on the next run', { timeout: 60_000 }, () => {
  const h = harness('t-push');
  try {
    h.flag('fail-push-2');
    const first = h.exec();
    assert.notEqual(first.status, 0);
    assert.deepEqual(h.calls().filter((c) => c.startsWith('push')), ['push 1']);
    assert.ok(h.state().includes('pushed-1'));
    assert.equal(h.state().includes('pushed'), false);

    h.flag('fail-push-2', false);
    h.resetCalls();
    const second = h.exec();
    assert.equal(second.status, 0, second.stderr);
    assert.deepEqual(h.calls().filter((c) => c.startsWith('push')), ['push 2']);
    assert.equal(count(h.calls(), 'claude'), 0);
  } finally {
    h.cleanup();
  }
});

test('a run that dies in pass 2 keeps pass 1 and the pass-2 selection, and extracts nothing twice', { timeout: 60_000 }, () => {
  const h = harness('t-two');
  try {
    h.flag('retry-batch-1.json');
    h.flag('fail-pull-p2');
    const first = h.exec();
    assert.notEqual(first.status, 0);
    assert.deepEqual(h.calls().filter((c) => c.startsWith('claude')).sort(), ['claude 1', 'claude 1', 'claude 2']);
    assert.ok(h.state().includes('extracted-p1') && h.state().includes('prepped-p2'));

    // Pass-2 selection reads the drafts, so a second look could choose differently; it must not run.
    h.flag('retry-batch-1.json', false);
    h.flag('fail-pull-p2', false);
    h.resetCalls();
    const second = h.exec();
    assert.equal(second.status, 0, second.stderr);
    assert.equal(count(h.calls(), 'p2prep'), 0);
    assert.equal(count(h.calls(), 'claude'), 0);
    assert.match(second.stdout, /pass 2 \{"merged_batches":1/);
    assert.deepEqual(h.calls().filter((c) => c.startsWith('push')), ['push 1', 'push 2']);
  } finally {
    h.cleanup();
  }
});

test('retirements and holds go out in the push stage, once each, across a crash and a failed push', { timeout: 60_000 }, () => {
  // 111 is confirmed deleted, 222 could not be checked; batch 1's items are all flagged and held.
  const h = harness('t-stepout', { missing: ['111', '222'], sources: { ids: { 111: 'deleted' } } });
  const env = { HNCD_HOLD_MISSES: '1' };
  const payload = (name) => JSON.parse(readFileSync(join(h.run, name), 'utf8'));
  try {
    h.flag('flag-batch-1.json');
    h.flag('fail-pull');
    const first = h.exec(env);
    assert.notEqual(first.status, 0);
    assert.equal(count(h.calls(), 'sources'), 1);
    assert.equal(count(h.calls(), 'push'), 0, 'a step-out went out before the push stage');
    assert.deepEqual(payload('retire-1.json'), { extractor: 'claude-skill-v2', profiles: [{ hnItemId: '111', draft: null }] });

    // The resumed run reaches the push stage and the hold payload fails.
    h.flag('fail-pull', false);
    h.flag('fail-push-hold-1');
    h.resetCalls();
    const second = h.exec(env);
    assert.notEqual(second.status, 0);
    assert.equal(count(h.calls(), 'sources'), 0, 'a resumed run asked Firebase again');
    // Batch 1 is all holds, so it assembles no draft push of its own. 222 could not be checked, so it
    // is held beside them rather than left to head the next page.
    assert.deepEqual(h.calls().filter((c) => c.startsWith('push')), ['push retire-1', 'push 2']);
    assert.ok(h.state().includes('pushed-retire-1') && !h.state().includes('pushed-hold-1'));
    const held = payload('hold-1.json');
    assert.deepEqual(held.profiles.map((p) => p.hnItemId).sort(), ['222', ...h.nonces(1)].sort());
    assert.ok(held.profiles.every((p) => p.hold === true));
    assert.equal(existsSync(join(h.run, 'push-1.json')), false, 'a held item was also pushed as a draft');

    // Only the hold that did not land goes out, from the payload the failed run wrote.
    h.flag('fail-push-hold-1', false);
    h.flag('flag-batch-1.json', false);
    h.resetCalls();
    const third = h.exec(env);
    assert.equal(third.status, 0, third.stderr);
    assert.deepEqual(h.calls().filter((c) => /^(sources|push|claude|prepare|pending)/.test(c)), ['push hold-1']);
    assert.deepEqual(payload('hold-1.json'), held);
    assert.match(third.stdout, /"held":3/);
  } finally {
    h.cleanup();
  }
});

// What every request that landed says about each id: the pushed-* markers name exactly the payloads
// that went out, so reading those files back is reading what the Worker received.
function outcomesSent(h) {
  const seen = new Map();
  for (const marker of h.state().filter((name) => name.startsWith('pushed-'))) {
    const name = marker.slice('pushed-'.length);
    const file = /^[0-9]+$/.test(name) ? `push-${name}.json` : `${name}.json`;
    for (const entry of JSON.parse(readFileSync(join(h.run, file), 'utf8')).profiles) {
      const id = String(entry.hnItemId ?? entry.comment.objectID);
      const kind = entry.hold === true ? 'hold' : entry.comment ? 'draft' : 'retire';
      seen.set(id, [...(seen.get(id) ?? []), kind]);
    }
  }
  return seen;
}

// Three batches, one per failure that used to stay pending, plus three dropped comments: 111 is
// deleted, 222 alive on Firebase but missing from the thread listing, 333 unreachable.
function everyFailure(page) {
  const h = harness(page, {
    batches: 3,
    missing: ['111', '222', '333'],
    sources: { ids: { 111: 'deleted' }, unreachableIds: ['333'] }
  });
  h.flag('partial-batch-1.json');
  h.flag('gender-batch-2.json');
  h.flag('nodraft-batch-3.json');
  return h;
}

test('every item the page read ends as exactly one pushed draft, retirement or hold', { timeout: 60_000 }, () => {
  const h = everyFailure('t-one-each');
  try {
    // HNCD_HOLD_MISSES is off: it governs only flagged items that have a draft, and none of these do.
    const run = h.exec();
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stderr, /batch 3 produced no drafts; its items are held/);
    assert.match(run.stdout, /outcomes \{"page":9,"drafted":2,"retired":1,"held":6,"no_draft_batch":2,"source_alive":1,"source_unreachable":1,"draft_missing":1,"flagged":0,"other":1\}/);

    const [b1, b2, b3] = [h.nonces(1), h.nonces(2), h.nonces(3)];
    const page = ['111', '222', '333', ...b1, ...b2, ...b3];
    const sent = outcomesSent(h);
    assert.deepEqual([...sent.keys()].sort(), [...page].sort(), 'an id the page read got no outcome, or one it never read got one');
    for (const [id, kinds] of sent) assert.equal(kinds.length, 1, `${id} got ${kinds.join(' and ')}`);
    const expected = {
      111: 'retire', 222: 'hold', 333: 'hold',
      [b1[0]]: 'draft', [b1[1]]: 'hold', // case 2: the model never answered the second item
      [b2[0]]: 'hold', [b2[1]]: 'draft', // case 4: the pronoun screen dropped the first
      [b3[0]]: 'hold', [b3[1]]: 'hold' // case 1: the batch came back with nothing
    };
    assert.deepEqual(Object.fromEntries([...sent].map(([id, [kind]]) => [id, kind])), expected);

    const holds = JSON.parse(readFileSync(join(h.run, 'holds.json'), 'utf8')).heldBy;
    assert.deepEqual(holds, {
      222: 'source_alive', 333: 'source_unreachable',
      [b1[1]]: 'draft_missing', [b2[0]]: 'other', [b3[0]]: 'no_draft_batch', [b3[1]]: 'no_draft_batch'
    });
  } finally {
    h.cleanup();
  }
});

test('a resumed run sends only the payload that failed, never the holds again', { timeout: 60_000 }, () => {
  const h = everyFailure('t-hold-resume');
  try {
    h.flag('fail-push-2');
    const first = h.exec();
    assert.notEqual(first.status, 0);
    assert.deepEqual(h.calls().filter((c) => c.startsWith('push')), ['push retire-1', 'push 1', 'push hold-1']);
    const held = readFileSync(join(h.run, 'hold-1.json'), 'utf8');

    // Whatever the box or the flags now say, the outcomes were frozen at assembly.
    h.flag('fail-push-2', false);
    h.flag('nodraft-batch-3.json', false);
    h.resetCalls();
    const second = h.exec({ HNCD_HOLD_MISSES: '1' });
    assert.equal(second.status, 0, second.stderr);
    assert.deepEqual(h.calls().filter((c) => /^(sources|push|claude|prepare|pending)/.test(c)), ['push 2']);
    assert.equal(readFileSync(join(h.run, 'hold-1.json'), 'utf8'), held);
    for (const [id, kinds] of outcomesSent(h)) assert.equal(kinds.length, 1, `${id} got ${kinds.join(' and ')}`);
    assert.equal(outcomesSent(h).size, 9);
  } finally {
    h.cleanup();
  }
});
