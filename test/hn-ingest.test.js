import { describe, expect, test } from 'bun:test';
import worker, { DETERMINISTIC_HN_EXTRACTOR, decodeHnCommentText, ingestHackerNews, ingestHnComment, toHnRecord } from '../worker.js';
import { REDACTION_MARKER } from '../sensitive-data.js';
import { createEnvironment, deliverQueuedMessages } from './memory-d1.js';

const THREAD = {
  objectID: '44444444',
  title: 'Ask HN: Who wants to be hired? (August 2026)',
  author: 'whoishiring',
  created_at: '2026-08-03T15:00:00.000Z'
};

const LABELED_COMMENT = {
  objectID: '44444501',
  parent_id: 44444444,
  author: 'adacandidate',
  created_at: '2026-08-03T16:12:00.000Z',
  comment_text: [
    'Location: Toronto, Canada',
    'Remote: Yes',
    'Willing to relocate: No',
    'Technologies: Rust, Go, Kubernetes, PostgreSQL',
    'Companies: Stripe, Example Systems',
    'Education: University of Waterloo',
    'Availability: Immediate',
    'R&#xe9;sum&#xe9;&#x2F;CV: <a href="https:&#x2F;&#x2F;example.com&#x2F;ada.pdf" rel="nofollow">https:&#x2F;&#x2F;example.com&#x2F;ada.pdf</a>',
    'I have been building storage systems since 2019 - present and I&#x27;m looking for a small team.'
  ].join('<p>')
};

const CONTACT_COMMENT = {
  objectID: '44444502',
  parent_id: 44444444,
  author: 'contactposter',
  created_at: '2026-08-03T17:40:00.000Z',
  comment_text: [
    'Location: Berlin, Germany',
    'Remote: No',
    'Technologies: Python, Django',
    'Email: reachme@example.com',
    'Phone: +1 415-555-0199',
    'Feel free to reach me at second.address@example.org or on 415-555-0143 any time.'
  ].join('<p>')
};

const PROSE_COMMENT = {
  objectID: '44444503',
  parent_id: 44444444,
  author: 'proseposter',
  created_at: '2026-08-03T18:05:00.000Z',
  comment_text:
    'Senior infrastructure engineer, eight years across payments and observability. I care about boring, ' +
    'legible systems and mentoring. Happy to work fully remote from anywhere in Europe, and I can start in September.'
};

const RUN_ON_BIO_COMMENT = {
  objectID: '44444508',
  parent_id: 44444444,
  author: 'runonposter',
  created_at: '2026-08-03T18:45:00.000Z',
  comment_text: [
    'Location: Austin, USA',
    'Software engineer with professional experience building scalable backends and highly available cloud ' +
      'infrastructure and orchestrating zero downtime deployments across dozens of regions for high traffic ' +
      'services handling millions of requests every single day without an early stop'
  ].join('<p>')
};

const HEADLINE_COMMENT = {
  objectID: '44444509',
  parent_id: 44444444,
  author: 'headlineposter',
  created_at: '2026-08-03T19:15:00.000Z',
  comment_text: ['Location: Remote', 'SEEKING WORK | Remote worldwide | Senior Backend Engineer'].join('<p>')
};

const REPLY_COMMENT = {
  objectID: '44444504',
  parent_id: 44444501,
  author: 'someoneelse',
  created_at: '2026-08-03T18:30:00.000Z',
  comment_text: 'Great profile, we are hiring for exactly this. Location: Toronto, Canada'
};

const NOISE_COMMENT = {
  objectID: '44444505',
  parent_id: 44444444,
  author: 'terseposter',
  created_at: '2026-08-03T19:00:00.000Z',
  comment_text: 'dupe'
};

const YEARS_OF_EXPERIENCE_COMMENT = {
  objectID: '44444506',
  parent_id: 44444444,
  author: 'seniorposter',
  created_at: '2026-08-03T19:30:00.000Z',
  comment_text: [
    'Location: Salt Lake City, Utah',
    'Remote: Yes',
    'Technologies: Python, TypeScript, Kubernetes',
    'Experience: 12+ years building distributed systems',
    'Résumé/CV: on request'
  ].join('<p>')
};

const IMMEDIATE_PROSE_COMMENT = {
  objectID: '44444507',
  parent_id: 44444444,
  author: 'readyposter',
  created_at: '2026-08-03T20:00:00.000Z',
  comment_text: [
    'Location: Lisbon, Portugal',
    'Remote: Yes',
    'Technologies: Go, PostgreSQL',
    'Résumé/CV: available upon request',
    'I ship reliable backend systems end to end and am available immediately.'
  ].join('<p>')
};

const RESUME_AVAILABLE_ONLY_COMMENT = {
  objectID: '44444508',
  parent_id: 44444444,
  author: 'quietposter',
  created_at: '2026-08-03T20:30:00.000Z',
  comment_text: [
    'Location: Prague, Czechia',
    'Remote: Yes',
    'Technologies: Kotlin, Android',
    'Résumé/CV: Available on request',
    'I build mobile apps and enjoy shipping polished UI.'
  ].join('<p>')
};

describe('deterministic Hacker News extraction', () => {
  test('decodes comment HTML into labelled plain text', () => {
    expect(decodeHnCommentText(LABELED_COMMENT.comment_text).split('\n')).toEqual([
      'Location: Toronto, Canada',
      'Remote: Yes',
      'Willing to relocate: No',
      'Technologies: Rust, Go, Kubernetes, PostgreSQL',
      'Companies: Stripe, Example Systems',
      'Education: University of Waterloo',
      'Availability: Immediate',
      'Résumé/CV: https://example.com/ada.pdf',
      "I have been building storage systems since 2019 - present and I'm looking for a small team."
    ]);
  });

  test('maps the conventional labels and keeps unmapped lines as the summary', async () => {
    const draft = DETERMINISTIC_HN_EXTRACTOR.extract(await record(LABELED_COMMENT));

    expect(draft).toMatchObject({
      name: 'adacandidate',
      location: 'Toronto, Canada',
      workMode: 'Remote',
      availability: 'Immediate',
      skills: ['Rust', 'Go', 'Kubernetes', 'PostgreSQL'],
      companies: ['Stripe', 'Example Systems'],
      universities: ['University of Waterloo'],
      dateRanges: ['2019 - present']
    });
    expect(draft.summary).toContain('Willing to relocate: No');
    expect(draft.summary).toContain('https://example.com/ada.pdf');
  });

  test('represents missing fields as unknown rather than inventing them', async () => {
    const draft = DETERMINISTIC_HN_EXTRACTOR.extract(await record(PROSE_COMMENT));

    expect(draft).toMatchObject({
      name: 'proseposter',
      location: 'Not specified',
      availability: 'Not specified',
      workMode: 'Remote',
      universities: [],
      companies: [],
      skills: []
    });
    expect(draft.role).toStartWith('Senior infrastructure engineer');
  });

  test('leaves role empty rather than truncating a run-on opening line mid-word', async () => {
    const draft = DETERMINISTIC_HN_EXTRACTOR.extract(await record(RUN_ON_BIO_COMMENT));

    expect(draft.role).toBe('');
    expect(draft.summary).toContain('Software engineer with professional experience');
    expect(draft.summary).toContain('without an early stop');
  });

  test('keeps a short unlabeled headline as the role verbatim', async () => {
    const draft = DETERMINISTIC_HN_EXTRACTOR.extract(await record(HEADLINE_COMMENT));

    expect(draft.role).toBe('SEEKING WORK | Remote worldwide | Senior Backend Engineer');
  });

  test('skips a comment with neither labels nor enough prose', async () => {
    expect(DETERMINISTIC_HN_EXTRACTOR.extract(await record(NOISE_COMMENT))).toBeNull();
  });

  test('does not mistake a years-of-experience line for a company name', async () => {
    const draft = DETERMINISTIC_HN_EXTRACTOR.extract(await record(YEARS_OF_EXPERIENCE_COMMENT));

    expect(draft.companies).toEqual([]);
    expect(draft.summary).toContain('Experience: 12+ years building distributed systems');
  });

  test('reads "available immediately" prose when there is no labelled availability line', async () => {
    const draft = DETERMINISTIC_HN_EXTRACTOR.extract(await record(IMMEDIATE_PROSE_COMMENT));

    expect(draft.availability).toBe('Immediately');
  });

  test('does not treat résumé availability as candidate availability', async () => {
    const draft = DETERMINISTIC_HN_EXTRACTOR.extract(await record(RESUME_AVAILABLE_ONLY_COMMENT));

    expect(draft.availability).toBe('Not specified');
  });

  test('runs extracted text through the shared sensitive-data policy', async () => {
    const draft = DETERMINISTIC_HN_EXTRACTOR.extract(await record(CONTACT_COMMENT));

    expect(draft.summary).toContain(`Email: ${REDACTION_MARKER}`);
    expect(draft.summary).toContain(`Phone: ${REDACTION_MARKER}`);
    expect(draft.summary).not.toContain('reachme@example.com');
    expect(draft.summary).not.toContain('second.address@example.org');
    expect(draft.summary).not.toContain('415-555-0199');
    expect(draft.summary).not.toContain('415-555-0143');
  });
});

describe('Hacker News ingestion', () => {
  test('publishes thread comments with a link back to the source comment', async () => {
    const env = createEnvironment();
    const transport = createTransport();

    expect(await ingestHackerNews(env, { transport: transport.fetch })).toEqual({ threads: 1, queued: 4, skipped: 0 });
    expect(await deliverQueuedMessages(env, worker)).toEqual({ delivered: 4, acknowledged: 4, retried: 0 });

    const candidates = await publicCandidates(env);
    expect(candidates.map((candidate) => candidate.name).sort()).toEqual(['adacandidate', 'contactposter', 'proseposter']);
    expect(candidates.every((candidate) => candidate.source === 'HN · August 2026')).toBe(true);
    expect(candidates.map((candidate) => candidate.sourceUrl).sort()).toEqual([
      'https://news.ycombinator.com/item?id=44444501',
      'https://news.ycombinator.com/item?id=44444502',
      'https://news.ycombinator.com/item?id=44444503'
    ]);
    expect(candidates.map((candidate) => candidate.publishedAt)).toEqual([
      '2026-08-03T18:05:00.000Z',
      '2026-08-03T17:40:00.000Z',
      '2026-08-03T16:12:00.000Z'
    ]);
  });

  test('never publishes contact details harvested from a comment', async () => {
    const env = createEnvironment();
    await ingestThread(env);

    const payload = JSON.stringify(await publicCandidates(env));
    expect(payload).toContain(REDACTION_MARKER);
    ['reachme@example.com', 'second.address@example.org', '415-555-0199', '415-555-0143'].forEach((secret) =>
      expect(payload).not.toContain(secret)
    );
  });

  test('ignores replies to candidate comments', async () => {
    const env = createEnvironment();
    await ingestThread(env);

    expect(env.DB.hnIngests.has(String(REPLY_COMMENT.objectID))).toBe(false);
    expect((await publicCandidates(env)).some((candidate) => candidate.name === 'someoneelse')).toBe(false);
  });

  test('re-running ingestion queues nothing and duplicates nothing', async () => {
    const env = createEnvironment();
    const transport = createTransport();
    await ingestThread(env, transport);
    const first = await publicCandidates(env);

    expect(await ingestHackerNews(env, { transport: transport.fetch })).toEqual({ threads: 1, queued: 0, skipped: 4 });
    expect(env.SUBMISSION_QUEUE.messages).toEqual([]);
    expect(await publicCandidates(env)).toEqual(first);
    expect(env.DB.submissions.size).toBe(3);
  });

  test('updates an edited comment in place instead of adding a second profile', async () => {
    const env = createEnvironment();
    const transport = createTransport();
    await ingestThread(env, transport);
    const original = (await publicCandidates(env)).find((candidate) => candidate.name === 'adacandidate');

    transport.comments[0] = { ...LABELED_COMMENT, comment_text: LABELED_COMMENT.comment_text.replace('Remote: Yes', 'Remote: No') };
    expect(await ingestHackerNews(env, { transport: transport.fetch })).toEqual({ threads: 1, queued: 1, skipped: 3 });
    await deliverQueuedMessages(env, worker);

    const candidates = await publicCandidates(env);
    expect(candidates).toHaveLength(3);
    const updated = candidates.find((candidate) => candidate.name === 'adacandidate');
    expect(updated.id).toBe(original.id);
    expect(original.mode).toBe('Remote');
    expect(updated.mode).toBe('On-site');
  });

  test('keeps a suppressed profile suppressed across re-ingestion', async () => {
    const env = createEnvironment();
    const transport = createTransport();
    await ingestThread(env, transport);

    suppress(env, LABELED_COMMENT.objectID);
    expect((await publicCandidates(env)).some((candidate) => candidate.name === 'adacandidate')).toBe(false);

    transport.comments[0] = { ...LABELED_COMMENT, comment_text: LABELED_COMMENT.comment_text.replace('Remote: Yes', 'Remote: No') };
    expect(await ingestHackerNews(env, { transport: transport.fetch })).toEqual({ threads: 1, queued: 0, skipped: 4 });
    expect((await publicCandidates(env)).some((candidate) => candidate.name === 'adacandidate')).toBe(false);
  });

  test('refuses a replayed message for a suppressed comment', async () => {
    const env = createEnvironment();
    await ingestThread(env);
    suppress(env, LABELED_COMMENT.objectID);

    const message = { objectID: LABELED_COMMENT.objectID, ...queueBody(LABELED_COMMENT) };
    expect(await ingestHnComment(env, message)).toBe('skipped_suppressed');
    expect((await publicCandidates(env)).some((candidate) => candidate.name === 'adacandidate')).toBe(false);
  });

  test('keeps an archived Hacker News revision out of public search', async () => {
    const env = createEnvironment();
    await ingestThread(env);

    env.DB.revisions.get(`hn-${LABELED_COMMENT.objectID}`).status = 'archived';
    expect((await publicCandidates(env)).some((candidate) => candidate.name === 'adacandidate')).toBe(false);

    expect(await ingestHnComment(env, queueBody(LABELED_COMMENT))).toBe('unchanged');
    expect((await publicCandidates(env)).some((candidate) => candidate.name === 'adacandidate')).toBe(false);
  });

  test('never republishes an archived revision when the comment changes', async () => {
    const env = createEnvironment();
    await ingestThread(env);
    env.DB.revisions.get(`hn-${LABELED_COMMENT.objectID}`).status = 'archived';

    const edited = { ...LABELED_COMMENT, comment_text: LABELED_COMMENT.comment_text.replace('Remote: Yes', 'Remote: No') };
    expect(await ingestHnComment(env, queueBody(edited))).toBe('updated');
    expect(env.DB.revisions.get(`hn-${LABELED_COMMENT.objectID}`).status).toBe('archived');
    expect((await publicCandidates(env)).some((candidate) => candidate.name === 'adacandidate')).toBe(false);
  });

  test('leaves a self-submitted review draft private while Hacker News rows publish', async () => {
    const env = createEnvironment();
    const submission = await worker.fetch(
      apiRequest('/api/submissions/text', 'POST', { sourceText: 'Name: Private Candidate\nLocation: Nowhere' }),
      env
    );
    expect(submission.status).toBe(202);
    await deliverQueuedMessages(env, worker);
    await ingestThread(env);

    const candidates = await publicCandidates(env);
    expect(candidates).toHaveLength(3);
    expect(candidates.some((candidate) => candidate.name === 'Private Candidate')).toBe(false);
  });
});

const INGEST_TOKEN = 'operator-secret-operator-secret-0123456789';

describe('operator-triggered ingestion', () => {
  test('rejects an unauthenticated or misconfigured request', async () => {
    const env = createEnvironment();
    expect((await worker.fetch(apiRequest('/api/admin/ingest/hn', 'POST', {}), env)).status).toBe(503);

    env.HN_INGEST_TOKEN = INGEST_TOKEN;
    expect((await worker.fetch(apiRequest('/api/admin/ingest/hn', 'POST', {}), env)).status).toBe(401);
    expect((await worker.fetch(apiRequest('/api/admin/ingest/hn', 'POST', {}, 'wrong'), env)).status).toBe(403);
    expect((await worker.fetch(apiRequest('/api/admin/ingest/hn', 'GET', null, INGEST_TOKEN), env)).status).toBe(405);
  });

  test('never degrades to open access when the ingest token is unset or too weak', async () => {
    const attempts = [undefined, '', '   ', 'short-token', 'x'.repeat(31)];
    const outcomes = await Promise.all(
      attempts.map(async (token) => {
        const env = createEnvironment();
        env.HN_INGEST_TOKEN = token;
        const anonymous = await worker.fetch(apiRequest('/api/admin/ingest/hn', 'POST', {}), env);
        const guessed = await worker.fetch(apiRequest('/api/admin/ingest/hn', 'POST', {}, token ?? ''), env);
        return [anonymous.status, guessed.status, await anonymous.json()];
      })
    );

    outcomes.forEach(([anonymousStatus, guessedStatus, body]) => {
      expect(anonymousStatus).toBe(503);
      expect(guessedStatus).toBe(503);
      expect(body).toEqual({ error: 'ingest_not_configured' });
    });
  });

  test('names the failure to its operator without leaking the upstream error', async () => {
    const env = createEnvironment();
    env.HN_INGEST_TOKEN = INGEST_TOKEN;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response('upstream exploded', { status: 500 });
    try {
      const response = await worker.fetch(apiRequest('/api/admin/ingest/hn', 'POST', {}, INGEST_TOKEN), env);
      expect(response.status).toBe(502);
      const body = await response.json();
      expect(body).toEqual({ error: 'ingest_failed', reason: 'Error: hn_fetch_failed' });
      expect(JSON.stringify(body)).not.toContain('upstream exploded');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('rate limits repeated ingest runs so the endpoint cannot amplify against upstream', async () => {
    const env = createEnvironment();
    env.HN_INGEST_TOKEN = INGEST_TOKEN;
    const originalFetch = globalThis.fetch;
    let upstreamCalls = 0;
    globalThis.fetch = async () => {
      upstreamCalls += 1;
      return new Response('upstream exploded', { status: 500 });
    };
    try {
      const first = await worker.fetch(apiRequest('/api/admin/ingest/hn', 'POST', {}, INGEST_TOKEN), env);
      const second = await worker.fetch(apiRequest('/api/admin/ingest/hn', 'POST', {}, INGEST_TOKEN), env);
      expect(first.status).toBe(502);
      expect(second.status).toBe(429);
      expect(await second.json()).toEqual({ error: 'ingest_in_progress' });
      expect(upstreamCalls).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('Hacker News thread discovery', () => {
  test('reads the date-sorted index for threads and the relevance index for comments', async () => {
    const transport = createTransport();
    await ingestHackerNews(createEnvironment(), { transport: transport.fetch });

    const [discovery, ...comments] = transport.requests;
    expect(new URL(discovery).pathname).toBe('/api/v1/search_by_date');
    expect(comments.length).toBeGreaterThan(0);
    expect(comments.map((url) => new URL(url).pathname)).toEqual(comments.map(() => '/api/v1/search'));
  });

  test('ingests the newest thread when the index returns an older one first', async () => {
    const env = createEnvironment();
    const transport = createArchiveTransport();

    expect(await ingestHackerNews(env, { transport: transport.fetch, threads: 1 })).toEqual({
      threads: 1,
      queued: 1,
      skipped: 0
    });
    await deliverQueuedMessages(env, worker);
    expect((await publicCandidates(env)).map((candidate) => candidate.source)).toEqual(['HN · August 2026']);
  });
});

describe('untokened removal of an ingested profile', () => {
  test('removes the listing without a management token', async () => {
    const env = createEnvironment();
    await ingestThread(env);
    const target = (await publicCandidates(env)).find((candidate) => candidate.name === 'adacandidate');

    const response = await worker.fetch(apiRequest(`/api/candidates/${target.id}/removal`, 'POST'), env);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ removed: true });
    expect((await publicCandidates(env)).some((candidate) => candidate.id === target.id)).toBe(false);
  });

  // Editing the comment is what separates suppression from the archived status: an unchanged
  // comment is skipped on its hash alone, so only an edit proves the removal itself is what keeps
  // the profile from being collected again.
  test('keeps an edited comment from being collected again', async () => {
    const env = createEnvironment();
    const transport = createTransport();
    await ingestThread(env, transport);
    const target = (await publicCandidates(env)).find((candidate) => candidate.name === 'adacandidate');
    await worker.fetch(apiRequest(`/api/candidates/${target.id}/removal`, 'POST'), env);

    transport.comments[0] = { ...LABELED_COMMENT, comment_text: LABELED_COMMENT.comment_text.replace('Remote: Yes', 'Remote: No') };
    expect(await ingestHackerNews(env, { transport: transport.fetch })).toEqual({ threads: 1, queued: 0, skipped: 4 });
    await deliverQueuedMessages(env, worker);

    expect((await publicCandidates(env)).some((candidate) => candidate.name === 'adacandidate')).toBe(false);
  });

  test('is idempotent', async () => {
    const env = createEnvironment();
    await ingestThread(env);
    const target = (await publicCandidates(env)).find((candidate) => candidate.name === 'adacandidate');
    const path = `/api/candidates/${target.id}/removal`;

    await worker.fetch(apiRequest(path, 'POST'), env);
    const second = await worker.fetch(apiRequest(path, 'POST'), env);

    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ removed: true });
  });

  test('refuses an unknown candidate and rejects GET', async () => {
    const env = createEnvironment();
    await ingestThread(env);

    expect((await worker.fetch(apiRequest('/api/candidates/does-not-exist/removal', 'POST'), env)).status).toBe(404);
    expect((await worker.fetch(apiRequest('/api/candidates/does-not-exist/removal'), env)).status).toBe(405);
  });
});

// workerd throws a TypeError on any other value before the request is sent, but Node and Bun accept
// `redirect: 'error'` happily -- so no behavioural test can catch a regression here, only the value.
const WORKERD_REDIRECT_MODES = ['follow', 'manual'];

describe('outbound requests to the HN API', () => {
  test('asks for a redirect mode the Workers runtime actually implements', async () => {
    const env = createEnvironment();
    const inits = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_url, init) => {
      inits.push(init);
      return Response.json({ hits: [] });
    };
    try {
      await ingestHackerNews(env);
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(inits.length).toBeGreaterThan(0);
    for (const init of inits) expect(WORKERD_REDIRECT_MODES).toContain(init.redirect);
  });

  test('fails closed rather than following a redirect off the HN API', async () => {
    const env = createEnvironment();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response('', { status: 302, headers: { location: 'https://elsewhere.example/' } });
    try {
      await expect(ingestHackerNews(env)).rejects.toThrow('hn_fetch_failed');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('ingest failure reporting', () => {
  test('names the reason a comment could not be ingested instead of retrying in silence', async () => {
    const env = createEnvironment();
    await ingestHackerNews(env, { transport: createTransport().fetch });
    const prepare = env.DB.prepare.bind(env.DB);
    env.DB.prepare = (sql) => {
      if (sql.includes('FROM hn_ingests WHERE hn_item_id = ?')) throw new Error('D1_ERROR: storage unavailable');
      return prepare(sql);
    };

    const logged = [];
    const original = console.error;
    console.error = (message) => logged.push(message);
    let delivery;
    try {
      delivery = await deliverQueuedMessages(env, worker);
    } finally {
      console.error = original;
    }

    expect(delivery.acknowledged).toBe(0);
    expect(delivery.retried).toBeGreaterThan(0);
    expect(logged.length).toBe(delivery.retried);
    expect(logged[0]).toBe('hn ingest failed during queue: Error: D1_ERROR: storage unavailable');
  });

  test('stays silent when nothing fails', async () => {
    const env = createEnvironment();
    await ingestHackerNews(env, { transport: createTransport().fetch });

    const logged = [];
    const original = console.error;
    console.error = (message) => logged.push(message);
    try {
      await deliverQueuedMessages(env, worker);
    } finally {
      console.error = original;
    }

    expect(logged).toEqual([]);
  });
});

// The upstream order is deliberately stale-first: a discovery step that trusts index order rather
// than the recorded timestamp would publish the 2025 cohort and never reach the current month.
function createArchiveTransport() {
  const threads = [
    { objectID: '33333333', title: 'Ask HN: Who wants to be hired? (November 2025)', created_at: '2025-11-03T15:00:00.000Z' },
    { objectID: '44444444', title: 'Ask HN: Who wants to be hired? (August 2026)', created_at: '2026-08-03T15:00:00.000Z' }
  ];
  const commentFor = (threadId) => ({
    objectID: `${threadId}01`,
    parent_id: Number(threadId),
    author: `candidate${threadId}`,
    created_at: '2026-08-03T16:12:00.000Z',
    comment_text: ['Location: Toronto, Canada', 'Remote: Yes', 'Technologies: Rust, Go'].join('<p>')
  });

  const transport = { requests: [] };
  transport.fetch = async (url) => {
    transport.requests.push(url);
    const parameters = new URL(url).searchParams;
    const tags = parameters.get('tags');
    if (tags === 'story,author_whoishiring') return { hits: threads, nbPages: 1 };
    const threadId = String(tags).replace('comment,story_', '');
    return { hits: Number(parameters.get('page') || 0) === 0 ? [commentFor(threadId)] : [], nbPages: 1 };
  };
  return transport;
}

function createTransport() {
  const transport = {
    comments: [LABELED_COMMENT, CONTACT_COMMENT, PROSE_COMMENT, REPLY_COMMENT, NOISE_COMMENT],
    requests: []
  };
  transport.fetch = async (url) => {
    transport.requests.push(url);
    const parameters = new URL(url).searchParams;
    const tags = parameters.get('tags');
    if (tags === 'story,author_whoishiring') return { hits: [THREAD], nbPages: 1 };
    if (tags !== `comment,story_${THREAD.objectID}`) throw new Error(`unexpected tags ${tags}`);
    return { hits: Number(parameters.get('page') || 0) === 0 ? transport.comments : [], nbPages: 1 };
  };
  return transport;
}

async function ingestThread(env, transport = createTransport()) {
  await ingestHackerNews(env, { transport: transport.fetch });
  return deliverQueuedMessages(env, worker);
}

function queueBody(comment) {
  return {
    itemId: String(comment.objectID),
    author: comment.author,
    commentText: comment.comment_text,
    createdAt: comment.created_at,
    threadId: THREAD.objectID,
    threadMonth: '2026-08'
  };
}

function record(comment) {
  return toHnRecord({ id: THREAD.objectID, month: '2026-08' }, comment);
}

function suppress(env, itemId) {
  Object.assign(env.DB.hnIngests.get(String(itemId)), {
    suppressed_at: '2026-08-05T00:00:00.000Z',
    suppressed_reason: 'removal_requested'
  });
  env.DB.revisions.get(`hn-${itemId}`).status = 'archived';
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
