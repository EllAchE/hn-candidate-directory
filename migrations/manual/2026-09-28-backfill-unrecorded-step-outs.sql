-- MANUAL, for a human to run once, after 0007 is applied and the new Worker is deployed. Wrangler does
-- not apply files in this directory. Run it after scripts/extract-hn-profiles/backfill-step-outs.mjs:
-- that script names the reason for every step-out a page run left on disk, and this catches what it
-- could not see, marking it held/'unrecorded' so it shows up in /api/ingest/step-outs and can be
-- requeued. Either order is safe: this touches only rows with no step-out recorded at all, and the
-- backfill still upgrades an 'unrecorded' reason it can name.
--
-- A row is a pre-0007 step-out when a model extractor's rank was reached (extractor_rank >= 1) but no
-- model-written profile is published for it. That is wider than "no published revision": a held item
-- whose deterministic (rank 0) profile is public was still held by the model pass, and belongs here.
-- A comment retired through a draft:null push also matches, and lands as held/'unrecorded'; requeue
-- by reason never reaches it unless someone asks for 'unrecorded', and the step-out is kept either way.
-- Idempotent: step_out_count = 0 excludes every row this or the Worker already recorded.
UPDATE hn_ingests
   SET step_out = 'held',
       step_out_reason = 'unrecorded',
       step_out_at = updated_at,
       step_out_count = step_out_count + 1
 WHERE step_out IS NULL
   AND step_out_count = 0
   AND suppressed_at IS NULL
   AND extractor_rank >= 1
   AND NOT EXISTS (
         SELECT 1 FROM profile_revisions r
          WHERE r.submission_id = hn_ingests.submission_id
            AND r.status = 'published'
            AND r.extractor_rank >= 1
       );
