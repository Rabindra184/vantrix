import { randomUUID } from 'node:crypto';
import type { BundleSource } from '@perfportal/core';
import {
  MetricWriter,
  ProjectRepository,
  RecomputeRepository,
  RunRepository,
  type RecomputeError,
  type RunRecord,
} from '@perfportal/persistence';
import {
  evaluateRules,
  toEvaluableStats,
  type EvaluableRule,
  type EvaluatedAssertion,
  type Verdict,
} from '@perfportal/sla';
import { runEngineAsync, type EngineOptions, type EngineResult } from '@perfportal/statistics';
import type { BlobStore } from '@perfportal/storage';
import type { PrismaClient } from '@prisma/client';
import type pg from 'pg';
import type { WorkerConfig } from '../config.js';
import { holdClient } from '../held-client.js';
import { RUN_INGEST_LOCK_NAMESPACE } from '../pipeline/pipeline.service.js';
import { selectPlugin } from '../pipeline/plugins.js';
import { isTransient } from '../pipeline/retry.js';
import { openRunSource, RawLogMissingError } from '../pipeline/run-source.js';

/**
 * What one recompute did. `locked` asks the caller to try again later; the
 * three `RecomputeError` words were recorded on the run, which takes it out of
 * every later selection; the rest need nothing further.
 */
export type RecomputeOutcome =
  | 'recomputed'
  | 'already_exact'
  | 'locked'
  | 'gone'
  | 'not_eligible'
  | RecomputeError;

/** One `run_assertion` row as the earlier ingest recorded it. */
interface StoredAssertion {
  rule_snapshot: EvaluableRule;
  outcome: string;
  actual_value: number | null;
}

/** An earlier assertion and its re-judged counterpart whose outcomes differ. */
interface OutcomeChange {
  before: StoredAssertion;
  after: EvaluatedAssertion;
}

/**
 * ═══ ONE RUN, REWRITTEN EXACTLY FROM ITS OWN STORED LOG ═══
 *
 * Re-reads the bytes the run was ingested from, re-runs the same engine with
 * the run's FROZEN engine options, and replaces every metric row in one
 * transaction — so a reader sees either the legacy figures or the exact ones,
 * never half of each. The SLA verdict is re-judged with the rule snapshots the
 * run already carries, never with the rules as they read today: an edited
 * threshold must not rewrite what a past run was judged against. Where a rule's
 * OUTCOME moves, that is recorded in `run_verdict_change`.
 *
 * What is NOT touched, deliberately: status, run number, test, note, every
 * lifecycle timestamp and identity column. And no `run_terminal` is published:
 * the run did not finish again, and nothing is waiting on it.
 */
export class RecomputeService {
  constructor(
    private readonly config: WorkerConfig,
    private readonly prisma: PrismaClient,
    private readonly pool: pg.Pool,
    private readonly blobs: BlobStore,
  ) {}

  /**
   * Under the SAME advisory lock `PipelineService.process` and the live fold
   * owner take, so a recompute can never interleave with an ingest of the same
   * run. A try-lock: a run somebody else holds is `locked`, and the queue asks
   * again later rather than this call waiting behind it.
   */
  async recompute(runId: string): Promise<RecomputeOutcome> {
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

      // A LOCK SESSION LOST MID-RECOMPUTE IS SAFE. The lock lives in this
      // session, so if its connection dies another worker can take it and
      // recompute the same run beside this one. Both write in one
      // transaction each, and every row they insert carries a unique key
      // (run_stat's (run_id, scope, name, family), each bucket table's
      // primary key): a second writer whose transaction overlaps the first
      // meets the first's rows and rolls back, and one that starts after the
      // first committed finds the run already exact. Either way the run ends
      // with one engine's figures, never two.

      try {
        return await this.#recomputeHoldingLock(runId);
      } finally {
        // An unlock that fails must not replace the error that brought this
        // here (see the pipeline's own finally). Releasing WITH the error makes
        // the pool destroy the client, and the lock with its session.
        try {
          await client.query('SELECT pg_advisory_unlock($1, hashtext($2))', [
            RUN_INGEST_LOCK_NAMESPACE,
            runId,
          ]);
        } catch (err) {
          broken = err instanceof Error ? err : new Error(String(err));
        }
      }
    } finally {
      held.release(broken);
    }
  }

  async #recomputeHoldingLock(runId: string): Promise<RecomputeOutcome> {
    const run = await new RunRepository(this.prisma).findByIdUnscoped(runId);
    if (!run) return 'gone';
    if (run.status !== 'complete' && run.status !== 'incomplete') return 'not_eligible';

    // Re-checked UNDER the lock, with the one definition the selection uses:
    // a run queued twice, or recomputed since it was queued, is already done.
    const recompute = new RecomputeRepository(this.pool);
    if ((await recompute.candidates({ runId }, 1)).length === 0) return 'already_exact';

    // ═══ THE LARGER OF THE PROJECT'S LIMIT AND THE WORKER'S ═══
    //
    // The run was ingested under the limit in force then. A project setting
    // LOWERED since would refuse an archive that parsed perfectly, and a size
    // refusal is about this deployment's settings, not about the log — so the
    // recompute opens with whichever is larger. A refusal even under that is
    // rethrown (`sourceFailure`), never recorded: raising the limit fixes it.
    const project = await new ProjectRepository(this.prisma).byId(run.projectId);
    const projectLimit = project?.settings.maxDecompressedBundleBytes;
    const maxTotalBytes = Math.max(
      typeof projectLimit === 'number' && Number.isFinite(projectLimit) ? projectLimit : 0,
      this.config.maxDecompressedBundleBytes,
    );

    let source: BundleSource;
    try {
      source = await openRunSource(run, { blobs: this.blobs, maxTotalBytes });
    } catch (err) {
      const reason = sourceFailure(err);
      if (reason === null) throw err;
      await recompute.markFailed(runId, reason);
      return reason;
    }

    let result: EngineResult;
    try {
      const { plugin } = await selectPlugin(source.index);
      result = await runEngineAsync(plugin.parse(source), run.engineOptions as EngineOptions);
    } catch (err) {
      // The bytes are in memory by now, so a transport failure is unlikely
      // here — but one that IS reported is not a fact about the log.
      if (isTransient(err)) throw err;
      await recompute.markFailed(runId, 'parse_failed');
      return 'parse_failed';
    }

    // ═══ THE FROZEN RULES, NOT TODAY'S ═══
    //
    // The snapshot each assertion stored is the rule as it read when the run
    // was judged. Re-evaluating those against the exact statistics answers
    // "would this run have passed the gate it was held to", which is the only
    // question a recompute is entitled to change the answer to.
    const { rows: stored } = await this.pool.query<StoredAssertion>(
      `SELECT rule_snapshot, outcome, actual_value FROM run_assertion WHERE run_id = $1 ORDER BY id`,
      [runId],
    );
    const { assertions, verdict } = evaluateRules(
      stored.map((s) => s.rule_snapshot),
      toEvaluableStats(result.stats),
    );

    await this.#write(run, result, assertions, verdict, outcomeChanges(stored, assertions));
    return 'recomputed';
  }

  async #write(
    run: RunRecord,
    result: EngineResult,
    assertions: readonly EvaluatedAssertion[],
    verdict: Verdict,
    changes: readonly OutcomeChange[],
  ): Promise<void> {
    const held = holdClient(await this.pool.connect());
    const client = held.client;
    let broken: Error | undefined;
    try {
      await client.query('BEGIN');

      const writer = new MetricWriter();
      await writer.deleteForRun(client, { runId: run.id, runStartedOn: run.startedOn });
      await writer.persist(
        client,
        { runId: run.id, orgId: run.orgId, projectId: run.projectId, runStartedOn: run.startedOn },
        result,
      );

      // The pipeline's columns. `ruleId` IS the snapshot's id: the stored
      // snapshot is the only rule this re-judgement knows about.
      for (const a of assertions) {
        await client.query(
          `INSERT INTO run_assertion
             (id, run_id, org_id, project_id, rule_id, rule_snapshot, outcome, actual_value, message)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            randomUUID(), run.id, run.orgId, run.projectId, a.ruleId,
            JSON.stringify(a.ruleSnapshot), a.outcome, a.actualValue, a.message,
          ],
        );
      }

      // `old_verdict` is NOT NULL, and every writer that stores assertions
      // also stores a verdict, so `run.verdict` is set whenever a change can
      // exist. A run somehow carrying assertions and no verdict was never
      // judged, which is what 'not_evaluated' says.
      const oldVerdict = run.verdict ?? 'not_evaluated';
      for (const c of changes) {
        await client.query(
          `INSERT INTO run_verdict_change
             (id, run_id, org_id, project_id, rule_snapshot, old_outcome, new_outcome,
              old_value, new_value, old_verdict, new_verdict)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [
            randomUUID(), run.id, run.orgId, run.projectId, JSON.stringify(c.before.rule_snapshot),
            c.before.outcome, c.after.outcome, c.before.actual_value, c.after.actualValue,
            oldVerdict, verdict,
          ],
        );
      }

      // Only what the exact statistics re-derive. `tool_assertions` and both
      // durations come from the same log through the same engine; status,
      // number, test, note and every timestamp but recomputed_at are left as
      // they were.
      await client.query(
        `UPDATE run SET stats_method = 'exact-v1', verdict = $2, tool_assertions = $3,
                duration_ms = $4, activity_ms = $5, recomputed_at = now()
          WHERE id = $1`,
        [run.id, verdict, JSON.stringify(result.toolAssertions), result.durationMs, result.activityMs],
      );

      await client.query('COMMIT');
    } catch (err) {
      // The ROLLBACK's own failure must not replace `err` (the pipeline's
      // pattern): on a connection the server ended it rejects with a code-less
      // error that would hide the transient one that brought this here.
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        broken = rollbackErr instanceof Error ? rollbackErr : new Error(String(rollbackErr));
      }
      throw err;
    } finally {
      held.release(broken);
    }
  }
}

/**
 * What a failure to OPEN the stored log says about the run, or null when it
 * says nothing and must be rethrown.
 *
 * Only two kinds of error are facts about the run: `RawLogMissingError`
 * (there is no log, and never will be) and an `IngestError` from verifying or
 * opening the bytes — `BUNDLE_CHECKSUM_MISMATCH`, or an archive refused as
 * not an archive, which is the log failing to parse. `BUNDLE_TOO_LARGE` is
 * NOT one of them: it is the deployment's limit speaking, and is rethrown.
 * Anything else is the object store failing to answer, and is NOT keyed on
 * `isTransient`: the AWS SDK reports a socket timeout as a bare
 * `name: 'TimeoutError'` with no code, which that function does not
 * recognise, and recording it would retire a perfectly good run for good.
 */
function sourceFailure(err: unknown): RecomputeError | null {
  if (err instanceof RawLogMissingError) return 'raw_log_missing';
  if (err instanceof Error && err.name === 'IngestError') {
    const code = (err as { code?: unknown }).code;
    // A size refusal is a fact about the configured limit, not the log: the
    // same bytes open once an operator raises it. Recording it would retire
    // the run for good over a setting.
    if (code === 'BUNDLE_TOO_LARGE') return null;
    return code === 'BUNDLE_CHECKSUM_MISMATCH' ? 'checksum_mismatch' : 'parse_failed';
  }
  return null;
}

/**
 * Pairs each re-judged assertion with the stored one for the same rule, by the
 * snapshot's id, in order of appearance (so duplicate ids pair first with
 * first), and keeps only the pairs whose OUTCOME moved. A value that changed
 * without changing the outcome is not a verdict change.
 */
function outcomeChanges(
  stored: readonly StoredAssertion[],
  assertions: readonly EvaluatedAssertion[],
): OutcomeChange[] {
  const byRule = new Map<string, StoredAssertion[]>();
  for (const s of stored) {
    const list = byRule.get(s.rule_snapshot.id) ?? [];
    list.push(s);
    byRule.set(s.rule_snapshot.id, list);
  }
  const changes: OutcomeChange[] = [];
  for (const after of assertions) {
    const before = byRule.get(after.ruleId)?.shift();
    if (before && before.outcome !== after.outcome) changes.push({ before, after });
  }
  return changes;
}
