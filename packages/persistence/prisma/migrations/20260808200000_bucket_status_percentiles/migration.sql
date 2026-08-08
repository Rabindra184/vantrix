-- Gatling's percentiles-over-time chart is OK-only and its response-time-
-- throughput scatter is two independent status-filtered series. The existing
-- `percentiles` column spans both statuses, so it cannot serve either without
-- being wrong whenever a bucket mixes them.
--
-- Nullable: rows written before this migration have no per-status figures, and
-- the reader reports {} for them rather than inventing numbers.
ALTER TABLE "run_series_bucket" ADD COLUMN "percentiles_ok" JSONB;
ALTER TABLE "run_series_bucket" ADD COLUMN "percentiles_ko" JSONB;
