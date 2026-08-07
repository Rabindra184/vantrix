import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { Inject, Injectable } from '@nestjs/common';
import { ingestError } from '@perfportal/core';
import {
  ProjectRepository,
  RunRepository,
  type ProjectSettings,
  type RunRecord,
} from '@perfportal/persistence';
import { BlobStore } from '@perfportal/storage';
import { IngestMetadataSchema, type IngestMetadata } from '@perfportal/contracts';
import { CONFIG } from '../auth/auth.module.js';
import type { AppConfig } from '../config.js';
import type { Tenant } from '../auth/auth.guard.js';
import { IngestQueue } from './queue.js';

const ENGINE_KEYS = [
  'warmupMs', 'lowerMs', 'higherMs', 'percentiles',
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
  async accept(tenant: Tenant, metadata: IngestMetadata, bundle: Readable): Promise<RunRecord> {
    const scope = { orgId: tenant.orgId, projectId: tenant.projectId };

    if (metadata.idempotencyKey) {
      const existing = await this.runs.findByIdempotencyKey(scope, metadata.idempotencyKey);
      if (existing) {
        bundle.resume();       // drain, or the connection stalls
        return existing;
      }
    }

    const settings = await this.projects.settings(scope);
    const maxBytes = settings.maxBundleBytes ?? this.config.maxBundleBytes;

    const key = `runs/${tenant.projectId}/${randomUUID()}.tgz`;
    const { sha256, bytes } = await this.blobs.putStream(key, bundle, maxBytes);

    const run = await this.runs.create({
      orgId: tenant.orgId,
      projectId: tenant.projectId,
      tool: metadata.tool,
      bundleKey: key,
      bundleSha256: sha256,
      bundleBytes: bytes,
      ...(metadata.idempotencyKey ? { idempotencyKey: metadata.idempotencyKey } : {}),
      startedAt: new Date(),
      engineOptions: engineOptionsFrom(settings),
    });

    await this.queue.add(run.id);
    return run;
  }
}

/**
 * Frozen onto the run, not read at parse time. Statistics are meaningful only
 * relative to the warm-up window and percentile set that produced them, and a
 * project changing its warm-up must not silently reinterpret its own history.
 */
export function engineOptionsFrom(settings: ProjectSettings): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of ENGINE_KEYS) {
    const v = settings[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}
