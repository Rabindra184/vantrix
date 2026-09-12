-- Asserts the outcome of infra/clean-test-residue.sql against the seed in
-- residue-test.sql. Any failure raises, so psql exits non-zero.
\set ON_ERROR_STOP on

DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM org
   WHERE id IN ('11111111-1111-1111-1111-111111111111',
                '22222222-2222-2222-2222-222222222222');
  IF n <> 0 THEN RAISE EXCEPTION 'residue orgs survived: %', n; END IF;

  SELECT count(*) INTO n FROM run_stat
   WHERE org_id IN ('11111111-1111-1111-1111-111111111111',
                    '22222222-2222-2222-2222-222222222222');
  IF n <> 0 THEN RAISE EXCEPTION 'orphaned run_stat rows: % -- the FK-free tables are not being deleted, or are deleted AFTER org', n; END IF;

  SELECT count(*) INTO n FROM run_series_bucket
   WHERE org_id IN ('11111111-1111-1111-1111-111111111111',
                    '22222222-2222-2222-2222-222222222222');
  IF n <> 0 THEN RAISE EXCEPTION 'orphaned run_series_bucket rows: %', n; END IF;

  -- The half that matters most: a pattern that grew too broad would pass
  -- every assertion above while destroying real data.
  SELECT count(*) INTO n FROM org WHERE id = '44444444-4444-4444-4444-444444444444';
  IF n <> 1 THEN RAISE EXCEPTION 'the keeper org was deleted -- the residue pattern is too broad'; END IF;

  SELECT count(*) INTO n FROM run_stat WHERE org_id = '44444444-4444-4444-4444-444444444444';
  IF n <> 1 THEN RAISE EXCEPTION 'the keeper run_stat row was deleted: %', n; END IF;

  SELECT count(*) INTO n FROM run_series_bucket WHERE org_id = '44444444-4444-4444-4444-444444444444';
  IF n <> 1 THEN RAISE EXCEPTION 'the keeper run_series_bucket row was deleted: %', n; END IF;

  SELECT count(*) INTO n FROM run WHERE org_id = '44444444-4444-4444-4444-444444444444';
  IF n <> 1 THEN RAISE EXCEPTION 'the keeper run was deleted: %', n; END IF;

  RAISE NOTICE 'clean-test-residue.sql: residue removed, keeper intact';
END $$;
