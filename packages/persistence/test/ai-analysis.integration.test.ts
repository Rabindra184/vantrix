import { randomUUID } from 'node:crypto';
import { describeSlaRule, formatSlaMeasured } from '@perfportal/contracts';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AiAnalysisRepository,
  createPool,
  createPrisma,
  OrgSettingsRepository,
  readStoredFigures,
} from '../src/index.js';
import { requireDatabaseUrl, resetDatabase } from './support/db.js';

const url = requireDatabaseUrl();
const pool = createPool(url);
const prisma = createPrisma(url);

const STARTED_AT = new Date('2026-08-07T10:00:00Z');
const STARTED_ON = new Date('2026-08-07T00:00:00Z');

let orgId: string;
let projectId: string;
let userId: string;

/** A finished run with one exact run_stat row, unless told otherwise. */
async function seedRun(opts: { statsMethod?: 'estimated' | 'exact-v1'; toolAssertions?: unknown } = {}): Promise<string> {
  const run = await prisma.run.create({
    data: {
      orgId,
      projectId,
      status: 'complete',
      tool: 'gatling',
      simulation: 'example.ParitySimulation',
      durationMs: 63161,
      activityMs: 62136,
      bundleKey: `runs/${randomUUID()}.tgz`,
      bundleSha256: 'a'.repeat(64),
      bundleBytes: BigInt(1),
      startedAt: STARTED_AT,
      startedOn: STARTED_ON,
      engineOptions: {},
      statsMethod: opts.statsMethod,
      ingestedAt: new Date(),
      toolAssertions: opts.toolAssertions as never,
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
    [run.id, orgId, projectId],
  );
  return run.id;
}

const CONTENT = {
  summary: [{ text: 'The run held its p95 of 30 ms.', facts: ['run.p95'] }],
};

beforeEach(async () => {
  await resetDatabase(pool);
  const org = await prisma.org.create({ data: { slug: 'acme', name: 'Acme' } });
  const project = await prisma.project.create({
    data: { orgId: org.id, slug: 'checkout', name: 'Checkout', settings: {} },
  });
  const user = await prisma.user.create({
    data: { id: randomUUID(), name: 'Asha', email: `${randomUUID()}@example.test` },
  });
  orgId = org.id;
  projectId = project.id;
  userId = user.id;
});

afterAll(async () => {
  await pool.end();
  await prisma.$disconnect();
});

describe('OrgSettingsRepository', () => {
  it('defaults ai_enabled to false and sets it', async () => {
    const repo = new OrgSettingsRepository(pool);
    expect(await repo.aiEnabled(orgId)).toBe(false);

    await repo.setAiEnabled(orgId, true);
    expect(await repo.aiEnabled(orgId)).toBe(true);

    await repo.setAiEnabled(orgId, false);
    expect(await repo.aiEnabled(orgId)).toBe(false);
  });
});

describe('AiAnalysisRepository', () => {
  it('markPending then record then find round-trips content', async () => {
    const runId = await seedRun();
    const repo = new AiAnalysisRepository(pool);
    expect(await repo.find(runId)).toBeNull();

    const before = Date.now();
    await repo.markPending(runId, userId);
    const pending = await repo.find(runId);
    expect(pending).toMatchObject({
      runId,
      status: 'pending',
      content: null,
      provider: null,
      model: null,
      factsVersion: null,
      failureReason: null,
      generatedAt: null,
    });
    expect(pending!.requestedAt.getTime()).toBeGreaterThanOrEqual(before - 1000);

    await repo.record(runId, { content: CONTENT, provider: 'anthropic', model: 'claude-opus-5-5', factsVersion: 1 });
    const ready = await repo.find(runId);
    expect(ready).toMatchObject({
      runId,
      status: 'ready',
      content: CONTENT,
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      factsVersion: 1,
      failureReason: null,
    });
    expect(ready!.generatedAt).toBeInstanceOf(Date);
    // Recording keeps when it was asked for.
    expect(ready!.requestedAt.getTime()).toBe(pending!.requestedAt.getTime());
  });

  it('markPending after failed clears the failure', async () => {
    const runId = await seedRun();
    const repo = new AiAnalysisRepository(pool);
    await repo.markPending(runId, userId);
    await repo.record(runId, { content: CONTENT, provider: 'anthropic', model: 'm', factsVersion: 1 });
    await repo.markFailed(runId, 'The analysis cited 41 ms, which is not one of the run’s figures.');
    expect(await repo.find(runId)).toMatchObject({
      status: 'failed',
      failureReason: 'The analysis cited 41 ms, which is not one of the run’s figures.',
    });

    await repo.markPending(runId, userId);
    expect(await repo.find(runId)).toMatchObject({
      status: 'pending',
      content: null,
      provider: null,
      model: null,
      factsVersion: null,
      failureReason: null,
      generatedAt: null,
    });
    const { rows } = await pool.query<{ requested_by: string | null }>(
      'SELECT requested_by FROM run_ai_analysis WHERE run_id = $1',
      [runId],
    );
    expect(rows[0]?.requested_by).toBe(userId);
  });

  it('eligibility reports not_exact for an estimated run', async () => {
    const repo = new AiAnalysisRepository(pool);
    const exact = await seedRun();
    const estimated = await seedRun({ statsMethod: 'estimated' });

    expect(await repo.eligibility(exact)).toMatchObject({
      orgId,
      status: 'complete',
      hasStats: true,
      notExact: false,
      verificationStatus: null,
      recomputedAt: null,
    });
    expect(await repo.eligibility(estimated)).toMatchObject({ notExact: true, hasStats: true });
    expect((await repo.eligibility(exact))!.ingestedAt).toBeInstanceOf(Date);

    await pool.query(`INSERT INTO run_verification (run_id, status) VALUES ($1, 'mismatch')`, [exact]);
    expect(await repo.eligibility(exact)).toMatchObject({ verificationStatus: 'mismatch' });

    expect(await repo.eligibility(randomUUID())).toBeNull();
  });

  it('deletes the analysis with its run', async () => {
    const runId = await seedRun();
    const repo = new AiAnalysisRepository(pool);
    await repo.markPending(runId, userId);
    await repo.record(runId, { content: CONTENT, provider: 'anthropic', model: 'm', factsVersion: 1 });

    // A deleted person keeps the analysis and drops only the attribution.
    await prisma.user.delete({ where: { id: userId } });
    expect(await repo.find(runId)).toMatchObject({ status: 'ready' });

    await prisma.run.delete({ where: { id: runId } });
    expect(await repo.find(runId)).toBeNull();
  });

  it('readInput returns stored figures and both kinds of assertion', async () => {
    const tool = [
      {
        expression: 'Global: 95th percentile of response time is less than 100.0',
        outcome: 'passed',
        actualValue: 30,
      },
    ];
    const runId = await seedRun({ toolAssertions: tool });
    const failing = { scope: 'run', targetName: null, family: 'response_time', metric: 'error_rate', comparator: 'lte', threshold: 0.01 } as const;
    const unjudged = { scope: 'request', targetName: 'Search', family: 'response_time', metric: 'p95', comparator: 'lte', threshold: 800 } as const;
    for (const [snapshot, outcome, actual] of [
      [failing, 'failed', 0.3333333333333333],
      [unjudged, 'not_applicable', null],
    ] as const) {
      await pool.query(
        `INSERT INTO run_assertion (id, run_id, org_id, project_id, rule_id, rule_snapshot, outcome, actual_value, message)
         VALUES (gen_random_uuid(), $1, $2, $3, gen_random_uuid(), $4::jsonb, $5, $6, 'raw message')`,
        [runId, orgId, projectId, JSON.stringify(snapshot), outcome, actual],
      );
    }

    const input = await new AiAnalysisRepository(pool).readInput(runId);
    expect(input).not.toBeNull();
    expect(input!.run).toEqual({
      simulation: 'example.ParitySimulation',
      status: 'complete',
      durationMs: 63161,
      activityMs: 62136,
    });
    expect(input!.figures).toEqual(await readStoredFigures(pool, runId, STARTED_ON));
    expect(input!.figures.stats).toHaveLength(1);
    expect(input!.toolAssertions).toEqual(tool);
    expect(input!.platformAssertions).toEqual([
      {
        description: describeSlaRule(failing),
        outcome: 'failed',
        actualDisplay: formatSlaMeasured('error_rate', 0.3333333333333333, 0.01),
      },
      { description: describeSlaRule(unjudged), outcome: 'not_applicable', actualDisplay: null },
    ]);

    expect(await new AiAnalysisRepository(pool).readInput(randomUUID())).toBeNull();
  });
});
