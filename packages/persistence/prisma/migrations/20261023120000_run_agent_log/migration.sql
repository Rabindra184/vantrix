-- GE report parity PR 1: the run's agent file, and a runner job's opt-out.
--
-- The Gatling agent writes a raw NDJSON file beside simulation.log during an
-- on-prem runner run (DNS, connect, TLS, bytes, status codes, warm-up). The
-- runner stores it at runs/<runId>/agent.ndjson and records here where it is,
-- its SHA-256 and its size: the same three facts the run already records for
-- its bundle. All three are NULL together for a run with no agent file, which
-- is every run before this migration, every upload and every plugin run, and
-- every runner job that opted out. bigint, not integer: a long soak's file can
-- pass 2 GiB.
--
-- agent_enabled defaults to true, so every job queued before this migration
-- reads as one that would have loaded the agent, and a caller that never sends
-- the field gets the agent. NOT NULL: there is no third answer.
-- No backticks in comments: Prisma runs this file as-is.

ALTER TABLE run ADD COLUMN agent_log_key text NULL;
ALTER TABLE run ADD COLUMN agent_log_sha256 text NULL;
ALTER TABLE run ADD COLUMN agent_log_bytes bigint NULL;

ALTER TABLE runner_job ADD COLUMN agent_enabled boolean NOT NULL DEFAULT true;
