import { describe, expect, it, vi } from 'vitest';
import type {
  ProjectRepository,
  RunnerJobWithArtifact,
  RunRepository,
} from '@perfportal/persistence';
import type { BlobStore, LiveChunkStore } from '@perfportal/storage';
import type { RunnerConfig } from '../src/config.js';
import type { RunnerIngestQueue } from '../src/ingest-queue.js';
import type { RunnerLiveNotifier } from '../src/live-notifier.js';
import { RunnerLiveSink } from '../src/live-sink.js';

/**
 * What the on-prem runner tells the platform about a job when it opens that
 * job's live run.
 *
 * ═══ WHY THIS FILE EXISTS: A KEY NAME NO COMPILER READ ═══
 *
 * `open()` used to build its metadata with conditional spreads —
 * `...(job.job.testSlug ? { test: job.job.testSlug } : {})` — and `test` is
 * not a field of `CreateLiveRunInput`; the field is `declaredTestSlug`.
 * TypeScript accepted it, because its excess-property check applies to object
 * LITERALS and a spread is not one. So the runner discarded the declared test
 * on every job it ever ran, `tsc` said nothing, `lint` said nothing, and the
 * three suites said nothing. A real Gatling run through the real runner is
 * what found it: `runner_job.test_slug` was `checkout-soak` and the run it
 * produced had `declared_test_slug` NULL and grouped by simulation class.
 *
 * ASSERTING ON THE ARGUMENT IS THE WHOLE POINT. A test that stubbed
 * `createLive` and only checked the run came back would have passed against
 * the defect — the run WAS created, correctly, minus one field. What has to be
 * pinned is the shape of what the runner asks for, key by key.
 *
 * The repository's own half — that `createLive` then WRITES the column — is
 * pinned separately, in `packages/persistence/test/run-live.integration.test.ts`.
 * Neither half is sufficient: this file would pass against a repository that
 * accepts the field and drops it, and that one would pass against a runner
 * that never sends it.
 */

function makeSink(overrides: Partial<RunnerConfig> = {}) {
  const createLive = vi.fn().mockResolvedValue({
    id: '44444444-4444-4444-4444-444444444444',
    bundleKey: 'runs/44444444-4444-4444-4444-444444444444/simulation.log',
  });
  const runs = {
    createLive,
    liveState: vi.fn().mockResolvedValue({ streamOffset: 0 }),
  } as unknown as RunRepository;

  const sink = new RunnerLiveSink({
    config: { maxLogBytes: 1024 * 1024, ...overrides } as RunnerConfig,
    projects: {
      settings: vi.fn().mockResolvedValue({}),
    } as unknown as ProjectRepository,
    runs,
    blobs: {} as unknown as BlobStore,
    chunks: {} as unknown as LiveChunkStore,
    queue: {} as unknown as RunnerIngestQueue,
    notifier: { opened: vi.fn() } as unknown as RunnerLiveNotifier,
  });

  return { sink, createLive };
}

/**
 * The four frozen-metadata fields carry real values by default, so a case that
 * cares about one of them asserts a VALUE rather than mere presence — and an
 * implementation that dropped a different one of the four still fails here.
 */
function job(over: Partial<Record<string, unknown>> = {}): RunnerJobWithArtifact {
  return {
    artifact: { name: 'checkout load' },
    job: {
      id: '11111111-1111-1111-1111-111111111111',
      orgId: '22222222-2222-2222-2222-222222222222',
      projectId: '33333333-3333-3333-3333-333333333333',
      environment: 'staging',
      branch: 'main',
      commitSha: 'abc1234',
      testSlug: 'checkout-soak',
      ...over,
    },
  } as unknown as RunnerJobWithArtifact;
}

describe('RunnerLiveSink.open metadata', () => {
  it('opens the run under the test the job declared', async () => {
    const { sink, createLive } = makeSink();

    await sink.open(job());

    expect(createLive).toHaveBeenCalledTimes(1);
    expect(createLive.mock.calls[0]?.[0]).toMatchObject({
      orgId: '22222222-2222-2222-2222-222222222222',
      projectId: '33333333-3333-3333-3333-333333333333',
      environment: 'staging',
      branch: 'main',
      commitSha: 'abc1234',
      declaredTestSlug: 'checkout-soak',
    });
  });

  it('sends no test at all when the job named none, rather than an empty one', async () => {
    // Null is the ordinary case — most jobs name no test and must keep
    // resolving by simulation class. `undefined` and `''` are NOT
    // interchangeable here: `createLive` writes `input.declaredTestSlug ?? null`,
    // so an empty string would be stored as '' and `resolveTestId` would then
    // have to defend against a slug that matches nothing and creates nothing.
    const { sink, createLive } = makeSink();

    await sink.open(job({ testSlug: null }));

    expect(createLive.mock.calls[0]?.[0].declaredTestSlug).toBeUndefined();
  });

  it('drops an empty declaration rather than opening a run under a blank test', async () => {
    const { sink, createLive } = makeSink();

    await sink.open(job({ testSlug: '' }));

    expect(createLive.mock.calls[0]?.[0].declaredTestSlug).toBeUndefined();
  });
});
