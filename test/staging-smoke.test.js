import { afterEach, describe, expect, test } from 'bun:test';
import { runStagingSmoke } from '../scripts/staging-smoke.js';

const servers = [];
const candidate = {
  id: 'candidate-1',
  name: 'Test Candidate',
  role: 'Engineer',
  summary: 'Builds reliable systems.',
  location: 'Remote',
  mode: 'Remote',
  availability: 'Immediate',
  university: 'Example University',
  universities: ['Example University'],
  companies: ['Example Co'],
  skills: ['JavaScript'],
  dateRanges: ['2024 - present'],
  source: 'Candidate submitted',
  sourceUrl: '',
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
