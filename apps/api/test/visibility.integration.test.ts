import { randomUUID } from 'node:crypto';
import {
  ActivityResponseSchema,
  OrgTestListResponseSchema,
  ProjectListResponseSchema,
  RunListResponseSchema,
  type ProjectRole,
} from '@perfportal/contracts';
import { ProjectMemberRepository } from '@perfportal/persistence';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestContext } from './support/app.js';
import { signInAsAdmin, signInAsProjectMember } from './support/session.js';

/**
 * ═══ THE FOUR ORG-WIDE LISTS SHOW A SESSION ONLY ITS OWN PROJECTS ═══
 *
 * `GET /v1/projects`, `/v1/runs`, `/v1/tests` and `/v1/activity` name no
 * project in their path, so `AccessGuard` lets every session through them
 * (`@NotProjectScoped`), and what keeps a member to their own projects is the
 * READ: each list narrows to the session's projects, or to none at all.
 *
 * Two projects in ONE org, because the org boundary is already pinned
 * elsewhere and is not what this file is about: `checkout` (A, the fixture's
 * own, with a passing run) and `search` (B, with a failed run and a running
 * one). B's runs arrive AFTER A's and fail, so without the filter B is what a
 * reader of A would see first everywhere — the newest run, the last run, the
 * attention list and the running count.
 */

let ctx: TestContext;
let A: string;
let B: string;
let runA: string;
let runBFailed: string;
let runBRunning: string;

beforeEach(async () => {
  ctx = await createTestApp();
  A = ctx.projectId;
  B = (
    await ctx.prisma.project.create({ data: { orgId: ctx.orgId, slug: 'search', name: 'Search', settings: {} } })
  ).id;

  const testA = await seedTest(A, 'checkout-smoke');
  // Two tests in B, because the attention list is the LATEST run per test:
  // a running run of the failed run's own test would supersede the failure.
  const soakB = await seedTest(B, 'search-soak');
  const liveB = await seedTest(B, 'search-live');
  // Minutes before now: inside the activity glance and its attention window,
  // which end at the request's own "now". A first, then B, so B is the newer
  // arrival AND the newer start.
  runA = await seedRun(A, testA, 30, { status: 'complete', verdict: 'passed' });
  runBFailed = await seedRun(B, soakB, 20, { status: 'complete', verdict: 'failed' });
  runBRunning = await seedRun(B, liveB, 10, { status: 'running', verdict: null });
});

afterEach(async () => {
  await ctx?.close();
});

async function seedTest(projectId: string, slug: string): Promise<string> {
  const test = await ctx.prisma.test.create({
    data: { orgId: ctx.orgId, projectId, slug, name: slug, simulationClass: `com.acme.${slug}` },
  });
  return test.id;
}

async function seedRun(
  projectId: string,
  testId: string,
  minutesAgo: number,
  state: { status: string; verdict: string | null },
): Promise<string> {
  const id = randomUUID();
  const at = new Date(Date.now() - minutesAgo * 60_000);
  await ctx.prisma.run.create({
    data: {
      id,
      orgId: ctx.orgId,
      projectId,
      testId,
      ...state,
      tool: 'gatling',
      bundleKey: `runs/${projectId}/${id}.tgz`,
      bundleSha256: 'a'.repeat(64),
      bundleBytes: 1n,
      createdAt: at,
      startedAt: at,
      startedOn: new Date(at.toISOString().slice(0, 10)),
      engineOptions: {},
    },
  });
  return id;
}

const member = (email: string, projects: ReadonlyArray<{ projectId: string; role: ProjectRole }>) =>
  signInAsProjectMember(ctx, `${email}-${randomUUID()}@example.test`, projects);

function get(path: string, credential: { cookie: string } | { token: string }) {
  const req = request(ctx.app.getHttpServer()).get(path);
  return 'cookie' in credential
    ? req.set('Cookie', credential.cookie)
    : req.set('Authorization', `Bearer ${credential.token}`);
}

/** What each of the four lists shows this credential, in a shape one assertion can compare. */
async function seen(credential: { cookie: string } | { token: string }) {
  const projects = await get('/v1/projects', credential);
  const runs = await get('/v1/runs', credential);
  const tests = await get('/v1/tests', credential);
  const activity = await get('/v1/activity?tz=UTC', credential);
  expect([projects.status, runs.status, tests.status, activity.status]).toStrictEqual([200, 200, 200, 200]);

  const a = ActivityResponseSchema.parse(activity.body);
  return {
    projects: ProjectListResponseSchema.parse(projects.body).items.map((p) => ({ slug: p.slug, role: p.role })),
    runs: RunListResponseSchema.parse(runs.body).items.map((r) => r.id),
    tests: OrgTestListResponseSchema.parse(tests.body).items.map((t) => t.slug),
    activity: {
      runCount: a.runCount,
      running: a.running,
      byProject: a.byProject.map((p) => [p.project.slug, p.runs]),
      attention: a.attention.map((row) => row.run.id),
      attentionTotal: a.attentionTotal,
      lastRun: a.lastRun?.id ?? null,
    },
  };
}

/** A problem body with its traceId dropped and the caller-supplied identifier masked. */
function masked(body: Record<string, unknown>, identifier: string): Record<string, unknown> {
  const { traceId, ...rest } = body;
  expect(typeof traceId).toBe('string');
  return JSON.parse(JSON.stringify(rest).replaceAll(identifier, '<target>')) as Record<string, unknown>;
}

describe('the org-wide lists, for a session', () => {
  it("show a viewer of A only A, carrying the viewer's role", async () => {
    const viewer = await member('viewer', [{ projectId: A, role: 'viewer' }]);

    expect(await seen(viewer)).toStrictEqual({
      projects: [{ slug: 'checkout', role: 'viewer' }],
      runs: [runA],
      tests: ['checkout-smoke'],
      activity: {
        runCount: 1,
        running: 0,
        byProject: [['checkout', 1]],
        attention: [],
        attentionTotal: 0,
        lastRun: runA,
      },
    });
  });

  /**
   * REVIEW FOCUS 1. `projectIds: []` is a person who belongs to no project
   * and `projectIds` absent is one who may see everything — a list that read
   * the empty array as "no filter" would hand this member the whole org,
   * which is exactly what the arrange above makes visible if it does.
   */
  it('show a member of no project nothing at all', async () => {
    const nobody = await member('nobody', []);

    expect(await seen(nobody)).toStrictEqual({
      projects: [],
      runs: [],
      tests: [],
      activity: { runCount: 0, running: 0, byProject: [], attention: [], attentionTotal: 0, lastRun: null },
    });
  });

  it("carry each project's own role for a member of several", async () => {
    const both = await member('both', [
      { projectId: A, role: 'member' },
      { projectId: B, role: 'manager' },
    ]);

    expect((await seen(both)).projects).toStrictEqual([
      { slug: 'checkout', role: 'member' },
      { slug: 'search', role: 'manager' },
    ]);
  });

  it('show an admin with no membership everything, with role null', async () => {
    const { cookie } = await signInAsAdmin(ctx, `admin-${randomUUID()}@example.test`);

    expect(await seen({ cookie })).toStrictEqual({
      projects: [
        { slug: 'checkout', role: null },
        { slug: 'search', role: null },
      ],
      runs: [runBRunning, runBFailed, runA],
      tests: ['search-live', 'search-soak', 'checkout-smoke'],
      activity: {
        runCount: 3,
        running: 1,
        byProject: [
          ['search', 2],
          ['checkout', 1],
        ],
        attention: [runBFailed],
        attentionTotal: 1,
        lastRun: runBRunning,
      },
    });
  });

  it("show an admin their own role where they hold a row, and null where they do not", async () => {
    const admin = await signInAsAdmin(ctx, `admin-row-${randomUUID()}@example.test`);
    await new ProjectMemberRepository(ctx.prisma).add({ projectId: B, userId: admin.userId, role: 'manager', addedBy: null });

    expect((await seen(admin)).projects).toStrictEqual([
      { slug: 'checkout', role: null },
      { slug: 'search', role: 'manager' },
    ]);
  });

  /**
   * REVIEW FOCUS 3. Roles are read per request and never cached on the
   * session, so the same cookie, unchanged, sees the removal on its very next
   * request — no sign-out, no expiry.
   */
  it('take a removed membership away on the next request', async () => {
    const viewer = await member('removed', [{ projectId: A, role: 'viewer' }]);
    expect((await seen(viewer)).projects).toStrictEqual([{ slug: 'checkout', role: 'viewer' }]);

    await new ProjectMemberRepository(ctx.prisma).remove(A, viewer.userId);

    expect(await seen(viewer)).toStrictEqual({
      projects: [],
      runs: [],
      tests: [],
      activity: { runCount: 0, running: 0, byProject: [], attention: [], attentionTotal: 0, lastRun: null },
    });
  });
});

/**
 * ═══ NO FILTER MAY TELL "NOT YOURS" FROM "NOT THERE" ═══
 *
 * Once the lists are narrowed, any parameter that names something by its own
 * identifier is a question about whether that thing exists — and an answer
 * that differs between an invisible project and a missing one lists which
 * exist. `GET /v1/runs` is the one list with such parameters: `project` (with
 * `test` and `number` behind it, which need it) and `cursor`, a run id.
 */
describe('GET /v1/runs filters, for a session that cannot see B', () => {
  it('answers ?project=<B> with the 404 a missing project gets', async () => {
    const viewer = await member('probe', [{ projectId: A, role: 'viewer' }]);

    const invisible = await get('/v1/runs?project=search', viewer);
    const missing = await get('/v1/runs?project=no-such-project', viewer);

    expect([invisible.status, missing.status]).toStrictEqual([404, 404]);
    expect(masked(invisible.body, 'search')).toStrictEqual(masked(missing.body, 'no-such-project'));

    // `test` needs `project`, and the project is refused first.
    const withTest = await get('/v1/runs?project=search&test=search-soak', viewer);
    const missingWithTest = await get('/v1/runs?project=no-such-project&test=search-soak', viewer);
    expect(masked(withTest.body, 'search')).toStrictEqual(masked(missingWithTest.body, 'no-such-project'));

    // The project it CAN see still filters as before.
    const own = await get('/v1/runs?project=checkout', viewer);
    expect(RunListResponseSchema.parse(own.body).items.map((r) => r.id)).toStrictEqual([runA]);
  });

  /**
   * A cursor is a run id, resolved to its sort position. Resolved without the
   * session's projects, B's run would continue the page from where B's run
   * sits — A's older run — while a run id that does not exist answers an empty
   * page: the difference says the id exists.
   */
  it("answers a cursor naming B's run as it answers one naming no run", async () => {
    const viewer = await member('cursor', [{ projectId: A, role: 'viewer' }]);

    const invisible = await get(`/v1/runs?cursor=${runBRunning}`, viewer);
    const missing = await get(`/v1/runs?cursor=${randomUUID()}`, viewer);

    expect([invisible.status, invisible.body]).toStrictEqual([200, { items: [], nextCursor: null }]);
    expect([missing.status, missing.body]).toStrictEqual([200, { items: [], nextCursor: null }]);
  });
});

/**
 * ═══ A BEARER TOKEN IS UNCHANGED ═══
 *
 * A token is minted against one project and its reach is that project, as it
 * always was; the session's project list never applies to it. The one new
 * thing it sees is `role: null` on its project, since a machine credential
 * holds no role.
 */
describe('the org-wide lists, for a bearer token of A', () => {
  it('show only A, with role null', async () => {
    expect(await seen({ token: ctx.readToken })).toStrictEqual({
      projects: [{ slug: 'checkout', role: null }],
      runs: [runA],
      tests: ['checkout-smoke'],
      activity: {
        runCount: 1,
        running: 0,
        byProject: [['checkout', 1]],
        attention: [],
        attentionTotal: 0,
        lastRun: runA,
      },
    });
  });

  it('still answers ?project=<B> with PROJECT_MISMATCH, not the 404', async () => {
    const res = await get('/v1/runs?project=search', { token: ctx.readToken });
    expect([res.status, res.body.code]).toStrictEqual([400, 'PROJECT_MISMATCH']);
  });
});
