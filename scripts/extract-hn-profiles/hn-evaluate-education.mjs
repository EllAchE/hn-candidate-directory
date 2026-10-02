#!/usr/bin/env node

import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractBatch, extractorDeveloperInstructions } from './hn-codex-extract-batch.mjs';

const fixture = JSON.parse(readFileSync(new URL('../../test/fixtures/hn-education-cases.json', import.meta.url), 'utf8'));
const hash = (value) => createHash('sha256').update(value).digest('hex');
const instructionHash = () => hash(extractorDeveloperInstructions());
const wrapperHash = () => hash(readFileSync(new URL('./hn-codex-extract-batch.mjs', import.meta.url)));
const labels = new Set();
for (const item of fixture.cases) {
  if (!item.label || labels.has(item.label) || typeof item.resume !== 'string' || typeof item.comment !== 'string' ||
      !Array.isArray(item.expected?.universities) || Object.values(item.expected).some((list) => !Array.isArray(list) || list.some((value) => typeof value !== 'string'))) {
    throw new Error('invalid or repeated education fixture');
  }
  labels.add(item.label);
}

const args = process.argv.slice(2);
if (args.length && (args.length !== 1 || args[0] !== '--run')) throw new Error('usage: hn-evaluate-education.mjs [--run]');
if (!args.length) {
  console.log(`${fixture.cases.length} validated synthetic cases; add --run to evaluate each in a separate isolated model context.`);
} else {
  const run = mkdtempSync(join(tmpdir(), 'hncd-education-eval-'));
  const developerInstructionsSha256 = instructionHash();
  const wrapperSha256 = wrapperHash();
  const outcomes = [];
  let truePositive = 0, falsePositive = 0, falseNegative = 0;
  for (const [index, item] of fixture.cases.entries()) {
    const batchPath = join(run, `batch-${index + 1}.json`);
    const outPath = join(run, `drafts-${index + 1}.json`);
    const batch = { batch: index + 1, delimiter: `HNCD-${randomBytes(12).toString('hex').toUpperCase()}`, items: [{
      nonce: randomBytes(9).toString('hex'), text: item.comment, resume: item.resume, links: [], expected: item.recheck || []
    }] };
    writeFileSync(batchPath, JSON.stringify(batch));
    extractBatch({ batchPath, outPath });
    const [result] = JSON.parse(readFileSync(outPath, 'utf8'));
    const actual = Object.fromEntries(Object.keys(item.expected).map((field) => [field, result.draft?.[field]]));
    const expectedSchools = new Set(item.expected.universities);
    const actualSchools = new Set(actual.universities || []);
    truePositive += [...actualSchools].filter((value) => expectedSchools.has(value)).length;
    falsePositive += [...actualSchools].filter((value) => !expectedSchools.has(value)).length;
    falseNegative += [...expectedSchools].filter((value) => !actualSchools.has(value)).length;
    const pass = Object.entries(item.expected).every(([field, expected]) =>
      Array.isArray(actual[field]) && expected.length === actual[field].length && expected.every((value) => actual[field].includes(value)));
    const outcome = { case: item.label, expected: item.expected, actual, pass };
    outcomes.push(outcome);
    console.log(JSON.stringify(outcome));
  }
  if (instructionHash() !== developerInstructionsSha256 || wrapperHash() !== wrapperSha256) {
    throw new Error('extractor instructions or wrapper changed during evaluation');
  }
  const report = {
    cases: outcomes, passed: outcomes.filter((item) => item.pass).length, total: outcomes.length,
    truePositive, falsePositive, falseNegative,
    precision: truePositive + falsePositive ? truePositive / (truePositive + falsePositive) : null,
    recall: truePositive + falseNegative ? truePositive / (truePositive + falseNegative) : null,
    developerInstructionsSha256,
    wrapperSha256,
    fixtureInstructionCommit: fixture.instructionCommit
  };
  writeFileSync(join(run, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, cases: undefined, run }));
  if (report.passed !== report.total) process.exitCode = 1;
}
