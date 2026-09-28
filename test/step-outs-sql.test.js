import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import worker from '../worker.js';

// memory-d1.js pattern-matches SQL text, so it cannot prove the statements themselves are right. This
// runs the real migrations and the Worker's step-out SQL against SQLite, the engine D1 is built on.
const TOKEN = 'push-token-that-is-long-enough-to-be-usable';
const MIGRATIONS = new URL('../migrations/', import.meta.url);
const MANUAL_BACKFILL = new URL('manual/2026-09-28-backfill-unrecorded-step-outs.sql', MIGRATIONS);

describe('step-out SQL against SQLite', () => {
  test('0007 is additive: existing rows keep their values and start with no step-out', () => {
    const db = new Database(':memory:');
    applyMigrations(db, (name) => name < '0007');
    ingest(db, '46000001', { rank: 2 });
    applyMigrations(db, (name) => name.startsWith('0007'));

    expect(db.query('SELECT extractor_rank, step_out, step_out_reason, step_out_count FROM hn_ingests').get()).toEqual({
      extractor_rank: 2,
      step_out: null,
      step_out_reason: null,
      step_out_count: 0
    });
    expect(db.query("SELECT name FROM sqlite_master WHERE name = 'hn_ingests_step_out'").get()).toEqual({
      name: 'hn_ingests_step_out'
    });
  });

  test('push, requeue and listing statements run as written', async () => {
    const env = sqliteEnv();
    for (const id of ['46000001', '46000002', '46000003', '46000004']) ingest(env.raw, id);
    env.raw.run("UPDATE hn_ingests SET suppressed_at = '2026-09-01T00:00:00.000Z' WHERE hn_item_id = '46000004'");

    const pushed = await call(env, '/api/admin/profiles/hn', 'POST', {
      extractor: 'claude-skill-v2',
      profiles: [
        { hnItemId: '46000001', hold: true, reason: 'source_alive' },
        { hnItemId: '46000002', hold: true },
        { hnItemId: '46000003', draft: null, reason: 'dead' },
        { hnItemId: '46000004', hold: true }
      ]
    });
    expect(pushed.results.map((result) => result.outcome)).toEqual(['held', 'held', 'retired', 'skipped_suppressed']);
    expect(pushed.pending).toBe(0);

    const restated = await call(env, '/api/admin/profiles/hn', 'POST', {
      extractor: 'claude-skill-v2',
      profiles: [{ hnItemId: '46000002', hold: true, reason: 'no_draft_batch', restate: true }]
    });
    expect(restated.results[0].outcome).toBe('held');
    expect(row(env.raw, '46000002')).toMatchObject({ step_out_reason: 'no_draft_batch', step_out_count: 1 });

    expect(await call(env, '/api/ingest/step-outs')).toEqual({
      counts: [
        { stepOut: 'held', reason: 'no_draft_batch', items: 1 },
        { stepOut: 'held', reason: 'source_alive', items: 1 },
        { stepOut: 'retired', reason: 'dead', items: 1 }
      ],
      recovered: 0
    });

    expect(await call(env, '/api/ingest/requeue', 'POST', { reason: 'dead' })).toEqual({
      reason: 'dead',
      requeued: 0,
      retiredNotRequeued: 1,
      pending: 0
    });
    expect(await call(env, '/api/ingest/requeue', 'POST', { reason: 'source_alive' })).toMatchObject({ requeued: 1, pending: 1 });
    expect(await call(env, '/api/ingest/requeue', 'POST', { hnItemIds: ['46000003', '46000004'] })).toMatchObject({
      requeued: 1,
      suppressed: 1,
      pending: 2
    });
    expect(row(env.raw, '46000001')).toMatchObject({ step_out: 'requeued', step_out_reason: 'source_alive', extractor_rank: 1 });

    const listed = await call(env, '/api/ingest/step-outs?reason=dead&stepOut=requeued');
    expect(listed.items.map((entry) => entry.hnItemId)).toEqual(['46000003']);
    expect(env.raw.query('SELECT COUNT(*) AS revisions FROM profile_revisions').get()).toEqual({ revisions: 0 });
  });

  test('the manual backfill marks only unrecorded pre-0007 step-outs, once', () => {
    const db = new Database(':memory:');
    applyMigrations(db);
    ingest(db, '46000001', { rank: 2 }); // held before 0007: no profile at all
    ingest(db, '46000002', { rank: 2, revisionRank: 0 }); // held, deterministic profile still public
    ingest(db, '46000003', { rank: 2, revisionRank: 2 }); // drafted by the model pass
    ingest(db, '46000004', { rank: 0 }); // never reached by a model extractor
    ingest(db, '46000005', { rank: 2, suppressed: true });
    ingest(db, '46000006', { rank: 2 });
    db.run("UPDATE hn_ingests SET step_out = 'retired', step_out_reason = 'deleted', step_out_count = 1 WHERE hn_item_id = '46000006'");

    const sql = readFileSync(MANUAL_BACKFILL, 'utf8');
    db.run(sql);
    db.run(sql);

    const marked = db
      .query("SELECT hn_item_id, step_out, step_out_reason, step_out_count FROM hn_ingests WHERE step_out IS NOT NULL ORDER BY hn_item_id")
      .all();
    expect(marked).toEqual([
      { hn_item_id: '46000001', step_out: 'held', step_out_reason: 'unrecorded', step_out_count: 1 },
      { hn_item_id: '46000002', step_out: 'held', step_out_reason: 'unrecorded', step_out_count: 1 },
      { hn_item_id: '46000006', step_out: 'retired', step_out_reason: 'deleted', step_out_count: 1 }
    ]);
  });
});

function applyMigrations(db, include = () => true) {
  for (const name of readdirSync(MIGRATIONS).filter((file) => file.endsWith('.sql') && include(file)).sort()) {
    db.run(readFileSync(new URL(name, MIGRATIONS), 'utf8'));
  }
}

function ingest(db, hnItemId, { rank = 0, revisionRank = null, suppressed = false } = {}) {
  const at = '2026-09-01T00:00:00.000Z';
  const submissionId = revisionRank === null ? null : `hn-${hnItemId}`;
  if (submissionId) {
    db.run(
      `INSERT INTO submissions (id, source_kind, source_text, review_token_hash, status, created_at, updated_at)
       VALUES (?, 'hn_comment', '', 'hash', 'ingested', ?, ?)`,
      [submissionId, at, at]
    );
    db.run(
      `INSERT INTO profile_revisions (id, submission_id, status, name, role, summary, location, work_mode, availability,
         universities_json, companies_json, skills_json, date_ranges_json, created_at, updated_at, published_at,
         extractor, extractor_rank)
       VALUES (?, ?, 'published', 'n', 'r', 's', 'l', 'Remote', 'Immediate', '[]', '[]', '[]', '[]', ?, ?, ?, 'x', ?)`,
      [`rev-${hnItemId}`, submissionId, at, at, at, revisionRank]
    );
  }
  db.run(
    `INSERT INTO hn_ingests (hn_item_id, submission_id, hn_author, hn_permalink, thread_id, thread_month, comment_hash,
       comment_created_at, suppressed_at, created_at, updated_at, extractor_rank)
     VALUES (?, ?, 'a', 'https://news.ycombinator.com/item?id=1', '1', '2026-09', 'h', ?, ?, ?, ?, ?)`,
    [hnItemId, submissionId, at, suppressed ? at : null, at, at, rank]
  );
}

function row(db, hnItemId) {
  return db.query('SELECT * FROM hn_ingests WHERE hn_item_id = ?').get(hnItemId);
}

// Just enough of the D1 binding for the Worker: positional binds, meta.changes, and an atomic batch.
function sqliteEnv() {
  const raw = new Database(':memory:');
  applyMigrations(raw);
  const prepare = (sql, values = []) => ({
    bind: (...next) => prepare(sql, next),
    first: async () => raw.query(sql).get(...values) ?? null,
    all: async () => ({ results: raw.query(sql).all(...values) }),
    run: async () => ({ success: true, meta: { changes: raw.query(sql).run(...values).changes } })
  });
  const DB = {
    prepare,
    batch: async (statements) => {
      raw.run('BEGIN');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        raw.run('COMMIT');
        return results;
      } catch (error) {
        raw.run('ROLLBACK');
        throw error;
      }
    }
  };
  return { raw, DB, HN_INGEST_TOKEN: TOKEN };
}

async function call(env, path, method = 'GET', body = null) {
  const headers = { authorization: `Bearer ${TOKEN}` };
  if (body !== null) headers['content-type'] = 'application/json';
  const response = await worker.fetch(
    new Request(`https://directory.example${path}`, { method, headers, body: body === null ? undefined : JSON.stringify(body) }),
    env
  );
  const payload = await response.json();
  expect(response.status).toBe(200);
  return payload;
}
