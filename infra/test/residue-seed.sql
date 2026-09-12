-- Seeds two residue orgs (one per fixture pattern) and one org that must
-- survive, each carrying a row in a plain FK-free table and a partitioned
-- one. Run infra/clean-test-residue.sql between this and residue-assert.sql.
\set ON_ERROR_STOP on

BEGIN;

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

COMMIT;
