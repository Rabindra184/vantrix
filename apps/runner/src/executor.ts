import { rm } from 'node:fs/promises';
import os from 'node:os';
import type { RunnerJobEventInput, RunnerJobWithArtifact } from '@perfportal/persistence';
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
import {
  endedEarly,
  endedEarlyEvent,
  endedEarlyMessage,
  endedEarlyRemediation,
  failureEventMessage,
  injectionEndReason,
  wasTerminated,
} from './run-events.js';

/**
 * How far a job got, which is what decides how a cancelled job's log ends: a
 * run that never opened, one that opened but never started Gatling, one whose
 * process was running.
 *
 * `ending` is past all of those: the injection has ENDED and the log says so,
 * so what is left is deciding the run's outcome — and a cancel landing in
 * there changes nothing about it. It is not a stage a cancelled job's log can
 * end from (its cancelled ending would write the injection and Ending lines a
 * second time), so `#recordCancelledEnding` does not take it.
 */
type RunStage = 'claimed' | 'opened' | 'spawned' | 'ending';

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
    const sink = new RunnerLiveSink({
      config: this.#config,
      projects: this.#projects,
      runs: this.#runs,
      blobs: this.#blobs,
      chunks: this.#chunks,
      queue: this.#queue,
      notifier: this.#notifier,
    });
    let logger: JobLogger | null = null;
    let tailer: SimulationLogTailer | null = null;
    let workDir: string | null = null;
    let stage: RunStage = 'claimed';
    // How the log ends when Gatling ended early. Set just before the throw
    // that fails the job, and read by the catch, which is the ONE place a
    // failed job's log gets its last line.
    let endedEarlyLine: string | null = null;
    // The records made when the process starts. Hoisted so the catch can wait
    // for them: an ending must never land before the start lines.
    let started: Promise<void> = Promise.resolve();
    const logError = (message: string) => {
      if (logger) logger.error(message);
      else console.error(`[runner] [error] ${message}`);
    };

    // ═══ THE RUN'S EVENTS — BEST-EFFORT, BY DESIGN ═══
    // (docs/superpowers/specs/2026-09-29-run-logs-design.md)
    //
    // These exist to explain a run on its Logs tab. A database hiccup must not
    // cost somebody the load test they are trying to watch, so a failed write
    // is logged to the job log and the job goes on. async + try, not
    // `.catch()`: a writer that throws SYNCHRONOUSLY must be caught too.
    const record = async (event: RunnerJobEventInput): Promise<void> => {
      try {
        await this.#runner.recordRunnerEvent(jobId, event);
      } catch (err) {
        logError(`failed to record run event "${event.phase ?? event.message}": ${String(err)}`);
      }
    };

    try {
      logger = await JobLogger.create(this.#config.logDir, jobId);
      await this.#runner.setLogPath(jobId, logger.path);
      logger.info(`claimed job ${jobId} (${job.job.name})`);
      await record({ message: `Claimed by the runner on '${os.hostname()}'` });
      await record({ phase: 'Deploying' });

      // Fail closed BEFORE opening a live run: never execute uploaded code as
      // the runner's own uid. Throwing here marks the job failed with an
      // actionable remediation rather than silently running attacker code
      // alongside the control-plane credentials.
      this.#assertUidIsolation();

      const runId = await sink.open(job);
      const opened = await this.#runner.markRunOpened(jobId, runId);
      if (!opened) {
        await sink.abortIncomplete();
        logger.info(`job ${jobId} was cancelled before live run ${runId} could attach`);
        await this.#recordCancelledEnding(record, 'claimed');
        return;
      }
      stage = 'opened';
      logger.info(`opened live run ${runId}`);
      if (await this.#isCancelled(jobId)) {
        await sink.abortIncomplete();
        logger.info(`cancelled job ${jobId} before Gatling started`);
        await this.#recordCancelledEnding(record, 'opened');
        return;
      }

      const prepared = await prepareGatlingRun(this.#config, job.job, job.artifact, () => this.#isCancelled(jobId));
      workDir = prepared.workDir;
      await record({ message: 'Package prepared' });
      if (await this.#isCancelled(jobId)) {
        await sink.abortIncomplete();
        logger.info(`cancelled job ${jobId} before process launch`);
        await this.#recordCancelledEnding(record, 'opened');
        return;
      }
      tailer = new SimulationLogTailer({
        resultsDir: prepared.resultsDir,
        pollMs: this.#config.logPollIntervalMs,
        onBytes: (offset, bytes) => sink.appendAt(offset, bytes),
        logger,
      });
      tailer.start();

      logger.info(`starting Gatling: ${prepared.command.command} ${prepared.command.args.join(' ')}`);
      // "Started" is recorded when the OS reports the process running, not
      // when this line asks for it, so a command that cannot be launched never
      // gets the line. It is AWAITED before the end is recorded, so the two can
      // never land out of order.
      const result = await spawnAndWait(prepared.command, {
        stdoutPrefix: `[gatling ${jobId}] `,
        stderrPrefix: `[gatling ${jobId}] `,
        logOutput: logger.stream,
        stopPollMs: this.#config.pollIntervalMs,
        shouldStop: () => this.#heartbeatAndCheckCancelled(jobId),
        onSpawn: () => {
          stage = 'spawned';
          started = (async () => {
            await record({ message: 'Gatling process started and ready to inject traffic' });
            await record({ phase: 'Injecting' });
          })();
        },
      });
      await started;
      await tailer.stop();
      tailer = null;

      if (result.stopped || (await this.#isCancelled(jobId))) {
        await sink.abortIncomplete();
        logger.info(`cancelled job ${jobId}`);
        await this.#recordCancelledEnding(record, 'spawned');
        return;
      }

      await record({ message: `Run injection ended with reason '${injectionEndReason(result)}'` });
      await record({ phase: 'Ending' });
      await this.#runner.markClosing(jobId);
      stage = 'ending';
      if (sink.bytesWritten === 0) {
        await sink.abortIncomplete();
        // A signal OR an exit code above 128: a JVM that handles SIGTERM
        // itself exits 143 with no signal at all, and that is not a simulation
        // class that could not be found.
        const terminated = wasTerminated(result);
        throw new RunnerExecutionError(
          terminated ? 'GATLING_SIGNALLED' : 'SIMULATION_LOG_NOT_FOUND',
          terminated
            ? `${injectionEndReason(result)} before simulation.log was produced.`
            : 'Gatling finished without producing a simulation.log file.',
          terminated
            ? 'Check host resource limits and runner logs, then queue a new run.'
            : 'Confirm the simulation class is correct and the uploaded artifact can run on this node.',
        );
      }

      // ═══ A GATLING THAT DIED PART-WAY IS AN ABANDONED STREAM ═══
      //
      // This closed every such run as finished and marked its job complete;
      // the pipeline then met the half-record the dying process left and
      // failed the run `LOG_MALFORMED`, blaming an archive nobody made, while
      // the job read "complete". Closing it as abandoned keeps what it
      // measured on an `incomplete` run, and the job fails naming how Gatling
      // ended — the same pattern as the no-simulation.log branch above: settle
      // the run, then throw so the catch fails the job and ends its log.
      //
      // WHAT IS CLAIMED IS THE EVIDENCE, NOT THE SIMULATION. An exit that is
      // neither 0 nor 2 can still follow a simulation that ran to its end — an
      // `after {}` hook throwing, or the assertion re-read running out of
      // memory — so the message says how the process ended and that it is not
      // a finished simulation's code, and never "before the simulation
      // finished". And it says what became of the DATA from what
      // `closeAbandoned` reports, because a run that fell back to no
      // statistics must not be described as having kept them.
      if (endedEarly(result)) {
        logger.warn(`${injectionEndReason(result)} rather than a finished simulation's exit code; closing the run as abandoned.`);
        const outcome = await sink.closeAbandoned();
        logger.info(`run ${sink.runId} closed as abandoned: ${outcome}`);
        endedEarlyLine = endedEarlyEvent(result, outcome);
        throw new RunnerExecutionError(
          'GATLING_ENDED_EARLY',
          endedEarlyMessage(result),
          endedEarlyRemediation(outcome),
        );
      }
      if (result.code === 2) {
        logger.warn('Gatling exited with code 2: a Gatling assertion failed, and the simulation ran to its end.');
      }
      await sink.close();
      await this.#runner.markComplete(jobId);
      logger.info(`completed job ${jobId} as run ${sink.runId}`);
      await record({ message: 'Run ended' });
    } catch (err) {
      if (tailer) {
        await tailer.stop().catch((tailErr) => logError(`failed to stop simulation.log tailer: ${String(tailErr)}`));
      }
      if (sink.runId && !sink.closed) {
        await this.#runner.markClosing(jobId).catch(() => undefined);
        await sink.abortIncomplete().catch((abortErr) => {
          logError(`failed to mark run ${sink.runId} incomplete after runner failure: ${String(abortErr)}`);
        });
      }
      const jobError = toRunnerJobError(err);
      await this.#runner.markFailed(jobId, jobError).catch((markErr) => {
        logError(`failed to mark job ${jobId} failed: ${String(markErr)}`);
      });
      logError(`failed job ${jobId}: ${jobError.code}: ${jobError.message}`);
      // The job's own state decides how the log ends, not the error thrown: a
      // cancel during extraction or launch fails the step, `markFailed` leaves
      // a cancelled job cancelled, and a log saying "failed" would contradict
      // it. Whatever the ending, the start lines land first.
      //
      // BUT NOT ONCE THE INJECTION HAS ENDED. From `ending` on, the log
      // already holds the injection-ended line and the Ending phase, and the
      // outcome is decided — a cancel racing the close (or the runner's own
      // shutdown, which cancels the job and then awaits this very run) must
      // not write them again under a "Run ended without results" over a run
      // that kept its results. A run Gatling ended early ends on that fact; any
      // other failure from there ends on the failure.
      await started;
      if (endedEarlyLine !== null) {
        await record({ message: endedEarlyLine });
      } else if (stage !== 'ending' && (await this.#isCancelled(jobId).catch(() => false))) {
        await this.#recordCancelledEnding(record, stage);
      } else {
        await record({ message: failureEventMessage(jobError, job.artifact.storagePath) });
      }
    } finally {
      if (workDir) await rm(workDir, { recursive: true, force: true }).catch((err) => logError(`failed to clean work dir: ${String(err)}`));
      await logger?.close().catch((err) => console.error('failed to close runner job log', err));
    }
  }

  /**
   * How a cancelled job's log ends, by how far it got (spec ruling 3). One
   * definition for the early returns and for the catch, so the two cannot
   * drift into telling different stories about the same cancel.
   */
  async #recordCancelledEnding(
    record: (event: RunnerJobEventInput) => Promise<void>,
    stage: Exclude<RunStage, 'ending'>,
  ): Promise<void> {
    if (stage === 'claimed') {
      await record({ message: 'Cancelled before the run opened' });
      return;
    }
    if (stage === 'opened') {
      await record({ message: 'Cancelled before Gatling started' });
      await record({ message: 'Run ended without results' });
      return;
    }
    await record({ message: "Run injection ended with reason 'Cancelled'" });
    await record({ phase: 'Ending' });
    await record({ message: 'Run ended without results' });
  }

  async #isCancelled(jobId: string): Promise<boolean> {
    return (await this.#runner.status(jobId)) === 'cancelled';
  }

  // Refuse to launch an uploaded simulation under the runner's own user. With
  // no child uid configured, `spawn`'s `uid` is `undefined` and the child
  // inherits this process's uid — and therefore its ambient access to the
  // control-plane network and any credentials reachable from it. This is a
  // hardening step, not full isolation: it closes the fail-OPEN default, but a
  // genuinely multi-tenant install still needs per-job container/namespace and
  // network isolation (tracked separately). Opt out only on a trusted
  // single-tenant host via RUNNER_ALLOW_SAME_UID=true.
  #assertUidIsolation(): void {
    if (this.#config.allowSameUidExecution) return;
    const selfUid = typeof process.getuid === 'function' ? process.getuid() : null;
    const childUid = this.#config.childUid;
    if (childUid === null || (selfUid !== null && childUid === selfUid)) {
      throw new RunnerExecutionError(
        'RUNNER_UID_ISOLATION_REQUIRED',
        "Refusing to execute an uploaded simulation as the runner's own user; " +
          'uploaded code would share the control-plane process credentials and network reach.',
        'Set RUNNER_CHILD_UID (and RUNNER_CHILD_GID) to an unprivileged user distinct ' +
          'from the runner process, or set RUNNER_ALLOW_SAME_UID=true only on a trusted ' +
          'single-tenant host.',
      );
    }
  }

  async #heartbeatAndCheckCancelled(jobId: string): Promise<boolean> {
    await this.#runner.heartbeat(jobId).catch((err) => {
      console.error(`failed to heartbeat runner job ${jobId}`, err);
    });
    return this.#isCancelled(jobId);
  }
}
