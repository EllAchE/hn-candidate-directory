-- Additive only, following 0004: no CHECK constraint moves, so ALTER TABLE ADD COLUMN is enough and
-- every published_at, revision id and suppression tombstone survives untouched.

-- The HN handle, separated from `name`. Until now `name` held the handle whenever a comment carried
-- no labelled name line, which is most of them -- so the directory listed people under a username
-- and had nowhere to put a real name once an extractor found one. Splitting the two lets `name`
-- hold the person and keeps the handle addressable. Empty means the profile did not come from HN.
ALTER TABLE profile_revisions ADD COLUMN hn_username TEXT NOT NULL DEFAULT '';

-- Links a candidate published in their own comment. Stored canonicalized (scheme, host and path
-- only) rather than as written: a query string on a profile link is tracking or a session, never
-- part of the destination, and dropping it removes the surface entirely instead of filtering it.
ALTER TABLE profile_revisions ADD COLUMN linkedin_url TEXT NOT NULL DEFAULT '';
ALTER TABLE profile_revisions ADD COLUMN github_url TEXT NOT NULL DEFAULT '';
ALTER TABLE profile_revisions ADD COLUMN personal_url TEXT NOT NULL DEFAULT '';
