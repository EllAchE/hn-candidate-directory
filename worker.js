const MAX_SOURCE_BYTES = 100_000;
const MAX_REQUEST_BYTES = MAX_SOURCE_BYTES + 4_096;
const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/submissions/text') {
      if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
      return createTextSubmission(request, env);
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

  const submissionId = crypto.randomUUID();
  const jobId = crypto.randomUUID();
  const reviewToken = createToken();
  const reviewTokenHash = await hashToken(reviewToken);
  const createdAt = new Date().toISOString();

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

  try {
    await env.SUBMISSION_QUEUE.send({ submissionId });
  } catch {
    await env.DB.batch([
      env.DB.prepare("UPDATE submissions SET status = 'failed', updated_at = ? WHERE id = ?").bind(new Date().toISOString(), submissionId),
      env.DB.prepare("UPDATE jobs SET status = 'failed', error = 'queue_unavailable', updated_at = ? WHERE submission_id = ?").bind(new Date().toISOString(), submissionId)
    ]);
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
  } catch (error) {
    const failedAt = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare("UPDATE submissions SET status = 'failed', updated_at = ? WHERE id = ?").bind(failedAt, submissionId),
      env.DB.prepare('UPDATE jobs SET status = \'failed\', error = ?, updated_at = ? WHERE submission_id = ?').bind(String(error.message || error).slice(0, 500), failedAt, submissionId)
    ]);
    message.retry?.();
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
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
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

export { MAX_SOURCE_BYTES, extractProfile };
