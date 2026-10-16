-- Exact statistics PR 3: one verification row per run, and when a raw log was deleted.
-- No backticks in comments: Prisma runs this file as-is, and the repo's
-- SQL also lives inside template literals elsewhere.

CREATE TABLE run_verification (
  run_id uuid PRIMARY KEY REFERENCES run(id) ON DELETE CASCADE,
  status text NOT NULL,
  checked_at timestamptz(3) NULL,
  verifier_version integer NULL,
  figures_checked integer NOT NULL DEFAULT 0,
  mismatches jsonb NOT NULL DEFAULT '[]'::jsonb,
  gatling_differences jsonb NOT NULL DEFAULT '[]'::jsonb,
  unverifiable_reason text NULL,
  raw_log_retained_until date NULL,
  CONSTRAINT run_verification_status_check
    CHECK (status IN ('pending', 'verified', 'mismatch', 'unverifiable')),
  CONSTRAINT run_verification_reason_check
    CHECK (unverifiable_reason IN ('raw_log_deleted', 'raw_log_missing', 'raw_log_unreadable', 'not_exact'))
);
CREATE INDEX run_verification_status_idx ON run_verification (status);

-- When retention deleted the run's raw log. NULL while the log is kept.
ALTER TABLE run ADD COLUMN raw_log_deleted_at timestamptz(3) NULL;
-- ingested_at is the retention clock: every terminal writer stamps it.
CREATE INDEX run_ingested_at_idx ON run (ingested_at);
