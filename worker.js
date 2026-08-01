const MAX_SOURCE_BYTES = 100_000;
const MAX_REQUEST_BYTES = MAX_SOURCE_BYTES + 4_096;
const MAX_URL_REQUEST_BYTES = 4_096;
const MAX_RESUME_BYTES = MAX_SOURCE_BYTES;
const MAX_RESUME_FILENAME_BYTES = 128;
const STRING_WEB_ACCESS_ENDPOINT = 'https://request.usestring.ai/v1/fetch';
const STRING_WEB_ACCESS_LIMITS = Object.freeze({ requests: 1, pages: 1, timeoutMs: 12_000, responseBytes: 750_000 });
const LINKEDIN_PROFILE_HOSTS = new Set(['linkedin.com', 'www.linkedin.com']);
const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

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

    const managementMatch = url.pathname.match(/^\/api\/candidates\/([^/]+)\/manage$/);
    if (managementMatch) {
      if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
      return manageCandidate(request, env, managementMatch[1]);
    }

    if (url.pathname === '/api/candidates') {
      if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
      return listPublishedCandidates(env);
    }

    if (url.pathname.startsWith('/api/')) return json({ error: 'not_found' }, 404);
    if (!env.ASSETS) return new Response('Not found', { status: 404 });

    if (url.pathname === '/') {
      url.pathname = '/who-is-hiring.html';
      return env.ASSETS.fetch(new Request(url, request));
    }

    return env.ASSETS.fetch(request);
  },

  async queue(batch, env) {
    await Promise.all(batch.messages.map((message) => processSubmissionMessage(message, env)));
  }
};

async function createTextSubmission(request, env) {
  const contentLength = Number(request.headers.get('content-length') || 0);
  if (contentLength > MAX_REQUEST_BYTES) return json({ error: 'source_text_too_large', maxBytes: MAX_SOURCE_BYTES }, 413);

  const requestText = await request.text();
  if (byteLength(requestText) > MAX_REQUEST_BYTES) return json({ error: 'source_text_too_large', maxBytes: MAX_SOURCE_BYTES }, 413);

  let body;
  try {
    body = JSON.parse(requestText);
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }

  const sourceText = typeof body?.sourceText === 'string' ? body.sourceText.trim() : '';
  if (!sourceText) return json({ error: 'source_text_required' }, 400);
  if (byteLength(sourceText) > MAX_SOURCE_BYTES) return json({ error: 'source_text_too_large', maxBytes: MAX_SOURCE_BYTES }, 413);
  if (!env.DB || !env.SUBMISSION_QUEUE) return json({ error: 'service_not_configured' }, 503);

  return createQueuedSubmission(env, crypto.randomUUID(), sourceText, 'submission_conflict');
}

async function createUrlSubmission(request, env) {
  const body = await readJson(request, MAX_URL_REQUEST_BYTES);
  if (body instanceof Response) return body;

  const sourceUrl = validateCandidateSourceUrl(body?.url);
  if (!sourceUrl) return json({ error: 'url_not_allowed' }, 400);
  if (!env.DB || !env.SUBMISSION_QUEUE || !env.UNBLOCKER_ORG_API_KEY) return json({ error: 'service_not_configured' }, 503);

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
  if (!env.DB || !env.SUBMISSION_QUEUE || !env.RESUME_STAGING) return json({ error: 'service_not_configured' }, 503);

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

  const objectKey = await resumeObjectKey(submissionId);
  try {
    await env.RESUME_STAGING.put(objectKey, resumeBytes);
  } catch {
    await failSubmissionSetup(env, submissionId, 'resume_staging_unavailable');
    await deleteResumeObject(env, submissionId);
    return json({ error: 'resume_staging_unavailable' }, 503);
  }

  const response = await enqueueSubmission(env, submissionId, pendingSubmission.reviewToken);
  if (!response.ok) await deleteResumeObject(env, submissionId);
  return response;
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

async function readLimitedBytes(request, maxBytes) {
  const contentLength = request.headers.get('content-length');
  if (contentLength && !/^\d+$/.test(contentLength)) return json({ error: 'resume_content_invalid' }, 400);
  if (contentLength && Number(contentLength) > maxBytes) return json({ error: 'resume_too_large', maxBytes }, 413);
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
      return json({ error: 'resume_too_large', maxBytes }, 413);
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
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<\/?(?:address|article|aside|blockquote|br|div|footer|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|table|tr|ul)\b[^>]*>/gi, '\n')
      .replace(/<[^>]*>/g, ' ')
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

async function listPublishedCandidates(env) {
  if (!env.DB) return json({ error: 'service_not_configured' }, 503);
  const result = await env.DB.prepare(
    `SELECT id, name, role, summary, location, work_mode, availability,
            universities_json, companies_json, skills_json, date_ranges_json, published_at
       FROM profile_revisions
      WHERE status = 'published'
      ORDER BY published_at DESC`
  ).all();

  return json({ candidates: result.results.map(toPublicCandidate) });
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
      await deleteResumeObject(env, submissionId);
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
    await deleteResumeObject(env, submissionId);
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

async function resumeObjectKey(submissionId) {
  const match = submissionId.match(/^resume-([a-f0-9]{64})$/);
  if (!match) return '';
  const keyHash = await hashToken(`resume-object:${match[1]}`);
  return `resume-staging/${keyHash}`;
}

async function deleteResumeObject(env, submissionId) {
  const objectKey = await resumeObjectKey(submissionId);
  if (!objectKey || !env.RESUME_STAGING) return;
  try {
    await env.RESUME_STAGING.delete(objectKey);
  } catch {
    return;
  }
}

async function authorizeReview(request, env, submissionId) {
  if (!env.DB) return json({ error: 'service_not_configured' }, 503);
  const authorization = request.headers.get('authorization') || '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
  if (!token) return json({ error: 'review_token_required' }, 401);

  const submission = await env.DB.prepare('SELECT id, review_token_hash, status FROM submissions WHERE id = ?').bind(submissionId).first();
  if (!submission) return json({ error: 'review_not_found' }, 404);
  const tokenHash = await hashToken(token);
  if (!constantTimeEqual(tokenHash, submission.review_token_hash)) return json({ error: 'review_token_invalid' }, 403);
  return submission;
}

async function authorizeCandidateManagement(request, env, candidateId) {
  if (!env.DB) return json({ error: 'service_not_configured' }, 503);
  const authorization = request.headers.get('authorization') || '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
  if (!token) return json({ error: 'management_token_required' }, 401);

  const management = await getCandidateManagementRecord(env, candidateId);
  if (!management) return json({ error: 'candidate_not_found' }, 404);
  const tokenHash = await hashToken(token);
  if (!constantTimeEqual(tokenHash, management.review_token_hash)) return json({ error: 'management_token_invalid' }, 403);
  return management;
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

  return {
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
  };
}

function validateDraft(value) {
  if (!value || typeof value !== 'object') return null;
  const text = (key, maxLength) => (typeof value[key] === 'string' && value[key].trim().length <= maxLength ? value[key].trim() : null);
  const list = (key) => {
    if (!Array.isArray(value[key]) || value[key].length > 50) return null;
    const items = value[key].map((item) => (typeof item === 'string' ? item.trim() : '')).filter(Boolean);
    return items.every((item) => item.length <= 200) ? unique(items) : null;
  };
  const draft = {
    name: text('name', 200),
    role: text('role', 300),
    summary: text('summary', 2_000),
    location: text('location', 300),
    workMode: text('workMode', 100),
    availability: text('availability', 100),
    universities: list('universities'),
    companies: list('companies'),
    skills: list('skills'),
    dateRanges: list('dateRanges')
  };
  return Object.values(draft).some((field) => field === null) ? null : draft;
}

function toReviewDraft(row) {
  return {
    id: row.id,
    status: row.status,
    name: row.name,
    role: row.role,
    summary: row.summary,
    location: row.location,
    workMode: row.work_mode,
    availability: row.availability,
    universities: parseList(row.universities_json),
    companies: parseList(row.companies_json),
    skills: parseList(row.skills_json),
    dateRanges: parseList(row.date_ranges_json),
    updatedAt: row.updated_at
  };
}

function toPublicCandidate(row) {
  const universities = parseList(row.universities_json);
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    summary: row.summary,
    location: row.location,
    mode: row.work_mode,
    availability: row.availability,
    university: universities[0] || 'Not specified',
    universities,
    companies: parseList(row.companies_json),
    skills: parseList(row.skills_json),
    dateRanges: parseList(row.date_ranges_json),
    source: 'Candidate submitted',
    enriched: true,
    posted: 0,
    publishedAt: row.published_at
  };
}

async function readJson(request, maxBytes) {
  const contentLength = request.headers.get('content-length');
  if (/^\d+$/.test(contentLength || '') && Number(contentLength) > maxBytes) return json({ error: 'request_too_large' }, 413);
  const text = await request.text();
  if (byteLength(text) > maxBytes) return json({ error: 'request_too_large' }, 413);
  try {
    return JSON.parse(text);
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }
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
    return Array.isArray(parsed) ? parsed : [];
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

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: JSON_HEADERS });
}

export { MAX_RESUME_BYTES, MAX_SOURCE_BYTES, STRING_WEB_ACCESS_LIMITS, extractProfile, validateCandidateSourceUrl };
