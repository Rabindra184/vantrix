-- Project access, PR 2 (docs/superpowers/specs/2026-10-07-project-access-design.md,
-- section 1, "Account flags"): an account whose password its owner did not
-- choose must choose a new one before it can do anything else.
--
-- A Better Auth additional field (createAuth declares it input: false, so no
-- public endpoint sets or clears it), so it keeps the camelCase, unmapped name
-- of every other column of this table.
--
-- NOT NULL DEFAULT false: every existing account keeps working exactly as it
-- did, and nobody is sent to a password step by the upgrade itself.

-- AlterTable
ALTER TABLE "user" ADD COLUMN "mustChangePassword" BOOLEAN NOT NULL DEFAULT false;
