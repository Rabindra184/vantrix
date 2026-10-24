-- GE report parity PR 2: the run's agent figures.
--
-- The agent file (PR 1, run.agent_log_key) is decoded at finalize into the
-- figures Gatling Enterprise draws from its own agent: DNS, TCP connect and
-- TLS handshake durations, connections opened and closed, bandwidth, TCP
-- states, status codes, GC, heap, CPU, RAM and the kernel TCP counters.
--
-- run_agent is ONE row per run that had an agent file: whether it could be
-- read (status), why not (reason), what the agent said about itself (header),
-- and what the figures were built on (bucket_width_ms, the run's own series
-- width). It cascades from run like run_verification does, so it is NOT one
-- of the FK-free tables.
--
-- The two bucket tables are partitioned by run_started_on and carry org_id
-- and project_id with NO foreign key, exactly like run_series_bucket and
-- run_user_bucket: deleting a run or an org does not reach them, which is why
-- infra/clean-test-residue.sql names both. Partitions run 2026-01 through
-- 2027-12, the horizon migration 20260925120000_partitions_2027 set, so
-- partition-runway.integration.test.ts guards these parents with the others.
--
-- dim is a remote (host/ip:port), a hostname, or the all-dimensions total,
-- stored as its own rows so a reader never sums on read. label is '' for a
-- metric with one value per bucket.
-- No backticks in comments: Prisma runs this file as-is.

CREATE TABLE run_agent (
  run_id uuid PRIMARY KEY REFERENCES run(id) ON DELETE CASCADE,
  org_id uuid NOT NULL,
  project_id uuid NOT NULL,
  status text NOT NULL,
  reason text NULL,
  header jsonb NULL,
  capped boolean NOT NULL DEFAULT false,
  agent_error jsonb NULL,
  malformed_lines integer NOT NULL DEFAULT 0,
  bucket_width_ms integer NULL,
  remotes text[] NOT NULL DEFAULT '{}',
  hostnames text[] NOT NULL DEFAULT '{}',
  processed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT run_agent_status_check CHECK (status IN ('collected', 'unreadable'))
);

CREATE TABLE "run_agent_duration_bucket" (
    "run_started_on" DATE NOT NULL,
    "run_id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "family" TEXT NOT NULL,
    "dim" TEXT NOT NULL,
    "start_offset_ms" INTEGER NOT NULL,
    "ok_count" INTEGER NOT NULL,
    "ko_count" INTEGER NOT NULL,
    "histogram_ok" BYTEA NOT NULL,
    "histogram_ko" BYTEA NOT NULL,
    -- A unique/primary key on a partitioned table must contain the partition key.
    CONSTRAINT "run_agent_duration_bucket_pkey"
      PRIMARY KEY ("run_started_on", "run_id", "family", "dim", "start_offset_ms")
) PARTITION BY RANGE ("run_started_on");

CREATE TABLE "run_agent_metric_bucket" (
    "run_started_on" DATE NOT NULL,
    "run_id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "metric" TEXT NOT NULL,
    "dim" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "start_offset_ms" INTEGER NOT NULL,
    "value" DOUBLE PRECISION NOT NULL,
    CONSTRAINT "run_agent_metric_bucket_pkey"
      PRIMARY KEY ("run_started_on", "run_id", "metric", "dim", "label", "start_offset_ms")
) PARTITION BY RANGE ("run_started_on");

-- run_agent_duration_bucket (partitioned by run_started_on)
CREATE TABLE "run_agent_duration_bucket_2026_01" PARTITION OF "run_agent_duration_bucket"
  FOR VALUES FROM ('2026-01-01') TO ('2026-02-01');
CREATE TABLE "run_agent_duration_bucket_2026_02" PARTITION OF "run_agent_duration_bucket"
  FOR VALUES FROM ('2026-02-01') TO ('2026-03-01');
CREATE TABLE "run_agent_duration_bucket_2026_03" PARTITION OF "run_agent_duration_bucket"
  FOR VALUES FROM ('2026-03-01') TO ('2026-04-01');
CREATE TABLE "run_agent_duration_bucket_2026_04" PARTITION OF "run_agent_duration_bucket"
  FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');
CREATE TABLE "run_agent_duration_bucket_2026_05" PARTITION OF "run_agent_duration_bucket"
  FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');
CREATE TABLE "run_agent_duration_bucket_2026_06" PARTITION OF "run_agent_duration_bucket"
  FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');
CREATE TABLE "run_agent_duration_bucket_2026_07" PARTITION OF "run_agent_duration_bucket"
  FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');
CREATE TABLE "run_agent_duration_bucket_2026_08" PARTITION OF "run_agent_duration_bucket"
  FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');
CREATE TABLE "run_agent_duration_bucket_2026_09" PARTITION OF "run_agent_duration_bucket"
  FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
CREATE TABLE "run_agent_duration_bucket_2026_10" PARTITION OF "run_agent_duration_bucket"
  FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');
CREATE TABLE "run_agent_duration_bucket_2026_11" PARTITION OF "run_agent_duration_bucket"
  FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');
CREATE TABLE "run_agent_duration_bucket_2026_12" PARTITION OF "run_agent_duration_bucket"
  FOR VALUES FROM ('2026-12-01') TO ('2027-01-01');
CREATE TABLE "run_agent_duration_bucket_2027_01" PARTITION OF "run_agent_duration_bucket"
  FOR VALUES FROM ('2027-01-01') TO ('2027-02-01');
CREATE TABLE "run_agent_duration_bucket_2027_02" PARTITION OF "run_agent_duration_bucket"
  FOR VALUES FROM ('2027-02-01') TO ('2027-03-01');
CREATE TABLE "run_agent_duration_bucket_2027_03" PARTITION OF "run_agent_duration_bucket"
  FOR VALUES FROM ('2027-03-01') TO ('2027-04-01');
CREATE TABLE "run_agent_duration_bucket_2027_04" PARTITION OF "run_agent_duration_bucket"
  FOR VALUES FROM ('2027-04-01') TO ('2027-05-01');
CREATE TABLE "run_agent_duration_bucket_2027_05" PARTITION OF "run_agent_duration_bucket"
  FOR VALUES FROM ('2027-05-01') TO ('2027-06-01');
CREATE TABLE "run_agent_duration_bucket_2027_06" PARTITION OF "run_agent_duration_bucket"
  FOR VALUES FROM ('2027-06-01') TO ('2027-07-01');
CREATE TABLE "run_agent_duration_bucket_2027_07" PARTITION OF "run_agent_duration_bucket"
  FOR VALUES FROM ('2027-07-01') TO ('2027-08-01');
CREATE TABLE "run_agent_duration_bucket_2027_08" PARTITION OF "run_agent_duration_bucket"
  FOR VALUES FROM ('2027-08-01') TO ('2027-09-01');
CREATE TABLE "run_agent_duration_bucket_2027_09" PARTITION OF "run_agent_duration_bucket"
  FOR VALUES FROM ('2027-09-01') TO ('2027-10-01');
CREATE TABLE "run_agent_duration_bucket_2027_10" PARTITION OF "run_agent_duration_bucket"
  FOR VALUES FROM ('2027-10-01') TO ('2027-11-01');
CREATE TABLE "run_agent_duration_bucket_2027_11" PARTITION OF "run_agent_duration_bucket"
  FOR VALUES FROM ('2027-11-01') TO ('2027-12-01');
CREATE TABLE "run_agent_duration_bucket_2027_12" PARTITION OF "run_agent_duration_bucket"
  FOR VALUES FROM ('2027-12-01') TO ('2028-01-01');

-- run_agent_metric_bucket (partitioned by run_started_on)
CREATE TABLE "run_agent_metric_bucket_2026_01" PARTITION OF "run_agent_metric_bucket"
  FOR VALUES FROM ('2026-01-01') TO ('2026-02-01');
CREATE TABLE "run_agent_metric_bucket_2026_02" PARTITION OF "run_agent_metric_bucket"
  FOR VALUES FROM ('2026-02-01') TO ('2026-03-01');
CREATE TABLE "run_agent_metric_bucket_2026_03" PARTITION OF "run_agent_metric_bucket"
  FOR VALUES FROM ('2026-03-01') TO ('2026-04-01');
CREATE TABLE "run_agent_metric_bucket_2026_04" PARTITION OF "run_agent_metric_bucket"
  FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');
CREATE TABLE "run_agent_metric_bucket_2026_05" PARTITION OF "run_agent_metric_bucket"
  FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');
CREATE TABLE "run_agent_metric_bucket_2026_06" PARTITION OF "run_agent_metric_bucket"
  FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');
CREATE TABLE "run_agent_metric_bucket_2026_07" PARTITION OF "run_agent_metric_bucket"
  FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');
CREATE TABLE "run_agent_metric_bucket_2026_08" PARTITION OF "run_agent_metric_bucket"
  FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');
CREATE TABLE "run_agent_metric_bucket_2026_09" PARTITION OF "run_agent_metric_bucket"
  FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
CREATE TABLE "run_agent_metric_bucket_2026_10" PARTITION OF "run_agent_metric_bucket"
  FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');
CREATE TABLE "run_agent_metric_bucket_2026_11" PARTITION OF "run_agent_metric_bucket"
  FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');
CREATE TABLE "run_agent_metric_bucket_2026_12" PARTITION OF "run_agent_metric_bucket"
  FOR VALUES FROM ('2026-12-01') TO ('2027-01-01');
CREATE TABLE "run_agent_metric_bucket_2027_01" PARTITION OF "run_agent_metric_bucket"
  FOR VALUES FROM ('2027-01-01') TO ('2027-02-01');
CREATE TABLE "run_agent_metric_bucket_2027_02" PARTITION OF "run_agent_metric_bucket"
  FOR VALUES FROM ('2027-02-01') TO ('2027-03-01');
CREATE TABLE "run_agent_metric_bucket_2027_03" PARTITION OF "run_agent_metric_bucket"
  FOR VALUES FROM ('2027-03-01') TO ('2027-04-01');
CREATE TABLE "run_agent_metric_bucket_2027_04" PARTITION OF "run_agent_metric_bucket"
  FOR VALUES FROM ('2027-04-01') TO ('2027-05-01');
CREATE TABLE "run_agent_metric_bucket_2027_05" PARTITION OF "run_agent_metric_bucket"
  FOR VALUES FROM ('2027-05-01') TO ('2027-06-01');
CREATE TABLE "run_agent_metric_bucket_2027_06" PARTITION OF "run_agent_metric_bucket"
  FOR VALUES FROM ('2027-06-01') TO ('2027-07-01');
CREATE TABLE "run_agent_metric_bucket_2027_07" PARTITION OF "run_agent_metric_bucket"
  FOR VALUES FROM ('2027-07-01') TO ('2027-08-01');
CREATE TABLE "run_agent_metric_bucket_2027_08" PARTITION OF "run_agent_metric_bucket"
  FOR VALUES FROM ('2027-08-01') TO ('2027-09-01');
CREATE TABLE "run_agent_metric_bucket_2027_09" PARTITION OF "run_agent_metric_bucket"
  FOR VALUES FROM ('2027-09-01') TO ('2027-10-01');
CREATE TABLE "run_agent_metric_bucket_2027_10" PARTITION OF "run_agent_metric_bucket"
  FOR VALUES FROM ('2027-10-01') TO ('2027-11-01');
CREATE TABLE "run_agent_metric_bucket_2027_11" PARTITION OF "run_agent_metric_bucket"
  FOR VALUES FROM ('2027-11-01') TO ('2027-12-01');
CREATE TABLE "run_agent_metric_bucket_2027_12" PARTITION OF "run_agent_metric_bucket"
  FOR VALUES FROM ('2027-12-01') TO ('2028-01-01');
