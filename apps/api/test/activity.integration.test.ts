import { randomUUID } from 'node:crypto';
import { ActivityResponseSchema, type ActivityResponse } from '@perfportal/contracts';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestContext } from './support/app.js';
import { signUpAsOrgMember } from './support/session.js';

/**
 * `GET /v1/activity` — what the portfolio home page draws, in one response.
 * The repository's own cases (the SQL attention rule against the contract's,
 * the cap, the day boundaries' half-open ranges) live in `packages/persistence`
 * and `activity-days.test.ts`; what is asserted HERE is what only the endpoint
 * decides: which credential sees how much, how `tz` arrives at the calendar,
 * the arithmetic that turns seven day counts into `runCount` and `passRate`,
 * and that the wire shape is the contract's.
 */

let ctx: TestContext;
let cookie: string;

beforeEach(async () => {
  ctx = await createTestApp();
  // A REAL MEMBER of ctx's own org, for the reason org-tests.integration.test.ts
  // records: a no-membership session answers 403, so the wrong helper would
  // make every "a session sees the org" case pass or fail for the wrong cause.
  cookie = await signUpAsOrgMember(ctx, 'activity-reader@example.test');
});

afterEach(async () => {
  await ctx?.close();
});

const PATH = '/v1/activity';
const HOUR = 3_600_000;

const asSession = (path: string) =>
  request(ctx.app.getHttpServer()).get(path).set('Cookie', cookie);
const asToken = (path: string) =>
  request(ctx.app.getHttpServer()).get(path).set('Authorization', `Bearer ${ctx.readToken}`);

function parse(body: unknown): ActivityResponse {
  return ActivityResponseSchema.parse(body);
}

async function seedTest(slug: string, over: { projectId?: string } = {}) {
  return ctx.prisma.test.create({
    data: {
      orgId: ctx.orgId,
      projectId: over.projectId ?? ctx.projectId,
      slug,
      name: slug,
      simulationClass: `com.acme.${slug}`,
    },
  });
}

/**
 * A run that ARRIVED `agoMs` before now. Arrival is `created_at`, which is the
 * column every window in this endpoint is on; the default would be the instant
 * of seeding, and "an hour ago" has to be a thing the fixture chose.
 */
async function seedRun(
  agoMs: number,
  over: Record<string, unknown> & { testId?: string | null; projectId?: string } = {},
) {
  const id = randomUUID();
  const createdAt = new Date(Date.now() - agoMs);
  await ctx.prisma.run.create({
    data: {
      id,
      orgId: ctx.orgId,
      projectId: ctx.projectId,
      status: 'complete',
      verdict: 'passed',
      tool: 'gatling',
      bundleKey: `runs/${ctx.projectId}/${id}.tgz`,
      bundleSha256: 'a'.repeat(64),
      bundleBytes: 1n,
      createdAt,
      startedAt: createdAt,
      startedOn: new Date(createdAt.toISOString().slice(0, 10)),
      engineOptions: {},
      ...over,
    },
  });
  return id;
}

/** `YYYY-MM-DD` of an instant in a zone, by the same `Intl` the endpoint counts days with. */
const dateIn = (tz: string, at = new Date()) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);

describe('GET /v1/activity', () => {
  it('answers a session its organisation’s activity, in the response schema', async () => {
    const smoke = await seedTest('checkout-smoke');
    await seedRun(2 * HOUR, { testId: smoke.id });

    const res = await asSession(PATH);

    expect(res.status).toBe(200);
    const body = parse(res.body);
    expect(body.days).toHaveLength(7);
    expect(body.window.tz).toBe('UTC');
    // The attention window starts where the glance does — the first instant of
    // the oldest of the seven days, which in UTC is that date's midnight — and
    // ends at the moment the server answered.
    expect(body.window.from).toBe(`${body.days[0]!.date}T00:00:00.000Z`);
    expect(Date.parse(body.window.to)).toBeGreaterThan(Date.parse(body.window.from));
    expect(body.runCount).toBe(1);
    expect(body.lastRun?.test).toEqual({ slug: 'checkout-smoke', name: 'checkout-smoke' });
  });

  it('echoes the zone it was asked for, as sent', async () => {
    const res = await asSession(`${PATH}?tz=Asia/Kolkata`);

    expect(res.status).toBe(200);
    // AS SENT: ICU would answer `Asia/Calcutta`, a zone the caller never named.
    expect(parse(res.body).window.tz).toBe('Asia/Kolkata');
  });

  /**
   * TWO ZONES WHOSE DATES ALWAYS DIFFER. Kiritimati is UTC+14 and Pago Pago
   * UTC-11, twenty-five hours apart with no daylight saving in either, so at
   * every instant their local dates are a day or two apart — unlike Kolkata
   * against UTC, which differ only from 18:30 to midnight UTC and left a case
   * built on them able to fail for a quarter of the day. If `tz` did not reach
   * the calendar, both answers would name the same today.
   */
  it('counts days in the zone it was asked for', async () => {
    const zones = ['Pacific/Kiritimati', 'Pacific/Pago_Pago'] as const;
    const todays: string[] = [];
    for (const zone of zones) {
      const before = dateIn(zone);
      const res = await asSession(`${PATH}?tz=${encodeURIComponent(zone)}`);
      const after = dateIn(zone);

      expect(res.status).toBe(200);
      const body = parse(res.body);
      expect(body.window.tz).toBe(zone);
      // Both ends of the request, so a midnight crossed mid-test cannot flake it.
      expect([before, after], zone).toContain(body.days[6]!.date);
      todays.push(body.days[6]!.date);
    }
    expect(todays[0]).not.toBe(todays[1]);
  });

  /**
   * ═══ ONE WINDOW: A RUN BEFORE THE OLDEST DAY'S MIDNIGHT IS IN NONE OF IT ═══
   *
   * The 168 hours before now reach back past the first instant of the oldest
   * glance day by a slice of 24 hours minus the local time of day. A run that
   * arrived in that slice used to be in the attention list and in no day — so
   * the page said "No runs in the last 7 days" beside it. It is in neither now:
   * not listed, not counted, and the org it is the only run of is a coverage
   * gap (`homeFormat.test.ts` pins that last step from this same answer).
   *
   * The zone is chosen so that it is between 02:00 and 14:00 there whenever
   * this runs: the slice is then at least ten hours wide and no local midnight
   * can be crossed mid-test. A fixed offset (`Etc/GMT…`, whose sign is
   * inverted: `Etc/GMT-5` is UTC+5) has no daylight saving, so the oldest day's
   * first instant is its date's UTC midnight minus the offset, computed here
   * without the code under test.
   */
  it('leaves a run that arrived before the oldest day’s midnight out of the window', async () => {
    const at = new Date();
    const offset = [...Array(27).keys()]
      .map((i) => i - 12)
      .find((h) => {
        const local = (at.getUTCHours() + at.getUTCMinutes() / 60 + h + 48) % 24;
        return local >= 2 && local < 14;
      })!;
    const tz = offset === 0 ? 'UTC' : `Etc/GMT${offset > 0 ? '-' : '+'}${Math.abs(offset)}`;
    const [y, m, d] = dateIn(tz, at).split('-').map(Number) as [number, number, number];
    const oldest = new Date(Date.UTC(y, m - 1, d - 6));
    const oldestStart = oldest.getTime() - offset * HOUR;

    const smoke = await seedTest('checkout-smoke');
    const arrived = new Date(oldestStart - HOUR);
    // In the slice: inside the 168 hours before now, and before the window.
    expect(arrived.getTime()).toBeGreaterThan(Date.now() - 168 * HOUR);
    const runId = await seedRun(0, {
      testId: smoke.id,
      status: 'failed',
      verdict: null,
      createdAt: arrived,
      startedAt: arrived,
      startedOn: new Date(arrived.toISOString().slice(0, 10)),
    });

    const res = await asSession(`${PATH}?tz=${encodeURIComponent(tz)}`);

    expect(res.status).toBe(200);
    const body = parse(res.body);
    // A failed run, so the only thing keeping it off the list is the window.
    // Asserted first: being listed while counted in no day is the defect.
    expect(body.attention).toEqual([]);
    expect(body.attentionTotal).toBe(0);
    expect(body.runCount).toBe(0);
    expect(body.passRate).toBeNull();
    // The positive control: the run is there, and it is this org's.
    expect(body.lastRun?.id).toBe(runId);
    // And the window the response names starts where the glance does.
    expect(body.days[0]!.date).toBe(oldest.toISOString().slice(0, 10));
    expect(body.window.from).toBe(new Date(oldestStart).toISOString());
  });

  it('treats a blank tz as UTC', async () => {
    const res = await asSession(`${PATH}?tz=%20%20`);

    expect(res.status).toBe(200);
    expect(parse(res.body).window.tz).toBe('UTC');
  });

  it('refuses an unknown zone, naming one it would take', async () => {
    const res = await asSession(`${PATH}?tz=Mars/Olympus_Mons`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_TIMEZONE');
    expect(res.body.remediation).toMatch(/Europe\/London/);
  });

  it('refuses a tz given twice rather than failing on it', async () => {
    const res = await asSession(`${PATH}?tz=UTC&tz=Europe/London`);

    // A repeated parameter arrives as an array, and `.trim()` on one would be a
    // TypeError: a 500 for a request only the caller can have got wrong.
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_QUERY');
  });

  it('shows a project token only its own project', async () => {
    const other = await ctx.prisma.project.create({
      data: { orgId: ctx.orgId, slug: 'other-project', name: 'Other Project', settings: {} },
    });
    await seedRun(HOUR);
    await seedRun(2 * HOUR, { projectId: other.id });

    const viaToken = parse((await asToken(PATH)).body);
    const viaSession = parse((await asSession(PATH)).body);

    expect(viaToken.byProject.map((p) => p.project.slug)).toEqual(['checkout']);
    expect(viaToken.runCount).toBe(1);
    // The positive control: the same org, asked by a credential that names no
    // project, sees both — so the line above is the scope and not an empty org.
    expect(viaSession.byProject.map((p) => p.project.slug).sort()).toEqual([
      'checkout',
      'other-project',
    ]);
    expect(viaSession.runCount).toBe(2);
  });

  it('names why each listed run needs attention', async () => {
    const smoke = await seedTest('checkout-smoke');
    // A platform gate that failed AND a simulation check that failed: the two
    // clauses a status or a verdict alone could not both have shown.
    await seedRun(HOUR, {
      testId: smoke.id,
      status: 'complete',
      verdict: 'failed',
      toolAssertions: [
        { expression: 'p95 < 100', actualValue: 250, outcome: 'failed' },
        { expression: 'ko < 1%', actualValue: 0, outcome: 'passed' },
      ],
    });

    const body = parse((await asSession(PATH)).body);

    expect(body.attentionTotal).toBe(1);
    expect(body.attention).toHaveLength(1);
    const row = body.attention[0]!;
    expect(row.test?.slug).toBe('checkout-smoke');
    expect(row.project.slug).toBe('checkout');
    expect(row.run.checks).toEqual({ failed: 1, total: 2 });
    expect(row.reasons).toEqual(['gate_failed', 'assertion_failed']);
  });

  it('reports the true attention count beyond the twenty rows it sends', async () => {
    for (let i = 0; i < 21; i += 1) {
      const t = await seedTest(`soak-${i}`);
      await seedRun(HOUR + i * 1000, { testId: t.id, status: 'failed', verdict: null });
    }

    const body = parse((await asSession(PATH)).body);

    expect(body.attention).toHaveLength(20);
    expect(body.attentionTotal).toBe(21);
  });

  it('adds the day counts up, and rates what has finished by what needs attention', async () => {
    await seedRun(HOUR);
    await seedRun(2 * HOUR);
    await seedRun(3 * HOUR);
    await seedRun(4 * HOUR, { status: 'failed', verdict: null });
    await seedRun(5 * HOUR, { status: 'running', verdict: null });

    const body = parse((await asSession(PATH)).body);

    expect(body.runCount).toBe(5);
    // 3 successful over 3 successful plus 1 needing attention. The running run
    // is in `runCount` and in neither side of the rate, so 3/4 and not 3/5.
    expect(body.passRate).toBe(0.75);
    expect(body.running).toBe(1);
  });

  it('answers a null passRate when nothing has finished', async () => {
    await seedRun(HOUR, { status: 'running', verdict: null });
    await seedRun(2 * HOUR, { status: 'pending', verdict: null });

    const body = parse((await asSession(PATH)).body);

    // `0 / 0` is not a rate: the page shows the run count alone.
    expect(body.passRate).toBeNull();
    expect(body.runCount).toBe(2);
    expect(body.running).toBe(1);
  });

  it('answers an empty organisation with seven empty days and no last run', async () => {
    const body = parse((await asSession(PATH)).body);

    expect(body.days.every((d) => d.total === 0)).toBe(true);
    expect(body.runCount).toBe(0);
    expect(body.passRate).toBeNull();
    expect(body.attention).toEqual([]);
    expect(body.attentionTotal).toBe(0);
    expect(body.lastRun).toBeNull();
  });

  it('refuses an unauthenticated request', async () => {
    const res = await request(ctx.app.getHttpServer()).get(PATH);
    expect(res.status).toBe(401);
  });
});
