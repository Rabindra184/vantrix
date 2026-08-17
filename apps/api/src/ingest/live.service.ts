import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
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
    private readonly prisma: PrismaClient,
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
   * Closes a run. A run that never received a single byte (stream_offset
   * still 0) finalizes as `incomplete` without touching blob storage or the
   * ingest queue: LiveChunkStore.finalize would write nothing for it anyway
   * (there is no bundleKey object to parse), and enqueuing it would drive
   * PipelineService into a parse failure over a run whose only fault is
   * that nothing was ever sent — see markIncomplete's docstring.
   *
   * Otherwise: finalize assembles the chunks into bundleKey, the placeholder
   * bundleSha256/bundleBytes RunRepository.createLive left blank are filled
   * from those exact assembled bytes, and the existing ingest job runs the
   * result through PipelineService unchanged — a streamed run becomes a row
   * indistinguishable from an uploaded one.
   */
  async close(scope: TenantScope, runId: string): Promise<CloseOutcome> {
    const run = await this.runs.findById(scope, runId);
    if (!run) return { kind: 'not_found' };
    if (run.status !== 'running') return { kind: 'not_running' };

    const offset = (await this.runs.liveState(runId))?.streamOffset ?? 0;

    if (offset === 0) {
      await this.runs.markIncomplete(runId);
    } else {
      await this.chunks.finalize(runId, run.bundleKey);
      const assembled = await this.blobs.get(run.bundleKey);
      const sha256 = createHash('sha256').update(assembled).digest('hex');

      // Guarded exactly like advanceOffset/markIncomplete/fail: only writes
      // while still 'running'. Without this, a second close() call racing
      // this one (or a straggling stream() chunk landing in the narrow
      // window between finalize() and this write) could not be told apart
      // from the first — flipping status away from 'running' here is what
      // makes a subsequent stream() call's advanceOffset reject it the same
      // way it rejects any other post-close chunk.
      const { count } = await this.prisma.run.updateMany({
        where: { id: runId, status: 'running' },
        data: { bundleSha256: sha256, bundleBytes: BigInt(assembled.length), status: 'parsing' },
      });

      if (count > 0) {
        await this.queue.add(runId);
        // Same wait/re-read shape as IngestController.post: the row is the
        // source of truth, never the notification, so a timeout here still
        // answers correctly off whatever the row says.
        await this.waiter.waitFor(runId, this.config.defaultWaitMs);
      }
    }

    const finalRun = (await this.runs.findById(scope, runId)) ?? run;
    return { kind: 'closed', run: finalRun };
  }
}
