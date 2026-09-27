-- A note a PERSON writes on a run after the fact
-- (docs/superpowers/specs/2026-09-27-run-note-design.md). NOT the
-- "description" column: that is Gatling's own run description from the
-- simulation.log header, bound by PRD G-02 as an exact string.
--
-- All three nullable, so every existing run reads NULL for all three, and
-- RunRepository.setNote is the only writer. timestamptz, NOT a bare
-- timestamp, for the reason 20260817000000 records: Prisma and node-postgres
-- disagree about a bare timestamp, and the run list reads this row through
-- the raw pool.
--
-- ON DELETE SET NULL: deleting a person keeps what they wrote and drops only
-- the attribution. A note is a record about a run and outlives its author.
ALTER TABLE "run"
  ADD COLUMN "note" TEXT,
  ADD COLUMN "note_updated_at" TIMESTAMPTZ(3),
  ADD COLUMN "note_updated_by" TEXT;

ALTER TABLE "run" ADD CONSTRAINT "run_note_updated_by_fkey"
  FOREIGN KEY ("note_updated_by") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The run list's search matches the note too, and every column in that OR
-- needs its own index or the whole predicate falls back to a sequential scan
-- (RunRepository.list records why). pg_trgm is already installed by
-- 20260821200000_run_search_trigram.
CREATE INDEX "run_note_trgm" ON "run" USING GIN ("note" gin_trgm_ops);
