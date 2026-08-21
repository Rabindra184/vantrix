import { createHash } from 'node:crypto';
import { engineOptionsFrom } from '@perfportal/core';
import {
  ProjectRepository,
  RunRepository,
  type RunnerJobWithArtifact,
} from '@perfportal/persistence';
import { BlobStore, LiveChunkStore } from '@perfportal/storage';
import type { RunnerConfig } from './config.js';
import { RunnerExecutionError } from './errors.js';
import type { RunnerIngestQueue } from './ingest-queue.js';
import type { RunnerLiveNotifier } from './live-notifier.js';

export class RunnerLiveSink {
  readonly #config: RunnerConfig;
  readonly #projects: ProjectRepository;
  readonly #runs: RunRepository;
  readonly #blobs: BlobStore;
  readonly #chunks: LiveChunkStore;
  readonly #queue: RunnerIngestQueue;
  readonly #notifier: RunnerLiveNotifier;
  #runId: string | null = null;
  #bundleKey: string | null = null;
  #offset = 0;
  #attemptBytes = 0;
  #closed = false;

  constructor(opts: {
    config: RunnerConfig;
    projects: ProjectRepository;
    runs: RunRepository;
    blobs: BlobStore;
    chunks: LiveChunkStore;
    queue: RunnerIngestQueue;
    notifier: RunnerLiveNotifier;
  }) {
    this.#config = opts.config;
    this.#projects = opts.projects;
    this.#runs = opts.runs;
    this.#blobs = opts.blobs;
    this.#chunks = opts.chunks;
    this.#queue = opts.queue;
    this.#notifier = opts.notifier;
  }

  get runId(): string | null {
    return this.#runId;
  }

  get bytesWritten(): number {
    return this.#attemptBytes;
  }

  get closed(): boolean {
    return this.#closed;
  }

  async open(job: RunnerJobWithArtifact): Promise<string> {
    const settings = await this.#projects.settings({
      orgId: job.job.orgId,
      projectId: job.job.projectId,
    });
    const run = await this.#runs.createLive({
      orgId: job.job.orgId,
      projectId: job.job.projectId,
      tool: 'gatling',
      ...(job.job.environment ? { environment: job.job.environment } : {}),
      ...(job.job.branch ? { branch: job.job.branch } : {}),
      ...(job.job.commitSha ? { commitSha: job.job.commitSha } : {}),
      idempotencyKey: `runner:${job.job.id}`,
      startedAt: new Date(),
      engineOptions: engineOptionsFrom(settings),
    });
    this.#runId = run.id;
    this.#bundleKey = run.bundleKey;
    const state = await this.#runs.liveState(run.id);
    this.#offset = state?.streamOffset ?? 0;
    this.#notifier.opened(run.id);
    return run.id;
  }

  async appendAt(fileOffset: number, bytes: Buffer): Promise<void> {
    if (fileOffset < this.#offset) {
      const alreadyWritten = this.#offset - fileOffset;
      if (alreadyWritten >= bytes.length) return;
      bytes = bytes.subarray(alreadyWritten);
      fileOffset = this.#offset;
    }
    if (fileOffset !== this.#offset) {
      throw new RunnerExecutionError(
        'SIMULATION_LOG_GAP',
        `simulation.log jumped from byte ${this.#offset} to ${fileOffset}.`,
        'Check whether Gatling rotated or rewrote simulation.log, then retry the job.',
      );
    }
    await this.append(bytes);
  }

  async append(bytes: Buffer): Promise<void> {
    if (bytes.length === 0) return;
    const runId = this.#requireRunId();
    if (this.#offset + bytes.length > this.#config.maxLogBytes) {
      throw new RunnerExecutionError(
        'SIMULATION_LOG_TOO_LARGE',
        `simulation.log exceeded the ${this.#config.maxLogBytes}-byte live run limit.`,
        'Reduce Gatling result volume for this run or raise MAX_BUNDLE_BYTES.',
      );
    }
    await this.#chunks.put(runId, this.#offset, bytes);
    const advanced = await this.#runs.advanceOffset(runId, this.#offset, this.#offset + bytes.length);
    if (!advanced) {
      throw new RunnerExecutionError(
        'LIVE_STREAM_REJECTED',
        'The live run stopped accepting chunks before the runner finished streaming simulation.log.',
        'Check whether the run was closed by another process or swept as stale, then retry.',
      );
    }
    this.#offset += bytes.length;
    this.#attemptBytes += bytes.length;
    this.#notifier.advanced(runId);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    const runId = this.#requireRunId();
    const claimed = await this.#runs.claimForClose(runId);
    if (!claimed) {
      this.#closed = true;
      return;
    }

    this.#notifier.closed(runId);
    let committed = false;
    // This finalize/hash/release sequence deliberately mirrors
    // LiveService.close() (apps/api/src/ingest/live.service.ts) step for
    // step, but is not extracted to @perfportal/core: that method wraps a
    // Nest-injected LiveService with a different dependency shape (its own
    // config/repository/blob-store instances via DI, not the plain
    // constructor-injected fields here), so sharing it would mean sharing a
    // framework-shaped interface a dependency-light package should not take
    // on. Keep the two in sync by hand if this sequence changes.
    try {
      const state = await this.#runs.liveState(runId);
      const authoritativeOffset = state?.streamOffset ?? this.#offset;
      if (authoritativeOffset === 0) {
        await this.#runs.markIncomplete(runId);
        committed = true;
        this.#closed = true;
        return;
      }

      const bundleKey = this.#bundleKey;
      if (!bundleKey) {
        throw new RunnerExecutionError(
          'LIVE_RUN_BUNDLE_KEY_MISSING',
          'The opened live run did not return a bundle key.',
          'Check runner and API versions, then retry the job.',
        );
      }
      await this.#chunks.finalize(runId, bundleKey);
      const bundle = await this.#blobs.get(bundleKey);
      const sha256 = createHash('sha256').update(bundle).digest('hex');
      await this.#runs.finalizeLive(runId, sha256, bundle.length);
      committed = true;
      this.#closed = true;
      await this.#enqueueForParsing(runId);
    } catch (err) {
      if (!committed) {
        await this.#runs.releaseClose(runId).catch((releaseErr: unknown) => {
          console.error('failed to release live close claim', releaseErr);
        });
      }
      throw err;
    }
  }

  async abortIncomplete(): Promise<void> {
    if (this.#closed) return;
    const runId = this.#requireRunId();
    const claimed = await this.#runs.claimForClose(runId);
    if (!claimed) {
      this.#closed = true;
      return;
    }
    this.#notifier.closed(runId);
    await this.#runs.markIncomplete(runId);
    this.#closed = true;
  }

  #requireRunId(): string {
    if (!this.#runId) {
      throw new RunnerExecutionError(
        'LIVE_RUN_NOT_OPEN',
        'The runner tried to stream before opening a live run.',
        'Check the runner process logs and retry the job.',
      );
    }
    return this.#runId;
  }

  async #enqueueForParsing(runId: string): Promise<void> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await this.#queue.add(runId);
        return;
      } catch (err) {
        lastError = err;
        if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
      }
    }
    throw new RunnerExecutionError(
      'INGEST_QUEUE_UNAVAILABLE',
      `Run ${runId} was finalized but could not be queued for parsing: ${String(lastError)}`,
      'Check Redis and queue workers, then retry queueing or inspect the finalized run object.',
    );
  }
}
