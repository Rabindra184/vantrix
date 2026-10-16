-- Exact statistics PR 2: recompute bookkeeping and verdict changes.
-- No backticks in comments: Prisma runs this file as-is, and the repo's
-- SQL also lives inside template literals elsewhere.

ALTER TABLE run ADD COLUMN recompute_error text NULL;
ALTER TABLE run ADD CONSTRAINT run_recompute_error_check
  CHECK (recompute_error IN ('raw_log_missing', 'checksum_mismatch', 'parse_failed'));
-- timestamptz(3), the precision every other instant on run carries, so the
-- schema's Timestamptz(3) describes what this builds.
ALTER TABLE run ADD COLUMN recomputed_at timestamptz(3) NULL;

-- A run with no statistics rows has no estimated figure to show. Labelling
-- it exact is vacuous and keeps the backfill's progress count honest.
UPDATE run SET stats_method = 'exact-v1'
 WHERE stats_method = 'estimated'
   AND NOT EXISTS (SELECT 1 FROM run_stat s WHERE s.run_id = run.id);

CREATE TABLE run_verdict_change (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  org_id uuid NOT NULL,
  project_id uuid NOT NULL,
  rule_snapshot jsonb NOT NULL,
  old_outcome text NOT NULL,
  new_outcome text NOT NULL,
  old_value double precision NULL,
  new_value double precision NULL,
  old_verdict text NOT NULL,
  new_verdict text NOT NULL,
  changed_at timestamptz(3) NOT NULL DEFAULT now()
);
CREATE INDEX run_verdict_change_run_id_idx ON run_verdict_change (run_id);
