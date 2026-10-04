import { afterEach, describe, expect, test } from 'bun:test';
import { runStagingSmoke } from '../scripts/staging-smoke.js';
import worker from '../worker.js';
import { createEnvironment } from './memory-d1.js';

const servers = [];
function credentialUrl(value) {
  const url = new URL(value);
  url.username = 'synthetic';
  url.password = 'invalid';
  return url.href;
}
const candidate = {
  id: 'candidate-1',
  name: 'Test Candidate',
  role: 'Engineer',
  summary: 'Builds reliable systems.',
  location: 'Remote',
  mode: 'Remote',
  availability: 'Immediate',
  hnUsername: '',
  linkedinUrl: '',
  githubUrl: '',
  personalUrl: '',
  university: 'Example University',
  universities: ['Example University'],
  companies: ['Example Co'],
  skills: ['JavaScript'],
  dateRanges: ['2024 - present'],
  source: 'Candidate submitted',
  sourceUrl: '',
  sources: [],
  processed: true,
  posted: 0,
  publishedAt: '2026-08-01T00:00:00.000Z'
};

afterEach(() => {
  servers.splice(0).forEach((server) => server.stop(true));
});

describe('staging smoke', () => {
  test('validates HTML, same-origin assets, and the public candidate API', async () => {
    const baseUrl = serve();
    await expect(runStagingSmoke(baseUrl)).resolves.toEqual({ assets: 2, candidates: 1 });
  });

  test.each([
    ['no experience', null],
    ['a bounded range', { minYears: 3, maxYears: 5 }],
    ['an open-ended range', { minYears: 10, maxYears: null }]
  ])('accepts %s', async (_label, experience) => {
    const value = { ...candidate, experience };
    await expect(runStagingSmoke(serve({ candidatesResponse: () => json({ candidates: [value] }) }))).resolves.toEqual({ assets: 2, candidates: 1 });
  });

  test('accepts the actual Worker listing after merging synthetic HN submissions', async () => {
    const env = createEnvironment();
    env.HN_INGEST_TOKEN = 'synthetic-smoke-test-token-long-enough';
    const profiles = ['900001', '900002'].map((itemId, index) => ({
      comment: {
        itemId, author: 'synthetic_smoke', threadId: '900000', threadMonth: '2026-10',
        createdAt: `2026-10-0${index + 1}T00:00:00Z`, commentText: 'Location: Remote. Engineer seeking work.'
      },
      draft: {
        name: 'Synthetic Candidate', role: 'Engineer', summary: 'Builds systems.', location: 'Remote',
        workMode: 'Remote', availability: 'Immediate', universities: [], companies: [],
        skills: ['JavaScript'], dateRanges: []
      }
    }));
    const pushed = await worker.fetch(new Request('https://directory.example/api/admin/profiles/hn', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${env.HN_INGEST_TOKEN}` },
      body: JSON.stringify({ profiles, extractor: 'claude-skill-v1' })
    }), env);
    expect(pushed.status).toBe(200);
    const listing = await worker.fetch(new Request('https://directory.example/api/candidates'), env);
    expect(listing.status).toBe(200);
    const payload = await listing.clone().json();
    expect(payload.candidates).toHaveLength(1);
    expect(payload.candidates[0].sources).toHaveLength(2);
    expect(payload.candidates[0].processed).toBe(true);
    const baseUrl = serve({ candidatesResponse: () => listing.clone() });
    await expect(runStagingSmoke(baseUrl)).resolves.toEqual({ assets: 2, candidates: 1 });
  });

  test.each([
    ['an unknown field', { ...candidate, unexpected: true }, 'public shape'],
    ['a missing field', Object.fromEntries(Object.entries(candidate).filter(([key]) => key !== 'hnUsername')), 'public shape'],
    ['a non-boolean processed flag', { ...candidate, processed: 'true' }, 'invalid processed'],
    ['non-array sources', { ...candidate, sources: {} }, 'invalid sources'],
    ['unknown source keys', { ...candidate, sources: [{ label: 'HN', url: 'https://news.ycombinator.com/item?id=900001', extra: '' }] }, 'public source shape'],
    ['private nested source data', { ...candidate, sources: [{ label: 'HN', url: 'https://news.ycombinator.com/item?id=900001', sourceText: 'private' }] }, 'private key payload.candidates[0].sources[0].sourceText'],
    ['a missing source URL', { ...candidate, sources: [{ label: 'HN' }] }, 'public source shape'],
    ['an empty source label', { ...candidate, sources: [{ label: '', url: 'https://news.ycombinator.com/item?id=900001' }] }, 'public source shape'],
    ['an empty source URL', { ...candidate, sources: [{ label: 'HN', url: '' }] }, 'invalid URL'],
    ['non-object experience', { ...candidate, experience: '5 years' }, 'invalid experience'],
    ['unknown experience keys', { ...candidate, experience: { minYears: 5, maxYears: 5, raw: '5' } }, 'invalid experience'],
    ['an inverted experience range', { ...candidate, experience: { minYears: 8, maxYears: 3 } }, 'invalid experience']
  ])('rejects %s in the current schema', async (_label, value, message) => {
    await expect(runStagingSmoke(serve({ candidatesResponse: () => json({ candidates: [value] }) }))).rejects.toThrow(message);
  });

  test.each([
    ['personalUrl', 'javascript:alert(1)'],
    ['linkedinUrl', 'http://www.linkedin.com/in/synthetic-candidate'],
    ['githubUrl', credentialUrl('https://github.com/synthetic-candidate')],
    ['personalUrl', 'https://example.com/?email=private'],
    ['personalUrl', 'https://example.com/#private'],
    ['personalUrl', 'https://example.com:8443/'],
    ['personalUrl', 'https://127.0.0.1/'],
    ['sourceUrl', 'https://news.ycombinator.com/item?id=900001&email=private']
  ])('rejects unsafe %s', async (key, url) => {
    const value = { ...candidate, [key]: url };
    await expect(runStagingSmoke(serve({ candidatesResponse: () => json({ candidates: [value] }) }))).rejects.toThrow('invalid URL');
  });

  test('rejects unsafe nested source URLs', async () => {
    const value = { ...candidate, sources: [{ label: 'HN', url: credentialUrl('https://news.ycombinator.com/item?id=900001') }] };
    await expect(runStagingSmoke(serve({ candidatesResponse: () => json({ candidates: [value] }) }))).rejects.toThrow('invalid URL');
  });

  test.each([
    ['malformed JSON', () => response('{', 'application/json', { 'cache-control': 'no-store' }), 'malformed JSON'],
    [
      'private data leak',
      () => json({ candidates: [{ ...candidate, reviewToken: 'private' }] }),
      'private key payload.candidates[0].reviewToken'
    ],
    ['invalid public shape', () => json({ candidates: [{ ...candidate, role: null }] }), 'invalid role']
  ])('rejects %s', async (_label, candidatesResponse, message) => {
    const baseUrl = serve({ candidatesResponse });
    await expect(runStagingSmoke(baseUrl)).rejects.toThrow(message);
  });

  test.each([
    ['same-origin', '/elsewhere', '/elsewhere'],
    ['cross-origin', 'https://example.com/elsewhere', 'https://example.com']
  ])('rejects a %s redirect', async (_label, location, message) => {
    const baseUrl = serve({ htmlResponse: () => new Response(null, { status: 302, headers: { location } }) });
    await expect(runStagingSmoke(baseUrl)).rejects.toThrow(`redirected to ${message}`);
  });

  test('bounds request time', async () => {
    const baseUrl = serve({
      htmlResponse: async () => {
        await Bun.sleep(100);
        return html();
      }
    });
    await expect(runStagingSmoke(baseUrl, { timeoutMs: 20, maxBytes: 1_000_000 })).rejects.toThrow('directory HTML timed out');
  });

  test('bounds a stalled response body', async () => {
    let sentFirstChunk = false;
    const stream = new ReadableStream({
      async pull(controller) {
        if (!sentFirstChunk) {
          sentFirstChunk = true;
          controller.enqueue(new TextEncoder().encode('<!doctype html>'));
          return;
        }
        await Bun.sleep(100);
        controller.close();
      }
    });
    const baseUrl = serve({ htmlResponse: () => new Response(stream, { headers: { 'content-type': 'text/html' } }) });
    await expect(runStagingSmoke(baseUrl, { timeoutMs: 20, maxBytes: 1_000_000 })).rejects.toThrow('directory HTML timed out');
  });

  test('bounds response bytes', async () => {
    const baseUrl = serve({ htmlResponse: () => response('x'.repeat(101), 'text/html') });
    await expect(runStagingSmoke(baseUrl, { timeoutMs: 5_000, maxBytes: 100 })).rejects.toThrow(
      'directory HTML exceeded 100 bytes'
    );
  });

  test('bounds same-origin asset requests', async () => {
    const scripts = Array.from({ length: 16 }, (_, index) => `<script src="./asset-${index}.js"></script>`).join('');
    const baseUrl = serve({
      htmlResponse: () => response(`<link rel="stylesheet" href="./who-is-hiring.css">${scripts}`, 'text/html')
    });
    await expect(runStagingSmoke(baseUrl)).rejects.toThrow('directory HTML references more than 16 assets');
  });

  test('rejects a non-2xx response', async () => {
    const baseUrl = serve({ candidatesResponse: () => new Response('unavailable', { status: 503 }) });
    await expect(runStagingSmoke(baseUrl)).rejects.toThrow('candidate API returned HTTP 503');
  });

  test('requires HTTPS away from loopback', async () => {
    await expect(runStagingSmoke('http://example.com')).rejects.toThrow('base URL must use HTTPS except for loopback tests');
  });
});

function serve(overrides = {}) {
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    routes: {
      '/': overrides.htmlResponse || (() => html()),
      '/who-is-hiring.css': () => response('body {}', 'text/css'),
      '/who-is-hiring.js': () => response('document.body.dataset.ready = "true";', 'text/javascript'),
      '/api/candidates': overrides.candidatesResponse || (() => json({ candidates: [candidate] }))
    }
  });
  servers.push(server);
  return server.url.href;
}

function html() {
  return response(
    '<!doctype html><html><head><link rel="stylesheet" href="./who-is-hiring.css"></head><body><script src="./who-is-hiring.js"></script></body></html>',
    'text/html'
  );
}

function json(value) {
  return response(JSON.stringify(value), 'application/json', { 'cache-control': 'no-store' });
}

function response(body, contentType, headers = {}) {
  return new Response(body, { headers: { 'content-type': contentType, ...headers } });
}
