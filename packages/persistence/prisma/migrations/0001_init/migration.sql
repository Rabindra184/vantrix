-- CreateTable
CREATE TABLE "org" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "org_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_token" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "scopes" TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "api_token_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "run" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "status" TEXT NOT NULL,
    "verdict" TEXT,
    "tool" TEXT NOT NULL,
    "tool_version" TEXT,
    "bundle_key" TEXT NOT NULL,
    "bundle_sha256" TEXT NOT NULL,
    "bundle_bytes" BIGINT NOT NULL,
    "idempotency_key" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL,
    "started_on" DATE NOT NULL,
    "ingested_at" TIMESTAMP(3),
    "engine_options" JSONB NOT NULL,
    "error" JSONB,

    CONSTRAINT "run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "run_stat" (
    "id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "scope" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "family" TEXT NOT NULL,
    "count" INTEGER NOT NULL,
    "ok_count" INTEGER NOT NULL,
    "ko_count" INTEGER NOT NULL,
    "error_rate" DOUBLE PRECISION NOT NULL,
    "min_ms" DOUBLE PRECISION NOT NULL,
    "max_ms" DOUBLE PRECISION NOT NULL,
    "mean_ms" DOUBLE PRECISION NOT NULL,
    "stddev_ms" DOUBLE PRECISION NOT NULL,
    "throughput_rps" DOUBLE PRECISION NOT NULL,
    "percentiles" JSONB NOT NULL,
    "sketch" BYTEA NOT NULL,
    "sketch_kind" TEXT NOT NULL,

    CONSTRAINT "run_stat_pkey" PRIMARY KEY ("id")
);

-- Prisma cannot express partitioning; this statement replaces the generated one.
-- Partitioning by run start date is what makes retention a partition drop
-- rather than a delete storm (NFR-SC-7).
CREATE TABLE "run_series_bucket" (
    "run_started_on" DATE NOT NULL,
    "run_id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "scope" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "start_offset_ms" INTEGER NOT NULL,
    "started_count" INTEGER NOT NULL,
    "ended_count" INTEGER NOT NULL,
    "ok_count" INTEGER NOT NULL,
    "ko_count" INTEGER NOT NULL,
    "min_ms" DOUBLE PRECISION NOT NULL,
    "max_ms" DOUBLE PRECISION NOT NULL,
    "mean_ms" DOUBLE PRECISION NOT NULL,
    "percentiles" JSONB NOT NULL,
    -- A unique/primary key on a partitioned table must contain the partition key.
    CONSTRAINT "run_series_bucket_pkey"
      PRIMARY KEY ("run_started_on", "run_id", "scope", "name", "start_offset_ms")
) PARTITION BY RANGE ("run_started_on");

-- No secondary index on (run_started_on, run_id, scope, name): those four
-- columns are a strict prefix of the primary key above, so the PK's own
-- btree already serves equality/range lookups on them. A matching index
-- would be pure write and storage overhead, repeated per partition.

-- Twelve months from 2026-01. Automatic rollover is a later milestone; until
-- then a write past the last partition fails loudly rather than silently
-- landing somewhere wrong.
CREATE TABLE "run_series_bucket_2026_01" PARTITION OF "run_series_bucket"
  FOR VALUES FROM ('2026-01-01') TO ('2026-02-01');
CREATE TABLE "run_series_bucket_2026_02" PARTITION OF "run_series_bucket"
  FOR VALUES FROM ('2026-02-01') TO ('2026-03-01');
CREATE TABLE "run_series_bucket_2026_03" PARTITION OF "run_series_bucket"
  FOR VALUES FROM ('2026-03-01') TO ('2026-04-01');
CREATE TABLE "run_series_bucket_2026_04" PARTITION OF "run_series_bucket"
  FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');
CREATE TABLE "run_series_bucket_2026_05" PARTITION OF "run_series_bucket"
  FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');
CREATE TABLE "run_series_bucket_2026_06" PARTITION OF "run_series_bucket"
  FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');
CREATE TABLE "run_series_bucket_2026_07" PARTITION OF "run_series_bucket"
  FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');
CREATE TABLE "run_series_bucket_2026_08" PARTITION OF "run_series_bucket"
  FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');
CREATE TABLE "run_series_bucket_2026_09" PARTITION OF "run_series_bucket"
  FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
CREATE TABLE "run_series_bucket_2026_10" PARTITION OF "run_series_bucket"
  FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');
CREATE TABLE "run_series_bucket_2026_11" PARTITION OF "run_series_bucket"
  FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');
CREATE TABLE "run_series_bucket_2026_12" PARTITION OF "run_series_bucket"
  FOR VALUES FROM ('2026-12-01') TO ('2027-01-01');

-- CreateTable
CREATE TABLE "run_error" (
    "id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "message" TEXT NOT NULL,
    "count" INTEGER NOT NULL,

    CONSTRAINT "run_error_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sla_rule" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "scope" TEXT NOT NULL,
    "target_name" TEXT,
    "family" TEXT NOT NULL,
    "metric" TEXT NOT NULL,
    "comparator" TEXT NOT NULL,
    "threshold" DOUBLE PRECISION NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "sla_rule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "run_assertion" (
    "id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "rule_id" UUID NOT NULL,
    "rule_snapshot" JSONB NOT NULL,
    "outcome" TEXT NOT NULL,
    "actual_value" DOUBLE PRECISION,
    "message" TEXT NOT NULL,

    CONSTRAINT "run_assertion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "org_slug_key" ON "org"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "project_org_id_slug_key" ON "project"("org_id", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "api_token_prefix_key" ON "api_token"("prefix");

-- CreateIndex
CREATE INDEX "run_project_id_started_at_idx" ON "run"("project_id", "started_at" DESC);

-- CreateIndex
CREATE INDEX "run_status_started_at_idx" ON "run"("status", "started_at");

-- CreateIndex
CREATE UNIQUE INDEX "run_project_id_idempotency_key_key" ON "run"("project_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "run_stat_run_id_idx" ON "run_stat"("run_id");

-- CreateIndex
CREATE UNIQUE INDEX "run_stat_run_id_scope_name_family_key" ON "run_stat"("run_id", "scope", "name", "family");

-- CreateIndex
CREATE INDEX "run_error_run_id_idx" ON "run_error"("run_id");

-- CreateIndex
CREATE INDEX "sla_rule_project_id_enabled_idx" ON "sla_rule"("project_id", "enabled");

-- CreateIndex
CREATE INDEX "run_assertion_run_id_idx" ON "run_assertion"("run_id");

-- AddForeignKey
ALTER TABLE "project" ADD CONSTRAINT "project_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_token" ADD CONSTRAINT "api_token_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "run" ADD CONSTRAINT "run_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sla_rule" ADD CONSTRAINT "sla_rule_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "run_assertion" ADD CONSTRAINT "run_assertion_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "run"("id") ON DELETE CASCADE ON UPDATE CASCADE;
