ALTER TABLE project
  ADD CONSTRAINT project_id_org_id_key UNIQUE (id, org_id);

CREATE TABLE runner_artifact (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  project_id uuid NOT NULL,
  name text NOT NULL,
  filename text NOT NULL,
  kind text NOT NULL,
  simulation_class text NOT NULL,
  gatling_version text,
  sha256 text NOT NULL,
  bytes bigint NOT NULL,
  storage_path text NOT NULL,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT runner_artifact_project_tenant_fk
    FOREIGN KEY (project_id, org_id) REFERENCES project(id, org_id) ON DELETE CASCADE,
  CONSTRAINT runner_artifact_id_org_project_key UNIQUE (id, org_id, project_id)
);

CREATE INDEX runner_artifact_project_created_at_idx
  ON runner_artifact(project_id, created_at DESC);

CREATE TABLE runner_job (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  project_id uuid NOT NULL,
  artifact_id uuid NOT NULL,
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
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT runner_job_project_tenant_fk
    FOREIGN KEY (project_id, org_id) REFERENCES project(id, org_id) ON DELETE CASCADE,
  CONSTRAINT runner_job_artifact_tenant_fk
    FOREIGN KEY (artifact_id, org_id, project_id) REFERENCES runner_artifact(id, org_id, project_id) ON DELETE RESTRICT
);

CREATE INDEX runner_job_project_created_at_idx
  ON runner_job(project_id, created_at DESC);

CREATE INDEX runner_job_status_created_at_idx
  ON runner_job(status, created_at ASC);

CREATE INDEX runner_job_artifact_id_idx ON runner_job(artifact_id);

CREATE INDEX runner_job_run_id_idx ON runner_job(run_id) WHERE run_id IS NOT NULL;
