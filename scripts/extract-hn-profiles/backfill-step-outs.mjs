#!/usr/bin/env node
// Names the reason for every step-out a page run made before the Worker recorded one. Reads the run
// directories devbox-run-page.sh left under /tmp/claude/hncd/<tag>/ and re-sends each step-out through
// the ordinary push endpoint with `restate: true`, which the Worker treats as "record why, change
// nothing else": a row that is back in the queue stays there, a row a draft has since reached is left
// alone, and no step-out is counted twice. No draft is ever sent, so no profile is written.
//
//   backfill-step-outs.mjs [--root <dir>] [--tag <tag>]            dry run: print every payload
//   backfill-step-outs.mjs [--root <dir>] [--tag <tag>] --send --host <https://host>
//
// Only what actually landed is restated: a step-out payload counts once its pushed-<name> marker
// exists, and a tag with a state directory but no `pushed` marker is still running and is skipped.
// The oldest tags (p15, p16) predate step-outs and have no state at all; their holds are derived from
// the files on disk and sent anyway, since a restatement of an item that was never stepped out is a
// no-op. Per id the newest tag wins. The reason comes from holds.json when the run wrote one, from the
// same derivation the page script uses when it did not, and is `unrecorded` when neither can say.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { pageOutcomes, pushedPayloads, retireReasons } from './hn-page-state.mjs';

const BATCH = 25;
const DEFAULT_EXTRACTOR = 'claude-skill-v2';
const TAG = /^\d{8}-p\d+$/;

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

const numbered = (runDir, prefix) => {
  const files = [];
  for (let k = 1; existsSync(join(runDir, `${prefix}-${k}.json`)); k += 1) files.push(`${prefix}-${k}`);
  return files;
};

// The extractor the tag pushed as, so the restatement is checked against the rank that run reached.
function tagExtractor(runDir) {
  for (const name of readdirSync(runDir).filter((file) => /^(push|hold|retire)-\d+\.json$/.test(file)).sort()) {
    const extractor = readJson(join(runDir, name))?.extractor;
    if (typeof extractor === 'string' && extractor) return extractor;
  }
  return DEFAULT_EXTRACTOR;
}

function heldReasons(runDir) {
  const recorded = readJson(join(runDir, 'holds.json'))?.heldBy;
  if (recorded && typeof recorded === 'object') return { source: 'holds.json', heldBy: recorded };
  const batches = readJson(join(runDir, 'prepare.json'))?.batches;
  if (!Array.isArray(batches)) return { source: 'none', heldBy: {} };
  return { source: 'derived', heldBy: pageOutcomes({ runDir, batches: batches.length }).heldBy };
}

// One tag's step-outs as [{hnItemId, kind, reason}], or a reason it was skipped.
export function tagStepOuts(runDir) {
  const hasState = existsSync(join(runDir, 'state'));
  if (hasState && !existsSync(join(runDir, 'state', 'pushed'))) return { skipped: 'not finished' };

  const held = heldReasons(runDir);
  const entries = [];
  if (!hasState) {
    // Before step-outs existed nothing was sent for these, so the derivation is the only record.
    for (const [hnItemId, reason] of Object.entries(held.heldBy)) entries.push({ hnItemId, kind: 'hold', reason });
    return { extractor: tagExtractor(runDir), reasons: held.source, entries };
  }

  const landed = new Set(pushedPayloads(runDir));
  const retired = retireReasons(readJson(join(runDir, 'sources.json')));
  for (const [kind, why] of [['retire', retired], ['hold', held.heldBy]]) {
    for (const name of numbered(runDir, kind).filter((payload) => landed.has(payload))) {
      for (const profile of readJson(join(runDir, `${name}.json`))?.profiles || []) {
        const hnItemId = String(profile?.hnItemId ?? '');
        if (!/^\d{1,20}$/.test(hnItemId)) continue;
        entries.push({ hnItemId, kind, reason: why[hnItemId] ?? 'unrecorded' });
      }
    }
  }
  return { extractor: tagExtractor(runDir), reasons: held.source, entries };
}

export function backfillPayloads({ root, tags }) {
  const names = (tags?.length ? tags : readdirSync(root).filter((name) => TAG.test(name)))
    .filter((name) => existsSync(join(root, name)))
    // Newest first, so an id a later page stepped out again keeps that page's reason.
    .sort((a, b) => b.localeCompare(a, 'en', { numeric: true }));

  const seen = new Set();
  const byExtractor = new Map();
  const report = [];
  for (const tag of names) {
    const found = tagStepOuts(join(root, tag));
    if (found.skipped) {
      report.push({ tag, skipped: found.skipped });
      continue;
    }
    let kept = 0;
    for (const entry of found.entries) {
      if (seen.has(entry.hnItemId)) continue;
      seen.add(entry.hnItemId);
      const profile = entry.kind === 'retire' ? { hnItemId: entry.hnItemId, draft: null } : { hnItemId: entry.hnItemId, hold: true };
      const list = byExtractor.get(found.extractor) || [];
      list.push({ ...profile, reason: entry.reason, restate: true });
      byExtractor.set(found.extractor, list);
      kept += 1;
    }
    report.push({ tag, extractor: found.extractor, reasons: found.reasons, stepOuts: found.entries.length, sent: kept });
  }

  const payloads = [];
  for (const [extractor, profiles] of byExtractor) {
    profiles.sort((a, b) => a.hnItemId.localeCompare(b.hnItemId, 'en', { numeric: true }));
    for (let i = 0; i < profiles.length; i += BATCH) payloads.push({ extractor, profiles: profiles.slice(i, i + BATCH) });
  }
  return { report, payloads };
}

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2));
  const root = typeof args.root === 'string' ? args.root : '/tmp/claude/hncd';
  const tags = typeof args.tag === 'string' ? [args.tag] : [];
  if (args.send && typeof args.host !== 'string') {
    console.error('usage: backfill-step-outs.mjs [--root <dir>] [--tag <tag>] [--send --host <https://host>]');
    process.exit(2);
  }

  const { report, payloads } = backfillPayloads({ root, tags });
  for (const line of report) console.error(`backfill: ${JSON.stringify(line)}`);
  if (!args.send) {
    console.error(`backfill: dry run, ${payloads.length} payload(s); nothing sent. Re-run with --send --host <origin> to push them.`);
    for (const payload of payloads) process.stdout.write(`${JSON.stringify(payload)}\n`);
    process.exit(0);
  }

  // hncd-api.mjs is the only script that touches the ingest token; this one only hands it files.
  const api = fileURLToPath(new URL('./hncd-api.mjs', import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), 'hncd-backfill-'));
  for (const [index, payload] of payloads.entries()) {
    const file = join(dir, `restate-${index + 1}.json`);
    writeFileSync(file, `${JSON.stringify(payload)}\n`);
    const result = spawnSync(process.execPath, [api, 'push', '--file', file, '--host', args.host], { encoding: 'utf8' });
    if (result.status !== 0) {
      console.error(`backfill: payload ${index + 1} of ${payloads.length} failed; re-running is safe. ${result.stderr.trim()}`);
      process.exit(1);
    }
    const outcomes = {};
    for (const entry of JSON.parse(result.stdout).results || []) outcomes[entry.outcome] = (outcomes[entry.outcome] || 0) + 1;
    console.error(`backfill: payload ${index + 1} of ${payloads.length} ${JSON.stringify(outcomes)}`);
  }
}
