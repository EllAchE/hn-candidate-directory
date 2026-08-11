import { sanitizeCandidateDraft } from './sensitive-data.js';

// Outbound fetches must never follow a redirect, but `redirect: 'error'` is not implementable at
// the edge and workerd throws a TypeError on it before the request leaves. Node and Bun both accept
// it, so the whole suite passes while every deployed fetch dies -- this is what kept the HN ingest
// silently empty. `manual` surfaces the 3xx as a normal response, and every caller rejects non-2xx.
const NO_REDIRECT = 'manual';
const MAX_SOURCE_BYTES = 100_000;
const MAX_REQUEST_BYTES = MAX_SOURCE_BYTES + 4_096;
const MAX_URL_REQUEST_BYTES = 4_096;
const MAX_RESUME_BYTES = MAX_SOURCE_BYTES;
const MAX_RESUME_FILENAME_BYTES = 128;
const STRING_WEB_ACCESS_ENDPOINT = 'https://request.usestring.ai/v1/fetch';
const STRING_WEB_ACCESS_LIMITS = Object.freeze({ requests: 1, pages: 1, timeoutMs: 12_000, responseBytes: 750_000 });
const LINKEDIN_PROFILE_HOSTS = new Set(['linkedin.com', 'www.linkedin.com']);
const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
const HN_ALGOLIA_ENDPOINT = 'https://hn.algolia.com/api/v1/search';
const HN_ALGOLIA_RECENT_ENDPOINT = 'https://hn.algolia.com/api/v1/search_by_date';
const HN_THREAD_QUERY = Object.freeze({ query: 'who wants to be hired', tags: 'story,author_whoishiring' });
const HN_INGEST_LIMITS = Object.freeze({
  threads: 2,
  threadCandidates: 40,
  commentPages: 8,
  pageSize: 100,
  queueBatch: 100,
  commentChars: 16_000,
  minProseChars: 120,
  timeoutMs: 10_000,
  responseBytes: 4_000_000
});
const HN_MONTHS = Object.freeze([
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December'
]);
const HN_LOCATION_LABELS = Object.freeze(['location', 'based in', 'based', 'city', 'country']);
const HN_REMOTE_LABELS = Object.freeze(['remote', 'remote work', 'remote?']);
const HN_ROLE_LABELS = Object.freeze(['role', 'title', 'position', 'seeking', 'looking for', 'interested in']);
const HN_SKILL_LABELS = Object.freeze(['technologies', 'technology', 'tech', 'tech stack', 'stack', 'skills', 'tools']);
const HN_UNIVERSITY_LABELS = Object.freeze(['education', 'university', 'universities', 'school', 'schools', 'degree']);
// 'experience' is deliberately excluded: candidates use it for years-of-experience ("Experience:
// 4+ years"), and mapping it here fed that phrase into the companies field instead of a name.
const HN_COMPANY_LABELS = Object.freeze(['companies', 'company', 'previously', 'employers', 'worked at']);
const HN_AVAILABILITY_LABELS = Object.freeze(['availability', 'available', 'start date', 'notice period']);
const HN_NAME_LABELS = Object.freeze(['name']);
const HN_MAPPED_LABELS = new Set([
  ...HN_LOCATION_LABELS,
  ...HN_REMOTE_LABELS,
  ...HN_ROLE_LABELS,
  ...HN_SKILL_LABELS,
  ...HN_UNIVERSITY_LABELS,
  ...HN_COMPANY_LABELS,
  ...HN_AVAILABILITY_LABELS,
  ...HN_NAME_LABELS
]);
const HN_UNKNOWN = 'Not specified';
// A card headline: long enough for a real title or a short opening sentence, short enough that a
// candidate's whole self-introduction can never pass as one.
const HN_TITLE_MAX_CHARS = 140;
const HN_TITLE_SENTENCE_PATTERN = new RegExp(`^(.{1,${HN_TITLE_MAX_CHARS}}?[.!?])(?=\\s|$)`);
const HN_INGEST_TOKEN_MIN_LENGTH = 32;
const MAX_BEARER_TOKEN_CHARS = 256;
const MAX_JSON_DEPTH = 32;
const INVISIBLE_TEXT_PATTERN = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;
const MAX_HTML_SOURCE_CHARS = 400_000;
const MAX_PUBLIC_CANDIDATES = 1_000;
const CANDIDATES_PAGE_SIZE = 200;
const DRAFT_FIELD_LIMITS = Object.freeze({
  name: 200,
  role: 300,
  summary: 2_000,
  location: 300,
  workMode: 100,
  availability: 100,
  listItem: 200
});
const RATE_LIMITS = Object.freeze({
  submissionBurst: { limit: 10, windowSeconds: 60 },
  submissionDaily: { limit: 40, windowSeconds: 86_400 },
  submissionGlobal: { limit: 3_000, windowSeconds: 21_600 },
  authFailure: { limit: 20, windowSeconds: 600 },
  ingestRequest: { limit: 10, windowSeconds: 600 },
  ingestRun: { limit: 1, windowSeconds: 900 },
  removalRequest: { limit: 20, windowSeconds: 3_600 }
});
const STORAGE_LIMITS = Object.freeze({
  pendingSubmissions: 5_000,
  abandonedSubmissionDays: 30,
  rateLimitRetentionSeconds: 172_800
});
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self'",
  'upgrade-insecure-requests'
].join('; ');
const SECURITY_HEADERS = Object.freeze({
  'content-security-policy': CONTENT_SECURITY_POLICY,
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'cross-origin-opener-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()'
});
const JSON_RESPONSE_HEADERS = Object.freeze({ ...JSON_HEADERS, ...SECURITY_HEADERS });

export default {
  async fetch(request, env) {
    try {
      return await routeRequest(request, env);
    } catch {
      return json({ error: 'internal_error' }, 500);
    }
  },

  async queue(batch, env) {
    await Promise.all(batch.messages.map((message) => processQueueMessage(message, env)));
  },

  async scheduled(_event, env) {
    await maintainStorage(env);
    if (!(await reserveIngestRun(env))) return;
    try {
      await ingestHackerNews(env);
    } catch (error) {
      logIngestFailure('scheduled', error);
    }
  }
};

// The ingest runs unattended on a cron, so discarding the reason it failed leaves no trace anywhere:
// a broken ingest and an ingest with nothing new to collect are indistinguishable from outside, which
// is how this ran empty for days. Only the failure reason is logged -- ingest inputs are public
// Hacker News URLs, and no candidate content or token reaches this path.
function logIngestFailure(stage, error) {
  const reason = ingestFailureReason(error);
  console.error(`hn ingest failed during ${stage}: ${reason}`);
  return reason;
}

function ingestFailureReason(error) {
  return error instanceof Error ? `${error.name}: ${error.message}` : 'unknown error';
}

async function routeRequest(request, env) {
  const url = new URL(request.url);

  if (url.pathname.startsWith('/api/')) {
    if (request.method === 'OPTIONS') return json({ error: 'method_not_allowed' }, 405);
    if (request.method !== 'GET' && isDisallowedOrigin(request, url, env)) {
      return json({ error: 'cross_origin_request_blocked' }, 403);
    }
  }

  if (url.pathname === '/api/submissions/text') {
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
    return createTextSubmission(request, env);
  }

  if (url.pathname === '/api/submissions/url') {
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
    return createUrlSubmission(request, env);
  }

  if (url.pathname === '/api/submissions/resume') {
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
    return createResumeSubmission(request, env);
  }

  const decisionMatch = url.pathname.match(/^\/api\/reviews\/([^/]+)\/decision$/);
  if (decisionMatch) {
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
    return decideReview(request, env, decisionMatch[1]);
  }

  const reviewMatch = url.pathname.match(/^\/api\/reviews\/([^/]+)$/);
  if (reviewMatch) {
    if (request.method === 'GET') return getReview(request, env, reviewMatch[1]);
    if (request.method === 'PATCH') return updateReview(request, env, reviewMatch[1]);
    return json({ error: 'method_not_allowed' }, 405);
  }

  const removalMatch = url.pathname.match(/^\/api\/candidates\/([^/]+)\/removal$/);
  if (removalMatch) {
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
    return requestCandidateRemoval(request, env, removalMatch[1]);
  }

  const managementMatch = url.pathname.match(/^\/api\/candidates\/([^/]+)\/manage$/);
  if (managementMatch) {
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
    return manageCandidate(request, env, managementMatch[1]);
  }

  if (url.pathname === '/api/candidates') {
    if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
    return listPublishedCandidates(request, env);
  }

  if (url.pathname === '/api/admin/ingest/hn') {
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
    return runHackerNewsIngest(request, env);
  }

  if (url.pathname.startsWith('/api/')) return json({ error: 'not_found' }, 404);
  if (!['GET', 'HEAD'].includes(request.method)) return json({ error: 'method_not_allowed' }, 405);
  if (!env.ASSETS) return new Response('Not found', { status: 404, headers: SECURITY_HEADERS });

  if (url.pathname === '/') {
    url.pathname = '/who-is-hiring.html';
    return withSecurityHeaders(await env.ASSETS.fetch(new Request(url, request)));
  }

  return withSecurityHeaders(await env.ASSETS.fetch(request));
}

function isDisallowedOrigin(request, url, env) {
  const origin = request.headers.get('origin');
  if (!origin) return false;
  const allowed = new Set([
    url.origin,
    ...String(env.ALLOWED_ORIGINS || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
  ]);
  return !allowed.has(origin);
}

function withSecurityHeaders(response) {
  const headers = new Headers(response.headers);
  Object.entries(SECURITY_HEADERS).forEach(([name, value]) => headers.set(name, value));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function processQueueMessage(message, env) {
  if (message.body?.hnComment) return processHnCommentMessage(message, env);
  return processSubmissionMessage(message, env);
}

// Cloudflare rewrites `cf-connecting-ip` on every edge request, so it is the only client
// identifier a caller cannot forge. Anything else would let one client poison another's bucket.
async function clientKey(env, request) {
  const address = request.headers.get('cf-connecting-ip') || 'unattributed';
  return (await hashToken(`${env.RATE_LIMIT_SALT || 'hn-candidate-directory'}|${address}`)).slice(0, 24);
}

async function consumeQuota(env, bucket, rule) {
  const nowMs = Date.now();
  const nowSeconds = Math.floor(nowMs / 1_000);
  const windowStart = Math.floor(nowSeconds / rule.windowSeconds) * rule.windowSeconds;
  const row = await env.DB.prepare(
    `INSERT INTO rate_limits (bucket, window_start, hits, updated_at)
     VALUES (?, ?, 1, ?)
     ON CONFLICT(bucket) DO UPDATE SET
       hits = CASE WHEN rate_limits.window_start = excluded.window_start THEN rate_limits.hits + 1 ELSE 1 END,
       window_start = excluded.window_start,
       updated_at = excluded.updated_at
     RETURNING hits`
  )
    .bind(bucket, windowStart, new Date(nowMs).toISOString())
    .first();

  const hits = Number(row?.hits ?? Number.MAX_SAFE_INTEGER);
  return { hits, allowed: hits <= rule.limit, retryAfter: Math.max(1, windowStart + rule.windowSeconds - nowSeconds) };
}

async function consumeEdgeQuota(env, key) {
  if (typeof env.RATE_LIMITER?.limit !== 'function') return null;
  try {
    const outcome = await env.RATE_LIMITER.limit({ key });
    return outcome?.success === false ? rateLimited(60) : null;
  } catch {
    return null;
  }
}

async function enforceQuota(env, name, scopeKey) {
  const edge = await consumeEdgeQuota(env, `${name}:${scopeKey}`);
  if (edge) return edge;

  try {
    const outcome = await consumeQuota(env, `${name}:${scopeKey}`, RATE_LIMITS[name]);
    return outcome.allowed ? null : rateLimited(outcome.retryAfter);
  } catch {
    return json({ error: 'rate_limit_unavailable' }, 503);
  }
}

async function reserveSubmissionCapacity(request, env) {
  const key = await clientKey(env, request);
  const burst = await enforceQuota(env, 'submissionBurst', key);
  if (burst) return burst;
  const daily = await enforceQuota(env, 'submissionDaily', key);
  if (daily) return daily;

  let global;
  try {
    global = await consumeQuota(env, 'submissionGlobal:all', RATE_LIMITS.submissionGlobal);
  } catch {
    return json({ error: 'rate_limit_unavailable' }, 503);
  }
  if (!global.allowed) return rateLimited(global.retryAfter);
  if (await isSubmissionStorageFull(env, global.hits)) return json({ error: 'submission_capacity_reached' }, 503);
  return null;
}

// `pending_submissions` is a cron-refreshed measurement, so the live window counter is added to it
// rather than trusting a value that can be up to one cron interval stale.
async function isSubmissionStorageFull(env, windowHits) {
  try {
    const row = await env.DB.prepare('SELECT value FROM service_state WHERE key = ?').bind('pending_submissions').first();
    return Number(row?.value ?? 0) + windowHits > STORAGE_LIMITS.pendingSubmissions;
  } catch {
    return true;
  }
}

async function denyAuthorization(request, env, response) {
  try {
    const outcome = await consumeQuota(env, `authFailure:${await clientKey(env, request)}`, RATE_LIMITS.authFailure);
    return outcome.allowed ? response : rateLimited(outcome.retryAfter);
  } catch {
    return response;
  }
}

async function reserveIngestRun(env) {
  if (!env.DB) return false;
  try {
    return (await consumeQuota(env, 'ingestRun:all', RATE_LIMITS.ingestRun)).allowed;
  } catch {
    return false;
  }
}

async function maintainStorage(env) {
  if (!env.DB) return;
  const nowMs = Date.now();
  const abandonedBefore = new Date(nowMs - STORAGE_LIMITS.abandonedSubmissionDays * 86_400_000).toISOString();
  const staleWindowStart = Math.floor(nowMs / 1_000) - STORAGE_LIMITS.rateLimitRetentionSeconds;

  try {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM submissions WHERE status IN ('submitted', 'failed') AND updated_at < ?").bind(abandonedBefore),
      env.DB.prepare('DELETE FROM rate_limits WHERE window_start < ?').bind(staleWindowStart)
    ]);
    const pending = await env.DB.prepare(
      "SELECT COUNT(*) AS total FROM submissions WHERE status IN ('submitted', 'processing', 'failed')"
    ).first();
    await env.DB.prepare(
      `INSERT INTO service_state (key, value, updated_at) VALUES ('pending_submissions', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
      .bind(Number(pending?.total ?? 0), new Date(nowMs).toISOString())
      .run();
  } catch {
    return;
  }
}

function rateLimited(retryAfter) {
  return json({ error: 'rate_limited' }, 429, { 'retry-after': String(retryAfter) });
}

async function createTextSubmission(request, env) {
  const oversized = () => json({ error: 'source_text_too_large', maxBytes: MAX_SOURCE_BYTES }, 413);
  const body = await readJson(request, MAX_REQUEST_BYTES, oversized);
  if (body instanceof Response) return body;

  const sourceText = typeof body?.sourceText === 'string' ? body.sourceText.trim() : '';
  if (!sourceText) return json({ error: 'source_text_required' }, 400);
  if (byteLength(sourceText) > MAX_SOURCE_BYTES) return oversized();
  if (!env.DB || !env.SUBMISSION_QUEUE) return json({ error: 'service_not_configured' }, 503);

  const quota = await reserveSubmissionCapacity(request, env);
  if (quota) return quota;

  return createQueuedSubmission(env, crypto.randomUUID(), sourceText, 'submission_conflict');
}

async function createUrlSubmission(request, env) {
  const body = await readJson(request, MAX_URL_REQUEST_BYTES);
  if (body instanceof Response) return body;

  const sourceUrl = validateCandidateSourceUrl(body?.url);
  if (!sourceUrl) return json({ error: 'url_not_allowed' }, 400);
  if (!env.DB || !env.SUBMISSION_QUEUE || !env.UNBLOCKER_ORG_API_KEY) return json({ error: 'service_not_configured' }, 503);

  const quota = await reserveSubmissionCapacity(request, env);
  if (quota) return quota;

  const submissionId = `url-${(await hashToken(sourceUrl)).slice(0, 32)}`;
  let existingSubmission;
  try {
    existingSubmission = await env.DB.prepare('SELECT id, status FROM submissions WHERE id = ?').bind(submissionId).first();
  } catch {
    return json({ error: 'submission_storage_unavailable' }, 503);
  }
  if (existingSubmission && existingSubmission.status !== 'failed') return json({ error: 'duplicate_url_submission' }, 409);

  let sourceText;
  try {
    sourceText = await fetchCandidateSource(sourceUrl, env.UNBLOCKER_ORG_API_KEY);
  } catch (error) {
    if (error instanceof UrlSubmissionError) return json({ error: error.code }, error.status);
    return json({ error: 'url_fetch_failed' }, 502);
  }

  if (existingSubmission) return retryFailedUrlSubmission(env, submissionId, sourceText);
  return createQueuedSubmission(env, submissionId, sourceText, 'duplicate_url_submission');
}

async function retryFailedUrlSubmission(env, submissionId, sourceText) {
  const retry = await resetFailedSubmission(env, submissionId, sourceText, 'duplicate_url_submission');
  if (retry instanceof Response) return retry;
  return enqueueSubmission(env, submissionId, retry.reviewToken);
}

async function createResumeSubmission(request, env) {
  if (!isPlainTextContentType(request.headers.get('content-type'))) return json({ error: 'resume_type_not_supported' }, 415);
  if (!isSafeResumeFilename(request.headers.get('x-resume-filename'))) return json({ error: 'resume_type_not_supported' }, 415);

  const resumeBytes = await readLimitedBytes(request, MAX_RESUME_BYTES);
  if (resumeBytes instanceof Response) return resumeBytes;
  const sourceText = decodeResumeText(resumeBytes);
  if (!sourceText) return json({ error: 'resume_content_invalid' }, 400);
  if (!env.DB || !env.SUBMISSION_QUEUE) return json({ error: 'service_not_configured' }, 503);

  const quota = await reserveSubmissionCapacity(request, env);
  if (quota) return quota;

  const contentHash = await hashBytes(resumeBytes);
  const submissionId = `resume-${contentHash}`;
  let existingSubmission;
  try {
    existingSubmission = await env.DB.prepare('SELECT id, status FROM submissions WHERE id = ?').bind(submissionId).first();
  } catch {
    return json({ error: 'submission_storage_unavailable' }, 503);
  }
  if (existingSubmission && existingSubmission.status !== 'failed') return json({ error: 'duplicate_resume_submission' }, 409);

  const pendingSubmission = existingSubmission
    ? await resetFailedSubmission(env, submissionId, sourceText, 'duplicate_resume_submission')
    : await persistQueuedSubmission(env, submissionId, sourceText, 'duplicate_resume_submission');
  if (pendingSubmission instanceof Response) return pendingSubmission;

  return enqueueSubmission(env, submissionId, pendingSubmission.reviewToken);
}

async function resetFailedSubmission(env, submissionId, sourceText, duplicateError) {
  const reviewToken = createToken();
  const reviewTokenHash = await hashToken(reviewToken);
  const updatedAt = new Date().toISOString();

  let results;
  try {
    results = await env.DB.batch([
      env.DB.prepare(
        `UPDATE submissions
            SET source_text = ?, review_token_hash = ?, status = 'submitted', updated_at = ?
          WHERE id = ? AND status = 'failed'
            AND EXISTS (SELECT 1 FROM jobs WHERE submission_id = ? AND status = 'failed')`
      ).bind(sourceText, reviewTokenHash, updatedAt, submissionId, submissionId),
      env.DB.prepare(
        `UPDATE jobs
            SET status = 'queued', attempts = 0, error = NULL, updated_at = ?
          WHERE submission_id = ? AND status = 'failed'`
      ).bind(updatedAt, submissionId)
    ]);
  } catch {
    return json({ error: 'submission_storage_unavailable' }, 503);
  }

  if (results.some((result) => changedRows(result) !== 1)) return json({ error: duplicateError }, 409);
  return { reviewToken };
}

async function createQueuedSubmission(env, submissionId, sourceText, duplicateError) {
  const pendingSubmission = await persistQueuedSubmission(env, submissionId, sourceText, duplicateError);
  if (pendingSubmission instanceof Response) return pendingSubmission;
  return enqueueSubmission(env, submissionId, pendingSubmission.reviewToken);
}

async function persistQueuedSubmission(env, submissionId, sourceText, duplicateError) {
  const jobId = crypto.randomUUID();
  const reviewToken = createToken();
  const reviewTokenHash = await hashToken(reviewToken);
  const createdAt = new Date().toISOString();

  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO submissions (id, source_kind, source_text, review_token_hash, status, created_at, updated_at)
         VALUES (?, 'text', ?, ?, 'submitted', ?, ?)`
      ).bind(submissionId, sourceText, reviewTokenHash, createdAt, createdAt),
      env.DB.prepare(
        `INSERT INTO jobs (id, submission_id, kind, status, attempts, created_at, updated_at)
         VALUES (?, ?, 'extract_profile', 'queued', 0, ?, ?)`
      ).bind(jobId, submissionId, createdAt, createdAt)
    ]);
  } catch {
    let duplicate = false;
    try {
      duplicate = Boolean(await env.DB.prepare('SELECT id FROM submissions WHERE id = ?').bind(submissionId).first());
    } catch {
      duplicate = false;
    }
    return duplicate ? json({ error: duplicateError }, 409) : json({ error: 'submission_storage_unavailable' }, 503);
  }

  return { reviewToken };
}

async function enqueueSubmission(env, submissionId, reviewToken) {
  try {
    await env.SUBMISSION_QUEUE.send({ submissionId });
  } catch {
    await failSubmissionSetup(env, submissionId, 'queue_unavailable');
    return json({ error: 'queue_unavailable' }, 503);
  }

  return json(
    {
      submissionId,
      reviewToken,
      status: 'submitted',
      reviewEndpoint: `/api/reviews/${submissionId}`
    },
    202
  );
}

async function failSubmissionSetup(env, submissionId, errorCode) {
  const failedAt = new Date().toISOString();
  try {
    await env.DB.batch([
      env.DB.prepare("UPDATE submissions SET status = 'failed', updated_at = ? WHERE id = ?").bind(failedAt, submissionId),
      env.DB.prepare("UPDATE jobs SET status = 'failed', error = ?, updated_at = ? WHERE submission_id = ?").bind(
        errorCode,
        failedAt,
        submissionId
      )
    ]);
  } catch {
    return;
  }
}

async function fetchCandidateSource(sourceUrl, apiKey) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), STRING_WEB_ACCESS_LIMITS.timeoutMs);

  try {
    const response = await fetch(STRING_WEB_ACCESS_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ url: sourceUrl, method: 'GET', format: 'json', executeJS: false, solveCaptcha: false }),
      redirect: NO_REDIRECT,
      signal: controller.signal
    });
    if (!response.ok) throw new UrlSubmissionError('url_fetch_failed', 502);

    const responseText = await readLimitedText(response, STRING_WEB_ACCESS_LIMITS.responseBytes);
    let envelope;
    try {
      envelope = JSON.parse(responseText);
    } catch {
      throw new UrlSubmissionError('url_fetch_failed', 502);
    }
    if (!isWebAccessEnvelope(envelope)) throw new UrlSubmissionError('url_fetch_failed', 502);
    if (envelope.statusCode < 200 || envelope.statusCode >= 300) throw new UrlSubmissionError('url_fetch_failed', 502);

    const sourceText = normalizeWebAccessData(envelope.data, envelope.headers);
    if (!sourceText) throw new UrlSubmissionError('url_fetch_failed', 502);
    if (byteLength(sourceText) > MAX_SOURCE_BYTES) throw new UrlSubmissionError('url_source_too_large', 413);
    return sourceText;
  } catch (error) {
    if (error instanceof UrlSubmissionError) throw error;
    if (controller.signal.aborted || error?.name === 'AbortError') throw new UrlSubmissionError('url_fetch_timeout', 504);
    throw new UrlSubmissionError('url_fetch_failed', 502);
  } finally {
    clearTimeout(timeout);
  }
}

async function readLimitedText(response, maxBytes) {
  const contentLength = response.headers.get('content-length');
  if (/^\d+$/.test(contentLength || '') && Number(contentLength) > maxBytes) {
    throw new UrlSubmissionError('url_source_too_large', 413);
  }
  if (!response.body) return '';

  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel();
      throw new UrlSubmissionError('url_source_too_large', 413);
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

// A declared `Content-Length` only short-circuits the read; the streamed body is counted
// independently so a lying or absent header cannot buffer an unbounded request into memory.
async function readLimitedBytes(request, maxBytes, oversized = () => json({ error: 'resume_too_large', maxBytes }, 413)) {
  const contentLength = request.headers.get('content-length');
  if (contentLength && !/^\d+$/.test(contentLength)) return json({ error: 'invalid_content_length' }, 400);
  if (contentLength && Number(contentLength) > maxBytes) return oversized();
  if (!request.body) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel();
      return oversized();
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function isPlainTextContentType(value) {
  return /^text\/plain(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?$/i.test((value || '').trim());
}

function isSafeResumeFilename(value) {
  if (typeof value !== 'string') return false;
  const filename = value.normalize('NFKC').trim();
  if (!filename || byteLength(filename) > MAX_RESUME_FILENAME_BYTES || /[\/\\\u0000-\u001f\u007f]/.test(filename)) return false;
  const stem = filename.slice(0, -4);
  return filename.toLowerCase().endsWith('.txt') && stem.length > 0 && !stem.includes('.') && /^[A-Za-z0-9][A-Za-z0-9 _()-]*$/.test(stem);
}

function decodeResumeText(bytes) {
  if (bytes.byteLength === 0 || hasBlockedFileSignature(bytes)) return null;

  let value;
  try {
    value = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '');
  } catch {
    return null;
  }

  if (!value.trim() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) return null;
  if (/<\/?[a-z][^>\n]{0,200}>/i.test(value) || /<!doctype\s+html\b/i.test(value)) return null;
  return value.trim();
}

function hasBlockedFileSignature(bytes) {
  const signatures = [
    [0x25, 0x50, 0x44, 0x46, 0x2d],
    [0x50, 0x4b, 0x03, 0x04],
    [0x50, 0x4b, 0x05, 0x06],
    [0x50, 0x4b, 0x07, 0x08],
    [0x4d, 0x5a],
    [0x7f, 0x45, 0x4c, 0x46],
    [0x1f, 0x8b],
    [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07],
    [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c],
    [0x89, 0x50, 0x4e, 0x47],
    [0xff, 0xd8, 0xff],
    [0x47, 0x49, 0x46, 0x38],
    [0x00, 0x61, 0x73, 0x6d],
    [0xca, 0xfe, 0xba, 0xbe],
    [0xfe, 0xed, 0xfa, 0xce],
    [0xfe, 0xed, 0xfa, 0xcf],
    [0xce, 0xfa, 0xed, 0xfe],
    [0xcf, 0xfa, 0xed, 0xfe]
  ];
  const leadingBytes = bytes.subarray(0, Math.min(bytes.byteLength, 64));
  return signatures.some((signature) => containsBytes(leadingBytes, signature));
}

function containsBytes(bytes, signature) {
  for (let offset = 0; offset <= bytes.byteLength - signature.length; offset += 1) {
    if (signature.every((value, index) => bytes[offset + index] === value)) return true;
  }
  return false;
}

function isWebAccessEnvelope(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (!Number.isInteger(value.statusCode) || value.statusCode < 100 || value.statusCode > 599) return false;
  if (typeof value.data !== 'string') return false;
  return isHeaderRecord(value.headers);
}

function isHeaderRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.entries(value).every(
    ([name, headerValue]) =>
      name.length > 0 &&
      name.length <= 256 &&
      (typeof headerValue === 'string' ||
        (Array.isArray(headerValue) && headerValue.length <= 50 && headerValue.every((item) => typeof item === 'string')))
  );
}

function normalizeWebAccessData(data, headers) {
  const contentType = headerValue(headers, 'content-type').split(';', 1)[0].trim().toLowerCase();
  if (contentType === 'text/plain') return data.trim();
  if (!['text/html', 'application/xhtml+xml'].includes(contentType)) throw new UrlSubmissionError('url_fetch_failed', 502);

  return decodeHtmlEntities(
    data
      .slice(0, MAX_HTML_SOURCE_CHARS)
      .replace(/<!--[\s\S]{0,20000}?-->/g, ' ')
      .replace(/<(script|style|noscript|template)\b[^>]{0,2000}>[\s\S]{0,20000}?<\/\1>/gi, ' ')
      .replace(
        /<\/?(?:address|article|aside|blockquote|br|div|footer|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|table|tr|ul)\b[^>]{0,2000}>/gi,
        '\n'
      )
      .replace(/<[^>]{0,2000}>/g, ' ')
  )
    .replace(/[\t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

function headerValue(headers, name) {
  const entry = Object.entries(headers).find(([headerName]) => headerName.toLowerCase() === name);
  if (!entry) return '';
  return Array.isArray(entry[1]) ? String(entry[1][0] || '') : entry[1];
}

function decodeHtmlEntities(value) {
  const named = { amp: '&', apos: "'", gt: '>', lt: '<', nbsp: ' ', quot: '"' };
  return value.replace(/&(#(?:x[0-9a-f]+|\d+)|amp|apos|gt|lt|nbsp|quot);/gi, (entity, code) => {
    if (!code.startsWith('#')) return named[code.toLowerCase()];
    const numeric = code[1].toLowerCase() === 'x' ? Number.parseInt(code.slice(2), 16) : Number.parseInt(code.slice(1), 10);
    return Number.isInteger(numeric) && numeric > 0 && numeric <= 0x10ffff ? String.fromCodePoint(numeric) : entity;
  });
}

function validateCandidateSourceUrl(value) {
  if (typeof value !== 'string' || !value.trim() || byteLength(value) > 2_048) return null;

  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    return null;
  }

  const hostname = parsed.hostname.toLowerCase();
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash || parsed.search || parsed.port) return null;
  if (isBlockedNetworkHost(hostname) || !LINKEDIN_PROFILE_HOSTS.has(hostname)) return null;
  const pathMatch = parsed.pathname.match(/^\/in\/([A-Za-z0-9-]{3,100})\/?$/);
  if (!pathMatch) return null;
  return `https://www.linkedin.com/in/${pathMatch[1]}`;
}

function isBlockedNetworkHost(hostname) {
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || hostname.endsWith('.internal')) {
    return true;
  }
  if (hostname === 'metadata.google.internal' || hostname === 'metadata.aws.internal') return true;
  if (hostname.includes(':')) return true;
  const octets = hostname.split('.');
  return octets.length === 4 && octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255);
}

class UrlSubmissionError extends Error {
  constructor(code, status) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

async function getReview(request, env, submissionId) {
  const submission = await authorizeReview(request, env, submissionId);
  if (submission instanceof Response) return submission;

  const draft = await getReviewRevision(env, submissionId);

  return json({ submissionId, status: draft?.status || submission.status, draft: draft ? toReviewDraft(draft) : null });
}

async function updateReview(request, env, submissionId) {
  const submission = await authorizeReview(request, env, submissionId);
  if (submission instanceof Response) return submission;

  const currentDraft = await getReviewRevision(env, submissionId);
  if (!currentDraft || currentDraft.status !== 'review_ready') return json({ error: 'review_not_editable' }, 409);

  const body = await readJson(request, 24_000);
  if (body instanceof Response) return body;
  const draft = validateDraft(body);
  if (!draft) return json({ error: 'invalid_review_draft' }, 400);
  if (sanitizeCandidateDraft(draft).detected) return json({ error: 'sensitive_review_draft' }, 400);

  const updatedAt = new Date().toISOString();
  const updateResult = await env.DB.prepare(
    `UPDATE profile_revisions
        SET name = ?, role = ?, summary = ?, location = ?, work_mode = ?, availability = ?,
            universities_json = ?, companies_json = ?, skills_json = ?, date_ranges_json = ?, updated_at = ?
      WHERE submission_id = ? AND status = 'review_ready'`
  )
    .bind(
      draft.name,
      draft.role,
      draft.summary,
      draft.location,
      draft.workMode,
      draft.availability,
      JSON.stringify(draft.universities),
      JSON.stringify(draft.companies),
      JSON.stringify(draft.skills),
      JSON.stringify(draft.dateRanges),
      updatedAt,
      submissionId
    )
    .run();

  if (changedRows(updateResult) === 0) return json({ error: 'review_not_editable' }, 409);

  const saved = await getReviewRevision(env, submissionId);

  return json({ submissionId, status: saved.status, draft: toReviewDraft(saved) });
}

async function decideReview(request, env, submissionId) {
  const submission = await authorizeReview(request, env, submissionId);
  if (submission instanceof Response) return submission;

  const body = await readJson(request, 24_000);
  if (body instanceof Response) return body;
  if (!['publish', 'refuse'].includes(body?.decision)) return json({ error: 'invalid_review_decision' }, 400);

  const revision = await getReviewRevision(env, submissionId);
  if (!revision) return json({ error: 'review_not_ready' }, 409);

  if (body.decision === 'publish') return publishReview(env, submissionId, revision, body.draft);
  return refuseReview(env, submissionId, revision);
}

async function publishReview(env, submissionId, revision, draftValue) {
  if (revision.status === 'published') return reviewDecisionResponse(submissionId, revision, true);
  if (revision.status === 'archived') return json({ error: 'review_withdrawn' }, 409);
  if (revision.status !== 'review_ready') return json({ error: 'invalid_review_transition' }, 409);

  const approvedDraft = validateDraft(draftValue);
  if (!approvedDraft) return json({ error: 'approved_draft_required' }, 400);
  if (sanitizeCandidateDraft(approvedDraft).detected) return json({ error: 'sensitive_review_draft' }, 400);

  const publishedAt = new Date().toISOString();
  const updateResult = await env.DB.prepare(
    `UPDATE profile_revisions
        SET status = 'published', name = ?, role = ?, summary = ?, location = ?, work_mode = ?, availability = ?,
            universities_json = ?, companies_json = ?, skills_json = ?, date_ranges_json = ?, published_at = ?, updated_at = ?
      WHERE submission_id = ? AND status = 'review_ready'`
  )
    .bind(
      approvedDraft.name,
      approvedDraft.role,
      approvedDraft.summary,
      approvedDraft.location,
      approvedDraft.workMode,
      approvedDraft.availability,
      JSON.stringify(approvedDraft.universities),
      JSON.stringify(approvedDraft.companies),
      JSON.stringify(approvedDraft.skills),
      JSON.stringify(approvedDraft.dateRanges),
      publishedAt,
      publishedAt,
      submissionId
    )
    .run();

  if (changedRows(updateResult) === 0) return resolvePublishRetry(env, submissionId);
  return reviewDecisionResponse(submissionId, await getReviewRevision(env, submissionId), false);
}

async function refuseReview(env, submissionId, revision) {
  if (revision.status === 'archived') return reviewDecisionResponse(submissionId, revision, true);
  if (!['review_ready', 'published'].includes(revision.status)) return json({ error: 'invalid_review_transition' }, 409);

  const updatedAt = new Date().toISOString();
  const updateResult = await env.DB.prepare(
    `UPDATE profile_revisions
        SET status = 'archived', published_at = NULL, updated_at = ?
      WHERE submission_id = ? AND status IN ('review_ready', 'published')`
  )
    .bind(updatedAt, submissionId)
    .run();

  if (changedRows(updateResult) === 0) {
    const current = await getReviewRevision(env, submissionId);
    if (current?.status === 'archived') return reviewDecisionResponse(submissionId, current, true);
    return json({ error: 'invalid_review_transition' }, 409);
  }

  return reviewDecisionResponse(submissionId, await getReviewRevision(env, submissionId), false);
}

async function resolvePublishRetry(env, submissionId) {
  const current = await getReviewRevision(env, submissionId);
  if (current?.status === 'published') return reviewDecisionResponse(submissionId, current, true);
  if (current?.status === 'archived') return json({ error: 'review_withdrawn' }, 409);
  return json({ error: 'invalid_review_transition' }, 409);
}

function reviewDecisionResponse(submissionId, revision, idempotent) {
  return json({
    submissionId,
    status: revision.status,
    idempotent,
    publishedAt: revision.published_at || null,
    candidate: revision.status === 'published' ? toPublicCandidate(revision) : null
  });
}

async function getReviewRevision(env, submissionId) {
  return env.DB.prepare(
    `SELECT id, status, name, role, summary, location, work_mode, availability,
            universities_json, companies_json, skills_json, date_ranges_json, updated_at, published_at
       FROM profile_revisions
      WHERE submission_id = ?`
  ).bind(submissionId).first();
}

async function listPublishedCandidates(request, env) {
  if (!env.DB) return json({ error: 'service_not_configured' }, 503);
  const edge = await consumeEdgeQuota(env, `candidates:${await clientKey(env, request)}`);
  if (edge) return edge;

  const offset = clampCandidateOffset(new URL(request.url).searchParams.get('offset'));
  const limit = Math.min(CANDIDATES_PAGE_SIZE, MAX_PUBLIC_CANDIDATES - offset);
  if (limit <= 0) return json({ candidates: [], nextOffset: null });

  let result;
  try {
    result = await env.DB.prepare(
      `SELECT r.id, r.name, r.role, r.summary, r.location, r.work_mode, r.availability,
              r.universities_json, r.companies_json, r.skills_json, r.date_ranges_json, r.published_at,
              i.hn_permalink, i.thread_month
         FROM profile_revisions r
         LEFT JOIN hn_ingests i ON i.submission_id = r.submission_id
        WHERE r.status = 'published' AND i.suppressed_at IS NULL
        ORDER BY r.published_at DESC, r.id
        LIMIT ? OFFSET ?`
    ).bind(limit, offset).all();
  } catch {
    return json({ error: 'submission_storage_unavailable' }, 503);
  }

  const nextOffset = result.results.length === limit && offset + limit < MAX_PUBLIC_CANDIDATES ? offset + limit : null;
  return json({ candidates: result.results.map(toPublicCandidate), nextOffset });
}

function clampCandidateOffset(raw) {
  const parsed = Number.parseInt(raw ?? '', 10);
  if (!Number.isInteger(parsed) || parsed < 0) return 0;
  return Math.min(parsed, MAX_PUBLIC_CANDIDATES);
}

// Deliberately unauthenticated. A profile built from a Hacker News comment is published without
// the subject ever asking, so they never receive the management token every other write path
// requires -- gating removal behind it would leave them with no way out at all. The asymmetry is
// intentional: a wrongful removal hides one public post from one directory and an operator can
// restore it, while a wrongful retention keeps someone listed against their wishes.
async function requestCandidateRemoval(request, env, candidateId) {
  const limited = await enforceQuota(env, 'removalRequest', await clientKey(env, request));
  if (limited) return limited;

  let row;
  try {
    row = await env.DB.prepare(
      `SELECT r.id, r.submission_id, r.status, i.hn_item_id, i.suppressed_at
         FROM profile_revisions r
         LEFT JOIN hn_ingests i ON i.submission_id = r.submission_id
        WHERE r.id = ?`
    )
      .bind(candidateId)
      .first();
  } catch {
    return json({ error: 'submission_storage_unavailable' }, 503);
  }

  if (!row) return json({ error: 'candidate_not_found' }, 404);
  if (!row.hn_item_id) return json({ error: 'token_managed_candidate' }, 409);
  if (row.suppressed_at || row.status === 'archived') return json({ removed: true });

  const removedAt = new Date().toISOString();
  try {
    await env.DB.batch([
      env.DB.prepare('UPDATE hn_ingests SET suppressed_at = ?, updated_at = ? WHERE submission_id = ?').bind(
        removedAt,
        removedAt,
        row.submission_id
      ),
      env.DB.prepare(
        "UPDATE profile_revisions SET status = 'archived', published_at = NULL, updated_at = ? WHERE id = ?"
      ).bind(removedAt, row.id)
    ]);
  } catch {
    return json({ error: 'submission_storage_unavailable' }, 503);
  }

  return json({ removed: true });
}

async function manageCandidate(request, env, candidateId) {
  const management = await authorizeCandidateManagement(request, env, candidateId);
  if (management instanceof Response) return management;

  const body = await readJson(request, 4_096);
  if (body instanceof Response) return body;
  if (!['update', 'remove'].includes(body?.action)) return json({ error: 'invalid_management_action' }, 400);

  if (body.action === 'update') return startCandidateUpdate(env, management);
  return removeCandidate(env, management);
}

async function startCandidateUpdate(env, management) {
  if (management.status === 'review_ready') return managementResponse(management, 'update', true);
  if (management.status === 'archived') return json({ error: 'candidate_archived' }, 409);
  if (management.status !== 'published') return json({ error: 'invalid_management_transition' }, 409);

  const updatedAt = new Date().toISOString();
  const updateResult = await env.DB.prepare(
    `UPDATE profile_revisions
        SET status = 'review_ready', published_at = NULL, updated_at = ?
      WHERE id = ? AND submission_id = ? AND status = 'published'`
  )
    .bind(updatedAt, management.candidate_id, management.submission_id)
    .run();

  if (changedRows(updateResult) > 0) {
    return managementResponse({ ...management, status: 'review_ready' }, 'update', false);
  }

  const current = await getCandidateManagementRecord(env, management.candidate_id);
  if (current?.submission_id !== management.submission_id) return json({ error: 'invalid_management_transition' }, 409);
  if (current.status === 'review_ready') return managementResponse(current, 'update', true);
  if (current.status === 'archived') return json({ error: 'candidate_archived' }, 409);
  return json({ error: 'invalid_management_transition' }, 409);
}

async function removeCandidate(env, management) {
  if (management.status === 'archived') return managementResponse(management, 'remove', true);
  if (!['published', 'review_ready'].includes(management.status)) return json({ error: 'invalid_management_transition' }, 409);

  const updatedAt = new Date().toISOString();
  const updateResult = await env.DB.prepare(
    `UPDATE profile_revisions
        SET status = 'archived', published_at = NULL, updated_at = ?
      WHERE id = ? AND submission_id = ? AND status IN ('published', 'review_ready')`
  )
    .bind(updatedAt, management.candidate_id, management.submission_id)
    .run();

  if (changedRows(updateResult) > 0) {
    return managementResponse({ ...management, status: 'archived' }, 'remove', false);
  }

  const current = await getCandidateManagementRecord(env, management.candidate_id);
  if (current?.submission_id === management.submission_id && current.status === 'archived') {
    return managementResponse(current, 'remove', true);
  }
  return json({ error: 'invalid_management_transition' }, 409);
}

function managementResponse(management, action, idempotent) {
  const reviewReady = management.status === 'review_ready';
  return json({
    action,
    candidateId: management.candidate_id,
    submissionId: management.submission_id,
    status: management.status,
    idempotent,
    visibility: reviewReady ? 'hidden_during_review' : 'not_searchable',
    reviewEndpoint: reviewReady ? `/api/reviews/${management.submission_id}` : null,
    decisionEndpoint: reviewReady ? `/api/reviews/${management.submission_id}/decision` : null
  });
}

async function processSubmissionMessage(message, env) {
  const submissionId = message.body?.submissionId;
  if (typeof submissionId !== 'string') {
    message.ack?.();
    return;
  }

  try {
    const submission = await env.DB.prepare('SELECT source_text, status FROM submissions WHERE id = ?').bind(submissionId).first();
    if (!submission) throw new Error('submission_not_found');
    if (submission.status === 'review_ready') {
      message.ack?.();
      return;
    }

    const processingAt = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare("UPDATE submissions SET status = 'processing', updated_at = ? WHERE id = ? AND status != 'review_ready'").bind(processingAt, submissionId),
      env.DB.prepare("UPDATE jobs SET status = 'processing', attempts = attempts + 1, updated_at = ? WHERE submission_id = ?").bind(processingAt, submissionId)
    ]);

    const draft = extractProfile(submission.source_text);
    const revisionId = crypto.randomUUID();
    const completedAt = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO profile_revisions (
           id, submission_id, status, name, role, summary, location, work_mode, availability,
           universities_json, companies_json, skills_json, date_ranges_json, created_at, updated_at
         ) VALUES (?, ?, 'review_ready', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(submission_id) DO UPDATE SET
           name = excluded.name, role = excluded.role, summary = excluded.summary,
           location = excluded.location, work_mode = excluded.work_mode, availability = excluded.availability,
           universities_json = excluded.universities_json, companies_json = excluded.companies_json,
           skills_json = excluded.skills_json, date_ranges_json = excluded.date_ranges_json,
           updated_at = excluded.updated_at`
      ).bind(
        revisionId,
        submissionId,
        draft.name,
        draft.role,
        draft.summary,
        draft.location,
        draft.workMode,
        draft.availability,
        JSON.stringify(draft.universities),
        JSON.stringify(draft.companies),
        JSON.stringify(draft.skills),
        JSON.stringify(draft.dateRanges),
        completedAt,
        completedAt
      ),
      env.DB.prepare("UPDATE submissions SET status = 'review_ready', source_text = '', updated_at = ? WHERE id = ?").bind(completedAt, submissionId),
      env.DB.prepare("UPDATE jobs SET status = 'completed', error = NULL, updated_at = ? WHERE submission_id = ?").bind(completedAt, submissionId)
    ]);
    message.ack?.();
  } catch {
    const failedAt = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare("UPDATE submissions SET status = 'failed', updated_at = ? WHERE id = ?").bind(failedAt, submissionId),
      env.DB.prepare("UPDATE jobs SET status = 'failed', error = 'extraction_failed', updated_at = ? WHERE submission_id = ?").bind(failedAt, submissionId)
    ]);
    message.retry?.();
  }
}

async function runHackerNewsIngest(request, env) {
  if (!env.DB || !env.SUBMISSION_QUEUE) return json({ error: 'service_not_configured' }, 503);

  const quota = await enforceQuota(env, 'ingestRequest', await clientKey(env, request));
  if (quota) return quota;
  if (!isUsableIngestToken(env.HN_INGEST_TOKEN)) return json({ error: 'ingest_not_configured' }, 503);

  const token = bearerToken(request);
  if (!token) return denyAuthorization(request, env, json({ error: 'ingest_token_required' }, 401));
  if (!constantTimeEqual(await hashToken(token), await hashToken(env.HN_INGEST_TOKEN))) {
    return denyAuthorization(request, env, json({ error: 'ingest_token_invalid' }, 403));
  }

  if (!(await reserveIngestRun(env))) return json({ error: 'ingest_in_progress' }, 429);

  try {
    return json(await ingestHackerNews(env), 202);
  } catch (error) {
    // This endpoint is reachable only with the ingest secret, so its caller is an operator who is
    // already entitled to the reason. Reading it requires a live tail, which needs credentials the
    // operator triggering an ingest may not have, so the answer travels back in the response too.
    return json({ error: 'ingest_failed', reason: logIngestFailure('request', error) }, 502);
  }
}

// An unset, blank, or short secret must never degrade into an open endpoint, and a value too
// short to resist guessing is no better than none.
function isUsableIngestToken(value) {
  return typeof value === 'string' && value.trim().length >= HN_INGEST_TOKEN_MIN_LENGTH;
}

async function ingestHackerNews(env, options = {}) {
  if (!env.DB || !env.SUBMISSION_QUEUE) return { threads: 0, queued: 0, skipped: 0 };

  const transport = options.transport || fetchHnJson;
  const threads = (await discoverHnThreads(transport)).slice(0, options.threads || HN_INGEST_LIMITS.threads);
  const results = await Promise.all(threads.map((thread) => queueHnThread(env, transport, thread)));

  return {
    threads: threads.length,
    queued: results.reduce((total, result) => total + result.queued, 0),
    skipped: results.reduce((total, result) => total + result.skipped, 0)
  };
}

async function previewHackerNewsIngest(options = {}) {
  const transport = options.transport || fetchHnJson;
  const extractor = options.extractor || DETERMINISTIC_HN_EXTRACTOR;
  const threads = (await discoverHnThreads(transport)).slice(0, options.threads || 1);

  return Promise.all(
    threads.map(async (thread) => {
      const comments = await fetchHnThreadComments(transport, thread.id);
      const records = (await Promise.all(comments.map((hit) => toHnRecord(thread, hit)))).filter(Boolean);
      const drafts = records.map((record) => extractor.extract(record)).filter(Boolean);
      return { threadId: thread.id, threadMonth: thread.month, comments: comments.length, extracted: drafts.length, drafts };
    })
  );
}

// Discovery must use the date-sorted index. Algolia's `/search` ranks by relevance, and the
// relevance window is dominated by older, heavily-engaged threads: at any candidate count short of
// the full corpus it omits the current month entirely, so the directory would publish a year-old
// cohort as its live listing.
async function discoverHnThreads(transport) {
  const payload = await transport(
    hnSearchUrl({ ...HN_THREAD_QUERY, hitsPerPage: HN_INGEST_LIMITS.threadCandidates }, HN_ALGOLIA_RECENT_ENDPOINT)
  );

  return (payload?.hits || [])
    .filter((hit) => /who wants to be hired/i.test(String(hit?.title || '')))
    .map((hit) => ({ id: String(hit?.objectID ?? ''), month: monthOf(hit?.created_at), createdAt: String(hit?.created_at || '') }))
    .filter((thread) => isHnItemId(thread.id) && thread.month)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

async function queueHnThread(env, transport, thread) {
  const known = await loadHnThreadState(env, thread.id);
  const comments = await fetchHnThreadComments(transport, thread.id);
  const records = (await Promise.all(comments.map((hit) => toHnRecord(thread, hit)))).filter(Boolean);
  const pending = records.filter((record) => {
    const state = known.get(record.itemId);
    return !state?.suppressed_at && state?.comment_hash !== record.commentHash;
  });

  await sendHnMessages(env, pending);

  return { queued: pending.length, skipped: records.length - pending.length };
}

async function fetchHnThreadComments(transport, threadId) {
  const hits = [];
  for (let page = 0; page < HN_INGEST_LIMITS.commentPages; page += 1) {
    const payload = await transport(
      hnSearchUrl({ tags: `comment,story_${threadId}`, hitsPerPage: HN_INGEST_LIMITS.pageSize, page })
    );
    const pageHits = payload?.hits || [];
    hits.push(...pageHits);
    if (pageHits.length < HN_INGEST_LIMITS.pageSize) break;
    if (Number.isInteger(payload?.nbPages) && page + 1 >= payload.nbPages) break;
  }
  return hits;
}

async function sendHnMessages(env, records) {
  for (let start = 0; start < records.length; start += HN_INGEST_LIMITS.queueBatch) {
    const group = records.slice(start, start + HN_INGEST_LIMITS.queueBatch).map((record) => ({ hnComment: record.comment }));
    if (typeof env.SUBMISSION_QUEUE.sendBatch === 'function') {
      await env.SUBMISSION_QUEUE.sendBatch(group.map((body) => ({ body })));
      continue;
    }
    await Promise.all(group.map((body) => env.SUBMISSION_QUEUE.send(body)));
  }
}

async function loadHnThreadState(env, threadId) {
  const result = await env.DB.prepare(
    'SELECT hn_item_id, comment_hash, suppressed_at FROM hn_ingests WHERE thread_id = ?'
  )
    .bind(threadId)
    .all();

  return new Map((result?.results || []).map((row) => [row.hn_item_id, row]));
}

async function processHnCommentMessage(message, env) {
  try {
    await ingestHnComment(env, message.body.hnComment);
    message.ack?.();
  } catch (error) {
    logIngestFailure('queue', error);
    message.retry?.();
  }
}

async function ingestHnComment(env, comment, extractor = DETERMINISTIC_HN_EXTRACTOR) {
  const record = await toHnRecord(null, comment);
  if (!record) return 'skipped_invalid';

  const existing = await env.DB.prepare(
    'SELECT submission_id, comment_hash, suppressed_at FROM hn_ingests WHERE hn_item_id = ?'
  )
    .bind(record.itemId)
    .first();
  if (existing?.suppressed_at) return 'skipped_suppressed';
  if (existing && existing.comment_hash === record.commentHash) return 'unchanged';

  const draft = extractor.extract(record);
  const submissionId = existing?.submission_id || (draft ? `hn-${record.itemId}` : null);
  const ingestedAt = new Date().toISOString();
  const profileStatements = draft ? await hnProfileStatements(env, submissionId, record, draft, ingestedAt) : [];

  await env.DB.batch([...profileStatements, hnIngestStatement(env, record, submissionId, ingestedAt)]);

  if (!draft) return 'skipped_unstructured';
  return existing ? 'updated' : 'created';
}

async function hnProfileStatements(env, submissionId, record, draft, ingestedAt) {
  const reviewTokenHash = await hashToken(createToken());

  return [
    env.DB.prepare(
      `INSERT INTO submissions (id, source_kind, source_text, review_token_hash, status, created_at, updated_at)
       VALUES (?, 'hn_comment', '', ?, 'ingested', ?, ?)
       ON CONFLICT(id) DO UPDATE SET status = 'ingested', updated_at = excluded.updated_at`
    ).bind(submissionId, reviewTokenHash, ingestedAt, ingestedAt),
    env.DB.prepare(
      `INSERT INTO profile_revisions (
         id, submission_id, status, name, role, summary, location, work_mode, availability,
         universities_json, companies_json, skills_json, date_ranges_json, created_at, updated_at, published_at
       ) VALUES (?, ?, 'published', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(submission_id) DO UPDATE SET
         name = excluded.name, role = excluded.role, summary = excluded.summary,
         location = excluded.location, work_mode = excluded.work_mode, availability = excluded.availability,
         universities_json = excluded.universities_json, companies_json = excluded.companies_json,
         skills_json = excluded.skills_json, date_ranges_json = excluded.date_ranges_json,
         updated_at = excluded.updated_at
       WHERE profile_revisions.status = 'published'`
    ).bind(
      crypto.randomUUID(),
      submissionId,
      draft.name,
      draft.role,
      draft.summary,
      draft.location,
      draft.workMode,
      draft.availability,
      JSON.stringify(draft.universities),
      JSON.stringify(draft.companies),
      JSON.stringify(draft.skills),
      JSON.stringify(draft.dateRanges),
      ingestedAt,
      ingestedAt,
      record.createdAt
    )
  ];
}

// An unextractable comment still earns an ingest row. Without the recorded hash, every run would
// re-queue the same unparsable thread noise forever.
function hnIngestStatement(env, record, submissionId, ingestedAt) {
  return env.DB.prepare(
    `INSERT INTO hn_ingests (
       hn_item_id, submission_id, hn_author, hn_permalink, thread_id, thread_month,
       comment_hash, comment_created_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(hn_item_id) DO UPDATE SET
       submission_id = excluded.submission_id, hn_author = excluded.hn_author,
       hn_permalink = excluded.hn_permalink, thread_id = excluded.thread_id,
       thread_month = excluded.thread_month, comment_hash = excluded.comment_hash,
       updated_at = excluded.updated_at
     WHERE hn_ingests.suppressed_at IS NULL`
  ).bind(
    record.itemId,
    submissionId,
    record.author,
    record.permalink,
    record.threadId,
    record.threadMonth,
    record.commentHash,
    record.createdAt,
    ingestedAt,
    ingestedAt
  );
}

async function toHnRecord(thread, hit) {
  const itemId = String(hit?.objectID ?? hit?.itemId ?? '').trim();
  if (!isHnItemId(itemId)) return null;
  if (thread && String(hit?.parent_id ?? '') !== thread.id) return null;

  const commentHtml = String(hit?.comment_text ?? hit?.commentText ?? '').slice(0, HN_INGEST_LIMITS.commentChars);
  const text = decodeHnCommentText(commentHtml);
  if (!text) return null;

  const createdAt = hnTimestamp(hit?.created_at ?? hit?.createdAt);
  if (!createdAt) return null;
  const threadId = thread ? thread.id : String(hit?.threadId ?? '');
  if (!isHnItemId(threadId)) return null;

  const comment = {
    itemId,
    author: hnAuthor(hit?.author),
    commentText: commentHtml,
    createdAt,
    threadId,
    threadMonth: thread ? thread.month : monthOf(hit?.threadMonth) || String(hit?.threadMonth ?? '')
  };
  if (!/^\d{4}-\d{2}$/.test(comment.threadMonth)) return null;

  return {
    ...comment,
    comment,
    text,
    permalink: `https://news.ycombinator.com/item?id=${itemId}`,
    commentHash: await hashToken(text)
  };
}

const DETERMINISTIC_HN_EXTRACTOR = Object.freeze({
  id: 'deterministic-labels-v1',
  extract: (record) => extractHnProfile(record)
});

function extractHnProfile(record) {
  const entries = record.text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^([^:]{2,32}):\s*(.*)$/);
      return { line, label: match ? normalizeHnLabel(match[1]) : '', value: match ? match[2].trim() : '' };
    });

  const labeled = new Map();
  entries.filter((entry) => entry.label && entry.value).forEach((entry) => {
    if (!labeled.has(entry.label)) labeled.set(entry.label, entry.value);
  });
  const valueFor = (labels) => labels.map((label) => labeled.get(label)).find(Boolean) || '';
  const listFor = (labels) => splitList(valueFor(labels));

  const location = valueFor(HN_LOCATION_LABELS);
  const skills = listFor(HN_SKILL_LABELS);
  const role = valueFor(HN_ROLE_LABELS);
  const leftovers = entries.filter((entry) => !entry.label || !HN_MAPPED_LABELS.has(entry.label) || !labeled.has(entry.label));
  const prose = leftovers.map((entry) => entry.line);
  if (!location && !skills.length && !role && prose.join(' ').length < HN_INGEST_LIMITS.minProseChars) return null;

  const separator = prose.some((line) => /^[^:]{2,32}:\s/.test(line)) ? ' · ' : ' ';
  const dateRanges = [...record.text.matchAll(/\b(?:19|20)\d{2}\s*(?:-|–|—|to)\s*(?:(?:19|20)\d{2}|present|current)\b/gi)].map(
    (match) => match[0]
  );
  const openingLine = prose.find((line) => !/^[^:]{2,32}:\s/.test(line)) || '';
  const title = role || hnTitleFromOpeningLine(openingLine);

  return boundedDraft(sanitizeCandidateDraft({
    name: (valueFor(HN_NAME_LABELS) || record.author || HN_UNKNOWN).slice(0, 200),
    role: title.slice(0, 300),
    summary: prose.join(separator).slice(0, 1_500) || HN_UNKNOWN,
    location: (location || HN_UNKNOWN).slice(0, 300),
    workMode: hnWorkMode(valueFor(HN_REMOTE_LABELS), record.text),
    availability: valueFor(HN_AVAILABILITY_LABELS).slice(0, 100) || HN_UNKNOWN,
    universities: listFor(HN_UNIVERSITY_LABELS),
    companies: listFor(HN_COMPANY_LABELS),
    skills,
    dateRanges: unique(dateRanges).slice(0, 20)
  }).draft);
}

function hnTitleFromOpeningLine(line) {
  const sentence = HN_TITLE_SENTENCE_PATTERN.exec(line);
  if (sentence) return sentence[1].trim();
  return line.length <= HN_TITLE_MAX_CHARS ? line : '';
}

function hnWorkMode(remoteValue, sourceText) {
  if (/^(yes|yes\b.*|remote|remote only|only remote|preferred|strongly preferred)$/i.test(remoteValue)) return 'Remote';
  if (/^(no|no\b.*|onsite|on-site|office|not preferred)$/i.test(remoteValue)) return 'On-site';
  if (remoteValue) return remoteValue.slice(0, 100);
  if (/\bremote\b/i.test(sourceText)) return 'Remote';
  return HN_UNKNOWN;
}

function normalizeHnLabel(label) {
  return label
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[\s/]+/g, ' ')
    .trim();
}

// Every quantifier here is bounded: the comment body is attacker-authored, so an unbounded lazy
// scan across repeated openers would let one post stall the queue consumer.
function decodeHnCommentText(html) {
  return decodeHtmlEntities(
    html
      .slice(0, HN_INGEST_LIMITS.commentChars)
      .replace(/<a\b[^>]{0,512}\bhref\s*=\s*"([^"]{0,2048})"[^>]{0,512}>[\s\S]{0,4096}?<\/a>/gi, ' $1 ')
      .replace(/<\/?(?:p|br|div|li|ul|ol|pre|blockquote)\b[^>]{0,512}>/gi, '\n')
      .replace(/<[^>]{0,2048}>/g, '')
  )
    .replace(/\r/g, '')
    .replace(/[\t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

function hnAuthor(value) {
  const author = String(value ?? '').trim();
  return /^[A-Za-z0-9_-]{2,32}$/.test(author) ? author : '';
}

function hnTimestamp(value) {
  const parsed = Date.parse(String(value ?? ''));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : '';
}

function monthOf(value) {
  return hnTimestamp(value).slice(0, 7);
}

function isHnItemId(value) {
  return /^\d{1,20}$/.test(value);
}

function hnSearchUrl(parameters, endpoint = HN_ALGOLIA_ENDPOINT) {
  const url = new URL(endpoint);
  Object.entries(parameters).forEach(([name, value]) => url.searchParams.set(name, String(value)));
  return url.href;
}

async function fetchHnJson(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HN_INGEST_LIMITS.timeoutMs);
  try {
    const response = await fetch(url, { method: 'GET', headers: { accept: 'application/json' }, redirect: NO_REDIRECT, signal: controller.signal });
    if (!response.ok) throw new Error('hn_fetch_failed');
    return JSON.parse(await readLimitedText(response, HN_INGEST_LIMITS.responseBytes));
  } finally {
    clearTimeout(timeout);
  }
}

// A missing record and a wrong token answer identically. Submission ids for URL and resume
// submissions are derived from their content, so a distinguishable 404 would tell any caller
// whether a given LinkedIn profile or resume had ever been submitted.
async function authorizeReview(request, env, submissionId) {
  if (!env.DB) return json({ error: 'service_not_configured' }, 503);
  const token = bearerToken(request);
  if (!token) return denyAuthorization(request, env, json({ error: 'review_token_required' }, 401));

  let submission;
  try {
    submission = await env.DB.prepare('SELECT id, review_token_hash, status FROM submissions WHERE id = ?').bind(submissionId).first();
  } catch {
    return json({ error: 'submission_storage_unavailable' }, 503);
  }

  const tokenHash = await hashToken(token);
  if (!constantTimeEqual(tokenHash, submission?.review_token_hash ?? unmatchableHash())) {
    return denyAuthorization(request, env, json({ error: 'review_token_invalid' }, 403));
  }
  return submission;
}

async function authorizeCandidateManagement(request, env, candidateId) {
  if (!env.DB) return json({ error: 'service_not_configured' }, 503);
  const token = bearerToken(request);
  if (!token) return denyAuthorization(request, env, json({ error: 'management_token_required' }, 401));

  let management;
  try {
    management = await getCandidateManagementRecord(env, candidateId);
  } catch {
    return json({ error: 'submission_storage_unavailable' }, 503);
  }

  const tokenHash = await hashToken(token);
  if (!constantTimeEqual(tokenHash, management?.review_token_hash ?? unmatchableHash())) {
    return denyAuthorization(request, env, json({ error: 'management_token_invalid' }, 403));
  }
  return management;
}

function bearerToken(request) {
  const authorization = request.headers.get('authorization') || '';
  if (!/^Bearer /.test(authorization)) return '';
  const token = authorization.slice(7).trim();
  return token && token.length <= MAX_BEARER_TOKEN_CHARS ? token : '';
}

// Workers forbid random generation during module evaluation, so the comparison decoy is
// materialized on first use and kept for the isolate's lifetime.
let absentTokenHash = '';
function unmatchableHash() {
  if (!absentTokenHash) {
    absentTokenHash = [...crypto.getRandomValues(new Uint8Array(32))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  return absentTokenHash;
}

async function getCandidateManagementRecord(env, candidateId) {
  return env.DB.prepare(
    `SELECT r.id AS candidate_id, r.submission_id, r.status, s.review_token_hash
       FROM profile_revisions r
       JOIN submissions s ON s.id = r.submission_id
      WHERE r.id = ?`
  )
    .bind(candidateId)
    .first();
}

function extractProfile(sourceText) {
  const lines = sourceText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const labeled = Object.fromEntries(
    lines
      .map((line) => line.match(/^([^:]{2,30}):\s*(.+)$/))
      .filter(Boolean)
      .map((match) => [match[1].toLowerCase(), match[2].trim()])
  );
  const valueFor = (...labels) => labels.map((label) => labeled[label]).find(Boolean) || '';
  const listFor = (...labels) => splitList(valueFor(...labels));
  const dateRanges = [...sourceText.matchAll(/\b(?:19|20)\d{2}\s*(?:-|–|—|to)\s*(?:(?:19|20)\d{2}|present|current)\b/gi)].map((match) => match[0]);

  return boundedDraft(sanitizeCandidateDraft({
    name: valueFor('name') || 'Name needs review',
    role: valueFor('role', 'title') || lines[0] || 'Role needs review',
    summary: valueFor('summary', 'about') || lines.slice(0, 3).join(' ').slice(0, 1_500),
    location: valueFor('location') || 'Location needs review',
    workMode: valueFor('work mode', 'work-mode', 'mode') || (/\bremote\b/i.test(sourceText) ? 'Remote' : 'Needs review'),
    availability: valueFor('availability') || 'Needs review',
    universities: listFor('universities', 'university', 'education', 'school', 'schools'),
    companies: listFor('companies', 'company', 'previously', 'experience', 'employers'),
    skills: listFor('skills', 'technologies', 'technology', 'stack'),
    dateRanges: unique(dateRanges).slice(0, 20)
  }).draft);
}

function validateDraft(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const text = (key, maxLength) => {
    if (typeof value[key] !== 'string') return null;
    const normalized = normalizeStoredText(value[key]);
    return normalized.length <= maxLength ? normalized : null;
  };
  const list = (key) => {
    if (!Array.isArray(value[key]) || value[key].length > 50) return null;
    const items = value[key].map((item) => (typeof item === 'string' ? normalizeStoredText(item) : '')).filter(Boolean);
    return items.every((item) => item.length <= DRAFT_FIELD_LIMITS.listItem) ? unique(items) : null;
  };
  const draft = {
    name: text('name', DRAFT_FIELD_LIMITS.name),
    role: text('role', DRAFT_FIELD_LIMITS.role),
    summary: text('summary', DRAFT_FIELD_LIMITS.summary),
    location: text('location', DRAFT_FIELD_LIMITS.location),
    workMode: text('workMode', DRAFT_FIELD_LIMITS.workMode),
    availability: text('availability', DRAFT_FIELD_LIMITS.availability),
    universities: list('universities'),
    companies: list('companies'),
    skills: list('skills'),
    dateRanges: list('dateRanges')
  };
  return Object.values(draft).some((field) => field === null) ? null : draft;
}

// Bidi overrides and zero-width characters survive escaping and reorder or hide text in every consumer.
function normalizeStoredText(value, maxChars = Number.MAX_SAFE_INTEGER) {
  return value
    .normalize('NFC')
    .replace(INVISIBLE_TEXT_PATTERN, '')
    .replace(/[\t\f\v ]+/g, ' ')
    .trim()
    .slice(0, maxChars);
}

function boundedDraft(draft) {
  return {
    ...draft,
    name: normalizeStoredText(draft.name, DRAFT_FIELD_LIMITS.name),
    role: normalizeStoredText(draft.role, DRAFT_FIELD_LIMITS.role),
    summary: normalizeStoredText(draft.summary, DRAFT_FIELD_LIMITS.summary),
    location: normalizeStoredText(draft.location, DRAFT_FIELD_LIMITS.location),
    workMode: normalizeStoredText(draft.workMode, DRAFT_FIELD_LIMITS.workMode),
    availability: normalizeStoredText(draft.availability, DRAFT_FIELD_LIMITS.availability),
    universities: boundedList(draft.universities),
    companies: boundedList(draft.companies),
    skills: boundedList(draft.skills),
    dateRanges: boundedList(draft.dateRanges)
  };
}

function boundedList(items) {
  return unique(items.map((item) => normalizeStoredText(item, DRAFT_FIELD_LIMITS.listItem)).filter(Boolean)).slice(0, 50);
}

function toReviewDraft(row) {
  const sanitized = candidateDraftFromRow(row);
  return {
    id: row.id,
    status: row.status,
    ...sanitized,
    updatedAt: row.updated_at
  };
}

function toPublicCandidate(row) {
  const sanitized = candidateDraftFromRow(row);
  const fromHackerNews = Boolean(row.hn_permalink);
  return {
    id: row.id,
    name: sanitized.name,
    role: sanitized.role,
    summary: sanitized.summary,
    location: sanitized.location,
    mode: sanitized.workMode,
    availability: sanitized.availability,
    university: sanitized.universities[0] || HN_UNKNOWN,
    universities: sanitized.universities,
    companies: sanitized.companies,
    skills: sanitized.skills,
    dateRanges: sanitized.dateRanges,
    source: fromHackerNews ? `HN · ${monthLabel(row.thread_month)}` : 'Candidate submitted',
    sourceUrl: fromHackerNews ? row.hn_permalink : '',
    posted: daysSince(row.published_at),
    publishedAt: row.published_at
  };
}

function monthLabel(threadMonth) {
  const match = /^(\d{4})-(\d{2})$/.exec(threadMonth || '');
  if (!match) return 'Hacker News';
  const month = HN_MONTHS[Number(match[2]) - 1];
  return month ? `${month} ${match[1]}` : 'Hacker News';
}

function daysSince(timestamp) {
  const published = Date.parse(timestamp || '');
  if (!Number.isFinite(published)) return 0;
  return Math.max(0, Math.floor((Date.now() - published) / 86_400_000));
}

function candidateDraftFromRow(row) {
  return sanitizeCandidateDraft({
    name: row.name,
    role: row.role,
    summary: row.summary,
    location: row.location,
    workMode: row.work_mode,
    availability: row.availability,
    universities: parseList(row.universities_json),
    companies: parseList(row.companies_json),
    skills: parseList(row.skills_json),
    dateRanges: parseList(row.date_ranges_json)
  }).draft;
}

async function readJson(request, maxBytes, oversized = () => json({ error: 'request_too_large' }, 413)) {
  if (!isJsonContentType(request.headers.get('content-type'))) return json({ error: 'unsupported_media_type' }, 415);

  const bytes = await readLimitedBytes(request, maxBytes, oversized);
  if (bytes instanceof Response) return bytes;

  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }
  if (jsonNestingDepth(text) > MAX_JSON_DEPTH) return json({ error: 'invalid_json' }, 400);

  try {
    return JSON.parse(text);
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }
}

function isJsonContentType(value) {
  return /^application\/(?:[a-z0-9.+-]+\+)?json\s*(?:;.*)?$/i.test((value || '').trim());
}

// `JSON.parse` recurses per nesting level, so a small body of bare brackets can exhaust the stack
// before any size or shape check ever runs.
function jsonNestingDepth(text) {
  let depth = 0;
  let deepest = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === '{' || character === '[') {
      depth += 1;
      if (depth > deepest) deepest = depth;
    } else if (character === '}' || character === ']') depth -= 1;
  }

  return deepest;
}

function splitList(value) {
  return unique(value.split(/[,;|]/).map((item) => item.trim()).filter(Boolean)).slice(0, 50);
}

function unique(values) {
  return [...new Set(values)];
}

function parseList(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function createToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hashToken(token) {
  return hashBytes(new TextEncoder().encode(token));
}

async function hashBytes(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function constantTimeEqual(left, right) {
  if (typeof right !== 'string' || left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

function byteLength(value) {
  return new TextEncoder().encode(value).byteLength;
}

function changedRows(result) {
  return Number(result?.meta?.changes ?? result?.changes ?? 0);
}

function json(value, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(value), { status, headers: { ...JSON_RESPONSE_HEADERS, ...extraHeaders } });
}

export {
  CANDIDATES_PAGE_SIZE,
  DETERMINISTIC_HN_EXTRACTOR,
  HN_INGEST_LIMITS,
  MAX_RESUME_BYTES,
  MAX_SOURCE_BYTES,
  STRING_WEB_ACCESS_LIMITS,
  decodeHnCommentText,
  extractProfile,
  ingestHackerNews,
  ingestHnComment,
  previewHackerNewsIngest,
  toHnRecord,
  validateCandidateSourceUrl
};
