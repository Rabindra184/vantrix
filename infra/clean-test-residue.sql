-- Remove the orgs the test suites leave behind, and everything under them.
--
-- WHY THIS EXISTS. `pnpm test:integration` truncates every table on setup, so
-- it cleans up after itself. `pnpm test:e2e` does NOT -- it seeds through the
-- real API and leaves its orgs in place. On a long-lived dev machine that
-- accumulates: measured 2026-09-12 at 1793 orgs, 2933 runs, 1792 logins and
-- 1,159,383 metrics rows, in a database that `VACUUM (FULL, ANALYZE)` then
-- took from 728 MB to 10 MB.
--
-- IT DELETES BY PATTERN, NEVER BY "EVERYTHING EXCEPT". That is the whole
-- safety property: the two regexes below match only what a test FIXTURE
-- generates, so running this against a database holding real data is a no-op
-- rather than a catastrophe. A keep-list would invert that -- one wrong id and
-- it deletes the thing you meant to protect.
--
-- The two shapes, each grepped from the source rather than from a sample:
--
--   org-<hex8>   `org-${randomUUID().slice(0, 8)}` -- apps/api/test/support/app.ts,
--                auth.integration.test.ts, live-gateway.integration.test.ts,
--                and apps/web/e2e/fixtures.ts's `unique('org')`
--   acme-<uuid>  `acme-${randomUUID()}` -- apps/worker/test/fold-owner and
--                sla-agreement integration tests
--
-- ADD A PATTERN HERE WHEN A FIXTURE ADDS ONE. `.github/workflows/ci.yml`'s
-- `test-residue` job fails if a table this script does not name starts
-- carrying `org_id` without a foreign key -- but nothing can detect a new
-- SLUG shape for you, because an unmatched org is indistinguishable from a
-- real one by design.
--
-- THE TEMP TABLE IS THE SAFETY MECHANISM, NOT THE STATEMENT ORDER.
-- `run_stat`, `run_error`, `run_error_bucket`, `run_series_bucket`,
-- `run_user_bucket` and `telemetry_sample` carry `org_id` but have NO foreign
-- key -- they are partitioned and deliberately FK-free for write throughput.
-- So `DELETE FROM org` does NOT reach them, and a script that resolves the
-- org set INLINE (`WHERE org_id IN (SELECT id FROM org WHERE slug ~ ...)`)
-- orphans every one of those rows the moment the orgs go first: the subquery
-- then matches nothing, nothing is raised, and the rows are unattributable
-- forever. Capturing the ids in `residue_org` up front removes that coupling
-- entirely -- measured, the deletes below can be reordered freely and still
-- produce the identical result.
--
-- The statements are still written orgs-last, because that reads in dependency
-- order and costs nothing. Do not "simplify" the temp table away to achieve
-- the same thing; that is the exact regression `.github/workflows/ci.yml`'s
-- `test-residue` job red-verifies, and it fails there with
-- `orphaned run_stat rows: 2`.
--
-- The FK-free set was read out of `pg_constraint`, not inferred from
-- `schema.prisma`, which reads as though `org` owns everything beneath it.
--
-- What org DOES cascade to, and so is absent below: `org_member`, `project`,
-- and via `project` to `api_token`, `run`, `sla_rule`, `test`, `runner_job`,
-- `runner_artifact`; and via `run` to `run_assertion`.
--
-- OUT OF SCOPE, deliberately: the `test-<uuid>` MinIO buckets that
-- `packages/storage`'s integration tests create. Those are S3 objects, not
-- rows, and removing them safely needs a signed S3 client -- deleting the
-- directories under MinIO's `/data` corrupts its own metadata. Prune them
-- with `mc rb --force`, not with this file.
--
-- Usage (the local stack from infra/docker-compose.yml):
--
--   docker exec -i infra-postgres-1 psql -U perfportal -d perfportal \
--     -v ON_ERROR_STOP=1 < infra/clean-test-residue.sql
--
-- Idempotent: a second run deletes nothing and reports zeroes. Run
-- `VACUUM (FULL, ANALYZE);` afterwards to actually return the disk --
-- autovacuum marks the space reusable but does not shrink the database, and
-- CLAUDE.md records disk and inode exhaustion as a real hazard on this
-- machine.

BEGIN;

-- Captured BEFORE anything is deleted: once the orgs are gone, neither the
-- FK-free metrics rows nor the memberships can be attributed to them.
CREATE TEMP TABLE residue_org ON COMMIT DROP AS
SELECT id, slug
  FROM org
 WHERE slug ~ '^org-[0-9a-f]{8}$'
    OR slug ~ '^acme-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

-- `org_member` cascades from `org`, so this set is unrecoverable afterwards.
-- A user is only deleted below if it ends up with NO membership at all, so
-- one that also belongs to a real org survives.
--
-- ═══ TWO ARMS, BECAUSE MEMBERSHIP ALONE CANNOT SEE EVERY FIXTURE USER ═══
--
-- The first arm walks `org_member`, which finds every user a residue org ever
-- admitted. It CANNOT find a user that never had a membership at all -- and
-- `seedUserWithoutOrg` (apps/web/e2e/fixtures.ts) creates exactly that on
-- purpose, for the 403-after-login case. Such a user has no org, no project and
-- no rows anywhere else, so nothing else in this file reaches it either: it
-- accumulates at one per `pnpm test:e2e` run, for ever, invisible.
--
-- Measured 2026-09-17 on this machine: a full sweep left the database at 0 orgs
-- and 0 runs with exactly one row in `user` -- `orphan-f8110219@example.test`.
-- It survived every statement here and would have survived every future run.
--
-- The second arm therefore matches the EMAIL SHAPE, which is the same
-- delete-by-pattern property the org regexes above rest on rather than a new
-- kind of rule. Every fixture user in that file is built by one helper --
-- `unique(prefix)` = `${prefix}-${randomUUID().slice(0, 8)}` -- at the
-- RFC 2606 reserved `example.test` domain, so the shape IS the contract and a
-- human address cannot collide with it. Its three producers today:
--
--   admin-<hex8>        seedAdmin            (has a membership; arm one finds it)
--   empty-admin-<hex8>  seedAdminForEmptyOrg (has a membership; arm one finds it)
--   orphan-<hex8>       seedUserWithoutOrg   (has NONE; only arm two finds it)
--
-- MATCHING THE SHAPE RATHER THAN THE THREE PREFIXES IS DELIBERATE. The org
-- patterns above are two hand-written slugs and each new one has to be added
-- here by hand; these are one helper's output, so a fourth fixture is covered
-- the day it is written. That closes for users the gap this file admits it
-- cannot close for orgs ("nothing can detect a new SLUG shape for you").
--
-- AND THE `NOT EXISTS` GUARD ON THE DELETE IS WHAT KEEPS BOTH ARMS SAFE. A
-- user matching either arm is still spared if it holds ANY surviving
-- membership, so a fixture-named account that somebody added to a real org is
-- never removed by this file.
CREATE TEMP TABLE residue_user ON COMMIT DROP AS
SELECT DISTINCT m.user_id AS id
  FROM org_member m
 WHERE m.org_id IN (SELECT id FROM residue_org)
 UNION
SELECT u.id
  FROM "user" u
 WHERE u.email ~ '^[a-z][a-z-]*-[0-9a-f]{8}@example\.test$';

\echo 'orgs matched:'
SELECT count(*) AS residue_orgs FROM residue_org;

-- 1. The FK-free tables. Nothing cascades to these.
DELETE FROM telemetry_sample  WHERE org_id IN (SELECT id FROM residue_org);
DELETE FROM run_series_bucket WHERE org_id IN (SELECT id FROM residue_org);
DELETE FROM run_user_bucket   WHERE org_id IN (SELECT id FROM residue_org);
DELETE FROM run_error_bucket  WHERE org_id IN (SELECT id FROM residue_org);
DELETE FROM run_error         WHERE org_id IN (SELECT id FROM residue_org);
DELETE FROM run_stat          WHERE org_id IN (SELECT id FROM residue_org);

-- 2. The orgs, which cascade to projects, runs, tests, tokens, rules and
--    memberships.
DELETE FROM org WHERE id IN (SELECT id FROM residue_org);

-- 3. Logins are not reachable from `org` at all. `account` and `session`
--    cascade from `user`.
DELETE FROM "user" u
 WHERE u.id IN (SELECT id FROM residue_user)
   AND NOT EXISTS (SELECT 1 FROM org_member m WHERE m.user_id = u.id);

COMMIT;
