-- The run list's `?q=` search, made indexable.
--
-- `RunRepository.list` matches seven text columns with a LEADING-WILDCARD
-- ILIKE, which no b-tree can serve. That is not merely slow in isolation:
-- PostgreSQL can only combine an OR into a BitmapOr while it can index EVERY
-- branch, so one unindexable column forced a sequential scan of the whole
-- predicate. These seven indexes and the primary-key range that replaced the
-- old `r.id::text ILIKE` (see `runIdPrefixRange`) are what make the search
-- proportional to what it matches rather than to the org's whole history.
--
-- pg_trgm IS A DEPLOYMENT DEPENDENCY, BUT A MUCH SMALLER ONE THAN THIS
-- COMMENT FIRST CLAIMED. It used to say `CREATE EXTENSION` "needs rights an
-- unprivileged application role usually does not have". That is wrong, and
-- the correction is measured rather than reasoned:
--
--   pg_trgm is a TRUSTED extension (PostgreSQL 13+). On postgres:16-alpine,
--   `pg_available_extension_versions` reports trusted = t for 1.3 through
--   1.6. A trusted extension can be installed by a NON-SUPERUSER; the only
--   privilege it needs is CREATE on the current database.
--
-- Both sides were tested against that image. A nosuperuser role owning the
-- database ran this statement successfully. A nosuperuser role WITHOUT
-- CREATE on the database got:
--
--   ERROR:  permission denied to create extension "pg_trgm"
--   HINT:   Must have CREATE privilege on current database to create this
--           extension.
--
-- So the failing shape is narrow: a migration role that can create tables in
-- a schema but holds no CREATE on the database itself. Any role that has run
-- the 20 migrations before this one already has broad DDL rights, so in
-- practice this succeeds — and `IF NOT EXISTS` makes it a no-op wherever the
-- platform ships pg_trgm pre-installed (RDS, Cloud SQL and Azure all offer
-- it).
--
-- To settle it for a given database before deploying, without changing
-- anything, run `infra/pg_trgm-preflight.sql` AS THE ROLE THAT RUNS
-- MIGRATIONS. It prints a PASS/FAIL verdict and, on failure, the exact GRANT.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- CreateIndex
CREATE INDEX "project_slug_trgm" ON "project" USING GIN ("slug" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "project_name_trgm" ON "project" USING GIN ("name" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "run_simulation_trgm" ON "run" USING GIN ("simulation" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "run_description_trgm" ON "run" USING GIN ("description" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "run_environment_trgm" ON "run" USING GIN ("environment" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "run_branch_trgm" ON "run" USING GIN ("branch" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "run_commit_sha_trgm" ON "run" USING GIN ("commit_sha" gin_trgm_ops);
