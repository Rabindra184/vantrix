import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_PERCENTILE_ROWS, TCP_STATE_NAMES } from '@perfportal/contracts';
import { AGENT_BUNDLE_FILE } from '@perfportal/core';
import { AGENT_DURATION_ROW_KEYS, AGENT_TCP_STATES } from '@perfportal/statistics';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestContext } from './support/app.js';
import { runPipelineFor } from './support/pipeline.js';

/**
 * ═══ THE FIVE AGENT READS, AGAINST A REAL INGEST ═══
 *
 * The paired fixture (`agent-run/`) is one JVM's `simulation.log` and agent
 * file: 90 requests, 90 `status` lines, two remotes and Linux machine figures.
 * It goes through the real `POST /v1/runs` and the real pipeline, so every
 * figure below was built by Task 5's finalize and read back through these
 * endpoints — "the sums equal the stored rows" is asserted against the table
 * itself, never against a number written down here.
 */

const FIXTURE_DIR = fileURLToPath(new URL('../../../fixtures/gatling-3.15.1.2/agent-run/', import.meta.url));
const HTTP_REMOTE = 'localhost/127.0.0.1:33357';
const HTTPS_REMOTE = 'localhost/127.0.0.1:36137';
const ENDPOINTS = ['agent', 'agent/connections', 'agent/dns', 'agent/injectors', 'agent/status'] as const;

function tarball(withAgent: boolean): Buffer {
  const dir = mkdtempSync(join(tmpdir(), 'agent-read-'));
  const results = join(dir, 'run-1');
  mkdirSync(results, { recursive: true });
  copyFileSync(join(FIXTURE_DIR, 'simulation.log'), join(results, 'simulation.log'));
  if (withAgent) copyFileSync(join(FIXTURE_DIR, 'agent.ndjson'), join(results, AGENT_BUNDLE_FILE));
  const out = join(dir, 'bundle.tgz');
  execFileSync('tar', ['-czf', out, '-C', dir, 'run-1']);
  return readFileSync(out);
}

async function ingest(ctx: TestContext, bundle: Buffer): Promise<string> {
  const res = await request(ctx.app.getHttpServer())
    .post('/v1/runs')
    .set('Authorization', `Bearer ${ctx.ingestToken}`)
    .field('metadata', JSON.stringify({ tool: 'gatling', waitMs: 0 }))
    .attach('bundle', bundle, 'bundle.tgz');
  expect(res.status, JSON.stringify(res.body)).toBe(202);
  const runId: string = res.body.id;
  await runPipelineFor(ctx, runId);
  const run = await request(ctx.app.getHttpServer())
    .get(`/v1/runs/${runId}`)
    .set('Authorization', `Bearer ${ctx.readToken}`);
  // Loud at setup rather than a confusing `available: false` deep in a case.
  expect(run.body.status, `run ${runId} did not finish: ${JSON.stringify(run.body)}`).toBe('complete');
  return runId;
}

function get(ctx: TestContext, path: string) {
  return request(ctx.app.getHttpServer()).get(path).set('Authorization', `Bearer ${ctx.readToken}`);
}

/** The stored total of one metric label at one dimension, read off the table itself. */
async function stored(ctx: TestContext, runId: string, metric: string, dim: string, label: string): Promise<number> {
  const { rows } = await ctx.pool.query<{ total: number | null }>(
    `SELECT sum(value)::float8 AS total FROM run_agent_metric_bucket
      WHERE run_id = $1 AND metric = $2 AND dim = $3 AND label = $4`,
    [runId, metric, dim, label],
  );
  return rows[0]?.total ?? 0;
}

/**
 * The two vocabularies the wire and the engine each spell: `@perfportal/contracts`
 * does not depend on `@perfportal/statistics`, so the API — which imports both —
 * is where their agreement is checked.
 */
describe('the agent vocabularies the wire and the store share', () => {
  it('names the same 13 percentile rows, in the same order', () => {
    expect([...AGENT_PERCENTILE_ROWS]).toEqual([...AGENT_DURATION_ROW_KEYS]);
  });

  it('names the same nine TCP states, in the same order', () => {
    expect(AGENT_TCP_STATES.map(([, label]) => label)).toEqual([...TCP_STATE_NAMES]);
  });
});

describe('GET /v1/runs/:id/agent*', () => {
  let ctx: TestContext;
  let runId: string;
  let plainRunId: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    runId = await ingest(ctx, tarball(true));
    plainRunId = await ingest(ctx, tarball(false));
  }, 120_000);

  afterAll(async () => {
    await ctx.close();
  });

  it('summarises the agent: available, its remotes and hostnames, and the load generator', async () => {
    const res = await get(ctx, `/v1/runs/${runId}/agent`).expect(200);
    expect(res.body).toMatchObject({
      runId,
      available: true,
      reason: null,
      detail: null,
      bucketWidthMs: 1000,
      remotes: [HTTP_REMOTE, HTTPS_REMOTE],
      hostnames: ['localhost'],
      // An upload, not an on-prem runner run.
      injector: { host: 'loadgen-1', sharedWithPerfPortal: false },
    });
    expect(res.body.header).toMatchObject({ os: 'Linux', collects: { http: true, machine: true } });
  });

  it('sums the connections to the stored all-remotes rows, and narrows them to one remote', async () => {
    const all = await get(ctx, `/v1/runs/${runId}/agent/connections`).expect(200);
    expect(all.body.available).toBe(true);
    expect(all.body.remote).toBe('*');
    expect(all.body.sums).toEqual({
      opened: await stored(ctx, runId, 'conn.opened', '*', ''),
      closed: await stored(ctx, runId, 'conn.closed', '*', ''),
      bitsOut: await stored(ctx, runId, 'bw.bits', '*', 'out'),
      bitsIn: await stored(ctx, runId, 'bw.bits', '*', 'in'),
    });
    // 60 non-warm-up connects: 30 to each port.
    expect(all.body.sums.opened).toBe(60);
    expect(all.body.tcpConnect.totals.ok).toBe(60);
    expect(all.body.tlsHandshake.totals.ok).toBe(30);

    const one = await get(ctx, `/v1/runs/${runId}/agent/connections?remote=${encodeURIComponent(HTTP_REMOTE)}`)
      .expect(200);
    expect(one.body.remote).toBe(HTTP_REMOTE);
    expect(one.body.sums.opened).toBe(await stored(ctx, runId, 'conn.opened', HTTP_REMOTE, ''));
    expect(one.body.sums.opened).toBeLessThan(all.body.sums.opened);
    // The first in-run sample read `states: {}` — no Gatling socket tracked, a measured
    // zero for every remote together, and no reading at all for any one remote. The two
    // are told apart on the wire: zeros for `*`, null for the remote.
    expect(all.body.buckets[0].startOffsetMs).toBe(0);
    expect(Object.values(all.body.buckets[0].states)).toEqual(Array(9).fill(0));
    expect(one.body.buckets[0]).toMatchObject({ startOffsetMs: 0, states: null });
    expect(one.body.buckets.some((b: { states: unknown }) => b.states !== null)).toBe(true);
    expect(one.body.tcpConnect.totals.ok).toBe(30);
    // The HTTP port carries no TLS: a section with nothing in it, never a row of zeros.
    expect(one.body.tlsHandshake.totals).toEqual({ ok: 0, ko: 0 });
    expect(one.body.tlsHandshake.overTime).toEqual([]);
  });

  it('refuses a remote the run never connected to', async () => {
    const res = await get(ctx, `/v1/runs/${runId}/agent/connections?remote=nowhere%3A1`).expect(400);
    expect(res.body.code).toBe('UNKNOWN_REMOTE');
    expect(res.body.remediation).toBe("List the run's remotes and hostnames with GET /v1/runs/{id}/agent.");
  });

  it('refuses a hostname the run never resolved', async () => {
    const res = await get(ctx, `/v1/runs/${runId}/agent/dns?hostname=nowhere`).expect(400);
    expect(res.body.code).toBe('UNKNOWN_HOSTNAME');
  });

  it('counts the DNS lookups, all and for one hostname', async () => {
    const all = await get(ctx, `/v1/runs/${runId}/agent/dns`).expect(200);
    expect(all.body.sums).toEqual({
      requests: await stored(ctx, runId, 'dns.count', '*', 'req'),
      ok: await stored(ctx, runId, 'dns.count', '*', 'ok'),
      ko: await stored(ctx, runId, 'dns.count', '*', 'ko'),
    });
    expect(all.body.sums.requests).toBe(60);
    expect(all.body.resolution.totals.ok).toBe(60);
    const one = await get(ctx, `/v1/runs/${runId}/agent/dns?hostname=localhost`).expect(200);
    expect(one.body.sums).toEqual(all.body.sums);
  });

  it('answers a window over a quiet stretch as available with no buckets', async () => {
    for (const path of ['agent/connections', 'agent/dns', 'agent/injectors', 'agent/status']) {
      const res = await get(ctx, `/v1/runs/${runId}/${path}?from=60000&to=70000`).expect(200);
      expect(res.body.available, path).toBe(true);
      expect(res.body.buckets, path).toEqual([]);
      expect(res.body.window, path).not.toBeNull();
    }
  });

  it('counts one status per request, adding up to the run\'s own request count', async () => {
    const res = await get(ctx, `/v1/runs/${runId}/agent/status`).expect(200);
    expect(res.body.codes).toEqual(['200', '404']);
    const total = res.body.buckets.reduce(
      (acc: number, b: { counts: Record<string, number> }) => acc + Object.values(b.counts).reduce((a, n) => a + n, 0),
      0,
    );
    const stats = await get(ctx, `/v1/runs/${runId}/stats`).expect(200);
    const runRow = stats.body.stats.find((s: { scope: string }) => s.scope === 'run');
    expect(runRow.count).toBe(90);
    expect(total).toBe(runRow.count);
  });

  it('reports CPU from the Linux load generator', async () => {
    const res = await get(ctx, `/v1/runs/${runId}/agent/injectors`).expect(200);
    expect(res.body.machine).toEqual({ available: true, reason: null });
    const withCpu = res.body.buckets.filter((b: { cpuUserPct: number | null }) => b.cpuUserPct !== null);
    expect(withCpu.length).toBeGreaterThan(0);
    for (const b of withCpu) {
      expect(b.cpuUserPct).toBeGreaterThanOrEqual(0);
      expect(b.cpuUserPct).toBeLessThanOrEqual(100);
    }
    expect(res.body.buckets.some((b: { heapUsedBytes: number | null }) => b.heapUsedBytes !== null)).toBe(true);
  });

  it('answers every endpoint "not collected" for a run with no agent file', async () => {
    for (const path of ENDPOINTS) {
      const res = await get(ctx, `/v1/runs/${plainRunId}/${path}`).expect(200);
      expect(res.body.available, path).toBe(false);
      expect(res.body.reason, path).toBe('not_collected');
    }
  });

  it('answers 404 for another org\'s run on every endpoint', async () => {
    const org = await ctx.prisma.org.create({ data: { slug: `other-${randomUUID().slice(0, 8)}`, name: 'Other' } });
    const project = await ctx.prisma.project.create({
      data: { orgId: org.id, slug: 'other', name: 'Other', settings: {} },
    });
    const otherRunId = randomUUID();
    await ctx.prisma.run.create({
      data: {
        id: otherRunId, orgId: org.id, projectId: project.id, status: 'complete', tool: 'gatling',
        bundleKey: `k/${otherRunId}`, bundleSha256: 'x'.repeat(64), bundleBytes: BigInt(1),
        startedAt: new Date('2026-10-24T00:00:00Z'), startedOn: new Date('2026-10-24T00:00:00Z'),
        engineOptions: {},
      },
    });
    for (const path of ENDPOINTS) {
      await get(ctx, `/v1/runs/${otherRunId}/${path}`).expect(404);
    }
  });
});

describe('agent figures on a coarsened run', () => {
  let ctx: TestContext;
  afterAll(async () => {
    await ctx.close();
  });

  it('reports the run\'s own 2000 ms bucket width', async () => {
    // Four 1000 ms buckets over a two-bucket cap coalesce to 2000 ms.
    ctx = await createTestApp({ maxBucketsRun: 2 });
    const runId = await ingest(ctx, tarball(true));
    const summary = await get(ctx, `/v1/runs/${runId}/agent`).expect(200);
    expect(summary.body.bucketWidthMs).toBe(2000);
    const status = await get(ctx, `/v1/runs/${runId}/agent/status`).expect(200);
    expect(status.body.bucketWidthMs).toBe(2000);
    for (const b of status.body.buckets) expect(b.startOffsetMs % 2000).toBe(0);
  }, 120_000);
});
