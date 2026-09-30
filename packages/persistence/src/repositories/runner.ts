import { Prisma, type PrismaClient } from '@prisma/client';
import type { RunEventPhase, RunEventSource } from '@perfportal/contracts';
import { capEventMessage, queuedEventMessages } from '../runner-events.js';

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

/**
 * One event the RUNNER records (docs/superpowers/specs/2026-09-29-run-logs-design.md):
 * a message or a phase separator, never both. The source is not a field — this
 * writer always writes `runner`, so the runner can never speak as `perfportal`.
 */
export type RunnerJobEventInput =
  | { readonly message: string; readonly phase?: undefined }
  | { readonly phase: RunEventPhase; readonly message?: undefined };

export interface RunnerJobEventRecord {
  at: Date;
  source: RunEventSource;
  message: string | null;
  phase: RunEventPhase | null;
}

export interface RunnerJobEvents {
  jobId: string;
  events: RunnerJobEventRecord[];
}

export class RunnerRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async createQueued(input: CreateRunnerJobInput): Promise<RunnerJobWithArtifact> {
    const systemProperties = JSON.stringify(input.job.systemProperties);
    const [start, simulation, pkg] = queuedEventMessages(input.artifact);
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
      ),
      -- The three queue events, IN THIS STATEMENT: a job never exists without
      -- them, and a job insert that fails leaves none. ORDER BY is what makes
      -- seq follow the order Gatling Enterprise prints them in.
      queued_events AS (
        INSERT INTO runner_job_event (job_id, org_id, project_id, source, message)
        SELECT job.id, job.org_id, job.project_id, 'perfportal', m.message
        FROM job
        CROSS JOIN (VALUES (1, ${start}::text), (2, ${simulation}::text), (3, ${pkg}::text)) AS m(ord, message)
        ORDER BY m.ord
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
          projectId: scope.projectId ? scope.projectId : undefined,
          artifactId: { in: ids },
        },
      });
      await tx.runnerArtifact.deleteMany({
        where: {
          orgId: scope.orgId,
          projectId: scope.projectId ? scope.projectId : undefined,
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

  /**
   * The runner's writer. Always source `runner`. The caller treats a failure
   * as best-effort (the executor logs it and runs the job anyway); this method
   * itself does not swallow anything.
   */
  async recordRunnerEvent(jobId: string, event: RunnerJobEventInput): Promise<void> {
    const message = event.message === undefined ? null : capEventMessage(event.message);
    const phase = event.phase ?? null;
    await this.prisma.$executeRaw`
      INSERT INTO runner_job_event (job_id, org_id, project_id, source, message, phase)
      SELECT id, org_id, project_id, 'runner', ${message}::text, ${phase}::text
      FROM runner_job
      WHERE id = ${jobId}::uuid
    `;
  }

  /**
   * A run's events, through the runner job that produced it, oldest first --
   * or null when no runner job in this tenant produced the run. The job is
   * found the way RunsService.lifecycleOf finds it (earliest by created_at),
   * and both reads carry the tenant, the rule every repository here follows.
   */
  async listEventsForRun(orgId: string, projectId: string, runId: string): Promise<RunnerJobEvents | null> {
    const [job] = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT id
      FROM runner_job
      WHERE org_id = ${orgId}::uuid
        AND project_id = ${projectId}::uuid
        AND run_id = ${runId}::uuid
      ORDER BY created_at ASC, id ASC
      LIMIT 1
    `;
    if (!job) return null;
    const events = await this.prisma.$queryRaw<RunnerJobEventRecord[]>`
      SELECT at, source, message, phase
      FROM runner_job_event
      WHERE job_id = ${job.id}::uuid
        AND org_id = ${orgId}::uuid
        AND project_id = ${projectId}::uuid
      ORDER BY seq ASC
    `;
    return { jobId: job.id, events };
  }

  /**
   * Cancels a job. `opts.recordRequest` says whether this cancel is somebody's
   * REQUEST, which the run's log then records as Cancel requested.
   *
   * It is required, with no default, because its wrong value is silent: the
   * API's cancel handler is a person pressing Cancel (true), while the
   * runner's own shutdown step cancels its active job when a node restarts
   * (false) -- and a default of either would have the log tell a reader that
   * somebody cancelled a run when a node merely restarted, or say nothing when
   * somebody did. Either way the job moves exactly the same; only the event
   * differs. The runner's mid-run cancel path records how the run ended.
   */
  async cancel(
    orgId: string,
    projectId: string,
    jobId: string,
    opts: { readonly recordRequest: boolean },
  ): Promise<RunnerJobWithArtifact | null> {
    // One statement: lock the row, move it, and write Cancel requested only
    // when the status it moved FROM was not already cancelled -- a cancel
    // that changes nothing says nothing -- and only when the caller says this
    // cancel is a request.
    const moved = await this.prisma.$queryRaw<{ previousStatus: string }[]>`
      WITH locked AS (
        SELECT id, status
        FROM runner_job
        WHERE org_id = ${orgId}::uuid
          AND project_id = ${projectId}::uuid
          AND id = ${jobId}::uuid
        FOR UPDATE
      ),
      moved AS (
        UPDATE runner_job j
        SET status = 'cancelled', updated_at = now()
        FROM locked l
        WHERE j.id = l.id
          AND l.status IN ('queued', 'starting', 'running', 'closing', 'cancelled')
        RETURNING j.id, j.org_id, j.project_id, l.status AS previous_status
      ),
      cancel_event AS (
        INSERT INTO runner_job_event (job_id, org_id, project_id, source, message)
        SELECT id, org_id, project_id, 'perfportal', 'Cancel requested.'
        FROM moved
        WHERE previous_status <> 'cancelled'
          AND ${opts.recordRequest}::boolean
      )
      SELECT previous_status AS "previousStatus" FROM moved
    `;
    return moved.length === 1 ? this.find(orgId, projectId, jobId) : null;
  }

  async retry(input: RetryRunnerJobInput): Promise<RunnerJobWithArtifact | null> {
    // The queue events name the ARTIFACT the retry runs, so they are built
    // from its row. Read with no status predicate: whether the source job may
    // be retried is decided by the INSERT below, which writes the events in
    // the same statement, so a refused retry writes neither.
    const [artifact] = await this.prisma.$queryRaw<{ simulationClass: string; name: string; bytes: bigint }[]>`
      SELECT a.simulation_class AS "simulationClass", a.name, a.bytes
      FROM runner_job j
      JOIN runner_artifact a ON a.id = j.artifact_id
      WHERE j.org_id = ${input.orgId}::uuid
        AND j.project_id = ${input.projectId}::uuid
        AND j.id = ${input.sourceJobId}::uuid
    `;
    if (!artifact) return null;
    const [start, simulation, pkg] = queuedEventMessages({
      simulationClass: artifact.simulationClass,
      name: artifact.name,
      bytes: Number(artifact.bytes),
    });
    const inserted = await this.prisma.$queryRaw<{ id: string }[]>`
      WITH job AS (
        -- ═══ EVERY FIELD THE OPERATOR CHOSE, INCLUDING test_slug ═══
        --
        -- A retry is the SAME JOB run again, so it carries the whole of what
        -- was asked for. test_slug was the one omission, and it is the one that
        -- changes what the RUN means rather than how it executes: a declared
        -- test exists precisely so two configurations of one simulation can be
        -- told apart, so a retry that loses it files the run under the
        -- auto-created test named after the simulation class. Silently -- the
        -- job succeeds, the run completes, and the cohort the reader is
        -- watching simply does not contain it.
        --
        -- Found by retrying a real job on a real runner. Nothing could have
        -- caught it: no test in this repository called this method.
        --
        -- NO BACKTICKS IN THIS COMMENT. It sits inside a $queryRaw TEMPLATE
        -- LITERAL, so one would end the string and fail as TS1005 two lines
        -- down -- which is exactly how the first draft of it failed, and which
        -- CLAUDE.md already records happening twice before.
        INSERT INTO runner_job (
          id, org_id, project_id, artifact_id, status, requested_by,
          environment, branch, commit_sha, test_slug, java_options, system_properties
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
          j.test_slug,
          j.java_options,
          j.system_properties
        FROM runner_job j
        WHERE j.org_id = ${input.orgId}::uuid
          AND j.project_id = ${input.projectId}::uuid
          AND j.id = ${input.sourceJobId}::uuid
          AND j.status IN ('failed', 'cancelled')
        RETURNING id, org_id, project_id
      ),
      -- The retry's own three queue events, written by this statement for
      -- the same reason createQueued writes them in its own: the second
      -- writer this repository keeps finding one short.
      queued_events AS (
        INSERT INTO runner_job_event (job_id, org_id, project_id, source, message)
        SELECT job.id, job.org_id, job.project_id, 'perfportal', m.message
        FROM job
        CROSS JOIN (VALUES (1, ${start}::text), (2, ${simulation}::text), (3, ${pkg}::text)) AS m(ord, message)
        ORDER BY m.ord
      )
      SELECT id FROM job
    `;
    return inserted.length === 1 ? this.find(input.orgId, input.projectId, input.id) : null;
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
