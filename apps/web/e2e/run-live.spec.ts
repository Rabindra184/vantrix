import { expect, test } from '@playwright/test';
import { Redis } from 'ioredis';
import { openLiveRun, seedAdmin } from './fixtures.js';
import { plot, signIn } from './helpers.js';
import { runChartsPath, runErrorsPath, runPath } from '../src/routes/paths.js';

/**
 * A RUNNING run's page — design part 2b §4.1, §4.3, §4.4, and FR-LIVE-4.
 *
 * WHAT ONLY EXISTS HERE. `RunDetail.live.test.tsx` already proves the branch
 * decision — what `identity`/`status`/`verdict`/`windowable`/`live`
 * `RunDetail` hands `RunShell`, and the `running && !compact` gate on the
 * socket itself; `RunShell.test.tsx` and the three per-tab `*.live.test.tsx`
 * files (`RunOverviewTab`, `RunChartsTab`, `RunErrorsTab`) prove the live
 * branches' own rendering — all of it against a mocked `useLiveRun`/a
 * QueryClient pre-populated by hand. What none of those can reach is the
 * REAL SOCKET: a real `POST /v1/runs/live` opening a run, a real
 * Redis-backed gateway seeding a real connection, and a real browser drawing
 * real ECharts SVGs from what it received — the whole path FR-LIVE-4 is
 * actually about.
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
 * The shape `LiveSlaSchema` requires on the wire (`packages/contracts/src/live-delta.ts`).
 * Named here, rather than left for TS to infer from the `{ evaluated: 0,
 * breaching: [] }` default below, because inference from an empty array
 * literal pins `breaching` at `never[]` -- a caller that then wants to
 * pass a REAL breach (Task 5's own e2e case) gets rejected by a parameter
 * type nobody wrote on purpose.
 */
type SlaFixture = {
  evaluated: number;
  /** Optional here, and defaulted on the wire (`LiveSlaSchema`), for the same
   * reason: a body already in Redis was written by whatever code was running
   * at the time. Every caller below that does not set it is exercising that
   * default through the real gateway, which does not validate what it
   * forwards. */
  notJudged?: number;
  breaching: { ruleId: string; description: string; actualValue: number; sinceOffsetMs: number }[];
};

/**
 * `seq` is a parameter, not fixed, because the AC-LIVE-1 measurement below
 * publishes a SECOND delta on the same run and needs it to carry a
 * different, checkable seq — the frame the client receives is the only
 * evidence the measurement has that it is timing the right message.
 *
 * `sla` defaults to "nothing breaching" -- true of every caller before
 * Task 5, and still true of most callers after it. The one exception passes
 * its own breach explicitly (see `deltaFixture(runId, seq, { ... })` below).
 */
function deltaFixture(runId: string, seq: number, sla: SlaFixture = { evaluated: 0, breaching: [] }) {
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
    // Required on the wire (LiveDeltaSchema). This fixture is untyped (no
    // `LiveDelta` import here), so a missing field is invisible to
    // `pnpm typecheck` -- but `apps/web/src/api/live.ts`'s `parseFrame`
    // validates every inbound frame with `LiveDeltaSchema.safeParse` and
    // silently drops the WHOLE delta on failure (`ws.onmessage`'s
    // `if (frame === null) return;`), so without this the client never
    // receives any of this fixture's data at all.
    sla,
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

      // Exactly one svg per PLOT — `plot()` scopes to `[data-chart-canvas]`
      // rather than to the whole figure, so this counts what ECharts drew and
      // not what the card contains. That distinction is why a chart header can
      // now carry icon controls; see `helpers.ts`.
      for (const id of ['concurrent-users', 'user-start-rate', 'percentiles', 'requests-per-second', 'responses-per-second']) {
        await expect(plot(page.getByTestId(`chart-${id}`))).toHaveCount(1);
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
      // This fixture's `sla.breaching` is empty — nothing is breaching, so
      // the banner must draw nothing at all, not an empty shell.
      await expect(page.getByTestId('sla-banner')).toHaveCount(0);
    } finally {
      await redis.del(`live:${runId}:snapshot`, `live:${runId}:deltas`);
      await redis.quit();
    }
  });
});

test.describe('a running run shows which SLA rules it is currently breaching', () => {
  /**
   * Task 5: the banner. A CONDITION, not an EVENT — a reader who opens this
   * page mid-breach must see the truth as it stands, so this seeds the
   * breach directly into the snapshot a fresh connection is served, rather
   * than publishing it as a later delta the reader would have had to
   * already be watching for.
   *
   * No real `sla_rule` row is seeded: `openLiveRun` starts no worker (this
   * file's own docstring), so nothing here ever evaluates a rule — the
   * fold owner that does was Task 3/4's own coverage. What this page reads
   * is exactly what a real fold owner would have written to the same Redis
   * key, and that shape is `deltaFixture`'s own `sla` field, overridden.
   */
  test('names the breaching rule and how long it has been breaching', async ({ page }) => {
    const admin = await seedAdmin();
    const runId = await openLiveRun(admin.orgId);
    const redis = new Redis(REDIS_URL);
    // `actualValue: 470` mirrors this same fixture's own `percentiles.p95`
    // above -- fixture data written by hand like the rest of `deltaFixture`,
    // not a value any assertion below re-derives from it.
    const delta = deltaFixture(runId, 5, {
      evaluated: 1,
      // Whole-branch review, C1: six of this project's seven rules are still
      // below the live evidence floor. "1 of 1" with no account of the other
      // six is the sentence that finding is about.
      notJudged: 6,
      breaching: [
        {
          ruleId: 'p95-checkout',
          description: 'p95 of the run (response_time) ≤ 100 — actual 470',
          actualValue: 470,
          sinceOffsetMs: 2000,
        },
      ],
    });

    try {
      await seedSnapshot(redis, runId, delta);
      await signIn(page, admin);
      await page.goto(runPath(runId));

      const banner = page.getByTestId('sla-banner');
      await expect(banner).toBeVisible();
      await expect(banner).toHaveRole('status');
      await expect(banner).toContainText('p95');
      // `sinceOffsetMs: 2000` -> `formatOffset` reads "2s" (apps/web/src/routes/format.ts).
      await expect(banner).toContainText('2s');
      // The denominator names what it counts, and the rules nobody has
      // checked yet are stated rather than left to be inferred from a number
      // that grows silently over the run's first minutes.
      await expect(banner).toContainText('1 of 1 checked SLA rule');
      await expect(banner).toContainText('6 further rules have not been checked yet');

      // This banner carries no <svg> at all, which is what is asserted here.
      // It is deliberately NOT scoped through `plot()`: the claim is about the
      // whole component, not about a plot it does not have.
      await expect(banner.locator('svg')).toHaveCount(0);

      // ON EVERY TAB, not just the one the reader happened to land on. This
      // banner used to live inside `Live`, the standalone live page that the
      // run-section work deleted; it now renders in `RunShell`, above the
      // `<Outlet/>`, so a breach follows the reader across the tab strip.
      // Charts is the tab that proves it — the furthest thing from Overview,
      // and the one a reader watching a run in progress is most likely to
      // sit on. Pushing the banner back down into a single tab would leave
      // `SlaBanner.test.tsx` entirely green.
      await page.goto(runChartsPath(runId));
      await expect(page.getByTestId('sla-banner')).toBeVisible();
      await expect(page.getByTestId('sla-banner')).toContainText('p95');
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
