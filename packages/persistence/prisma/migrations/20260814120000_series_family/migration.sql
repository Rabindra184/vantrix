-- Appendix A GR-04 and GR-06 need percentiles over time for a GROUP, and a
-- group carries two measures under one name — cumulated response time and
-- wall-clock duration, which diverge whenever its requests overlap. The old
-- primary key (run_started_on, run_id, scope, name, start_offset_ms) has no
-- room for that distinction, so the two collided and one replaced the other.
--
-- NOT NULL with a backfill rather than nullable: every row that exists is a
-- response_time series, and a nullable family would make every later read
-- carry a "which is it" branch for a state that cannot occur.
ALTER TABLE "run_series_bucket" ADD COLUMN "family" TEXT;
UPDATE "run_series_bucket" SET "family" = 'response_time' WHERE "family" IS NULL;
ALTER TABLE "run_series_bucket" ALTER COLUMN "family" SET NOT NULL;

-- FAMILY SITS AFTER name AND BEFORE start_offset_ms, and the position is
-- load-bearing. 0001_init records that there is deliberately no secondary index
-- on (run_started_on, run_id, scope, name) because those columns are a strict
-- prefix of this key and the PK's own btree already serves them. Putting family
-- any earlier breaks that prefix and silently costs every existing series
-- lookup its index, once per partition, with nothing failing to announce it.
--
-- DROP then ADD on the partitioned parent cascades to all twelve partitions.
-- The partition key (run_started_on) stays in the key, which Postgres requires.
ALTER TABLE "run_series_bucket" DROP CONSTRAINT "run_series_bucket_pkey";
ALTER TABLE "run_series_bucket" ADD CONSTRAINT "run_series_bucket_pkey"
  PRIMARY KEY ("run_started_on", "run_id", "scope", "name", "family", "start_offset_ms");
