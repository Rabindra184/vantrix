import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ingestError } from '@perfportal/core';
import {
  ProjectRepository,
  RunRepository,
  type RunRecord,
} from '@perfportal/persistence';
import { BlobStore } from '@perfportal/storage';
import { IngestMetadataSchema, type IngestMetadata } from '@perfportal/contracts';
import { CONFIG } from '../auth/auth.module.js';
import type { AppConfig } from '../config.js';
import type { Tenant } from '../auth/auth.guard.js';
import { IngestQueue } from './queue.js';

// lowerMs/higherMs deliberately absent: packages/statistics/src/engine.ts's
// EngineOptions no longer accepts indicator bounds at all - bands are folded
// at READ time from the project's current settings.indicators (see
// @perfportal/contracts' ProjectSettingsSchema docstring). Freezing them here
// used to be a double bug: this key list looked for a FLAT lowerMs/higherMs
// that the documented settings shape never writes (it's nested under
// "indicators"), and even a matching value would have landed in
// run.engineOptions only to be silently ignored by an engine that no longer
// reads it - a stale value rewritten on every ingest for no effect.
const ENGINE_KEYS = [
  'warmupMs', 'percentiles',
  'maxEndpoints', 'maxBucketsRun', 'maxBucketsEndpoint',
] as const;

@Injectable()
export class IngestService {
  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly projects: ProjectRepository,
    private readonly runs: RunRepository,
    private readonly blobs: BlobStore,
    private readonly queue: IngestQueue,
  ) {}

  parseMetadata(raw: string): IngestMetadata {
    let json: unknown;
    try {
      json = JSON.parse(raw || '{}');
    } catch {
      throw ingestError('TOOL_UNKNOWN', {
        message: 'The "metadata" field is not valid JSON.',
        remediation: 'Send metadata as a JSON object, for example {"tool":"gatling"}.',
      });
    }
    const parsed = IngestMetadataSchema.safeParse(json);
    if (!parsed.success) {
      throw ingestError('TOOL_UNKNOWN', {
        message: `Invalid metadata: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`,
        remediation:
          'Send {"tool":"gatling"} plus any optional fields. See /v1/openapi.json for the full schema.',
        detail: { issues: parsed.error.issues },
      });
    }
    return parsed.data;
  }

  /**
   * Step order is load-bearing (spec §6.1). The bundle is durable before any
   * row references it, and the run row commits before the job is enqueued.
   * The DB insert and the queue add span two systems and cannot share a
   * transaction, so exactly one inconsistency is reachable — a run with no
   * job — which the sweeper recovers. The reverse order yields a job pointing
   * at a nonexistent run, which is not recoverable.
   */
  async accept(
    tenant: Tenant & { projectId: string },
    metadata: IngestMetadata,
    bundle: Readable,
  ): Promise<RunRecord> {
    const scope = { orgId: tenant.orgId, projectId: tenant.projectId };

    if (metadata.idempotencyKey) {
      const existing = await this.runs.findByIdempotencyKey(scope, metadata.idempotencyKey);
      if (existing) {
        bundle.resume();       // drain, or the connection stalls
        return existing;
      }
    }

    const settings = await this.projects.settings(scope);
    const maxBytes = (settings.maxBundleBytes as number | undefined) ?? this.config.maxBundleBytes;

    const key = `runs/${tenant.projectId}/${randomUUID()}.tgz`;
    const { sha256, bytes } = await this.blobs.putStream(key, bundle, maxBytes);

    let run: RunRecord;
    try {
      run = await this.runs.create({
        orgId: tenant.orgId,
        projectId: tenant.projectId,
        tool: metadata.tool,
        ...(metadata.environment ? { environment: metadata.environment } : {}),
        ...(metadata.branch ? { branch: metadata.branch } : {}),
        ...(metadata.commitSha ? { commitSha: metadata.commitSha } : {}),
        bundleKey: key,
        bundleSha256: sha256,
        bundleBytes: bytes,
        ...(metadata.idempotencyKey ? { idempotencyKey: metadata.idempotencyKey } : {}),
        startedAt: new Date(),
        engineOptions: engineOptionsFrom(settings),
      });
    } catch (err) {
      // Lost a concurrent race against another request sharing this
      // idempotency key: the unique index (projectId, idempotencyKey)
      // rejected our insert after we had already durably uploaded `key`.
      // The winner's row is the one true answer here — behave exactly like
      // the sequential duplicate path above and hand back its run, not a
      // 500. If the re-fetch somehow finds nothing, this wasn't actually an
      // idempotency-key race; rethrow the original error rather than invent
      // a response.
      if (metadata.idempotencyKey && isUniqueConstraintViolation(err)) {
        const winner = await this.runs.findByIdempotencyKey(scope, metadata.idempotencyKey);
        if (winner) {
          await this.deleteOrphanedBundle(key);
          return winner;
        }
      }
      throw err;
    }

    await this.queue.add(run.id);
    return run;
  }

  /**
   * Best-effort cleanup of a bundle no row will ever reference (the loser of
   * an idempotent-create race). A failure here must not fail the request —
   * losing this cleanup leaves the same kind of orphan a lifecycle rule can
   * still reap, whereas failing the request would turn an idempotent
   * endpoint into one that 500s under contention, which is strictly worse.
   */
  private async deleteOrphanedBundle(key: string): Promise<void> {
    try {
      await this.blobs.delete(key);
    } catch (err) {
      console.error('failed to delete orphaned bundle after losing idempotency race', key, err);
    }
  }
}

/** Robust to message-text changes in Prisma: keys on the stable error code. */
function isUniqueConstraintViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

/**
 * Frozen onto the run, not read at parse time. Statistics are meaningful only
 * relative to the warm-up window and percentile set that produced them, and a
 * project changing its warm-up must not silently reinterpret its own history.
 *
 * `settings` is the RAW project.settings JSON (ProjectRepository.settings()),
 * not @perfportal/contracts' validated ProjectSettings: these ENGINE_KEYS are
 * ingest-time engine knobs (and, via the sibling `maxBundleBytes` read in
 * accept() above, a bundle-size cap) that live in the same JSON column but
 * outside that schema's modeled shape, so they are read here unvalidated.
 */
export function engineOptionsFrom(settings: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of ENGINE_KEYS) {
    const v = settings[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}
