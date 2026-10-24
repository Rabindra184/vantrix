import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CanonicalEvent } from '@perfportal/core';
import { decodeAgentFile, parseSimulationLog, type AgentFile } from '@perfportal/plugin-gatling';
import {
  buildAgentFigures,
  runEngineAsync,
  runSeriesWidthMs,
  type AgentDurationFamily,
  type AgentFigures,
  type AgentMetricBucket,
} from '@perfportal/statistics';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AgentMetricWriter,
  AgentReader,
  createPool,
  createPrisma,
  type MetricContext,
  type ProjectScope,
} from '../src/index.js';
import { requireDatabaseUrl, resetDatabase } from './support/db.js';

const url = requireDatabaseUrl();
const pool = createPool(url);
const prisma = createPrisma(url);

/** The real paired fixture: a simulation.log and the agent file its JVM wrote. */
const FIXTURE = join(import.meta.dirname, '../../../fixtures/gatling-3.15.1.2/agent-run');
const FAMILIES: AgentDurationFamily[] = ['dns_resolution', 'tcp_connect', 'tls_handshake'];
/** A UTC day inside the 2027 partitions, so a write past the 2026 set is exercised too. */
const STARTED_ON = new Date(Date.UTC(2027, 2, 14));

let file: AgentFile;
let figures: AgentFigures;

beforeAll(async () => {
  file = decodeAgentFile(readFileSync(join(FIXTURE, 'agent.ndjson')));
  async function* events(): AsyncGenerator<CanonicalEvent> {
    yield* parseSimulationLog(readFileSync(join(FIXTURE, 'simulation.log')));
  }
  const result = await runEngineAsync(events());
  figures = buildAgentFigures(file, {
    runStartMs: result.runStartedAtMs!,
    durationMs: result.durationMs,
    bucketWidthMs: runSeriesWidthMs(result),
  });
  // Vacuity guards: a fixture that built nothing would make every round trip below agree.
  expect(figures.durations.length).toBeGreaterThan(0);
  expect(figures.metrics.length).toBeGreaterThan(0);
});

let scope: ProjectScope;
let otherScope: ProjectScope;
let ctx: MetricContext;

async function seedProject(slug: string): Promise<ProjectScope> {
  const org = await prisma.org.create({ data: { slug, name: slug } });
  const project = await prisma.project.create({
    data: { orgId: org.id, slug: `${slug}-p`, name: slug, settings: {} },
  });
  return { orgId: org.id, projectId: project.id };
}

beforeEach(async () => {
  await resetDatabase(pool);
  scope = await seedProject('acme');
  otherScope = await seedProject('other');
  const run = await prisma.run.create({
    data: {
      orgId: scope.orgId,
      projectId: scope.projectId,
      status: 'complete',
      tool: 'gatling',
      bundleKey: 'runs/x.tgz',
      bundleSha256: '',
      bundleBytes: 0,
      startedAt: STARTED_ON,
      startedOn: STARTED_ON,
      engineOptions: {},
    },
  });
  ctx = { runId: run.id, orgId: scope.orgId, projectId: scope.projectId, runStartedOn: STARTED_ON };
});

afterAll(async () => {
  await pool.end();
  await prisma.$disconnect();
});

/** The writer runs inside the caller's transaction, as the pipeline's finalize does. */
async function inTransaction(fn: (client: import('pg').PoolClient) => Promise<void>): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await fn(client);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function bucketRowCounts(runId: string): Promise<{ durations: number; metrics: number }> {
  const d = await pool.query<{ n: string }>('SELECT count(*) AS n FROM run_agent_duration_bucket WHERE run_id = $1', [runId]);
  const m = await pool.query<{ n: string }>('SELECT count(*) AS n FROM run_agent_metric_bucket WHERE run_id = $1', [runId]);
  return { durations: Number(d.rows[0]!.n), metrics: Number(m.rows[0]!.n) };
}

const metricKey = (m: AgentMetricBucket) => `${m.metric}|${m.dim}|${m.label}|${m.startOffsetMs}`;
const byMetricKey = (a: AgentMetricBucket, b: AgentMetricBucket) => metricKey(a).localeCompare(metricKey(b));

describe('AgentMetricWriter + AgentReader', () => {
  it('reads back every duration bucket and every metric row it wrote', async () => {
    const writer = new AgentMetricWriter();
    await inTransaction((client) => writer.persist(client, ctx, figures, file));
    const reader = new AgentReader(pool);

    const summary = await reader.summary(scope, ctx.runId);
    expect(summary).toEqual({
      status: 'collected',
      reason: null,
      header: file.header,
      capped: file.capped,
      agentError: file.error,
      malformedLines: file.malformedLines,
      bucketWidthMs: figures.bucketWidthMs,
      remotes: figures.remotes,
      hostnames: figures.hostnames,
    });

    // Durations, per dimension, all three families at once.
    const durationDims = [...new Set(figures.durations.map((d) => d.dim))];
    let durationsRead = 0;
    for (const dim of durationDims) {
      const read = await reader.durations(scope, ctx.runId, STARTED_ON, { families: FAMILIES, dim });
      const written = figures.durations.filter((d) => d.dim === dim);
      expect(read.length).toBe(written.length);
      durationsRead += read.length;
      for (const w of written) {
        const r = read.find((x) => x.family === w.family && x.startOffsetMs === w.startOffsetMs);
        expect(r, `${w.family} ${dim} @${w.startOffsetMs}`).toBeDefined();
        expect(r!.dim).toBe(dim);
        expect([r!.okCount, r!.koCount]).toEqual([w.okCount, w.koCount]);
        expect([r!.histogramOk.total, r!.histogramKo.total]).toEqual([w.histogramOk.total, w.histogramKo.total]);
        expect(Buffer.from(r!.histogramOk.serialize())).toEqual(Buffer.from(w.histogramOk.serialize()));
        expect(Buffer.from(r!.histogramKo.serialize())).toEqual(Buffer.from(w.histogramKo.serialize()));
      }
    }
    expect(durationsRead).toBe(figures.durations.length);

    // A family filter narrows: one family's rows only.
    const connectOnly = await reader.durations(scope, ctx.runId, STARTED_ON, { families: ['tcp_connect'], dim: '*' });
    expect(connectOnly.length).toBe(figures.durations.filter((d) => d.family === 'tcp_connect' && d.dim === '*').length);
    expect(connectOnly.every((d) => d.family === 'tcp_connect')).toBe(true);

    // Metrics, per dimension, every metric name at once: the union is every row written.
    const metricNames = [...new Set(figures.metrics.map((m) => m.metric))];
    const metricDims = [...new Set(figures.metrics.map((m) => m.dim))];
    const allRead: AgentMetricBucket[] = [];
    for (const dim of metricDims) {
      allRead.push(...(await reader.metrics(scope, ctx.runId, STARTED_ON, { metrics: metricNames, dim })));
    }
    expect([...allRead].sort(byMetricKey)).toEqual([...figures.metrics].sort(byMetricKey));

    // A metric filter narrows.
    const statusOnly = await reader.metrics(scope, ctx.runId, STARTED_ON, { metrics: ['status'], dim: '*' });
    expect(statusOnly.length).toBeGreaterThan(0);
    expect(statusOnly.every((m) => m.metric === 'status' && m.dim === '*')).toBe(true);
  });

  it('answers null for a run with no agent row', async () => {
    expect(await new AgentReader(pool).summary(scope, ctx.runId)).toBeNull();
  });

  it('records an unreadable agent file with its reason and no bucket rows', async () => {
    await inTransaction((client) => new AgentMetricWriter().persistUnreadable(client, ctx, 'checksum_mismatch'));

    expect(await new AgentReader(pool).summary(scope, ctx.runId)).toEqual({
      status: 'unreadable',
      reason: 'checksum_mismatch',
      header: null,
      capped: false,
      agentError: null,
      malformedLines: 0,
      bucketWidthMs: null,
      remotes: [],
      hostnames: [],
    });
    expect(await bucketRowCounts(ctx.runId)).toEqual({ durations: 0, metrics: 0 });
  });

  it("keeps a run's figures invisible to another org's scope", async () => {
    await inTransaction((client) => new AgentMetricWriter().persist(client, ctx, figures, file));
    const reader = new AgentReader(pool);
    // The other scope sees nothing; the owning scope sees rows (so the empties are not vacuous).
    expect(await reader.summary(otherScope, ctx.runId)).toBeNull();
    expect(await reader.durations(otherScope, ctx.runId, STARTED_ON, { families: FAMILIES, dim: '*' })).toEqual([]);
    expect(await reader.metrics(otherScope, ctx.runId, STARTED_ON, { metrics: ['status'], dim: '*' })).toEqual([]);
    expect(await reader.summary(scope, ctx.runId)).not.toBeNull();
    expect((await reader.durations(scope, ctx.runId, STARTED_ON, { families: FAMILIES, dim: '*' })).length).toBeGreaterThan(0);
    // A scope with the right org and another org's project sees nothing either.
    const crossed = { orgId: scope.orgId, projectId: otherScope.projectId };
    expect(await reader.summary(crossed, ctx.runId)).toBeNull();
    expect(await reader.metrics(crossed, ctx.runId, STARTED_ON, { metrics: ['status'], dim: '*' })).toEqual([]);
  });

  it('cascades run_agent from the run and leaves the FK-free bucket rows behind, by design', async () => {
    await inTransaction((client) => new AgentMetricWriter().persist(client, ctx, figures, file));
    const before = await bucketRowCounts(ctx.runId);
    expect(before).toEqual({ durations: figures.durations.length, metrics: figures.metrics.length });

    await prisma.run.delete({ where: { id: ctx.runId } });

    const agent = await pool.query('SELECT 1 FROM run_agent WHERE run_id = $1', [ctx.runId]);
    expect(agent.rowCount).toBe(0);
    expect(await bucketRowCounts(ctx.runId)).toEqual(before);
  });
});
