import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { Inject, Injectable } from '@nestjs/common';
import { engineOptionsFrom, ingestError } from '@perfportal/core';
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
        // Frozen at accept time beside the three above, and the same kind of
        // thing: what the CALLER asserts, never what the platform measured.
        // The worker resolves it against a real `test` row once it has the
        // simulation class too — see `resolveTestId`.
        ...(metadata.test ? { declaredTestSlug: metadata.test } : {}),
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
  return typeof err === 'object' && err !== null && 'code' in err && err.code === 'P2002';
}
