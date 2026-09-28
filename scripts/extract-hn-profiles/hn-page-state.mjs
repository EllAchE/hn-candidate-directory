#!/usr/bin/env node
// Decides whether a page run starts over or picks up where the last one stopped, and whether a
// drafts file belongs to the prepare run that is on disk now. Both answers used to be implicit:
// every run re-prepared, so no draft could outlive its batch. Resuming keeps model work across a
// crash, which is only safe while nothing from a different prepare can reach assembly.
//
//   hn-page-state.mjs plan --run <dir> [--fresh]
//   hn-page-state.mjs bind --batch <batch.json> [--map <batch.map.json>] --drafts <drafts.json>

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) args[token.slice(2)] = argv[i + 1] === undefined || argv[i + 1].startsWith('--') ? true : argv[++i];
    else args._.push(token);
  }
  return args;
}

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
};

// A push is the one step that cannot be taken back, and it also changes what the pending endpoint
// returns, so a tag that has pushed anything is finished: a second page needs a second tag, and
// HNCD_FRESH does not reopen it. Each marker names one push request: a batch number for drafts,
// `retire-<k>` or `hold-<k>` for a step-out payload.
export function pushedPayloads(runDir) {
  const state = join(runDir, 'state');
  if (!existsSync(state)) return [];
  return readdirSync(state)
    .map((name) => /^pushed-(.+)$/.exec(name)?.[1])
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
}

export function planRun({ runDir, fresh = false }) {
  const state = join(runDir, 'state');
  if (existsSync(join(state, 'pushed'))) {
    return { action: 'refuse', reason: 'this tag already pushed; start the next page under a new tag' };
  }
  const partial = pushedPayloads(runDir);
  if (partial.length && fresh) {
    return { action: 'refuse', reason: `batches ${partial.join(',')} already pushed; HNCD_FRESH cannot restart a tag that has pushed` };
  }
  if (fresh) return { action: 'fresh', reason: 'HNCD_FRESH=1' };
  if (!existsSync(join(state, 'prepared'))) return { action: 'fresh', reason: 'no completed prepare to resume' };

  const prepare = readJson(join(runDir, 'prepare.json'));
  if (!Array.isArray(prepare?.batches)) {
    return { action: partial.length ? 'refuse' : 'fresh', reason: 'prepare.json is missing or unreadable' };
  }
  const batches = prepare.batches.length;
  // A page of nothing but deletions prepares no batch and only retires. Once one retirement landed,
  // the rest are finished from the same payloads; before that, starting over costs nothing.
  if (!batches && !partial.length) return { action: 'fresh', reason: 'prepare.json lists no batches' };
  const lost = [];
  for (let n = 1; n <= batches; n += 1) {
    for (const name of [`batch-${n}.json`, `batch-${n}.map.json`]) if (!existsSync(join(runDir, name))) lost.push(name);
  }
  // Without its map a prepared batch cannot be assembled, and without the batch its drafts cannot
  // be bound, so a half-missing prepare is only good for starting over -- unless something already
  // pushed, when starting over would re-read a pending list the push has since changed.
  if (lost.length) return { action: partial.length ? 'refuse' : 'fresh', reason: `prepared files missing: ${lost.join(', ')}` };

  const stages = existsSync(state) ? readdirSync(state).sort() : [];
  return { action: 'resume', reason: 'reusing the prepared batches and their maps', batches, stages, pushed: partial };
}

const draftEntries = (raw) => (Array.isArray(raw) ? raw : Array.isArray(raw?.profiles) ? raw.profiles : null);

// A draft belongs to this prepare run only if every nonce it carries was minted by it. One foreign
// nonce means the file came from another prepare of the same tag (nonces are never reused), and the
// whole file goes: assembly would drop those entries as unknown_nonce anyway, but a stale file on
// disk also reads as "this batch is done" and keeps it from ever being extracted. An empty or
// unreadable file binds to nothing and is treated the same way, so the batch runs again.
export function bindDrafts({ batch, map, drafts }) {
  const entries = draftEntries(drafts);
  if (!entries) return { bound: false, reason: 'unreadable' };
  if (!entries.length) return { bound: false, reason: 'empty' };
  const known = new Set((batch?.items || []).map((item) => item.nonce));
  const unknown = [];
  for (const entry of entries) {
    const id = entry?.nonce;
    if (typeof id !== 'string' || !known.has(id) || (map && !Object.hasOwn(map, id))) unknown.push(id ?? null);
  }
  if (unknown.length) return { bound: false, reason: 'foreign_nonce', unknown };
  return { bound: true, entries: entries.length };
}

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  if (command === 'plan' && args.run) {
    process.stdout.write(`${JSON.stringify(planRun({ runDir: args.run, fresh: Boolean(args.fresh) }))}\n`);
  } else if (command === 'bind' && args.batch && args.drafts) {
    const result = bindDrafts({
      batch: readJson(args.batch),
      // A named map that cannot be read binds nothing, rather than quietly skipping the map check.
      map: args.map ? (readJson(args.map) ?? {}) : undefined,
      drafts: readJson(args.drafts)
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exit(result.bound ? 0 : 1);
  } else {
    console.error('usage: hn-page-state.mjs plan --run <dir> [--fresh] | bind --batch <batch.json> [--map <map.json>] --drafts <drafts.json>');
    process.exit(2);
  }
}
