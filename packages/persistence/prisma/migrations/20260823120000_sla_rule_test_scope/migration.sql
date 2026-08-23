-- An SLA rule may now apply to ONE TEST rather than to the whole project.
--
-- ═══ WHY NULL IS THE BACKFILL ═══
--
-- Every rule that exists today judges every run in its project, and this
-- column is NULL for all of them — which is exactly that meaning, written
-- down. So there is no backfill statement below, and that is not an omission:
-- a migration that copied each project rule onto each test would turn one rule
-- into N, leave a project that later grows a test inheriting nothing, and make
-- retuning a gate an N-row edit. Keeping both meanings in one column is what
-- lets an org-wide error-rate floor and a per-test latency gate coexist, which
-- is how people actually configure this.
--
-- ADDITIVE AND REVERSIBLE. Undoing it is `DROP COLUMN test_id`; every rule
-- reverts to project-wide, which is what it already was.
--
-- ═══ `test_id` IS NOT A THIRD MEANING OF "SCOPE" ═══
--
-- `sla_rule.scope` already means run/scenario/group/request — WHAT the rule
-- measures — and `ProjectScope` in the repositories means the tenant. This
-- column is neither: it is what the rule APPLIES TO. Nothing here is called a
-- scope, deliberately, because a reader who conflates the two authors a rule
-- that measures the wrong thing.

ALTER TABLE "sla_rule" ADD COLUMN "test_id" UUID;

-- ═══ CASCADE, WHERE `run.test_id` IS SET NULL ═══
--
-- The opposite choice from `run`, and the difference is history versus
-- configuration. A run is a record of something that happened, so deleting its
-- test must not delete it — `run.test_id` goes NULL and the run survives,
-- ungrouped. A rule is configuration for something that will happen; a rule
-- pointing at a test that no longer exists judges nothing, forever, while
-- still appearing in an authoring list as configured protection.
--
-- Verdicts already recorded are unaffected either way: `run_assertion` carries
-- no foreign key to `sla_rule` at all and keeps its own `rule_snapshot`,
-- precisely so a retired rule cannot rewrite the past.
ALTER TABLE "sla_rule" ADD CONSTRAINT "sla_rule_test_id_fkey"
  FOREIGN KEY ("test_id") REFERENCES "test"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ═══ NO INDEX ON `test_id`, AND THAT IS A DECISION ═══
--
-- The hot path is `listEnabled`, which reads
-- `project_id = $1 AND enabled AND (test_id IS NULL OR test_id = $2)`. The
-- existing `sla_rule_project_id_enabled_idx` answers the first two, and what
-- it returns is one project's enabled rules — single digits in every
-- deployment this has been measured on. Filtering `test_id` over that in
-- memory costs nothing; a second index would cost a write on every rule
-- change to save nothing on a set that small.
--
-- The FK constraint above does NOT create one (Postgres indexes the
-- REFERENCED side, never the referencing side), so a DELETE of a test scans
-- `sla_rule` to find its rules. That is a rare, human-initiated operation
-- against a small table. If either assumption stops holding — thousands of
-- rules per project, or automated test deletion — this is the index to add.
