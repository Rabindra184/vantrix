import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_PERCENTILE_ROWS, TCP_STATE_NAMES } from '@perfportal/contracts';
import { AGENT_BUNDLE_FILE } from '@perfportal/core';
import { AgentMetricWriter } from '@perfportal/persistence';
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

type AgentFile = Parameters<AgentMetricWriter['persist']>[3];
type AgentFigures = Parameters<AgentMetricWriter['persist']>[2];

const HTTP_OFF_REASON = 'no gatling-http jar on the classpath';

function header(collects: { http: boolean; machine: boolean }, reasons: { http?: string; machine?: string }) {
  return {
    format: 'perfportal-agent/1', agentVersion: '0.1.0', gatlingHttpClient: null, gatlingHttp: null,
    java: '21', os: 'Linux', host: 'loadgen-9', startedAt: 0, collects, reasons,
  };
}

/**
 * Gives an already-ingested run (one with no agent file) a `run_agent` row of
 * our choosing, through the real writer: an unreadable file, or collected
 * figures built by hand. The states these cases need — an HTTP collector that
 * was off, a bucket holding only the TCP gauge — are ones the paired fixture,
 * a real Linux run with every collector on, cannot produce.
 */
async function writeAgent(
  ctx: TestContext,
  runId: string,
  agent: { unreadable: string } | { header: AgentFile['header']; metrics: AgentFigures['metrics'] },
): Promise<void> {
  const run = await ctx.prisma.run.findUniqueOrThrow({ where: { id: runId } });
  const mctx = { runId, orgId: run.orgId, projectId: run.projectId, runStartedOn: run.startedOn };
  const client = await ctx.pool.connect();
  try {
    const writer = new AgentMetricWriter();
    if ('unreadable' in agent) {
      await writer.persistUnreadable(client, mctx, agent.unreadable);
    } else {
      const file: AgentFile = {
        header: agent.header, dns: [], connects: [], tls: [], closes: [], statuses: [], samples: [],
        error: null, capped: false, malformedLines: 0,
      };
      await writer.persist(client, mctx, { bucketWidthMs: 1000, durations: [], metrics: agent.metrics, remotes: [], hostnames: [] }, file);
    }
  } finally {
    client.release();
  }
}

describe('GET /v1/runs/:id/agent*', () => {
  let ctx: TestContext;
  let runId: string;
  let plainRunId: string;
  let unreadableRunId: string;
  let httpOffRunId: string;
  let gaugeOnlyRunId: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    runId = await ingest(ctx, tarball(true));
    plainRunId = await ingest(ctx, tarball(false));

    unreadableRunId = await ingest(ctx, tarball(false));
    await writeAgent(ctx, unreadableRunId, { unreadable: 'checksum_mismatch' });

    httpOffRunId = await ingest(ctx, tarball(false));
    await writeAgent(ctx, httpOffRunId, {
      header: header({ http: false, machine: true }, { http: HTTP_OFF_REASON }),
      metrics: [{ metric: 'heap', dim: '*', label: 'used', startOffsetMs: 0, value: 1024 }],
    });

    // Bucket 0 holds the first kernel-TCP sample: its `tcp.established` gauge is
    // filed, and no `tcp.evt` counter is (nothing earlier to take a delta from).
    // Bucket 1000 holds both.
    gaugeOnlyRunId = await ingest(ctx, tarball(false));
    await writeAgent(ctx, gaugeOnlyRunId, {
      header: header({ http: true, machine: true }, {}),
      metrics: [
        { metric: 'tcp.established', dim: '*', label: '', startOffsetMs: 0, value: 3 },
        { metric: 'tcp.established', dim: '*', label: '', startOffsetMs: 1000, value: 5 },
        { metric: 'tcp.evt', dim: '*', label: 'activeOpenings', startOffsetMs: 1000, value: 2 },
        { metric: 'tcp.evt', dim: '*', label: 'failedAttempts', startOffsetMs: 1000, value: 0 },
        { metric: 'tcp.evt', dim: '*', label: 'receivedResets', startOffsetMs: 1000, value: 0 },
        { metric: 'tcp.evt', dim: '*', label: 'sentResets', startOffsetMs: 1000, value: 1 },
      ],
    });
  }, 180_000);

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

  it('answers a window INSIDE the run that holds no bucket as available with no buckets', async () => {
    // The run spans 0–3625 ms on 1000 ms buckets, so a slice from 1200 to 1800 is inside
    // it and starts no bucket: a quiet slice of a recorded run, not "never recorded".
    for (const path of ['agent/connections', 'agent/dns', 'agent/injectors', 'agent/status']) {
      const res = await get(ctx, `/v1/runs/${runId}/${path}?from=1200&to=1800`).expect(200);
      expect(res.body.available, path).toBe(true);
      expect(res.body.reason, path).toBeNull();
      expect(res.body.buckets, path).toEqual([]);
      expect(res.body.window, path).toMatchObject({ fromMs: 1000, bucketWidthMs: 1000 });
    }
  });

  it('answers every endpoint "unreadable" with the stored reason for an unreadable agent file', async () => {
    for (const path of ENDPOINTS) {
      const res = await get(ctx, `/v1/runs/${unreadableRunId}/${path}`).expect(200);
      expect(res.body.available, path).toBe(false);
      expect(res.body.reason, path).toBe('unreadable');
      expect(res.body.detail, path).toBe('checksum_mismatch');
    }
  });

  it('answers the HTTP-fed reads "http_not_collected" when the HTTP collector was off, and still serves the load generator', async () => {
    for (const path of ['agent/connections', 'agent/dns', 'agent/status']) {
      const res = await get(ctx, `/v1/runs/${httpOffRunId}/${path}`).expect(200);
      expect(res.body.available, path).toBe(false);
      expect(res.body.reason, path).toBe('http_not_collected');
      expect(res.body.detail, path).toBe(HTTP_OFF_REASON);
    }
    const injectors = await get(ctx, `/v1/runs/${httpOffRunId}/agent/injectors`).expect(200);
    expect(injectors.body).toMatchObject({ available: true, reason: null, machine: { available: true, reason: null } });
    expect(injectors.body.buckets[0]).toMatchObject({ startOffsetMs: 0, heapUsedBytes: 1024 });
    // The summary itself is available: the agent ran, one collector did not.
    const summary = await get(ctx, `/v1/runs/${httpOffRunId}/agent`).expect(200);
    expect(summary.body).toMatchObject({ available: true, header: { collects: { http: false }, reasons: { http: HTTP_OFF_REASON } } });
  });

  it('reports a gauge-only TCP bucket as established with the four counters null, never zero', async () => {
    const res = await get(ctx, `/v1/runs/${gaugeOnlyRunId}/agent/injectors`).expect(200);
    const [first, second] = res.body.buckets;
    expect(first.tcpEvents).toEqual({
      activeOpenings: null, failedAttempts: null, established: 3, receivedResets: null, sentResets: null,
    });
    expect(second.tcpEvents).toEqual({
      activeOpenings: 2, failedAttempts: 0, established: 5, receivedResets: 0, sentResets: 1,
    });
    // No `tcp.seg` row in either bucket: no segment reading, so null rather than zeros.
    expect(first.tcpSegments).toBeNull();
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
