import { Prisma, type PrismaClient } from '@prisma/client';

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
  /** The test the requester named, or null — becomes the run's own
   *  declaration when the runner opens it. */
  testSlug: string | null;
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
  testSlug: string | null;
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
    testSlug: string | null;
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

export interface RunnerClaimScope {
  orgId: string;
  projectId?: string | null;
}

export interface DeletedRunnerArtifact {
  artifactId: string;
  storagePath: string;
  logPaths: string[];
}

export class RunnerRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async createQueued(input: CreateRunnerJobInput): Promise<RunnerJobWithArtifact> {
    const systemProperties = JSON.stringify(input.job.systemProperties);
    const [row] = await this.prisma.$queryRaw<RunnerRow[]>`
      WITH artifact AS (
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
        RETURNING *
      ),
      job AS (
        INSERT INTO runner_job (
          id, org_id, project_id, artifact_id, status, requested_by,
          environment, branch, commit_sha, test_slug, java_options, system_properties
        )
        SELECT
          ${input.job.id}::uuid,
          artifact.org_id,
          artifact.project_id,
          artifact.id,
          'queued',
          ${input.job.requestedBy},
          ${input.job.environment},
          ${input.job.branch},
          ${input.job.commitSha},
          ${input.job.testSlug},
          ${input.job.javaOptions},
          ${systemProperties}::jsonb
        FROM artifact
        RETURNING *
      )
      SELECT
        artifact.id AS "artifactId",
        artifact.org_id AS "artifactOrgId",
        artifact.project_id AS "artifactProjectId",
        artifact.name,
        artifact.filename,
        artifact.kind,
        artifact.simulation_class AS "simulationClass",
        artifact.gatling_version AS "gatlingVersion",
        artifact.sha256,
        artifact.bytes,
        artifact.storage_path AS "storagePath",
        artifact.created_at AS "artifactCreatedAt",
        job.id AS "jobId",
        job.org_id AS "jobOrgId",
        job.project_id AS "jobProjectId",
        job.artifact_id AS "jobArtifactId",
        job.run_id AS "runId",
        job.status,
        job.requested_by AS "requestedBy",
        job.environment,
        job.branch,
        job.commit_sha AS "commitSha",
        job.test_slug AS "testSlug",
        job.java_options AS "javaOptions",
        job.system_properties AS "systemProperties",
        job.log_path AS "logPath",
        job.error,
        job.created_at AS "jobCreatedAt",
        job.updated_at AS "updatedAt"
      FROM artifact, job
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
        j.test_slug AS "testSlug",
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
  async claimNext(scope: RunnerClaimScope): Promise<RunnerJobWithArtifact | null> {
    const projectPredicate = scope.projectId
      ? Prisma.sql`AND project_id = ${scope.projectId}::uuid`
      : Prisma.empty;
    const [row] = await this.prisma.$queryRaw<RunnerRow[]>`
      WITH candidate AS (
        SELECT id
        FROM runner_job
        WHERE status = 'queued'
          AND org_id = ${scope.orgId}::uuid
          ${projectPredicate}
        ORDER BY created_at ASC, id ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
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
        j.test_slug AS "testSlug",
        j.java_options AS "javaOptions",
        j.system_properties AS "systemProperties",
        j.log_path AS "logPath",
        j.error,
        j.created_at AS "jobCreatedAt",
        j.updated_at AS "updatedAt"
    `;
    return row ? mapRow(row) : null;
  }

  async markRunOpened(jobId: string, runId: string): Promise<boolean> {
    const updated = await this.prisma.$executeRaw`
      UPDATE runner_job
      SET run_id = ${runId}::uuid, status = 'running', updated_at = now()
      WHERE id = ${jobId}::uuid AND status = 'starting'
    `;
    return updated === 1;
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

  async heartbeat(jobId: string): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE runner_job
      SET updated_at = now()
      WHERE id = ${jobId}::uuid AND status IN ('starting', 'running', 'closing')
    `;
  }

  async failStale(scope: RunnerClaimScope, cutoff: Date): Promise<number> {
    const projectPredicate = scope.projectId
      ? Prisma.sql`AND project_id = ${scope.projectId}::uuid`
      : Prisma.empty;
    const error = {
      code: 'RUNNER_JOB_STALE',
      message: 'The on-prem runner job stopped heartbeating before it reached a terminal state.',
      remediation: 'Check the runner process logs and host health, then retry the job.',
    };
    return this.prisma.$executeRaw`
      UPDATE runner_job
      SET status = 'failed', error = ${JSON.stringify(error)}::jsonb, updated_at = now()
      WHERE org_id = ${scope.orgId}::uuid
        ${projectPredicate}
        AND status IN ('starting', 'running', 'closing')
        AND updated_at < ${cutoff}
    `;
  }

  async deleteTerminalArtifactsOlderThan(
    scope: RunnerClaimScope,
    cutoff: Date,
    limit = 25,
  ): Promise<DeletedRunnerArtifact[]> {
    const projectPredicate = scope.projectId
      ? Prisma.sql`AND a.project_id = ${scope.projectId}::uuid`
      : Prisma.empty;

    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{
        artifactId: string;
        storagePath: string;
        logPaths: string[] | null;
      }[]>`
        WITH eligible AS (
          SELECT
            a.id,
            max(j.updated_at) AS last_updated,
            COALESCE(array_remove(array_agg(j.log_path ORDER BY j.created_at), NULL), ARRAY[]::text[]) AS log_paths
          FROM runner_artifact a
          JOIN runner_job j
            ON j.artifact_id = a.id
           AND j.org_id = a.org_id
           AND j.project_id = a.project_id
          WHERE a.org_id = ${scope.orgId}::uuid
            ${projectPredicate}
          GROUP BY a.id
          HAVING bool_and(j.status IN ('complete', 'failed', 'cancelled'))
             AND max(j.updated_at) < ${cutoff}
        )
        SELECT
          a.id AS "artifactId",
          a.storage_path AS "storagePath",
          e.log_paths AS "logPaths"
        FROM eligible e
        JOIN runner_artifact a ON a.id = e.id
        ORDER BY e.last_updated ASC, a.id ASC
        LIMIT ${limit}
        FOR UPDATE OF a
      `;
      if (rows.length === 0) return [];

      const ids = rows.map((row) => row.artifactId);
      await tx.runnerJob.deleteMany({
        where: {
          orgId: scope.orgId,
          ...(scope.projectId ? { projectId: scope.projectId } : {}),
          artifactId: { in: ids },
        },
      });
      await tx.runnerArtifact.deleteMany({
        where: {
          orgId: scope.orgId,
          ...(scope.projectId ? { projectId: scope.projectId } : {}),
          id: { in: ids },
        },
      });

      return rows.map((row) => ({
        artifactId: row.artifactId,
        storagePath: row.storagePath,
        logPaths: row.logPaths ?? [],
      }));
    });
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
        AND status IN ('queued', 'starting', 'running', 'closing', 'cancelled')
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
        j.test_slug AS "testSlug",
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
      testSlug: row.testSlug,
      javaOptions: row.javaOptions,
      systemProperties: row.systemProperties,
      logPath: row.logPath,
      error: row.error,
      createdAt: row.jobCreatedAt,
      updatedAt: row.updatedAt,
    },
  };
}
