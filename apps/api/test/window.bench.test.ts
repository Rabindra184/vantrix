import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Histogram } from '@perfportal/statistics';
import { createTestApp, type TestContext } from './support/app.js';

/**
 * The windowed re-aggregation's cost, measured rather than assumed.
 *
 * A windowed request-scope table merges up to 300 histograms PER ENDPOINT, and
 * 15,000 deserialise-and-merge operations on one request is not obviously
 * cheap. This is the part of the design most likely to fail on contact with a
 * real run, so it gets a number and a budget.
 *
 * ═══ SEEDED, NOT INGESTED, AND DELIBERATELY ═══
 *
 * The subject here is the READ path. Pushing 15,000 buckets through the real
 * pipeline would put minutes on the suite and measure the writer instead.
 */

let ctx: TestContext;

afterEach(async () => {
  await ctx?.close();
});

const auth = () => ({ Authorization: `Bearer ${ctx.readToken}` });


/** The §9 budget. Server-side, for one windowed request-scope table. */
const BUDGET_MS = 500;
const ENDPOINTS = 50;
const BUCKETS = 300;

/**
 * A run with `ENDPOINTS × BUCKETS` series rows, written straight to the table.
 *
 * Each histogram gets a realistic per-bucket population — ~20 observations in a
 * narrow latency band — because a histogram's size tracks the value SPREAD it
 * covers. Seeding one observation per bucket would measure a payload the real
 * ingest path never produces.
 */
async function seedWideRun(): Promise<string> {
  const id = randomUUID();
  const startedOn = new Date('2026-08-16T00:00:00Z');
  await ctx.prisma.run.create({
    data: {
      id, orgId: ctx.orgId, projectId: ctx.projectId,
      status: 'complete', verdict: 'passed', tool: 'gatling',
      startedAt: startedOn, startedOn, durationMs: BUCKETS * 1000,
      bundleKey: `k/${id}`, bundleSha256: 'z'.repeat(64), bundleBytes: BigInt(1),
      engineOptions: {},
    },
  });

  const columns = [
    'run_started_on', 'run_id', 'org_id', 'project_id',
    'scope', 'name', 'family', 'start_offset_ms',
    'started_count', 'ended_count', 'ok_count', 'ko_count',
    'started_ok_count', 'started_ko_count',
    'min_ms', 'max_ms', 'mean_ms', 'percentiles', 'percentiles_ok', 'percentiles_ko',
    'histogram_ok', 'histogram_ko',
  ];

  const rows: unknown[][] = [];
  for (let e = 0; e < ENDPOINTS; e += 1) {
    for (let b = 0; b < BUCKETS; b += 1) {
      const ok = new Histogram();
      const ko = new Histogram();
      for (let i = 0; i < 20; i += 1) ok.accept(40 + ((e + b + i) % 25));
      ko.accept(300 + (b % 40));
      rows.push([
        startedOn, id, ctx.orgId, ctx.projectId,
        'request', `GET /r${e}`, 'response_time', b * 1000,
        21, 21, 20, 1, 20, 1, 40, 340, 55,
        '{}', '{}', '{}',
        Buffer.from(ok.serialize()), Buffer.from(ko.serialize()),
      ]);
    }
  }

  // Chunked the way MetricWriter chunks: Postgres caps a statement at 65535
  // parameters, and this is 15,000 rows of 22 columns.
  const cols = columns.map((c) => `"${c}"`).join(', ');
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const params: unknown[] = [];
    const tuples = chunk.map((row) => {
      const placeholders = row.map((v) => { params.push(v); return `$${params.length}`; });
      return `(${placeholders.join(', ')})`;
    });
    await ctx.pool.query(
      `INSERT INTO "run_series_bucket" (${cols}) VALUES ${tuples.join(', ')}`, params);
  }
  return id;
}

describe('windowed re-aggregation cost (design §9)', () => {
  it(`re-aggregates a ${ENDPOINTS}-endpoint run within the budget`, async () => {
    ctx = await createTestApp();
    const id = await seedWideRun();

    const started = process.hrtime.bigint();
    const res = await request(ctx.app.getHttpServer())
      .get(`/v1/runs/${id}/stats?scope=request&from=0&to=2147483647`)
      .set(auth());
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

    expect(res.status).toBe(200);
    // Not a vacuous pass: every endpoint must really be in the answer, and
    // every row must carry the merged counts rather than an empty histogram.
    expect(res.body.stats).toHaveLength(ENDPOINTS);
    expect(res.body.stats[0].count).toBe(BUCKETS * 21);

    console.log(
      `\n  windowed /stats: ${elapsedMs.toFixed(0)}ms ` +
      `(${ENDPOINTS * BUCKETS} buckets, budget ${BUDGET_MS}ms)\n`,
    );
    expect(elapsedMs).toBeLessThan(BUDGET_MS);
  }, 600_000);
});
