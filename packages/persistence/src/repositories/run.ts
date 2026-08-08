import { Prisma, type PrismaClient } from '@prisma/client';
import type { TenantScope } from './tenant.js';

export interface RunRecord {
  id: string;
  orgId: string;
  projectId: string;
  status: string;
  verdict: string | null;
  tool: string;
  toolVersion: string | null;
  bundleKey: string;
  bundleSha256: string;
  bundleBytes: number;
  idempotencyKey: string | null;
  /** When the platform received this run's bundle — ingest time, not tool start. */
  startedAt: Date;
  startedOn: Date;
  /** The load test's own start (from the tool's run header), set by the
   *  worker once parsing completes. Null until then, and for any run that
   *  never reaches 'complete'. */
  toolStartedAt: Date | null;
  ingestedAt: Date | null;
  engineOptions: Record<string, unknown>;
  error: { code: string; message: string; remediation: string } | null;
}

export interface CreateRunInput {
  orgId: string;
  projectId: string;
  tool: string;
  bundleKey: string;
  bundleSha256: string;
  bundleBytes: number;
  idempotencyKey?: string;
  startedAt: Date;
  engineOptions: Record<string, unknown>;
}

interface RunRow {
  id: string;
  orgId: string;
  projectId: string;
  status: string;
  verdict: string | null;
  tool: string;
  toolVersion: string | null;
  bundleKey: string;
  bundleSha256: string;
  bundleBytes: bigint;
  idempotencyKey: string | null;
  startedAt: Date;
  startedOn: Date;
  toolStartedAt: Date | null;
  ingestedAt: Date | null;
  engineOptions: unknown;
  error: unknown;
}

function toRecord(row: RunRow): RunRecord {
  return {
    id: row.id,
    orgId: row.orgId,
    projectId: row.projectId,
    status: row.status,
    verdict: row.verdict,
    tool: row.tool,
    toolVersion: row.toolVersion,
    bundleKey: row.bundleKey,
    bundleSha256: row.bundleSha256,
    bundleBytes: Number(row.bundleBytes),
    idempotencyKey: row.idempotencyKey,
    startedAt: row.startedAt,
    startedOn: row.startedOn,
    toolStartedAt: row.toolStartedAt,
    ingestedAt: row.ingestedAt,
    engineOptions: (row.engineOptions ?? {}) as Record<string, unknown>,
    error: (row.error ?? null) as RunRecord['error'],
  };
}

/** UTC date of the run start — the partition key. Derived, never supplied. */
function startedOnFrom(startedAt: Date): Date {
  return new Date(
    Date.UTC(startedAt.getUTCFullYear(), startedAt.getUTCMonth(), startedAt.getUTCDate()),
  );
}

export class RunRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(input: CreateRunInput): Promise<RunRecord> {
    const row = await this.prisma.run.create({
      data: {
        orgId: input.orgId,
        projectId: input.projectId,
        status: 'pending',
        verdict: null,
        tool: input.tool,
        bundleKey: input.bundleKey,
        bundleSha256: input.bundleSha256,
        bundleBytes: BigInt(input.bundleBytes),
        idempotencyKey: input.idempotencyKey ?? null,
        startedAt: input.startedAt,
        startedOn: startedOnFrom(input.startedAt),
        engineOptions: input.engineOptions as object,
      },
    });
    return toRecord(row);
  }

  async findById(scope: TenantScope, id: string): Promise<RunRecord | null> {
    const row = await this.prisma.run.findFirst({
      where: { id, orgId: scope.orgId, projectId: scope.projectId },
    });
    return row ? toRecord(row) : null;
  }

  /** Unscoped by design: the worker holds a job, not a caller's credential. */
  async findByIdUnscoped(id: string): Promise<RunRecord | null> {
    const row = await this.prisma.run.findUnique({ where: { id } });
    return row ? toRecord(row) : null;
  }

  async findByIdempotencyKey(scope: TenantScope, key: string): Promise<RunRecord | null> {
    const row = await this.prisma.run.findFirst({
      where: { orgId: scope.orgId, projectId: scope.projectId, idempotencyKey: key },
    });
    return row ? toRecord(row) : null;
  }

  /** Unscoped by design: the worker, acting on a job it has already dequeued. */
  async markParsing(id: string): Promise<void> {
    await this.prisma.run.update({ where: { id }, data: { status: 'parsing' } });
  }

  /**
   * Unscoped by design: the worker, acting on a job it has already dequeued.
   *
   * Only writes when the run is not already terminal. Two jobs for the same
   * run can race past the pending guard in PipelineService (BullMQ's default
   * concurrency, or stalled-job redelivery); the loser's transaction rolls
   * back and must not overwrite the winner's already-committed
   * complete/verdict with failed/null. Returns whether it actually wrote,
   * so the caller can tell it lost the race and skip publishing a terminal
   * notification the winner already sent.
   */
  async fail(
    id: string,
    error: { code: string; message: string; remediation: string },
  ): Promise<boolean> {
    const { count } = await this.prisma.run.updateMany({
      where: { id, status: { notIn: ['complete', 'failed'] } },
      data: { status: 'failed', error, ingestedAt: new Date() },
    });
    return count > 0;
  }

  /**
   * Ordered by the run's real start when known — coalesce(tool_started_at,
   * started_at) — falling back to ingest time for a run the worker has not
   * yet completed. `id DESC` is the tiebreaker so cursor pagination stays
   * stable even when two runs share the exact same ordering key.
   *
   * Prisma's typed query builder cannot express an ORDER BY over a computed
   * expression, so this is raw SQL with keyset (not offset) pagination: the
   * cursor is resolved to its own (ordering key, id) pair first, and the
   * next page is every row strictly after it in that same order — the same
   * semantics Prisma's `cursor`/`skip: 1` gave the old single-column
   * ordering, just expressed by hand.
   */
  async list(
    scope: TenantScope,
    opts: { limit: number; cursor?: string },
  ): Promise<{ items: RunRecord[]; nextCursor: string | null }> {
    let cursorKey: { effective: Date; id: string } | null = null;
    if (opts.cursor) {
      const cursorRun = await this.prisma.run.findFirst({
        where: { id: opts.cursor, orgId: scope.orgId, projectId: scope.projectId },
        select: { id: true, startedAt: true, toolStartedAt: true },
      });
      // A cursor that no longer resolves (wrong tenant, deleted row) yields
      // an empty page rather than reinterpreting it as "start from the top"
      // — silently restarting pagination would resurface items the caller
      // already saw.
      if (!cursorRun) return { items: [], nextCursor: null };
      cursorKey = { effective: cursorRun.toolStartedAt ?? cursorRun.startedAt, id: cursorRun.id };
    }

    const rows = await this.prisma.$queryRaw<RunRow[]>`
      SELECT
        id, org_id AS "orgId", project_id AS "projectId", status, verdict, tool,
        tool_version AS "toolVersion", bundle_key AS "bundleKey",
        bundle_sha256 AS "bundleSha256", bundle_bytes AS "bundleBytes",
        idempotency_key AS "idempotencyKey", started_at AS "startedAt",
        started_on AS "startedOn", tool_started_at AS "toolStartedAt",
        ingested_at AS "ingestedAt", engine_options AS "engineOptions", error
      FROM run
      WHERE org_id = ${scope.orgId}::uuid AND project_id = ${scope.projectId}::uuid
      ${
        cursorKey
          ? Prisma.sql`AND (COALESCE(tool_started_at, started_at), id) < (${cursorKey.effective}::timestamp(3), ${cursorKey.id}::uuid)`
          : Prisma.empty
      }
      ORDER BY COALESCE(tool_started_at, started_at) DESC, id DESC
      LIMIT ${opts.limit + 1}
    `;
    const page = rows.slice(0, opts.limit);
    const next = rows.length > opts.limit ? (page[page.length - 1]?.id ?? null) : null;
    return { items: page.map(toRecord), nextCursor: next };
  }
}
