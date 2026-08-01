import { describe, expect, test } from 'bun:test';
import worker, { MAX_SOURCE_BYTES, extractProfile } from '../worker.js';

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

    env.DB.publish(submission.submissionId);
    const published = await publicCandidates(env);
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ name: 'Ada Candidate', summary: 'A candidate-reviewed summary.', skills: ['Rust', 'SQLite'] });
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

function createEnvironment() {
  return {
    DB: new MemoryD1(),
    SUBMISSION_QUEUE: {
      messages: [],
      async send(message) {
        this.messages.push(message);
      }
    }
  };
}

class MemoryD1 {
  constructor() {
    this.submissions = new Map();
    this.jobs = new Map();
    this.revisions = new Map();
  }

  prepare(sql) {
    return new MemoryStatement(this, sql);
  }

  async batch(statements) {
    return Promise.all(statements.map((statement) => statement.run()));
  }

  publish(submissionId) {
    const revision = this.revisions.get(submissionId);
    revision.status = 'published';
    revision.published_at = new Date().toISOString();
  }
}

class MemoryStatement {
  constructor(database, sql, values = []) {
    this.database = database;
    this.sql = sql.replace(/\s+/g, ' ').trim();
    this.values = values;
  }

  bind(...values) {
    return new MemoryStatement(this.database, this.sql, values);
  }

  async first() {
    if (this.sql === 'SELECT source_text, status FROM submissions WHERE id = ?') {
      const submission = this.database.submissions.get(this.values[0]);
      return submission ? select(submission, ['source_text', 'status']) : null;
    }
    if (this.sql === 'SELECT id, review_token_hash, status FROM submissions WHERE id = ?') {
      const submission = this.database.submissions.get(this.values[0]);
      return submission ? select(submission, ['id', 'review_token_hash', 'status']) : null;
    }
    if (this.sql.includes('FROM profile_revisions') && this.sql.includes('WHERE submission_id = ?')) {
      return this.database.revisions.get(this.values[0]) || null;
    }
    throw new Error(`Unsupported first statement: ${this.sql}`);
  }

  async all() {
    if (this.sql.includes("WHERE status = 'published'")) {
      const results = [...this.database.revisions.values()]
        .filter((revision) => revision.status === 'published')
        .sort((left, right) => right.published_at.localeCompare(left.published_at));
      return { results };
    }
    throw new Error(`Unsupported all statement: ${this.sql}`);
  }

  async run() {
    const [first, ...rest] = this.values;
    if (this.sql.startsWith('INSERT INTO submissions')) {
      const [id, sourceText, reviewTokenHash, createdAt, updatedAt] = this.values;
      this.database.submissions.set(id, {
        id,
        source_kind: 'text',
        source_text: sourceText,
        review_token_hash: reviewTokenHash,
        status: 'submitted',
        created_at: createdAt,
        updated_at: updatedAt
      });
      return success();
    }
    if (this.sql.startsWith('INSERT INTO jobs')) {
      const [id, submissionId, createdAt, updatedAt] = this.values;
      this.database.jobs.set(submissionId, {
        id,
        submission_id: submissionId,
        kind: 'extract_profile',
        status: 'queued',
        attempts: 0,
        error: null,
        created_at: createdAt,
        updated_at: updatedAt
      });
      return success();
    }
    if (this.sql.startsWith("UPDATE submissions SET status = 'processing'")) {
      const submission = this.database.submissions.get(rest[0]);
      if (submission?.status !== 'review_ready') Object.assign(submission, { status: 'processing', updated_at: first });
      return success();
    }
    if (this.sql.startsWith("UPDATE jobs SET status = 'processing'")) {
      const job = this.database.jobs.get(rest[0]);
      Object.assign(job, { status: 'processing', attempts: job.attempts + 1, updated_at: first });
      return success();
    }
    if (this.sql.startsWith('INSERT INTO profile_revisions')) {
      const [
        id,
        submissionId,
        name,
        role,
        summary,
        location,
        workMode,
        availability,
        universitiesJson,
        companiesJson,
        skillsJson,
        dateRangesJson,
        createdAt,
        updatedAt
      ] = this.values;
      this.database.revisions.set(submissionId, {
        id,
        submission_id: submissionId,
        status: 'review_ready',
        name,
        role,
        summary,
        location,
        work_mode: workMode,
        availability,
        universities_json: universitiesJson,
        companies_json: companiesJson,
        skills_json: skillsJson,
        date_ranges_json: dateRangesJson,
        created_at: createdAt,
        updated_at: updatedAt,
        published_at: null
      });
      return success();
    }
    if (this.sql.startsWith("UPDATE submissions SET status = 'review_ready'")) {
      const submission = this.database.submissions.get(rest[0]);
      Object.assign(submission, { status: 'review_ready', source_text: '', updated_at: first });
      return success();
    }
    if (this.sql.startsWith("UPDATE jobs SET status = 'completed'")) {
      const job = this.database.jobs.get(rest[0]);
      Object.assign(job, { status: 'completed', error: null, updated_at: first });
      return success();
    }
    if (this.sql.startsWith('UPDATE profile_revisions')) {
      const [
        name,
        role,
        summary,
        location,
        workMode,
        availability,
        universitiesJson,
        companiesJson,
        skillsJson,
        dateRangesJson,
        updatedAt,
        submissionId
      ] = this.values;
      const revision = this.database.revisions.get(submissionId);
      Object.assign(revision, {
        name,
        role,
        summary,
        location,
        work_mode: workMode,
        availability,
        universities_json: universitiesJson,
        companies_json: companiesJson,
        skills_json: skillsJson,
        date_ranges_json: dateRangesJson,
        updated_at: updatedAt
      });
      return success();
    }
    if (this.sql.startsWith("UPDATE submissions SET status = 'failed'")) return success();
    if (this.sql.startsWith("UPDATE jobs SET status = 'failed'")) return success();
    throw new Error(`Unsupported run statement: ${this.sql}`);
  }
}

function select(value, keys) {
  return Object.fromEntries(keys.map((key) => [key, value[key]]));
}

function success() {
  return { success: true };
}
