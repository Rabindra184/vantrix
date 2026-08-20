import { expect, test } from '@playwright/test';
import { Redis } from 'ioredis';
import { openLiveRun, seedAdmin } from './fixtures.js';
import { signIn } from './helpers.js';
import { runChartsPath, runErrorsPath, runPath } from '../src/routes/paths.js';

/**
 * A RUNNING run's page — design part 2b §4.1, §4.3, §4.4, and FR-LIVE-4.
 *
 * WHAT ONLY EXISTS HERE. `apps/web/test/RunDetail.live.test.tsx` already
 * proves the branch decision and the `Live` component's own rendering
 * against a mocked `useLiveRun`/a QueryClient pre-populated by hand. What
 * that cannot reach is the REAL SOCKET: a real `POST /v1/runs/live` opening
 * a run, a real Redis-backed gateway seeding a real connection, and a real
 * browser drawing real ECharts SVGs from what it received — the whole path
 * FR-LIVE-4 is actually about.
 *
 * `openLiveRun` (fixtures.ts) is the one seed in this file that creates a
 * ROW — everything the page renders beyond that comes from Redis, written
 * directly by this file, the same way `live-gateway.integration.test.ts`
 * seeds a snapshot key and a delta stream rather than running a real fold
 * owner. No worker process is needed: `createLive` sets `status: 'running'`
 * on insert, so the run answers 202 the instant it exists.
 */

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6380';

/* ======================================================================== *
 * A delta shaped exactly as the fold owner publishes one.
 * ======================================================================== */

function bucketFixture(startOffsetMs: number) {
  return {
    startOffsetMs,
    startedCount: 20,
    endedCount: 20,
    okCount: 18,
    koCount: 2,
    startedOkCount: 18,
    startedKoCount: 2,
    minMs: 10,
    maxMs: 800,
    meanMs: 145,
    percentiles: { p50: 120, p95: 480, p99: 700 },
    percentilesOk: { p50: 110, p95: 400, p99: 650 },
    percentilesKo: { p50: 600, p95: 780, p99: 800 },
  };
}

/**
 * `seq` is a parameter, not fixed, because the AC-LIVE-1 measurement below
 * publishes a SECOND delta on the same run and needs it to carry a
 * different, checkable seq — the frame the client receives is the only
 * evidence the measurement has that it is timing the right message.
 */
function deltaFixture(runId: string, seq: number) {
  const offsets = [0, 1000, 2000, 3000];
  return {
    runId,
    seq,
    summary: {
      count: 320,
      okCount: 288,
      koCount: 32,
      errorRate: 0.1,
      percentiles: { p50: 125, p95: 470, p99: 690 },
      maxUsers: 12,
      durationMs: (offsets.at(-1) ?? 0) + 1000,
    },
    responseTime: { widthMs: 1000, replaces: true, buckets: offsets.map((o) => bucketFixture(o)) },
    users: {
      widthMs: 1000,
      buckets: offsets.map((o) => ({ scenario: 'Checkout', startOffsetMs: o, started: 4, ended: 1, active: 4 })),
    },
    errors: {
      rows: [
        { message: 'HTTP 500', count: 20 },
        { message: 'timeout', count: 12 },
      ],
    },
  };
}

async function seedSnapshot(redis: Redis, runId: string, delta: ReturnType<typeof deltaFixture>): Promise<void> {
  await redis.set(`live:${runId}:snapshot`, JSON.stringify(delta), 'EX', 300);
}

test.describe('a running run draws its live dashboard', () => {
  /**
   * RE-ENABLED (Task 11). This test used to prove the deleted `Live`
   * component end to end on one URL: its `<h1>` ("Run in progress"),
   * `LiveSummary`'s tiles, the five live charts, the live-fed errors table,
   * and four withheld-section notices. `Live` no longer exists — `RunShell`
   * renders for a running run instead, and its content is now split across
   * three tabs (Overview, Charts, Errors), each wired in its own task
   * (8, 9, 10). This rewrite keeps the ORIGINAL claims — same delta fixture,
   * same tile values, same chart ids, same withheld-notice count — but
   * points each one at the tab that now owns it, navigating between them
   * with `page.goto` the same way `run-charts.spec.ts` does.
   *
   * The `<h1>` assertion is NOT carried forward: "Run in progress" is gone
   * for good, not relocated — the header now carries the run's identity, the
   * same as any other run state, and that is already proven by
   * `run-detail.spec.ts`'s thin-identity case. Asserting a specific heading
   * text here would duplicate that coverage for no claim this test is about.
   *
   * `openLiveRun`/Redis seeding is unchanged from the original test.
   */
  test('the live charts draw, the tiles read the delta, and the withheld sections say what they are waiting for', async ({
    page,
  }) => {
    const admin = await seedAdmin();
    const runId = await openLiveRun(admin.orgId);
    const redis = new Redis(REDIS_URL);
    const delta = deltaFixture(runId, 5);

    try {
      await seedSnapshot(redis, runId, delta);
      await signIn(page, admin);

      /* ---- Overview: the streaming sentence, the headline tiles, one withheld notice ---- */
      await page.goto(runPath(runId));

      await expect(page.getByRole('navigation', { name: 'Run sections' })).toBeVisible();
      // Not the finished-run screen, and not the bare "please wait" spinner
      // this task replaces.
      await expect(page.getByText(/updating as the run streams/i)).toBeVisible();
      await expect(page.getByTestId('live-notice-finalizing')).toHaveCount(0);

      /* ---- the headline tiles, computed from the delta this test built ---- */
      await expect(page.getByTestId('live-stat-total-requests')).toContainText(String(delta.summary.count));
      await expect(page.getByTestId('live-stat-error-rate')).toContainText(
        `${(delta.summary.errorRate * 100).toFixed(2)}%`,
      );
      await expect(page.getByTestId('live-stat-peak-users')).toContainText(String(delta.summary.maxUsers));
      await expect(page.getByTestId('live-stat-p95')).toContainText(`${delta.summary.percentiles.p95} ms`);

      // ONE withheld notice here — the statistics table, which needs
      // per-endpoint rows the live wire excludes on every path.
      await expect(page.getByTestId('live-notice-withheld')).toHaveCount(1);
      await expect(page.getByText('Statistics', { exact: true })).toBeVisible();

      /* ---- Charts: the live charts really drew, two withheld notices ---- */
      await page.goto(runChartsPath(runId));

      // Exactly one svg per figure — the same invariant nine other specs
      // already rest on (CLAUDE.md): a decorative icon or a second drawing
      // inside a chart's <figure> would break this count as much as a chart
      // that failed to draw would.
      for (const id of ['concurrent-users', 'user-start-rate', 'percentiles', 'requests-per-second', 'responses-per-second']) {
        await expect(page.getByTestId(`chart-${id}`).locator('svg')).toHaveCount(1);
      }

      await expect(page.getByTestId('live-notice-withheld')).toHaveCount(2);
      await expect(page.getByText('Response time distribution', { exact: true })).toBeVisible();
      await expect(page.getByText('Response time percentiles distribution', { exact: true })).toBeVisible();
      // Never here — its real chart is on the Errors tab.
      await expect(page.getByText('Errors per second', { exact: true })).toHaveCount(0);

      /* ---- Errors: the live-fed table, one withheld notice ---- */
      await page.goto(runErrorsPath(runId));

      const errorsTable = page.getByRole('table', { name: /errors/i });
      await expect(errorsTable).toBeVisible();
      for (const row of delta.errors.rows) {
        await expect(page.getByTestId('error-row').filter({ hasText: row.message })).toBeVisible();
      }

      await expect(page.getByTestId('live-notice-withheld')).toHaveCount(1);
      await expect(page.getByText('Errors per second', { exact: true })).toBeVisible();

      // No progress indicator anywhere on the withheld sections, on any of
      // the three tabs above — a spinner claims something is arriving, and
      // nothing is, on any path, while this run streams.
      await expect(page.getByRole('progressbar')).toHaveCount(0);
    } finally {
      await redis.del(`live:${runId}:snapshot`, `live:${runId}:deltas`);
      await redis.quit();
    }
  });
});

test.describe('AC-LIVE-1: publish-to-receipt latency', () => {
  /**
   * Part 2a deferred "<2s p95 delta latency" to here, as the first point
   * with an end-to-end path to measure (design §5.6). This is a REAL socket
   * end to end — the browser's own `WebSocket`, the real gateway, a real
   * Redis pub/sub round trip — with the fold owner's own publish stood in
   * for by this test writing directly to the same channel the gateway
   * subscribes to (`LiveHub`), which is the one piece a browser-only harness
   * cannot run for itself.
   *
   * A single clean sample, not a statistical p95 — there is no fleet of
   * concurrent viewers here to draw a distribution from. If the measured
   * number misses 2s, this test reports it rather than loosening the bound
   * to make it pass.
   */
  test('measures publish-to-receipt across a real socket', async ({ page }) => {
    const admin = await seedAdmin();
    const runId = await openLiveRun(admin.orgId);
    const redis = new Redis(REDIS_URL);

    try {
      await seedSnapshot(redis, runId, deltaFixture(runId, 0));
      await signIn(page, admin);

      const wsPromise = page.waitForEvent('websocket', (ws) => ws.url().includes('/live'));
      await page.goto(runPath(runId));
      const ws = await wsPromise;

      // Wait for the INITIAL seed frame before publishing the timed delta,
      // so the measurement times a genuine PUBLISH round trip rather than
      // racing the gateway's own join-then-seed sequence.
      await ws.waitForEvent('framereceived');

      const timed = deltaFixture(runId, 1);
      const publishedAt = Date.now();
      await redis.publish(`live:${runId}`, JSON.stringify(timed));

      const frame = await ws.waitForEvent('framereceived', {
        predicate: ({ payload }) => {
          const text = typeof payload === 'string' ? payload : payload.toString('utf8');
          return text.includes('"seq":1');
        },
        timeout: 10_000,
      });
      const receivedAt = Date.now();
      void frame;

      const latencyMs = receivedAt - publishedAt;
      // Recorded here rather than only in CI's own log: this is the number
      // design §5.6 asks to be written back into the spec.
      console.log(`AC-LIVE-1 measured publish-to-receipt latency: ${latencyMs}ms`);

      expect(latencyMs).toBeLessThan(2000);
    } finally {
      await redis.del(`live:${runId}:snapshot`, `live:${runId}:deltas`);
      await redis.quit();
    }
  });
});
