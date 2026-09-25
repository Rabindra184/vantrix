-- Twelve months of 2027 partitions for every metrics table.
--
-- WHY THIS EXISTS, AND WHY IT IS NOT THE REAL FIX. 0001_init says it plainly:
-- "Twelve months from 2026-01. Automatic rollover is a later milestone; until
-- then a write past the last partition fails loudly rather than silently
-- landing somewhere wrong." That choice is right -- a DEFAULT partition would
-- accept 2027 rows into a bag that retention cannot drop, which is worse than
-- an error. What was missing is that a deferral with no date becomes a cliff
-- when the date arrives, and nothing measured the distance.
--
-- MEASURED BEFORE THIS MIGRATION, against a migrated database on 2026-09-25:
--
--   run_series_bucket   last = FOR VALUES FROM ('2026-12-01') TO ('2027-01-01')
--   run_error_bucket    last = FOR VALUES FROM ('2026-12-01') TO ('2027-01-01')
--   run_user_bucket     last = FOR VALUES FROM ('2026-12-01') TO ('2027-01-01')
--   telemetry_sample    last = FOR VALUES FROM ('2026-12-01') TO ('2027-01-01')
--
-- and a real insert:
--
--   2026-12-31 -> INSERT 0 1
--   2027-01-01 -> ERROR: no partition of relation "run_series_bucket" found for row
--
-- 98 days of runway. The partition key is the RUN's own start date, so from
-- 1 January 2027 every new load test would have failed to ingest -- on all
-- four tables at once.
--
-- THIS BUYS TWELVE MONTHS AND THE GUARD IS WHAT MAKES THAT HONEST.
-- `packages/persistence/test/partition-runway.integration.test.ts` fails when
-- the furthest partition ends inside the floor, so the next extension is
-- announced by a red build months ahead instead of by an outage. Extending
-- without that guard would only move the cliff and lose the one thing this
-- discovery produced.
--
-- Automatic rollover is still the milestone 0001_init names, and it is still
-- not this: a job that creates partitions ahead of the clock is a feature with
-- its own failure modes (who runs it, what happens when it does not).


-- run_series_bucket (partitioned by run_started_on)
CREATE TABLE "run_series_bucket_2027_01" PARTITION OF "run_series_bucket"
  FOR VALUES FROM ('2027-01-01') TO ('2027-02-01');
CREATE TABLE "run_series_bucket_2027_02" PARTITION OF "run_series_bucket"
  FOR VALUES FROM ('2027-02-01') TO ('2027-03-01');
CREATE TABLE "run_series_bucket_2027_03" PARTITION OF "run_series_bucket"
  FOR VALUES FROM ('2027-03-01') TO ('2027-04-01');
CREATE TABLE "run_series_bucket_2027_04" PARTITION OF "run_series_bucket"
  FOR VALUES FROM ('2027-04-01') TO ('2027-05-01');
CREATE TABLE "run_series_bucket_2027_05" PARTITION OF "run_series_bucket"
  FOR VALUES FROM ('2027-05-01') TO ('2027-06-01');
CREATE TABLE "run_series_bucket_2027_06" PARTITION OF "run_series_bucket"
  FOR VALUES FROM ('2027-06-01') TO ('2027-07-01');
CREATE TABLE "run_series_bucket_2027_07" PARTITION OF "run_series_bucket"
  FOR VALUES FROM ('2027-07-01') TO ('2027-08-01');
CREATE TABLE "run_series_bucket_2027_08" PARTITION OF "run_series_bucket"
  FOR VALUES FROM ('2027-08-01') TO ('2027-09-01');
CREATE TABLE "run_series_bucket_2027_09" PARTITION OF "run_series_bucket"
  FOR VALUES FROM ('2027-09-01') TO ('2027-10-01');
CREATE TABLE "run_series_bucket_2027_10" PARTITION OF "run_series_bucket"
  FOR VALUES FROM ('2027-10-01') TO ('2027-11-01');
CREATE TABLE "run_series_bucket_2027_11" PARTITION OF "run_series_bucket"
  FOR VALUES FROM ('2027-11-01') TO ('2027-12-01');
CREATE TABLE "run_series_bucket_2027_12" PARTITION OF "run_series_bucket"
  FOR VALUES FROM ('2027-12-01') TO ('2028-01-01');

-- run_error_bucket (partitioned by run_started_on)
CREATE TABLE "run_error_bucket_2027_01" PARTITION OF "run_error_bucket"
  FOR VALUES FROM ('2027-01-01') TO ('2027-02-01');
CREATE TABLE "run_error_bucket_2027_02" PARTITION OF "run_error_bucket"
  FOR VALUES FROM ('2027-02-01') TO ('2027-03-01');
CREATE TABLE "run_error_bucket_2027_03" PARTITION OF "run_error_bucket"
  FOR VALUES FROM ('2027-03-01') TO ('2027-04-01');
CREATE TABLE "run_error_bucket_2027_04" PARTITION OF "run_error_bucket"
  FOR VALUES FROM ('2027-04-01') TO ('2027-05-01');
CREATE TABLE "run_error_bucket_2027_05" PARTITION OF "run_error_bucket"
  FOR VALUES FROM ('2027-05-01') TO ('2027-06-01');
CREATE TABLE "run_error_bucket_2027_06" PARTITION OF "run_error_bucket"
  FOR VALUES FROM ('2027-06-01') TO ('2027-07-01');
CREATE TABLE "run_error_bucket_2027_07" PARTITION OF "run_error_bucket"
  FOR VALUES FROM ('2027-07-01') TO ('2027-08-01');
CREATE TABLE "run_error_bucket_2027_08" PARTITION OF "run_error_bucket"
  FOR VALUES FROM ('2027-08-01') TO ('2027-09-01');
CREATE TABLE "run_error_bucket_2027_09" PARTITION OF "run_error_bucket"
  FOR VALUES FROM ('2027-09-01') TO ('2027-10-01');
CREATE TABLE "run_error_bucket_2027_10" PARTITION OF "run_error_bucket"
  FOR VALUES FROM ('2027-10-01') TO ('2027-11-01');
CREATE TABLE "run_error_bucket_2027_11" PARTITION OF "run_error_bucket"
  FOR VALUES FROM ('2027-11-01') TO ('2027-12-01');
CREATE TABLE "run_error_bucket_2027_12" PARTITION OF "run_error_bucket"
  FOR VALUES FROM ('2027-12-01') TO ('2028-01-01');

-- run_user_bucket (partitioned by run_started_on)
CREATE TABLE "run_user_bucket_2027_01" PARTITION OF "run_user_bucket"
  FOR VALUES FROM ('2027-01-01') TO ('2027-02-01');
CREATE TABLE "run_user_bucket_2027_02" PARTITION OF "run_user_bucket"
  FOR VALUES FROM ('2027-02-01') TO ('2027-03-01');
CREATE TABLE "run_user_bucket_2027_03" PARTITION OF "run_user_bucket"
  FOR VALUES FROM ('2027-03-01') TO ('2027-04-01');
CREATE TABLE "run_user_bucket_2027_04" PARTITION OF "run_user_bucket"
  FOR VALUES FROM ('2027-04-01') TO ('2027-05-01');
CREATE TABLE "run_user_bucket_2027_05" PARTITION OF "run_user_bucket"
  FOR VALUES FROM ('2027-05-01') TO ('2027-06-01');
CREATE TABLE "run_user_bucket_2027_06" PARTITION OF "run_user_bucket"
  FOR VALUES FROM ('2027-06-01') TO ('2027-07-01');
CREATE TABLE "run_user_bucket_2027_07" PARTITION OF "run_user_bucket"
  FOR VALUES FROM ('2027-07-01') TO ('2027-08-01');
CREATE TABLE "run_user_bucket_2027_08" PARTITION OF "run_user_bucket"
  FOR VALUES FROM ('2027-08-01') TO ('2027-09-01');
CREATE TABLE "run_user_bucket_2027_09" PARTITION OF "run_user_bucket"
  FOR VALUES FROM ('2027-09-01') TO ('2027-10-01');
CREATE TABLE "run_user_bucket_2027_10" PARTITION OF "run_user_bucket"
  FOR VALUES FROM ('2027-10-01') TO ('2027-11-01');
CREATE TABLE "run_user_bucket_2027_11" PARTITION OF "run_user_bucket"
  FOR VALUES FROM ('2027-11-01') TO ('2027-12-01');
CREATE TABLE "run_user_bucket_2027_12" PARTITION OF "run_user_bucket"
  FOR VALUES FROM ('2027-12-01') TO ('2028-01-01');

-- telemetry_sample (partitioned by sampled_on)
CREATE TABLE "telemetry_sample_2027_01" PARTITION OF "telemetry_sample"
  FOR VALUES FROM ('2027-01-01') TO ('2027-02-01');
CREATE TABLE "telemetry_sample_2027_02" PARTITION OF "telemetry_sample"
  FOR VALUES FROM ('2027-02-01') TO ('2027-03-01');
CREATE TABLE "telemetry_sample_2027_03" PARTITION OF "telemetry_sample"
  FOR VALUES FROM ('2027-03-01') TO ('2027-04-01');
CREATE TABLE "telemetry_sample_2027_04" PARTITION OF "telemetry_sample"
  FOR VALUES FROM ('2027-04-01') TO ('2027-05-01');
CREATE TABLE "telemetry_sample_2027_05" PARTITION OF "telemetry_sample"
  FOR VALUES FROM ('2027-05-01') TO ('2027-06-01');
CREATE TABLE "telemetry_sample_2027_06" PARTITION OF "telemetry_sample"
  FOR VALUES FROM ('2027-06-01') TO ('2027-07-01');
CREATE TABLE "telemetry_sample_2027_07" PARTITION OF "telemetry_sample"
  FOR VALUES FROM ('2027-07-01') TO ('2027-08-01');
CREATE TABLE "telemetry_sample_2027_08" PARTITION OF "telemetry_sample"
  FOR VALUES FROM ('2027-08-01') TO ('2027-09-01');
CREATE TABLE "telemetry_sample_2027_09" PARTITION OF "telemetry_sample"
  FOR VALUES FROM ('2027-09-01') TO ('2027-10-01');
CREATE TABLE "telemetry_sample_2027_10" PARTITION OF "telemetry_sample"
  FOR VALUES FROM ('2027-10-01') TO ('2027-11-01');
CREATE TABLE "telemetry_sample_2027_11" PARTITION OF "telemetry_sample"
  FOR VALUES FROM ('2027-11-01') TO ('2027-12-01');
CREATE TABLE "telemetry_sample_2027_12" PARTITION OF "telemetry_sample"
  FOR VALUES FROM ('2027-12-01') TO ('2028-01-01');
