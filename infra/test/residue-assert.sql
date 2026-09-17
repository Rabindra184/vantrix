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

  -- ═══ LOGINS ═══
  -- Both arms of `residue_user`, and both ways it could be too broad.

  SELECT count(*) INTO n FROM "user" WHERE id = 'u-residue-member';
  IF n <> 0 THEN RAISE EXCEPTION 'a residue org''s member survived: the membership arm of residue_user is not deleting'; END IF;

  -- ARM ONE ALONE CAN SEE THIS ONE: a fixed-string address the email shape
  -- does not match, given away only by its membership in a residue org.
  SELECT count(*) INTO n FROM "user" WHERE id = 'u-residue-plain';
  IF n <> 0 THEN RAISE EXCEPTION 'a residue member with a non-fixture email survived: the membership arm of residue_user is gone, and the email arm cannot reach it'; END IF;

  -- THE NEW ARM. Before it existed this row survived every sweep, for ever,
  -- because it has no org_member row for the membership walk to find.
  SELECT count(*) INTO n FROM "user" WHERE id = 'u-residue-orphan';
  IF n <> 0 THEN RAISE EXCEPTION 'the org-less fixture user survived: seedUserWithoutOrg''s residue is unreachable again'; END IF;

  SELECT count(*) INTO n FROM "user" WHERE id = 'u-keeper-member';
  IF n <> 1 THEN RAISE EXCEPTION 'the keeper org''s member was deleted'; END IF;

  -- THE KEEPER THAT DISTINGUISHES THE RULE FROM ITS CARICATURE. A real person
  -- who has signed up and not yet joined an org looks exactly like the orphan
  -- fixture to any rule keyed on membership alone.
  SELECT count(*) INTO n FROM "user" WHERE id = 'u-keeper-orgless';
  IF n <> 1 THEN RAISE EXCEPTION 'a real user with no org was deleted -- the user rule is "no membership" rather than "fixture email shape", which would remove every new signup'; END IF;

  SELECT count(*) INTO n FROM "user" WHERE id = 'u-keeper-shaped';
  IF n <> 1 THEN RAISE EXCEPTION 'a fixture-shaped user in a REAL org was deleted -- the NOT EXISTS(org_member) guard is gone'; END IF;

  RAISE NOTICE 'clean-test-residue.sql: residue removed, keeper intact';
END $$;
