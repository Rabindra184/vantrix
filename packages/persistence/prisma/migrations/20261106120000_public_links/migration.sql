-- Public links (docs/superpowers/specs/2026-11-06-public-links-and-custom-report-design.md,
-- section 3): the org's switch, and the links themselves.
-- No backticks in comments: Prisma runs this file as-is, and the repo's SQL
-- also lives inside template literals elsewhere.

-- The org-level opt-in, beside ai_enabled. Off by default, so an upgraded
-- install answers no public link until an admin turns it on. Turning it off
-- stops every link at once and changes no link row.
ALTER TABLE "org" ADD COLUMN "public_links_enabled" BOOLEAN NOT NULL DEFAULT false;

-- One row per link. token_hash is the lowercase hex SHA-256 of the secret,
-- never the secret, and the unique index on it is how a request finds its
-- link in one read. org_id and project_id are denormalised from the run, as
-- api_token and the metrics tables do, so the credential lookup answers the
-- tenant in one row; PublicLinkRepository.create writes them from the run
-- itself, so they cannot disagree with it.
--
-- Every link expires (expires_at is NOT NULL). revoked_at is set by a revoke
-- and never cleared. Rows are never deleted by the product: an expired or
-- revoked link stays listed so a reader can see what was shared and when it
-- stopped. They go only with their org, project or run (ON DELETE CASCADE).
-- The two people a row names are SET NULL on delete, as the run note does:
-- the link and its history survive the account, only the name goes.
--
-- timestamptz, never a bare timestamp: the rows are read through the raw
-- pool, and node-postgres would read a bare one in the local zone.
CREATE TABLE "run_public_link" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "org_id" UUID NOT NULL,
  "project_id" UUID NOT NULL,
  "run_id" UUID NOT NULL,
  "token_hash" TEXT NOT NULL,
  "created_by" TEXT,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMPTZ(3) NOT NULL,
  "revoked_at" TIMESTAMPTZ(3),
  "revoked_by" TEXT,
  "last_used_at" TIMESTAMPTZ(3),

  CONSTRAINT "run_public_link_pkey" PRIMARY KEY ("id"),
  -- What Prisma cannot model: the stored value is a SHA-256 in lowercase hex
  -- and nothing else. This is what holds every writer to it, and what refuses
  -- the one mistake that would matter most, storing the plaintext secret.
  CONSTRAINT "run_public_link_token_hash_check" CHECK ("token_hash" ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX "run_public_link_token_hash_key" ON "run_public_link"("token_hash");

-- Serves a run's list, newest first.
CREATE INDEX "run_public_link_run_id_created_at_idx" ON "run_public_link"("run_id", "created_at" DESC);

ALTER TABLE "run_public_link" ADD CONSTRAINT "run_public_link_org_id_fkey"
  FOREIGN KEY ("org_id") REFERENCES "org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "run_public_link" ADD CONSTRAINT "run_public_link_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "run_public_link" ADD CONSTRAINT "run_public_link_run_id_fkey"
  FOREIGN KEY ("run_id") REFERENCES "run"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "run_public_link" ADD CONSTRAINT "run_public_link_created_by_fkey"
  FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "run_public_link" ADD CONSTRAINT "run_public_link_revoked_by_fkey"
  FOREIGN KEY ("revoked_by") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
