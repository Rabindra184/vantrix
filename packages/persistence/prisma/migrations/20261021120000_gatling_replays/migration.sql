-- Exact statistics PR 4: how many seeded replays of Gatling's own percentile
-- method found the run's gatling_differences.
-- NULL when the method did not run: then gatling_differences is empty because
-- nothing was compared, not because nothing differed. The seed count when it
-- did, and never 0 or fewer, which is not a number of replays.
-- No backticks in comments: Prisma runs this file as-is.

ALTER TABLE run_verification ADD COLUMN gatling_replays integer NULL;
ALTER TABLE run_verification ADD CONSTRAINT run_verification_gatling_replays_check
  CHECK (gatling_replays IS NULL OR gatling_replays > 0);
