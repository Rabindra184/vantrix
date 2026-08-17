import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { ProjectScope, TenantScope } from './tenant.js';

export interface RunRecord {
  id: string;
  orgId: string;
  projectId: string;
  /**
   * Joined from `project`. REQUIRED: run.project_id is NOT NULL, so every
   * read path can supply it and no consumer should have to check. The
   * worker's findByIdUnscoped pays one indexed foreign-key join it does not
   * read — cheaper than a second RunRecord shape, and far cheaper than an
   * optional-but-always-present field.
   */
  project: { id: string; slug: string; name: string };
  status: string;
  verdict: string | null;
  tool: string;
  toolVersion: string | null;
  /** Ingest metadata, frozen at accept time. Null when the caller sent none. */
  environment: string | null;
  branch: string | null;
  commitSha: string | null;
  /** The tool's own simulation identity and run description, from the run
   *  header. Null until the worker parses, and forever for a failed run. */
  simulation: string | null;
  description: string | null;
  /** The load test's own span in ms. Null until the worker parses. */
  durationMs: number | null;
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
  /**
   * The TOOL'S own assertions, decoded and re-evaluated — Appendix A G-05.
   *
   * NULL means the run predates the decoder: its definitions were discarded at
   * ingest and survive only inside the raw bundle. `[]` means the simulation
   * declared none. The two are different facts and the read path keeps them
   * apart rather than collapsing both to an empty table.
   */
  toolAssertions:
    | { expression: string; actualValue: number | null; outcome: string }[]
    | null;
}

export interface CreateRunInput {
  orgId: string;
  projectId: string;
  tool: string;
  environment?: string;
  branch?: string;
  commitSha?: string;
  bundleKey: string;
  bundleSha256: string;
  bundleBytes: number;
  idempotencyKey?: string;
  startedAt: Date;
  engineOptions: Record<string, unknown>;
}

/**
 * No bundleKey/bundleSha256/bundleBytes: a live run has none of those at
 * open time (see createLive). Otherwise the same frozen-at-submission fields
 * as CreateRunInput -- `tool` and `startedAt` are still required, for the
 * same reasons they are there: `tool` because Run.tool is non-null and the
 * caller (the validated OpenLiveRunRequestSchema) always has one, and
 * `startedAt` because startedOn is derived from it and cannot be derived
 * from nothing.
 */
export interface CreateLiveRunInput {
  orgId: string;
  projectId: string;
  tool: string;
  environment?: string;
  branch?: string;
  commitSha?: string;
  idempotencyKey?: string;
  startedAt: Date;
  engineOptions: Record<string, unknown>;
}

interface RunRow {
  id: string;
  orgId: string;
  projectId: string;
  project: { id: string; slug: string; name: string };
  status: string;
  verdict: string | null;
  tool: string;
  toolVersion: string | null;
  environment: string | null;
  branch: string | null;
  commitSha: string | null;
  simulation: string | null;
  description: string | null;
  durationMs: number | null;
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
  toolAssertions: unknown;
}

function toRecord(row: RunRow): RunRecord {
  return {
    id: row.id,
    orgId: row.orgId,
    projectId: row.projectId,
    project: { id: row.project.id, slug: row.project.slug, name: row.project.name },
    status: row.status,
    verdict: row.verdict,
    tool: row.tool,
    toolVersion: row.toolVersion,
    environment: row.environment,
    branch: row.branch,
    commitSha: row.commitSha,
    simulation: row.simulation,
    description: row.description,
    durationMs: row.durationMs,
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
    toolAssertions: (row.toolAssertions ?? null) as RunRecord['toolAssertions'],
  };
}

/**
 * The raw-SQL list's row shape. Flat project columns rather than RunRow's
 * nested object, because a SQL result set has no nesting — fromSqlRow below
 * is the one place that difference is reconciled.
 */
interface RunSqlRow extends Omit<RunRow, 'project'> {
  projectSlug: string;
  projectName: string;
}

function fromSqlRow(row: RunSqlRow): RunRecord {
  const { projectSlug, projectName, ...rest } = row;
  return toRecord({ ...rest, project: { id: row.projectId, slug: projectSlug, name: projectName } });
}

/** UTC date of the run start — the partition key. Derived, never supplied. */
function startedOnFrom(startedAt: Date): Date {
  return new Date(
    Date.UTC(startedAt.getUTCFullYear(), startedAt.getUTCMonth(), startedAt.getUTCDate()),
  );
}

/**
 * Robust to message-text changes in Prisma: keys on the stable error code.
 *
 * Replicated from apps/api/src/ingest/ingest.service.ts's private helper of
 * the same name rather than imported: apps/api depends on
 * packages/persistence, never the reverse, so importing it across that
 * boundary is not available. Same one-line check, kept in sync by hand.
 */
function isUniqueConstraintViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
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
        environment: input.environment ?? null,
        branch: input.branch ?? null,
        commitSha: input.commitSha ?? null,
        bundleKey: input.bundleKey,
        bundleSha256: input.bundleSha256,
        bundleBytes: BigInt(input.bundleBytes),
        idempotencyKey: input.idempotencyKey ?? null,
        startedAt: input.startedAt,
        startedOn: startedOnFrom(input.startedAt),
        engineOptions: input.engineOptions as object,
      },
      include: { project: true },
    });
    return toRecord(row);
  }

  /**
   * Opens a run that will be fed by a stream rather than a bundle upload.
   *
   * Mirrors create()'s freezing of environment/branch/commitSha/engineOptions
   * -- they describe the run as submitted, and submission is `open` for a
   * live run exactly as it is the POST for an uploaded one.
   *
   * bundleKey/bundleSha256/bundleBytes are NON-NULL columns (schema.prisma),
   * and RunRecord/RunRow/CreateRunInput all type them non-null too, so a
   * live run -- which has no bundle yet -- gets deterministic placeholders
   * here rather than a nullability migration that would ripple through all
   * three interfaces plus the raw SQL in list()/TRENDS_SQL:
   *   - bundleKey is the key close() (Task 9) will assemble the chunks
   *     into. Computing it needs the row's id before insert, so the id is
   *     generated here (randomUUID()) and passed in rather than left to the
   *     column default -- that avoids an insert-then-update.
   *   - bundleSha256: '' and bundleBytes: 0n are sentinels, not nulls.
   *     close() overwrites both once LiveChunkStore.finalize assembles the
   *     real bytes. This repo already places sentinel bundle values on runs
   *     with no real bundle (apps/web/e2e/fixtures.ts uses '0'.repeat(64) /
   *     BigInt(1)), and the only raw-pool reader of these columns is
   *     TRENDS_SQL, which filters status = 'complete' -- so a `running`
   *     row's placeholder sha is never read by it. A future consumer that
   *     treats '' as a real digest would still be misled; confined to rows
   *     that are `running`, and the nullability migration remains available
   *     if that ever matters enough to pay for.
   *
   * The idempotency check below is check-THEN-create, not a transaction, so
   * it is not by itself a race guard -- it only short-circuits the common
   * sequential case (a genuine retry, well after the original committed).
   * Two callers racing with the SAME key can both pass the check and both
   * reach create(): the (projectId, idempotencyKey) unique index still lets
   * only one of those inserts land, but the loser's create() throws P2002
   * instead of quietly losing. The catch below is what makes the whole
   * method idempotent under that concurrency rather than only under
   * sequential retries -- mirrors apps/api/src/ingest/ingest.service.ts's
   * accept(), which has the identical race on the bundle-upload path.
   */
  async createLive(input: CreateLiveRunInput): Promise<RunRecord> {
    const scope = { orgId: input.orgId, projectId: input.projectId };
    if (input.idempotencyKey) {
      const existing = await this.findByIdempotencyKey(scope, input.idempotencyKey);
      if (existing) return existing;
    }

    const id = randomUUID();
    try {
      const row = await this.prisma.run.create({
        data: {
          id,
          orgId: input.orgId,
          projectId: input.projectId,
          status: 'running',
          verdict: null,
          tool: input.tool,
          environment: input.environment ?? null,
          branch: input.branch ?? null,
          commitSha: input.commitSha ?? null,
          bundleKey: `runs/${id}/simulation.log`,
          bundleSha256: '',
          bundleBytes: 0n,
          streamOffset: 0n,
          idempotencyKey: input.idempotencyKey ?? null,
          startedAt: input.startedAt,
          startedOn: startedOnFrom(input.startedAt),
          engineOptions: input.engineOptions as object,
        },
        include: { project: true },
      });
      return toRecord(row);
    } catch (err) {
      // Lost a concurrent race against another createLive() call sharing
      // this idempotency key: the unique index rejected our insert after we
      // had already passed the sequential check above. The winner's row is
      // the one true answer -- behave exactly like the sequential-duplicate
      // path and hand it back rather than a 500. If the re-fetch somehow
      // finds nothing, this was not actually an idempotency-key race;
      // rethrow the original error rather than invent a result.
      if (input.idempotencyKey && isUniqueConstraintViolation(err)) {
        const winner = await this.findByIdempotencyKey(scope, input.idempotencyKey);
        if (winner) return winner;
      }
      throw err;
    }
  }

  /**
   * Compare-and-set on the byte cursor -- NOT check-then-act. `from` is a
   * WHERE-clause predicate, not a separate read, so the update and the
   * comparison happen in one round trip the database serializes: two
   * concurrent chunks both claiming to start at the same `from` cannot both
   * match, because the first one to commit moves streamOffset away from
   * `from` before the second's WHERE clause is evaluated. The loser's
   * updateMany matches zero rows and returns false, telling the caller to
   * resync rather than silently corrupting the stream.
   *
   * The same zero-match outcome is what makes a REPLAYED chunk (the agent
   * retrying a chunk the server already advanced past) a safe no-op: its
   * `from` no longer matches the row's current offset either, so it returns
   * false exactly like a genuine conflict does. The caller cannot tell the
   * two apart from the return value alone, and does not need to -- both
   * cases mean "the byte cursor did not move from where you think it is,
   * go find out where it really is."
   *
   * Also requires status: 'running' in the WHERE clause: once a run is
   * terminal (complete/failed/incomplete) its offset is frozen, so a
   * straggling chunk that arrives after close() must not resurrect it.
   */
  async advanceOffset(runId: string, from: number, to: number): Promise<boolean> {
    const { count } = await this.prisma.run.updateMany({
      where: { id: runId, status: 'running', streamOffset: BigInt(from) },
      data: { streamOffset: BigInt(to) },
    });
    return count === 1;
  }

  /**
   * Finalizes a live run that never reaches 'complete' -- inactivity, an
   * explicit abort, or a close() called before the producer says done.
   * verdict is always 'not_evaluated' (never 'passed'): a partial run can
   * satisfy every SLA rule purely by having stopped before the load that
   * would have broken it (design FR-LIVE-5), so reporting a pass would be a
   * false signal, not a cautious one.
   *
   * Guarded the same way fail() is: only writes when the run is not already
   * terminal, so a race with a genuine completion (or a duplicate
   * markIncomplete call) cannot regress an already-decided run back to
   * incomplete.
   */
  async markIncomplete(runId: string): Promise<void> {
    await this.prisma.run.updateMany({
      where: { id: runId, status: { notIn: ['complete', 'failed', 'incomplete'] } },
      data: { status: 'incomplete', verdict: 'not_evaluated', ingestedAt: new Date() },
    });
  }

  /**
   * A live run's status and byte cursor, read together -- not part of
   * RunRecord (no existing reader needs stream_offset, so it was never
   * added to that shape; see toRecord()/RunRow above). stream() reads both
   * to tell a gap from a replay from a not-running run BEFORE it writes
   * anything; close() reads the cursor (after claimForClose below has
   * already made it safe to) to decide zero-byte-vs-real-data. Read in
   * ONE query rather than two separate ones: status and streamOffset are
   * two columns on the same row, and reading them apart would let one
   * change land between the reads, making the pair inconsistent with
   * itself at the exact moment the caller most needs them to agree.
   */
  async liveState(runId: string): Promise<{ status: string; streamOffset: number } | null> {
    const row = await this.prisma.run.findUnique({
      where: { id: runId },
      select: { status: true, streamOffset: true },
    });
    return row ? { status: row.status, streamOffset: Number(row.streamOffset) } : null;
  }

  /**
   * Claims a live run for closing: the FIRST write close() makes, before
   * it decides anything else. Moving 'running' -> 'parsing' here (rather
   * than after finalizing, as an earlier version of this did) closes the
   * exact window a stray stream() chunk could otherwise land in between
   * LiveChunkStore.finalize assembling the log and the write that used to
   * record the decision: once status leaves 'running', advanceOffset's own
   * WHERE clause rejects every further chunk -- gap, replay, or otherwise
   * -- the same way it rejects one arriving after any other terminal
   * state. It is also what makes two concurrent close() calls for the
   * same run resolve safely: only one `updateMany` here can match, so only
   * one caller proceeds past this point, and it needs no separate status
   * read beforehand -- the attempt itself is the read.
   *
   * markIncomplete (above) accepts a run in 'parsing', not only 'running'
   * (`status: { notIn: ['complete', 'failed', 'incomplete'] }`), so a
   * zero-byte close can still land there after this claim succeeds --
   * closing that same window for the zero-byte case too: reading the
   * cursor used to happen before any write existed to freeze it, so a byte
   * arriving in that gap could get marked `incomplete` out from under it.
   *
   * Returns whether THIS call won the claim. `false` means the run was not
   * 'running' at the moment of the attempt -- already closed by a
   * concurrent caller, or never a live run at all; the caller reports that
   * as "not running", never "not found" (existence is confirmed separately,
   * by the findById a tenant-scoped caller already had to do to reach a
   * run id at all).
   *
   * Sets parsingStartedAt (see the field's own docstring on Run above) to
   * NOW, not left null: the sweeper's 'parsing' staleness check reads it,
   * falling back to createdAt (this run's OPEN time) only when null.
   * Without this, a live run streaming for longer than parsingStaleAfterMs
   * before it is closed -- the ordinary case for the soak tests this
   * feature exists for -- would already read as stale the instant this
   * claim lands, and the sweeper could re-enqueue it while close() is still
   * assembling the log, mid-`Promise.all` over a multi-thousand-object
   * live-chunk prefix.
   */
  async claimForClose(runId: string): Promise<boolean> {
    const { count } = await this.prisma.run.updateMany({
      where: { id: runId, status: 'running' },
      data: { status: 'parsing', parsingStartedAt: new Date() },
    });
    return count > 0;
  }

  /**
   * Fills the bundleSha256/bundleBytes placeholders createLive left blank
   * (see that method's docstring), once close() has assembled the real
   * bytes. Only reachable after claimForClose has already won this run's
   * 'running' -> 'parsing' transition, so nothing else can be racing this
   * row at this point -- the `status: 'parsing'` guard here is defensive
   * (mirrors every other guarded write in this class), not load-bearing
   * the way claimForClose's own guard is.
   */
  async finalizeLive(runId: string, bundleSha256: string, bundleBytes: number): Promise<void> {
    await this.prisma.run.updateMany({
      where: { id: runId, status: 'parsing' },
      data: { bundleSha256, bundleBytes: BigInt(bundleBytes) },
    });
  }

  /**
   * Undoes claimForClose after a close() attempt fails partway through --
   * the only way a 'parsing' row claimForClose created can move back to
   * 'running'. Without this, a transient failure in the middle of
   * LiveChunkStore.finalize's multi-thousand-object assembly (or the
   * blobs.get that reads the result back to hash it) would strand the run
   * at 'parsing' with bundleSha256 still '' forever: every retried close()
   * would 409 RUN_NOT_RUNNING, since claimForClose can never re-match a row
   * that is not 'running'. Pre-claimForClose, the same failure left the run
   * 'running' and a retry worked, because LiveChunkStore.finalize is itself
   * idempotent (its own exists(key) guard) -- this restores that property.
   *
   * Guarded on status: 'parsing' so this can never resurrect a run a
   * DIFFERENT process has already moved past that point (a real ingest job
   * that raced in and completed or failed it first) -- releaseClose then
   * does nothing, and whatever actually decided the run's fate stands.
   *
   * Clears parsingStartedAt back to null: the parsing attempt it described
   * did not survive, so it must not linger as a stale reading against
   * whatever happens next (another close() attempt, or nothing at all).
   */
  async releaseClose(runId: string): Promise<void> {
    await this.prisma.run.updateMany({
      where: { id: runId, status: 'parsing' },
      data: { status: 'running', parsingStartedAt: null },
    });
  }

  async findById(scope: TenantScope, id: string): Promise<RunRecord | null> {
    const row = await this.prisma.run.findFirst({
      where: {
        id,
        orgId: scope.orgId,
        ...(scope.projectId ? { projectId: scope.projectId } : {}),
      },
      include: { project: true },
    });
    return row ? toRecord(row) : null;
  }

  /** Unscoped by design: the worker holds a job, not a caller's credential. */
  async findByIdUnscoped(id: string): Promise<RunRecord | null> {
    const row = await this.prisma.run.findUnique({ where: { id }, include: { project: true } });
    return row ? toRecord(row) : null;
  }

  async findByIdempotencyKey(scope: ProjectScope, key: string): Promise<RunRecord | null> {
    const row = await this.prisma.run.findFirst({
      where: { orgId: scope.orgId, projectId: scope.projectId, idempotencyKey: key },
      include: { project: true },
    });
    return row ? toRecord(row) : null;
  }

  /**
   * Unscoped by design: the worker, acting on a job it has already dequeued.
   *
   * Sets parsingStartedAt alongside status, same as claimForClose does for
   * the live-close path -- the sweeper's staleness check reads that column
   * for every route into 'parsing', not just this one.
   */
  async markParsing(id: string): Promise<void> {
    await this.prisma.run.update({
      where: { id },
      data: { status: 'parsing', parsingStartedAt: new Date() },
    });
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
        where: {
          id: opts.cursor,
          orgId: scope.orgId,
          ...(scope.projectId ? { projectId: scope.projectId } : {}),
        },
        select: { id: true, startedAt: true, toolStartedAt: true },
      });
      // A cursor that no longer resolves (wrong tenant, deleted row) yields
      // an empty page rather than reinterpreting it as "start from the top"
      // — silently restarting pagination would resurface items the caller
      // already saw.
      if (!cursorRun) return { items: [], nextCursor: null };
      cursorKey = { effective: cursorRun.toolStartedAt ?? cursorRun.startedAt, id: cursorRun.id };
    }

    const rows = await this.prisma.$queryRaw<RunSqlRow[]>`
      SELECT
        r.id, r.org_id AS "orgId", r.project_id AS "projectId", r.status, r.verdict, r.tool,
        r.tool_version AS "toolVersion", r.environment, r.branch, r.commit_sha AS "commitSha",
        r.simulation, r.description,
        r.duration_ms AS "durationMs", r.bundle_key AS "bundleKey",
        r.bundle_sha256 AS "bundleSha256", r.bundle_bytes AS "bundleBytes",
        r.idempotency_key AS "idempotencyKey", r.started_at AS "startedAt",
        r.started_on AS "startedOn", r.tool_started_at AS "toolStartedAt",
        r.ingested_at AS "ingestedAt", r.engine_options AS "engineOptions", r.error,
        r.tool_assertions AS "toolAssertions",
        p.slug AS "projectSlug", p.name AS "projectName"
      FROM run r
      JOIN project p ON p.id = r.project_id
      WHERE r.org_id = ${scope.orgId}::uuid
      ${scope.projectId ? Prisma.sql`AND r.project_id = ${scope.projectId}::uuid` : Prisma.empty}
      ${
        cursorKey
          ? Prisma.sql`AND (COALESCE(r.tool_started_at, r.started_at), r.id) < (${cursorKey.effective}::timestamp(3), ${cursorKey.id}::uuid)`
          : Prisma.empty
      }
      ORDER BY COALESCE(r.tool_started_at, r.started_at) DESC, r.id DESC
      LIMIT ${opts.limit + 1}
    `;
    const page = rows.slice(0, opts.limit);
    const next = rows.length > opts.limit ? (page[page.length - 1]?.id ?? null) : null;
    return { items: page.map(fromSqlRow), nextCursor: next };
  }
}
