import { describe, expect, test } from 'bun:test';
import worker, {
  HN_EXTRACTION_VERSION,
  HN_PUSH_LIMITS,
  decodeHnCommentText,
  hnCommentHash,
  ingestHackerNews
} from '../worker.js';
import { REDACTION_MARKER } from '../sensitive-data.js';
import { createEnvironment, deliverQueuedMessages } from './memory-d1.js';

const TOKEN = 'push-token-that-is-long-enough-to-be-usable';

const THREAD = {
  objectID: '44444444',
  title: 'Ask HN: Who wants to be hired? (August 2026)',
  author: 'whoishiring',
  created_at: '2026-08-03T15:00:00.000Z'
};

// Prose employment and education, with no `Companies:` or `Education:` label anywhere -- the exact
// shape the deterministic extractor cannot read and the whole reason this endpoint exists.
const PROSE_COMMENT = {
  objectID: '44444501',
  parent_id: 44444444,
  author: 'proseposter',
  created_at: '2026-08-03T16:12:00.000Z',
  comment_text: [
    'Location: Toronto, Canada',
    'Remote: Yes',
    'Technologies: Rust, Go, Kubernetes',
    'I spent four years at Stripe on payments infrastructure after finishing my degree at the ' +
      'University of Waterloo, and the two years since at Example Systems building storage.'
  ].join('<p>')
};

const SECOND_COMMENT = {
  objectID: '44444502',
  parent_id: 44444444,
  author: 'secondposter',
  created_at: '2026-08-03T17:40:00.000Z',
  comment_text: ['Location: Berlin, Germany', 'Technologies: Python, Django', 'Ten years in data engineering.'].join('<p>')
};

const NOISE_COMMENT = {
  objectID: '44444503',
  parent_id: 44444444,
  author: 'noiseposter',
  created_at: '2026-08-03T18:05:00.000Z',
  comment_text: 'Good luck everyone!'
};

describe('pushing externally-extracted HN profiles', () => {
  test('requires a usable secret, a token, and the right token', async () => {
    const env = createEnvironment();

    for (const secret of [undefined, '', '   ', 'too-short-to-be-usable']) {
      env.HN_INGEST_TOKEN = secret;
      const response = await push(env, [item()], TOKEN);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: 'ingest_not_configured' });
    }

    env.HN_INGEST_TOKEN = TOKEN;
    expect((await push(env, [item()], '')).status).toBe(401);
    expect((await push(env, [item()], `${TOKEN}-wrong`)).status).toBe(403);
  });

  test('rejects the wrong method on both routes', async () => {
    const env = configured();
    expect((await worker.fetch(apiRequest('/api/admin/profiles/hn', 'GET', null, TOKEN), env)).status).toBe(405);
    expect((await worker.fetch(apiRequest('/api/admin/profiles/hn/pending', 'POST', {}, TOKEN), env)).status).toBe(405);
  });

  test('rejects an unusable batch before touching the database', async () => {
    const env = configured();

    const wrongType = await worker.fetch(
      new Request('https://directory.example/api/admin/profiles/hn', {
        method: 'POST',
        headers: { 'content-type': 'text/plain', authorization: `Bearer ${TOKEN}` },
        body: 'not json'
      }),
      env
    );
    expect(wrongType.status).toBe(415);

    for (const extractor of [null, 'nonexistent-extractor-v9', 'deterministic-labels-v1']) {
      const response = await push(env, [item()], TOKEN, extractor);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'unknown_extractor' });
    }

    expect((await push(env, [], TOKEN)).status).toBe(400);

    const oversized = await push(env, Array.from({ length: HN_PUSH_LIMITS.batch + 1 }, () => item()), TOKEN);
    expect(oversized.status).toBe(413);
    expect((await oversized.json()).error).toBe('batch_too_large');

    expect(env.DB.revisions.size).toBe(0);
    expect(env.DB.hnIngests.size).toBe(0);
  });

  test('creates a profile for a comment the cron has never seen, and derives its permalink', async () => {
    const env = configured();

    const response = await push(env, [
      {
        ...item(PROSE_COMMENT, { companies: ['Stripe', 'Example Systems'], universities: ['University of Waterloo'] }),
        comment: { ...commentBody(PROSE_COMMENT), permalink: 'https://phishing.example/steal' }
      }
    ]);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.results).toEqual([{ hnItemId: '44444501', outcome: 'created', redacted: false }]);

    const revision = env.DB.revisions.get('hn-44444501');
    expect(revision.companies_json).toBe(JSON.stringify(['Stripe', 'Example Systems']));
    expect(revision.universities_json).toBe(JSON.stringify(['University of Waterloo']));
    expect(revision.extractor).toBe('claude-skill-v1');

    // A client-supplied permalink renders as the public source link, so accepting one would let
    // anyone holding the ingest token publish a phishing URL onto a candidate card.
    expect(env.DB.hnIngests.get('44444501').hn_permalink).toBe('https://news.ycombinator.com/item?id=44444501');
  });

  test('upgrades a cron-ingested profile in place and records the honest comment hash', async () => {
    const env = configured();
    await ingestThread(env);

    const before = env.DB.revisions.get('hn-44444501');
    expect(JSON.parse(before.companies_json)).toEqual([]);
    const revisionId = before.id;
    const publishedAt = before.published_at;
    const submissions = env.DB.submissions.size;

    const response = await push(env, [
      item(PROSE_COMMENT, { companies: ['Stripe'], universities: ['University of Waterloo'] })
    ]);
    expect((await response.json()).results[0].outcome).toBe('updated');

    const after = env.DB.revisions.get('hn-44444501');
    expect(after.id).toBe(revisionId);
    expect(after.published_at).toBe(publishedAt);
    expect(JSON.parse(after.companies_json)).toEqual(['Stripe']);
    expect(env.DB.submissions.size).toBe(submissions);

    // The hash stays the value the deterministic pipeline would have written for this text. Writing
    // anything else would either re-queue the comment forever or blind edit detection permanently.
    expect(env.DB.hnIngests.get('44444501').comment_hash).toBe(
      await hnCommentHash(decodeHnCommentText(PROSE_COMMENT.comment_text), HN_EXTRACTION_VERSION)
    );
  });

  test('an ordinary cron run leaves a pushed profile alone', async () => {
    const env = configured();
    await ingestThread(env);
    await push(env, [item(PROSE_COMMENT, { companies: ['Stripe'] })]);

    const result = await ingestHackerNews(env, { transport: transport().fetch });
    expect(result.queued).toBe(0);
    expect(JSON.parse(env.DB.revisions.get('hn-44444501').companies_json)).toEqual(['Stripe']);
  });

  test('an extraction version bump re-derives without overwriting a better extractor', async () => {
    const env = configured();
    await ingestThread(env);
    await push(env, [item(PROSE_COMMENT, { companies: ['Stripe'], universities: ['University of Waterloo'] })]);

    const revision = env.DB.revisions.get('hn-44444501');
    const revisionId = revision.id;
    const publishedAt = revision.published_at;

    await ageToPreviousExtractorVersion(env);
    await ingestThread(env);

    // The deterministic pass runs, finds nothing in the prose, and is refused by the rank guard.
    // Without it, every version bump would silently undo every profile this endpoint ever wrote.
    const survived = env.DB.revisions.get('hn-44444501');
    expect(JSON.parse(survived.companies_json)).toEqual(['Stripe']);
    expect(JSON.parse(survived.universities_json)).toEqual(['University of Waterloo']);
    expect(survived.id).toBe(revisionId);
    expect(survived.published_at).toBe(publishedAt);

    // The ingest row still advanced, so the system settles in one run rather than re-queueing forever.
    expect((await ingestHackerNews(env, { transport: transport().fetch })).queued).toBe(0);
  });

  test('never resurrects a suppressed candidate', async () => {
    const env = configured();
    await ingestThread(env);
    suppress(env, '44444501');
    const tombstone = { ...env.DB.hnIngests.get('44444501') };

    const response = await push(env, [item(PROSE_COMMENT, { companies: ['Stripe'] })]);
    expect((await response.json()).results[0]).toEqual({ hnItemId: '44444501', outcome: 'skipped_suppressed' });

    expect(env.DB.hnIngests.get('44444501')).toEqual(tombstone);
    expect(env.DB.revisions.get('hn-44444501').status).toBe('archived');
    expect(await publicCandidateIds(env)).not.toContain('hn-44444501');
  });

  test('refuses to republish a revision that is no longer published', async () => {
    const env = configured();
    await ingestThread(env);
    env.DB.revisions.get('hn-44444501').status = 'archived';

    const response = await push(env, [item(PROSE_COMMENT, { companies: ['Stripe'] })]);
    expect((await response.json()).results[0]).toEqual({ hnItemId: '44444501', outcome: 'blocked_by_status' });
    expect(env.DB.revisions.get('hn-44444501').status).toBe('archived');
  });

  test('a malformed item costs only itself', async () => {
    const env = configured();

    const response = await push(env, [
      item(PROSE_COMMENT, { companies: ['Stripe'] }),
      { comment: commentBody(SECOND_COMMENT), draft: { ...draft(), summary: 'x'.repeat(2_001) } },
      item(NOISE_COMMENT)
    ]);

    expect((await response.json()).results.map((entry) => entry.outcome)).toEqual([
      'created',
      'invalid_draft',
      'created'
    ]);
    expect(env.DB.revisions.has('hn-44444502')).toBe(false);
    expect(env.DB.revisions.has('hn-44444501')).toBe(true);
    expect(env.DB.revisions.has('hn-44444503')).toBe(true);
  });

  test('rejects a comment envelope it cannot trust', async () => {
    const env = configured();
    const broken = [
      { ...commentBody(PROSE_COMMENT), itemId: '12a' },
      { ...commentBody(PROSE_COMMENT), threadId: 'not-a-thread' },
      { ...commentBody(PROSE_COMMENT), threadMonth: 'sometime in August' },
      { ...commentBody(PROSE_COMMENT), createdAt: 'the day before yesterday' },
      { ...commentBody(PROSE_COMMENT), commentText: '' }
    ];

    const response = await push(env, broken.map((comment) => ({ comment, draft: draft() })));
    expect((await response.json()).results).toEqual(broken.map(() => ({ outcome: 'invalid_comment' })));
    expect(env.DB.revisions.size).toBe(0);
  });

  test('redacts contact details lifted out of a resume', async () => {
    const env = configured();

    const response = await push(env, [
      item(PROSE_COMMENT, {
        summary: 'Reach me at ada@example.com or +1 415-555-0199 for storage work.',
        companies: ['Stripe (ada@example.com)']
      })
    ]);
    expect((await response.json()).results[0].redacted).toBe(true);

    const stored = JSON.stringify(env.DB.revisions.get('hn-44444501'));
    expect(stored).toContain(REDACTION_MARKER);
    expect(stored).not.toContain('ada@example.com');
    expect(stored).not.toContain('415-555-0199');
  });

  test('records resume provenance and refuses an unusable resume URL', async () => {
    const env = configured();

    const accepted = await push(env, [
      { ...item(PROSE_COMMENT), resumeUrl: 'https://example.com/ada.pdf', resumeFetchedAt: '2026-08-11T09:00:00.000Z' }
    ]);
    expect((await accepted.json()).results[0].outcome).toBe('created');
    expect(env.DB.hnIngests.get('44444501').resume_url).toBe('https://example.com/ada.pdf');

    for (const resumeUrl of ['http://example.com/ada.pdf', 'https://localhost/ada.pdf', 'https://127.0.0.1/a.pdf']) {
      const rejected = await push(env, [{ ...item(SECOND_COMMENT), resumeUrl }]);
      expect((await rejected.json()).results[0]).toEqual({ hnItemId: '44444502', outcome: 'invalid_resume_url' });
    }
    expect(env.DB.revisions.has('hn-44444502')).toBe(false);
  });

  test('a cron pass does not wipe resume provenance', async () => {
    const env = configured();
    await ingestThread(env);
    await push(env, [{ ...item(PROSE_COMMENT), resumeUrl: 'https://example.com/ada.pdf' }]);

    await ageToPreviousExtractorVersion(env);
    await ingestThread(env);

    expect(env.DB.hnIngests.get('44444501').resume_url).toBe('https://example.com/ada.pdf');
  });

  test('a null draft retires a comment nothing can extract', async () => {
    const env = configured();
    await ingestThread(env);

    const response = await push(env, [{ comment: commentBody(NOISE_COMMENT), draft: null }]);
    expect((await response.json()).results[0]).toEqual({ hnItemId: '44444503', outcome: 'retired' });

    expect(env.DB.revisions.has('hn-44444503')).toBe(false);
    expect(env.DB.hnIngests.get('44444503').extractor_rank).toBe(1);
    expect(await pendingIds(env)).not.toContain('44444503');
  });

  test('is idempotent', async () => {
    const env = configured();
    const batch = [item(PROSE_COMMENT, { companies: ['Stripe'] })];

    await push(env, batch);
    const first = { ...env.DB.revisions.get('hn-44444501') };
    await push(env, batch);
    const second = env.DB.revisions.get('hn-44444501');

    expect(second.id).toBe(first.id);
    expect(second.published_at).toBe(first.published_at);
    expect(env.DB.submissions.size).toBe(1);
  });

  test('an edited comment returns to the work queue', async () => {
    const env = configured();
    await ingestThread(env);
    await push(env, [item(PROSE_COMMENT, { companies: ['Stripe'] })]);
    expect(await pendingIds(env)).not.toContain('44444501');

    const edited = { ...PROSE_COMMENT, comment_text: `${PROSE_COMMENT.comment_text}<p>Now also interested in Elixir.` };
    await ingestThread(env, transport([edited, SECOND_COMMENT, NOISE_COMMENT]));

    expect(env.DB.hnIngests.get('44444501').extractor_rank).toBe(0);
    expect(await pendingIds(env)).toContain('44444501');
    // Stale and good beats fresh and bad for a directory card, so the profile holds until a re-run.
    expect(JSON.parse(env.DB.revisions.get('hn-44444501').companies_json)).toEqual(['Stripe']);
  });

  test('the pending set shrinks monotonically and excludes suppressed rows', async () => {
    const env = configured();
    await ingestThread(env);
    suppress(env, '44444502');

    const initial = await pendingIds(env);
    expect(initial).toContain('44444501');
    expect(initial).toContain('44444503');
    expect(initial).not.toContain('44444502');

    await push(env, [item(PROSE_COMMENT, { companies: ['Stripe'] }), { comment: commentBody(NOISE_COMMENT), draft: null }]);

    expect(await pendingIds(env)).toEqual([]);
  });

  test('does not consume the ingest run reservation', async () => {
    const env = configured();

    for (let attempt = 0; attempt < 12; attempt += 1) {
      expect((await push(env, [item(PROSE_COMMENT)])).status).toBe(200);
    }

    // The single-flight reservation exists to stop the cron amplifying against Algolia. A backfill
    // is dozens of pushes and must not spend it.
    const ingest = await worker.fetch(apiRequest('/api/admin/ingest/hn', 'POST', null, TOKEN), env);
    expect(ingest.status).not.toBe(429);
  });

  test('keeps provenance out of the public payload', async () => {
    const env = configured();
    await push(env, [{ ...item(PROSE_COMMENT, { companies: ['Stripe'] }), resumeUrl: 'https://example.com/ada.pdf' }]);

    const response = await worker.fetch(apiRequest('/api/candidates'), env);
    const payload = JSON.stringify(await response.json());
    for (const leak of ['resume_url', 'resumeUrl', 'extractor', 'extractor_rank', 'ada.pdf']) {
      expect(payload).not.toContain(leak);
    }
  });
});

function configured() {
  const env = createEnvironment();
  env.HN_INGEST_TOKEN = TOKEN;
  return env;
}

function draft(overrides = {}) {
  return {
    name: 'Ada Candidate',
    role: 'Infrastructure engineer',
    summary: 'Storage and payments infrastructure.',
    location: 'Toronto, Canada',
    workMode: 'Remote',
    availability: 'Immediate',
    universities: [],
    companies: [],
    skills: ['Rust', 'Go'],
    dateRanges: [],
    ...overrides
  };
}

function item(comment = PROSE_COMMENT, overrides = {}) {
  return { comment: commentBody(comment), draft: draft(overrides) };
}

function commentBody(comment) {
  return {
    itemId: String(comment.objectID),
    author: comment.author,
    commentText: comment.comment_text,
    createdAt: comment.created_at,
    threadId: THREAD.objectID,
    threadMonth: '2026-08'
  };
}

function push(env, profiles, token = TOKEN, extractor = 'claude-skill-v1') {
  const body = extractor === null ? { profiles } : { extractor, profiles };
  return worker.fetch(apiRequest('/api/admin/profiles/hn', 'POST', body, token), env);
}

async function pendingIds(env) {
  const response = await worker.fetch(
    apiRequest('/api/admin/profiles/hn/pending?extractor=claude-skill-v1', 'GET', null, TOKEN),
    env
  );
  expect(response.status).toBe(200);
  return (await response.json()).items.map((entry) => entry.hnItemId);
}

async function publicCandidateIds(env) {
  const response = await worker.fetch(apiRequest('/api/candidates'), env);
  return (await response.json()).candidates.map((candidate) => candidate.id);
}

function transport(comments = [PROSE_COMMENT, SECOND_COMMENT, NOISE_COMMENT]) {
  const fetchJson = async (url) => {
    const parameters = new URL(url).searchParams;
    if (parameters.get('tags') === 'story,author_whoishiring') return { hits: [THREAD], nbPages: 1 };
    return { hits: Number(parameters.get('page') || 0) === 0 ? comments : [], nbPages: 1 };
  };
  return { fetch: fetchJson };
}

async function ingestThread(env, source = transport()) {
  await ingestHackerNews(env, { transport: source.fetch });
  return deliverQueuedMessages(env, worker);
}

// Rewriting the stored hashes to what the previous extraction version would have written is what a
// version bump looks like from the database's side.
async function ageToPreviousExtractorVersion(env) {
  const byId = new Map(
    [PROSE_COMMENT, SECOND_COMMENT, NOISE_COMMENT].map((comment) => [String(comment.objectID), comment])
  );
  await Promise.all(
    [...env.DB.hnIngests.values()].map(async (row) => {
      const text = decodeHnCommentText(byId.get(row.hn_item_id).comment_text);
      row.comment_hash = await hnCommentHash(text, HN_EXTRACTION_VERSION - 1);
    })
  );
}

function suppress(env, itemId) {
  Object.assign(env.DB.hnIngests.get(itemId), {
    suppressed_at: '2026-08-05T00:00:00.000Z',
    suppressed_reason: 'removal_requested'
  });
  const revision = env.DB.revisions.get(`hn-${itemId}`);
  if (revision) revision.status = 'archived';
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
