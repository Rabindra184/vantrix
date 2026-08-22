-- A Test layer between a project and its runs.
--
-- ═══ THE GROUPING ALREADY EXISTED; IT HAD NO IDENTITY ═══
--
-- `TRENDS_SQL` cohorts runs with `AND r.simulation IS NOT DISTINCT FROM $3`.
-- That is this concept, spelled as a string comparison: runs of the same
-- simulation, in the same project, over time. This migration gives it a row,
-- a name a reader can change, and a stable id to point at.
--
-- ADDITIVE AND REVERSIBLE. No column is dropped and no row is deleted.
-- `run.simulation` stays on every row, which is what makes the backfill below
-- re-derivable: undoing this is `DROP COLUMN test_id` and `DROP TABLE test`,
-- and nothing has been lost.

CREATE TABLE "test" (
  "id"               UUID         NOT NULL,
  "org_id"           UUID         NOT NULL,
  "project_id"       UUID         NOT NULL,
  "slug"             TEXT         NOT NULL,
  "name"             TEXT         NOT NULL,
  "simulation_class" TEXT         NOT NULL,
  "description"      TEXT,
  "created_at"       TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "updated_at"       TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "test_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "test_project_id_fkey" FOREIGN KEY ("project_id")
    REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- ONE TEST PER SIMULATION CLASS. This is what makes the worker's
-- resolve-or-create deterministic: given a parsed class there is exactly one
-- row it can belong to. It is also what the backfill's GROUP BY relies on.
CREATE UNIQUE INDEX "test_project_id_simulation_class_key"
  ON "test"("project_id", "simulation_class");
CREATE UNIQUE INDEX "test_project_id_slug_key" ON "test"("project_id", "slug");
CREATE INDEX "test_project_id_created_at_idx"
  ON "test"("project_id", "created_at" DESC);

-- ═══ BACKFILL ═══
--
-- One test per distinct (project, simulation) that has ever been parsed.
--
-- `created_at` is the FIRST run's, not now(): a test's age should be the age
-- of the thing it describes, so trends and sorting read the same after this
-- migration as before it.
--
-- THE SLUG IS DERIVED THE SAME WAY `NewProject.tsx` DERIVES A PROJECT SLUG —
-- lowercase, non-alphanumeric runs collapse to a single hyphen, trim the ends
-- — and then deduplicated, because that mapping is not injective:
-- `checkout.Basic` and `checkout-Basic` both land on `checkout-basic`, which
-- inside one project is a unique-constraint violation mid-migration.
--
-- The suffix is assigned by `row_number()` over the collision group ordered by
-- first-run time, so it is DETERMINISTIC: running this against a copy of the
-- same data produces the same slugs. A class that slugifies to nothing at all
-- (all punctuation) falls back to `test`, and then takes a suffix like any
-- other collision.
WITH grouped AS (
  SELECT
    org_id,
    project_id,
    simulation,
    MIN(created_at) AS first_seen
  FROM "run"
  WHERE simulation IS NOT NULL
  GROUP BY org_id, project_id, simulation
),
slugged AS (
  SELECT
    org_id,
    project_id,
    simulation,
    first_seen,
    NULLIF(
      trim(BOTH '-' FROM regexp_replace(lower(simulation), '[^a-z0-9]+', '-', 'g')),
      ''
    ) AS base
  FROM grouped
),
numbered AS (
  SELECT
    org_id,
    project_id,
    simulation,
    first_seen,
    COALESCE(base, 'test') AS base,
    row_number() OVER (
      PARTITION BY project_id, COALESCE(base, 'test')
      ORDER BY first_seen, simulation
    ) AS n
  FROM slugged
)
INSERT INTO "test" (id, org_id, project_id, slug, name, simulation_class, created_at, updated_at)
SELECT
  gen_random_uuid(),
  org_id,
  project_id,
  CASE WHEN n = 1 THEN base ELSE base || '-' || n END,
  simulation,
  simulation,
  first_seen,
  now()
FROM numbered;

ALTER TABLE "run" ADD COLUMN "test_id" UUID;

-- SET NULL, never CASCADE: deleting a test must not delete the runs it
-- grouped. Same instinct as `run_assertion` keeping a rule snapshot rather
-- than a live foreign key — history survives the thing that organised it.
ALTER TABLE "run" ADD CONSTRAINT "run_test_id_fkey" FOREIGN KEY ("test_id")
  REFERENCES "test"("id") ON DELETE SET NULL ON UPDATE CASCADE;

UPDATE "run" r
   SET test_id = t.id
  FROM "test" t
 WHERE t.project_id = r.project_id
   AND t.simulation_class = r.simulation;

CREATE INDEX "run_test_id_created_at_idx" ON "run"("test_id", "created_at" DESC);

-- Runs left with test_id IS NULL are not a failure to repair. They are runs
-- that are still pending, runs whose bundle never parsed, and rows that
-- predate the worker ever recording a simulation. "We have not been told
-- yet" is a real state and it has to be representable.
