import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import worker, { CANDIDATES_PAGE_SIZE, ingestHnComment } from '../worker.js';

function fixture() {
  const db = new Database(':memory:');
  db.run(`CREATE TABLE profile_revisions (
    id TEXT, submission_id TEXT, status TEXT, name TEXT, role TEXT, summary TEXT,
    location TEXT, work_mode TEXT, availability TEXT, hn_username TEXT,
    linkedin_url TEXT, github_url TEXT, personal_url TEXT,
    universities_json TEXT, companies_json TEXT, skills_json TEXT, date_ranges_json TEXT,
    published_at TEXT, updated_at TEXT
  ); CREATE TABLE hn_ingests (
    submission_id TEXT, hn_author TEXT, hn_permalink TEXT, thread_month TEXT,
    extractor_rank INTEGER, comment_created_at TEXT, suppressed_at TEXT, hn_item_id TEXT, updated_at TEXT, comment_hash TEXT
  ); CREATE TABLE rate_limits (bucket TEXT PRIMARY KEY, window_start INTEGER, hits INTEGER, updated_at TEXT)`);
  const env = { DB: { prepare(sql) {
    return { bind(...values) { return {
      async all() { return { results: db.query(sql).all(...values) }; },
      async first() { return db.query(sql).get(...values); },
      async run() { const result = db.query(sql).run(...values); return { meta: { changes: result.changes } }; }
    }; } };
  }, async batch(statements) { return Promise.all(statements.map((statement) => statement.run())); } } };
  return { db, env };
}

function seed(db, id, author = '', overrides = {}) {
  const row = {
    id, submission_id: id, status: 'published', name: `Person ${id}`, role: 'Engineer', summary: '',
    location: 'Remote', work_mode: 'Remote', availability: 'Not specified', hn_username: author,
    linkedin_url: '', github_url: '', personal_url: '', universities_json: '[]', companies_json: '[]',
    skills_json: '[]', date_ranges_json: '[]', published_at: '2026-10-01T00:00:00Z', ...overrides
  };
  const columns = Object.keys(row);
  db.query(`INSERT INTO profile_revisions (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`).run(...Object.values(row));
  if (author) db.query('INSERT INTO hn_ingests (submission_id, hn_author, hn_permalink, thread_month, extractor_rank, comment_created_at, suppressed_at, hn_item_id) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)').run(
    id, author, `https://news.ycombinator.com/item?id=${id}`, '2026-10', 2, row.published_at, id
  );
}

async function listing(env, suffix = '') {
  const response = await worker.fetch(new Request(`https://example.com/api/candidates${suffix}`), env);
  expect(response.status).toBe(200);
  return response.json();
}

test('real SQLite merges HN accounts before pagination, preserves facts and all comment links', async () => {
  const { db, env } = fixture();
  try {
    seed(db, '10001', 'synthetic_handle', { skills_json: '["TypeScript"]', universities_json: '["Example University"]', personal_url: 'https://example.org/' });
    seed(db, '10002', 'SYNTHETIC_HANDLE', { location: 'London', skills_json: '["Go","typescript"]', published_at: '2026-10-02T00:00:00Z' });
    db.query('UPDATE profile_revisions SET published_at = ? WHERE id = ?').run('2026-10-03T00:00:00Z', '10001');
    const { candidates } = await listing(env);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ id: '10002', location: 'London', personalUrl: '', universities: ['Example University'] });
    expect(new Set(candidates[0].skills.map((value) => value.toLowerCase()))).toEqual(new Set(['go', 'typescript']));
    expect(candidates[0].sources.map((source) => source.url)).toEqual([
      'https://news.ycombinator.com/item?id=10002', 'https://news.ycombinator.com/item?id=10001'
    ]);
    expect((await listing(env, '?hnUsername=Synthetic_Handle')).candidates).toHaveLength(1);
    const stats = await listing(env, '/stats');
    expect(stats).toMatchObject({ candidates: 1, processed: 1, universities: 1, facets: { university: 1, skill: 1 } });
  } finally { db.close(); }
});

test('paginates people rather than submissions, including a person with more than one page of comments', async () => {
  const { db, env } = fixture();
  try {
    for (let index = 0; index < CANDIDATES_PAGE_SIZE + 1; index++) seed(db, String(20000 + index), 'same_synthetic_person');
    for (let index = 0; index < CANDIDATES_PAGE_SIZE; index++) seed(db, String(30000 + index), `synthetic_${index}`);
    const first = await listing(env);
    const second = await listing(env, `?offset=${first.nextOffset}`);
    expect(first.candidates).toHaveLength(CANDIDATES_PAGE_SIZE);
    expect(second.candidates).toHaveLength(1);
    expect(second.nextOffset).toBeNull();
    const all = [...first.candidates, ...second.candidates];
    expect(new Set(all.map((candidate) => candidate.hnUsername.toLowerCase())).size).toBe(CANDIDATES_PAGE_SIZE + 1);
    expect(all.find((candidate) => candidate.hnUsername === 'same_synthetic_person').sources).toHaveLength(CANDIDATES_PAGE_SIZE + 1);
  } finally { db.close(); }
});

test('suppressed account hides older and future submissions, including tombstones without a submission', async () => {
  const { db, env } = fixture();
  try {
    seed(db, '40001', 'removed_synthetic');
    db.query('INSERT INTO hn_ingests (submission_id, hn_author, hn_permalink, thread_month, extractor_rank, comment_created_at, suppressed_at) VALUES (NULL, ?, ?, ?, ?, ?, ?)').run('REMOVED_SYNTHETIC', 'https://news.ycombinator.com/item?id=40000', '2026-09', 2, '2026-09-01', '2026-10-01');
    seed(db, '40002', 'removed_synthetic', { published_at: '2026-10-03T00:00:00Z' });
    seed(db, '40003', 'visible_synthetic');
    expect((await listing(env)).candidates.map((candidate) => candidate.id)).toEqual(['40003']);
    expect((await listing(env, '/stats')).candidates).toBe(1);
  } finally { db.close(); }
});

test('equal display names and unverified candidate-supplied handles do not merge separate people', async () => {
  const { db, env } = fixture();
  try {
    seed(db, '50001', '', { name: 'Same name', hn_username: 'claimed_handle' });
    seed(db, '50002', '', { name: 'Same name', hn_username: 'claimed_handle' });
    seed(db, '50003', 'claimed_handle', { name: 'Same name' });
    expect((await listing(env)).candidates).toHaveLength(3);
  } finally { db.close(); }
});

test('removing a merged person suppresses every existing comment and rejects a future comment', async () => {
  const { db, env } = fixture();
  try {
    seed(db, '60001', 'removed_synthetic');
    seed(db, '60002', 'REMOVED_SYNTHETIC');
    seed(db, '60003', 'visible_synthetic');
    const request = new Request('https://example.com/api/candidates/60001/removal', { method: 'POST' });
    expect((await worker.fetch(request, env)).status).toBe(200);
    expect(db.query("SELECT COUNT(*) AS total FROM profile_revisions WHERE status = 'archived'").get().total).toBe(2);
    expect(db.query('SELECT COUNT(*) AS total FROM hn_ingests WHERE suppressed_at IS NOT NULL').get().total).toBe(2);
    expect((await listing(env)).candidates.map((candidate) => candidate.id)).toEqual(['60003']);
    expect(await ingestHnComment(env, {
      objectID: '60004', author: 'Removed_Synthetic', threadId: '60000', threadMonth: '2026-10',
      created_at: '2026-10-02T00:00:00Z', comment_text: 'Location: Remote\nTechnologies: TypeScript\nRemote: Yes'
    })).toBe('skipped_suppressed');
  } finally { db.close(); }
});
