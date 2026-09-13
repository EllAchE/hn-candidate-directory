#!/usr/bin/env node
// The resume pass: the label hint read at prepare time, the attach step that seals fetched
// text into a batch, the strict miss check, and the merge that folds a second pass over the
// first. Fetches go to a local server standing in for the unblocker shim via UNBLOCKER_URL.

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { attachResumes, chooseIndex } from '../scripts/extract-hn-profiles/hn-attach-resumes.mjs';
import { checkDrafts, expectedFields } from '../scripts/extract-hn-profiles/hn-check-drafts.mjs';
import { mergeDrafts } from '../scripts/extract-hn-profiles/hn-merge-drafts.mjs';
import { labelledResumeIndex, screenedLinks } from '../scripts/extract-hn-profiles/hn-untrusted.mjs';

const DRIVE = 'https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456/view?usp=sharing';

// HN's markup: bare `<p>` openers, never closed, so the rendered text is one run-on line.
const comment = (resumeLine) =>
  `Location: Berlin<p>Remote: yes<p>Willing to relocate: no<p>Technologies: Go, Rust` +
  `<p>${resumeLine}<p>Email: <a href="https://example.com/me">https://example.com/me</a>`;

test('the Résumé/CV line names the link the harness should fetch first', () => {
  const html = comment(`Résumé/CV: <a href="${DRIVE}" rel="nofollow">https://drive.google.com/file/d/1AbCdEfGhIj...</a>`);
  const links = screenedLinks(html);
  assert.equal(links.length, 2);
  assert.equal(labelledResumeIndex(html, links), links.find((l) => l.url.startsWith('https://drive.google.com')).index);
});

test('a bare Resume: label and an ASCII spelling both count', () => {
  const html = comment(`Resume: <a href="https://cv.example.org/jane.pdf">https://cv.example.org/jane.pdf</a>`);
  assert.equal(labelledResumeIndex(html, screenedLinks(html)), 1);
  const cv = comment(`CV: <a href="https://cv.example.org/jane.pdf">https://cv.example.org/jane.pdf</a>`);
  assert.equal(labelledResumeIndex(cv, screenedLinks(cv)), 1);
});

test('a LinkedIn resume line is no hint, and a missing line is null', () => {
  const html = comment(`Résumé/CV: <a href="https://www.linkedin.com/in/jane">https://www.linkedin.com/in/jane</a>`);
  assert.equal(labelledResumeIndex(html, screenedLinks(html)), null);
  const none = comment('Résumé/CV: on request');
  assert.equal(labelledResumeIndex(none, screenedLinks(none)), null);
});

test('the model pick beats the label, and a bad pick falls back to it', () => {
  const item = { resumeHint: 1 };
  assert.equal(chooseIndex(item, { resumeLinkIndex: 2 }), 2);
  assert.equal(chooseIndex(item, { resumeLinkIndex: null }), 1);
  assert.equal(chooseIndex(item, { resumeLinkIndex: 'x' }), 1);
  assert.equal(chooseIndex({ resumeHint: null }, undefined), null);
});

test('expectations follow what the source demonstrably answers', () => {
  const bare = { text: 'Technologies: Go\nWilling to relocate: no' };
  assert.deepEqual(expectedFields(bare), ['role', 'summary']);
  const labelled = { text: 'Location: Berlin\nRemote: yes' };
  assert.deepEqual(expectedFields(labelled), ['role', 'summary', 'location', 'workMode']);
  const withResume = { text: 'Location: Berlin', resume: 'Jane Doe\nAcme Corp 2019-2023' };
  assert.deepEqual(expectedFields(withResume), ['role', 'summary', 'location', 'name', 'companies']);
});

test('an empty name or employer list with a resume attached is a miss worth a retry', () => {
  const batch = {
    batch: 3,
    items: [
      { nonce: 'a', text: 'Location: Berlin\nRemote: yes', resume: 'Jane Doe\nAcme 2019-2023' },
      { nonce: 'b', text: 'Location: Paris' },
      { nonce: 'c', text: 'recruiter spam' },
      { nonce: 'd', text: 'Location: Rome', resume: 'x' },
      { nonce: 'e', text: 'Location: Oslo' }
    ]
  };
  const drafts = [
    { nonce: 'a', draft: { name: '', role: 'SRE', summary: 'Runs things.', location: 'Berlin', workMode: 'remote', companies: [] } },
    { nonce: 'b', draft: { name: '', role: '', summary: 'A person.', location: 'Paris', companies: [] } },
    { nonce: 'c', draft: null },
    // The fields at the top level, no wrapper: a shape assembly would drop, retried as such.
    { nonce: 'e', name: 'E', role: 'Dev', summary: 'Flat.', location: 'Oslo' }
  ];
  const report = checkDrafts(batch, drafts);
  assert.equal(report.items, 5);
  assert.equal(report.withResume, 2);
  assert.equal(report.retired, 1);
  assert.deepEqual(report.missing, { name: 1, companies: 1, role: 1, draft: 1, malformed: 1 });
  assert.deepEqual(report.flagged.map((f) => [f.nonce, f.missing, f.retry]), [
    ['a', ['name', 'companies'], true],
    ['b', ['role'], false],
    ['d', ['draft'], true],
    ['e', ['malformed'], true]
  ]);
});

test('a second pass replaces a first only when it knows at least as much, and never retires', () => {
  const base = [
    { nonce: 'a', injection: false, draft: { name: '', role: 'SRE', summary: 's', companies: [] } },
    { nonce: 'b', injection: false, draft: { name: 'B', role: 'Dev', summary: 's', companies: ['X'] } },
    { nonce: 'c', injection: true, draft: { name: '', role: 'PM', summary: 's', companies: [] } }
  ];
  const over = [
    { nonce: 'a', injection: false, draft: { name: 'A', role: 'SRE', summary: 's', companies: ['Acme'] } },
    { nonce: 'b', injection: false, draft: { name: '', role: 'Dev', summary: 's', companies: [] } },
    { nonce: 'c', injection: false, draft: null },
    { nonce: 'd', injection: false, draft: { name: 'D', role: 'x', summary: 's', companies: [] } }
  ];
  const merged = Object.fromEntries(mergeDrafts(base, over).map((entry) => [entry.nonce, entry]));
  assert.equal(merged.a.draft.name, 'A');
  assert.equal(merged.b.draft.name, 'B');
  assert.equal(merged.c.draft.role, 'PM');
  assert.equal(merged.c.injection, true);
  assert.equal(merged.d.draft.name, 'D');
});

// A stand-in for the unblocker: any POST /fetch answers with a resume-shaped HTML page.
async function withFetchServer(fn) {
  const hits = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      hits.push(JSON.parse(body).url);
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<html><body><h1>Jane Doe</h1><p>Senior engineer at Acme Corp, 2019-2023.</p>${'<p>Built things.</p>'.repeat(40)}</body></html>`);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const previous = process.env.UNBLOCKER_URL;
  process.env.UNBLOCKER_URL = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(hits);
  } finally {
    if (previous === undefined) delete process.env.UNBLOCKER_URL;
    else process.env.UNBLOCKER_URL = previous;
    server.close();
  }
}

test('attach seals the fetched text into the item and reuses it on the next pass', async () => {
  await withFetchServer(async (hits) => {
    const out = mkdtempSync(join(tmpdir(), 'hncd-attach-'));
    const batch = {
      batch: 1,
      items: [
        { nonce: 'n1', text: 'Location: Berlin', links: [{ index: 1, url: 'https://cv.example.org/jane.pdf' }], resumeHint: 1 },
        { nonce: 'n2', text: 'no resume', links: [{ index: 1, url: 'https://www.linkedin.com/in/x' }], resumeHint: null }
      ]
    };
    const first = await attachResumes({ batch, out });
    assert.equal(first.fetched, 1);
    assert.equal(first.attached, 1);
    assert.deepEqual([...first.selected], ['n1']);
    assert.match(batch.items[0].resume, /Jane Doe/);
    assert.equal(batch.items[0].resumeSource, 'label');
    assert.equal(batch.items[0].resumeUrl, 'https://cv.example.org/jane.pdf');
    assert.ok(existsSync(join(out, 'resume-n1.txt')));
    assert.equal(JSON.parse(readFileSync(join(out, 'resume-n1.json'), 'utf8')).resumeUrl, 'https://cv.example.org/jane.pdf');
    assert.deepEqual(hits, ['https://cv.example.org/jane.pdf']);

    // Second pass: n1 is only re-selected because the check asked; n2 gains a model-chosen link.
    batch.items[1].links.push({ index: 2, url: 'https://cv.example.org/other.pdf' });
    const drafts = [{ nonce: 'n1', resumeLinkIndex: null }, { nonce: 'n2', resumeLinkIndex: 2 }];
    const second = await attachResumes({ batch, out, drafts, retry: new Set(['n1']) });
    assert.equal(second.fetched, 1);
    assert.equal(second.attached, 2);
    assert.deepEqual([...second.selected].sort(), ['n1', 'n2']);
    assert.equal(batch.items[1].resumeSource, 'model');
    assert.deepEqual(hits, ['https://cv.example.org/jane.pdf', 'https://cv.example.org/other.pdf']);
  });
});

test('a fetch miss is counted by reason and never throws', async () => {
  const previous = process.env.UNBLOCKER_URL;
  process.env.UNBLOCKER_URL = 'http://127.0.0.1:9';
  try {
    const out = mkdtempSync(join(tmpdir(), 'hncd-attach-miss-'));
    const batch = { batch: 1, items: [{ nonce: 'n1', text: '', links: [{ index: 1, url: 'https://cv.example.org/a.pdf' }], resumeHint: 1 }] };
    const result = await attachResumes({ batch, out });
    assert.equal(result.attached, 0);
    assert.deepEqual(result.misses, { fetch_unreachable: 1 });
    assert.equal(batch.items[0].resume, undefined);
  } finally {
    if (previous === undefined) delete process.env.UNBLOCKER_URL;
    else process.env.UNBLOCKER_URL = previous;
  }
});
