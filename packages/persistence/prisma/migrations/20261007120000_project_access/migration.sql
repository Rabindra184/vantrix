-- Project access, PR 1 (docs/superpowers/specs/2026-10-07-project-access-design.md,
-- section 1): an install-wide admin flag on the account, and a person's role
-- in each project they may see.
--
-- The four "user" columns and session."impersonatedBy" are Better Auth's admin
-- plugin's own, so they keep its camelCase, unmapped names like the rest of
-- those two tables. "role" is the ONE admin flag: 'admin' or 'user'.

-- AlterTable
ALTER TABLE "session" ADD COLUMN     "impersonatedBy" TEXT;

-- AlterTable
ALTER TABLE "user" ADD COLUMN     "banExpires" TIMESTAMP(3),
ADD COLUMN     "banReason" TEXT,
ADD COLUMN     "banned" BOOLEAN DEFAULT false,
ADD COLUMN     "role" TEXT DEFAULT 'user';

-- ═══ NOBODY LOSES ACCESS ON UPGRADE ═══
-- Until now every session could read its whole org, and every org_member row
-- was written 'admin' (bootstrap and the e2e fixtures both wrote it). So every
-- account with a membership becomes an admin, and keeps exactly what it had;
-- project_member starts empty and an admin assigns people afterwards. An
-- account with no membership could see nothing and stays 'user'.
--
-- Placed after the "role" column exists, which it writes, and before
-- org_member's own role is dropped, which it deliberately does not read:
-- every member is promoted whatever that column said, because the column was
-- never read and could not have narrowed anyone's access.
--
-- The one statement between the ADMINS markers is read and executed verbatim
-- by packages/persistence/test/access-backfill.integration.test.ts: keep it
-- one, and keep every semicolon a statement terminator.
-- ADMINS: begin
UPDATE "user" SET "role" = 'admin' WHERE "id" IN (SELECT "user_id" FROM "org_member");
-- ADMINS: end

-- AlterTable
-- Written and never read; the admin flag lives on "user" now, in one place.
ALTER TABLE "org_member" DROP COLUMN "role";

-- CreateTable
CREATE TABLE "project_member" (
    "project_id" UUID NOT NULL,
    "user_id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "added_by" TEXT,

    CONSTRAINT "project_member_pkey" PRIMARY KEY ("project_id","user_id")
);

-- CreateIndex
CREATE INDEX "project_member_user_id_idx" ON "project_member"("user_id");

-- AddForeignKey
ALTER TABLE "project_member" ADD CONSTRAINT "project_member_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_member" ADD CONSTRAINT "project_member_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_member" ADD CONSTRAINT "project_member_added_by_fkey" FOREIGN KEY ("added_by") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ═══ WHAT PRISMA CANNOT MODEL ═══
-- A project role is one of the three in PROJECT_ROLES (@perfportal/contracts).
-- The repository's type already says so; this is what holds every OTHER
-- writer to it, raw SQL and a later admin screen included.
ALTER TABLE "project_member" ADD CONSTRAINT "project_member_role_check"
  CHECK ("role" IN ('manager', 'member', 'viewer'));
