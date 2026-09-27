-- A run's number within its test: "Run 12" (backlog #5,
-- docs/superpowers/specs/2026-09-27-run-number-design.md).
--
-- ARRIVAL order, never renumbered. The counter lives on the test and is bumped
-- in the same statement that sets a run's test_id, so a number is taken
-- exactly once, at the moment a run joins its test. See
-- apps/worker/src/pipeline/run-number.ts for the two writers.
--
-- Existing runs are numbered by the SAME rule applied to history: creation
-- order within each test. The two UPDATEs between the BACKFILL markers are
-- read and executed verbatim by run-number.integration.test.ts, so keep the
-- markers and keep each statement ending in a semicolon.

ALTER TABLE "test" ADD COLUMN "next_run_number" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "run" ADD COLUMN "run_number" INTEGER;

-- BACKFILL: begin
UPDATE run r
   SET run_number = n.num
  FROM (SELECT id,
               row_number() OVER (PARTITION BY test_id ORDER BY created_at, id) AS num
          FROM run
         WHERE test_id IS NOT NULL) n
 WHERE r.id = n.id;

UPDATE test t
   SET next_run_number = COALESCE((SELECT max(r.run_number) FROM run r WHERE r.test_id = t.id), 0) + 1;
-- BACKFILL: end

-- NULLs are distinct in a unique index, so every run without a test coexists.
-- The name is Prisma's own default for @@unique([testId, runNumber]) on "run",
-- which is what keeps infra/test/schema-matches-migrations.sh reading "agree".
CREATE UNIQUE INDEX "run_test_id_run_number_key" ON "run"("test_id", "run_number");
