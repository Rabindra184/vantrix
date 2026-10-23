import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

function makeSink(overrides: Partial<RunnerConfig> = {}, extra: { blobs?: unknown; runs?: Record<string, unknown> } = {}) {
  const createLive = vi.fn().mockResolvedValue({
    id: '44444444-4444-4444-4444-444444444444',
    bundleKey: 'runs/44444444-4444-4444-4444-444444444444/simulation.log',
  });
  const runs = {
    createLive,
    liveState: vi.fn().mockResolvedValue({ streamOffset: 0 }),
    ...extra.runs,
  } as unknown as RunRepository;

  const sink = new RunnerLiveSink({
    config: { maxLogBytes: 1024 * 1024, ...overrides } as RunnerConfig,
    projects: {
      settings: vi.fn().mockResolvedValue({}),
    } as unknown as ProjectRepository,
    runs,
    blobs: (extra.blobs ?? {}) as unknown as BlobStore,
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
    artifact: {},
    job: {
      id: '11111111-1111-1111-1111-111111111111',
      name: 'checkout load',
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

/**
 * ═══ THE AGENT FILE IS STORED WITH THE RUN, OR NOT AT ALL — NEVER A THROW ═══
 *
 * `storeAgentLog` runs while a finished load test is being closed. Whatever
 * goes wrong with the agent's file — missing, oversized, a bucket or database
 * that refuses it — the run is closed regardless, so this reports what it did
 * and the executor says so in the job log.
 */
describe('RunnerLiveSink.storeAgentLog', () => {
  const RUN_ID = '44444444-4444-4444-4444-444444444444';
  const KEY = `runs/${RUN_ID}/agent.ndjson`;
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'runner-agent-log-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** A sink whose blob store reads the stream it is handed, as the real one does. */
  async function agentSink(opts: { putFails?: boolean; recordFails?: boolean; cap?: number } = {}) {
    const order: string[] = [];
    const stored: Buffer[] = [];
    const putStream = vi.fn(async (key: string, body: Readable, maxBytes: number) => {
      order.push(`put:${key}`);
      const parts: Buffer[] = [];
      for await (const part of body) parts.push(part as Buffer);
      const bytes = Buffer.concat(parts);
      if (opts.putFails) throw new Error('the bucket refused the object');
      if (bytes.length > maxBytes) throw new Error('over the cap');
      stored.push(bytes);
      return { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
    });
    const recordAgentLog = vi.fn(async () => {
      order.push('recordAgentLog');
      if (opts.recordFails) throw new Error('database unavailable');
    });
    const { sink } = makeSink(
      { maxAgentLogBytes: opts.cap ?? 1024 },
      { blobs: { putStream }, runs: { recordAgentLog } },
    );
    await sink.open(job());
    return { sink, putStream, recordAgentLog, order, stored };
  }

  async function agentFile(bytes: number): Promise<{ file: string; content: Buffer }> {
    const content = Buffer.alloc(bytes, '{"t":1}\n');
    const file = path.join(dir, 'perfportal-agent.ndjson');
    await writeFile(file, content);
    return { file, content };
  }

  it('stores the bytes under the run, then records them on the run', async () => {
    const { sink, recordAgentLog, order, stored } = await agentSink();
    const { file, content } = await agentFile(300);

    await expect(sink.storeAgentLog(file)).resolves.toBe('stored');

    expect(order).toEqual([`put:${KEY}`, 'recordAgentLog']);
    expect(stored[0]?.equals(content)).toBe(true);
    expect(recordAgentLog).toHaveBeenCalledWith(RUN_ID, {
      key: KEY,
      sha256: createHash('sha256').update(content).digest('hex'),
      bytes: 300,
    });
  });

  it('stores a file of exactly the cap', async () => {
    const { sink } = await agentSink({ cap: 512 });
    const { file } = await agentFile(512);
    await expect(sink.storeAgentLog(file)).resolves.toBe('stored');
  });

  it('does not store an agent file larger than the cap', async () => {
    const { sink, putStream, recordAgentLog } = await agentSink({ cap: 512 });
    const { file } = await agentFile(513);

    await expect(sink.storeAgentLog(file)).resolves.toBe('too_large');

    expect(putStream).not.toHaveBeenCalled();
    expect(recordAgentLog).not.toHaveBeenCalled();
  });

  it('reports a missing file as absent, and an empty one too', async () => {
    const { sink, putStream } = await agentSink();
    await expect(sink.storeAgentLog(path.join(dir, 'never-written.ndjson'))).resolves.toBe('absent');
    const { file } = await agentFile(0);
    await expect(sink.storeAgentLog(file)).resolves.toBe('absent');
    expect(putStream).not.toHaveBeenCalled();
  });

  it('reports a refused upload as failed, and records nothing', async () => {
    const { sink, recordAgentLog } = await agentSink({ putFails: true });
    const { file } = await agentFile(100);

    await expect(sink.storeAgentLog(file)).resolves.toBe('failed');
    expect(recordAgentLog).not.toHaveBeenCalled();
  });

  it('reports a refused database write as failed rather than throwing', async () => {
    const { sink } = await agentSink({ recordFails: true });
    const { file } = await agentFile(100);

    await expect(sink.storeAgentLog(file)).resolves.toBe('failed');
  });

  it('reports failed, not a throw, when no run was ever opened', async () => {
    const { sink } = makeSink({ maxAgentLogBytes: 1024 });
    const { file } = await agentFile(100);
    await expect(sink.storeAgentLog(file)).resolves.toBe('failed');
  });
});
