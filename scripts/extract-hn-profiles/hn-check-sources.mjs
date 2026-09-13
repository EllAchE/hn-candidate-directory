#!/usr/bin/env node
// Reports pending items whose Hacker News source no longer exists.
//
// A deleted comment is a permanent hole in the work queue, not a transient miss. Extraction
// reads the comment from Algolia, which stops serving a deleted item, so the item can never
// be extracted. Retiring it (`draft: null`) cannot clear it either: the push endpoint
// identifies an item by re-supplying its comment text (worker.js `toHnRecord` returns null on
// empty text), and deletion is precisely the state where that text is gone. So the row keeps
// its low `extractor_rank`, stays in `pending`, and is re-served on the first page of every
// run forever -- the one case the `draft: null` design note at worker.js:1806 was written for
// is the one case it cannot close.
//
// That share only grows: every page leaves its own deleted items behind, so each run has fewer
// usable slots than the last. Hence this script -- it names the floor so a run can be read
// against the work that is actually reachable rather than against `remaining`.
//
// It only reports. Clearing a row means either archiving the published profile through the
// removal route or a Worker change, and which of those is right is a policy question about
// what an author's deletion should mean -- not something a check should decide on its own.

import { readFileSync, writeFileSync } from 'node:fs';

const FIREBASE = 'https://hacker-news.firebaseio.com/v0/item';
const LANES = 10;
const ATTEMPTS = 3;

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) args[token.slice(2)] = argv[i + 1]?.startsWith('--') ? true : argv[++i];
  }
  return args;
}

// Firebase rather than Algolia, and this is the whole reason the check works: Algolia drops a
// deleted item from its index, so "absent from Algolia" cannot distinguish a deletion from a
// fetch that simply missed. Firebase keeps the record and marks it, so a deletion is a positive
// answer here instead of an absence.
//
// `dead` is separated from `deleted` because they are different events -- flagged or killed by
// moderation versus withdrawn by the author -- and only the second says anything about what the
// candidate wanted. `null` means the id is unknown to Firebase, which for an id D1 recorded from
// a live thread means the item was removed hard rather than flagged.
export function classifySource(item) {
  if (item === null || item === undefined) return 'missing';
  if (item.deleted === true) return 'deleted';
  if (item.dead === true) return 'dead';
  if (typeof item.text !== 'string' || item.text === '') return 'no_text';
  return 'ok';
}

export const isUnextractable = (verdict) => verdict !== 'ok';

async function fetchItem(id) {
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    try {
      return await fetch(`${FIREBASE}/${id}.json`).then((response) => response.json());
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
    }
  }
  // Distinct from `missing`: the network gave up, the item may well be fine. Reporting it as a
  // deletion would overstate the floor, which is the number this script exists to get right.
  return { unreachable: true };
}

export async function classifyAll(ids, lanes = LANES) {
  const verdicts = new Map();
  const lane = async (slice) => {
    for (const id of slice) {
      const item = await fetchItem(id);
      verdicts.set(id, item?.unreachable ? 'unreachable' : classifySource(item));
    }
  };
  await Promise.all(
    Array.from({ length: lanes }, (_, index) => lane(ids.filter((_, position) => position % lanes === index)))
  );
  return verdicts;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.pending) {
    console.error('usage: hn-check-sources.mjs --pending <pending.json> [--out report.json]');
    console.error('  produce pending.json with: hncd-api.mjs pending --host <https://host>');
    process.exit(2);
  }

  // Takes the page as a file rather than fetching it, so the ingest token stays where the skill
  // says it lives: `hncd-api.mjs` is the only script that touches it. This one reads a saved page
  // and public Firebase, so it holds no credential and can run anywhere -- including next to a
  // remote extraction run, which is where knowing the floor actually changes what you do.
  const page = JSON.parse(readFileSync(args.pending, 'utf8'));
  const ids = (page.items || []).map((item) => String(item.hnItemId));
  if (!ids.length) {
    console.error(`${args.pending} has no items`);
    process.exit(1);
  }

  const verdicts = await classifyAll(ids);
  const blocked = [...verdicts].filter(([, verdict]) => isUnextractable(verdict) && verdict !== 'unreachable');
  const unreachable = [...verdicts].filter(([, verdict]) => verdict === 'unreachable').length;
  const byReason = {};
  for (const [, verdict] of blocked) byReason[verdict] = (byReason[verdict] || 0) + 1;

  const report = {
    // `remaining` is the pending endpoint's name for the count; the push response calls the same
    // number `pending`. Carried through under the name the source used.
    remaining: page.remaining,
    page: ids.length,
    unextractable: blocked.length,
    reachable: ids.length - blocked.length - unreachable,
    unreachable,
    byReason,
    ids: Object.fromEntries(blocked)
  };
  if (args.out) writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`);
  const { ids: _ids, ...summary } = report;
  console.log(JSON.stringify(summary));
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
