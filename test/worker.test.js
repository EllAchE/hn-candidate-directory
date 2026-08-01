import { describe, expect, test } from 'bun:test';
import worker, { MAX_SOURCE_BYTES, extractProfile } from '../worker.js';
import { createEnvironment } from './memory-d1.js';

describe('source-text review drafts', () => {
  test('remain private through submission, processing, review, and draft edits', async () => {
    const env = createEnvironment();
    const sourceText = [
      'Name: Ada Candidate',
      'Role: Distributed systems engineer',
      'Location: Toronto, Canada',
      'Work mode: Remote',
      'Availability: Immediate',
      'Education: University of Waterloo',
      'Companies: Stripe, Example Labs',
      'Skills: Rust, Go, Kubernetes',
      'Experience: Example Labs 2021 - 2024',
      'Summary: I build reliable data systems.'
    ].join('\n');

    const submissionResponse = await worker.fetch(apiRequest('/api/submissions/text', 'POST', { sourceText }), env);
    expect(submissionResponse.status).toBe(202);
    const submission = await submissionResponse.json();
    expect(submission.status).toBe('submitted');
    expect(env.SUBMISSION_QUEUE.messages).toEqual([{ submissionId: submission.submissionId }]);
    expect(env.DB.submissions.get(submission.submissionId).review_token_hash).not.toBe(submission.reviewToken);

    expect(await publicCandidates(env)).toEqual([]);

    const missingToken = await worker.fetch(apiRequest(`/api/reviews/${submission.submissionId}`), env);
    expect(missingToken.status).toBe(401);
    const pendingReview = await privateReview(env, submission);
    expect(pendingReview).toEqual({ submissionId: submission.submissionId, status: 'submitted', draft: null });

    let acknowledged = false;
    await worker.queue(
      {
        messages: [
          {
            body: env.SUBMISSION_QUEUE.messages[0],
            ack: () => {
              acknowledged = true;
            }
          }
        ]
      },
      env
    );

    expect(acknowledged).toBe(true);
    expect(env.DB.submissions.get(submission.submissionId).source_text).toBe('');
    const readyReview = await privateReview(env, submission);
    expect(readyReview.status).toBe('review_ready');
    expect(readyReview.draft).toMatchObject({
      name: 'Ada Candidate',
      role: 'Distributed systems engineer',
      location: 'Toronto, Canada',
      workMode: 'Remote',
      universities: ['University of Waterloo'],
      companies: ['Stripe', 'Example Labs'],
      skills: ['Rust', 'Go', 'Kubernetes'],
      dateRanges: ['2021 - 2024']
    });
    expect(await publicCandidates(env)).toEqual([]);

    await worker.queue({ messages: [{ body: env.SUBMISSION_QUEUE.messages[0], ack: () => {} }] }, env);
    expect((await privateReview(env, submission)).draft).toEqual(readyReview.draft);

    const editedDraft = { ...readyReview.draft, summary: 'A candidate-reviewed summary.', skills: ['Rust', 'SQLite'] };
    delete editedDraft.id;
    delete editedDraft.status;
    delete editedDraft.updatedAt;
    const saveResponse = await worker.fetch(
      apiRequest(`/api/reviews/${submission.submissionId}`, 'PATCH', editedDraft, submission.reviewToken),
      env
    );
    expect(saveResponse.status).toBe(200);
    expect((await saveResponse.json()).draft).toMatchObject({ summary: 'A candidate-reviewed summary.', skills: ['Rust', 'SQLite'] });
    expect(await publicCandidates(env)).toEqual([]);

  });

  test('rejects source text over the byte budget before writing D1 state', async () => {
    const env = createEnvironment();
    const response = await worker.fetch(apiRequest('/api/submissions/text', 'POST', { sourceText: 'x'.repeat(MAX_SOURCE_BYTES + 1) }), env);

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: 'source_text_too_large', maxBytes: MAX_SOURCE_BYTES });
    expect(env.DB.submissions.size).toBe(0);
    expect(env.SUBMISSION_QUEUE.messages).toEqual([]);
  });

  test('rejects an incorrect review token', async () => {
    const env = createEnvironment();
    const response = await worker.fetch(apiRequest('/api/submissions/text', 'POST', { sourceText: 'Name: Private Candidate' }), env);
    const submission = await response.json();

    const reviewResponse = await worker.fetch(apiRequest(`/api/reviews/${submission.submissionId}`, 'GET', null, 'wrong-token'), env);
    expect(reviewResponse.status).toBe(403);
  });
});

describe('candidate consent decisions', () => {
  test('requires the review token and a ready draft', async () => {
    const env = createEnvironment();
    const submission = await submit(env, 'Name: Token Candidate');
    const decisionPath = `/api/reviews/${submission.submissionId}/decision`;

    const missingToken = await worker.fetch(apiRequest(decisionPath, 'POST', { decision: 'refuse' }), env);
    expect(missingToken.status).toBe(401);

    const wrongToken = await worker.fetch(apiRequest(decisionPath, 'POST', { decision: 'publish', draft: {} }, 'wrong-token'), env);
    expect(wrongToken.status).toBe(403);

    const notReady = await decide(env, submission, { decision: 'refuse' });
    expect(notReady.status).toBe(409);
    expect(await notReady.json()).toEqual({ error: 'review_not_ready' });

    await processQueuedSubmission(env);
    const invalidDecision = await decide(env, submission, { decision: 'later' });
    expect(invalidDecision.status).toBe(400);
    expect(await invalidDecision.json()).toEqual({ error: 'invalid_review_decision' });

    const missingApprovedDraft = await decide(env, submission, { decision: 'publish' });
    expect(missingApprovedDraft.status).toBe(400);
    expect(await missingApprovedDraft.json()).toEqual({ error: 'approved_draft_required' });
  });

  test('keeps a refusal private and cannot publish it later', async () => {
    const env = createEnvironment();
    const submission = await submit(env, 'Name: Private Candidate\nRole: Infrastructure engineer');
    await processQueuedSubmission(env);

    const refusalResponse = await decide(env, submission, { decision: 'refuse' });
    expect(refusalResponse.status).toBe(200);
    expect(await refusalResponse.json()).toMatchObject({ status: 'archived', idempotent: false, publishedAt: null, candidate: null });
    expect(await publicCandidates(env)).toEqual([]);

    const repeatedRefusal = await decide(env, submission, { decision: 'refuse' });
    expect(repeatedRefusal.status).toBe(200);
    expect(await repeatedRefusal.json()).toMatchObject({ status: 'archived', idempotent: true, candidate: null });

    const refusedReview = await privateReview(env, submission);
    expect(refusedReview.status).toBe('archived');
    const refusedDraft = refusedReview.draft;
    const latePublish = await decide(env, submission, { decision: 'publish', draft: editableDraft(refusedDraft) });
    expect(latePublish.status).toBe(409);
    expect(await latePublish.json()).toEqual({ error: 'review_withdrawn' });
    expect(await publicCandidates(env)).toEqual([]);

    const lateEdit = await worker.fetch(
      apiRequest(`/api/reviews/${submission.submissionId}`, 'PATCH', editableDraft(refusedDraft), submission.reviewToken),
      env
    );
    expect(lateEdit.status).toBe(409);
  });

  test('publishes exactly the approved revision once and supports withdrawal', async () => {
    const env = createEnvironment();
    const submission = await submit(env, 'Name: Original Candidate\nRole: Backend engineer\nSkills: Go, Redis');
    await processQueuedSubmission(env);

    const extracted = (await privateReview(env, submission)).draft;
    const approvedDraft = {
      ...editableDraft(extracted),
      name: 'Candidate Approved Name',
      summary: 'This exact candidate-reviewed revision may be searched.',
      skills: ['Go', 'SQLite']
    };
    const publishResponse = await decide(env, submission, { decision: 'publish', draft: approvedDraft });
    expect(publishResponse.status).toBe(200);
    const publication = await publishResponse.json();
    const approvedPublicFields = {
      name: approvedDraft.name,
      role: approvedDraft.role,
      summary: approvedDraft.summary,
      location: approvedDraft.location,
      mode: approvedDraft.workMode,
      availability: approvedDraft.availability,
      universities: approvedDraft.universities,
      companies: approvedDraft.companies,
      skills: approvedDraft.skills,
      dateRanges: approvedDraft.dateRanges
    };
    expect(publication).toMatchObject({ status: 'published', idempotent: false, candidate: approvedPublicFields });
    expect(publication.publishedAt).toBeString();

    const published = await publicCandidates(env);
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject(approvedPublicFields);

    const changedRetryDraft = { ...approvedDraft, name: 'A retry must not replace the approved revision' };
    const repeatedPublish = await decide(env, submission, { decision: 'publish', draft: changedRetryDraft });
    expect(repeatedPublish.status).toBe(200);
    const repeatedPublication = await repeatedPublish.json();
    expect(repeatedPublication).toMatchObject({ status: 'published', idempotent: true, candidate: approvedPublicFields });
    expect(repeatedPublication.publishedAt).toBe(publication.publishedAt);
    expect((await publicCandidates(env))[0]).toMatchObject(approvedPublicFields);

    const editAfterPublish = await worker.fetch(
      apiRequest(`/api/reviews/${submission.submissionId}`, 'PATCH', changedRetryDraft, submission.reviewToken),
      env
    );
    expect(editAfterPublish.status).toBe(409);

    const withdrawal = await decide(env, submission, { decision: 'refuse' });
    expect(withdrawal.status).toBe(200);
    expect(await withdrawal.json()).toMatchObject({ status: 'archived', idempotent: false, candidate: null, publishedAt: null });
    expect(await publicCandidates(env)).toEqual([]);

    const publishAfterWithdrawal = await decide(env, submission, { decision: 'publish', draft: approvedDraft });
    expect(publishAfterWithdrawal.status).toBe(409);
    expect(await publicCandidates(env)).toEqual([]);
  });
});

test('extractProfile returns normalized collection fields', () => {
  expect(
    extractProfile('Name: Lin\nEducation: MIT; Stanford University\nSkills: TypeScript | Go | TypeScript\nExperience: 2019 to present\nLocation: Boston')
  ).toMatchObject({
    name: 'Lin',
    location: 'Boston',
    universities: ['MIT', 'Stanford University'],
    skills: ['TypeScript', 'Go'],
    dateRanges: ['2019 to present']
  });
});

async function privateReview(env, submission) {
  const response = await worker.fetch(apiRequest(`/api/reviews/${submission.submissionId}`, 'GET', null, submission.reviewToken), env);
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  return response.json();
}

async function submit(env, sourceText) {
  const response = await worker.fetch(apiRequest('/api/submissions/text', 'POST', { sourceText }), env);
  expect(response.status).toBe(202);
  return response.json();
}

async function processQueuedSubmission(env) {
  await worker.queue({ messages: [{ body: env.SUBMISSION_QUEUE.messages.at(-1), ack: () => {} }] }, env);
}

async function decide(env, submission, body) {
  return worker.fetch(
    apiRequest(`/api/reviews/${submission.submissionId}/decision`, 'POST', body, submission.reviewToken),
    env
  );
}

function editableDraft(draft) {
  const editable = { ...draft };
  delete editable.id;
  delete editable.status;
  delete editable.updatedAt;
  return editable;
}

async function publicCandidates(env) {
  const response = await worker.fetch(apiRequest('/api/candidates'), env);
  expect(response.status).toBe(200);
  return (await response.json()).candidates;
}

function apiRequest(path, method = 'GET', body = null, token = '') {
  const headers = {};
  if (body !== null) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  return new Request(`https://directory.example${path}`, {
    method,
    headers,
    body: body === null ? undefined : JSON.stringify(body)
  });
}
