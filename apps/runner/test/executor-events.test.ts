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
import { RunnerLiveSink } from '../src/live-sink.js';
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
    abortIncomplete: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
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

  it('names a non-zero exit, and keeps the run a simulation.log was produced for', async () => {
    const { executor, runner } = harness({ result: { code: 2, signal: null, stopped: false } });
    await executor.run(job());
    expect(recorded(runner).slice(-3)).toEqual([
      "Run injection ended with reason 'Gatling exited with code 2'", '--- Ending', 'Run ended',
    ]);
  });

  it('names the signal that ended Gatling', async () => {
    const { executor, runner } = harness({ result: { code: null, signal: 'SIGKILL', stopped: false } });
    await executor.run(job());
    expect(recorded(runner).slice(-3)).toEqual([
      "Run injection ended with reason 'Gatling was terminated by SIGKILL'", '--- Ending', 'Run ended',
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
