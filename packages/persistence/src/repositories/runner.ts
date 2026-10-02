import { Prisma, type PrismaClient } from '@prisma/client';
import type { RunEventPhase, RunEventSource } from '@perfportal/contracts';
import { capEventMessage, queuedEventMessages } from '../runner-events.js';

/**
 * One VERSION of a package: the exact file a job runs. The run name and the
 * simulation class are the JOB's, not this row's — one version serves many jobs.
 */
export interface RunnerArtifactRecord {
  id: string;
  orgId: string;
  projectId: string;
  filename: string;
  kind: string;
  gatlingVersion: string | null;
  sha256: string;
  bytes: number;
  storagePath: string;
  createdAt: Date;
  /** Null once the package was deleted; the row stays as the record of what
   *  its jobs ran until retention removes it. */
  packageId: string | null;
  packageName: string | null;
  /** The jar manifest's Gatling-Simulations; null when unknown. */
  simulations: string[] | null;
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
  /** The RUN name the requester chose. */
  name: string;
  /** The class this job runs (`-s`). */
  simulationClass: string;
}

export interface RunnerJobWithArtifact {
  artifact: RunnerArtifactRecord;
  job: RunnerJobRecord;
}

interface RunnerRow {
  artifactId: string;
  artifactOrgId: string;
  artifactProjectId: string;
  filename: string;
  kind: string;
  gatlingVersion: string | null;
  sha256: string;
  bytes: bigint;
  storagePath: string;
  artifactCreatedAt: Date;
  packageId: string | null;
  packageName: string | null;
  simulations: string[] | null;
  jobName: string;
  jobSimulationClass: string;
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

/**
 * A job on an EXISTING version (`artifactId`) — the version is created by
 * `PackageRepository.addVersion`, never here. The job names the run and the
 * class it runs.
 */
export interface CreateRunnerJobInput {
  orgId: string;
  projectId: string;
  artifactId: string;
  job: {
    id: string;
    requestedBy: string;
    name: string;
    simulationClass: string;
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

export type RetryRunnerJobResult =
  | { kind: 'retried'; row: RunnerJobWithArtifact }
  | { kind: 'not_retryable' }
  | { kind: 'package_deleted' };

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

  /**
   * Queues a job on an existing version. Null when the version is not in this
   * tenant, or its package was deleted — a version whose package is gone is a
   * record of what earlier jobs ran, not something a new job may start from.
   */
  async createQueued(input: CreateRunnerJobInput): Promise<RunnerJobWithArtifact | null> {
    const [version] = await this.prisma.$queryRaw<{ bytes: bigint; packageName: string }[]>`
      SELECT a.bytes, p.name AS "packageName"
      FROM runner_artifact a
      JOIN package p ON p.id = a.package_id
      WHERE a.id = ${input.artifactId}::uuid
        AND a.org_id = ${input.orgId}::uuid
        AND a.project_id = ${input.projectId}::uuid
    `;
    if (!version) return null;
    const [start, simulation, pkg] = queuedEventMessages({
      simulationClass: input.job.simulationClass,
      packageName: version.packageName,
      bytes: Number(version.bytes),
    });
    const systemProperties = JSON.stringify(input.job.systemProperties);
    const inserted = await this.prisma.$queryRaw<{ id: string }[]>`
      WITH version AS (
        -- FOR SHARE OF the package: a delete locks the package FOR UPDATE
        -- before it counts active jobs, so it waits for this statement and
        -- then sees the job it queued. A version whose package is already
        -- gone matches no row, and nothing is queued.
        SELECT a.id, a.org_id, a.project_id
        FROM runner_artifact a
        JOIN package p ON p.id = a.package_id
        WHERE a.id = ${input.artifactId}::uuid
          AND a.org_id = ${input.orgId}::uuid
          AND a.project_id = ${input.projectId}::uuid
        FOR SHARE OF p
      ),
      job AS (
        INSERT INTO runner_job (
          id, org_id, project_id, artifact_id, status, requested_by, name, simulation_class,
          environment, branch, commit_sha, test_slug, java_options, system_properties
        )
        SELECT
          ${input.job.id}::uuid, version.org_id, version.project_id, version.id, 'queued',
          ${input.job.requestedBy}, ${input.job.name}, ${input.job.simulationClass},
          ${input.job.environment}, ${input.job.branch}, ${input.job.commitSha},
          ${input.job.testSlug}, ${input.job.javaOptions}, ${systemProperties}::jsonb
        FROM version
        RETURNING id, org_id, project_id
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
      SELECT id FROM job
    `;
    if (inserted.length !== 1) return null;
    // Null means "version refused", so it must never stand for a job that WAS
    // queued and then could not be read back — that is an invariant broken,
    // and it says so, naming the job, the way retry does.
    const row = await this.find(input.orgId, input.projectId, input.job.id);
    if (!row) throw new Error(`runner job ${input.job.id} was queued but could not be read back`);
    return row;
  }

  async listRecent(orgId: string, projectId: string, limit = 20): Promise<RunnerJobWithArtifact[]> {
    const rows = await this.prisma.$queryRaw<RunnerRow[]>`
      SELECT
        a.id AS "artifactId",
        a.org_id AS "artifactOrgId",
        a.project_id AS "artifactProjectId",
        a.filename,
        a.kind,
        a.gatling_version AS "gatlingVersion",
        a.sha256,
        a.bytes,
        a.storage_path AS "storagePath",
        a.created_at AS "artifactCreatedAt",
        a.package_id AS "packageId",
        p.name AS "packageName",
        a.simulations,
        j.name AS "jobName",
        j.simulation_class AS "jobSimulationClass",
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
      LEFT JOIN package p ON p.id = a.package_id
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
        a.filename,
        a.kind,
        a.gatling_version AS "gatlingVersion",
        a.sha256,
        a.bytes,
        a.storage_path AS "storagePath",
        a.created_at AS "artifactCreatedAt",
        a.package_id AS "packageId",
        (SELECT name FROM package WHERE id = a.package_id) AS "packageName",
        a.simulations,
        j.name AS "jobName",
        j.simulation_class AS "jobSimulationClass",
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
    // The run is stamped with its package in the same statement that attaches
    // it: Used-by counts read run.package_id, which survives the job's retention.
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      WITH job AS (
        UPDATE runner_job
        SET run_id = ${runId}::uuid, status = 'running', updated_at = now()
        WHERE id = ${jobId}::uuid AND status = 'starting'
        RETURNING id, artifact_id
      ),
      stamped AS (
        UPDATE run r SET package_id = a.package_id
        FROM job JOIN runner_artifact a ON a.id = job.artifact_id
        WHERE r.id = ${runId}::uuid
      )
      SELECT id FROM job
    `;
    return rows.length === 1;
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

  /** Pass 1: terminal jobs past the window go, with their events (cascade); the
   *  caller removes their log files. Their versions are pass 2's question. */
  async deleteTerminalJobsOlderThan(
    scope: RunnerClaimScope,
    cutoff: Date,
    limit = 25,
  ): Promise<{ jobId: string; logPath: string | null }[]> {
    const projectPredicate = scope.projectId
      ? Prisma.sql`AND project_id = ${scope.projectId}::uuid`
      : Prisma.empty;
    return this.prisma.$queryRaw<{ jobId: string; logPath: string | null }[]>`
      DELETE FROM runner_job
      WHERE id IN (
        SELECT id FROM runner_job
        WHERE org_id = ${scope.orgId}::uuid
          ${projectPredicate}
          AND status IN ('complete', 'failed', 'cancelled')
          AND updated_at < ${cutoff}
        ORDER BY updated_at ASC, id ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id AS "jobId", log_path AS "logPath"
    `;
  }

  /**
   * Pass 2: a version goes with its file when it is NOT any package's current
   * version, NO job references it any more, and it was uploaded before the
   * window. A package's current version is never swept.
   *
   * ═══ LOCK, THEN RE-CHECK: TWO STATEMENTS IN ONE TRANSACTION ═══
   *
   * One statement cannot do this safely. Its NOT EXISTS predicates are read on
   * the statement's snapshot, and FOR UPDATE SKIP LOCKED does not re-check them
   * when it takes the lock — EvalPlanQual re-checks only a row that was itself
   * UPDATEd, and nothing updates a version row: an upload that REUSES an
   * existing version (same bytes) only KEY SHARE locks it, through the
   * current_artifact_id foreign key. So an upload that made a version current,
   * committing after the snapshot but before the lock, was deleted anyway: ON
   * DELETE SET NULL silently emptied the package's current version and the
   * runner removed the file. A job inserted in the same window instead tripped
   * runner_job's ON DELETE RESTRICT and failed the whole batch.
   *
   * So statement 1 only CHOOSES and LOCKS (FOR UPDATE OF a SKIP LOCKED), and
   * statement 2 — a separate statement, so under READ COMMITTED it takes a
   * fresh snapshot — deletes only the locked versions that are STILL unneeded.
   * Anything committed before the lock, statement 2 sees. After the lock,
   * nothing can make a locked version current or point a job at it: both need
   * a KEY SHARE lock on the version, which waits behind FOR UPDATE. And a
   * writer already holding one when statement 1 runs makes it skip that row.
   *
   * THE RESIDUAL: a writer that reaches a version AFTER statement 1 locked it —
   * a queue or a retry inserting a job on it, an upload of the same bytes
   * making it current — waits for this transaction, then fails on its own
   * foreign key (23503) once the row is gone. Loud, and on that one request:
   * the sweep completes, and nothing is deleted or emptied silently.
   *
   * THE SNAPSHOT-TO-LOCK WINDOW ITSELF IS ARGUED, NOT RED-VERIFIED. It lies
   * inside statement 1, and nothing outside the database can park a statement
   * between taking its snapshot and taking its row locks. The tests pin what
   * can be reached: the lock held across both statements, by parking this
   * transaction between them.
   */
  async deleteUnneededVersionsOlderThan(
    scope: RunnerClaimScope,
    cutoff: Date,
    limit = 25,
  ): Promise<{ artifactId: string; storagePath: string }[]> {
    const projectPredicate = scope.projectId
      ? Prisma.sql`AND a.project_id = ${scope.projectId}::uuid`
      : Prisma.empty;
    return this.prisma.$transaction(
      async (tx) => {
        const locked = await tx.$queryRaw<{ id: string }[]>`
          SELECT a.id FROM runner_artifact a
          WHERE a.org_id = ${scope.orgId}::uuid
            ${projectPredicate}
            AND a.created_at < ${cutoff}
            AND NOT EXISTS (SELECT 1 FROM package p WHERE p.current_artifact_id = a.id)
            AND NOT EXISTS (SELECT 1 FROM runner_job j WHERE j.artifact_id = a.id)
          ORDER BY a.created_at ASC, a.id ASC
          LIMIT ${limit}
          FOR UPDATE OF a SKIP LOCKED
        `;
        if (locked.length === 0) return [];
        return tx.$queryRaw<{ artifactId: string; storagePath: string }[]>`
          DELETE FROM runner_artifact a
          WHERE a.id = ANY(${locked.map((row) => row.id)}::uuid[])
            AND NOT EXISTS (SELECT 1 FROM package p WHERE p.current_artifact_id = a.id)
            AND NOT EXISTS (SELECT 1 FROM runner_job j WHERE j.artifact_id = a.id)
          RETURNING a.id AS "artifactId", a.storage_path AS "storagePath"
        `;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );
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

  /**
   * Queues the source job again, on the SAME version it ran — never whatever
   * its package holds now, so a retry runs byte for byte what failed — under
   * the source's own name and class. `package_deleted` when that version's
   * package is gone: its file is gone with it, so there is nothing to run.
   */
  async retry(input: RetryRunnerJobInput): Promise<RetryRunnerJobResult> {
    // The queue events name the JOB's class and its version's PACKAGE, so they
    // are built from those rows. Read with no status predicate: whether the
    // source job may be retried is decided by the INSERT below, which writes
    // the events in the same statement, so a refused retry writes neither.
    const [source] = await this.prisma.$queryRaw<{
      simulationClass: string;
      packageId: string | null;
      packageName: string | null;
      bytes: bigint;
    }[]>`
      SELECT j.simulation_class AS "simulationClass", a.package_id AS "packageId",
        p.name AS "packageName", a.bytes
      FROM runner_job j
      JOIN runner_artifact a ON a.id = j.artifact_id
      LEFT JOIN package p ON p.id = a.package_id
      WHERE j.org_id = ${input.orgId}::uuid
        AND j.project_id = ${input.projectId}::uuid
        AND j.id = ${input.sourceJobId}::uuid
    `;
    if (!source) return { kind: 'not_retryable' };
    if (source.packageId === null || source.packageName === null) return { kind: 'package_deleted' };
    const [start, simulation, pkg] = queuedEventMessages({
      simulationClass: source.simulationClass,
      packageName: source.packageName,
      bytes: Number(source.bytes),
    });
    const inserted = await this.prisma.$queryRaw<{ id: string }[]>`
      WITH source AS (
        -- FOR SHARE OF the package, for the reason createQueued takes it: a
        -- retry is a start too, and a package delete that counts active jobs
        -- must either wait for this statement and see the job it queues, or
        -- have committed first, leaving no package row to join, so nothing is
        -- queued on a version whose file the delete handed back for removal.
        SELECT j.*
        FROM runner_job j
        JOIN runner_artifact a ON a.id = j.artifact_id
        JOIN package p ON p.id = a.package_id
        WHERE j.org_id = ${input.orgId}::uuid
          AND j.project_id = ${input.projectId}::uuid
          AND j.id = ${input.sourceJobId}::uuid
          AND j.status IN ('failed', 'cancelled')
        FOR SHARE OF p
      ),
      job AS (
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
        -- The run name and the simulation class are per-job fields now (one
        -- version serves many jobs), so they are copied here with the rest;
        -- and artifact_id is the SOURCE's, which is what makes a retry run
        -- the bytes that failed rather than a newer upload.
        --
        -- NO BACKTICKS IN THIS COMMENT. It sits inside a $queryRaw TEMPLATE
        -- LITERAL, so one would end the string and fail as TS1005 two lines
        -- down -- which is exactly how the first draft of it failed, and which
        -- CLAUDE.md already records happening twice before.
        INSERT INTO runner_job (
          id, org_id, project_id, artifact_id, status, requested_by, name, simulation_class,
          environment, branch, commit_sha, test_slug, java_options, system_properties
        )
        SELECT
          ${input.id}::uuid,
          j.org_id,
          j.project_id,
          j.artifact_id,
          'queued',
          ${input.requestedBy},
          j.name,
          j.simulation_class,
          j.environment,
          j.branch,
          j.commit_sha,
          j.test_slug,
          j.java_options,
          j.system_properties
        FROM source j
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
    if (inserted.length === 1) {
      const row = await this.find(input.orgId, input.projectId, input.id);
      if (!row) throw new Error(`runner job ${input.id} was queued as a retry but could not be read back`);
      return { kind: 'retried', row };
    }
    // Nothing was queued. Either the source is not retryable, or its package
    // was deleted between the read above and the insert — which, holding the
    // package FOR SHARE, then found no package row to join. Ask which.
    const [after] = await this.prisma.$queryRaw<{ packageId: string | null }[]>`
      SELECT a.package_id AS "packageId"
      FROM runner_job j
      JOIN runner_artifact a ON a.id = j.artifact_id
      WHERE j.org_id = ${input.orgId}::uuid
        AND j.project_id = ${input.projectId}::uuid
        AND j.id = ${input.sourceJobId}::uuid
    `;
    return after !== undefined && after.packageId === null
      ? { kind: 'package_deleted' }
      : { kind: 'not_retryable' };
  }

  async find(orgId: string, projectId: string, jobId: string): Promise<RunnerJobWithArtifact | null> {
    const [row] = await this.prisma.$queryRaw<RunnerRow[]>`
      SELECT
        a.id AS "artifactId",
        a.org_id AS "artifactOrgId",
        a.project_id AS "artifactProjectId",
        a.filename,
        a.kind,
        a.gatling_version AS "gatlingVersion",
        a.sha256,
        a.bytes,
        a.storage_path AS "storagePath",
        a.created_at AS "artifactCreatedAt",
        a.package_id AS "packageId",
        p.name AS "packageName",
        a.simulations,
        j.name AS "jobName",
        j.simulation_class AS "jobSimulationClass",
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
      LEFT JOIN package p ON p.id = a.package_id
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
      filename: row.filename,
      kind: row.kind,
      gatlingVersion: row.gatlingVersion,
      sha256: row.sha256,
      bytes: Number(row.bytes),
      storagePath: row.storagePath,
      createdAt: row.artifactCreatedAt,
      packageId: row.packageId,
      packageName: row.packageName,
      simulations: row.simulations,
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
      name: row.jobName,
      simulationClass: row.jobSimulationClass,
    },
  };
}
