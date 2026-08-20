import type { RunnerJobWithArtifact } from '@perfportal/persistence';
import {
  ProjectRepository,
  RunnerRepository,
  RunRepository,
} from '@perfportal/persistence';
import { BlobStore, LiveChunkStore } from '@perfportal/storage';
import type { RunnerConfig } from './config.js';
import { prepareGatlingRun } from './artifact.js';
import { RunnerExecutionError, toRunnerJobError } from './errors.js';
import type { RunnerIngestQueue } from './ingest-queue.js';
import { JobLogger } from './job-logger.js';
import { SimulationLogTailer } from './log-tailer.js';
import type { RunnerLiveNotifier } from './live-notifier.js';
import { RunnerLiveSink } from './live-sink.js';
import { spawnAndWait } from './process.js';

export class RunnerExecutor {
  readonly #config: RunnerConfig;
  readonly #projects: ProjectRepository;
  readonly #runner: RunnerRepository;
  readonly #runs: RunRepository;
  readonly #blobs: BlobStore;
  readonly #chunks: LiveChunkStore;
  readonly #queue: RunnerIngestQueue;
  readonly #notifier: RunnerLiveNotifier;

  constructor(opts: {
    config: RunnerConfig;
    projects: ProjectRepository;
    runner: RunnerRepository;
    runs: RunRepository;
    blobs: BlobStore;
    chunks: LiveChunkStore;
    queue: RunnerIngestQueue;
    notifier: RunnerLiveNotifier;
  }) {
    this.#config = opts.config;
    this.#projects = opts.projects;
    this.#runner = opts.runner;
    this.#runs = opts.runs;
    this.#blobs = opts.blobs;
    this.#chunks = opts.chunks;
    this.#queue = opts.queue;
    this.#notifier = opts.notifier;
  }

  async run(job: RunnerJobWithArtifact): Promise<void> {
    const jobId = job.job.id;
    const logger = await JobLogger.create(this.#config.logDir, jobId);
    await this.#runner.setLogPath(jobId, logger.path);
    logger.info(`claimed job ${jobId} (${job.artifact.name})`);

    const sink = new RunnerLiveSink({
      config: this.#config,
      projects: this.#projects,
      runs: this.#runs,
      blobs: this.#blobs,
      chunks: this.#chunks,
      queue: this.#queue,
      notifier: this.#notifier,
    });
    let tailer: SimulationLogTailer | null = null;

    try {
      const runId = await sink.open(job);
      await this.#runner.markRunOpened(jobId, runId);
      logger.info(`opened live run ${runId}`);
      if (await this.#isCancelled(jobId)) {
        await sink.abortIncomplete();
        logger.info(`cancelled job ${jobId} before Gatling started`);
        return;
      }

      const prepared = await prepareGatlingRun(this.#config, job.job, job.artifact);
      if (await this.#isCancelled(jobId)) {
        await sink.abortIncomplete();
        logger.info(`cancelled job ${jobId} before process launch`);
        return;
      }
      tailer = new SimulationLogTailer({
        resultsDir: prepared.resultsDir,
        pollMs: this.#config.logPollIntervalMs,
        onBytes: (bytes) => sink.append(bytes),
      });
      tailer.start();

      logger.info(`starting Gatling: ${prepared.command.command} ${prepared.command.args.join(' ')}`);
      const result = await spawnAndWait(prepared.command, {
        stdoutPrefix: `[gatling ${jobId}] `,
        stderrPrefix: `[gatling ${jobId}] `,
        logOutput: logger.stream,
        stopPollMs: this.#config.pollIntervalMs,
        shouldStop: () => this.#isCancelled(jobId),
      });
      await tailer.stop();
      tailer = null;

      if (result.stopped || (await this.#isCancelled(jobId))) {
        await sink.abortIncomplete();
        logger.info(`cancelled job ${jobId}`);
        return;
      }

      await this.#runner.markClosing(jobId);
      if (result.signal) {
        await sink.abortIncomplete();
        throw new RunnerExecutionError(
          'GATLING_SIGNALLED',
          `Gatling was terminated by ${result.signal}.`,
          'Check host resource limits and runner logs, then queue a new run.',
        );
      }
      if (sink.bytesWritten === 0) {
        await sink.abortIncomplete();
        throw new RunnerExecutionError(
          'SIMULATION_LOG_NOT_FOUND',
          'Gatling finished without producing a simulation.log file.',
          'Confirm the simulation class is correct and the uploaded artifact can run on this node.',
        );
      }

      if (result.code && result.code !== 0) {
        logger.warn(`Gatling exited with code ${result.code}; keeping the run because simulation.log was produced.`);
      }
      await sink.close();
      await this.#runner.markComplete(jobId);
      logger.info(`completed job ${jobId} as run ${sink.runId}`);
    } catch (err) {
      if (tailer) {
        await tailer.stop().catch((tailErr) => logger.error(`failed to stop simulation.log tailer: ${String(tailErr)}`));
      }
      if (sink.runId && !sink.closed) {
        await this.#runner.markClosing(jobId).catch(() => undefined);
        await sink.abortIncomplete().catch((abortErr) => {
          logger.error(`failed to mark run ${sink.runId} incomplete after runner failure: ${String(abortErr)}`);
        });
      }
      const jobError = toRunnerJobError(err);
      await this.#runner.markFailed(jobId, jobError);
      logger.error(`failed job ${jobId}: ${jobError.code}: ${jobError.message}`);
    } finally {
      await logger.close().catch((err) => console.error('failed to close runner job log', err));
    }
  }

  async #isCancelled(jobId: string): Promise<boolean> {
    return (await this.#runner.status(jobId)) === 'cancelled';
  }
}
