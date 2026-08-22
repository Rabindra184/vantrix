-- SLA rules become authorable, so they need the two things a managed list
-- cannot do without: something to call a rule, and something to order it by.
--
-- ADDITIVE ONLY. Every column is either nullable or defaulted, so this applies
-- to a table that already holds rules without touching one of them, and
-- `RuleRepository.listEnabled` -- the hot path every run evaluates through --
-- keeps reading exactly the columns it read before.

-- Nullable on purpose. Every rule that predates authoring was inserted by a
-- fixture with nothing to call it; the UI falls back to the rule's own
-- expression for those, which is what the run page has always shown.
ALTER TABLE "sla_rule" ADD COLUMN "name" TEXT;

-- TIMESTAMPTZ, not TIMESTAMP. Prisma decodes a bare `timestamp` as UTC while
-- node-postgres decodes it in the node process's local zone, so a column
-- holding UTC by convention reads back differently depending on which client
-- asked. `run` shipped that bug and it was invisible in UTC -- only an
-- Asia/Kolkata machine showed the 5h30m gap. Nothing reads these through the
-- raw pool today; that was true of `run` too.
--
-- DEFAULT now() backfills existing rows to the moment of migration. That is a
-- lie about when those rules were authored, and the honest alternative -- NULL
-- for "unknown" -- costs every consumer a nullable instant forever, for rows
-- that only ever came from fixtures. Recorded rather than hidden.
ALTER TABLE "sla_rule" ADD COLUMN "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "sla_rule" ADD COLUMN "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
