-- Exact 1ms histograms, beside the sketch and under the same key. Nullable
-- because runs ingested before this migration have none, and the read path
-- reports `configurable: false` for them rather than pretending otherwise.
ALTER TABLE "run_stat" ADD COLUMN "histogram_ok" BYTEA;
ALTER TABLE "run_stat" ADD COLUMN "histogram_ko" BYTEA;
ALTER TABLE "run_stat" ADD COLUMN "histogram_kind" TEXT;

-- Indicator bands are now a read-time fold over histogram_ok, at whatever
-- bounds the project currently has. Storing them froze the bounds at ingest,
-- which AC-PARITY-4 forbids. `failed` was always just run_stat.ko_count.
DROP TABLE "run_indicator";

-- Errors gain a scope so a request detail page can show its own (RQ-11).
-- Existing rows are run-scope by construction.
ALTER TABLE "run_error" ADD COLUMN "scope" TEXT NOT NULL DEFAULT 'run';
ALTER TABLE "run_error" ADD COLUMN "name" TEXT NOT NULL DEFAULT '';
ALTER TABLE "run_error" ALTER COLUMN "scope" DROP DEFAULT;
ALTER TABLE "run_error" ALTER COLUMN "name" DROP DEFAULT;
CREATE UNIQUE INDEX "run_error_run_scope_name_message_key"
  ON "run_error" ("run_id", "scope", "name", "message");

-- Run header fields (G-01, G-02, G-04). duration_ms is the tool's own span,
-- unrelated to ingest timing.
ALTER TABLE "run" ADD COLUMN "simulation" TEXT;
ALTER TABLE "run" ADD COLUMN "description" TEXT;
ALTER TABLE "run" ADD COLUMN "duration_ms" INTEGER;

-- Per-scenario user arrival rate and concurrency (G-18, G-19, G-26).
-- Partitioned on run_started_on exactly like run_series_bucket, for retention.
CREATE TABLE "run_user_bucket" (
    "run_started_on" DATE NOT NULL,
    "run_id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "scenario" TEXT NOT NULL,
    "start_offset_ms" INTEGER NOT NULL,
    "started" INTEGER NOT NULL,
    "ended" INTEGER NOT NULL,
    "max_concurrent" INTEGER NOT NULL,
    -- A unique/primary key on a partitioned table must contain the partition key.
    CONSTRAINT "run_user_bucket_pkey"
      PRIMARY KEY ("run_started_on", "run_id", "scenario", "start_offset_ms")
) PARTITION BY RANGE ("run_started_on");

CREATE TABLE "run_user_bucket_2026_01" PARTITION OF "run_user_bucket"
  FOR VALUES FROM ('2026-01-01') TO ('2026-02-01');
CREATE TABLE "run_user_bucket_2026_02" PARTITION OF "run_user_bucket"
  FOR VALUES FROM ('2026-02-01') TO ('2026-03-01');
CREATE TABLE "run_user_bucket_2026_03" PARTITION OF "run_user_bucket"
  FOR VALUES FROM ('2026-03-01') TO ('2026-04-01');
CREATE TABLE "run_user_bucket_2026_04" PARTITION OF "run_user_bucket"
  FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');
CREATE TABLE "run_user_bucket_2026_05" PARTITION OF "run_user_bucket"
  FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');
CREATE TABLE "run_user_bucket_2026_06" PARTITION OF "run_user_bucket"
  FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');
CREATE TABLE "run_user_bucket_2026_07" PARTITION OF "run_user_bucket"
  FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');
CREATE TABLE "run_user_bucket_2026_08" PARTITION OF "run_user_bucket"
  FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');
CREATE TABLE "run_user_bucket_2026_09" PARTITION OF "run_user_bucket"
  FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
CREATE TABLE "run_user_bucket_2026_10" PARTITION OF "run_user_bucket"
  FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');
CREATE TABLE "run_user_bucket_2026_11" PARTITION OF "run_user_bucket"
  FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');
CREATE TABLE "run_user_bucket_2026_12" PARTITION OF "run_user_bucket"
  FOR VALUES FROM ('2026-12-01') TO ('2027-01-01');
