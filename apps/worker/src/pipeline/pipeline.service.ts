import { createHash, randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { IngestError, ingestError, type BundleSource } from '@perfportal/core';
import {
  MetricWriter,
  ProjectRepository,
  RunRepository,
  RuleRepository,
  type RunRecord,
} from '@perfportal/persistence';
import { SIMULATION_LOG } from '@perfportal/plugin-gatling';
import { evaluateRules, toEvaluableStats, type EvaluableRule } from '@perfportal/sla';
import { runEngineAsync, type EngineOptions } from '@perfportal/statistics';
import { BlobStore, openTarGzBundle } from '@perfportal/storage';
import type { PrismaClient } from '@prisma/client';
import type pg from 'pg';
import type { WorkerConfig } from '../config.js';
import { selectPlugin } from './plugins.js';

/**
 * A live run's `bundleKey` (Task 9, apps/api/src/ingest/live.service.ts)
 * holds the assembled `simulation.log` AS ITS OWN RAW BYTES —
 * `LiveChunkStore.finalize` (packages/storage/src/live-chunks.ts) writes
 * exactly the concatenated chunk stream, with no tar/gzip wrapping: a live
 * run was never an archive, so there is nothing to wrap. An uploaded run's
 * `bundleKey` (IngestService.accept's `runs/{projectId}/{uuid}.tgz`) is
 * always a real gzipped tar.
 *
 * `openTarGzBundle` assumes the latter unconditionally: it gunzips whatever
 * bytes it is given and throws `BUNDLE_NOT_ARCHIVE` the instant they are not
 * a gzip stream, which every live run's raw log always is. Presenting the
 * raw buffer as a one-file `BundleSource` here — rather than teaching
 * `openTarGzBundle` to detect and skip the unwrap — keeps that function
 * single-purpose (it opens archives; this is not one) and leaves every
 * downstream consumer untouched: `GatlingPlugin.detect`/`parse` only ever
 * call `source.index.files`/`head`/`read`, never anything archive-specific,
 * so a live run's finalized log parses through the exact same plugin code a
 * bundle upload does.
 */
function rawLogBundleSource(buf: Buffer): BundleSource {
  const files = [SIMULATION_LOG];
  return {
    index: {
      files,
      head: async (path, bytes) => {
        if (path !== SIMULATION_LOG) throw new Error(`no such entry: ${path}`);
        return new Uint8Array(buf.subarray(0, bytes));
      },
    },
    read: async (path) => {
      if (path !== SIMULATION_LOG) throw new Error(`no such entry: ${path}`);
      // `buf` (unlike head()'s small slice above) can be the whole
      // 150-250 MB log, so this returns the SAME buffer rather than
      // `new Uint8Array(buf)` -- that constructor form copies every byte,
      // doubling peak memory for no reason: Buffer already IS a Uint8Array
      // (Node's own subclass), so no conversion is needed at all.
      return buf;
    },
  };
}

/**
 * Namespace for the per-run ingest advisory lock. Arbitrary but fixed, and
 * paired with `hashtext(run_id)` as the second key so this lock can never
 * collide with an advisory lock taken elsewhere for another purpose.
 *
 * Exported rather than left `const` so `apps/worker/src/live/fold-owner.ts`
 * can reuse it instead of copying the number. Two independent locks would
 * NOT be equivalent here: the fold owner deliberately competes on this same
 * namespace so a run cannot be folded while `PipelineService` is parsing it
 * (see `LiveFoldOwner`'s own doc comment for why that matters).
 */
export const RUN_INGEST_LOCK_NAMESPACE = 8_531_001;

/**
 * Thrown by `process()` when it loses the lock race to the LIVE FOLD OWNER
 * rather than to another `process()` call for the same run -- see
 * `#handleLockLost`'s doc comment for how the two are told apart. Always
 * means "ask the caller to try again shortly," never "this run's data is
 * bad," so it is deliberately NOT an `IngestError`: `isTransient`
 * (`pipeline/retry.ts`) treats every `IngestError` as deterministic on
 * principle, which is the opposite of what this needs. `code: 'RUN_LOCKED'`
 * is what tells `retry.ts` to retry it, alongside the networking/Prisma
 * codes already there.
 */
class RunLockedError extends Error {
  readonly code = 'RUN_LOCKED';
  constructor(runId: string) {
    super(`run ${runId} is locked by the live fold owner; will retry`);
    this.name = 'RunLockedError';
  }
}

@Injectable()
export class PipelineService {
  constructor(
    private readonly config: WorkerConfig,
    private readonly prisma: PrismaClient,
    private readonly pool: pg.Pool,
    private readonly blobs: BlobStore,
  ) {}

  /**
   * ONE PROCESSOR PER RUN, enforced by a Postgres advisory lock rather than by
   * the status check below.
   *
   * That check is check-then-act: two processors both read a non-terminal
   * status, both pass, and both go on to write `run_stat`, where the loser
   * dies on `run_stat_run_id_scope_name_family_key` having already done the
   * entire parse. Its transaction rolls back, so nothing is corrupted and the
   * winner's result stands — but the rejection propagates to the consumer as
   * an ingest failure that no bundle caused.
   *
   * The claim CANNOT be made by narrowing `markParsing` to non-`parsing`
   * rows: the Sweeper's whole purpose is re-queuing runs stranded in
   * `parsing`, and that would strand them permanently. A lock has the
   * lifetime this needs instead — held only while a processor is alive, so a
   * worker that dies mid-parse releases it and the sweeper's retry can claim
   * it, while a live processor keeps every rival out.
   *
   * `pg_try_advisory_lock` and not its blocking form: a rival should return
   * immediately, not queue up to redo work that is already being done.
   */
  async process(runId: string): Promise<void> {
    // The lock lives on ONE connection and is released on it, so it cannot be
    // taken on one pooled connection and orphaned on another.
    const client = await this.pool.connect();
    try {
      const { rows } = await client.query<{ got: boolean }>(
        'SELECT pg_try_advisory_lock($1, hashtext($2)) AS got',
        [RUN_INGEST_LOCK_NAMESPACE, runId],
      );
      if (!rows[0]?.got) {
        await this.#handleLockLost(runId);
        return;
      }

      try {
        await this.#processHoldingLock(runId);
      } finally {
        await client.query('SELECT pg_advisory_unlock($1, hashtext($2))', [
          RUN_INGEST_LOCK_NAMESPACE,
          runId,
        ]);
      }
    } finally {
      client.release();
    }
  }

  /**
   * Reached when `process()` loses the advisory-lock race for `runId`. Two
   * structurally different races land here, and they need OPPOSITE
   * treatments:
   *
   *  1. TWO INGEST PROCESSORS RACING OVER THE SAME BUNDLE -- a duplicate
   *     BullMQ delivery, or the Sweeper's 'parsing' re-enqueue landing while
   *     the original attempt is still alive (this method's own class doc
   *     comment above `process` describes the hazard the lock exists to
   *     close). The lock is held by ANOTHER `process()` call for this exact
   *     run, actively driving it to a terminal state on its own. The
   *     ORIGINAL behaviour here -- silently return, do nothing -- is
   *     correct and must stay: the winner will finish (or, if it dies, the
   *     Sweeper's staleness re-enqueue is the recovery path, not a BullMQ
   *     retry racing the same lock again).
   *
   *  2. THE LIVE FOLD OWNER STILL HOLDS THE LOCK. `LiveService.close()`
   *     (`apps/api/src/ingest/live.service.ts`) moves a run to `'parsing'`
   *     and enqueues this job BEFORE the fold owner's next tick has
   *     released the shared lock -- design part-2a §1.1 reuses this exact
   *     namespace deliberately so a run can never be folded while it is
   *     being parsed. The owner releases within one `liveTickMs` (<=5s by
   *     default), so returning silently here would report the job a
   *     success while nothing has actually parsed the run: it would sit at
   *     `'parsing'` until the Sweeper's `parsingStaleAfterMs` (15 minutes by
   *     default) notices. This case must THROW so BullMQ retries -- its
   *     default 3 attempts with exponential backoff from 2s (`queue.ts`)
   *     comfortably covers a <=5s wait.
   *
   * The two are told apart by `bundleKey`, NOT by status: `claimForClose`
   * and `markParsing` both write `'parsing'`, so status alone cannot
   * distinguish a run the fold owner is about to release from one another
   * `process()` call is actively driving. Only a LIVE run's bundleKey (the
   * `/${SIMULATION_LOG}` suffix `rawLogBundleSource` above already tests
   * for) can ever contend with the fold owner for this lock -- the owner
   * only claims runs at `status = 'running'`, and an uploaded run never
   * passes through that state -- so an uploaded run losing the race can
   * only mean case 1, and a live run losing it while non-terminal is
   * overwhelmingly case 2.
   */
  async #handleLockLost(runId: string): Promise<void> {
    const runs = new RunRepository(this.prisma);
    const run = await runs.findByIdUnscoped(runId);
    if (!run) return;                                                   // swept away or deleted
    if (run.status === 'complete' || run.status === 'failed') return;   // already terminal -- case 1, resolved

    if (run.bundleKey.endsWith(`/${SIMULATION_LOG}`)) {
      throw new RunLockedError(runId);                                  // case 2 -- ask BullMQ to retry
    }
    // Case 1: another process() call already owns this run's outcome.
  }

  async #processHoldingLock(runId: string): Promise<void> {
    const runs = new RunRepository(this.prisma);
    const run = await runs.findByIdUnscoped(runId);
    if (!run) return;                                   // swept away or deleted
    if (run.status === 'complete' || run.status === 'failed') return;   // already terminal

    await runs.markParsing(runId);

    try {
      await this.#ingest(run);
    } catch (err) {
      const structured =
        err instanceof IngestError || (err instanceof Error && err.name === 'IngestError')
          ? (err as IngestError)
          : null;
      const wrote = await runs.fail(runId, {
        code: structured?.code ?? 'INTERNAL',
        message: structured?.message ?? 'The run could not be ingested.',
        remediation:
          structured?.remediation ??
          'Retry the upload. If it keeps failing, the bundle may be incomplete.',
      });
      if (wrote) {
        await this.#publish(runId);
      } else {
        // Lost the race: another worker already drove this run to a terminal
        // state (complete or failed) before this transaction rolled back.
        // Its write must stand, and it already published — don't do so again.
        console.warn(
          `run ${runId} reached a terminal state on another worker; discarding this failure`,
        );
      }
      throw err;                                        // let the consumer classify it
    }

    await this.#publish(runId);
  }

  async #ingest(run: RunRecord): Promise<void> {
    const archive = await this.blobs.get(run.bundleKey);

    // spec §6.2 step 2: verify SHA-256 against what was recorded at upload
    // time. A mismatch here means the object fetched back from the blob
    // store is not the bytes that were durably written — storage-side
    // corruption, not a malformed bundle — so it must not be blamed on the
    // caller the way a parse failure would be.
    const actualSha256 = createHash('sha256').update(archive).digest('hex');
    if (actualSha256 !== run.bundleSha256) {
      throw ingestError('BUNDLE_CHECKSUM_MISMATCH', {
        message:
          `The bundle fetched from object storage does not match the checksum recorded ` +
          `at upload time (expected ${run.bundleSha256}, got ${actualSha256}).`,
        remediation:
          'This is a storage integrity problem, not a malformed upload — re-upload is unlikely ' +
          'to help by itself. Escalate to the platform team to check the object store for ' +
          'corruption or a bad replica before retrying.',
        detail: { expected: run.bundleSha256, actual: actualSha256 },
      });
    }

    const project = await new ProjectRepository(this.prisma).byId(run.projectId);
    const maxTotalBytes =
      (project?.settings.maxDecompressedBundleBytes as number | undefined) ??
      this.config.maxDecompressedBundleBytes;
    // See rawLogBundleSource's docstring: a live run's bundleKey always ends
    // in `/simulation.log` (createLive's convention) and is never a gzip
    // stream; an uploaded run's always ends in `.tgz` and always is one.
    // maxTotalBytes/maxEntryBytes (decompression-bomb guards) do not apply
    // to the live path — there is no compression to bound in the first
    // place, since these are exactly the bytes the platform already
    // received and stored one stream chunk at a time.
    const source = run.bundleKey.endsWith(`/${SIMULATION_LOG}`)
      ? rawLogBundleSource(archive)
      : await openTarGzBundle(archive, { maxTotalBytes });
    const { plugin, toolVersion } = await selectPlugin(source.index);

    const result = await runEngineAsync(plugin.parse(source), run.engineOptions as EngineOptions);
    // The tool's own run header, not the upload/ingest time already frozen
    // onto run.startedAt at accept time (see schema.prisma). Null only when
    // the parsed bundle carried no meta event at all — not expected for a
    // successfully-parsed run, but the engine makes that case explicit
    // rather than defaulting to the Unix epoch, so this stays null too.
    //
    // Bound below as an ISO string, not a bare Date: this transaction goes
    // through node-postgres directly (not Prisma), and node-postgres
    // serializes a JS Date parameter using the process's LOCAL timezone
    // (pg/lib/utils.js dateToString) — which a `timestamp(3)` (no tz)
    // column then stores verbatim, silently shifting the value by the
    // host's UTC offset. `toISOString()` always renders the UTC instant, so
    // the column ends up holding what run.startedAt/ingested_at already do.
    const toolStartedAt =
      result.runStartedAtMs !== null ? new Date(result.runStartedAtMs).toISOString() : null;

    const rules = await new RuleRepository(this.prisma).listEnabled({
      orgId: run.orgId,
      projectId: run.projectId,
    });

    const evaluable = toEvaluableStats(result.stats);

    const evaluableRules: EvaluableRule[] = rules.map((r) => ({
      id: r.id,
      scope: r.scope,
      targetName: r.targetName,
      family: r.family,
      metric: r.metric,
      comparator: r.comparator,
      threshold: r.threshold,
    }));

    const { assertions, verdict } = evaluateRules(evaluableRules, evaluable);

    // ═══ WHICH TEST THIS IS A RUN OF ═══
    //
    // Resolved HERE, immediately before the transaction, and deliberately not
    // inside it. See `resolveTestId` for why a slug collision must not be able
    // to abort the write that finalizes the run.
    //
    // This is the moment the answer first exists: `result.simulation` is the
    // class parsed out of the log header, and nothing before this point in a
    // run's life knows it. `null` when the header declared none, which stays a
    // run with no test rather than a test with no name.
    const testId = await this.#resolveTestId(run, result.simulation);

    // Statistics, assertions, and the terminal status commit together. A run is
    // never observable with statistics but no verdict, or the reverse.
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      await new MetricWriter().persist(
        client,
        {
          runId: run.id,
          orgId: run.orgId,
          projectId: run.projectId,
          runStartedOn: run.startedOn,
        },
        result,
      );

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

      // The status guard mirrors RunRepository.fail's: a concurrently-processed
      // duplicate of this job (stalled-job redelivery, BullMQ concurrency > 1)
      // must not resurrect an already-committed 'failed' run back to
      // 'complete' out from under it. Doesn't affect the single-worker happy
      // path — status is 'parsing' here, never already terminal.
      await client.query(
        `UPDATE run SET status = 'complete', verdict = $2, tool_version = $3, ingested_at = now(),
                tool_started_at = $4, simulation = $5, description = $6, duration_ms = $7,
                tool_assertions = $8, activity_ms = $9, test_id = $10
          WHERE id = $1 AND status NOT IN ('complete', 'failed')`,
        [
          run.id, verdict, toolVersion, toolStartedAt,
          result.simulation, result.description, result.durationMs,
          // Appendix A G-05. Written here rather than evaluated on read because
          // the engine has just judged them against the very rollups it built —
          // recomputing later would mean reloading sketches to re-answer a
          // question already answered. `[]` for a simulation that declared none,
          // which is a different fact from the NULL a pre-decoder run carries.
          JSON.stringify(result.toolAssertions),
          // The MEASURED span, beside the series span above. See
          // `EngineResult.activityMs` for why the run page needs both.
          result.activityMs,
          // Written in the SAME statement as `simulation`, which is the point:
          // the string and the row it groups by can never disagree, because
          // one UPDATE sets both or neither.
          testId,
        ],
      );

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Resolve-or-create the `test` this run belongs to, by simulation class.
   *
   * ═══ THE SAME RULE THE MIGRATION USED, WHICH IS THE POINT ═══
   *
   * `20260822220000_test_entity` grouped history by `(project_id, simulation)`
   * and derived a slug the same way. If this drifted from that, the backfill
   * would be a one-off that the application immediately started contradicting
   * — a second test for a class that already had one. Keeping the two rules
   * identical is what makes the migration trustworthy rather than a snapshot.
   *
   * ═══ OUTSIDE THE FINALIZE TRANSACTION, DELIBERATELY ═══
   *
   * A constraint violation ABORTS a Postgres transaction — every later
   * statement in it fails with "current transaction is aborted". Doing this
   * inside the transaction that writes statistics, assertions and the terminal
   * status would mean a slug collision could lose all of that, to decide a
   * grouping. Its own connection instead, and its own failure mode: a run
   * whose test could not be resolved is a run with `test_id IS NULL`, which is
   * a state the schema already allows for pending and unparsed runs. The next
   * run of the same class creates the test and adopts it.
   *
   * An orphan test with no runs is possible if this succeeds and the
   * transaction below then fails. That is benign — the next run of that class
   * finds and reuses it.
   */
  async #resolveTestId(run: RunRecord, simulation: string | null): Promise<string | null> {
    // No class in the header is not a failure — it is a run that cannot say
    // what it was. A test named `null` would be worse than no test.
    if (simulation === null || simulation.trim() === '') return null;

    const base = slugifySimulation(simulation);
    try {
      const existing = await this.pool.query<{ id: string }>(
        `SELECT id FROM test WHERE project_id = $1 AND simulation_class = $2`,
        [run.projectId, simulation],
      );
      if (existing.rows[0] !== undefined) return existing.rows[0].id;

      // The slug is chosen and the row inserted in ONE statement, so the
      // window between "this slug is free" and "this slug is mine" is as small
      // as Postgres can make it. `ON CONFLICT (project_id, simulation_class)
      // DO UPDATE` rather than DO NOTHING because only DO UPDATE returns a
      // row — which is how a caller that lost the race still gets the id.
      const inserted = await this.pool.query<{ id: string }>(
        `WITH candidate AS (
           SELECT CASE WHEN n = 1 THEN $3::text ELSE $3::text || '-' || n END AS slug
             FROM generate_series(1, 50) AS n
            WHERE NOT EXISTS (
                  SELECT 1 FROM test t
                   WHERE t.project_id = $2::uuid
                     AND t.slug = CASE WHEN n = 1 THEN $3::text ELSE $3::text || '-' || n END)
            ORDER BY n
            LIMIT 1)
         INSERT INTO test (id, org_id, project_id, slug, name, simulation_class, created_at, updated_at)
         SELECT gen_random_uuid(), $1::uuid, $2::uuid, c.slug, $4, $4, now(), now()
           FROM candidate c
         ON CONFLICT (project_id, simulation_class) DO UPDATE SET updated_at = test.updated_at
         RETURNING id`,
        [run.orgId, run.projectId, base, simulation],
      );
      if (inserted.rows[0] !== undefined) return inserted.rows[0].id;

      // Nothing returned means either a lost race or fifty taken slugs. One
      // more read settles which, and costs nothing on the path that never
      // gets here.
      const after = await this.pool.query<{ id: string }>(
        `SELECT id FROM test WHERE project_id = $1 AND simulation_class = $2`,
        [run.projectId, simulation],
      );
      return after.rows[0]?.id ?? null;
    } catch (err) {
      // A run is worth more than its grouping. Failing the pipeline here would
      // turn a naming problem into a lost result.
      console.warn(
        `run ${run.id}: could not resolve a test for simulation ${simulation}; ` +
          `leaving it ungrouped: ${String(err)}`,
      );
      return null;
    }
  }

  async #publish(runId: string): Promise<void> {
    await this.pool.query(`SELECT pg_notify('run_terminal', $1)`, [runId]);
  }
}

/**
 * A simulation class as a URL slug — the TypeScript half of a rule the
 * migration also spells in SQL (`regexp_replace(lower(x), '[^a-z0-9]+', '-')`
 * then trim). Two spellings of one rule is a real risk, and the mitigation is
 * that `test-entity.integration.test.ts` asserts they agree on the same inputs
 * rather than each agreeing with itself.
 *
 * A class that is entirely punctuation slugifies to nothing; `test` is the
 * fallback, and the collision suffix then applies to it like any other base.
 */
export function slugifySimulation(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '');
  return slug === '' ? 'test' : slug;
}
