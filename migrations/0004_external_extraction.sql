-- Additive only. A widening CHECK constraint is what forced the table rebuild in 0002; nothing
-- here changes one, so ALTER TABLE ADD COLUMN is sufficient and every published_at, revision id
-- and suppression tombstone survives untouched.

-- Which extractor produced the stored profile, and how far it is trusted. The rank is the guard on
-- the revision upsert: the deterministic pass must never overwrite a profile a better extractor
-- already wrote, or the next HN_EXTRACTION_VERSION bump -- which re-derives every ingested comment
-- by design -- would silently undo all of them. An empty `extractor` means the row predates
-- provenance, which is every row that exists today.
ALTER TABLE profile_revisions ADD COLUMN extractor TEXT NOT NULL DEFAULT '';
ALTER TABLE profile_revisions ADD COLUMN extractor_rank INTEGER NOT NULL DEFAULT 0;

-- The same rank on the ingest row answers a different question: which comments a better extractor
-- has already read. It cannot live on the revision, because a comment the deterministic pass could
-- not parse has no revision at all -- and those are exactly the ones worth handing to a better
-- extractor. It resets whenever comment_hash moves, so an edited comment returns to the work queue
-- instead of staying retired on a stale reading.
ALTER TABLE hn_ingests ADD COLUMN extractor_rank INTEGER NOT NULL DEFAULT 0;

-- Provenance for a resume an external extractor read. The Worker never fetches these; they are
-- recorded so a repeat run can skip a document it has already read, and no public response reads
-- either column.
ALTER TABLE hn_ingests ADD COLUMN resume_url TEXT;
ALTER TABLE hn_ingests ADD COLUMN resume_fetched_at TEXT;

CREATE INDEX IF NOT EXISTS hn_ingests_extraction ON hn_ingests(extractor_rank, comment_created_at);
