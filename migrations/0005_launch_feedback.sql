-- Pilot feedback. Write-only from the edge: there is no read route, so a report naming a person or
-- quoting a private detail is only ever readable through an operator `wrangler d1` query.
CREATE TABLE IF NOT EXISTS launch_feedback (
  id TEXT PRIMARY KEY,
  message TEXT NOT NULL,
  contact TEXT,
  candidate_id TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS launch_feedback_created ON launch_feedback(created_at);
