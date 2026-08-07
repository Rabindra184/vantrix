import type { PrismaClient } from '@prisma/client';
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
  startedAt: Date;
  startedOn: Date;
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

function toRecord(row: {
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
  ingestedAt: Date | null;
  engineOptions: unknown;
  error: unknown;
}): RunRecord {
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

  /** Unscoped by design: the worker, acting on a job it has already dequeued. */
  async complete(id: string, verdict: string, toolVersion: string | null): Promise<void> {
    await this.prisma.run.update({
      where: { id },
      data: { status: 'complete', verdict, toolVersion, ingestedAt: new Date() },
    });
  }

  /** Unscoped by design: the worker, acting on a job it has already dequeued. */
  async fail(
    id: string,
    error: { code: string; message: string; remediation: string },
  ): Promise<void> {
    await this.prisma.run.update({
      where: { id },
      data: { status: 'failed', error, ingestedAt: new Date() },
    });
  }

  async list(
    scope: TenantScope,
    opts: { limit: number; cursor?: string },
  ): Promise<{ items: RunRecord[]; nextCursor: string | null }> {
    const rows = await this.prisma.run.findMany({
      where: { orgId: scope.orgId, projectId: scope.projectId },
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      take: opts.limit + 1,
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    });
    const page = rows.slice(0, opts.limit);
    const next = rows.length > opts.limit ? (page[page.length - 1]?.id ?? null) : null;
    return { items: page.map(toRecord), nextCursor: next };
  }

  /**
   * Orphan recovery: a run committed but whose queue enqueue never landed.
   * Ages off created_at, not startedAt — a CI job can post a three-hour-old run.
   */
  async claimStale(olderThanMs: number): Promise<string[]> {
    const cutoff = new Date(Date.now() - olderThanMs);
    const rows = await this.prisma.run.findMany({
      where: { status: 'pending', createdAt: { lt: cutoff } },
      select: { id: true },
      take: 100,
    });
    return rows.map((r) => r.id);
  }
}
