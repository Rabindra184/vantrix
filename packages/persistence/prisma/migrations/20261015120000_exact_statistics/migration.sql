-- Exact statistics (docs/superpowers/specs/2026-10-15-exact-statistics-design.md).
-- New rows carry no DDSketch; rows written before keep theirs until the
-- backfill (PR 2) and the clean-up (PR 5).
ALTER TABLE run_stat ALTER COLUMN sketch DROP NOT NULL;
ALTER TABLE run_stat ALTER COLUMN sketch_kind DROP NOT NULL;

-- Existing runs are 'estimated'; the default then flips so every run created
-- from now on is 'exact-v1' without touching any insert statement.
ALTER TABLE run ADD COLUMN stats_method text NOT NULL DEFAULT 'estimated';
ALTER TABLE run ALTER COLUMN stats_method SET DEFAULT 'exact-v1';
ALTER TABLE run ADD CONSTRAINT run_stats_method_check CHECK (stats_method IN ('estimated', 'exact-v1'));
