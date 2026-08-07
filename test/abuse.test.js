import { describe, expect, test } from 'bun:test';
import worker, { HN_INGEST_LIMITS, decodeHnCommentText, extractProfile } from '../worker.js';
import { redactSensitiveText } from '../sensitive-data.js';
import { createEnvironment } from './memory-d1.js';

const ORIGIN = 'https://directory.example';
const INGEST_TOKEN = 'operator-secret-operator-secret-0123456789';

describe('volume abuse', () => {
  test('caps a single client burst and reopens after the window rolls', async () => {
    const env = createEnvironment();
    const clock = installClock();
    try {
      const burst = await sequential(12, () => submitText(env, 'Name: Burst Candidate'));
      const accepted = burst.filter((response) => response.status === 202);
      const rejected = burst.filter((response) => response.status === 429);
      expect(accepted).toHaveLength(10);
      expect(rejected).toHaveLength(2);
      expect(Number(rejected[0].headers.get('retry-after'))).toBeGreaterThan(0);
      expect(await rejected[0].json()).toEqual({ error: 'rate_limited' });

      clock.advance(60_000);
      expect((await submitText(env, 'Name: Next Window')).status).toBe(202);
    } finally {
      clock.restore();
    }
  });

  test('attributes quota per client address rather than globally', async () => {
    const env = createEnvironment();
    const clock = installClock();
    try {
      const exhausted = await sequential(11, () => submitText(env, 'Name: Noisy', '203.0.113.9'));
      expect(exhausted.at(-1).status).toBe(429);
      expect((await submitText(env, 'Name: Quiet', '198.51.100.4')).status).toBe(202);
    } finally {
      clock.restore();
    }
  });

  test('fails closed on writes when the limiter store is unavailable', async () => {
    const env = createEnvironment();
    const originalPrepare = env.DB.prepare.bind(env.DB);
    env.DB.prepare = (sql) => {
      if (sql.includes('rate_limits')) throw new Error('d1 unavailable');
      return originalPrepare(sql);
    };

    const response = await submitText(env, 'Name: Blocked Candidate');
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'rate_limit_unavailable' });
    expect(env.SUBMISSION_QUEUE.messages).toEqual([]);
  });
});

describe('storage exhaustion', () => {
  test('refuses new submissions once the pending backlog reaches capacity', async () => {
    const env = createEnvironment();
    env.DB.serviceState.set('pending_submissions', { key: 'pending_submissions', value: 5_000, updated_at: '2026-01-01T00:00:00.000Z' });

    const response = await submitText(env, 'Name: Overflow Candidate');
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'submission_capacity_reached' });
    expect(env.SUBMISSION_QUEUE.messages).toEqual([]);
  });

  test('expires abandoned submissions and refreshes the backlog counter on cron', async () => {
    const env = createEnvironment();
    const accepted = await (await submitText(env, 'Name: Abandoned Candidate')).json();
    env.DB.submissions.get(accepted.submissionId).updated_at = '2020-01-01T00:00:00.000Z';
    env.DB.rateLimits.set('stale:bucket', { bucket: 'stale:bucket', window_start: 0, hits: 99, updated_at: '2020-01-01T00:00:00.000Z' });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error('no upstream in test');
    };
    try {
      await worker.scheduled({}, env);
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(env.DB.submissions.has(accepted.submissionId)).toBe(false);
    expect(env.DB.rateLimits.has('stale:bucket')).toBe(false);
    expect(env.DB.serviceState.get('pending_submissions').value).toBe(0);
  });
});

describe('token brute force', () => {
  test('answers an unknown id and a wrong token identically', async () => {
    const env = createEnvironment();
    const accepted = await (await submitText(env, 'Name: Private Candidate')).json();

    const wrongToken = await worker.fetch(apiRequest(`/api/reviews/${accepted.submissionId}`, 'GET', null, { token: 'not-the-token' }), env);
    const unknownId = await worker.fetch(apiRequest('/api/reviews/00000000-0000-4000-8000-000000000000', 'GET', null, { token: 'not-the-token' }), env);

    expect(wrongToken.status).toBe(403);
    expect(unknownId.status).toBe(wrongToken.status);
    expect(await unknownId.json()).toEqual(await wrongToken.json());
    expect(unknownId.headers.get('cache-control')).toBe(wrongToken.headers.get('cache-control'));
  });

  test('rate limits repeated authorization failures without locking out the token holder', async () => {
    const env = createEnvironment();
    const accepted = await (await submitText(env, 'Name: Guarded Candidate')).json();

    const attempts = await sequential(21, (index) =>
      worker.fetch(apiRequest(`/api/reviews/${accepted.submissionId}`, 'GET', null, { token: `guess-${index}` }), env)
    );
    expect(attempts.slice(0, 20).every((response) => response.status === 403)).toBe(true);
    expect(attempts.at(-1).status).toBe(429);

    const correct = await worker.fetch(apiRequest(`/api/reviews/${accepted.submissionId}`, 'GET', null, { token: accepted.reviewToken }), env);
    expect(correct.status).toBe(200);
  });

  test('ignores an oversized bearer credential instead of hashing it', async () => {
    const env = createEnvironment();
    const accepted = await (await submitText(env, 'Name: Guarded Candidate')).json();
    const response = await worker.fetch(apiRequest(`/api/reviews/${accepted.submissionId}`, 'GET', null, { token: 'x'.repeat(4_096) }), env);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'review_token_required' });
  });
});

describe('hostile payloads', () => {
  test('rejects a body that lies about its content length', async () => {
    const env = createEnvironment();
    const response = await worker.fetch(
      streamedRequest('/api/submissions/text', 'x'.repeat(200_000), { 'content-length': '12', 'content-type': 'application/json' }),
      env
    );
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: 'source_text_too_large', maxBytes: 100_000 });
  });

  test('rejects a chunked body with no declared length', async () => {
    const env = createEnvironment();
    const response = await worker.fetch(
      streamedRequest('/api/submissions/text', 'x'.repeat(200_000), { 'content-type': 'application/json' }),
      env
    );
    expect(response.status).toBe(413);
  });

  test('rejects a non-numeric content length', async () => {
    const env = createEnvironment();
    const response = await worker.fetch(
      streamedRequest('/api/submissions/text', '{}', { 'content-length': '1e9', 'content-type': 'application/json' }),
      env
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_content_length' });
  });

  test('rejects deeply nested json before handing it to the parser', async () => {
    const env = createEnvironment();
    const nested = `{"sourceText":${'['.repeat(2_000)}${']'.repeat(2_000)}}`;
    const response = await worker.fetch(streamedRequest('/api/submissions/text', nested, { 'content-type': 'application/json' }), env);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_json' });
  });

  test('rejects a body sent under a non-json content type', async () => {
    const env = createEnvironment();
    const response = await worker.fetch(
      streamedRequest('/api/submissions/text', '{"sourceText":"Name: Ada"}', { 'content-type': 'text/plain' }),
      env
    );
    expect(response.status).toBe(415);
    expect(await response.json()).toEqual({ error: 'unsupported_media_type' });
  });

  test('rejects invalid utf-8 without leaking a decoder error', async () => {
    const env = createEnvironment();
    const response = await worker.fetch(
      streamedRequest('/api/submissions/text', new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]), { 'content-type': 'application/json' }),
      env
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_json' });
  });

  test('strips bidi overrides and zero-width characters from extracted fields', () => {
    const draft = extractProfile('Name: Ada‮reversed​Candidate\nRole: ⁦Engineer⁩\nLocation: Toronto');
    expect(draft.name).toBe('AdareversedCandidate');
    expect(draft.role).toBe('Engineer');
    expect(/[​-‏‪-‮⁦-⁩﻿]/.test(JSON.stringify(draft))).toBe(false);
  });

  test('bounds every field an extractor can emit', () => {
    const draft = extractProfile(`Name: ${'a'.repeat(5_000)}\nSummary: ${'b'.repeat(50_000)}\nSkills: ${'c'.repeat(5_000)}`);
    expect(draft.name.length).toBeLessThanOrEqual(200);
    expect(draft.summary.length).toBeLessThanOrEqual(2_000);
    draft.skills.forEach((skill) => expect(skill.length).toBeLessThanOrEqual(200));
  });
});

describe('redos guards', () => {
  test('markup stripping stays linear on adversarial html', () => {
    const hostile = `<a href="${'a'.repeat(4_000)}${'<'.repeat(20_000)}${'<div '.repeat(20_000)}`;
    const elapsed = timed(() => decodeHnCommentText(hostile));
    expect(elapsed).toBeLessThan(2_000);
  });

  test('comment decoding truncates to the ingest limit', () => {
    expect(decodeHnCommentText('x'.repeat(200_000)).length).toBeLessThanOrEqual(HN_INGEST_LIMITS.commentChars);
  });

  test('credential redaction stays linear on adversarial assignments', () => {
    const hostile = `${'credentials: "'}${'a:'.repeat(2_000)}`.repeat(1);
    const elapsed = timed(() => redactSensitiveText(hostile));
    expect(elapsed).toBeLessThan(2_000);
  });

  test('refuses to scan text beyond the redaction budget', () => {
    const result = redactSensitiveText('a'.repeat(9_000));
    expect(result).toEqual({ value: '[redacted]', detected: true });
  });

  test('profile extraction stays linear on adversarial source text', () => {
    const hostile = `${'label: '.repeat(1)}${'a:'.repeat(20_000)}\n`.repeat(20);
    const elapsed = timed(() => extractProfile(hostile));
    expect(elapsed).toBeLessThan(2_000);
  });
});

describe('response hygiene', () => {
  test('blocks a cross-origin write while allowing the same origin', async () => {
    const env = createEnvironment();
    const foreign = await worker.fetch(
      apiRequest('/api/submissions/text', 'POST', { sourceText: 'Name: Ada' }, { origin: 'https://evil.example' }),
      env
    );
    expect(foreign.status).toBe(403);
    expect(await foreign.json()).toEqual({ error: 'cross_origin_request_blocked' });

    const local = await worker.fetch(
      apiRequest('/api/submissions/text', 'POST', { sourceText: 'Name: Ada' }, { origin: ORIGIN }),
      env
    );
    expect(local.status).toBe(202);
  });

  test('refuses a cors preflight rather than advertising permissive headers', async () => {
    const env = createEnvironment();
    const response = await worker.fetch(apiRequest('/api/submissions/text', 'OPTIONS', null, { origin: 'https://evil.example' }), env);
    expect(response.status).toBe(405);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });

  test('sets the security header set on api and asset responses', async () => {
    const env = createEnvironment();
    env.ASSETS = { fetch: async () => new Response('<html></html>', { headers: { 'content-type': 'text/html' } }) };

    const api = await worker.fetch(apiRequest('/api/candidates'), env);
    const asset = await worker.fetch(new Request(`${ORIGIN}/`), env);

    [api, asset].forEach((response) => {
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(response.headers.get('x-frame-options')).toBe('DENY');
      expect(response.headers.get('referrer-policy')).toBe('no-referrer');
      expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
      expect(response.headers.get('content-security-policy')).toContain("object-src 'none'");
    });
  });

  test('returns a generic body when an unexpected failure escapes a handler', async () => {
    const env = createEnvironment();
    env.DB = {
      prepare() {
        throw new Error('sensitive internal detail');
      }
    };
    const response = await worker.fetch(apiRequest('/api/candidates'), env);
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain('sensitive internal detail');
  });

  test('keeps the ingest secret out of every operator-facing response', async () => {
    const env = createEnvironment();
    env.HN_INGEST_TOKEN = INGEST_TOKEN;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response('upstream exploded', { status: 500 });
    try {
      const response = await worker.fetch(apiRequest('/api/admin/ingest/hn', 'POST', {}, { token: INGEST_TOKEN }), env);
      const body = await response.text();
      expect(body).not.toContain(INGEST_TOKEN);
      expect(body).not.toContain('upstream exploded');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

function apiRequest(path, method = 'GET', body = null, options = {}) {
  const headers = {};
  if (body !== null) headers['content-type'] = 'application/json';
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.origin) headers.origin = options.origin;
  if (options.address) headers['cf-connecting-ip'] = options.address;
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers,
    body: body === null ? undefined : JSON.stringify(body)
  });
}

// Cloudflare hands the worker a streaming body whose real size can disagree with the declared
// length, which `new Request` normalizes away, so the abuse cases build the shape directly.
function streamedRequest(path, payload, headers) {
  const bytes = typeof payload === 'string' ? new TextEncoder().encode(payload) : payload;
  return {
    method: 'POST',
    url: `${ORIGIN}${path}`,
    headers: new Headers(headers),
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      }
    })
  };
}

function submitText(env, sourceText, address = '203.0.113.1') {
  return worker.fetch(apiRequest('/api/submissions/text', 'POST', { sourceText }, { address }), env);
}

async function sequential(count, run) {
  const results = [];
  for (let index = 0; index < count; index += 1) results.push(await run(index));
  return results;
}

function installClock() {
  const originalNow = Date.now;
  let offset = 0;
  Date.now = () => originalNow.call(Date) + offset;
  return {
    advance(milliseconds) {
      offset += milliseconds;
    },
    restore() {
      Date.now = originalNow;
    }
  };
}

function timed(run) {
  const started = performance.now();
  run();
  return performance.now() - started;
}
