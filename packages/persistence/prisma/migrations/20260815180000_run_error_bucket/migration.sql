-- Failures on a time axis, run scope. Partitioned on run_started_on exactly
-- like run_series_bucket and run_user_bucket, for retention (NFR-SC-7):
-- dropping a partition beats a delete storm.
--
-- No scope/name/family columns. This table is run scope only; a column that
-- only ever holds one value invites a future reader to filter on it and find
-- the filter silently ignored. Request-scope errors keep their flat rollup in
-- run_error, which is what RQ-11's per-request table reads.
--
-- is_other is a REAL COLUMN rather than the magic message 'other' that
-- ErrorRollup.top() uses. That literal collides with a genuine error message
-- of the same text, which against run_error's unique key
-- (run_id, scope, name, message) is a latent unique violation that would fail
-- an ingest outright. Folded rows here carry message = '' and is_other = true;
-- a real message is never empty, because the engine maps a missing one to
-- '(no message)'.
--
-- bucket_width_ms is constant per run and denormalised deliberately. The
-- alternative is inferBucketWidthMs, which reads the smallest gap between
-- offsets — right for a dense series and systematically wrong for a sparse
-- one: three errors at 5s, 40s and 90s infer a width of 35000ms.
CREATE TABLE "run_error_bucket" (
    "run_started_on"  DATE    NOT NULL,
    "run_id"          UUID    NOT NULL,
    "org_id"          UUID    NOT NULL,
    "project_id"      UUID    NOT NULL,
    "start_offset_ms" INTEGER NOT NULL,
    "message"         TEXT    NOT NULL,
    "is_other"        BOOLEAN NOT NULL,
    "count"           INTEGER NOT NULL,
    "bucket_width_ms" INTEGER NOT NULL,
    -- A unique/primary key on a partitioned table must contain the partition key.
    CONSTRAINT "run_error_bucket_pkey"
      PRIMARY KEY ("run_started_on", "run_id", "start_offset_ms", "message", "is_other")
) PARTITION BY RANGE ("run_started_on");

-- No secondary index on (run_started_on, run_id): those two columns are a
-- strict prefix of the primary key above, so the PK's own btree already serves
-- the only query this table has. The same reasoning 0001_init records for
-- run_series_bucket.

-- Twelve months from 2026-01, matching its two neighbours. Automatic rollover
-- is a later milestone; until then a write past the last partition fails
-- loudly rather than silently landing somewhere wrong.
CREATE TABLE "run_error_bucket_2026_01" PARTITION OF "run_error_bucket"
  FOR VALUES FROM ('2026-01-01') TO ('2026-02-01');
CREATE TABLE "run_error_bucket_2026_02" PARTITION OF "run_error_bucket"
  FOR VALUES FROM ('2026-02-01') TO ('2026-03-01');
CREATE TABLE "run_error_bucket_2026_03" PARTITION OF "run_error_bucket"
  FOR VALUES FROM ('2026-03-01') TO ('2026-04-01');
CREATE TABLE "run_error_bucket_2026_04" PARTITION OF "run_error_bucket"
  FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');
CREATE TABLE "run_error_bucket_2026_05" PARTITION OF "run_error_bucket"
  FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');
CREATE TABLE "run_error_bucket_2026_06" PARTITION OF "run_error_bucket"
  FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');
CREATE TABLE "run_error_bucket_2026_07" PARTITION OF "run_error_bucket"
  FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');
CREATE TABLE "run_error_bucket_2026_08" PARTITION OF "run_error_bucket"
  FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');
CREATE TABLE "run_error_bucket_2026_09" PARTITION OF "run_error_bucket"
  FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
CREATE TABLE "run_error_bucket_2026_10" PARTITION OF "run_error_bucket"
  FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');
CREATE TABLE "run_error_bucket_2026_11" PARTITION OF "run_error_bucket"
  FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');
CREATE TABLE "run_error_bucket_2026_12" PARTITION OF "run_error_bucket"
  FOR VALUES FROM ('2026-12-01') TO ('2027-01-01');
