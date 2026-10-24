import { GatlingDifferenceSchema, type GatlingDifference } from '@perfportal/contracts';
import { retainedUntil, type BundleSource, type CanonicalEvent } from '@perfportal/core';
import {
  NOT_EXACT_RUN_SQL,
  ProjectRepository,
  readStoredAgentFigures,
  readStoredFigures,
  RunRepository,
  VerificationRepository,
  type RunRecord,
  type StoredAgentFigures,
  type StoredFigures,
  type UnverifiableReason,
} from '@perfportal/persistence';
import { decodeAgentFile, type AgentFile } from '@perfportal/plugin-gatling';
import type { BlobStore } from '@perfportal/storage';
import {
  BASE_WIDTH_MS,
  compare,
  expectedAgent,
  expectedFrom,
  gatlingDifferences,
  gatlingMethodInput,
  gatlingMethodLines,
  optionsFrom,
  runSeriesWidth,
  VERIFIER_VERSION,
  type Stored,
  type StoredAgent,
} from '@perfportal/verify';
import type { PrismaClient } from '@prisma/client';
import type pg from 'pg';
import type { WorkerConfig } from '../config.js';
import { holdClient } from '../held-client.js';
import { openAgentSource } from '../pipeline/agent-source.js';
import { RUN_INGEST_LOCK_NAMESPACE } from '../pipeline/pipeline.service.js';
import { selectPlugin } from '../pipeline/plugins.js';
import { isTransient } from '../pipeline/retry.js';
import { openRunSource, RawLogMissingError } from '../pipeline/run-source.js';
import type { GatlingMethodRunner } from './gatling-method-runner.js';

/**
 * What one verification did. `locked` asks the caller to try again later;
 * `verified`, `mismatch` and the four `UnverifiableReason` words were
 * recorded on the run's verification row; `gone` and `not_eligible` need
 * nothing further.
 */
export type VerifyOutcome = 'verified' | 'mismatch' | 'locked' | 'gone' | 'not_eligible' | UnverifiableReason;

/**
 * Whether the run's statistics were all written by the exact engine, by
 * persistence's ONE definition (NOT_EXACT_RUN_SQL — the recompute selects by
 * it, and the verify scan takes a not_exact row back by it). A run that is
 * not exact cannot be held to the raw log figure for figure; checking it
 * would report a flood of mismatches that say only "estimated", which PR 2
 * already says.
 *
 * No backticks in here: it is a template literal, and one ends the string.
 */
const NOT_EXACT_SQL = `
  SELECT ${NOT_EXACT_RUN_SQL} AS not_exact,
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
    /**
     * Gatling's own method (gatling-method-runner.ts); null, or omitted, where
     * its jars are not installed. A verification then records no differences
     * and no replay count, which is what says the method did not run.
     */
    private readonly gatlingMethod: GatlingMethodRunner | null = null,
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

    const options = optionsFrom(run.engineOptions, meta.startedAtMs);
    const expected = expectedFrom(events, options);
    const stored = toStored(await readStoredFigures(this.pool, runId, run.startedOn));

    // ═══ THE AGENT FILE, CHECKED INTO THE SAME LEDGER ═══
    //
    // Only a run whose agent file was COLLECTED has agent figures to hold to
    // it. A run with no `run_agent` row, or one recorded unreadable at ingest
    // (any reason, a builder failure included), stored no agent figures and is
    // verified on simulation.log alone. A collected run whose file can no
    // longer be read is unverifiable: its stored figures cannot be checked,
    // and verifying the rest would read as though they had been.
    const storedAgent = await readStoredAgentFigures(this.pool, runId, run.startedOn);
    if (storedAgent?.status === 'collected') {
      // A transport failure is rethrown, never recorded: it says nothing about
      // the file (the rule simulation.log's read follows above).
      const agentSource = await openAgentSource(run, { blobs: this.blobs }, source, { rethrowTransient: true });
      if (agentSource.kind === 'none') return unverifiable('raw_log_missing');
      if (agentSource.kind === 'unreadable') {
        return unverifiable(agentSource.reason === 'missing' ? 'raw_log_missing' : 'raw_log_unreadable');
      }
      let file: AgentFile;
      try {
        file = decodeAgentFile(agentSource.bytes);
      } catch {
        return unverifiable('raw_log_unreadable');
      }
      expected.agent = expectedAgent(file, {
        runStartMs: options.runStartMs,
        // The span late records are placed at, RECOMPUTED here from
        // simulation.log, never read from the run row — the width's rule
        // below, for the same reason: a wrong stored duration_ms is one run
        // figure (compareRun), not every agent row it would have misplaced.
        durationMs: expected.run.durationMs,
        // DERIVED here, never read from run_agent: the run series' width as
        // the verifier computes it from simulation.log (1000 for a run with no
        // request, as the builder's). The stored width is then one checked
        // figure of its own (compareAgentSummary), and a wrong one also shows
        // on every row it misplaced.
        bucketWidthMs: runSeriesWidth(events, options) ?? BASE_WIDTH_MS,
      });
      stored.agent = toStoredAgent(storedAgent);
    }

    const { figuresChecked, mismatches } = compare(expected, stored);

    const status = mismatches.length === 0 ? 'verified' : 'mismatch';
    // After compare, whatever it found: a mismatched run's report differs from
    // Gatling's in its own right, and the reader of that run wants both.
    const gatling = await this.#gatlingMethod(runId, events);
    await verifications.record(runId, {
      status,
      verifierVersion: VERIFIER_VERSION,
      figuresChecked,
      mismatches,
      // core's one rule, the one the API derives the date by when it reads it.
      // ingested_at is the retention clock, and every terminal writer stamps
      // it: now stands in only for a row somehow missing it.
      rawLogRetainedUntil: retainedUntil(run.ingestedAt ?? new Date(), this.config.rawLogRetentionDays),
      gatlingDifferences: gatling.differences,
      gatlingReplays: gatling.replays,
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
   * ═══ WHERE GATLING'S OWN REPORT WOULD DIFFER, OR NOTHING ═══
   *
   * Built from the SAME events the verifier just decoded — never a second read
   * of the log. The replay count is recorded only beside an answer the method
   * actually gave; when it did not run ([] and null) the row says so.
   *
   * A TOOL FAILURE NEVER CHANGES THE VERIFICATION: no jar, no `java`, a
   * timeout, a crash, a row outside the tool's contract, an answer that does
   * not account for exactly the keys sent (gatlingDifferences throws), or a
   * difference the API's own schema would refuse — each is one warn line and a
   * check recorded without differences. The last of those matters because a
   * stored row the API could not parse would answer 500 on the run's page long
   * after this job had finished.
   *
   * It runs INSIDE the run's advisory lock, which this job holds until
   * `record()`: a re-ingest or recompute of this one run waits behind the
   * tool, for at most GATLING_METHOD_TIMEOUT_MS. Moving it out would need a
   * second, guarded write of the differences after the status.
   */
  async #gatlingMethod(
    runId: string,
    events: readonly CanonicalEvent[],
  ): Promise<{ differences: GatlingDifference[]; replays: number | null }> {
    if (this.gatlingMethod === null) return { differences: [], replays: null };
    const seeds = this.config.gatlingMethodSeeds;
    try {
      const input = gatlingMethodInput(events);
      const output = await this.gatlingMethod(gatlingMethodLines(input), seeds);
      const differences = GatlingDifferenceSchema.array().parse(gatlingDifferences(input, output));
      return { differences, replays: seeds };
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      console.warn(`verify: run ${runId}: Gatling's method did not run, so no differences were recorded: ${why}`);
      return { differences: [], replays: null };
    }
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

/** Persistence's agent read, in the verifier's vocabulary: field for field. */
function toStoredAgent(a: StoredAgentFigures): StoredAgent {
  return {
    bucketWidthMs: a.bucketWidthMs,
    durations: a.durations.map((d) => ({
      family: d.family,
      dim: d.dim,
      startOffsetMs: d.startOffsetMs,
      okCount: d.okCount,
      koCount: d.koCount,
      ok: d.ok,
      ko: d.ko,
    })),
    metrics: a.metrics.map((m) => ({
      metric: m.metric,
      dim: m.dim,
      label: m.label,
      startOffsetMs: m.startOffsetMs,
      value: m.value,
    })),
  };
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
