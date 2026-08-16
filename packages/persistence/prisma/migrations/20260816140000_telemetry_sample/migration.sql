-- Load-generator host telemetry. Partitioned on sampled_on exactly like
-- run_series_bucket, run_user_bucket and run_error_bucket, for retention:
-- dropping a partition beats a delete storm. Retention matters MORE here than
-- for those three, because this table grows on wall-clock time rather than on
-- runs — a daemon writing a sample a second, forever, whether or not a test is
-- running.
--
-- THE PARTITION KEY IS THE AGENT'S DATE, NOT THE SERVER'S. It has to be, so a
-- sample lands in the partition its sampled_at implies and a window query can
-- prune. A clock skewed across midnight puts a sample in the neighbouring
-- partition; the pruning predicate in TELEMETRY_WINDOW_SQL covers both edges,
-- and received_at is what makes such a case diagnosable rather than mysterious.
--
-- NO run_id COLUMN, AND THAT IS THE ARCHITECTURE. A run does not exist in
-- PerfPortal until its bundle is POSTed, which happens AFTER the test finishes;
-- an agent handed a run id would need a handshake, an ordering guarantee
-- between test and upload, and a failure mode for when the upload never comes.
-- Instead a run selects whatever overlaps its own window.
--
-- org_id and project_id come from the TOKEN, never from the agent's payload.
-- An agent runs on a load generator, which is a machine an attacker is far
-- likelier to reach than the API.
CREATE TABLE "telemetry_sample" (
    "sampled_on"  DATE        NOT NULL,
    "org_id"      UUID        NOT NULL,
    "project_id"  UUID        NOT NULL,
    "host"        TEXT        NOT NULL,
    "sampled_at"  TIMESTAMPTZ NOT NULL,
    "received_at" TIMESTAMPTZ NOT NULL,

    -- Cumulative counters, stored RAW. Never a rate the agent computed: the
    -- sampling interval is the agent's and it drifts, and a counter reset
    -- (process restart, interface flap) is detectable here as
    -- `current < previous` and invisible in a pre-computed rate, where it
    -- arrives as a plausible enormous spike a reader would believe.
    --
    -- BIGINT throughout. These are since-boot counters on a machine that may
    -- be up for months; INTEGER overflows net_rx_bytes inside a day at 10Gb/s.
    "cpu_user_ms"       BIGINT NOT NULL,
    "cpu_system_ms"     BIGINT NOT NULL,
    "cpu_idle_ms"       BIGINT NOT NULL,
    "cpu_iowait_ms"     BIGINT NOT NULL,
    "net_rx_bytes"      BIGINT NOT NULL,
    "net_tx_bytes"      BIGINT NOT NULL,
    "tcp_in_segs"       BIGINT NOT NULL,
    "tcp_out_segs"      BIGINT NOT NULL,
    "tcp_retrans_segs"  BIGINT NOT NULL,
    "tcp_in_errs"       BIGINT NOT NULL,
    "tcp_active_opens"  BIGINT NOT NULL,
    "tcp_passive_opens" BIGINT NOT NULL,

    -- Gauges, stored as read.
    "mem_used_bytes"  BIGINT NOT NULL,
    "mem_total_bytes" BIGINT NOT NULL,

    -- Connection counts by TCP state. JSONB because the state set is the
    -- KERNEL'S, not ours: ESTABLISHED, TIME_WAIT, CLOSE_WAIT, SYN_SENT and
    -- more, and a column per state would need a migration every time an OS
    -- reports one we had not enumerated.
    -- {"ESTABLISHED": 412, "TIME_WAIT": 88} — absent when zero.
    "tcp_states" JSONB NOT NULL,

    -- A unique/primary key on a partitioned table must contain the partition
    -- key. (org_id, project_id) precede host so the tenant predicate is a
    -- prefix of the index the window query uses.
    CONSTRAINT "telemetry_sample_pkey"
      PRIMARY KEY ("sampled_on", "org_id", "project_id", "host", "sampled_at")
) PARTITION BY RANGE ("sampled_on");

-- No secondary index. The window query filters
-- (sampled_on, org_id, project_id) and orders by (host, sampled_at) — a strict
-- prefix followed by the remaining key columns, so the primary key's own btree
-- serves it. The same reasoning 0001_init records for run_series_bucket.

-- Twelve months from 2026-01, matching every other partitioned table here.
-- Automatic rollover is a later milestone; until then a write past the last
-- partition fails LOUDLY rather than silently landing somewhere wrong.
CREATE TABLE "telemetry_sample_2026_01" PARTITION OF "telemetry_sample"
  FOR VALUES FROM ('2026-01-01') TO ('2026-02-01');
CREATE TABLE "telemetry_sample_2026_02" PARTITION OF "telemetry_sample"
  FOR VALUES FROM ('2026-02-01') TO ('2026-03-01');
CREATE TABLE "telemetry_sample_2026_03" PARTITION OF "telemetry_sample"
  FOR VALUES FROM ('2026-03-01') TO ('2026-04-01');
CREATE TABLE "telemetry_sample_2026_04" PARTITION OF "telemetry_sample"
  FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');
CREATE TABLE "telemetry_sample_2026_05" PARTITION OF "telemetry_sample"
  FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');
CREATE TABLE "telemetry_sample_2026_06" PARTITION OF "telemetry_sample"
  FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');
CREATE TABLE "telemetry_sample_2026_07" PARTITION OF "telemetry_sample"
  FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');
CREATE TABLE "telemetry_sample_2026_08" PARTITION OF "telemetry_sample"
  FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');
CREATE TABLE "telemetry_sample_2026_09" PARTITION OF "telemetry_sample"
  FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
CREATE TABLE "telemetry_sample_2026_10" PARTITION OF "telemetry_sample"
  FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');
CREATE TABLE "telemetry_sample_2026_11" PARTITION OF "telemetry_sample"
  FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');
CREATE TABLE "telemetry_sample_2026_12" PARTITION OF "telemetry_sample"
  FOR VALUES FROM ('2026-12-01') TO ('2027-01-01');
