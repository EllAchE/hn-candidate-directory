#!/usr/bin/env node
// Drops any draft whose summary genders a candidate the source text never gendered.
//
// The extractor is told not to do this (see .claude/agents/hn-profile-extractor.md), and mostly
// does not, but "mostly" is the wrong bar for a guess about a real, named person on a public
// page. This runs before assembly, where the nonce still links a draft to its own source text,
// so it needs no identity map -- the map is what must not travel, and this check must run
// wherever extraction ran.
//
// Drop, never repair: rewriting the summary here would make the harness the author of profile
// text, which is the one thing this pipeline keeps the model responsible for. A dropped item
// stays in `pending` and comes back on the next page.

import { readFileSync, writeFileSync } from 'node:fs';

const GENDERED = /\b(?:he|him|his|she|her|hers|himself|herself)\b/gi;

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) args[token.slice(2)] = argv[i + 1]?.startsWith('--') ? true : argv[++i];
  }
  return args;
}

// A pronoun the candidate used of themselves is allowed -- the agent file permits exactly that.
// So the test is not "is there a pronoun" but "is there one the source does not contain".
export function unsupportedPronouns(summary, sourceText) {
  const inSource = new Set((sourceText.match(GENDERED) || []).map((word) => word.toLowerCase()));
  const used = new Set((summary.match(GENDERED) || []).map((word) => word.toLowerCase()));
  return [...used].filter((word) => !inSource.has(word));
}

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.batch || !args.drafts || !args.out) {
    console.error('usage: hn-screen-pronouns.mjs --batch <batch.json> --drafts <drafts.json> --out <screened.json>');
    process.exit(2);
  }

  const batch = JSON.parse(readFileSync(args.batch, 'utf8'));
  const source = new Map((batch.items || []).map((item) => [item.nonce, item.text || '']));
  const drafts = JSON.parse(readFileSync(args.drafts, 'utf8'));
  const entries = Array.isArray(drafts) ? drafts : drafts.profiles || [];

  const kept = [];
  const dropped = [];
  for (const entry of entries) {
    const summary = entry?.draft?.summary;
    if (typeof summary !== 'string') {
      kept.push(entry);
      continue;
    }
    // A nonce with no source text is not this check's problem to judge; assembly rejects it.
    const unsupported = unsupportedPronouns(summary, source.get(entry.nonce) ?? summary);
    if (unsupported.length) dropped.push({ nonce: entry.nonce, pronouns: unsupported });
    else kept.push(entry);
  }

  writeFileSync(args.out, JSON.stringify(kept, null, 2));
  process.stdout.write(`${JSON.stringify({ checked: entries.length, kept: kept.length, dropped })}\n`);
}
