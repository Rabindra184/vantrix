-- Ingest metadata the API has validated since M0 and discarded ever since.
-- Nullable with no default and no backfill: the values were never stored
-- anywhere, so there is nothing to backfill FROM. Every existing run reads
-- null forever, which is the honest state — '' would claim the caller sent
-- an empty branch.
--
-- No index on any of them. Nothing filters on these yet, and an index on a
-- column that is null for 100% of existing rows earns nothing.
ALTER TABLE "run" ADD COLUMN "environment" TEXT;
ALTER TABLE "run" ADD COLUMN "branch" TEXT;
ALTER TABLE "run" ADD COLUMN "commit_sha" TEXT;
