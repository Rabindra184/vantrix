import { randomUUID } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { AI_ANALYSIS_JOB_OPTIONS, AI_ANALYSIS_QUEUE } from '@perfportal/core';
import type { RunFacts } from '@perfportal/insight';
import {
  AiAnalysisRepository,
  createPool,
  createPrisma,
  OrgSettingsRepository,
  SCHEMA_TABLES,
} from '@perfportal/persistence';
import { Queue, QueueEvents, type Worker } from 'bullmq';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AiAnalysisService } from '../src/ai/ai-analysis.service.js';
import { startAiAnalysisConsumer } from '../src/ai/ai-queue.js';
import { ProviderHttpError, RefusedError, type AnalysisProvider } from '../src/ai/providers.js';
import { loadWorkerConfig, type WorkerConfig } from '../src/config.js';

const base = loadWorkerConfig({ ...process.env, DATABASE_URL: process.env.DATABASE_URL ?? '' });
/** A provider is configured; which one does not matter, the fake below answers. */
const config: WorkerConfig = {
  ...base,
  ai: { provider: 'openai-compatible', model: 'fake-1', baseUrl: 'http://fake.invalid', apiKey: null },
};
const pool = createPool(config.databaseUrl);
const prisma = createPrisma(config.databaseUrl);
const analyses = new AiAnalysisRepository(pool);
const orgs = new OrgSettingsRepository(pool);
const connection = { connection: { url: config.redisUrl } };
const queue = new Queue(AI_ANALYSIS_QUEUE, connection);

let orgId: string;
let consumer: Worker | undefined;

interface Call {
  system: string;
  facts: RunFacts;
  feedback: string | null;
}

/** Answers in order, recording what it was asked. A function answer is run, so it can throw. */
class FakeProvider implements AnalysisProvider {
  readonly name = 'fake';
  readonly model = 'fake-1';
  readonly calls: Call[] = [];
  constructor(private readonly answers: (unknown | (() => unknown))[]) {}

  async generate(req: Call): Promise<unknown> {
    this.calls.push(req);
    const next = this.answers[this.calls.length - 1];
    if (next === undefined) throw new Error(`the fake was asked ${String(this.calls.length)} times`);
    return typeof next === 'function' ? (next as () => unknown)() : next;
  }
}

/** Content whose one number, 3, is the run's request count. */
function content(requests: string): unknown {
  return {
    health: { headline: `The run made ${requests} requests.`, bullets: [`It made ${requests} requests in all.`] },
    insights: { headline: 'A request failed.', errors: [], assertions: [], injectionProfile: [], responseTimes: [] },
    recommendations: { headline: 'Look at the failure.', bullets: ['Read the failed request before the next run.'] },
  };
}
const GOOD = content('3');
const BAD = content('4,000');

beforeEach(async () => {
  await queue.obliterate({ force: true });
  await pool.query(`TRUNCATE TABLE ${SCHEMA_TABLES.map((t) => `"${t}"`).join(', ')} CASCADE`);
  const org = await prisma.org.create({ data: { slug: 'acme', name: 'Acme' } });
  orgId = org.id;
  await orgs.setAiEnabled(orgId, true);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await consumer?.close();
  consumer = undefined;
  await queue.obliterate({ force: true });
});

afterAll(async () => {
  await queue.close();
  await pool.end();
  await prisma.$disconnect();
});

/** A finished, exact run with one run-scope row (3 requests, 1 KO), its analysis requested. */
async function seedRun(): Promise<string> {
  const project = await prisma.project.create({ data: { orgId, slug: `p-${randomUUID().slice(0, 8)}`, name: 'P', settings: {} } });
  const user = await prisma.user.create({ data: { id: randomUUID(), email: `${randomUUID()}@example.test`, name: 'A' } });
  const run = await prisma.run.create({
    data: {
      orgId, projectId: project.id, status: 'complete', tool: 'gatling', simulation: 'example.ParitySimulation',
      durationMs: 63161, activityMs: 62136, bundleKey: `runs/${randomUUID()}.tgz`, bundleSha256: 'a'.repeat(64),
      bundleBytes: BigInt(1), startedAt: new Date('2026-08-07T10:00:00Z'), startedOn: new Date('2026-08-07T00:00:00Z'),
      engineOptions: {}, ingestedAt: new Date(),
    },
  });
  await pool.query(
    `INSERT INTO run_stat
       (id, run_id, org_id, project_id, scope, name, family,
        count, ok_count, ko_count, error_rate,
        min_ms, max_ms, mean_ms, stddev_ms, throughput_rps, percentiles, histogram_kind)
     VALUES (gen_random_uuid(), $1, $2, $3, 'run', '', 'response_time',
             3, 2, 1, 0.3333333333333333, 10, 30, 20, 8.16496580927726, 1.5,
             '{"p50": 20, "p95": 30}'::jsonb, 'sparse-ms-v2')`,
    [run.id, orgId, project.id],
  );
  await analyses.markPending(run.id, user.id);
  return run.id;
}

describe('AiAnalysisService', () => {
  it('stores ready content whose numbers trace to facts', async () => {
    const runId = await seedRun();
    const provider = new FakeProvider([GOOD]);

    expect(await new AiAnalysisService(config, pool, provider).generate(runId, { lastAttempt: false })).toBe('ready');

    const row = await analyses.find(runId);
    expect(row).toMatchObject({ status: 'ready', content: GOOD, provider: 'fake', model: 'fake-1', factsVersion: 1, failureReason: null });
    expect(row!.generatedAt).not.toBeNull();
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]!.feedback).toBeNull();
    // The facts the model was handed are the run's own stored figures.
    expect(provider.calls[0]!.facts.facts.find((f) => f.id === 'run.requests')?.display).toBe('3');
  });

  it('retries once naming the offending numbers, then stores the corrected content', async () => {
    const runId = await seedRun();
    const provider = new FakeProvider([BAD, GOOD]);

    expect(await new AiAnalysisService(config, pool, provider).generate(runId, { lastAttempt: false })).toBe('ready');

    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[1]!.feedback).toContain('4,000');
    expect(await analyses.find(runId)).toMatchObject({ status: 'ready', content: GOOD });
  });

  it('fails with numbers_not_in_facts after a second bad answer', async () => {
    const runId = await seedRun();
    const provider = new FakeProvider([BAD, BAD]);

    expect(await new AiAnalysisService(config, pool, provider).generate(runId, { lastAttempt: false })).toBe('failed');

    expect(provider.calls).toHaveLength(2);
    expect(await analyses.find(runId)).toMatchObject({
      status: 'failed', failureReason: 'numbers_not_in_facts: 4,000', content: null, generatedAt: null,
    });
  });

  it('fails with invalid_output after two answers the schema refuses, naming the problem in the retry', async () => {
    const runId = await seedRun();
    const provider = new FakeProvider([{ health: 'fine' }, 'not json at all']);

    expect(await new AiAnalysisService(config, pool, provider).generate(runId, { lastAttempt: false })).toBe('failed');

    expect(provider.calls[1]!.feedback).toMatch(/health/);
    expect(await analyses.find(runId)).toMatchObject({ status: 'failed', failureReason: 'invalid_output' });
  });

  it("sends the simulation's own assertions, and none when the stored column does not parse", async () => {
    const runId = await seedRun();
    const stored = [{ expression: 'Global: max of response time is less than 50.0', actualValue: 30, outcome: 'passed' }];
    await pool.query('UPDATE run SET tool_assertions = $2::jsonb WHERE id = $1', [runId, JSON.stringify(stored)]);
    const provider = new FakeProvider([GOOD]);
    await new AiAnalysisService(config, pool, provider).generate(runId, { lastAttempt: false });
    const tool = provider.calls[0]!.facts.facts.filter((f) => f.id.startsWith('assertion.tool.'));
    expect(tool.map((f) => f.text)).toEqual([stored[0]!.expression]);

    await pool.query(`UPDATE run SET tool_assertions = '{"not": "a list"}'::jsonb WHERE id = $1`, [runId]);
    const again = new FakeProvider([GOOD]);
    expect(await new AiAnalysisService(config, pool, again).generate(runId, { lastAttempt: false })).toBe('ready');
    expect(again.calls[0]!.facts.facts.some((f) => f.id.startsWith('assertion.tool.'))).toBe(false);
  });

  it('skips and records org_disabled when the switch was turned off after queueing', async () => {
    const runId = await seedRun();
    await orgs.setAiEnabled(orgId, false);
    const provider = new FakeProvider([GOOD]);

    expect(await new AiAnalysisService(config, pool, provider).generate(runId, { lastAttempt: false })).toBe('skipped');

    expect(provider.calls).toHaveLength(0);
    expect(await analyses.find(runId)).toMatchObject({ status: 'failed', failureReason: 'org_disabled' });
  });

  it('skips and records not_configured when the deployment names no provider', async () => {
    const runId = await seedRun();

    expect(await new AiAnalysisService({ ...config, ai: null }, pool, null).generate(runId, { lastAttempt: false })).toBe('skipped');

    expect(await analyses.find(runId)).toMatchObject({ status: 'failed', failureReason: 'not_configured' });
  });

  it('records refused at once when the model declines', async () => {
    const runId = await seedRun();
    const provider = new FakeProvider([() => { throw new RefusedError('cyber'); }]);

    expect(await new AiAnalysisService(config, pool, provider).generate(runId, { lastAttempt: false })).toBe('failed');

    expect(provider.calls).toHaveLength(1);
    expect(await analyses.find(runId)).toMatchObject({ status: 'failed', failureReason: 'refused' });
  });

  it('records provider_error on the last attempt and rethrows before it', async () => {
    const runId = await seedRun();
    const unreachable = (): never => { throw new ProviderHttpError(503, 'overloaded'); };

    const early = new AiAnalysisService(config, pool, new FakeProvider([unreachable]));
    await expect(early.generate(runId, { lastAttempt: false })).rejects.toBeInstanceOf(ProviderHttpError);
    // Left for the queue's next attempt: still pending, nothing recorded.
    expect(await analyses.find(runId)).toMatchObject({ status: 'pending', failureReason: null });

    const last = new AiAnalysisService(config, pool, new FakeProvider([unreachable]));
    expect(await last.generate(runId, { lastAttempt: true })).toBe('failed');
    expect(await analyses.find(runId)).toMatchObject({ status: 'failed', failureReason: 'provider_error' });
  });

  it('records internal_error on the last attempt for an error it does not classify, and rethrows it', async () => {
    const runId = await seedRun();
    const dbDown = new Error('the database went away');
    vi.spyOn(AiAnalysisRepository.prototype, 'readInput').mockRejectedValue(dbDown);
    const service = new AiAnalysisService(config, pool, new FakeProvider([GOOD]));

    await expect(service.generate(runId, { lastAttempt: false })).rejects.toBe(dbDown);
    expect(await analyses.find(runId)).toMatchObject({ status: 'pending' });

    await expect(service.generate(runId, { lastAttempt: true })).rejects.toBe(dbDown);
    expect(await analyses.find(runId)).toMatchObject({ status: 'failed', failureReason: 'internal_error' });
  });

  it('rethrows the original error when recording the failure fails too', async () => {
    const runId = await seedRun();
    const dbDown = new Error('the database went away');
    vi.spyOn(AiAnalysisRepository.prototype, 'readInput').mockRejectedValue(dbDown);
    vi.spyOn(AiAnalysisRepository.prototype, 'markFailed').mockRejectedValue(new Error('and stayed away'));

    await expect(
      new AiAnalysisService(config, pool, new FakeProvider([GOOD])).generate(runId, { lastAttempt: true }),
    ).rejects.toBe(dbDown);
  });

  it('records provider_error at once for a call it cut off, rather than paying for it again', async () => {
    const runId = await seedRun();
    const provider = new FakeProvider([() => { throw new Anthropic.APIConnectionTimeoutError(); }]);

    // Not the last attempt, and still recorded: the queue never sees it.
    expect(await new AiAnalysisService(config, pool, provider).generate(runId, { lastAttempt: false })).toBe('failed');

    expect(provider.calls).toHaveLength(1);
    expect(await analyses.find(runId)).toMatchObject({ status: 'failed', failureReason: 'provider_error' });
  });

  it('stamps the analysis with when the facts were read, so a recompute during generation leaves it stale', async () => {
    const runId = await seedRun();
    // The recompute lands while the model is answering: after the facts were
    // read, before the answer is stored.
    const provider = new FakeProvider([
      async () => {
        await pool.query('UPDATE run SET recomputed_at = clock_timestamp() WHERE id = $1::uuid', [runId]);
        return GOOD;
      },
    ]);

    expect(await new AiAnalysisService(config, pool, provider).generate(runId, { lastAttempt: false })).toBe('ready');

    const row = await analyses.find(runId);
    const run = await analyses.eligibility(runId);
    expect(row!.generatedAt).not.toBeNull();
    expect(run!.recomputedAt).not.toBeNull();
    // Later than the stamp: the API's isStale reads exactly this comparison.
    expect(run!.recomputedAt!.getTime()).toBeGreaterThan(row!.generatedAt!.getTime());
  });

  it('records provider_error at once for a request the provider refused', async () => {
    const runId = await seedRun();
    const provider = new FakeProvider([() => { throw new ProviderHttpError(401, 'bad key'); }]);

    expect(await new AiAnalysisService(config, pool, provider).generate(runId, { lastAttempt: false })).toBe('failed');

    expect(await analyses.find(runId)).toMatchObject({ status: 'failed', failureReason: 'provider_error' });
  });
});

describe('startAiAnalysisConsumer', () => {
  async function run(provider: AnalysisProvider, attempts: number): Promise<string> {
    const runId = await seedRun();
    const events = new QueueEvents(AI_ANALYSIS_QUEUE, connection);
    await events.waitUntilReady();
    try {
      consumer = startAiAnalysisConsumer(config, new AiAnalysisService(config, pool, provider));
      await add(runId, attempts, events);
    } finally {
      await events.close();
    }
    return runId;
  }

  /** The shipped options, but `attempts` of them, 50 ms apart, so a case need not wait out the backoff. */
  async function add(runId: string, attempts: number, events: QueueEvents): Promise<void> {
    const job = await queue.add(
      'analyse',
      { runId },
      { ...AI_ANALYSIS_JOB_OPTIONS, jobId: runId, attempts, backoff: { type: 'fixed', delay: 50 } },
    );
    await job.waitUntilFinished(events, 30_000).catch(() => undefined);
  }

  it('lets the queue retry an unreachable provider, and records nothing until the attempt that works', async () => {
    const provider = new FakeProvider([() => { throw new ProviderHttpError(503, 'overloaded'); }, GOOD]);

    const runId = await run(provider, 2);

    expect(provider.calls).toHaveLength(2);
    expect(await analyses.find(runId)).toMatchObject({ status: 'ready', content: GOOD });
  });

  it('records provider_error when the job has no attempt left', async () => {
    const provider = new FakeProvider([() => { throw new ProviderHttpError(503, 'overloaded'); }]);

    const runId = await run(provider, 1);

    expect(provider.calls).toHaveLength(1);
    expect(await analyses.find(runId)).toMatchObject({ status: 'failed', failureReason: 'provider_error' });
  });

  it('takes a new job for a run whose last job failed for good', async () => {
    const dbDown = new Error('the database went away');
    const readInput = vi.spyOn(AiAnalysisRepository.prototype, 'readInput').mockRejectedValueOnce(dbDown);
    const provider = new FakeProvider([GOOD]);
    const runId = await run(provider, 1);
    expect(await analyses.find(runId)).toMatchObject({ status: 'failed', failureReason: 'internal_error' });

    // The API's retry: the row pending again, the job queued under the same id.
    readInput.mockRestore();
    const user = await prisma.user.findFirstOrThrow();
    await analyses.markPending(runId, user.id);
    const events = new QueueEvents(AI_ANALYSIS_QUEUE, connection);
    await events.waitUntilReady();
    try {
      await add(runId, 1, events);
    } finally {
      await events.close();
    }

    expect(provider.calls).toHaveLength(1);
    expect(await analyses.find(runId)).toMatchObject({ status: 'ready', content: GOOD });
  });
});
