-- Seeds two residue orgs (one per fixture pattern) and one org that must
-- survive, each carrying a row in a plain FK-free table and a partitioned
-- one. Run infra/clean-test-residue.sql between this and residue-assert.sql.
\set ON_ERROR_STOP on

BEGIN;

-- ═══ THE SEED OWNS ITS USER ROWS AND MUST CLEAR THEM FIRST ═══
--
-- Callers reset the tables around this file with `TRUNCATE org CASCADE`, which
-- reaches everything that REFERENCES `org` -- project, org_member, run and the
-- rest. It does NOT reach `"user"`: that table is referenced BY `org_member`
-- and references nothing, so a truncate of `org` leaves every login standing.
--
-- So the KEEPER users survive a reset by construction, and a second seed then
-- hits `duplicate key value violates unique constraint "user_pkey"`. Because
-- this file is one transaction, that does not merely skip the users -- it rolls
-- back the ORGS, RUNS and metric rows too, and the caller is left with an empty
-- database that every "residue is gone" assertion passes against.
--
-- That is exactly how it failed: `.github/workflows/ci.yml`'s red-verify step
-- seeds a SECOND time, and the vacuous-assertion check it exists to make fired
-- on a database holding nothing at all.
DELETE FROM "user" WHERE id IN (
  'u-residue-member', 'u-residue-plain', 'u-residue-orphan',
  'u-keeper-member', 'u-keeper-orgless', 'u-keeper-shaped'
);

INSERT INTO org (id, slug, name) VALUES
  ('11111111-1111-1111-1111-111111111111', 'org-deadbeef',                           'Residue A'),
  ('22222222-2222-2222-2222-222222222222', 'acme-33333333-3333-3333-3333-333333333333', 'Residue B'),
  ('44444444-4444-4444-4444-444444444444', 'keeper-real-org',                        'Keeper');

INSERT INTO project (id, org_id, slug, name, settings)
SELECT ('5'||substr(o.id::text, 2))::uuid, o.id, 'proj', 'Proj', '{}'::jsonb FROM org o
 WHERE o.id IN ('11111111-1111-1111-1111-111111111111',
                '22222222-2222-2222-2222-222222222222',
                '44444444-4444-4444-4444-444444444444');

INSERT INTO run (id, org_id, project_id, status, tool, bundle_key, bundle_sha256,
                 bundle_bytes, started_at, started_on, engine_options)
SELECT ('6'||substr(p.id::text, 2))::uuid, p.org_id, p.id, 'complete', 'gatling',
       'k', 'sha', 1, now(), current_date, '{}'::jsonb
  FROM project p WHERE p.slug = 'proj';

-- A plain FK-free table.
INSERT INTO run_stat (id, run_id, org_id, project_id, scope, name, family, count,
                      ok_count, ko_count, error_rate, min_ms, max_ms, mean_ms,
                      stddev_ms, throughput_rps, percentiles, sketch, sketch_kind)
SELECT ('7'||substr(r.id::text, 2))::uuid, r.id, r.org_id, r.project_id, 'run', '',
       'response_time', 1, 1, 0, 0, 1, 1, 1, 0, 1, '{}'::jsonb, '\x00'::bytea, 'ddsketch'
  FROM run r WHERE r.bundle_key = 'k';

-- A PARTITIONED FK-free table: proves the DELETE routes into partitions.
INSERT INTO run_series_bucket (run_started_on, run_id, org_id, project_id, scope, name,
                               start_offset_ms, started_count, ended_count, ok_count,
                               ko_count, min_ms, max_ms, mean_ms, percentiles, family)
SELECT current_date, r.id, r.org_id, r.project_id, 'run', '', 0, 1, 1, 1, 0,
       1, 1, 1, '{}'::jsonb, 'response_time'
  FROM run r WHERE r.bundle_key = 'k';

-- ═══ LOGINS: FIVE, BECAUSE THE USER RULE HAS TWO ARMS AND TWO WAYS TO BE TOO
--     BROAD ═══
--
-- Nothing seeded users before this, so BOTH arms of `residue_user` ran
-- unguarded: the membership walk and the email-shape match. Each user below
-- exists to make one of the four outcomes falsifiable.
--
-- `updatedAt` has no default on this table; `createdAt` does.
INSERT INTO "user" (id, name, email, "updatedAt") VALUES
  -- DELETED by arm one: a fixture user whose only membership is a residue org.
  ('u-residue-member', 'Residue Admin',  'admin-deadbeef@example.test',  CURRENT_TIMESTAMP),
  -- DELETED by arm two: `seedUserWithoutOrg`'s shape, which has NO membership
  -- at all and is therefore invisible to arm one. This is the row that was
  -- found surviving a real full sweep on 2026-09-17.
  ('u-residue-orphan', 'Residue Orphan', 'orphan-cafebabe@example.test', CURRENT_TIMESTAMP),
  -- DELETED by arm one ALONE. Its email is a fixed string, not `unique()`'s
  -- shape, so arm two cannot see it -- the API integration fixtures sign up
  -- addresses like this (`minter@`, `uploader@`, `admin@`) and only its
  -- membership in a residue org gives it away.
  --
  -- WITHOUT THIS ROW THE TWO ARMS ARE INDISTINGUISHABLE. Every other fixture
  -- user here matches the email shape as well as the membership, so deleting
  -- arm one entirely left this fixture green -- measured, and the reason this
  -- row exists.
  ('u-residue-plain',  'Residue Plain',  'minter@example.test',         CURRENT_TIMESTAMP),
  -- KEPT: a real person in the keeper org. The ordinary case.
  ('u-keeper-member',  'Keeper Human',   'human@keeper.example.com',     CURRENT_TIMESTAMP),
  -- KEPT, AND THIS IS THE ONE THAT MATTERS MOST: a real person who belongs to
  -- no org yet -- signed up, not invited. Arm two must be a claim about the
  -- fixture EMAIL SHAPE and never "delete every user without a membership",
  -- and only this row can tell those two apart.
  ('u-keeper-orgless', 'Keeper Orgless', 'newcomer@keeper.example.com',  CURRENT_TIMESTAMP),
  -- KEPT: fixture-SHAPED, but a member of the keeper org. Proves the
  -- `NOT EXISTS (org_member)` guard still spares a matching user who has a
  -- surviving membership -- the half that stops a pattern match from being
  -- the whole decision.
  ('u-keeper-shaped',  'Keeper Shaped',  'admin-feedface@example.test',  CURRENT_TIMESTAMP);

INSERT INTO org_member (user_id, org_id, role) VALUES
  ('u-residue-member', '11111111-1111-1111-1111-111111111111', 'admin'),
  ('u-residue-plain',  '22222222-2222-2222-2222-222222222222', 'member'),
  ('u-keeper-member',  '44444444-4444-4444-4444-444444444444', 'admin'),
  ('u-keeper-shaped',  '44444444-4444-4444-4444-444444444444', 'admin');

COMMIT;
