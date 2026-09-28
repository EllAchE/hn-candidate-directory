-- Additive only, following 0004 and 0006: ALTER TABLE ADD COLUMN, no rebuild, every row survives.
--
-- Apply this BEFORE deploying the Worker that writes these columns. That Worker's push, requeue and
-- step-outs statements name them, so against an unmigrated database every step-out -- and every
-- draft that ends one -- fails with "no such column" and the page run stalls.

-- Why an item left the extractor's queue without a draft. `step_out` is 'held', 'retired' or
-- 'requeued' (sent back to the queue by /api/ingest/requeue), and NULL once a draft lands or if it
-- never stepped out. There is no CHECK on either column on purpose: widening one means rebuilding the
-- table, as 0002 had to, and the Worker validates both against a closed list before writing.
ALTER TABLE hn_ingests ADD COLUMN step_out TEXT;
ALTER TABLE hn_ingests ADD COLUMN step_out_reason TEXT;
ALTER TABLE hn_ingests ADD COLUMN step_out_at TEXT;
ALTER TABLE hn_ingests ADD COLUMN step_out_extractor TEXT;
-- Kept when a draft finally clears the step-out, so it also counts the tries a recovered item took.
ALTER TABLE hn_ingests ADD COLUMN step_out_count INTEGER NOT NULL DEFAULT 0;

-- Requeue by reason, and the paged id list for one reason, both walk this.
CREATE INDEX IF NOT EXISTS hn_ingests_step_out ON hn_ingests(step_out_reason, hn_item_id);
