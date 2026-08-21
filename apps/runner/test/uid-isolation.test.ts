import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ProjectRepository,
  RunnerJobWithArtifact,
  RunRepository,
} from '@perfportal/persistence';
import type { BlobStore, LiveChunkStore } from '@perfportal/storage';
import type { RunnerConfig } from '../src/config.js';
import { RunnerExecutor } from '../src/executor.js';
import type { RunnerIngestQueue } from '../src/ingest-queue.js';
import type { RunnerLiveNotifier } from '../src/live-notifier.js';

/**
 * The runner executes uploaded Gatling code as a child process. If that child
 * inherits the runner's own uid it also inherits the control-plane process
 * credentials and network reach — so the executor fails CLOSED before opening a
 * live run unless a distinct unprivileged child uid is configured (or a trusted
 * single-tenant host opts out with RUNNER_ALLOW_SAME_UID=true).
 *
 * The security-relevant property is not just "the guard returns false" — it is
 * that execution never STARTS when isolation is missing. `sink.open()` is the
 * first step toward running the artifact and its very first call is
 * `projects.settings(...)`, so a never-called `settings` spy proves the guard
 * fired BEFORE the run was opened, which is exactly where the executor's own
 * comment says it must.
 */

const selfUid = typeof process.getuid === 'function' ? process.getuid() : null;
const hasGetuid = selfUid !== null;

let logDir: string;

function makeExecutor(configOver: Partial<RunnerConfig>) {
  const config = {
    logDir,
    allowSameUidExecution: false,
    childUid: null,
    childGid: null,
    ...configOver,
  } as RunnerConfig;

  const runner = {
    setLogPath: vi.fn().mockResolvedValue(undefined),
    markFailed: vi.fn().mockResolvedValue(undefined),
    markRunOpened: vi.fn().mockResolvedValue(true),
    markClosing: vi.fn().mockResolvedValue(undefined),
    markComplete: vi.fn().mockResolvedValue(undefined),
    heartbeat: vi.fn().mockResolvedValue(undefined),
    status: vi.fn().mockResolvedValue('running'),
  };

  // The first thing sink.open() does; if it runs, the guard let execution begin.
  const settings = vi.fn().mockRejectedValue(new Error('SENTINEL_OPEN_REACHED'));
  const projects = { settings } as unknown as ProjectRepository;

  const executor = new RunnerExecutor({
    config,
    projects,
    runner: runner as never,
    runs: {} as unknown as RunRepository,
    blobs: {} as unknown as BlobStore,
    chunks: {} as unknown as LiveChunkStore,
    queue: {} as unknown as RunnerIngestQueue,
    notifier: {} as unknown as RunnerLiveNotifier,
  });

  return { executor, runner, settings };
}

function job(): RunnerJobWithArtifact {
  return {
    artifact: { name: 'checkout load' },
    job: {
      id: '11111111-1111-1111-1111-111111111111',
      orgId: '22222222-2222-2222-2222-222222222222',
      projectId: '33333333-3333-3333-3333-333333333333',
    },
  } as unknown as RunnerJobWithArtifact;
}

beforeEach(async () => {
  logDir = await mkdtemp(path.join(os.tmpdir(), 'runner-uid-'));
});

afterEach(async () => {
  await rm(logDir, { recursive: true, force: true });
});

describe('RunnerExecutor uid isolation (fail closed before opening a live run)', () => {
  it('refuses to run and never opens a live run when no child uid is configured', async () => {
    const { executor, runner, settings } = makeExecutor({
      allowSameUidExecution: false,
      childUid: null,
    });

    await executor.run(job());

    expect(settings).not.toHaveBeenCalled();
    expect(runner.markFailed).toHaveBeenCalledTimes(1);
    expect(runner.markFailed.mock.calls[0]?.[1].code).toBe('RUNNER_UID_ISOLATION_REQUIRED');
    // Never reached the "opened live run" stage.
    expect(runner.markRunOpened).not.toHaveBeenCalled();
  });

  it.skipIf(!hasGetuid)(
    'refuses to run when the child uid equals the runner own uid',
    async () => {
      const { executor, runner, settings } = makeExecutor({
        allowSameUidExecution: false,
        childUid: selfUid,
      });

      await executor.run(job());

      expect(settings).not.toHaveBeenCalled();
      expect(runner.markFailed.mock.calls[0]?.[1].code).toBe('RUNNER_UID_ISOLATION_REQUIRED');
    },
  );

  it('proceeds to open the run when a distinct unprivileged child uid is set', async () => {
    const distinctUid = (selfUid ?? 0) + 1;
    const { executor, runner, settings } = makeExecutor({
      allowSameUidExecution: false,
      childUid: distinctUid,
    });

    await executor.run(job());

    // Guard passed: execution began (settings called), and if it failed it was
    // for the downstream sentinel — NOT the isolation guard.
    expect(settings).toHaveBeenCalledTimes(1);
    const code = runner.markFailed.mock.calls[0]?.[1].code;
    expect(code).not.toBe('RUNNER_UID_ISOLATION_REQUIRED');
  });

  it('lets a trusted single-tenant host opt out with allowSameUidExecution', async () => {
    const { executor, runner, settings } = makeExecutor({
      allowSameUidExecution: true,
      childUid: null,
    });

    await executor.run(job());

    expect(settings).toHaveBeenCalledTimes(1);
    const code = runner.markFailed.mock.calls[0]?.[1].code;
    expect(code).not.toBe('RUNNER_UID_ISOLATION_REQUIRED');
  });
});
