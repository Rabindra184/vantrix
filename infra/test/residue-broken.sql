-- DELIBERATELY WRONG. Not a cleanup script -- a fixture that proves
-- residue-assert.sql can actually fail.
--
-- This is the "simplification" someone reaches for when they see the temp
-- table in infra/clean-test-residue.sql and judge it ceremony: resolve the
-- org set inline instead. Combined with deleting the orgs first, every
-- FK-free row below is orphaned -- the subqueries match nothing once the
-- orgs are gone. Postgres raises nothing, the script exits 0, and the rows
-- are unattributable forever.
--
-- If the CI job's assertion step ever PASSES against this file, the
-- assertion has stopped testing anything and must be fixed.
BEGIN;

DELETE FROM org
 WHERE slug ~ '^org-[0-9a-f]{8}$'
    OR slug ~ '^acme-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

DELETE FROM run_stat WHERE org_id IN (
  SELECT id FROM org
   WHERE slug ~ '^org-[0-9a-f]{8}$'
      OR slug ~ '^acme-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$');

DELETE FROM run_series_bucket WHERE org_id IN (
  SELECT id FROM org
   WHERE slug ~ '^org-[0-9a-f]{8}$'
      OR slug ~ '^acme-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$');

COMMIT;
