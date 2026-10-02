import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ProjectRepository,
  RunnerJobEventInput,
  RunnerJobWithArtifact,
  RunRepository,
} from '@perfportal/persistence';
import type { BlobStore, LiveChunkStore } from '@perfportal/storage';
import { prepareGatlingRun } from '../src/artifact.js';
import type { RunnerConfig } from '../src/config.js';
import { RunnerExecutionError } from '../src/errors.js';
import { RunnerExecutor } from '../src/executor.js';
import type { RunnerIngestQueue } from '../src/ingest-queue.js';
import type { RunnerLiveNotifier } from '../src/live-notifier.js';
import { RunnerLiveSink, type AbandonedOutcome } from '../src/live-sink.js';
import { SimulationLogTailer } from '../src/log-tailer.js';
import { spawnAndWait, type ProcessResult } from '../src/process.js';

/**
 * ═══ WHAT THE RUNNER TELLS A RUN'S LOGS TAB, PATH BY PATH ═══
 * (docs/superpowers/specs/2026-09-29-run-logs-design.md)
 *
 * The sink, the artifact preparation, the process and the tailer are replaced
 * so each path can be driven exactly; what is real is the executor's own
 * sequencing and its calls to `recordRunnerEvent`, which is what these assert.
 */
vi.mock('../src/live-sink.js', () => ({ RunnerLiveSink: vi.fn() }));
vi.mock('../src/artifact.js', () => ({ prepareGatlingRun: vi.fn() }));
vi.mock('../src/process.js', () => ({ spawnAndWait: vi.fn() }));
vi.mock('../src/log-tailer.js', () => ({ SimulationLogTailer: vi.fn() }));

const JOB_ID = '11111111-1111-4111-8111-111111111111';
const RUN_ID = '44444444-4444-4444-8444-444444444444';
const STORAGE = 'runner-artifacts/5f0c6a52-6d1e-4c1b-9b1e-2f5c7e8a9d10.jar';
const CLAIMED = `Claimed by the runner on '${os.hostname()}'`;
const STARTED = 'Gatling process started and ready to inject traffic';
const LEAKS = ['PARAM-LEAK', '-Xmx7g', 'leak.', STORAGE, 'io.gatling.app.Gatling'] as const;

let logDir: string;
let workDir: string;

beforeEach(async () => {
  logDir = await mkdtemp(path.join(os.tmpdir(), 'runner-events-log-'));
  workDir = await mkdtemp(path.join(os.tmpdir(), 'runner-events-work-'));
});

afterEach(async () => {
  vi.clearAllMocks();
  await rm(logDir, { recursive: true, force: true });
  await rm(workDir, { recursive: true, force: true });
});

function job(): RunnerJobWithArtifact {
  const now = new Date('2026-09-29T11:41:00.000Z');
  return {
    artifact: {
      id: '55555555-5555-4555-8555-555555555555', orgId: '22222222-2222-4222-8222-222222222222',
      projectId: '33333333-3333-4333-8333-333333333333', name: 'checkout load', filename: 'checkout.jar',
      kind: 'gatling_jar', simulationClass: 'example.ParitySimulation', gatlingVersion: '3.15.1',
      sha256: 'a'.repeat(64), bytes: 4096, storagePath: STORAGE, createdAt: now,
    },
    job: {
      id: JOB_ID, orgId: '22222222-2222-4222-8222-222222222222', projectId: '33333333-3333-4333-8333-333333333333',
      artifactId: '55555555-5555-4555-8555-555555555555', runId: null, status: 'starting', requestedBy: 'tester',
      environment: null, branch: null, commitSha: null, testSlug: null,
      javaOptions: '-Xmx7g -Dleak.secret=PARAM-LEAK-7f3a', systemProperties: { 'leak.key': 'PARAM-LEAK-91c2' },
      logPath: null, error: null, createdAt: now, updatedAt: now,
    },
  };
}

interface HarnessOptions {
  readonly config?: Partial<RunnerConfig>;
  /** What `runner.status` answers, in order; `running` once exhausted. */
  readonly statuses?: readonly string[];
  readonly result?: ProcessResult;
  readonly bytesWritten?: number;
  /** What `closeAbandoned` reports it did; `kept` unless a case says otherwise. */
  readonly abandoned?: AbandonedOutcome;
  readonly opened?: boolean;
  readonly recordFails?: boolean;
  readonly prepare?: typeof prepareGatlingRun;
}

function harness(opts: HarnessOptions = {}) {
  const statuses = [...(opts.statuses ?? [])];
  const runner = {
    setLogPath: vi.fn().mockResolvedValue(undefined),
    markRunOpened: vi.fn().mockResolvedValue(opts.opened ?? true),
    markClosing: vi.fn().mockResolvedValue(undefined),
    markComplete: vi.fn().mockResolvedValue(undefined),
    markFailed: vi.fn().mockResolvedValue(undefined),
    heartbeat: vi.fn().mockResolvedValue(undefined),
    status: vi.fn(async () => statuses.shift() ?? 'running'),
    recordRunnerEvent: opts.recordFails
      ? vi.fn().mockRejectedValue(new Error('database unavailable'))
      : vi.fn().mockResolvedValue(undefined),
  };
  const sink = {
    open: vi.fn().mockResolvedValue(RUN_ID),
    // Both close the sink, as the real ones do: the executor's catch reads
    // `closed` to decide whether a run still needs aborting.
    abortIncomplete: vi.fn(async () => {
      sink.closed = true;
    }),
    close: vi.fn().mockResolvedValue(undefined),
    closeAbandoned: vi.fn(async (): Promise<AbandonedOutcome> => {
      sink.closed = true;
      return opts.abandoned ?? 'kept';
    }),
    appendAt: vi.fn().mockResolvedValue(undefined),
    bytesWritten: opts.bytesWritten ?? 2048,
    runId: RUN_ID,
    closed: false,
  };
  vi.mocked(RunnerLiveSink).mockImplementation(function fakeSink() { return sink; } as never);
  vi.mocked(SimulationLogTailer).mockImplementation(function fakeTailer() {
    return { start: vi.fn(), stop: vi.fn().mockResolvedValue(undefined) };
  } as never);
  vi.mocked(prepareGatlingRun).mockImplementation(opts.prepare ?? (async () => ({
    command: {
      command: 'java',
      args: ['-Xmx7g', '-Dleak.secret=PARAM-LEAK-7f3a', '-Dleak.key=PARAM-LEAK-91c2', '-cp', `/srv/${STORAGE}`, 'io.gatling.app.Gatling'],
      cwd: workDir,
    },
    resultsDir: path.join(workDir, 'results'),
    workDir,
  })));
  vi.mocked(spawnAndWait).mockImplementation(async (_command, spawnOpts) => {
    spawnOpts?.onSpawn?.();
    return opts.result ?? { code: 0, signal: null, stopped: false };
  });
  const config = {
    logDir, allowSameUidExecution: true, childUid: null, childGid: null,
    logPollIntervalMs: 50, pollIntervalMs: 50, ...opts.config,
  } as RunnerConfig;
  const executor = new RunnerExecutor({
    config,
    projects: {} as unknown as ProjectRepository,
    runner: runner as never,
    runs: {} as unknown as RunRepository,
    blobs: {} as unknown as BlobStore,
    chunks: {} as unknown as LiveChunkStore,
    queue: {} as unknown as RunnerIngestQueue,
    notifier: {} as unknown as RunnerLiveNotifier,
  });
  return { executor, runner, sink };
}

/** What the runner recorded, as the Logs tab would print it. */
function recorded(runner: ReturnType<typeof harness>['runner']): string[] {
  return runner.recordRunnerEvent.mock.calls.map((call: unknown[]) => {
    const event = call[1] as RunnerJobEventInput;
    return event.phase !== undefined ? `--- ${event.phase}` : event.message;
  });
}

describe('the runner’s events, path by path', () => {
  it('walks a clean run from claim to end, against its own job', async () => {
    const { executor, runner } = harness();
    await executor.run(job());
    expect(recorded(runner)).toEqual([
      CLAIMED, '--- Deploying', 'Package prepared', STARTED, '--- Injecting',
      "Run injection ended with reason 'Run completed normally'", '--- Ending', 'Run ended',
    ]);
    expect(runner.recordRunnerEvent.mock.calls.every((call: unknown[]) => call[0] === JOB_ID)).toBe(true);
    expect(runner.markComplete).toHaveBeenCalledTimes(1);
  });

  it('names exit 2 — a failed Gatling assertion — and closes the run as finished', async () => {
    const { executor, runner, sink } = harness({ result: { code: 2, signal: null, stopped: false } });
    await executor.run(job());
    expect(recorded(runner).slice(-3)).toEqual([
      "Run injection ended with reason 'Gatling exited with code 2'", '--- Ending', 'Run ended',
    ]);
    // The simulation ran to its end and only its own assertion failed, so the
    // log is whole and the run is complete.
    expect(sink.close).toHaveBeenCalledTimes(1);
    expect(sink.closeAbandoned).not.toHaveBeenCalled();
    expect(runner.markComplete).toHaveBeenCalledTimes(1);
    expect(runner.markFailed).not.toHaveBeenCalled();
  });

  /**
   * ═══ A GATLING THAT DIED PART-WAY IS AN ABANDONED STREAM ═══
   *
   * This closed the run normally and marked the job `complete`. The pipeline
   * then met the half-record a dying process leaves and failed the run
   * `LOG_MALFORMED`, telling the reader to check an archive nobody made,
   * while the job beside it read "complete". Measured on a real run killed
   * 25 s in: exit 143, `needed 4 bytes at 8190, have 0`.
   *
   * It closes the run as abandoned now — the sweeper's treatment of a
   * producer that stopped — so the run ends `incomplete` with what it
   * measured, and the job FAILS, naming how Gatling ended. The run's LOG ends
   * on the RUN's outcome, not on the job's failure: a run that ended
   * `incomplete` did not fail, and `Run failed: …` over it said it had.
   */
  it.each([
    ['a signal', { code: null, signal: 'SIGKILL' as const }, 'Gatling was terminated by SIGKILL'],
    ['a JVM-handled SIGTERM', { code: 143, signal: null }, 'Gatling exited with code 143'],
  ])('closes the run as abandoned and fails the job when Gatling ends early (%s)', async (_label, ended, reason) => {
    const { executor, runner, sink } = harness({ result: { ...ended, stopped: false } });
    await executor.run(job());

    expect(sink.closeAbandoned).toHaveBeenCalledTimes(1);
    expect(sink.close).not.toHaveBeenCalled();
    // Abandoned is not aborted: the run keeps its data.
    expect(sink.abortIncomplete).not.toHaveBeenCalled();
    expect(runner.markComplete).not.toHaveBeenCalled();
    expect(runner.markFailed).toHaveBeenCalledWith(JOB_ID, expect.objectContaining({ code: 'GATLING_ENDED_EARLY' }));
    expect(recorded(runner).slice(-3)).toEqual([
      `Run injection ended with reason '${reason}'`,
      '--- Ending',
      `Run ended early: ${reason}. What it measured was kept.`,
    ]);
    expect(recorded(runner).some((line) => line.startsWith('Run failed'))).toBe(false);
  });

  /**
   * THE JOB'S MESSAGE STATES THE EVIDENCE, NOT A CLAIM ABOUT THE SIMULATION.
   * Exit 1 can follow a simulation that ran to its end (an `after {}` hook
   * throwing, the assertion re-read running out of memory), so "before the
   * simulation finished" would sometimes be false.
   */
  it.each([
    ['a signal', { code: null, signal: 'SIGKILL' as const }, 'Gatling was terminated by SIGKILL'],
    ['exit 1', { code: 1, signal: null }, 'Gatling exited with code 1'],
  ])('fails the job on how Gatling ended, never on where the simulation was (%s)', async (_label, ended, reason) => {
    const { executor, runner } = harness({ result: { ...ended, stopped: false } });
    await executor.run(job());

    const [, error] = runner.markFailed.mock.calls[0] as [string, { code: string; message: string; remediation: string }];
    expect(error.message).toBe(
      `${reason} rather than a finished simulation's exit code (0, or 2 when a Gatling assertion failed).`,
    );
    expect(error.message).not.toMatch(/before the simulation/i);
  });

  /**
   * WHAT THE RUN KEPT IS WHAT `closeAbandoned` SAYS IT KEPT. The sink falls
   * back to `incomplete` with no statistics on a storage error, a log with no
   * whole record, or no bytes; a job message and a Logs ending that said the
   * run kept what it measured over that would be wrong.
   */
  it.each([
    ['empty', 'Nothing it measured could be kept.', /without statistics/],
    ['not_claimed', 'Nothing it measured could be kept.', /already closed the run/],
  ] as const)('says the data was not kept when closeAbandoned reports %s', async (outcome, kept, remediation) => {
    const { executor, runner } = harness({
      result: { code: 143, signal: null, stopped: false },
      abandoned: outcome,
    });
    await executor.run(job());

    expect(recorded(runner).slice(-1)).toEqual([`Run ended early: Gatling exited with code 143. ${kept}`]);
    const [, error] = runner.markFailed.mock.calls[0] as [string, { remediation: string }];
    expect(error.remediation).toMatch(remediation);
    expect(error.remediation).not.toMatch(/keeps what it measured/);
  });

  /**
   * A SIGTERM THE JVM HANDLES ITSELF IS EXIT 143 WITH NO SIGNAL, and one that
   * lands before Gatling's first flush leaves no simulation.log. Keyed on
   * `result.signal` alone it read as an ordinary exit and sent the operator to
   * check the simulation class.
   */
  it.each([
    ['a signal', { code: null, signal: 'SIGKILL' as const }, 'Gatling was terminated by SIGKILL'],
    ['a JVM-handled SIGTERM', { code: 143, signal: null }, 'Gatling exited with code 143'],
  ])('fails a terminated Gatling that wrote no simulation.log as terminated (%s)', async (_label, ended, reason) => {
    const { executor, runner, sink } = harness({ bytesWritten: 0, result: { ...ended, stopped: false } });
    await executor.run(job());

    expect(sink.abortIncomplete).toHaveBeenCalledTimes(1);
    expect(sink.closeAbandoned).not.toHaveBeenCalled();
    const [, error] = runner.markFailed.mock.calls[0] as [string, { code: string; remediation: string }];
    expect(error.code).toBe('GATLING_SIGNALLED');
    expect(error.remediation).not.toMatch(/simulation class/);
    expect(recorded(runner).slice(-1)).toEqual([
      `Run failed: GATLING_SIGNALLED: ${reason} before simulation.log was produced.`,
    ]);
  });

  /**
   * AFTER THE INJECTION ENDED, A CANCEL CHANGES NOTHING. The early exit
   * records the injection and the Ending phase, then spends S3 reads and up to
   * three seconds of queue retries in `closeAbandoned` — a window in which a
   * cancel (or the runner's own shutdown, which cancels the job and awaits this
   * run) can land. The catch then wrote the cancelled ending: a second
   * injection-ended line, a second Ending and "Run ended without results" over
   * a run that kept its results.
   */
  it('ends on the early exit, not on a cancel that lands while the run is being closed', async () => {
    // status(): after the open, after the package, after the process, then the catch.
    const { executor, runner } = harness({
      result: { code: 143, signal: null, stopped: false },
      statuses: ['running', 'running', 'running', 'cancelled'],
    });
    await executor.run(job());

    expect(recorded(runner)).toEqual([
      CLAIMED, '--- Deploying', 'Package prepared', STARTED, '--- Injecting',
      "Run injection ended with reason 'Gatling exited with code 143'",
      '--- Ending',
      'Run ended early: Gatling exited with code 143. What it measured was kept.',
    ]);
    expect(recorded(runner).filter((line) => line === '--- Ending')).toHaveLength(1);
    expect(recorded(runner)).not.toContain('Run ended without results');
  });

  /**
   * THE GUARD IS ABOUT THE STAGE, NOT ONLY THE EARLY EXIT. From `ending` on the
   * log already holds the injection-ended line and the Ending phase, so a
   * cancel racing ANY failure from there — here a Gatling that wrote nothing —
   * must not write them again: the log ends on the failure, once.
   */
  it('does not write a second ending when a cancel lands on a failure after the injection ended', async () => {
    const { executor, runner } = harness({
      bytesWritten: 0,
      statuses: ['running', 'running', 'running', 'cancelled'],
    });
    await executor.run(job());

    expect(recorded(runner)).toEqual([
      CLAIMED, '--- Deploying', 'Package prepared', STARTED, '--- Injecting',
      "Run injection ended with reason 'Run completed normally'",
      '--- Ending',
      'Run failed: SIMULATION_LOG_NOT_FOUND: Gatling finished without producing a simulation.log file.',
    ]);
  });

  it('ends at the claim when the job was cancelled before its run opened', async () => {
    const { executor, runner } = harness({ opened: false });
    await executor.run(job());
    expect(recorded(runner)).toEqual([CLAIMED, '--- Deploying', 'Cancelled before the run opened']);
  });

  it('ends without results when cancelled before the package was prepared', async () => {
    const { executor, runner } = harness({ statuses: ['cancelled'] });
    await executor.run(job());
    expect(recorded(runner)).toEqual([
      CLAIMED, '--- Deploying', 'Cancelled before Gatling started', 'Run ended without results',
    ]);
    expect(prepareGatlingRun).not.toHaveBeenCalled();
  });

  it('ends without results when cancelled after the package was prepared', async () => {
    const { executor, runner } = harness({ statuses: ['running', 'cancelled'] });
    await executor.run(job());
    expect(recorded(runner)).toEqual([
      CLAIMED, '--- Deploying', 'Package prepared', 'Cancelled before Gatling started', 'Run ended without results',
    ]);
    expect(spawnAndWait).not.toHaveBeenCalled();
  });

  // A cancel reaches the executor's catch too: `prepareGatlingRun` hands the
  // cancel check to the extractor, which kills tar/unzip and fails the step.
  // `markFailed` is guarded `status <> 'cancelled'`, so the JOB stays cancelled;
  // the log has to end by what the job actually is, not by the error thrown.
  it('ends a cancel during preparation as cancelled, not failed', async () => {
    // status() is read once after the run opens, then once by the catch.
    const { executor, runner } = harness({
      statuses: ['running', 'cancelled'],
      prepare: async () => {
        throw new RunnerExecutionError('BUNDLE_EXTRACT_FAILED', 'Bundle extraction exited with code signal SIGTERM.', 'x');
      },
    });
    await executor.run(job());
    expect(recorded(runner)).toEqual([
      CLAIMED, '--- Deploying', 'Cancelled before Gatling started', 'Run ended without results',
    ]);
    expect(recorded(runner).some((line) => line.startsWith('Run failed'))).toBe(false);
  });

  it('ends a cancel that fails the run before it opened as cancelled, not failed', async () => {
    // status() is read once, by the catch: nothing before the open reads it.
    const { executor, runner, sink } = harness({ statuses: ['cancelled'] });
    sink.open.mockRejectedValue(new RunnerExecutionError('LIVE_OPEN_FAILED', 'the API refused the open', 'x'));
    await executor.run(job());
    expect(recorded(runner)).toEqual([CLAIMED, '--- Deploying', 'Cancelled before the run opened']);
  });

  it('ends a cancel that fails a running process as cancelled, after its start lines', async () => {
    // status(): after the open, after the package, then the catch. The start
    // lines are slow to write, so an ending that did not wait for them would
    // land first.
    const { executor, runner } = harness({ statuses: ['running', 'running', 'cancelled'] });
    vi.mocked(spawnAndWait).mockImplementation(async (_command, spawnOpts) => {
      spawnOpts?.onSpawn?.();
      throw new RunnerExecutionError('GATLING_LAUNCH_FAILED', 'the process failed after it started', 'x');
    });
    runner.recordRunnerEvent.mockImplementation(async (_jobId: string, event: RunnerJobEventInput) => {
      if (event.message === STARTED) await new Promise((resolve) => setTimeout(resolve, 30));
    });
    await executor.run(job());
    expect(recorded(runner)).toEqual([
      CLAIMED, '--- Deploying', 'Package prepared', STARTED, '--- Injecting',
      "Run injection ended with reason 'Cancelled'", '--- Ending', 'Run ended without results',
    ]);
  });

  it('ends a failure of a running process on the failure, after its start lines', async () => {
    const { executor, runner } = harness();
    vi.mocked(spawnAndWait).mockImplementation(async (_command, spawnOpts) => {
      spawnOpts?.onSpawn?.();
      throw new RunnerExecutionError('GATLING_LAUNCH_FAILED', 'the process failed after it started', 'x');
    });
    runner.recordRunnerEvent.mockImplementation(async (_jobId: string, event: RunnerJobEventInput) => {
      if (event.message === STARTED) await new Promise((resolve) => setTimeout(resolve, 30));
    });
    await executor.run(job());
    expect(recorded(runner)).toEqual([
      CLAIMED, '--- Deploying', 'Package prepared', STARTED, '--- Injecting',
      'Run failed: GATLING_LAUNCH_FAILED: the process failed after it started',
    ]);
  });

  it('ends a run cancelled mid-injection as cancelled, without results', async () => {
    const { executor, runner } = harness({ result: { code: null, signal: 'SIGTERM', stopped: true } });
    await executor.run(job());
    expect(recorded(runner)).toEqual([
      CLAIMED, '--- Deploying', 'Package prepared', STARTED, '--- Injecting',
      "Run injection ended with reason 'Cancelled'", '--- Ending', 'Run ended without results',
    ]);
  });

  it('ends a UID refusal on the refusal, before any run is opened', async () => {
    const { executor, runner, sink } = harness({ config: { allowSameUidExecution: false, childUid: null } });
    await executor.run(job());
    expect(recorded(runner)).toEqual([
      CLAIMED, '--- Deploying',
      "Run failed: RUNNER_UID_ISOLATION_REQUIRED: Refusing to execute an uploaded simulation as the runner's own user; "
        + 'uploaded code would share the control-plane process credentials and network reach.',
    ]);
    expect(sink.open).not.toHaveBeenCalled();
  });

  it('ends a run that produced no simulation.log on its failure', async () => {
    const { executor, runner } = harness({ bytesWritten: 0 });
    await executor.run(job());
    expect(recorded(runner).slice(-3)).toEqual([
      "Run injection ended with reason 'Run completed normally'", '--- Ending',
      'Run failed: SIMULATION_LOG_NOT_FOUND: Gatling finished without producing a simulation.log file.',
    ]);
  });

  it('ends a missing artifact on its failure, without the storage key', async () => {
    const { executor, runner } = harness({
      prepare: async () => {
        throw new RunnerExecutionError('ARTIFACT_NOT_FOUND', `Artifact file is not readable at /srv/perfportal/${STORAGE}.`, 'x');
      },
    });
    await executor.run(job());
    expect(recorded(runner)).toEqual([
      CLAIMED, '--- Deploying', 'Run failed: ARTIFACT_NOT_FOUND: Artifact file is not readable at <artifact>.',
    ]);
  });
});

describe('the events are best-effort', () => {
  it('runs the job to completion when every event fails to record, and says so in the job log', async () => {
    const { executor, runner } = harness({ recordFails: true });
    await executor.run(job());
    expect(runner.markComplete).toHaveBeenCalledTimes(1);
    expect(runner.markFailed).not.toHaveBeenCalled();
    const log = await readFile(path.join(logDir, `${JOB_ID}.log`), 'utf8');
    expect(log).toContain('failed to record run event');
  });
});

describe('no job parameter reaches an event', () => {
  it('names neither the command line, the Java options, a system property nor the storage key', async () => {
    const { executor, runner } = harness();
    await executor.run(job());
    const text = recorded(runner).join('\n');
    for (const leak of LEAKS) expect(text, `an event carries "${leak}"`).not.toContain(leak);
  });
});
