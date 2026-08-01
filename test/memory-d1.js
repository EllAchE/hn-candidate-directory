export function createEnvironment() {
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
    if (this.sql.startsWith("UPDATE profile_revisions SET status = 'published'")) {
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
        publishedAt,
        updatedAt,
        submissionId
      ] = this.values;
      const revision = this.database.revisions.get(submissionId);
      if (revision?.status !== 'review_ready') return success(0);
      Object.assign(revision, {
        status: 'published',
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
        published_at: publishedAt,
        updated_at: updatedAt
      });
      return success();
    }
    if (this.sql.startsWith("UPDATE profile_revisions SET status = 'archived'")) {
      const [updatedAt, submissionId] = this.values;
      const revision = this.database.revisions.get(submissionId);
      if (!['review_ready', 'published'].includes(revision?.status)) return success(0);
      Object.assign(revision, { status: 'archived', published_at: null, updated_at: updatedAt });
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
      if (revision?.status !== 'review_ready') return success(0);
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

function success(changes = 1) {
  return { success: true, meta: { changes } };
}
