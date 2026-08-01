import { describe, expect, test } from 'bun:test';
import worker, { MAX_RESUME_BYTES, MAX_SOURCE_BYTES, STRING_WEB_ACCESS_LIMITS, extractProfile, validateCandidateSourceUrl } from '../worker.js';
import { REDACTION_MARKER } from '../sensitive-data.js';
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

describe('plain-text resume review drafts', () => {
  test('stages exact private bytes, enters the existing consent pipeline, and cleans both source copies', async () => {
    const env = createEnvironment();
    const filename = 'Ada Candidate Resume.txt';
    const sourceText = [
      'Name: Resume Candidate',
      'Role: Platform engineer',
      'Location: Toronto, Canada',
      'Work mode: Remote',
      'Companies: Example Systems',
      'Skills: Rust, Go',
      'Summary: I build reliable systems.'
    ].join('\n');

    const response = await worker.fetch(resumeRequest(sourceText, { filename }), env);
    expect(response.status).toBe(202);
    const responseText = await response.text();
    const submission = JSON.parse(responseText);
    const staged = env.RESUME_STAGING.puts[0];
    expect(submission).toMatchObject({ status: 'submitted', reviewEndpoint: `/api/reviews/${submission.submissionId}` });
    expect(submission.submissionId).toStartWith('resume-');
    expect(staged.key).toStartWith('resume-staging/');
    expect(new TextDecoder().decode(staged.bytes)).toBe(sourceText);
    expect(staged.options).toBeUndefined();
    expect(responseText).not.toContain(sourceText);
    expect(responseText).not.toContain(filename);
    expect(responseText).not.toContain(staged.key);
    expect(responseText).not.toContain('RESUME_STAGING');

    const stored = env.DB.submissions.get(submission.submissionId);
    expect(stored).toMatchObject({ source_kind: 'text', source_text: sourceText, status: 'submitted' });
    expect(stored.review_token_hash).not.toBe(submission.reviewToken);
    expect(stored.filename).toBeUndefined();
    expect(stored.object_key).toBeUndefined();
    expect(env.SUBMISSION_QUEUE.messages).toEqual([{ submissionId: submission.submissionId }]);
    expect(await publicCandidates(env)).toEqual([]);

    await processQueuedSubmission(env);
    expect(env.DB.submissions.get(submission.submissionId).source_text).toBe('');
    expect(env.RESUME_STAGING.objects.size).toBe(0);
    expect(env.RESUME_STAGING.deletes).toEqual([staged.key]);
    const review = await privateReview(env, submission);
    expect(review).toMatchObject({
      status: 'review_ready',
      draft: { name: 'Resume Candidate', role: 'Platform engineer', companies: ['Example Systems'], skills: ['Rust', 'Go'] }
    });
    expect(await publicCandidates(env)).toEqual([]);

    const duplicateResponse = await worker.fetch(resumeRequest(sourceText, { filename }), env);
    expect(duplicateResponse.status).toBe(409);
    expect(await duplicateResponse.json()).toEqual({ error: 'duplicate_resume_submission' });
    expect(env.RESUME_STAGING.puts).toHaveLength(1);

    const publicationResponse = await decide(env, submission, { decision: 'publish', draft: editableDraft(review.draft) });
    expect(publicationResponse.status).toBe(200);
    expect(await publicCandidates(env)).toEqual([expect.objectContaining({ name: 'Resume Candidate', skills: ['Rust', 'Go'] })]);
  });

  test('rejects oversized, mislabeled, unsafe-name, malformed, binary, HTML, archive, and executable inputs before staging', async () => {
    const cases = [
      { request: resumeRequest('Name: Candidate', { contentType: 'application/octet-stream' }), status: 415, error: 'resume_type_not_supported' },
      { request: resumeRequest('Name: Candidate', { filename: '../resume.txt' }), status: 415, error: 'resume_type_not_supported' },
      { request: resumeRequest('Name: Candidate', { filename: 'resume.pdf.txt' }), status: 415, error: 'resume_type_not_supported' },
      { request: resumeRequest('Name: Candidate', { filename: 'résumé.txt' }), status: 415, error: 'resume_type_not_supported' },
      { request: resumeRequest('<html><body>private resume</body></html>'), status: 400, error: 'resume_content_invalid' },
      { request: resumeRequest(new Uint8Array([0xc3, 0x28])), status: 400, error: 'resume_content_invalid' },
      { request: resumeRequest(new Uint8Array([0x4e, 0x61, 0x6d, 0x65, 0x3a, 0x00, 0x41])), status: 400, error: 'resume_content_invalid' },
      { request: resumeRequest(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x61, 0x62, 0x63])), status: 400, error: 'resume_content_invalid' },
      { request: resumeRequest(new TextEncoder().encode('prefix %PDF-1.7 private data')), status: 400, error: 'resume_content_invalid' },
      { request: resumeRequest(new Uint8Array([0x4d, 0x5a, 0x61, 0x62, 0x63])), status: 400, error: 'resume_content_invalid' }
    ];

    for (const testCase of cases) {
      const env = createEnvironment();
      const response = await worker.fetch(testCase.request, env);
      expect(response.status).toBe(testCase.status);
      expect(await response.json()).toEqual({ error: testCase.error });
      expect(env.DB.submissions.size).toBe(0);
      expect(env.RESUME_STAGING.puts).toEqual([]);
      expect(env.SUBMISSION_QUEUE.messages).toEqual([]);
    }

    const preflightEnv = createEnvironment();
    const preflightRequest = resumeRequest('x');
    preflightRequest.headers.set('content-length', String(MAX_RESUME_BYTES + 1));
    const preflightResponse = await worker.fetch(preflightRequest, preflightEnv);
    expect(preflightResponse.status).toBe(413);
    expect(await preflightResponse.json()).toEqual({ error: 'resume_too_large', maxBytes: MAX_RESUME_BYTES });
    expect(preflightEnv.DB.submissions.size).toBe(0);
    expect(preflightEnv.RESUME_STAGING.puts).toEqual([]);

    const streamingEnv = createEnvironment();
    const streamingResponse = await worker.fetch(resumeRequest('x'.repeat(MAX_RESUME_BYTES + 1)), streamingEnv);
    expect(streamingResponse.status).toBe(413);
    expect(await streamingResponse.json()).toEqual({ error: 'resume_too_large', maxBytes: MAX_RESUME_BYTES });
    expect(streamingEnv.DB.submissions.size).toBe(0);
    expect(streamingEnv.RESUME_STAGING.puts).toEqual([]);
  });

  test('deduplicates concurrent exact content before R2 and never exposes the losing token or object key', async () => {
    const env = createEnvironment();
    const sourceText = 'Name: Concurrent Candidate\nRole: Backend engineer';
    const responses = await Promise.all([
      worker.fetch(resumeRequest(sourceText), env),
      worker.fetch(resumeRequest(sourceText), env)
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([202, 409]);
    const bodies = await Promise.all(responses.map((response) => response.text()));
    const successBody = bodies[responses.findIndex((response) => response.status === 202)];
    const duplicateBody = bodies[responses.findIndex((response) => response.status === 409)];
    expect(JSON.parse(duplicateBody)).toEqual({ error: 'duplicate_resume_submission' });
    expect(duplicateBody).not.toContain(JSON.parse(successBody).reviewToken);
    expect(env.DB.submissions.size).toBe(1);
    expect(env.DB.jobs.size).toBe(1);
    expect(env.RESUME_STAGING.puts).toHaveLength(1);
    expect(env.RESUME_STAGING.objects.size).toBe(1);
    expect(env.RESUME_STAGING.deletes).toEqual([]);
    expect(successBody).not.toContain(env.RESUME_STAGING.puts[0].key);
    expect(duplicateBody).not.toContain(env.RESUME_STAGING.puts[0].key);
  });

  test('fails closed around R2 and Queue setup and permits a same-content Queue retry', async () => {
    const sourceText = 'Name: Retry Resume\nRole: Data engineer';
    const stagingFailureEnv = createEnvironment();
    stagingFailureEnv.RESUME_STAGING.put = async () => {
      throw new Error('r2-private-bucket-secret');
    };
    const stagingResponse = await worker.fetch(resumeRequest(sourceText, { filename: 'Private Resume.txt' }), stagingFailureEnv);
    expect(stagingResponse.status).toBe(503);
    const stagingBody = await stagingResponse.text();
    expect(stagingBody).toBe('{"error":"resume_staging_unavailable"}');
    expect(stagingBody).not.toContain(sourceText);
    expect(stagingBody).not.toContain('Private Resume.txt');
    expect(stagingBody).not.toContain('r2-private-bucket-secret');
    const failedSubmissionId = [...stagingFailureEnv.DB.submissions.keys()][0];
    expect(stagingFailureEnv.DB.submissions.get(failedSubmissionId).status).toBe('failed');
    expect(stagingFailureEnv.DB.jobs.get(failedSubmissionId)).toMatchObject({ status: 'failed', error: 'resume_staging_unavailable' });
    expect(stagingFailureEnv.SUBMISSION_QUEUE.messages).toEqual([]);
    expect(stagingFailureEnv.RESUME_STAGING.deletes).toHaveLength(1);

    const queueEnv = createEnvironment();
    let queueAvailable = false;
    queueEnv.SUBMISSION_QUEUE.send = async function (message) {
      if (!queueAvailable) throw new Error('queue-private-secret');
      this.messages.push(message);
    };
    const firstResponse = await worker.fetch(resumeRequest(sourceText), queueEnv);
    expect(firstResponse.status).toBe(503);
    expect(await firstResponse.json()).toEqual({ error: 'queue_unavailable' });
    const submissionId = [...queueEnv.DB.submissions.keys()][0];
    expect(queueEnv.DB.submissions.get(submissionId).status).toBe('failed');
    expect(queueEnv.DB.jobs.get(submissionId)).toMatchObject({ status: 'failed', error: 'queue_unavailable' });
    expect(queueEnv.RESUME_STAGING.objects.size).toBe(0);

    queueAvailable = true;
    const retryResponse = await worker.fetch(resumeRequest(sourceText), queueEnv);
    expect(retryResponse.status).toBe(202);
    expect(await retryResponse.json()).toMatchObject({ submissionId, status: 'submitted' });
    expect(queueEnv.DB.submissions.get(submissionId).status).toBe('submitted');
    expect(queueEnv.DB.jobs.get(submissionId)).toMatchObject({ status: 'queued', attempts: 0, error: null });
    expect(queueEnv.RESUME_STAGING.puts).toHaveLength(2);
    expect(queueEnv.RESUME_STAGING.objects.size).toBe(1);
    expect(queueEnv.SUBMISSION_QUEUE.messages).toEqual([{ submissionId }]);
  });

  test('retains staged data for Queue retry and treats R2 deletion as a lifecycle-backed best effort', async () => {
    const retryEnv = createEnvironment();
    const submissionResponse = await worker.fetch(resumeRequest('Name: Processing Retry\nRole: Security engineer'), retryEnv);
    const submission = await submissionResponse.json();
    const originalBatch = retryEnv.DB.batch.bind(retryEnv.DB);
    let failExtractionWrite = true;
    retryEnv.DB.batch = async (statements) => {
      if (failExtractionWrite && statements.some((statement) => statement.sql.startsWith('INSERT INTO profile_revisions'))) {
        failExtractionWrite = false;
        throw new Error('private-database-detail');
      }
      return originalBatch(statements);
    };
    let retried = false;
    await worker.queue({ messages: [{ body: { submissionId: submission.submissionId }, retry: () => { retried = true; } }] }, retryEnv);
    expect(retried).toBe(true);
    expect(retryEnv.DB.submissions.get(submission.submissionId).status).toBe('failed');
    expect(retryEnv.DB.submissions.get(submission.submissionId).source_text).toContain('Processing Retry');
    expect(retryEnv.DB.jobs.get(submission.submissionId).error).toBe('extraction_failed');
    expect(retryEnv.RESUME_STAGING.objects.size).toBe(1);

    let acknowledged = false;
    await worker.queue({ messages: [{ body: { submissionId: submission.submissionId }, ack: () => { acknowledged = true; } }] }, retryEnv);
    expect(acknowledged).toBe(true);
    expect(retryEnv.DB.submissions.get(submission.submissionId)).toMatchObject({ status: 'review_ready', source_text: '' });
    expect(retryEnv.RESUME_STAGING.objects.size).toBe(0);

    const deleteFailureEnv = createEnvironment();
    const deleteFailureResponse = await worker.fetch(resumeRequest('Name: Lifecycle Candidate\nRole: Product engineer'), deleteFailureEnv);
    const deleteFailureSubmission = await deleteFailureResponse.json();
    deleteFailureEnv.RESUME_STAGING.delete = async () => {
      throw new Error('private-r2-delete-detail');
    };
    let deleteFailureAck = false;
    let deleteFailureRetry = false;
    await worker.queue(
      {
        messages: [{
          body: { submissionId: deleteFailureSubmission.submissionId },
          ack: () => { deleteFailureAck = true; },
          retry: () => { deleteFailureRetry = true; }
        }]
      },
      deleteFailureEnv
    );
    expect(deleteFailureAck).toBe(true);
    expect(deleteFailureRetry).toBe(false);
    expect(deleteFailureEnv.DB.submissions.get(deleteFailureSubmission.submissionId)).toMatchObject({ status: 'review_ready', source_text: '' });
    expect(deleteFailureEnv.RESUME_STAGING.objects.size).toBe(1);
  });

  test('keeps Queue-send and D1-marking failures generic while deleting the staged object', async () => {
    const env = createEnvironment();
    env.SUBMISSION_QUEUE.send = async () => {
      throw new Error('queue-transport-secret');
    };
    const originalBatch = env.DB.batch.bind(env.DB);
    env.DB.batch = async (statements) => {
      if (statements.some((statement) => statement.sql.startsWith("UPDATE submissions SET status = 'failed'"))) {
        throw new Error('database-marking-secret');
      }
      return originalBatch(statements);
    };

    const response = await worker.fetch(resumeRequest('Name: Setup Failure Candidate'), env);
    expect(response.status).toBe(503);
    const responseText = await response.text();
    expect(responseText).toBe('{"error":"queue_unavailable"}');
    expect(responseText).not.toContain('queue-transport-secret');
    expect(responseText).not.toContain('database-marking-secret');
    expect(responseText).not.toContain('Setup Failure Candidate');
    expect(env.RESUME_STAGING.objects.size).toBe(0);
    expect(env.RESUME_STAGING.deletes).toHaveLength(1);
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

describe('shared sensitive-field safety', () => {
  test('produces redacted private drafts for source text, LinkedIn URL, and plain-text resume ingestion', async () => {
    const textEnv = createEnvironment();
    const textSecrets = ['text.candidate@example.com', '+1 (415) 555-2671', 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456'];
    const textSubmission = await submit(
      textEnv,
      candidateSource('Text Candidate', `Contact ${textSecrets[0]} or ${textSecrets[1]}`, textSecrets[2])
    );
    await processQueuedSubmission(textEnv);
    const textReview = await expectRedactedReview(textEnv, textSubmission, textSecrets);
    const textPublicationResponse = await decide(textEnv, textSubmission, {
      decision: 'publish',
      draft: editableDraft(textReview.draft)
    });
    expect(textPublicationResponse.status).toBe(200);
    const textPublication = await textPublicationResponse.text();
    expect(textPublication).toContain(REDACTION_MARKER);
    for (const secret of textSecrets) expect(textPublication).not.toContain(secret);

    const urlEnv = createEnvironment();
    urlEnv.UNBLOCKER_ORG_API_KEY = 'server-only-secret';
    const urlSecrets = ['url-secret-value', '123-45-6789'];
    await withWebAccessStub(
      () => webAccessResponse(candidateSource('URL Candidate', `Password: ${urlSecrets[0]} and SSN ${urlSecrets[1]}`, 'Go')),
      async () => {
        const response = await worker.fetch(
          apiRequest('/api/submissions/url', 'POST', { url: 'https://www.linkedin.com/in/redacted-url-candidate' }),
          urlEnv
        );
        expect(response.status).toBe(202);
        const submission = await response.json();
        await processQueuedSubmission(urlEnv);
        await expectRedactedReview(urlEnv, submission, urlSecrets);
      }
    );

    const resumeEnv = createEnvironment();
    const resumeSecrets = ['4111 1111 1111 1111', '+44 20 7946 0958'];
    const resumeSource = candidateSource('Resume Candidate', `Payment ${resumeSecrets[0]} and mobile ${resumeSecrets[1]}`, 'Rust');
    const resumeResponse = await worker.fetch(resumeRequest(resumeSource), resumeEnv);
    expect(resumeResponse.status).toBe(202);
    const resumeSubmission = await resumeResponse.json();
    expect(new TextDecoder().decode(resumeEnv.RESUME_STAGING.puts[0].bytes)).toBe(resumeSource);
    await processQueuedSubmission(resumeEnv);
    await expectRedactedReview(resumeEnv, resumeSubmission, resumeSecrets);
    expect(resumeEnv.RESUME_STAGING.objects.size).toBe(0);
  });

  test('sanitizes a pre-existing private revision before returning it for review', async () => {
    const env = createEnvironment();
    const submission = await submit(env, candidateSource('Legacy Private Candidate', 'Safe summary', 'Go'));
    await processQueuedSubmission(env);
    const persisted = env.DB.revisions.get(submission.submissionId);
    const legacySecrets = ['legacy.private@example.com', 'password=legacy-private-value'];
    persisted.summary = `Contact ${legacySecrets[0]}`;
    persisted.skills_json = JSON.stringify(['Go', legacySecrets[1], { secret: 'nested-object-value' }]);

    expect(persisted.summary).toContain(legacySecrets[0]);
    const reviewText = JSON.stringify((await privateReview(env, submission)).draft);
    expect(reviewText).toContain(REDACTION_MARKER);
    expect(reviewText).not.toContain('nested-object-value');
    for (const secret of legacySecrets) expect(reviewText).not.toContain(secret);
  });

  test('rejects sensitive review edits and publishes safe candidate-approved fields unchanged', async () => {
    const env = createEnvironment();
    const submission = await submit(env, candidateSource('Approved Candidate', 'Safe summary', 'Go'));
    await processQueuedSubmission(env);
    const extracted = editableDraft((await privateReview(env, submission)).draft);
    const secret = 'candidate.edit@example.com';
    const sensitiveDraft = { ...extracted, summary: `Reach me at ${secret}` };

    const saveResponse = await worker.fetch(
      apiRequest(`/api/reviews/${submission.submissionId}`, 'PATCH', sensitiveDraft, submission.reviewToken),
      env
    );
    expect(saveResponse.status).toBe(400);
    expect(await saveResponse.text()).toBe('{"error":"sensitive_review_draft"}');
    expect(env.DB.revisions.get(submission.submissionId).summary).toBe('Safe summary');

    const rejectedPublication = await decide(env, submission, { decision: 'publish', draft: sensitiveDraft });
    expect(rejectedPublication.status).toBe(400);
    expect(await rejectedPublication.text()).toBe('{"error":"sensitive_review_draft"}');
    expect(env.DB.revisions.get(submission.submissionId).status).toBe('review_ready');

    const approvedDraft = {
      ...extracted,
      name: 'Ada Lovelace',
      role: 'Staff Engineer at 37signals',
      summary: 'C++, Go 1.22.3, ISO 27001, SOC 2, 2021 - 2024, https://ada.dev/portfolio?ref=hn',
      location: 'Toronto, Canada 02139',
      universities: ['MIT'],
      companies: ['37signals'],
      skills: ['C++', 'Go 1.22.3'],
      dateRanges: ['2021 - 2024']
    };
    const publicationResponse = await decide(env, submission, { decision: 'publish', draft: approvedDraft });
    expect(publicationResponse.status).toBe(200);
    expect((await publicationResponse.json()).candidate).toMatchObject({
      name: approvedDraft.name,
      role: approvedDraft.role,
      summary: approvedDraft.summary,
      location: approvedDraft.location,
      universities: approvedDraft.universities,
      companies: approvedDraft.companies,
      skills: approvedDraft.skills,
      dateRanges: approvedDraft.dateRanges
    });
  });

  test('sanitizes pre-existing published rows in list and idempotent decision responses', async () => {
    const env = createEnvironment();
    const publication = await publishSubmission(env, candidateSource('Legacy Public Candidate', 'Safe summary', 'Go'));
    const persisted = env.DB.revisions.get(publication.submission.submissionId);
    const legacySecrets = ['legacy.public@example.com', 'sk-live-secret-value-1234567890', '+1 (212) 555-0198'];
    persisted.summary = `Contact ${legacySecrets[0]}`;
    persisted.skills_json = JSON.stringify(['Go', legacySecrets[1]]);
    persisted.availability = legacySecrets[2];

    const publicText = JSON.stringify(await publicCandidates(env));
    expect(publicText).toContain(REDACTION_MARKER);
    for (const secret of legacySecrets) expect(publicText).not.toContain(secret);

    const retryResponse = await decide(env, publication.submission, { decision: 'publish', draft: {} });
    expect(retryResponse.status).toBe(200);
    const retryText = await retryResponse.text();
    expect(retryText).toContain(REDACTION_MARKER);
    for (const secret of legacySecrets) expect(retryText).not.toContain(secret);
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

function candidateSource(name, summary, skill) {
  return [
    `Name: ${name}`,
    'Role: Platform engineer',
    'Location: Toronto, Canada',
    'Work mode: Remote',
    'Availability: Immediate',
    'Education: University of Waterloo',
    'Companies: Example Systems',
    `Skills: ${skill}`,
    `Summary: ${summary}`
  ].join('\n');
}

async function expectRedactedReview(env, submission, secrets) {
  const review = await privateReview(env, submission);
  const reviewText = JSON.stringify(review.draft);
  expect(review.status).toBe('review_ready');
  expect(reviewText).toContain(REDACTION_MARKER);
  for (const secret of secrets) expect(reviewText).not.toContain(secret);
  return review;
}

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

function resumeRequest(body, overrides = {}) {
  const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body;
  return new Request('https://directory.example/api/submissions/resume', {
    method: 'POST',
    headers: {
      'content-type': overrides.contentType ?? 'text/plain; charset=utf-8',
      'x-resume-filename': overrides.filename ?? 'resume.txt'
    },
    body: bytes
  });
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
