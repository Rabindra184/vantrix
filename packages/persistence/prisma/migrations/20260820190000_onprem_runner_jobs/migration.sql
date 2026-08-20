CREATE TABLE runner_artifact (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  name text NOT NULL,
  filename text NOT NULL,
  kind text NOT NULL,
  simulation_class text NOT NULL,
  gatling_version text,
  sha256 text NOT NULL,
  bytes bigint NOT NULL,
  storage_path text NOT NULL,
  created_at timestamptz(3) NOT NULL DEFAULT now()
);

CREATE INDEX runner_artifact_project_created_at_idx
  ON runner_artifact(project_id, created_at DESC);

CREATE TABLE runner_job (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  artifact_id uuid NOT NULL REFERENCES runner_artifact(id) ON DELETE RESTRICT,
  run_id uuid REFERENCES run(id) ON DELETE SET NULL,
  status text NOT NULL,
  requested_by text NOT NULL,
  environment text,
  branch text,
  commit_sha text,
  java_options text,
  system_properties jsonb NOT NULL DEFAULT '{}'::jsonb,
  log_path text,
  error jsonb,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now()
);

CREATE INDEX runner_job_project_created_at_idx
  ON runner_job(project_id, created_at DESC);

CREATE INDEX runner_job_status_created_at_idx
  ON runner_job(status, created_at ASC);
