export function createEnvironment() {
  return {
    DB: new MemoryD1(),
    SUBMISSION_QUEUE: {
      messages: [],
      async send(message) {
        this.messages.push(message);
      },
      async sendBatch(entries) {
        entries.forEach((entry) => this.messages.push(entry.body));
      }
    }
  };
}

export async function deliverQueuedMessages(env, worker) {
  let acknowledged = 0;
  let retried = 0;
  const messages = env.SUBMISSION_QUEUE.messages.splice(0).map((body) => ({
    body,
    ack: () => {
      acknowledged += 1;
    },
    retry: () => {
      retried += 1;
    }
  }));
  await worker.queue({ messages }, env);
  return { delivered: messages.length, acknowledged, retried };
}

const EMPTY_STEP_OUT = Object.freeze({
  step_out: null,
  step_out_reason: null,
  step_out_at: null,
  step_out_count: 0,
  step_out_extractor: null
});
const PENDING_STATUSES = new Set(['submitted', 'processing', 'failed']);
const ABANDONED_STATUSES = new Set(['submitted', 'failed']);

class MemoryD1 {
  constructor() {
    this.submissions = new Map();
    this.jobs = new Map();
    this.revisions = new Map();
    this.hnIngests = new Map();
    this.rateLimits = new Map();
    this.serviceState = new Map();
    this.launchFeedback = [];
    this.batchTail = Promise.resolve();
  }

  prepare(sql) {
    return new MemoryStatement(this, sql);
  }

  async batch(statements) {
    const previousBatch = this.batchTail;
    let releaseBatch;
    this.batchTail = new Promise((resolve) => {
      releaseBatch = resolve;
    });
    await previousBatch;
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    } finally {
      releaseBatch();
    }
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
    if (this.sql === 'SELECT id, status FROM submissions WHERE id = ?') {
      const submission = this.database.submissions.get(this.values[0]);
      return submission ? select(submission, ['id', 'status']) : null;
    }
    if (this.sql === 'SELECT id FROM submissions WHERE id = ?') {
      const submission = this.database.submissions.get(this.values[0]);
      return submission ? select(submission, ['id']) : null;
    }
    if (this.sql === 'SELECT source_text, status FROM submissions WHERE id = ?') {
      const submission = this.database.submissions.get(this.values[0]);
      return submission ? select(submission, ['source_text', 'status']) : null;
    }
    if (this.sql === 'SELECT id, review_token_hash, status FROM submissions WHERE id = ?') {
      const submission = this.database.submissions.get(this.values[0]);
      return submission ? select(submission, ['id', 'review_token_hash', 'status']) : null;
    }
    if (this.sql.includes('JOIN submissions s ON s.id = r.submission_id') && this.sql.includes('WHERE r.id = ?')) {
      const revision = revisionById(this.database, this.values[0]);
      const submission = revision ? this.database.submissions.get(revision.submission_id) : null;
      return revision && submission
        ? {
            candidate_id: revision.id,
            submission_id: revision.submission_id,
            status: revision.status,
            review_token_hash: submission.review_token_hash
          }
        : null;
    }
    if (this.sql.includes('LEFT JOIN hn_ingests i ON i.submission_id = r.submission_id') && this.sql.includes('WHERE r.id = ?')) {
      const revision = revisionById(this.database, this.values[0]);
      if (!revision) return null;
      const ingest = [...this.database.hnIngests.values()].find((row) => row.submission_id === revision.submission_id);
      return {
        id: revision.id,
        submission_id: revision.submission_id,
        status: revision.status,
        hn_item_id: ingest?.hn_item_id ?? null,
        hn_author: ingest?.hn_author ?? null,
        suppressed_at: ingest?.suppressed_at ?? null
      };
    }
    if (this.sql.startsWith('SELECT hn_item_id FROM hn_ingests WHERE hn_author = ?')) {
      const ingest = [...this.database.hnIngests.values()].find((row) => row.suppressed_at && row.hn_author.toLowerCase() === this.values[0].toLowerCase());
      return ingest ? { hn_item_id: ingest.hn_item_id } : null;
    }
    if (this.sql.includes('FROM hn_ingests') && this.sql.includes('WHERE hn_item_id = ?')) {
      const ingest = this.database.hnIngests.get(this.values[0]);
      return ingest ? select(ingest, ['submission_id', 'comment_hash', 'suppressed_at']) : null;
    }
    if (this.sql.includes('FROM profile_revisions') && this.sql.includes('WHERE submission_id = ?')) {
      return this.database.revisions.get(this.values[0]) || null;
    }
    if (this.sql.startsWith('INSERT INTO rate_limits')) {
      const [bucket, windowStart, updatedAt] = this.values;
      const existing = this.database.rateLimits.get(bucket);
      const hits = existing && existing.window_start === windowStart ? existing.hits + 1 : 1;
      this.database.rateLimits.set(bucket, { bucket, window_start: windowStart, hits, updated_at: updatedAt });
      return { hits };
    }
    if (this.sql === 'SELECT value FROM service_state WHERE key = ?') {
      const state = this.database.serviceState.get(this.values[0]);
      return state ? { value: state.value } : null;
    }
    if (this.sql.startsWith('SELECT COUNT(*) AS retired FROM hn_ingests')) {
      const retired = [...this.database.hnIngests.values()].filter(
        (ingest) => ingest.step_out_reason === this.values[0] && ingest.step_out === 'retired' && ingest.suppressed_at === null
      ).length;
      return { retired };
    }
    if (this.sql.startsWith('SELECT COUNT(*) AS recovered FROM hn_ingests')) {
      const recovered = [...this.database.hnIngests.values()].filter(
        (ingest) => ingest.step_out === null && (ingest.step_out_count ?? 0) > 0 && ingest.suppressed_at === null
      ).length;
      return { recovered };
    }
    if (this.sql.startsWith('SELECT COUNT(*) AS pending FROM hn_ingests')) {
      const pending = [...this.database.hnIngests.values()].filter(
        (ingest) => ingest.suppressed_at === null && (ingest.extractor_rank ?? 0) < this.values[0]
      ).length;
      return { pending };
    }
    if (this.sql.startsWith('SELECT COUNT(*) AS total FROM submissions')) {
      return { total: [...this.database.submissions.values()].filter((row) => PENDING_STATUSES.has(row.status)).length };
    }
    throw new Error(`Unsupported first statement: ${this.sql}`);
  }

  async all() {
    if (this.sql.startsWith('SELECT hn_item_id, step_out, step_out_reason, suppressed_at FROM hn_ingests')) {
      const results = this.values
        .map((itemId) => this.database.hnIngests.get(itemId))
        .filter(Boolean)
        .map((ingest) => select(ingest, ['hn_item_id', 'step_out', 'step_out_reason', 'suppressed_at']));
      return { results };
    }
    if (this.sql.startsWith('SELECT step_out, step_out_reason, COUNT(*) AS items FROM hn_ingests')) {
      const groups = new Map();
      for (const ingest of this.database.hnIngests.values()) {
        if (!ingest.step_out || ingest.suppressed_at !== null) continue;
        const key = `${ingest.step_out}\u0000${ingest.step_out_reason}`;
        const group = groups.get(key) || { step_out: ingest.step_out, step_out_reason: ingest.step_out_reason, items: 0 };
        group.items += 1;
        groups.set(key, group);
      }
      const results = [...groups.values()].sort(
        (a, b) => a.step_out.localeCompare(b.step_out) || a.step_out_reason.localeCompare(b.step_out_reason)
      );
      return { results };
    }
    if (this.sql.startsWith('SELECT hn_item_id, step_out, step_out_at, step_out_count, step_out_extractor FROM hn_ingests')) {
      const [reason, stepOut, after, limit] = this.values;
      const results = [...this.database.hnIngests.values()]
        .filter(
          (ingest) =>
            ingest.step_out_reason === reason &&
            ingest.step_out !== null &&
            ingest.step_out === (stepOut ?? ingest.step_out) &&
            ingest.hn_item_id > after &&
            ingest.suppressed_at === null
        )
        .sort((a, b) => a.hn_item_id.localeCompare(b.hn_item_id))
        .slice(0, limit)
        .map((ingest) => select(ingest, ['hn_item_id', 'step_out', 'step_out_at', 'step_out_count', 'step_out_extractor']));
      return { results };
    }
    if (this.sql.includes('FROM hn_ingests i')) {
      return {
        results: this.values
          .map((itemId) => this.database.hnIngests.get(itemId))
          .filter(Boolean)
          .map((ingest) => {
            const revision = ingest.submission_id ? this.database.revisions.get(ingest.submission_id) : null;
            return {
              hn_item_id: ingest.hn_item_id,
              submission_id: ingest.submission_id,
              suppressed_at: ingest.suppressed_at,
              comment_hash: ingest.comment_hash,
              extractor_rank: ingest.extractor_rank ?? 0,
              step_out: ingest.step_out ?? null,
              step_out_reason: ingest.step_out_reason ?? null,
              revision_status: revision?.status ?? null,
              revision_rank: revision?.extractor_rank ?? null
            };
          })
      };
    }
    if (this.sql.includes('FROM hn_ingests') && this.sql.includes('AND extractor_rank < ?')) {
      const [rank, limit] = this.values;
      const results = [...this.database.hnIngests.values()]
        .filter((ingest) => ingest.suppressed_at === null && (ingest.extractor_rank ?? 0) < rank)
        .sort((a, b) => b.comment_created_at.localeCompare(a.comment_created_at) || a.hn_item_id.localeCompare(b.hn_item_id))
        .slice(0, limit);
      return { results };
    }
    if (this.sql.includes('FROM hn_ingests') && this.sql.includes('WHERE thread_id = ?')) {
      const results = [...this.database.hnIngests.values()]
        .filter((ingest) => ingest.thread_id === this.values[0])
        .map((ingest) => select(ingest, ['hn_item_id', 'comment_hash', 'suppressed_at']));
      return { results };
    }
    if (this.sql.startsWith('WITH eligible AS')) {
      const ingestsBySubmission = new Map([...this.database.hnIngests.values()].map((ingest) => [ingest.submission_id, ingest]));
      const suppressedAuthors = new Set([...this.database.hnIngests.values()].filter((ingest) => ingest.suppressed_at).map((ingest) => String(ingest.hn_author || '').toLowerCase()));
      let rows = [...this.database.revisions.values()]
        .filter((revision) => revision.status === 'published')
        .map((revision) => {
          const ingest = ingestsBySubmission.get(revision.submission_id);
          const accountKey = String(ingest?.hn_author || revision.hn_username || '').trim().toLowerCase();
          return { ...revision, ...hnJoinColumns(ingest),
            source_created_at: ingest?.comment_created_at || revision.published_at,
            person_key: ingest?.hn_permalink && accountKey ? `hn:${accountKey}` : `profile:${revision.id}`,
            account_suppressed: ingest && suppressedAuthors.has(String(ingest.hn_author || '').toLowerCase())
          };
        })
        .filter((revision) => revision.suppressed_at === null && !revision.account_suppressed);
      if (this.sql.includes("AND COALESCE(NULLIF(i.hn_author, ''), r.hn_username) = ? COLLATE NOCASE")) {
        const username = String(this.values[0]).toLowerCase();
        rows = rows.filter((revision) => String(revision.hn_author || revision.hn_username || '').toLowerCase() === username);
      }
      rows.sort((left, right) => right.source_created_at.localeCompare(left.source_created_at) || left.id.localeCompare(right.id));
      const groups = new Map();
      for (const row of rows) {
        const group = groups.get(row.person_key) || [];
        group.push(row);
        groups.set(row.person_key, group);
      }
      const [limit, offset] = this.values.slice(-2);
      return { results: [...groups.values()].slice(offset, offset + limit).flat() };
    }
    throw new Error(`Unsupported all statement: ${this.sql}`);
  }

  async run() {
    const [first, ...rest] = this.values;
    if (this.sql.startsWith("DELETE FROM submissions WHERE status IN ('submitted', 'failed')")) {
      const stale = [...this.database.submissions.values()].filter(
        (row) => ABANDONED_STATUSES.has(row.status) && row.updated_at < first
      );
      stale.forEach((row) => this.database.submissions.delete(row.id));
      return success(stale.length);
    }
    if (this.sql.startsWith('DELETE FROM rate_limits')) {
      const stale = [...this.database.rateLimits.values()].filter((row) => row.window_start < first);
      stale.forEach((row) => this.database.rateLimits.delete(row.bucket));
      return success(stale.length);
    }
    if (this.sql.startsWith('INSERT INTO launch_feedback')) {
      const [id, message, contact, candidateId, createdAt] = this.values;
      this.database.launchFeedback.push({
        id,
        message,
        contact,
        candidate_id: candidateId,
        created_at: createdAt
      });
      return success();
    }
    if (this.sql.startsWith('INSERT INTO service_state')) {
      this.database.serviceState.set('pending_submissions', {
        key: 'pending_submissions',
        value: first,
        updated_at: rest[0]
      });
      return success();
    }
    if (this.sql.startsWith('INSERT INTO submissions') && this.sql.includes("'hn_comment'")) {
      const [id, reviewTokenHash, createdAt, updatedAt] = this.values;
      const existing = this.database.submissions.get(id);
      if (existing) {
        Object.assign(existing, { status: 'ingested', updated_at: updatedAt });
        return success();
      }
      this.database.submissions.set(id, {
        id,
        source_kind: 'hn_comment',
        source_text: '',
        review_token_hash: reviewTokenHash,
        status: 'ingested',
        created_at: createdAt,
        updated_at: updatedAt
      });
      return success();
    }
    if (this.sql.startsWith('INSERT INTO profile_revisions') && this.sql.includes("'published'")) {
      const [
        id,
        submissionId,
        name,
        role,
        summary,
        location,
        workMode,
        availability,
        hnUsername,
        linkedinUrl,
        githubUrl,
        personalUrl,
        universitiesJson,
        companiesJson,
        skillsJson,
        dateRangesJson,
        experienceJson,
        createdAt,
        updatedAt,
        publishedAt,
        extractor,
        extractorRank
      ] = this.values;
      const fields = {
        name,
        role,
        summary,
        location,
        work_mode: workMode,
        availability,
        hn_username: hnUsername,
        linkedin_url: linkedinUrl,
        github_url: githubUrl,
        personal_url: personalUrl,
        universities_json: universitiesJson,
        companies_json: companiesJson,
        skills_json: skillsJson,
        date_ranges_json: dateRangesJson,
        experience_json: experienceJson,
        experienceJson,
        updated_at: updatedAt,
        extractor,
        extractor_rank: extractorRank
      };
      const existing = this.database.revisions.get(submissionId);
      if (existing) {
        if (existing.status !== 'published') return success(0);
        if ((existing.extractor_rank ?? 0) > extractorRank) return success(0);
        Object.assign(existing, fields);
        return success();
      }
      this.database.revisions.set(submissionId, {
        id,
        submission_id: submissionId,
        status: 'published',
        ...fields,
        created_at: createdAt,
        published_at: publishedAt
      });
      return success();
    }
    if (this.sql.startsWith('INSERT INTO hn_ingests')) {
      const [
        hnItemId,
        submissionId,
        hnAuthor,
        hnPermalink,
        threadId,
        threadMonth,
        commentHash,
        commentCreatedAt,
        createdAt,
        updatedAt,
        extractorRank,
        resumeUrl,
        resumeFetchedAt
      ] = this.values;
      const fields = {
        submission_id: submissionId,
        hn_author: hnAuthor,
        hn_permalink: hnPermalink,
        thread_id: threadId,
        thread_month: threadMonth,
        comment_hash: commentHash,
        updated_at: updatedAt
      };
      const existing = this.database.hnIngests.get(hnItemId);
      if (existing) {
        if (existing.suppressed_at !== null) return success(0);
        const unchangedText = existing.comment_hash === commentHash;
        Object.assign(existing, fields, {
          resume_url: resumeUrl ?? existing.resume_url ?? null,
          resume_fetched_at: resumeFetchedAt ?? existing.resume_fetched_at ?? null,
          extractor_rank: unchangedText ? Math.max(existing.extractor_rank ?? 0, extractorRank) : extractorRank
        });
        return success();
      }
      this.database.hnIngests.set(hnItemId, {
        hn_item_id: hnItemId,
        ...fields,
        comment_created_at: commentCreatedAt,
        suppressed_at: null,
        suppressed_reason: null,
        created_at: createdAt,
        extractor_rank: extractorRank,
        resume_url: resumeUrl ?? null,
        resume_fetched_at: resumeFetchedAt ?? null,
        ...EMPTY_STEP_OUT
      });
      return success();
    }
    if (this.sql.startsWith('INSERT INTO submissions')) {
      const [id, sourceText, reviewTokenHash, createdAt, updatedAt] = this.values;
      if (this.database.submissions.has(id)) throw new Error('constraint_failed');
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
    if (this.sql.startsWith("UPDATE submissions SET source_text = ?, review_token_hash = ?, status = 'submitted'")) {
      const [sourceText, reviewTokenHash, updatedAt, submissionId, jobSubmissionId] = this.values;
      const submission = this.database.submissions.get(submissionId);
      const job = this.database.jobs.get(jobSubmissionId);
      if (submission?.status !== 'failed' || job?.status !== 'failed') return success(0);
      Object.assign(submission, { source_text: sourceText, review_token_hash: reviewTokenHash, status: 'submitted', updated_at: updatedAt });
      return success();
    }
    if (this.sql.startsWith("UPDATE jobs SET status = 'queued'")) {
      const [updatedAt, submissionId] = this.values;
      const job = this.database.jobs.get(submissionId);
      if (job?.status !== 'failed') return success(0);
      Object.assign(job, { status: 'queued', attempts: 0, error: null, updated_at: updatedAt });
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
        hnUsername,
        linkedinUrl,
        githubUrl,
        personalUrl,
        universitiesJson,
        companiesJson,
        skillsJson,
        dateRangesJson,
        experienceJson,
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
        hn_username: hnUsername,
        linkedin_url: linkedinUrl,
        github_url: githubUrl,
        personal_url: personalUrl,
        universities_json: universitiesJson,
        companies_json: companiesJson,
        skills_json: skillsJson,
        date_ranges_json: dateRangesJson,
        experience_json: experienceJson,
        experienceJson,
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
        hnUsername,
        linkedinUrl,
        githubUrl,
        personalUrl,
        universitiesJson,
        companiesJson,
        skillsJson,
        dateRangesJson,
        experienceJson,
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
        hn_username: hnUsername,
        linkedin_url: linkedinUrl,
        github_url: githubUrl,
        personal_url: personalUrl,
        universities_json: universitiesJson,
        companies_json: companiesJson,
        skills_json: skillsJson,
        date_ranges_json: dateRangesJson,
        experience_json: experienceJson,
        experienceJson,
        published_at: publishedAt,
        updated_at: updatedAt
      });
      return success();
    }
    if (this.sql.startsWith("UPDATE profile_revisions SET status = 'review_ready'")) {
      const [updatedAt, candidateId, submissionId] = this.values;
      const revision = revisionById(this.database, candidateId);
      if (revision?.submission_id !== submissionId || revision.status !== 'published') return success(0);
      Object.assign(revision, { status: 'review_ready', published_at: null, updated_at: updatedAt });
      return success();
    }
    if (this.sql === "UPDATE profile_revisions SET status = 'archived', published_at = NULL, updated_at = ? WHERE id = ?") {
      const [updatedAt, candidateId] = this.values;
      const revision = revisionById(this.database, candidateId);
      if (!revision) return success(0);
      Object.assign(revision, { status: 'archived', published_at: null, updated_at: updatedAt });
      return success();
    }
    if (this.sql.startsWith('UPDATE hn_ingests SET extractor_rank = MAX(extractor_rank, ?), step_out = ?')) {
      const [rank, stepOut, reason, stepOutAt, extractor, updatedAt, hnItemId] = this.values;
      const ingest = this.database.hnIngests.get(hnItemId);
      if (!ingest || ingest.suppressed_at !== null) return success(0);
      Object.assign(ingest, {
        extractor_rank: Math.max(ingest.extractor_rank ?? 0, rank),
        step_out: stepOut,
        step_out_reason: reason,
        step_out_at: stepOutAt,
        step_out_extractor: extractor,
        step_out_count: (ingest.step_out_count ?? 0) + 1,
        updated_at: updatedAt
      });
      return success();
    }
    if (this.sql.startsWith('UPDATE hn_ingests SET step_out = ?, step_out_reason = ?')) {
      const [stepOut, reason, stepOutAt, extractor, updatedAt, hnItemId] = this.values;
      const ingest = this.database.hnIngests.get(hnItemId);
      if (!ingest || ingest.suppressed_at !== null) return success(0);
      const upgradable = ['held', 'retired'].includes(ingest.step_out) && ingest.step_out_reason === 'unrecorded';
      if (ingest.step_out && !upgradable) return success(0);
      Object.assign(ingest, {
        step_out_count: ingest.step_out ? ingest.step_out_count : (ingest.step_out_count ?? 0) + 1,
        step_out: stepOut,
        step_out_reason: reason,
        step_out_at: ingest.step_out_at ?? stepOutAt,
        step_out_extractor: ingest.step_out_extractor ?? extractor,
        updated_at: updatedAt
      });
      return success();
    }
    if (this.sql.startsWith('UPDATE hn_ingests SET step_out = NULL')) {
      const ingest = this.database.hnIngests.get(this.values[0]);
      if (!ingest?.step_out) return success(0);
      Object.assign(ingest, { step_out: null, step_out_reason: null, step_out_at: null });
      return success();
    }
    if (this.sql.startsWith("UPDATE hn_ingests SET step_out = 'requeued'") && this.sql.includes('WHERE step_out_reason = ?')) {
      const [rank, updatedAt, reason] = this.values;
      const rows = [...this.database.hnIngests.values()].filter(
        (ingest) => ingest.step_out_reason === reason && ingest.step_out === 'held' && ingest.suppressed_at === null
      );
      rows.forEach((ingest) =>
        Object.assign(ingest, { step_out: 'requeued', extractor_rank: Math.min(ingest.extractor_rank ?? 0, rank), updated_at: updatedAt })
      );
      return success(rows.length);
    }
    if (this.sql.startsWith("UPDATE hn_ingests SET step_out = 'requeued'") && this.sql.includes('WHERE hn_item_id = ?')) {
      const [rank, updatedAt, hnItemId] = this.values;
      const ingest = this.database.hnIngests.get(hnItemId);
      if (!ingest || !['held', 'retired'].includes(ingest.step_out) || ingest.suppressed_at !== null) return success(0);
      Object.assign(ingest, { step_out: 'requeued', extractor_rank: Math.min(ingest.extractor_rank ?? 0, rank), updated_at: updatedAt });
      return success();
    }
    if (this.sql.startsWith('UPDATE hn_ingests SET suppressed_at = ?') && this.sql.includes('WHERE hn_author = ?')) {
      const [suppressedAt, updatedAt, author] = this.values;
      const ingests = [...this.database.hnIngests.values()].filter((row) => row.hn_author.toLowerCase() === author.toLowerCase());
      ingests.forEach((row) => Object.assign(row, { suppressed_at: suppressedAt, updated_at: updatedAt }));
      return success(ingests.length);
    }
    if (this.sql.startsWith("UPDATE profile_revisions SET status = 'archived'") && this.sql.includes('WHERE submission_id IN')) {
      const [updatedAt, identity] = this.values;
      const ingests = [...this.database.hnIngests.values()].filter((row) => this.sql.includes('WHERE hn_author = ?')
        ? row.hn_author.toLowerCase() === identity.toLowerCase() : row.submission_id === identity);
      const revisions = ingests.map((row) => this.database.revisions.get(row.submission_id)).filter(Boolean);
      revisions.forEach((row) => Object.assign(row, { status: 'archived', published_at: null, updated_at: updatedAt }));
      return success(revisions.length);
    }
    if (this.sql === 'UPDATE hn_ingests SET suppressed_at = ?, updated_at = ? WHERE submission_id = ?') {
      const [suppressedAt, updatedAt, submissionId] = this.values;
      const ingest = [...this.database.hnIngests.values()].find((row) => row.submission_id === submissionId);
      if (!ingest) return success(0);
      Object.assign(ingest, { suppressed_at: suppressedAt, updated_at: updatedAt });
      return success();
    }
    if (this.sql.startsWith("UPDATE profile_revisions SET status = 'archived'") && this.sql.includes('WHERE id = ?')) {
      const [updatedAt, candidateId, submissionId] = this.values;
      const revision = revisionById(this.database, candidateId);
      if (revision?.submission_id !== submissionId || !['review_ready', 'published'].includes(revision.status)) return success(0);
      Object.assign(revision, { status: 'archived', published_at: null, updated_at: updatedAt });
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
        hnUsername,
        linkedinUrl,
        githubUrl,
        personalUrl,
        universitiesJson,
        companiesJson,
        skillsJson,
        dateRangesJson,
        experienceJson,
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
        hn_username: hnUsername,
        linkedin_url: linkedinUrl,
        github_url: githubUrl,
        personal_url: personalUrl,
        universities_json: universitiesJson,
        companies_json: companiesJson,
        skills_json: skillsJson,
        date_ranges_json: dateRangesJson,
        experience_json: experienceJson,
        experienceJson,
        updated_at: updatedAt
      });
      return success();
    }
    if (this.sql.startsWith("UPDATE submissions SET status = 'failed'")) {
      const [updatedAt, submissionId] = this.values;
      const submission = this.database.submissions.get(submissionId);
      if (!submission) return success(0);
      Object.assign(submission, { status: 'failed', updated_at: updatedAt });
      return success();
    }
    if (this.sql.startsWith("UPDATE jobs SET status = 'failed'")) {
      const queueFailure = this.sql.includes("error = 'queue_unavailable'");
      const extractionFailure = this.sql.includes("error = 'extraction_failed'");
      const [error, updatedAt, submissionId] = queueFailure
        ? ['queue_unavailable', this.values[0], this.values[1]]
        : extractionFailure
          ? ['extraction_failed', this.values[0], this.values[1]]
          : this.values;
      const job = this.database.jobs.get(submissionId);
      if (!job) return success(0);
      Object.assign(job, { status: 'failed', error, updated_at: updatedAt });
      return success();
    }
    throw new Error(`Unsupported run statement: ${this.sql}`);
  }
}

function select(value, keys) {
  return Object.fromEntries(keys.map((key) => [key, value[key]]));
}

function hnJoinColumns(ingest) {
  return {
    hn_author: ingest?.hn_author ?? null,
    hn_permalink: ingest?.hn_permalink ?? null,
    thread_month: ingest?.thread_month ?? null,
    extractor_rank: ingest?.extractor_rank ?? null,
    suppressed_at: ingest?.suppressed_at ?? null
  };
}

function revisionById(database, candidateId) {
  return [...database.revisions.values()].find((revision) => revision.id === candidateId) || null;
}

function success(changes = 1) {
  return { success: true, meta: { changes } };
}
