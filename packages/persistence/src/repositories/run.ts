import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { RunStatus, RunVerdict } from '@perfportal/contracts';
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
  /**
   * The test this is a run OF, joined for the same reason `project` is: every
   * caller that has a run wants to name what it was a run of, and the
   * alternative is a second query at every one of those call sites.
   *
   * NULL is a real state, not a missing join — see the `Test` model. A run is
   * without one while it is pending, forever if its bundle never parsed, and
   * for any row that predates the worker recording a simulation.
   */
  test: { id: string; slug: string; name: string } | null;
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
  activityMs: number | null;
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
  /** The joined `test`, or null — see `RunRecord.test`. */
  test?: { id: string; slug: string; name: string } | null;
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
  activityMs: number | null;
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
    test:
      row.test === null || row.test === undefined
        ? null
        : { id: row.test.id, slug: row.test.slug, name: row.test.name },
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
    activityMs: row.activityMs,
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
interface RunSqlRow extends Omit<RunRow, 'project' | 'test'> {
  projectSlug: string;
  projectName: string;
  /**
   * The list joins `test` for its NAME, not just its id: a run row that could
   * not say what test it was of would send every caller back for one query per
   * row. Flat, like the project columns beside it, for the reason this file's
   * header gives — a SQL result set has no nesting.
   *
   * Null for a run with no test, which is a real state rather than a missing
   * join. See the `Test` model.
   */
  testId: string | null;
  testSlug: string | null;
  testName: string | null;
}

/** A verdict filter, plus the one value that is the ABSENCE of a verdict. */
export type RunVerdictFilter = RunVerdict | 'none';

/**
 * TYPED, NOT `string`. These reach `list()`'s raw SQL as bound parameters,
 * so a bad value cannot inject — but it can silently return an empty page
 * that reads as "no such runs", which is why the API validates them
 * (`parseRunListFilters`) and answers 400 `RUN_FILTER_INVALID` instead.
 * Declaring them as plain strings here made that guard the only thing
 * standing between a typo and a wrong answer, with nothing in the type
 * system agreeing.
 */
export interface RunListOptions {
  readonly limit: number;
  readonly cursor?: string;
  readonly status?: RunStatus;
  readonly verdict?: RunVerdictFilter;
  readonly q?: string;
  /**
   * Narrow to one test's runs. A UUID, not a slug: a slug is unique per
   * PROJECT, so resolving it needs the project, and the API has already done
   * that by the time it gets here — passing the slug down would make this
   * repository resolve it a second time or take a project it does not need.
   *
   * A run with `test_id IS NULL` — still pending, never parsed — matches no
   * value of this, which is correct: it is not a run of any test yet.
   */
  readonly testId?: string;
}

function fromSqlRow(row: RunSqlRow): RunRecord {
  const { projectSlug, projectName, testId, testSlug, testName, ...rest } = row;
  return toRecord({
    ...rest,
    project: { id: row.projectId, slug: projectSlug, name: projectName },
    // All three or none: the LEFT JOIN either matched a test or it did not,
    // and a half-populated triple would be a bug in the query rather than a
    // state to represent.
    test:
      testId === null || testSlug === null || testName === null
        ? null
        : { id: testId, slug: testSlug, name: testName },
  });
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
  return typeof err === 'object' && err !== null && 'code' in err && err.code === 'P2002';
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

/**
 * A query that could be the start of a run id, as a `[low, high]` uuid pair —
 * or null when it could not be one.
 *
 * THE ID IS A RANGE ON THE PRIMARY KEY, NOT A PATTERN ON ITS TEXT. Two
 * separate problems pushed it here.
 *
 * The first was correctness: `r.id::text ILIKE '%3%'` matches almost every
 * uuid ever generated, so folding the id into a contains-anywhere search made
 * every short query return the whole org.
 *
 * The second is that `r.id::text ILIKE 'prefix%'` is not indexable either —
 * the cast alone defeats the primary key, and in an OR that matters far more
 * than it looks: PostgreSQL can only BitmapOr branches it can index, so ONE
 * unindexable branch forces a sequential scan of the WHOLE predicate,
 * including the six trigram-indexed columns beside it. Widening the prefix to
 * a uuid range compares `uuid` to `uuid` and lands on `run_pkey`.
 *
 * Dashes are cosmetic in a uuid's text form, so they are stripped and the
 * remaining hex is padded with `0` for the low bound and `f` for the high
 * one: `19c46616-c525` becomes `19c46616-c525-0000-0000-000000000000` through
 * `19c46616-c525-ffff-ffff-ffffffffffff`. Four hex digits is the shortest
 * thing that cannot also be an ordinary word — and it is what the UI puts on
 * screen to copy, since `RunList` renders `id.slice(0, 8)` for a run with no
 * simulation name yet.
 */
function runIdPrefixRange(query: string): { low: string; high: string } | null {
  const hex = query.replace(/-/g, '');
  if (hex.length < 4 || hex.length > 32 || !/^[0-9a-f]+$/i.test(hex)) return null;
  const lower = hex.toLowerCase();
  return { low: asUuid(lower.padEnd(32, '0')), high: asUuid(lower.padEnd(32, 'f')) };
}

/** 32 hex characters, dashed into the 8-4-4-4-12 form Postgres parses. */
function asUuid(hex32: string): string {
  return (
    `${hex32.slice(0, 8)}-${hex32.slice(8, 12)}-${hex32.slice(12, 16)}-` +
    `${hex32.slice(16, 20)}-${hex32.slice(20)}`
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
      include: { project: true, test: true },
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
        include: { project: true, test: true },
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
   *
   * Stamps streamUpdatedAt in the same statement (see that field's
   * docstring on Run). This is the ONLY writer of the column the sweeper
   * measures 'running' staleness from -- a live producer's only observable
   * sign of life is bytes landing, and this is where that happens. It costs
   * nothing: this row is already being written, so the column rides along
   * in an UPDATE that was happening anyway. Written only on the branch that
   * actually MOVED the cursor, never on the replay/lost-race path above it
   * in stream(), which does not reach this method at all -- a replay is
   * proof the agent is alive but not proof it is making progress, and a
   * stuck agent retrying one chunk forever must still age out.
   */
  async advanceOffset(runId: string, from: number, to: number): Promise<boolean> {
    const { count } = await this.prisma.run.updateMany({
      where: { id: runId, status: 'running', streamOffset: BigInt(from) },
      data: { streamOffset: BigInt(to), streamUpdatedAt: new Date() },
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
      include: { project: true, test: true },
    });
    return row ? toRecord(row) : null;
  }

  /** Unscoped by design: the worker holds a job, not a caller's credential. */
  async findByIdUnscoped(id: string): Promise<RunRecord | null> {
    const row = await this.prisma.run.findUnique({ where: { id }, include: { project: true, test: true } });
    return row ? toRecord(row) : null;
  }

  async findByIdempotencyKey(scope: ProjectScope, key: string): Promise<RunRecord | null> {
    const row = await this.prisma.run.findFirst({
      where: { orgId: scope.orgId, projectId: scope.projectId, idempotencyKey: key },
      include: { project: true, test: true },
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
   * The org's projects whose slug or name matches a free-text search, as ids.
   *
   * A SEPARATE QUERY ON PURPOSE — see the `opts.q` block in `list()` for the
   * whole argument. In short: a joined column cannot take part in a
   * BitmapOr, so matching the project inside the run query's own OR would
   * cost every other branch its index. This one is itself indexed, by
   * `project_slug_trgm` / `project_name_trgm`.
   *
   * Unbounded by design. It returns ids within ONE org, so its size is that
   * tenant's project count; a cap here would silently drop matching runs from
   * a page that claims to be the whole answer, which is the failure mode the
   * search's own docstring in the API exists to avoid.
   */
  private async projectIdsMatching(orgId: string, like: string): Promise<string[]> {
    const rows = await this.prisma.$queryRawUnsafe<{ id: string }[]>(
      `SELECT id FROM project
        WHERE org_id = $1::uuid
          AND (slug ILIKE $2 ESCAPE '\\' OR name ILIKE $2 ESCAPE '\\')`,
      orgId,
      like,
    );
    return rows.map((row) => row.id);
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
    opts: RunListOptions,
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

    const filters: string[] = ['r.org_id = $1::uuid'];
    const params: unknown[] = [scope.orgId];
    if (scope.projectId) {
      params.push(scope.projectId);
      filters.push(`r.project_id = $${params.length}::uuid`);
    }
    if (cursorKey) {
      params.push(cursorKey.effective, cursorKey.id);
      filters.push(
        `(COALESCE(r.tool_started_at, r.started_at), r.id) < ` +
          `($${params.length - 1}::timestamptz(3), $${params.length}::uuid)`,
      );
    }
    if (opts.testId) {
      params.push(opts.testId);
      filters.push(`r.test_id = $${params.length}::uuid`);
    }
    if (opts.status) {
      params.push(opts.status);
      filters.push(`r.status = $${params.length}`);
    }
    if (opts.verdict) {
      if (opts.verdict === 'none') {
        filters.push('r.verdict IS NULL');
      } else {
        params.push(opts.verdict);
        filters.push(`r.verdict = $${params.length}`);
      }
    }
    // FREE TEXT OVER THE RUN'S OWN WORDS, plus the id AS A KEY RANGE.
    //
    // ONE TABLE'S COLUMNS, SO THE WHOLE `OR` CAN BE A BitmapOr.
    //
    // PostgreSQL can only combine an OR into a bitmap while it can index
    // EVERY branch — and a branch on a JOINED table is not one it can index
    // at all. Spelling the project match as `p.slug ILIKE …` therefore cost
    // the six run columns beside it their indexes too: measured on the real
    // table, the cross-table version plans as a nested loop filtering every
    // run in the org, while the shape below plans as a BitmapOr over
    // `run_project_id_started_at_idx` and one trigram index per column.
    //
    // So the projects are resolved FIRST, by their own trigram indexes, and
    // arrive here as an id array. The result set is identical — a run whose
    // project matches is exactly a run whose `project_id` is in that list —
    // and it costs one small indexed query, only when `q` is present.
    //
    // IT RUNS FOR A PROJECT-SCOPED CALLER TOO, and skipping it there was a
    // real bug, caught by searching a live token's own project by name. The
    // reasoning for skipping sounded right — an `r.project_id = $n` filter is
    // ANDed above, so no OTHER project's runs can enter the page however the
    // name matches — but it answers the wrong question. When the caller's OWN
    // project is what matches, every row in scope should match and the branch
    // is the only thing that says so. Without it, a token scoped to
    // `parity-run-c6bcd6a5` searching `parity-run` got zero runs while the
    // org-scoped session got both.
    //
    // NO `COALESCE(col, '')`, AND ITS ABSENCE IS LOAD-BEARING. It was there
    // to make a null column compare as an empty string, which reads as
    // defensive and is in fact a no-op: `NULL ILIKE '%x%'` is NULL, and NULL
    // in a positive OR is indistinguishable from false to a WHERE clause. It
    // was not free, though — wrapping the column in an expression put it out
    // of reach of a plain-column index, so all five nullable columns fell
    // back to a sequential scan. Measured: bare columns plan as a BitmapOr
    // over trigram index scans, the same predicate with COALESCE plans as
    // `Seq Scan on run`.
    if (opts.q) {
      const like = `%${escapeLike(opts.q)}%`;
      params.push(like);
      const at = `$${params.length}`;
      const clauses = [
        `r.simulation ILIKE ${at} ESCAPE '\\'`,
        `r.description ILIKE ${at} ESCAPE '\\'`,
        `r.environment ILIKE ${at} ESCAPE '\\'`,
        `r.branch ILIKE ${at} ESCAPE '\\'`,
        `r.commit_sha ILIKE ${at} ESCAPE '\\'`,
      ];

      const matched = await this.projectIdsMatching(scope.orgId, like);
      if (matched.length > 0) {
        params.push(matched);
        clauses.push(`r.project_id = ANY($${params.length}::uuid[])`);
      }

      const range = runIdPrefixRange(opts.q);
      if (range) {
        params.push(range.low, range.high);
        clauses.push(
          `r.id BETWEEN $${params.length - 1}::uuid AND $${params.length}::uuid`,
        );
      }
      filters.push(`(${clauses.join(' OR ')})`);
    }
    params.push(opts.limit + 1);

    const rows = await this.prisma.$queryRawUnsafe(
      `
      SELECT
        r.id, r.org_id AS "orgId", r.project_id AS "projectId", r.status, r.verdict, r.tool,
        r.tool_version AS "toolVersion", r.environment, r.branch, r.commit_sha AS "commitSha",
        r.simulation, r.description,
        r.duration_ms AS "durationMs", r.activity_ms AS "activityMs", r.bundle_key AS "bundleKey",
        r.bundle_sha256 AS "bundleSha256", r.bundle_bytes AS "bundleBytes",
        r.idempotency_key AS "idempotencyKey", r.started_at AS "startedAt",
        r.started_on AS "startedOn", r.tool_started_at AS "toolStartedAt",
        r.ingested_at AS "ingestedAt", r.engine_options AS "engineOptions", r.error,
        r.tool_assertions AS "toolAssertions",
        p.slug AS "projectSlug", p.name AS "projectName",
        t.id AS "testId", t.slug AS "testSlug", t.name AS "testName"
      FROM run r
      JOIN project p ON p.id = r.project_id
      -- LEFT, and that is the whole point: a run with no test is an ordinary
      -- run — still pending, or a bundle that never parsed — and an inner join
      -- would drop it out of the list it belongs in.
      LEFT JOIN test t ON t.id = r.test_id
      WHERE ${filters.join(' AND ')}
      ORDER BY COALESCE(r.tool_started_at, r.started_at) DESC, r.id DESC
      LIMIT $${params.length}
      `,
      ...params,
    ) as RunSqlRow[];
    const page = rows.slice(0, opts.limit);
    const next = rows.length > opts.limit ? (page[page.length - 1]?.id ?? null) : null;
    return { items: page.map(fromSqlRow), nextCursor: next };
  }
}
