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
-- pg_trgm IS A DEPLOYMENT DEPENDENCY, AND THAT IS THE ONE THING TO KNOW
-- BEFORE RUNNING THIS. `CREATE EXTENSION` needs rights an unprivileged
-- application role usually does not have, so on a managed instance this
-- statement may have to be run once by an administrator (every major managed
-- Postgres offers pg_trgm; it is on the standard allow-list for RDS, Cloud
-- SQL and Azure). `IF NOT EXISTS` makes it a no-op where a platform has
-- installed it already, so the common case needs nothing.
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
