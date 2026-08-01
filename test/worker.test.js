import { describe, expect, test } from 'bun:test';
import worker, { MAX_SOURCE_BYTES, STRING_WEB_ACCESS_LIMITS, extractProfile, validateCandidateSourceUrl } from '../worker.js';
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

describe('allowlisted URL review drafts', () => {
  test('retrieves one canonical LinkedIn page through String Web Access and preserves private review and consent', async () => {
    const env = createEnvironment();
    env.UNBLOCKER_ORG_API_KEY = 'server-only-secret';
    const sourceText = [
      'Name: Web Candidate',
      'Role: Reliability engineer',
      'Location: Berlin, Germany',
      'Work mode: Remote',
      'Companies: Example Systems',
      'Skills: Go, SRE',
      'Summary: I build resilient infrastructure.'
    ].join('\n');
    const sourceHtml = `<html><head><style>.secret { display: none }</style></head><body>${sourceText
      .split('\n')
      .map((line) => `<p>${line}</p>`)
      .join('')}</body></html>`;

    await withWebAccessStub(
      () => webAccessResponse(sourceHtml),
      async (requests) => {
        const response = await worker.fetch(
          apiRequest('/api/submissions/url', 'POST', { url: 'https://linkedin.com/in/web-candidate/' }),
          env
        );
        expect(response.status).toBe(202);
        const submission = await response.json();
        expect(submission.status).toBe('submitted');
        expect(submission.submissionId).toStartWith('url-');
        const storedSubmission = env.DB.submissions.get(submission.submissionId);
        expect(storedSubmission).toMatchObject({ source_kind: 'text', source_text: sourceText });
        expect(storedSubmission.source_url).toBeUndefined();
        expect(env.SUBMISSION_QUEUE.messages).toEqual([{ submissionId: submission.submissionId }]);
        expect(await publicCandidates(env)).toEqual([]);

        expect(STRING_WEB_ACCESS_LIMITS).toMatchObject({ requests: 1, pages: 1 });
        expect(requests).toHaveLength(1);
        expect(requests[0].url).toBe('https://request.usestring.ai/v1/fetch');
        expect(requests[0].init.method).toBe('POST');
        expect(requests[0].init.headers.authorization).toBe('Bearer server-only-secret');
        expect(JSON.parse(requests[0].init.body)).toEqual({
          url: 'https://www.linkedin.com/in/web-candidate',
          method: 'GET',
          format: 'json',
          executeJS: false,
          solveCaptcha: false
        });

        await processQueuedSubmission(env);
        expect(env.DB.submissions.get(submission.submissionId).source_text).toBe('');
        const review = await privateReview(env, submission);
        expect(review).toMatchObject({
          status: 'review_ready',
          draft: { name: 'Web Candidate', role: 'Reliability engineer', skills: ['Go', 'SRE'] }
        });
        expect(await publicCandidates(env)).toEqual([]);

        const approvedDraft = editableDraft(review.draft);
        const publicationResponse = await decide(env, submission, { decision: 'publish', draft: approvedDraft });
        expect(publicationResponse.status).toBe(200);
        expect(await publicCandidates(env)).toEqual([expect.objectContaining({ name: 'Web Candidate', skills: ['Go', 'SRE'] })]);
      }
    );
  });

  test('rejects non-allowlisted, network-sensitive, and ambiguous URLs before any upstream request', async () => {
    const invalidUrls = [
      'http://www.linkedin.com/in/candidate',
      'https://user:password@www.linkedin.com/in/candidate',
      'https://www.linkedin.com/in/candidate#details',
      'https://www.linkedin.com/in/candidate?tracking=secret',
      'https://www.linkedin.com:8443/in/candidate',
      'https://127.0.0.1/in/candidate',
      'https://10.0.0.8/in/candidate',
      'https://169.254.169.254/latest/meta-data',
      'https://[::1]/in/candidate',
      'https://localhost/in/candidate',
      'https://metadata.google.internal/computeMetadata/v1',
      'https://linkedin.example/in/candidate',
      'https://www.linkedin.com/company/example',
      'https://www.linkedin.com/in/a',
      'not a url'
    ];
    const env = createEnvironment();
    env.UNBLOCKER_ORG_API_KEY = 'server-only-secret';

    await withWebAccessStub(
      () => {
        throw new Error('upstream must not be called');
      },
      async (requests) => {
        for (const url of invalidUrls) {
          expect(validateCandidateSourceUrl(url)).toBeNull();
          const response = await worker.fetch(apiRequest('/api/submissions/url', 'POST', { url }), env);
          expect(response.status).toBe(400);
          expect(await response.json()).toEqual({ error: 'url_not_allowed' });
        }
        expect(requests).toEqual([]);
        expect(env.DB.submissions.size).toBe(0);

        const oversizedRequest = apiRequest('/api/submissions/url', 'POST', { url: 'https://www.linkedin.com/in/candidate' });
        oversizedRequest.headers.set('content-length', '4097');
        const oversizedResponse = await worker.fetch(oversizedRequest, env);
        expect(oversizedResponse.status).toBe(413);
        expect(await oversizedResponse.json()).toEqual({ error: 'request_too_large' });
        expect(requests).toEqual([]);
      }
    );

    expect(validateCandidateSourceUrl('https://linkedin.com/in/Candidate-123/')).toBe(
      'https://www.linkedin.com/in/Candidate-123'
    );
  });

  test('deduplicates a canonical URL durably after source clearing and under concurrent insertion', async () => {
    const sourceText = 'Name: Deduplicated Candidate\nRole: Backend engineer';

    await withWebAccessStub(
      () => webAccessResponse(sourceText),
      async (requests) => {
        const durableEnv = createEnvironment();
        durableEnv.UNBLOCKER_ORG_API_KEY = 'server-only-secret';
        const firstResponse = await worker.fetch(
          apiRequest('/api/submissions/url', 'POST', { url: 'https://linkedin.com/in/deduplicated-candidate/' }),
          durableEnv
        );
        expect(firstResponse.status).toBe(202);
        const first = await firstResponse.json();
        await processQueuedSubmission(durableEnv);
        expect(durableEnv.DB.submissions.get(first.submissionId).source_text).toBe('');

        const repeatedResponse = await worker.fetch(
          apiRequest('/api/submissions/url', 'POST', { url: 'https://www.linkedin.com/in/deduplicated-candidate' }),
          durableEnv
        );
        expect(repeatedResponse.status).toBe(409);
        expect(await repeatedResponse.json()).toEqual({ error: 'duplicate_url_submission' });
        expect(durableEnv.DB.submissions.size).toBe(1);
        expect(durableEnv.SUBMISSION_QUEUE.messages).toHaveLength(1);

        const concurrentEnv = createEnvironment();
        concurrentEnv.UNBLOCKER_ORG_API_KEY = 'server-only-secret';
        const concurrentResponses = await Promise.all([
          worker.fetch(apiRequest('/api/submissions/url', 'POST', { url: 'https://linkedin.com/in/race-candidate/' }), concurrentEnv),
          worker.fetch(apiRequest('/api/submissions/url', 'POST', { url: 'https://www.linkedin.com/in/race-candidate' }), concurrentEnv)
        ]);
        expect(concurrentResponses.map((response) => response.status).sort()).toEqual([202, 409]);
        expect(concurrentEnv.DB.submissions.size).toBe(1);
        expect(concurrentEnv.DB.jobs.size).toBe(1);
        expect(concurrentEnv.SUBMISSION_QUEUE.messages).toHaveLength(1);
        expect(requests).toHaveLength(3);
      }
    );
  });

  test('recycles only a failed URL submission after a Queue outage', async () => {
    const env = createEnvironment();
    env.UNBLOCKER_ORG_API_KEY = 'server-only-secret';
    let queueAvailable = false;
    env.SUBMISSION_QUEUE.send = async function (message) {
      if (!queueAvailable) throw new Error('queue secret detail');
      this.messages.push(message);
    };

    await withWebAccessStub(
      () => webAccessResponse('Name: Retry Candidate\nRole: Data engineer'),
      async (requests) => {
        const firstResponse = await worker.fetch(
          apiRequest('/api/submissions/url', 'POST', { url: 'https://www.linkedin.com/in/retry-candidate' }),
          env
        );
        expect(firstResponse.status).toBe(503);
        expect(await firstResponse.json()).toEqual({ error: 'queue_unavailable' });
        const submissionId = [...env.DB.submissions.keys()][0];
        expect(env.DB.submissions.get(submissionId).status).toBe('failed');
        expect(env.DB.jobs.get(submissionId)).toMatchObject({ status: 'failed', error: 'queue_unavailable' });

        queueAvailable = true;
        const retryResponse = await worker.fetch(
          apiRequest('/api/submissions/url', 'POST', { url: 'https://linkedin.com/in/retry-candidate/' }),
          env
        );
        expect(retryResponse.status).toBe(202);
        expect(await retryResponse.json()).toMatchObject({ submissionId, status: 'submitted' });
        expect(env.DB.submissions.get(submissionId).status).toBe('submitted');
        expect(env.DB.jobs.get(submissionId)).toMatchObject({ status: 'queued', attempts: 0, error: null });
        expect(env.SUBMISSION_QUEUE.messages).toEqual([{ submissionId }]);
        expect(requests).toHaveLength(2);
      }
    );
  });

  test('fails closed on redirects, malformed envelopes, timeouts, and byte-limit breaches without leaking details', async () => {
    const env = createEnvironment();
    env.UNBLOCKER_ORG_API_KEY = 'server-only-secret';
    const secret = 'upstream-secret-cookie';
    const targetDetail = 'http://169.254.169.254/latest/meta-data';
    const attempts = [
      () => webAccessResponse(secret, { statusCode: 302, headers: { location: targetDetail } }),
      () => new Response(JSON.stringify({ statusCode: 200, headers: {}, data: { secret } })),
      () => webAccessResponse(secret, { headers: { 'content-type': 'application/pdf' } }),
      () => new Response(`${secret} ${targetDetail}`, { status: 502 }),
      () => {
        throw new DOMException(`${secret} ${targetDetail}`, 'AbortError');
      },
      () => webAccessResponse('x'.repeat(MAX_SOURCE_BYTES + 1)),
      () =>
        new Response(JSON.stringify({ statusCode: 200, headers: {}, data: secret }), {
          headers: { 'content-length': String(STRING_WEB_ACCESS_LIMITS.responseBytes + 1) }
        }),
      () => new Response('x'.repeat(STRING_WEB_ACCESS_LIMITS.responseBytes + 1))
    ];
    const expectedStatuses = [502, 502, 502, 502, 504, 413, 413, 413];
    const logs = [];
    const originalConsole = { error: console.error, log: console.log, warn: console.warn };
    console.error = (...values) => logs.push(values.join(' '));
    console.log = (...values) => logs.push(values.join(' '));
    console.warn = (...values) => logs.push(values.join(' '));

    try {
      for (let index = 0; index < attempts.length; index += 1) {
        await withWebAccessStub(attempts[index], async () => {
          const response = await worker.fetch(
            apiRequest('/api/submissions/url', 'POST', { url: 'https://www.linkedin.com/in/private-candidate' }),
            env
          );
          expect(response.status).toBe(expectedStatuses[index]);
          const responseText = await response.text();
          expect(responseText).not.toContain(secret);
          expect(responseText).not.toContain(targetDetail);
          expect(responseText).not.toContain('server-only-secret');
        });
      }
    } finally {
      console.error = originalConsole.error;
      console.log = originalConsole.log;
      console.warn = originalConsole.warn;
    }

    expect(logs).toEqual([]);
    expect(env.DB.submissions.size).toBe(0);
    expect(env.SUBMISSION_QUEUE.messages).toEqual([]);
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

describe('published candidate management', () => {
  test('binds a management token to the exact candidate without changing visibility on failed authorization', async () => {
    const env = createEnvironment();
    const first = await publishSubmission(env, 'Name: First Candidate\nRole: Platform engineer');
    const second = await publishSubmission(env, 'Name: Second Candidate\nRole: Product engineer');
    const firstPath = `/api/candidates/${first.candidate.id}/manage`;

    const missingToken = await worker.fetch(apiRequest(firstPath, 'POST', { action: 'remove' }), env);
    expect(missingToken.status).toBe(401);
    expect(await missingToken.json()).toEqual({ error: 'management_token_required' });

    const wrongToken = await worker.fetch(apiRequest(firstPath, 'POST', { action: 'update' }, 'wrong-token'), env);
    expect(wrongToken.status).toBe(403);
    expect(await wrongToken.json()).toEqual({ error: 'management_token_invalid' });

    const unrelatedToken = await worker.fetch(apiRequest(firstPath, 'POST', { action: 'remove' }, second.submission.reviewToken), env);
    expect(unrelatedToken.status).toBe(403);
    expect(await unrelatedToken.json()).toEqual({ error: 'management_token_invalid' });

    const invalidAction = await manage(env, first, 'replace');
    expect(invalidAction.status).toBe(400);
    expect(await invalidAction.json()).toEqual({ error: 'invalid_management_action' });

    const published = await publicCandidates(env);
    expect(published.map((candidate) => candidate.id).sort()).toEqual([first.candidate.id, second.candidate.id].sort());
    expect(env.DB.revisions.get(first.submission.submissionId)).toMatchObject({ status: 'published', name: 'First Candidate' });
  });

  test('moves a verified update into private review and requires explicit consent to republish', async () => {
    const env = createEnvironment();
    const published = await publishSubmission(env, 'Name: Update Candidate\nRole: Backend engineer\nSkills: Go, Redis');

    const updateResponse = await manage(env, published, 'update');
    expect(updateResponse.status).toBe(200);
    const update = await updateResponse.json();
    expect(update).toMatchObject({
      action: 'update',
      candidateId: published.candidate.id,
      submissionId: published.submission.submissionId,
      status: 'review_ready',
      idempotent: false,
      visibility: 'hidden_during_review',
      reviewEndpoint: `/api/reviews/${published.submission.submissionId}`,
      decisionEndpoint: `/api/reviews/${published.submission.submissionId}/decision`
    });
    expect(await publicCandidates(env)).toEqual([]);

    const repeatedUpdate = await manage(env, published, 'update');
    expect(repeatedUpdate.status).toBe(200);
    expect(await repeatedUpdate.json()).toMatchObject({ status: 'review_ready', idempotent: true });

    const privateDraft = (await privateReview(env, published.submission)).draft;
    const editedDraft = { ...editableDraft(privateDraft), name: 'Candidate Approved Update', skills: ['Go', 'SQLite'] };
    const saveResponse = await worker.fetch(
      apiRequest(`/api/reviews/${published.submission.submissionId}`, 'PATCH', editedDraft, published.submission.reviewToken),
      env
    );
    expect(saveResponse.status).toBe(200);
    expect(await publicCandidates(env)).toEqual([]);

    const republishResponse = await decide(env, published.submission, { decision: 'publish', draft: editedDraft });
    expect(republishResponse.status).toBe(200);
    expect(await republishResponse.json()).toMatchObject({ status: 'published', candidate: { name: 'Candidate Approved Update', skills: ['Go', 'SQLite'] } });
    expect(await publicCandidates(env)).toEqual([expect.objectContaining({ id: published.candidate.id, name: 'Candidate Approved Update' })]);
  });

  test('archives verified removals and makes retries and invalid transitions safe', async () => {
    const env = createEnvironment();
    const published = await publishSubmission(env, 'Name: Removal Candidate\nRole: Security engineer');

    const removalResponse = await manage(env, published, 'remove');
    expect(removalResponse.status).toBe(200);
    expect(await removalResponse.json()).toMatchObject({
      action: 'remove',
      candidateId: published.candidate.id,
      status: 'archived',
      idempotent: false,
      visibility: 'not_searchable',
      reviewEndpoint: null,
      decisionEndpoint: null
    });
    expect(await publicCandidates(env)).toEqual([]);

    const repeatedRemoval = await manage(env, published, 'remove');
    expect(repeatedRemoval.status).toBe(200);
    expect(await repeatedRemoval.json()).toMatchObject({ status: 'archived', idempotent: true });

    const updateAfterRemoval = await manage(env, published, 'update');
    expect(updateAfterRemoval.status).toBe(409);
    expect(await updateAfterRemoval.json()).toEqual({ error: 'candidate_archived' });
    expect((await privateReview(env, published.submission)).status).toBe('archived');
    expect(await publicCandidates(env)).toEqual([]);
  });

  test('allows a verified removal while an update is still private', async () => {
    const env = createEnvironment();
    const published = await publishSubmission(env, 'Name: Update Removal Candidate\nRole: Data engineer');

    expect((await manage(env, published, 'update')).status).toBe(200);
    expect(await publicCandidates(env)).toEqual([]);

    const removalResponse = await manage(env, published, 'remove');
    expect(removalResponse.status).toBe(200);
    expect(await removalResponse.json()).toMatchObject({ status: 'archived', idempotent: false });
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

async function publishSubmission(env, sourceText) {
  const submission = await submit(env, sourceText);
  await processQueuedSubmission(env);
  const draft = editableDraft((await privateReview(env, submission)).draft);
  const response = await decide(env, submission, { decision: 'publish', draft });
  expect(response.status).toBe(200);
  const publication = await response.json();
  return { submission, candidate: publication.candidate };
}

async function manage(env, publication, action) {
  return worker.fetch(
    apiRequest(`/api/candidates/${publication.candidate.id}/manage`, 'POST', { action }, publication.submission.reviewToken),
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

function webAccessResponse(data, overrides = {}) {
  return new Response(
    JSON.stringify({
      statusCode: overrides.statusCode ?? 200,
      headers: overrides.headers ?? { 'content-type': 'text/html; charset=utf-8' },
      data
    }),
    { headers: { 'content-type': 'application/json' } }
  );
}

async function withWebAccessStub(handler, callback) {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), init });
    return handler(url, init);
  };
  try {
    return await callback(requests);
  } finally {
    globalThis.fetch = originalFetch;
  }
}
