import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
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
import { engineOptionsFrom } from './ingest.service.js';
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
  ) {}

  /**
   * Opens a run that will be fed by POST /v1/runs/:id/stream rather than a
   * bundle upload. Freezes environment/branch/commitSha/engineOptions the
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
      ...(body.idempotencyKey ? { idempotencyKey: body.idempotencyKey } : {}),
      startedAt: new Date(),
      engineOptions: engineOptionsFrom(settings),
    });

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
   * succeeded). It still writes — rewriting the same key with the same
   * bytes is a harmless overwrite of real, already-accepted data, never
   * something to clean up the way a gap's orphan is.
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
      // Replay.
      await this.chunks.put(runId, offset, bytes);
      return { kind: 'accepted', nextOffset: cursor };
    }

    // offset === cursor: the expected next chunk. Write BEFORE advancing --
    // a crash between the two leaves a duplicate object at the same key
    // (chunkKey is a pure function of runId+offset), which assembly simply
    // overwrites -- safe. The reverse order could report success for bytes
    // that never actually landed, which is a gap.
    await this.chunks.put(runId, offset, bytes);
    const advanced = await this.runs.advanceOffset(runId, offset, offset + bytes.length);
    if (advanced) return { kind: 'accepted', nextOffset: offset + bytes.length };

    // Lost a race between the reads above and this CAS: a concurrent chunk
    // at this exact offset landed first, or the run closed in the interim.
    // Re-read rather than assume which — if the cursor has since moved
    // PAST our offset, a rival's write already accepted these same bytes
    // and this is a replay now too; otherwise the run stopped running.
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
   */
  async close(scope: TenantScope, runId: string): Promise<CloseOutcome> {
    const run = await this.runs.findById(scope, runId);
    if (!run) return { kind: 'not_found' };

    const claimed = await this.runs.claimForClose(runId);
    if (!claimed) return { kind: 'not_running' };

    // Safe to read now without racing anything: claimForClose already
    // moved this run off 'running', so no further stream() call can touch
    // stream_offset (advanceOffset's own WHERE requires status: 'running').
    const offset = (await this.runs.liveState(runId))?.streamOffset ?? 0;

    if (offset === 0) {
      // A run that never received a byte has no bundleKey object to parse
      // (LiveChunkStore.finalize would write nothing) — enqueuing it would
      // drive PipelineService into a parse failure for a run whose only
      // fault is that nothing was ever sent.
      await this.runs.markIncomplete(runId);
    } else {
      await this.chunks.finalize(runId, run.bundleKey);
      const assembled = await this.blobs.get(run.bundleKey);
      const sha256 = createHash('sha256').update(assembled).digest('hex');
      await this.runs.finalizeLive(runId, sha256, assembled.length);

      await this.queue.add(runId);
      // Same wait/re-read shape as IngestController.post: the row is the
      // source of truth, never the notification, so a timeout here still
      // answers correctly off whatever the row says.
      await this.waiter.waitFor(runId, this.config.defaultWaitMs);
    }

    const finalRun = (await this.runs.findById(scope, runId)) ?? run;
    return { kind: 'closed', run: finalRun };
  }
}
