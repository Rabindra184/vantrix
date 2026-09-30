-- A runner run's lifecycle events: the Logs tab (backlog #6,
-- docs/superpowers/specs/2026-09-29-run-logs-design.md).
--
-- One row per event of one on-prem runner job. Three writers: the API when it
-- queues or retries a job and when it cancels one, and the runner at each step
-- of running it. The table reaches org through runner_job's cascade, so
-- infra/test/fk-free-tables.sql covers it without naming it.

-- CreateTable
CREATE TABLE "runner_job_event" (
    "seq" BIGSERIAL NOT NULL,
    "job_id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" TEXT NOT NULL,
    "message" TEXT,
    "phase" TEXT,

    CONSTRAINT "runner_job_event_pkey" PRIMARY KEY ("seq")
);

-- CreateIndex
CREATE INDEX "runner_job_event_job_id_seq_idx" ON "runner_job_event"("job_id", "seq");

-- AddForeignKey
ALTER TABLE "runner_job_event" ADD CONSTRAINT "runner_job_event_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "runner_job"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- ═══ WHAT PRISMA CANNOT MODEL ═══
-- Prisma has no CHECK constraints, and prisma migrate diff ignores them, so
-- these live here alone. An event is a MESSAGE or a PHASE separator, never
-- both and never neither; its source is one of the two writers; a phase is
-- one of the three Gatling Enterprise names.
ALTER TABLE "runner_job_event" ADD CONSTRAINT "runner_job_event_source_check"
  CHECK ("source" IN ('perfportal', 'runner'));
ALTER TABLE "runner_job_event" ADD CONSTRAINT "runner_job_event_phase_check"
  CHECK ("phase" IN ('Deploying', 'Injecting', 'Ending'));
ALTER TABLE "runner_job_event" ADD CONSTRAINT "runner_job_event_message_xor_phase_check"
  CHECK (("message" IS NULL) <> ("phase" IS NULL));
