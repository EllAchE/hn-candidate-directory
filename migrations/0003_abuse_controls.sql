-- Fixed-window counters for the D1 rate limiter. One row per bucket; `window_start` is the epoch
-- second the current window opened, so a stale window is reset in the same upsert that increments it.
CREATE TABLE IF NOT EXISTS rate_limits (
  bucket TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  hits INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS rate_limits_window ON rate_limits(window_start);

-- Cron-refreshed counters. `pending_submissions` keeps the storage-capacity check off the hot path.
CREATE TABLE IF NOT EXISTS service_state (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS submissions_status_updated ON submissions(status, updated_at);
