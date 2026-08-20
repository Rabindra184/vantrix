import type { PrismaClient } from '@prisma/client';

export interface RunnerArtifactRecord {
  id: string;
  orgId: string;
  projectId: string;
  name: string;
  filename: string;
  kind: string;
  simulationClass: string;
  gatlingVersion: string | null;
  sha256: string;
  bytes: number;
  storagePath: string;
  createdAt: Date;
}

export interface RunnerJobRecord {
  id: string;
  orgId: string;
  projectId: string;
  artifactId: string;
  runId: string | null;
  status: string;
  requestedBy: string;
  environment: string | null;
  branch: string | null;
  commitSha: string | null;
  javaOptions: string | null;
  systemProperties: Record<string, string>;
  logPath: string | null;
  error: { code: string; message: string; remediation: string } | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface RunnerJobWithArtifact {
  artifact: RunnerArtifactRecord;
  job: RunnerJobRecord;
}

interface RunnerRow {
  artifactId: string;
  artifactOrgId: string;
  artifactProjectId: string;
  name: string;
  filename: string;
  kind: string;
  simulationClass: string;
  gatlingVersion: string | null;
  sha256: string;
  bytes: bigint;
  storagePath: string;
  artifactCreatedAt: Date;
  jobId: string;
  jobOrgId: string;
  jobProjectId: string;
  jobArtifactId: string;
  runId: string | null;
  status: string;
  requestedBy: string;
  environment: string | null;
  branch: string | null;
  commitSha: string | null;
  javaOptions: string | null;
  systemProperties: Record<string, string>;
  logPath: string | null;
  error: { code: string; message: string; remediation: string } | null;
  jobCreatedAt: Date;
  updatedAt: Date;
}

export interface CreateRunnerJobInput {
  artifact: {
    id: string;
    orgId: string;
    projectId: string;
    name: string;
    filename: string;
    kind: string;
    simulationClass: string;
    gatlingVersion: string | null;
    sha256: string;
    bytes: number;
    storagePath: string;
  };
  job: {
    id: string;
    requestedBy: string;
    environment: string | null;
    branch: string | null;
    commitSha: string | null;
    javaOptions: string | null;
    systemProperties: Record<string, string>;
  };
}

export interface RetryRunnerJobInput {
  id: string;
  orgId: string;
  projectId: string;
  sourceJobId: string;
  requestedBy: string;
}

export interface RunnerJobError {
  code: string;
  message: string;
  remediation: string;
}

export class RunnerRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async createQueued(input: CreateRunnerJobInput): Promise<RunnerJobWithArtifact> {
    const systemProperties = JSON.stringify(input.job.systemProperties);
    await this.prisma.$executeRaw`
      INSERT INTO runner_artifact (
        id, org_id, project_id, name, filename, kind, simulation_class,
        gatling_version, sha256, bytes, storage_path
      )
      VALUES (
        ${input.artifact.id}::uuid,
        ${input.artifact.orgId}::uuid,
        ${input.artifact.projectId}::uuid,
        ${input.artifact.name},
        ${input.artifact.filename},
        ${input.artifact.kind},
        ${input.artifact.simulationClass},
        ${input.artifact.gatlingVersion},
        ${input.artifact.sha256},
        ${input.artifact.bytes},
        ${input.artifact.storagePath}
      )
    `;

    const [row] = await this.prisma.$queryRaw<RunnerRow[]>`
      INSERT INTO runner_job (
        id, org_id, project_id, artifact_id, status, requested_by,
        environment, branch, commit_sha, java_options, system_properties
      )
      VALUES (
        ${input.job.id}::uuid,
        ${input.artifact.orgId}::uuid,
        ${input.artifact.projectId}::uuid,
        ${input.artifact.id}::uuid,
        'queued',
        ${input.job.requestedBy},
        ${input.job.environment},
        ${input.job.branch},
        ${input.job.commitSha},
        ${input.job.javaOptions},
        ${systemProperties}::jsonb
      )
      RETURNING
        (SELECT id FROM runner_artifact WHERE id = ${input.artifact.id}::uuid) AS "artifactId",
        ${input.artifact.orgId}::uuid AS "artifactOrgId",
        ${input.artifact.projectId}::uuid AS "artifactProjectId",
        ${input.artifact.name} AS name,
        ${input.artifact.filename} AS filename,
        ${input.artifact.kind} AS kind,
        ${input.artifact.simulationClass} AS "simulationClass",
        ${input.artifact.gatlingVersion} AS "gatlingVersion",
        ${input.artifact.sha256} AS sha256,
        ${input.artifact.bytes}::bigint AS bytes,
        ${input.artifact.storagePath} AS "storagePath",
        (SELECT created_at FROM runner_artifact WHERE id = ${input.artifact.id}::uuid) AS "artifactCreatedAt",
        id AS "jobId",
        org_id AS "jobOrgId",
        project_id AS "jobProjectId",
        artifact_id AS "jobArtifactId",
        run_id AS "runId",
        status,
        requested_by AS "requestedBy",
        environment,
        branch,
        commit_sha AS "commitSha",
        java_options AS "javaOptions",
        system_properties AS "systemProperties",
        NULL::text AS "logPath",
        error,
        created_at AS "jobCreatedAt",
        updated_at AS "updatedAt"
    `;
    if (!row) throw new Error('runner job insert returned no row');
    return mapRow(row);
  }

  async listRecent(orgId: string, projectId: string, limit = 20): Promise<RunnerJobWithArtifact[]> {
    const rows = await this.prisma.$queryRaw<RunnerRow[]>`
      SELECT
        a.id AS "artifactId",
        a.org_id AS "artifactOrgId",
        a.project_id AS "artifactProjectId",
        a.name,
        a.filename,
        a.kind,
        a.simulation_class AS "simulationClass",
        a.gatling_version AS "gatlingVersion",
        a.sha256,
        a.bytes,
        a.storage_path AS "storagePath",
        a.created_at AS "artifactCreatedAt",
        j.id AS "jobId",
        j.org_id AS "jobOrgId",
        j.project_id AS "jobProjectId",
        j.artifact_id AS "jobArtifactId",
        j.run_id AS "runId",
        j.status,
        j.requested_by AS "requestedBy",
        j.environment,
        j.branch,
        j.commit_sha AS "commitSha",
        j.java_options AS "javaOptions",
        j.system_properties AS "systemProperties",
        j.log_path AS "logPath",
        j.error,
        j.created_at AS "jobCreatedAt",
        j.updated_at AS "updatedAt"
      FROM runner_job j
      JOIN runner_artifact a ON a.id = j.artifact_id
      WHERE j.org_id = ${orgId}::uuid AND j.project_id = ${projectId}::uuid
      ORDER BY j.created_at DESC, j.id DESC
      LIMIT ${limit}
    `;
    return rows.map(mapRow);
  }

  /**
   * Claims the oldest queued job with a single database statement.
   *
   * FOR UPDATE SKIP LOCKED lets a future multi-process deployment run more
   * than one runner without double-starting a load test, while the default
   * single-node deployment still processes one job at a time by simply
   * awaiting each claim.
   */
  async claimNext(): Promise<RunnerJobWithArtifact | null> {
    const [row] = await this.prisma.$queryRaw<RunnerRow[]>`
      WITH candidate AS (
        SELECT id
        FROM runner_job
        WHERE status = 'queued'
        ORDER BY created_at ASC, id ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE runner_job j
      SET status = 'starting', updated_at = now()
      FROM candidate, runner_artifact a
      WHERE j.id = candidate.id AND a.id = j.artifact_id
      RETURNING
        a.id AS "artifactId",
        a.org_id AS "artifactOrgId",
        a.project_id AS "artifactProjectId",
        a.name,
        a.filename,
        a.kind,
        a.simulation_class AS "simulationClass",
        a.gatling_version AS "gatlingVersion",
        a.sha256,
        a.bytes,
        a.storage_path AS "storagePath",
        a.created_at AS "artifactCreatedAt",
        j.id AS "jobId",
        j.org_id AS "jobOrgId",
        j.project_id AS "jobProjectId",
        j.artifact_id AS "jobArtifactId",
        j.run_id AS "runId",
        j.status,
        j.requested_by AS "requestedBy",
        j.environment,
        j.branch,
        j.commit_sha AS "commitSha",
        j.java_options AS "javaOptions",
        j.system_properties AS "systemProperties",
        j.log_path AS "logPath",
        j.error,
        j.created_at AS "jobCreatedAt",
        j.updated_at AS "updatedAt"
    `;
    return row ? mapRow(row) : null;
  }

  async markRunOpened(jobId: string, runId: string): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE runner_job
      SET run_id = ${runId}::uuid, status = 'running', updated_at = now()
      WHERE id = ${jobId}::uuid AND status = 'starting'
    `;
  }

  async setLogPath(jobId: string, logPath: string): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE runner_job
      SET log_path = ${logPath}, updated_at = now()
      WHERE id = ${jobId}::uuid
    `;
  }

  async markClosing(jobId: string): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE runner_job
      SET status = 'closing', updated_at = now()
      WHERE id = ${jobId}::uuid AND status <> 'cancelled'
    `;
  }

  async markComplete(jobId: string): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE runner_job
      SET status = 'complete', updated_at = now()
      WHERE id = ${jobId}::uuid AND status <> 'cancelled'
    `;
  }

  async markFailed(jobId: string, error: RunnerJobError): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE runner_job
      SET status = 'failed', error = ${JSON.stringify(error)}::jsonb, updated_at = now()
      WHERE id = ${jobId}::uuid AND status <> 'cancelled'
    `;
  }

  async status(jobId: string): Promise<string | null> {
    const [row] = await this.prisma.$queryRaw<{ status: string }[]>`
      SELECT status
      FROM runner_job
      WHERE id = ${jobId}::uuid
    `;
    return row?.status ?? null;
  }

  async cancel(orgId: string, projectId: string, jobId: string): Promise<RunnerJobWithArtifact | null> {
    const updated = await this.prisma.$executeRaw`
      UPDATE runner_job
      SET status = 'cancelled', updated_at = now()
      WHERE org_id = ${orgId}::uuid
        AND project_id = ${projectId}::uuid
        AND id = ${jobId}::uuid
        AND status IN ('queued', 'starting', 'running', 'cancelled')
    `;
    return updated === 1 ? this.find(orgId, projectId, jobId) : null;
  }

  async retry(input: RetryRunnerJobInput): Promise<RunnerJobWithArtifact | null> {
    const inserted = await this.prisma.$executeRaw`
      INSERT INTO runner_job (
        id, org_id, project_id, artifact_id, status, requested_by,
        environment, branch, commit_sha, java_options, system_properties
      )
      SELECT
        ${input.id}::uuid,
        j.org_id,
        j.project_id,
        j.artifact_id,
        'queued',
        ${input.requestedBy},
        j.environment,
        j.branch,
        j.commit_sha,
        j.java_options,
        j.system_properties
      FROM runner_job j
      WHERE j.org_id = ${input.orgId}::uuid
        AND j.project_id = ${input.projectId}::uuid
        AND j.id = ${input.sourceJobId}::uuid
        AND j.status IN ('failed', 'cancelled')
    `;
    return inserted === 1 ? this.find(input.orgId, input.projectId, input.id) : null;
  }

  async find(orgId: string, projectId: string, jobId: string): Promise<RunnerJobWithArtifact | null> {
    const [row] = await this.prisma.$queryRaw<RunnerRow[]>`
      SELECT
        a.id AS "artifactId",
        a.org_id AS "artifactOrgId",
        a.project_id AS "artifactProjectId",
        a.name,
        a.filename,
        a.kind,
        a.simulation_class AS "simulationClass",
        a.gatling_version AS "gatlingVersion",
        a.sha256,
        a.bytes,
        a.storage_path AS "storagePath",
        a.created_at AS "artifactCreatedAt",
        j.id AS "jobId",
        j.org_id AS "jobOrgId",
        j.project_id AS "jobProjectId",
        j.artifact_id AS "jobArtifactId",
        j.run_id AS "runId",
        j.status,
        j.requested_by AS "requestedBy",
        j.environment,
        j.branch,
        j.commit_sha AS "commitSha",
        j.java_options AS "javaOptions",
        j.system_properties AS "systemProperties",
        j.log_path AS "logPath",
        j.error,
        j.created_at AS "jobCreatedAt",
        j.updated_at AS "updatedAt"
      FROM runner_job j
      JOIN runner_artifact a ON a.id = j.artifact_id
      WHERE j.org_id = ${orgId}::uuid
        AND j.project_id = ${projectId}::uuid
        AND j.id = ${jobId}::uuid
    `;
    return row ? mapRow(row) : null;
  }
}

function mapRow(row: RunnerRow): RunnerJobWithArtifact {
  return {
    artifact: {
      id: row.artifactId,
      orgId: row.artifactOrgId,
      projectId: row.artifactProjectId,
      name: row.name,
      filename: row.filename,
      kind: row.kind,
      simulationClass: row.simulationClass,
      gatlingVersion: row.gatlingVersion,
      sha256: row.sha256,
      bytes: Number(row.bytes),
      storagePath: row.storagePath,
      createdAt: row.artifactCreatedAt,
    },
    job: {
      id: row.jobId,
      orgId: row.jobOrgId,
      projectId: row.jobProjectId,
      artifactId: row.jobArtifactId,
      runId: row.runId,
      status: row.status,
      requestedBy: row.requestedBy,
      environment: row.environment,
      branch: row.branch,
      commitSha: row.commitSha,
      javaOptions: row.javaOptions,
      systemProperties: row.systemProperties,
      logPath: row.logPath,
      error: row.error,
      createdAt: row.jobCreatedAt,
      updatedAt: row.updatedAt,
    },
  };
}
