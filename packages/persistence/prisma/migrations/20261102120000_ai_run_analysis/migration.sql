-- AI run analysis (docs/superpowers/specs/2026-11-02-ai-run-analysis-design.md):
-- the org's switch, and one analysis per run.
-- No backticks in comments: Prisma runs this file as-is, and the repo's SQL
-- also lives inside template literals elsewhere.

-- The org-level opt-in. Off by default, so an upgraded install sends nothing
-- anywhere until an admin turns it on, whatever the operator configured.
ALTER TABLE "org" ADD COLUMN "ai_enabled" BOOLEAN NOT NULL DEFAULT false;

-- One row per run. content is the validated analysis, NULL until it is
-- ready; failure_reason is the one sentence a failed attempt left.
-- facts_version records which facts the analysis was checked against; a bump
-- does NOT make it stale (staleness is the run's statistics being rewritten
-- after generated_at), it is a record.
--
-- ON DELETE CASCADE from the run: an analysis is about one run's figures and
-- means nothing without them. ON DELETE SET NULL from the person: deleting an
-- account keeps the analysis and drops only who asked for it, as the run
-- note does. timestamptz, never a bare timestamp: the rows are read through
-- the raw pool, and node-postgres would read a bare one in the local zone.
CREATE TABLE "run_ai_analysis" (
  "run_id" UUID NOT NULL,
  "status" TEXT NOT NULL,
  "content" JSONB,
  "provider" TEXT,
  "model" TEXT,
  "facts_version" INTEGER,
  "failure_reason" TEXT,
  "requested_by" TEXT,
  "requested_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "generated_at" TIMESTAMPTZ(3),

  CONSTRAINT "run_ai_analysis_pkey" PRIMARY KEY ("run_id"),
  CONSTRAINT "run_ai_analysis_status_check" CHECK ("status" IN ('pending', 'ready', 'failed'))
);

ALTER TABLE "run_ai_analysis" ADD CONSTRAINT "run_ai_analysis_run_id_fkey"
  FOREIGN KEY ("run_id") REFERENCES "run"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "run_ai_analysis" ADD CONSTRAINT "run_ai_analysis_requested_by_fkey"
  FOREIGN KEY ("requested_by") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
