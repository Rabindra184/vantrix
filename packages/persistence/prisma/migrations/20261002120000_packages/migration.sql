-- Packages as first-class sources (backlog #8,
-- docs/superpowers/specs/2026-10-02-packages-design.md).
--
-- A package groups runner_artifact rows, each of which becomes one VERSION.
-- Jobs keep pointing at the exact version they ran. The two per-job fields the
-- artifact carried (the run name and the simulation class) move to the job.

-- CreateTable
CREATE TABLE "package" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "current_artifact_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "package_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "package_project_updated_at_idx" ON "package"("project_id", "updated_at" DESC);

-- AlterTable
ALTER TABLE "runner_artifact" ADD COLUMN "package_id" UUID,
ADD COLUMN "simulations" JSONB,
ALTER COLUMN "name" DROP NOT NULL,
ALTER COLUMN "simulation_class" DROP NOT NULL;

-- AlterTable
ALTER TABLE "runner_job" ADD COLUMN "name" TEXT,
ADD COLUMN "simulation_class" TEXT;

-- AlterTable
ALTER TABLE "run" ADD COLUMN "package_id" UUID;

-- CreateIndex
CREATE INDEX "runner_artifact_package_id_idx" ON "runner_artifact"("package_id");

-- CreateIndex
CREATE INDEX "run_package_id_idx" ON "run"("package_id");

-- AddForeignKey
ALTER TABLE "package" ADD CONSTRAINT "package_project_tenant_fk" FOREIGN KEY ("project_id", "org_id") REFERENCES "project"("id", "org_id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "package" ADD CONSTRAINT "package_current_artifact_fk" FOREIGN KEY ("current_artifact_id") REFERENCES "runner_artifact"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "runner_artifact" ADD CONSTRAINT "runner_artifact_package_fk" FOREIGN KEY ("package_id") REFERENCES "package"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "run" ADD CONSTRAINT "run_package_id_fkey" FOREIGN KEY ("package_id") REFERENCES "package"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- The seven statements between the BACKFILL markers are read and executed
-- verbatim by packages/persistence/test/package-backfill.integration.test.ts:
-- keep them seven, and keep every semicolon a statement terminator.
--
-- ═══ THE BACKFILL MUST NEVER ABORT A DEPLOY ═══
-- One package per project per filename stem IGNORING CASE and kind, because a
-- package name is unique per project ignoring case and the backfill must not
-- be able to propose two that are not. The stem is the filename without its
-- extension (a .tar.gz counts as one), at most 112 characters; the package is
-- named after the stem of the group's EARLIEST upload.
--
-- The one case a name can still collide is the same stem in the two kinds (a
-- jar and a bundle both called load): the later group takes a " (2)" suffix,
-- in upload order. A suffix with a space and parentheses, never "-2", because
-- every stored filename passed through the API's sanitizeFilename, which
-- replaces anything outside letters, digits, underscore, dot, hyphen and space
-- with an underscore: no stem can contain a parenthesis, so a " (n)" name
-- cannot equal any stem or another generated name. A "-n" suffix could, and
-- did: load.jar, Load.jar and load-2.jar made the unique index refuse "load-2".
-- 112 characters plus " (NN)" still fits the 120-character name.
-- BACKFILL: begin
UPDATE runner_job j
SET name = a.name, simulation_class = a.simulation_class
FROM runner_artifact a
WHERE a.id = j.artifact_id AND j.name IS NULL;

CREATE TEMP TABLE package_backfill AS
SELECT gen_random_uuid() AS id, s.org_id, s.project_id, s.kind, lower(s.stem) AS stem_key,
       (array_agg(s.stem ORDER BY s.created_at, s.stem))[1] AS stem,
       min(s.created_at) AS first_at, max(s.created_at) AS last_at
FROM (
  SELECT org_id, project_id, kind, created_at,
         COALESCE(NULLIF(left(regexp_replace(filename, '(\.tar\.gz|\.[^.]+)$', '', 'i'), 112), ''), 'package') AS stem
  FROM runner_artifact
  WHERE package_id IS NULL
) s
GROUP BY s.org_id, s.project_id, s.kind, lower(s.stem);

INSERT INTO package (id, org_id, project_id, name, kind, created_at, updated_at)
SELECT x.id, x.org_id, x.project_id,
       CASE WHEN x.n = 1 THEN x.stem ELSE x.stem || ' (' || x.n || ')' END,
       x.kind, x.first_at, x.last_at
FROM (
  SELECT b.*, row_number() OVER (PARTITION BY b.project_id, b.stem_key ORDER BY b.first_at, b.kind) AS n
  FROM package_backfill b
) x;

UPDATE runner_artifact a
SET package_id = b.id
FROM package_backfill b
WHERE a.package_id IS NULL
  AND b.project_id = a.project_id
  AND b.kind = a.kind
  AND b.stem_key = lower(COALESCE(NULLIF(left(regexp_replace(a.filename, '(\.tar\.gz|\.[^.]+)$', '', 'i'), 112), ''), 'package'));

UPDATE package p
SET current_artifact_id = (
  SELECT a.id FROM runner_artifact a
  WHERE a.package_id = p.id
  ORDER BY a.created_at DESC, a.id DESC
  LIMIT 1
)
WHERE p.current_artifact_id IS NULL;

UPDATE run r
SET package_id = a.package_id
FROM runner_job j
JOIN runner_artifact a ON a.id = j.artifact_id
WHERE j.run_id = r.id AND r.package_id IS NULL AND a.package_id IS NOT NULL;

DROP TABLE IF EXISTS package_backfill;
-- BACKFILL: end

-- Every job has its name and class now.
ALTER TABLE "runner_job" ALTER COLUMN "name" SET NOT NULL;
ALTER TABLE "runner_job" ALTER COLUMN "simulation_class" SET NOT NULL;

-- ═══ WHAT PRISMA CANNOT MODEL ═══
-- A package name is unique per project IGNORING CASE: an expression index,
-- which Prisma 6 can neither declare nor introspect (schema.prisma says so on
-- the model). The kind is one of the two artifact kinds.
CREATE UNIQUE INDEX "package_project_name_lower_key" ON "package" ("project_id", lower("name"));
ALTER TABLE "package" ADD CONSTRAINT "package_kind_check"
  CHECK ("kind" IN ('gatling_jar', 'gatling_bundle'));
