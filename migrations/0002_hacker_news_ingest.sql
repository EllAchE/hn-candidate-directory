-- SQLite cannot alter a CHECK constraint, so widening `submissions.source_kind` and
-- `submissions.status` requires a table rebuild. `jobs` and `profile_revisions` are rebuilt
-- with it: they must point at the replacement table before the original is dropped, or the
-- implicit DELETE behind DROP TABLE would cascade their rows away.
PRAGMA defer_foreign_keys = true;

DROP TABLE IF EXISTS submissions_0002;
DROP TABLE IF EXISTS jobs_0002;
DROP TABLE IF EXISTS profile_revisions_0002;

CREATE TABLE submissions_0002 (
  id TEXT PRIMARY KEY,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('text', 'hn_comment')),
  source_text TEXT NOT NULL,
  review_token_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('submitted', 'processing', 'review_ready', 'ingested', 'failed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO submissions_0002 (id, source_kind, source_text, review_token_hash, status, created_at, updated_at)
SELECT id, source_kind, source_text, review_token_hash, status, created_at, updated_at FROM submissions;

CREATE TABLE jobs_0002 (
  id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL UNIQUE REFERENCES submissions_0002(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind = 'extract_profile'),
  status TEXT NOT NULL CHECK (status IN ('queued', 'processing', 'completed', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO jobs_0002 (id, submission_id, kind, status, attempts, error, created_at, updated_at)
SELECT id, submission_id, kind, status, attempts, error, created_at, updated_at FROM jobs;

CREATE TABLE profile_revisions_0002 (
  id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL UNIQUE REFERENCES submissions_0002(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('review_ready', 'published', 'archived')),
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  summary TEXT NOT NULL,
  location TEXT NOT NULL,
  work_mode TEXT NOT NULL,
  availability TEXT NOT NULL,
  universities_json TEXT NOT NULL DEFAULT '[]',
  companies_json TEXT NOT NULL DEFAULT '[]',
  skills_json TEXT NOT NULL DEFAULT '[]',
  date_ranges_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  published_at TEXT
);

INSERT INTO profile_revisions_0002 (
  id, submission_id, status, name, role, summary, location, work_mode, availability,
  universities_json, companies_json, skills_json, date_ranges_json, created_at, updated_at, published_at
)
SELECT
  id, submission_id, status, name, role, summary, location, work_mode, availability,
  universities_json, companies_json, skills_json, date_ranges_json, created_at, updated_at, published_at
FROM profile_revisions;

DROP TABLE profile_revisions;
DROP TABLE jobs;
DROP TABLE submissions;

ALTER TABLE submissions_0002 RENAME TO submissions;
ALTER TABLE jobs_0002 RENAME TO jobs;
ALTER TABLE profile_revisions_0002 RENAME TO profile_revisions;

CREATE INDEX IF NOT EXISTS profile_revisions_public_search ON profile_revisions(status, published_at DESC);

-- `submission_id` deliberately survives its submission with ON DELETE SET NULL. The suppression
-- tombstone is keyed on the immutable Hacker News item id, so deleting the ingested profile can
-- never let a later ingest resurrect a comment somebody asked to remove.
CREATE TABLE IF NOT EXISTS hn_ingests (
  hn_item_id TEXT PRIMARY KEY,
  submission_id TEXT UNIQUE REFERENCES submissions(id) ON DELETE SET NULL,
  hn_author TEXT NOT NULL,
  hn_permalink TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  thread_month TEXT NOT NULL,
  comment_hash TEXT NOT NULL,
  comment_created_at TEXT NOT NULL,
  suppressed_at TEXT,
  suppressed_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS hn_ingests_thread ON hn_ingests(thread_id, suppressed_at);
CREATE INDEX IF NOT EXISTS hn_ingests_submission ON hn_ingests(submission_id);
