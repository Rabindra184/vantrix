-- The folded remainder becomes a COLUMN instead of a reserved message value.
--
-- ═══ THE BUG ═══
--
-- ErrorRollup.top() appended `{ message: 'other' }` unconditionally after
-- taking the top 200. A run with more than 200 distinct messages, one of them
-- really called "other" and frequent enough to be kept, therefore produced two
-- rows with the same (run_id, scope, name, message). Against the unique index
-- below that aborted the INSERT, which aborted the transaction, which failed
-- the whole ingest — the run was LOST, not merely mislabelled.
--
-- No sentinel string can fix that: any string a load test can emit is a string
-- a load test can emit. The remainder is a different KIND of row, so it now
-- carries a different value in a different column. This matches
-- run_error_bucket, which was built this way from the start; the two error
-- surfaces now agree instead of using two conventions.
--
-- ═══ EXISTING ROWS ═══
--
-- Every pre-existing row gets is_other = false, INCLUDING any that was written
-- as the old sentinel. That is not a lossy choice made for convenience — it is
-- the only honest one available: a stored row messaged 'other' is genuinely
-- indistinguishable from a real error of that name, which is the whole defect.
-- Those historical rows keep rendering as a literal message called "other".
ALTER TABLE "run_error" ADD COLUMN "is_other" BOOLEAN NOT NULL DEFAULT false;

-- The unique key gains the discriminator, so ('other', false) and ('', true)
-- are distinct rows and the collision is unrepresentable rather than merely
-- unlikely.
--
-- NOTE THE INDEX NAME. 20260808120000 created this as
-- "run_error_run_scope_name_message_key" and 20260809153812 then RENAMED it to
-- the Prisma-generated form below; dropping the original name fails with
-- "index does not exist". The new name follows the same convention, so a
-- future `prisma migrate diff` sees no drift.
DROP INDEX "run_error_run_id_scope_name_message_key";
CREATE UNIQUE INDEX "run_error_run_id_scope_name_message_is_other_key"
  ON "run_error" ("run_id", "scope", "name", "message", "is_other");

-- Default dropped once the backfill is done, matching how 20260808120000
-- introduced scope/name: the writer always supplies this, and a default left in
-- place would let a future insert omit it and silently mean "not the remainder".
ALTER TABLE "run_error" ALTER COLUMN "is_other" DROP DEFAULT;
