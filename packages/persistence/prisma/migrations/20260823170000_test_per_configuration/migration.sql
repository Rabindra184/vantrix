-- A test is a CONFIGURATION, not a simulation class.
--
-- ═══ WHAT THIS UNDOES, AND WHY IT WAS TAKEN IN THE FIRST PLACE ═══
--
-- `20260822220000_test_entity` created `test_project_id_simulation_class_key`
-- and its own comment said why it would go: "Gatling Enterprise does NOT have
-- this constraint — its Test is a named configuration, so two tests may share
-- a simulation class with different load profiles. Getting there needs clients
-- to name the test at submit time (an optional `metadata.test`), and dropping
-- a unique index is not a data change, which is exactly why taking it now
-- costs nothing later."
--
-- That is this migration. `metadata.test` exists now, so the constraint comes
-- off — and a project can hold "checkout smoke" and "checkout soak" as two
-- tests of one simulation with different injection profiles.
--
-- NO ROW CHANGES, and no data can be lost: dropping a unique index can only
-- widen what is permitted. Every existing project has exactly one test per
-- class and keeps behaving identically until somebody declares otherwise.

-- ═══ THE INDEX STAYS, ONLY ITS UNIQUENESS GOES ═══
--
-- `resolveTestId` still asks "which test has this simulation class in this
-- project" for every run that declares no test — the ordinary path, and the
-- only path for every client that has not been updated. Dropping the index
-- outright would turn that into a sequential scan of the project's tests on
-- every parse.
DROP INDEX "test_project_id_simulation_class_key";
CREATE INDEX "test_project_id_simulation_class_idx"
  ON "test"("project_id", "simulation_class");

-- ═══ `test_project_id_slug_key` IS NOW THE ONLY UNIQUE KEY, AND IT CARRIES
--     THE RACE SAFETY THE OTHER ONE USED TO ═══
--
-- The worker's resolve-or-create was `ON CONFLICT (project_id,
-- simulation_class)`, which requires a unique index on exactly those columns —
-- so that clause could not survive this migration. It becomes
-- `ON CONFLICT (project_id, slug)`, and the guarantee is unchanged rather than
-- weakened: two concurrent first-runs of one class derive the SAME base slug
-- from it (`slugifySimulation`), so they collide on this index and the loser
-- is handed the winner's row by `DO UPDATE … RETURNING id`, exactly as before.
-- See `test-resolver.ts`.

-- Ingest metadata, frozen at accept time beside `environment`, `branch` and
-- `commit_sha` — the same treatment, because it is the same kind of thing: a
-- fact the CALLER asserts about a run, not one the platform measured.
--
-- NULLABLE, and null is the ordinary case. It means "no test named", which is
-- every run from every client that has not been updated, and which resolves by
-- simulation class exactly as it always has.
--
-- KEPT ON THE RUN rather than resolved to a `test_id` at accept time, because
-- a declared test may not exist yet and cannot be created without a simulation
-- class — and the class is not known until the log header is parsed. The
-- worker (and, for a live run, `LiveFoldOwner`) resolves it the moment it has
-- both.
ALTER TABLE "run" ADD COLUMN "declared_test_slug" TEXT;
