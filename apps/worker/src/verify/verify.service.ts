import type { BundleSource, CanonicalEvent } from '@perfportal/core';
import {
  ProjectRepository,
  readStoredFigures,
  RunRepository,
  VerificationRepository,
  type RunRecord,
  type StoredFigures,
  type UnverifiableReason,
} from '@perfportal/persistence';
import type { BlobStore } from '@perfportal/storage';
import { compare, expectedFrom, optionsFrom, VERIFIER_VERSION, type Stored } from '@perfportal/verify';
import type { PrismaClient } from '@prisma/client';
import type pg from 'pg';
import type { WorkerConfig } from '../config.js';
import { holdClient } from '../held-client.js';
import { RUN_INGEST_LOCK_NAMESPACE } from '../pipeline/pipeline.service.js';
import { selectPlugin } from '../pipeline/plugins.js';
import { isTransient } from '../pipeline/retry.js';
import { openRunSource, RawLogMissingError } from '../pipeline/run-source.js';

/**
 * What one verification did. `locked` asks the caller to try again later;
 * `verified`, `mismatch` and the four `UnverifiableReason` words were
 * recorded on the run's verification row; `gone` and `not_eligible` need
 * nothing further.
 */
export type VerifyOutcome = 'verified' | 'mismatch' | 'locked' | 'gone' | 'not_eligible' | UnverifiableReason;

/**
 * The run's statistics were not all written by the exact engine: labelled
 * estimated, or carrying a stat row in an older format (a sketch, or a
 * histogram kind before sparse-ms-v2) — the same per-row test the recompute
 * selection makes. Such a run cannot be held to the raw log figure for
 * figure; checking it would report a flood of mismatches that say only
 * "estimated", which PR 2 already says.
 *
 * Reads the run as r. No backticks in here: it is interpolated into a
 * template literal, and one of those ends the string.
 */
const NOT_EXACT_SQL = `
  SELECT r.stats_method = 'estimated'
      OR EXISTS (SELECT 1 FROM run_stat s
                  WHERE s.run_id = r.id
                    AND (s.sketch IS NOT NULL OR s.histogram_kind IS DISTINCT FROM 'sparse-ms-v2')) AS not_exact,
         EXISTS (SELECT 1 FROM run_stat s WHERE s.run_id = r.id) AS has_stats
    FROM run r WHERE r.id = $1::uuid`;

/**
 * ═══ ONE RUN, CHECKED FIGURE BY FIGURE AGAINST ITS OWN RAW LOG ═══
 *
 * Re-reads the bytes the run was ingested from, decodes them with the shared
 * decoder, and has `packages/verify` — an implementation that shares no code
 * with the engine that wrote the rows — say what every stored figure should
 * be. The answer is recorded on `run_verification`; nothing about the run
 * itself is changed.
 */
export class VerifyService {
  constructor(
    private readonly config: WorkerConfig,
    private readonly prisma: PrismaClient,
    private readonly pool: pg.Pool,
    private readonly blobs: BlobStore,
  ) {}

  /**
   * ═══ UNDER THE RUN LOCK, FOR THE WHOLE READ ═══
   *
   * The same advisory lock `PipelineService.process`, the recompute and the
   * live fold owner take, held from before the log is opened until after the
   * stored rows are read. A writer rewriting the run (a re-ingest, a
   * recompute) therefore lands wholly before or wholly after this check,
   * never between the log and the rows — which is the only way a correct run
   * could read as a mismatch. A try-lock: a run somebody else holds is
   * `locked`, and the queue asks again later.
   */
  async verify(runId: string): Promise<VerifyOutcome> {
    // HELD, for the reason `PipelineService.process` gives: a connection that
    // dies while checked out emits an `error` nothing else listens for.
    const held = holdClient(await this.pool.connect());
    const client = held.client;
    let broken: Error | undefined;
    try {
      const { rows } = await client.query<{ got: boolean }>(
        'SELECT pg_try_advisory_lock($1, hashtext($2)) AS got',
        [RUN_INGEST_LOCK_NAMESPACE, runId],
      );
      if (!rows[0]?.got) return 'locked';
      try {
        return await this.#verifyHoldingLock(runId);
      } finally {
        // An unlock that fails must not replace the error that brought this
        // here; releasing WITH it makes the pool destroy the client, and the
        // lock with its session (the recompute's own finally).
        try {
          await client.query('SELECT pg_advisory_unlock($1, hashtext($2))', [RUN_INGEST_LOCK_NAMESPACE, runId]);
        } catch (err) {
          broken = err instanceof Error ? err : new Error(String(err));
        }
      }
    } finally {
      held.release(broken);
    }
  }

  async #verifyHoldingLock(runId: string): Promise<VerifyOutcome> {
    const run = await new RunRepository(this.prisma).findByIdUnscoped(runId);
    if (!run) return 'gone';
    if (run.status !== 'complete' && run.status !== 'incomplete') return 'not_eligible';

    const { rows } = await this.pool.query<{ not_exact: boolean; has_stats: boolean }>(NOT_EXACT_SQL, [runId]);
    if (!rows[0]?.has_stats) return 'not_eligible';

    const verifications = new VerificationRepository(this.pool);
    const unverifiable = async (reason: UnverifiableReason): Promise<VerifyOutcome> => {
      await verifications.markUnverifiable(runId, reason, VERIFIER_VERSION);
      return reason;
    };

    // Before the log is even opened: an estimated run cannot be checked, and
    // must not be reported as one with mismatches.
    if (rows[0].not_exact) return unverifiable('not_exact');

    if (run.rawLogDeletedAt !== null) {
      // ═══ AN OUTCOME DECIDED WHILE THE LOG EXISTED STANDS ═══
      //
      // markRawLogDeleted's rule: a run already verified (or found to
      // mismatch) keeps that answer, because it was settled against the very
      // log that is now gone. Only a run never checked becomes unverifiable.
      const existing = await verifications.find(runId);
      if (existing !== null && existing.status !== 'pending') return 'raw_log_deleted';
      return unverifiable('raw_log_deleted');
    }

    let source: BundleSource;
    try {
      source = await openRunSource(run, { blobs: this.blobs, maxTotalBytes: await this.#maxTotalBytes(run) });
    } catch (err) {
      const reason = sourceFailure(err);
      if (reason === null) throw err;
      return unverifiable(reason);
    }

    let events: CanonicalEvent[];
    try {
      const { plugin } = await selectPlugin(source.index);
      events = [];
      for await (const e of plugin.parse(source)) events.push(e);
    } catch (err) {
      // The bytes are in memory by now; a transport failure reported here is
      // still not a fact about the log.
      if (isTransient(err)) throw err;
      return unverifiable('raw_log_unreadable');
    }

    // The run header carries the instant every offset is measured from. A log
    // without one cannot be placed in time, so nothing in it can be checked.
    const meta = events.find((e) => e.type === 'meta');
    if (meta === undefined || meta.type !== 'meta') return unverifiable('raw_log_unreadable');

    const expected = expectedFrom(events, optionsFrom(run.engineOptions, meta.startedAtMs));
    const stored = toStored(await readStoredFigures(this.pool, runId, run.startedOn));
    const { figuresChecked, mismatches } = compare(expected, stored);

    const status = mismatches.length === 0 ? 'verified' : 'mismatch';
    await verifications.record(runId, {
      status,
      verifierVersion: VERIFIER_VERSION,
      figuresChecked,
      mismatches,
      rawLogRetainedUntil: retainedUntil(run, this.config.rawLogRetentionDays),
    });
    if (status === 'mismatch') {
      // ONE line: the list is on the row, and the Data integrity page shows it.
      console.error(
        `verify: run ${runId} has ${mismatches.length} mismatch${mismatches.length === 1 ? '' : 'es'} against its raw log`,
      );
    }
    return status;
  }

  /**
   * The larger of the project's limit and the worker's — the recompute's rule
   * and its reason: a project limit lowered since ingest would refuse an
   * archive that opened perfectly, and that is about a setting, not the log.
   */
  async #maxTotalBytes(run: RunRecord): Promise<number> {
    const project = await new ProjectRepository(this.prisma).byId(run.projectId);
    const projectLimit = project?.settings.maxDecompressedBundleBytes;
    return Math.max(
      typeof projectLimit === 'number' && Number.isFinite(projectLimit) ? projectLimit : 0,
      this.config.maxDecompressedBundleBytes,
    );
  }
}

/**
 * What a failure to OPEN the stored log says about the run, or null when it
 * says nothing and must be rethrown — the recompute's classification
 * (`recompute.service.ts`'s `sourceFailure`), in the verifier's words: a
 * missing log is `raw_log_missing`; a checksum mismatch or an archive that
 * will not open is `raw_log_unreadable`; `BUNDLE_TOO_LARGE` is the
 * deployment's limit speaking and is rethrown, as is anything else (the
 * object store failing to answer is not a fact about the run).
 */
function sourceFailure(err: unknown): UnverifiableReason | null {
  if (err instanceof RawLogMissingError) return 'raw_log_missing';
  if (err instanceof Error && err.name === 'IngestError') {
    const code = (err as { code?: unknown }).code;
    if (code === 'BUNDLE_TOO_LARGE') return null;
    return 'raw_log_unreadable';
  }
  return null;
}

/**
 * The ingest's UTC calendar day plus the retention, as the UTC midnight that
 * starts that day; null when raw logs are kept for ever. `ingested_at` is the
 * retention clock (`retentionDue` reads the same column), and every terminal
 * writer stamps it — `now` stands in only for a row somehow missing it.
 */
function retainedUntil(run: RunRecord, days: number): Date | null {
  if (days === 0) return null;
  const ingested = run.ingestedAt ?? new Date();
  return new Date(Date.UTC(ingested.getUTCFullYear(), ingested.getUTCMonth(), ingested.getUTCDate() + days));
}

/**
 * Persistence's read, in the verifier's vocabulary. Field for field: two
 * lists are named differently there (`seriesBuckets`, `userBuckets`), and
 * nullable series columns stay null so a legacy row is compared, not
 * skipped. Every numeric column here is an int4 or a float8, which
 * node-postgres hands back as a number; a bigint or numeric would arrive as a
 * string and fail every exact comparison, which is why none is used.
 *
 * The two run spans are nullable in the table and not in the verifier: a null
 * is passed as NaN, which equals nothing, so it is reported as a mismatch
 * (stored as null once serialised) rather than silently skipped.
 */
function toStored(f: StoredFigures): Stored {
  return {
    stats: f.stats.map((s) => ({
      scope: s.scope,
      name: s.name,
      family: s.family,
      count: s.count,
      okCount: s.okCount,
      koCount: s.koCount,
      errorRate: s.errorRate,
      minMs: s.minMs,
      maxMs: s.maxMs,
      meanMs: s.meanMs,
      stddevMs: s.stddevMs,
      throughputRps: s.throughputRps,
      percentiles: s.percentiles,
    })),
    series: f.seriesBuckets.map((b) => ({
      scope: b.scope,
      name: b.name,
      family: b.family,
      startOffsetMs: b.startOffsetMs,
      startedCount: b.startedCount,
      endedCount: b.endedCount,
      okCount: b.okCount,
      koCount: b.koCount,
      startedOkCount: b.startedOkCount,
      startedKoCount: b.startedKoCount,
      minMs: b.minMs,
      maxMs: b.maxMs,
      meanMs: b.meanMs,
      percentiles: b.percentiles,
      percentilesOk: b.percentilesOk,
      percentilesKo: b.percentilesKo,
    })),
    errors: f.errors.map((e) => ({ scope: e.scope, name: e.name, message: e.message, isOther: e.isOther, count: e.count })),
    errorBuckets: f.errorBuckets.map((e) => ({
      startOffsetMs: e.startOffsetMs,
      message: e.message,
      isOther: e.isOther,
      count: e.count,
      bucketWidthMs: e.bucketWidthMs,
    })),
    users: f.userBuckets.map((u) => ({
      scenario: u.scenario,
      startOffsetMs: u.startOffsetMs,
      started: u.started,
      ended: u.ended,
      maxConcurrent: u.maxConcurrent,
    })),
    run: { durationMs: f.run.durationMs ?? Number.NaN, activityMs: f.run.activityMs ?? Number.NaN },
  };
}
