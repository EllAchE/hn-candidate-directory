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
import { documentToFollow, resumeText } from '../scripts/extract-hn-profiles/hn-resume-text.mjs';
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

const BLURB = '<p>Built things.</p>'.repeat(40);

test('a landing page names the document to follow, ranked by the words around each link', () => {
  const index = `<h1>Emmanuel</h1><p>My resumes for the role you are hiring for.</p>
    <h2>Technical Support Resume</h2><p>For support roles.</p>
    <a href="https://drive.google.com/uc?export=download&amp;id=AAA">Download</a>
    <a href="https://drive.google.com/file/d/AAA/view?usp=sharing">Open in Drive</a>
    <h2>General CV</h2><p>Comprehensive CV covering all professional experience.</p>
    <a href="https://drive.google.com/uc?export=download&amp;id=GEN">Download</a>
    <a href="https://drive.google.com/file/d/GEN/view?usp=sharing">Open in Drive</a>`;
  assert.equal(documentToFollow(index, 'https://me.example.org/resume'), 'https://drive.google.com/uc?export=download&id=GEN');
  assert.equal(documentToFollow('<a href="/projects">Projects</a><p>Jane Doe, engineer.</p>', 'https://me.example.org/'), null);
  const interstitial = `<a href="http://bitly.com/?utm_source=Bitly"></a><p>Here's a preview of your destination</p>
    <a href="https://pax.example.org/">pax.example.org/</a><a href="https://x.com/bitly"></a>`;
  assert.equal(documentToFollow(interstitial, 'https://bit.ly/abc'), 'https://pax.example.org/');
});

// A small site: a landing page listing two documents, the documents themselves, and a
// shortener-style preview page pointing at a page that renders empty.
async function withSite(fn) {
  const pages = {
    '/resume': `<h2>Support Resume</h2><a href="/support.pdf">Download</a><h2>General CV</h2><p>Comprehensive CV.</p><a href="/general.pdf">Download</a>`,
    '/support.pdf': `<html><body><h1>Jane Doe</h1><p>Support engineer at Acme Corp.</p>${BLURB}</body></html>`,
    '/general.pdf': `<html><body><h1>Jane Doe</h1><p>Engineer at Acme Corp, 2019-2023.</p><p>Education: MIT, BSc 2018.</p>${BLURB}${BLURB}</body></html>`,
    '/preview': `<title>Jane Doe - Resume</title><p>Here's a preview of your destination</p><a href="https://bit.ly/x">bitly</a><a href="https://dest.example.org/empty">dest.example.org/</a>${BLURB}`,
    '/empty': `<html><body><div id="root"></div></body></html>`,
    '/full': `<html><body><h1>Jane Doe</h1><p>Engineer at Acme Corp.</p>${BLURB}<a href="/general.pdf">Download PDF</a></body></html>`
  };
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const url = new URL(JSON.parse(body).url);
      const page = pages[url.pathname];
      if (!page) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(page.replaceAll('__SELF__', `https://${url.hostname}`));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const previous = process.env.UNBLOCKER_URL;
  process.env.UNBLOCKER_URL = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn();
  } finally {
    if (previous === undefined) delete process.env.UNBLOCKER_URL;
    else process.env.UNBLOCKER_URL = previous;
    server.close();
  }
}

const itemFor = (url) => ({ nonce: 'n', text: '', links: [{ index: 1, url }], resumeHint: 1 });

test('a resume link that lands on an index page reads the document it points at', async () => {
  await withSite(async () => {
    const out = mkdtempSync(join(tmpdir(), 'hncd-follow-'));
    const result = await resumeText({ batch: { items: [itemFor('https://me.example.org/resume')] }, nonce: 'n', link: 1, out });
    assert.equal(result.ok, true);
    assert.match(result.text, /Education: MIT/);
    assert.equal(result.url, 'https://me.example.org/resume');
    assert.equal(result.documentUrl, 'https://me.example.org/general.pdf');
    assert.equal(JSON.parse(readFileSync(join(out, 'resume-n.json'), 'utf8')).documentUrl, 'https://me.example.org/general.pdf');
  });
});

test('a page that already reads as a resume keeps its own text unless the document says more', async () => {
  await withSite(async () => {
    const out = mkdtempSync(join(tmpdir(), 'hncd-follow-full-'));
    const result = await resumeText({ batch: { items: [itemFor('https://me.example.org/full')] }, nonce: 'n', link: 1, out });
    assert.equal(result.ok, true);
    assert.equal(result.documentUrl, 'https://me.example.org/general.pdf');
    assert.match(result.text, /Education: MIT/);
  });
});

test('a shortener preview page stands when its destination renders empty', async () => {
  await withSite(async () => {
    const out = mkdtempSync(join(tmpdir(), 'hncd-follow-short-'));
    const result = await resumeText({ batch: { items: [itemFor('https://bit.ly/preview')] }, nonce: 'n', link: 1, out });
    assert.equal(result.ok, true);
    assert.equal(result.documentUrl, null);
    assert.match(result.text, /Jane Doe - Resume/);
  });
});

test('a Résumé line whose link has no scheme still names that link', () => {
  const html = comment('Résumé/CV: jmuconto.github.io/resume');
  const links = screenedLinks(html);
  assert.deepEqual(links.map((l) => l.url), ['https://example.com/me', 'https://jmuconto.github.io/resume']);
  assert.equal(labelledResumeIndex(html, links), 2);
});
