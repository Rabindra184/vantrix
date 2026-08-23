import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { engineOptionsFrom, ingestError } from '@perfportal/core';
import {
  ProjectRepository,
  RunRepository,
  type RunRecord,
  type TenantScope,
} from '@perfportal/persistence';
import { BlobStore, LiveChunkStore } from '@perfportal/storage';
import type { OpenLiveRunRequest } from '@perfportal/contracts';
import { CONFIG } from '../auth/auth.module.js';
import type { AppConfig } from '../config.js';
import { TerminalWaiter } from '../runs/terminal-waiter.js';
import { LiveNotifier } from './live-notifier.js';
import { IngestQueue } from './queue.js';

export interface OpenLiveRunResult {
  runId: string;
  streamUrl: string;
  nextOffset: number;
}

export type StreamOutcome =
  | { kind: 'not_found' }
  /** A gap (ahead of the cursor), or the run is no longer `running` — the
   *  two cases the caller cannot and need not tell apart (see `stream()`'s
   *  own docstring). Never reached for a replay; that is `accepted`. */
  | { kind: 'rejected'; nextOffset: number }
  | { kind: 'accepted'; nextOffset: number };

export type CloseOutcome =
  | { kind: 'not_found' }
  | { kind: 'not_running' }
  | { kind: 'closed'; run: RunRecord };

/**
 * Holds the logic for the three live-streaming routes; LiveController stays
 * thin, matching IngestController/IngestService.
 */
@Injectable()
export class LiveService {
  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly projects: ProjectRepository,
    private readonly runs: RunRepository,
    private readonly blobs: BlobStore,
    private readonly chunks: LiveChunkStore,
    private readonly queue: IngestQueue,
    private readonly waiter: TerminalWaiter,
    private readonly notifier: LiveNotifier,
  ) {}

  /**
   * Opens a run that will be fed by POST /v1/runs/:id/stream rather than a
   * bundle upload. Freezes environment/branch/commitSha/test/engineOptions the
   * same way IngestService.accept does for an upload — see
   * RunRepository.createLive's docstring for why a live run's submission
   * moment is `open`, exactly as an upload's is its own POST.
   */
  async open(tenant: TenantScope & { projectId: string }, body: OpenLiveRunRequest): Promise<OpenLiveRunResult> {
    const scope = { orgId: tenant.orgId, projectId: tenant.projectId };
    const settings = await this.projects.settings(scope);

    const run = await this.runs.createLive({
      orgId: tenant.orgId,
      projectId: tenant.projectId,
      tool: body.tool,
      ...(body.environment ? { environment: body.environment } : {}),
      ...(body.branch ? { branch: body.branch } : {}),
      ...(body.commitSha ? { commitSha: body.commitSha } : {}),
      // Same freeze-at-open treatment as the three above. `LiveFoldOwner`
      // resolves it against a real `test` row the moment the decoder reads the
      // log header, so a declared test's SLA rules judge this run from its
      // first ticks rather than only from the finished report.
      ...(body.test ? { declaredTestSlug: body.test } : {}),
      ...(body.idempotencyKey ? { idempotencyKey: body.idempotencyKey } : {}),
      startedAt: new Date(),
      engineOptions: engineOptionsFrom(settings),
    });

    // Fire-and-forget (design §1.2): lets the fold owner attempt a claim now
    // instead of waiting for its next discovery poll. Never awaited, and a
    // dropped message is harmless -- the poll finds this run's `running` row
    // regardless, on the next tick at the latest.
    this.notifier.opened(run.id);

    // NOT a hardcoded 0: createLive is idempotent under idempotencyKey, so a
    // retried open can rejoin a run that already accepted bytes. Reading the
    // real cursor back is what makes that rejoin resumable rather than
    // silently restarting the run — see OpenLiveRunResponseSchema's docstring.
    const state = await this.runs.liveState(run.id);

    return { runId: run.id, streamUrl: `/v1/runs/${run.id}/stream`, nextOffset: state?.streamOffset ?? 0 };
  }

  /**
   * Lands one chunk, discriminating gap / replay / accept from the cursor
   * READ BEFORE ANY WRITE — the fix this method exists to get right.
   *
   * A GAP (`offset` ahead of the cursor) is refused WITHOUT calling
   * `chunks.put`. Writing first and validating after (an earlier version of
   * this did exactly that) leaves an orphan object at the gap's own
   * (wrong, future) key even though the chunk was rejected: `finalize`
   * concatenates every key under the run's prefix in sorted order with no
   * concept of "this one was never accepted", so that orphan lands in the
   * assembled log at its sorted position regardless. That is silent wrong
   * data reaching the decoder — checksummed correctly, because the
   * checksum is taken of the corrupted assembly, so nothing downstream
   * notices. Refusing before writing is what makes the orphan
   * unconstructible in the first place.
   *
   * A REPLAY (`offset` behind the cursor) is the opposite case and must
   * stay a 202, not an error: it is what makes the agent's own retries
   * idempotent (send the same chunk again after a timeout that actually
   * succeeded). It does NOT write. Everything up to `cursor` is already
   * durably stored — `put` only ever runs before `advanceOffset` moves the
   * cursor past the bytes it just wrote (below), so a replay's bytes are
   * guaranteed to already sit at their real key. Writing again anyway was
   * the second half of this method's own bug: nothing here validates that
   * a replayed `offset` is a real chunk boundary, or that `bytes.length`
   * matches what is actually stored there — an agent replaying at a
   * different offset, or re-chunking at a different size after a restart,
   * would `put` under a key that never legitimately existed (or overwrite
   * a real one with the WRONG bytes), and `finalize` concatenates the
   * prefix with no way to tell. That is Critical 1's corruption again,
   * this time answered 202 instead of 409. A pure no-op is what actually
   * keeps this idempotent.
   *
   * Only the exact-match case (`offset === cursor`) reaches `advanceOffset`
   * at all, and there the original ordering argument still holds: `put`
   * happens BEFORE the offset advances, so a crash between the two leaves a
   * duplicate object at the same key (assembly overwrites it — safe)
   * rather than a gap (not safe).
   */
  async stream(scope: TenantScope, runId: string, offset: number, bytes: Buffer): Promise<StreamOutcome> {
    const run = await this.runs.findById(scope, runId);
    if (!run) return { kind: 'not_found' };

    const state = await this.runs.liveState(runId);
    const cursor = state?.streamOffset ?? 0;

    if (state?.status !== 'running' || offset > cursor) {
      // Not running (already closed, or somehow never opened live) or a
      // genuine gap: refuse, and never touch blob storage for either.
      return { kind: 'rejected', nextOffset: cursor };
    }

    if (offset < cursor) {
      // Replay: a no-op, deliberately not calling chunks.put at all — see
      // the docstring above for why writing here (even to the "same" key)
      // is exactly the bug this method exists to not have. No notifier ping
      // either, for the same reason (design §2.3): a replay changes nothing
      // the owner needs to know.
      return { kind: 'accepted', nextOffset: cursor };
    }

    // offset === cursor: the expected next chunk.
    if (offset + bytes.length > this.config.maxBundleBytes) {
      // Reuses the upload path's own cap (config.maxBundleBytes) rather
      // than inventing a second number: nothing here bounds a live run's
      // total size otherwise. LiveChunkStore.assemble's own docstring
      // explicitly declines to bound itself, on the grounds that it "only
      // ever reads back bytes this same run already wrote through put" —
      // that delegates the bound to the caller that decides what gets
      // written in the first place, which is here.
      throw ingestError('BUNDLE_TOO_LARGE', {
        message:
          `Streaming this chunk would carry run ${runId} past the ` +
          `${this.config.maxBundleBytes}-byte limit.`,
        remediation:
          'This live run has reached its size limit. Close it, or raise the configured bundle ' +
          'size limit.',
        detail: { maxBytes: this.config.maxBundleBytes },
      });
    }

    // Write BEFORE advancing -- a crash between the two leaves a duplicate
    // object at the same key (chunkKey is a pure function of runId+offset),
    // which assembly simply overwrites -- safe. The reverse order could
    // report success for bytes that never actually landed, which is a gap.
    await this.chunks.put(runId, offset, bytes);
    const advanced = await this.runs.advanceOffset(runId, offset, offset + bytes.length);
    if (advanced) {
      // Design §2.3: fire-and-forget, and ONLY here -- this is the one
      // branch that just durably landed genuinely new bytes. The replay
      // branch above and the race-recovery re-read below both return
      // `accepted` too, but neither wrote anything this call: a gap or a
      // replay changes nothing the owner needs to know, so pinging there
      // would just cost the owner a wasted readFrom next tick.
      this.notifier.advanced(runId);
      return { kind: 'accepted', nextOffset: offset + bytes.length };
    }

    // Lost a race between the reads above and this CAS: a concurrent chunk
    // at this exact offset landed first, or the run closed in the interim.
    // Re-read rather than assume which — if the cursor has since moved
    // PAST our offset, a rival's write already accepted these same bytes
    // and this is a replay now too; otherwise the run stopped running.
    // No ping here either: the rival's own advanceOffset call already sent
    // one for these bytes, if it landed through this same code path.
    const current = (await this.runs.liveState(runId))?.streamOffset ?? cursor;
    if (offset < current) return { kind: 'accepted', nextOffset: current };
    return { kind: 'rejected', nextOffset: current };
  }

  /**
   * Closes a run. The FIRST write is `claimForClose` — a CAS moving
   * 'running' -> 'parsing' before anything else is decided. That single
   * reordering (this method used to finalize first and flip status last)
   * closes two races at once, not just one:
   *   - A chunk arriving after `finalize` has assembled the log but before
   *     the old code recorded that fact used to be answered 202 and land
   *     silently outside the already-written bundle. Once status leaves
   *     'running' up front, `advanceOffset` rejects it immediately.
   *   - The zero-byte race: reading `stream_offset` used to happen before
   *     any write existed to freeze it, so a byte arriving in that gap
   *     could still be marked `incomplete` out from under it.
   *     `claimForClose` freezes the cursor FIRST — `markIncomplete` (below)
   *     accepts a run in 'parsing', not only 'running', so the zero-byte
   *     path still completes correctly after the claim.
   * It also makes two concurrent `close()` calls for the same run resolve
   * safely on its own: only one caller's claim can win, so this method
   * needs no separate "is someone else already closing this" check.
   *
   * `claimForClose` also sets `parsingStartedAt`, which is what stops the
   * sweeper's 'parsing' staleness check (`apps/worker/src/sweeper.ts`) from
   * measuring a live run's time in `parsing` against its OPEN time — see
   * that column's own docstring (schema.prisma) for why `created_at` was
   * wrong for this specific case, and would otherwise let the sweeper
   * re-enqueue a run this method is still assembling.
   *
   * The body from here is wrapped in `try`/`catch` so a failure UNDOES the
   * claim rather than stranding the run: `LiveChunkStore.finalize` runs a
   * `Promise.all` over every chunk a long live run wrote, `blobs.get` reads
   * the assembled result back to hash it, and either is real network I/O a
   * transient object-store error can interrupt. Before `claimForClose`
   * existed, that kind of failure left the run `running` and a retried
   * `close()` simply worked, because `LiveChunkStore.finalize` is itself
   * idempotent (its own `exists(key)` guard). `releaseClose` restores that:
   * it reverts `'parsing'` back to `'running'` so a retried `close()` can
   * claim it again, and the original error is rethrown unchanged (a 500,
   * same as an unhandled failure always was) rather than swallowed.
   *
   * ═══ BUT ONLY UP TO `finalizeLive`. AFTER THAT, RELEASING LOSES BYTES ═══
   *
   * The `catch` used to span all four steps, and `queue.add` is not like the
   * other three. Once `finalizeLive` commits, `bundleSha256`/`bundleBytes`
   * describe a bundle that is already assembled at `bundleKey` and the
   * per-chunk objects `finalize` consumed are already deleted. Reverting to
   * `'running'` from there is not a retry, it is three separate injuries:
   *
   *   - Nothing sweeps `'running'` back out on the strength of the run being
   *     finished — the sweeper's `running` branch finalizes an idle run as
   *     `incomplete`, which for a run whose bytes are ALL present and
   *     already hashed is a worse answer than the `complete` it had earned.
   *   - `advanceOffset` accepts chunks again (its WHERE wants exactly
   *     `'running'`), so an agent still streaming lands bytes that the
   *     retried `close()` will then silently drop: `finalize`'s `exists(key)`
   *     guard sees `bundleKey` already written, skips the re-assembly,
   *     DELETES the new chunks anyway, and hashes the stale bundle.
   *     `bundleBytes` then disagrees with `stream_offset` and nothing
   *     downstream notices.
   *   - It makes the design's own NFR-AV-5 deviation (§5.1) false, which
   *     turns on Redis being exactly the component that has failed here.
   *
   * So a failure at `queue.add` leaves the run at `'parsing'` with the
   * bundle committed and `parsingStartedAt` set, and recovery is the
   * sweeper's `'parsing'` path re-enqueueing it — which is what that path
   * is for, and which now measures staleness from `parsingStartedAt` rather
   * than the run's open time. The error is still rethrown, so the caller
   * learns the enqueue failed; what it does NOT do is undo work that
   * succeeded. A retried `close()` 409s (`claimForClose` cannot re-match a
   * non-`running` row) — correctly, because there is nothing left for it to
   * do.
   *
   * `releaseClose` itself is called with its own rejection swallowed. It is
   * a compensating write for an error that has already happened, and the
   * run is left at `'parsing'` whether it succeeds or not — so the only
   * thing an unguarded `await` could change is WHICH error the operator is
   * shown, replacing the object-store failure that actually broke with the
   * database failure that merely followed it.
   *
   * `waitFor` runs AFTER the `try`, never inside it — it never throws (a
   * timeout resolves `false`, it does not reject), and it is conditional on
   * `hasData`: the zero-byte path has nothing to wait for, since
   * `markIncomplete` already decided its terminal state synchronously and
   * nothing will ever `pg_notify` for it.
   */
  async close(scope: TenantScope, runId: string): Promise<CloseOutcome> {
    const run = await this.runs.findById(scope, runId);
    if (!run) return { kind: 'not_found' };

    const claimed = await this.runs.claimForClose(runId);
    if (!claimed) return { kind: 'not_running' };

    // HERE, not after `queue.add` below -- design §1.2's `live:closed`. The
    // fold owner still holds this run's advisory lock, and
    // `PipelineService.process` needs that same lock the moment the job
    // below is picked up. Publishing at the claim gives the owner the whole
    // of `finalize` + `assemble` + hashing + `finalizeLive` as a head start
    // on releasing it, instead of racing the enqueue.
    //
    // Fire-and-forget by signature, like the other two channels: a failure
    // here must not fail a close that has already committed its CAS, and a
    // dropped message only costs what this call saves -- the tick's own
    // release pass still drops a run that has left `running`.
    //
    // The `releaseClose` path below can revert this claim on an error
    // before `committed`. If the owner has already acted on this ping, the
    // run returns to `running` unowned and the next tick re-claims it,
    // re-folding from byte 0 -- correct (the fold position is deliberately
    // not persisted, design §2.1), and it costs CPU on an error path only.
    this.notifier.closed(runId);

    let hasData: boolean;
    // Flips the instant this run's terminal state is durably decided —
    // `finalizeLive` for the normal path, `markIncomplete` for the
    // zero-byte one. Past it, reverting the claim would discard a decision
    // rather than retry an attempt (see the docstring above).
    let committed = false;
    try {
      // Safe to read now without racing anything: claimForClose already
      // moved this run off 'running', so no further stream() call can touch
      // stream_offset (advanceOffset's own WHERE requires status: 'running').
      const offset = (await this.runs.liveState(runId))?.streamOffset ?? 0;
      hasData = offset > 0;

      if (!hasData) {
        // A run that never received a byte has no bundleKey object to parse
        // (LiveChunkStore.finalize would write nothing) — enqueuing it would
        // drive PipelineService into a parse failure for a run whose only
        // fault is that nothing was ever sent.
        await this.runs.markIncomplete(runId);
        committed = true;
      } else {
        await this.chunks.finalize(runId, run.bundleKey);
        const assembled = await this.blobs.get(run.bundleKey);
        const sha256 = createHash('sha256').update(assembled).digest('hex');
        await this.runs.finalizeLive(runId, sha256, assembled.length);
        committed = true;

        await this.queue.add(runId);
      }
    } catch (err) {
      if (!committed) await this.runs.releaseClose(runId).catch(() => {});
      throw err;
    }

    if (hasData) {
      // Same wait/re-read shape as IngestController.post: the row is the
      // source of truth, never the notification, so a timeout here still
      // answers correctly off whatever the row says.
      await this.waiter.waitFor(runId, this.config.defaultWaitMs);
    }

    const finalRun = (await this.runs.findById(scope, runId)) ?? run;
    return { kind: 'closed', run: finalRun };
  }
}
