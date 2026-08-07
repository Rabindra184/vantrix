import { createHash, randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { IngestError, ingestError } from '@perfportal/core';
import {
  MetricWriter,
  ProjectRepository,
  RunRepository,
  RuleRepository,
  type RunRecord,
} from '@perfportal/persistence';
import { evaluateRules, type EvaluableRule, type EvaluableStat } from '@perfportal/sla';
import { runEngineAsync, type EngineOptions } from '@perfportal/statistics';
import { BlobStore, openTarGzBundle } from '@perfportal/storage';
import type { PrismaClient } from '@prisma/client';
import type pg from 'pg';
import type { WorkerConfig } from '../config.js';
import { selectPlugin } from './plugins.js';

@Injectable()
export class PipelineService {
  constructor(
    private readonly config: WorkerConfig,
    private readonly prisma: PrismaClient,
    private readonly pool: pg.Pool,
    private readonly blobs: BlobStore,
  ) {}

  async process(runId: string): Promise<void> {
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
      project?.settings.maxDecompressedBundleBytes ?? this.config.maxDecompressedBundleBytes;
    const source = await openTarGzBundle(archive, { maxTotalBytes });
    const { plugin, toolVersion } = await selectPlugin(source.index);

    const result = await runEngineAsync(plugin.parse(source), run.engineOptions as EngineOptions);

    const rules = await new RuleRepository(this.prisma).listEnabled({
      orgId: run.orgId,
      projectId: run.projectId,
    });

    const evaluable: EvaluableStat[] = result.stats.map((s) => ({
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
      sketch: s.sketch,
    }));

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

      await client.query(
        `UPDATE run SET status = 'complete', verdict = $2, tool_version = $3, ingested_at = now()
          WHERE id = $1`,
        [run.id, verdict, toolVersion],
      );

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async #publish(runId: string): Promise<void> {
    await this.pool.query(`SELECT pg_notify('run_terminal', $1)`, [runId]);
  }
}
