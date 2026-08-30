import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RuleRepository } from '@perfportal/persistence';
import { createTestApp, type TestContext } from './support/app.js';
import { signUpAsOrgMember } from './support/session.js';

let ctx: TestContext;
let cookie: string;

beforeEach(async () => {
  ctx = await createTestApp();
  // A REAL MEMBER of ctx's own org, not `signUpAndLogin`'s org-less user. A
  // no-membership session 403s the same way `SessionOnlyGuard` refuses a
  // bearer token, so the wrong helper would make "accepts a session" pass for
  // entirely the wrong reason — the same trap tokens.integration.test.ts
  // records.
  cookie = await signUpAsOrgMember(ctx, 'rule-author@example.test');
});

afterEach(async () => {
  await ctx?.close();
});

const RULES = '/v1/projects/checkout/rules';

const runRule = (over: Record<string, unknown> = {}) => ({
  scope: 'run',
  targetName: null,
  family: 'response_time',
  metric: 'p95',
  comparator: 'lte',
  threshold: 800,
  ...over,
});

const asSession = (method: 'post' | 'get' | 'patch' | 'delete', path: string) =>
  request(ctx.app.getHttpServer())[method](path).set('Cookie', cookie);

/**
 * ═══ EVERY STATUS ASSERTION IN THIS FILE CARRIES THE BODY ═══
 *
 * `expect(res.status).toBe(201)` reports `expected 501 to be 201` and nothing
 * else — no code, no detail, no remediation, and no way to tell a server
 * error from a guard doing its job. This suite produced exactly that once, in
 * a full run, and passed on every rerun; with the body attached, the same
 * failure would have arrived with the problem document that explains it.
 *
 * The cost is one argument per assertion and it is paid only on failure:
 * vitest evaluates the message eagerly, but `JSON.stringify` of a parsed
 * response body is nothing next to the HTTP round trip above it.
 */
const createRule = async (over: Record<string, unknown> = {}) => {
  const res = await asSession('post', RULES).send(runRule(over));
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { id: string; [k: string]: unknown };
};

describe('POST /v1/projects/:slug/rules', () => {
  it('creates a rule and returns it complete, with an id and both instants', async () => {
    const res = await asSession('post', RULES).send(runRule({ name: 'Checkout p95 gate' }));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({
      name: 'Checkout p95 gate',
      scope: 'run',
      targetName: null,
      family: 'response_time',
      metric: 'p95',
      comparator: 'lte',
      threshold: 800,
      enabled: true,
    });
    expect(res.body.id).toMatch(/^[0-9a-f-]{36}$/);
    // The 201 is earned on `openapi.integration.test.ts`'s standard — the row
    // is complete and addressable the instant the response is sent — so the
    // response must actually carry the stored instants, not placeholders.
    expect(Number.isNaN(Date.parse(res.body.createdAt))).toBe(false);
    expect(Number.isNaN(Date.parse(res.body.updatedAt))).toBe(false);
  });

  it('names the rule null when the author gave it none', async () => {
    const res = await asSession('post', RULES).send(runRule());
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.name).toBeNull();
  });

  /**
   * ═══ THE REASON THIS ENDPOINT EXISTS ═══
   *
   * `resolveMetric` returns null for a name it cannot resolve and
   * `evaluateRules` records `not_applicable` rather than failing. So without
   * this rejection, `p95th` saves happily and then reads "not checked" on
   * every run forever while looking like configured protection. The 400 is the
   * only moment anything can tell the author.
   */
  it('refuses a metric the evaluator could never resolve', async () => {
    const res = await asSession('post', RULES).send(runRule({ metric: 'p95th' }));
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body.code).toBe('INVALID_SLA_RULE');
    // The remediation must name what IS valid — a 400 that only says "invalid"
    // leaves the author guessing at the very thing they got wrong.
    expect(res.body.remediation).toContain('p95');
  });

  it.each(['p0', 'p100', 'P95', 'errorRate'])('refuses the unresolvable metric %s', async (metric) => {
    const res = await asSession('post', RULES).send(runRule({ metric }));
    expect(res.status, JSON.stringify(res.body)).toBe(400);
  });

  /**
   * `error_rate` and `throughput_rps` need no new rule FAMILY — `family`
   * selects the stat row and `metric` selects the value out of it. This case
   * exists because the opposite was believed and nearly acted on.
   */
  it.each(['error_rate', 'throughput_rps', 'count', 'mean', 'p99.9'])(
    'accepts %s, which needs no new family',
    async (metric) => {
      const res = await asSession('post', RULES).send(runRule({ metric, comparator: 'gte' }));
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.metric).toBe(metric);
    },
  );

  it('refuses a target on a run rule and a missing one on a request rule', async () => {
    const withTarget = await asSession('post', RULES).send(runRule({ targetName: 'GET /catalog' }));
    expect(withTarget.status).toBe(400);

    const withoutTarget = await asSession('post', RULES).send(runRule({ scope: 'request' }));
    expect(withoutTarget.status).toBe(400);

    const correct = await asSession('post', RULES).send(
      runRule({ scope: 'request', targetName: 'GET /catalog' }),
    );
    expect(correct.status).toBe(201);
  });

  it('refuses a threshold no comparison could pass', async () => {
    const res = await asSession('post', RULES).send({ ...runRule(), threshold: 'soon' });
    expect(res.status, JSON.stringify(res.body)).toBe(400);
  });

  // ═══ The guard, both directions ═══
  it('refuses a bearer token even one holding read scope', async () => {
    const res = await request(ctx.app.getHttpServer())
      .post(RULES)
      .set('Authorization', `Bearer ${ctx.readToken}`)
      .send(runRule());
    expect(res.status, JSON.stringify(res.body)).toBe(403);
  });

  it('404s for a project in another organisation, never 403', async () => {
    const other = await ctx.prisma.org.create({ data: { slug: 'other-org-rules', name: 'Other' } });
    await ctx.prisma.project.create({
      data: { orgId: other.id, slug: 'other-rules-project', name: 'Other' },
    });
    const res = await asSession('post', '/v1/projects/other-rules-project/rules').send(runRule());
    expect(res.status, JSON.stringify(res.body)).toBe(404);
  });
});

describe('GET /v1/projects/:slug/rules', () => {
  it('lists disabled rules too, newest first', async () => {
    const first = await createRule({ name: 'first' });
    await createRule({ name: 'second', metric: 'p99' });
    await asSession('patch', `${RULES}/${first.id}`).send({ enabled: false });

    const res = await asSession('get', RULES);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const names = (res.body.rules as { name: string }[]).map((r) => r.name);
    // An authoring list MUST show a disabled rule — "disabled" is a state a
    // reader put it in and has to be able to undo. `listEnabled`, which
    // evaluation uses, stays as narrow as it was.
    expect(names).toContain('first');
    expect(names).toContain('second');
    expect(names.indexOf('second')).toBeLessThan(names.indexOf('first'));
  });

  it('does not leak another organisation’s rules', async () => {
    await createRule({ name: 'ours' });
    const other = await ctx.prisma.org.create({ data: { slug: 'other-org-list', name: 'Other' } });
    const otherProject = await ctx.prisma.project.create({
      data: { orgId: other.id, slug: 'other-list-project', name: 'Other' },
    });
    await ctx.prisma.slaRule.create({
      data: {
        orgId: other.id,
        projectId: otherProject.id,
        scope: 'run',
        targetName: null,
        family: 'response_time',
        metric: 'p95',
        comparator: 'lte',
        threshold: 1,
        name: 'theirs',
      },
    });

    const res = await asSession('get', RULES);
    const names = (res.body.rules as { name: string }[]).map((r) => r.name);
    expect(names).toContain('ours');
    expect(names).not.toContain('theirs');
  });
});

describe('PATCH /v1/projects/:slug/rules/:ruleId', () => {
  it('retunes a threshold and moves updatedAt', async () => {
    const created = await createRule();
    const res = await asSession('patch', `${RULES}/${created.id}`).send({ threshold: 1200 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.threshold).toBe(1200);
    expect(Date.parse(res.body.updatedAt)).toBeGreaterThanOrEqual(
      Date.parse(created.createdAt as string),
    );
  });

  it('silences and restores a rule without deleting it', async () => {
    const created = await createRule();
    const off = await asSession('patch', `${RULES}/${created.id}`).send({ enabled: false });
    expect(off.body.enabled).toBe(false);
    const on = await asSession('patch', `${RULES}/${created.id}`).send({ enabled: true });
    expect(on.body.enabled).toBe(true);
  });

  /**
   * A rule's identity is WHAT it measures. Re-aiming one keeps its id while
   * every assertion already recorded against it describes a measurement it
   * never took — `ruleSnapshot` survives a threshold change and cannot help
   * with that. `.strict()` is what makes each of these a 400 rather than a
   * silently ignored field.
   */
  it.each([{ metric: 'p99' }, { scope: 'request' }, { family: 'latency' }, { comparator: 'gte' }])(
    'refuses %j, which would re-aim the rule rather than retune it',
    async (patch) => {
      const created = await createRule();
      const res = await asSession('patch', `${RULES}/${created.id}`).send(patch);
      expect(res.status, JSON.stringify(res.body)).toBe(400);
    },
  );

  it('refuses an empty patch rather than reporting a write it never made', async () => {
    const created = await createRule();
    const res = await asSession('patch', `${RULES}/${created.id}`).send({});
    expect(res.status, JSON.stringify(res.body)).toBe(400);
  });

  it('404s for a rule id that belongs to another organisation', async () => {
    const other = await ctx.prisma.org.create({ data: { slug: 'other-org-patch', name: 'Other' } });
    const otherProject = await ctx.prisma.project.create({
      data: { orgId: other.id, slug: 'other-patch-project', name: 'Other' },
    });
    const theirs = await ctx.prisma.slaRule.create({
      data: {
        orgId: other.id,
        projectId: otherProject.id,
        scope: 'run',
        targetName: null,
        family: 'response_time',
        metric: 'p95',
        comparator: 'lte',
        threshold: 1,
      },
    });

    const res = await asSession('patch', `${RULES}/${theirs.id}`).send({ threshold: 5 });
    expect(res.status, JSON.stringify(res.body)).toBe(404);
    // And it really was not touched — a 404 that still wrote would be the
    // worst possible outcome.
    const after = await ctx.prisma.slaRule.findUnique({ where: { id: theirs.id } });
    expect(after?.threshold).toBe(1);
  });

  it('400s on a rule id that is not a UUID at all', async () => {
    const res = await asSession('patch', `${RULES}/not-a-uuid`).send({ threshold: 5 });
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body.code).toBe('INVALID_ID');
  });
});

describe('DELETE /v1/projects/:slug/rules/:ruleId', () => {
  it('removes the rule and returns what it removed', async () => {
    const created = await createRule({ name: 'retired' });
    const res = await asSession('delete', `${RULES}/${created.id}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ id: created.id, name: 'retired' });

    const list = await asSession('get', RULES);
    expect((list.body.rules as { id: string }[]).map((r) => r.id)).not.toContain(created.id);
  });

  it('404s the second time, so a repeated delete never reports a phantom success', async () => {
    const created = await createRule();
    expect((await asSession('delete', `${RULES}/${created.id}`)).status).toBe(200);
    expect((await asSession('delete', `${RULES}/${created.id}`)).status).toBe(404);
  });

  /**
   * `run_assertion.rule_id` carries no foreign key to `sla_rule` by design:
   * a verdict already recorded is history and must survive the rule that
   * produced it being retired. Deleting the rule must therefore leave the
   * assertion — and its `ruleSnapshot` — exactly where it was.
   */
  it('leaves an already-recorded assertion intact', async () => {
    const created = await createRule();
    const run = await ctx.prisma.run.create({
      data: {
        orgId: ctx.orgId,
        projectId: ctx.projectId,
        status: 'complete',
        tool: 'gatling',
        bundleKey: 'runs/rules-delete.tgz',
        bundleSha256: 'a'.repeat(64),
        bundleBytes: BigInt(1),
        startedAt: new Date('2026-08-22T10:00:00Z'),
        startedOn: new Date('2026-08-22T00:00:00Z'),
        engineOptions: {},
        ingestedAt: new Date('2026-08-22T10:00:01Z'),
      },
    });
    await ctx.prisma.runAssertion.create({
      data: {
        runId: run.id,
        orgId: ctx.orgId,
        projectId: ctx.projectId,
        ruleId: created.id,
        outcome: 'failed',
        actualValue: 900,
        message: 'p95 exceeded',
        ruleSnapshot: { metric: 'p95', threshold: 800 },
      },
    });

    expect((await asSession('delete', `${RULES}/${created.id}`)).status).toBe(200);

    const assertions = await ctx.prisma.runAssertion.findMany({ where: { runId: run.id } });
    expect(assertions).toHaveLength(1);
    expect(assertions[0]?.ruleSnapshot).toMatchObject({ metric: 'p95', threshold: 800 });
  });

  it('refuses a bearer token', async () => {
    const created = await createRule();
    const res = await request(ctx.app.getHttpServer())
      .delete(`${RULES}/${created.id}`)
      .set('Authorization', `Bearer ${ctx.readToken}`);
    expect(res.status, JSON.stringify(res.body)).toBe(403);
  });
});

/**
 * ═══ THE ROUND TRIP ═══
 *
 * Every case above proves a row was written. This one proves the rule the API
 * wrote is the rule the EVALUATOR reads — the same shape `listEnabled` returns
 * to the pipeline and the fold owner. Without it, the whole endpoint could be
 * writing rows in a shape nothing evaluates.
 */
describe('a rule authored through the API is one the evaluator would load', () => {
  it('appears in the enabled set with every field the evaluator needs', async () => {
    const created = await createRule({ metric: 'error_rate', comparator: 'lte', threshold: 0.01 });

    const enabled = await ctx.prisma.slaRule.findMany({
      where: { orgId: ctx.orgId, projectId: ctx.projectId, enabled: true },
    });
    const mine = enabled.find((r) => r.id === created.id);
    expect(mine).toBeDefined();
    expect(mine).toMatchObject({
      scope: 'run',
      targetName: null,
      family: 'response_time',
      metric: 'error_rate',
      comparator: 'lte',
      threshold: 0.01,
    });
  });

  it('disappears from the enabled set the moment it is silenced', async () => {
    const created = await createRule();
    await asSession('patch', `${RULES}/${created.id}`).send({ enabled: false });

    const enabled = await ctx.prisma.slaRule.findMany({
      where: { orgId: ctx.orgId, projectId: ctx.projectId, enabled: true },
    });
    expect(enabled.map((r) => r.id)).not.toContain(created.id);
  });
});

/**
 * ═══ A RULE MAY NOW JUDGE ONE TEST INSTEAD OF THE WHOLE PROJECT ═══
 *
 * The point of the feature, and the one thing worth proving against a real
 * database: that `RuleRepository.listEnabled` — the query the pipeline and the
 * fold owner both evaluate from — returns the right SET for a given run.
 *
 * Everything here is `listEnabled` rather than a HTTP read, deliberately. A
 * list endpoint can be right while evaluation is wrong, and evaluation is the
 * half that decides whether somebody's deploy is blocked.
 */
describe('rules scoped to one test', () => {
  const seedTest = (slug: string, simulationClass: string) =>
    ctx.prisma.test.create({
      data: {
        orgId: ctx.orgId,
        projectId: ctx.projectId,
        slug,
        name: slug,
        simulationClass,
      },
    });

  const listEnabledFor = (testId: string | null) =>
    new RuleRepository(ctx.prisma).listEnabled(
      { orgId: ctx.orgId, projectId: ctx.projectId },
      testId,
    );

  it('creates a rule against a named test and reports which one', async () => {
    const test = await seedTest('payments-sweep', 'shop.PaymentsSimulation');
    const created = await createRule({ testSlug: 'payments-sweep' });
    expect(created.test).toEqual({ id: test.id, slug: 'payments-sweep', name: 'payments-sweep' });
  });

  it('reports null for a rule nobody scoped, which is every rule that existed before', async () => {
    const created = await createRule();
    expect(created.test).toBeNull();
  });

  /**
   * 404, never a silently project-wide rule. That is the failure mode that
   * matters: a gate applied to everything looks exactly like a gate applied to
   * something, and nothing on any screen afterwards distinguishes them.
   */
  it('404s an unknown test slug rather than widening the rule to everything', async () => {
    const res = await asSession('post', RULES).send(runRule({ testSlug: 'no-such-test' }));
    expect(res.status, JSON.stringify(res.body)).toBe(404);
    expect(await ctx.prisma.slaRule.count()).toBe(0);
  });

  /**
   * ═══ THE CASE THE WHOLE MIGRATION EXISTS FOR ═══
   *
   * Three rules, three different answers, and each one is a different way the
   * filter could be wrong: dropping the project-wide rule from a test's set,
   * leaking one test's rule into another's, or letting a test rule judge a run
   * that belongs to no test at all.
   */
  it('gives each run the project-wide rules plus its own test’s, and nobody else’s', async () => {
    const payments = await seedTest('payments-sweep', 'shop.PaymentsSimulation');
    const search = await seedTest('search-latency', 'shop.SearchSimulation');

    const wide = await createRule({ name: 'Project error floor', metric: 'error_rate' });
    const paymentsOnly = await createRule({ name: 'Payments p95', testSlug: 'payments-sweep' });
    const searchOnly = await createRule({ name: 'Search p95', testSlug: 'search-latency' });

    const forPayments = (await listEnabledFor(payments.id)).map((r) => r.id);
    expect(forPayments).toContain(wide.id);
    expect(forPayments).toContain(paymentsOnly.id);
    expect(forPayments).not.toContain(searchOnly.id);

    const forSearch = (await listEnabledFor(search.id)).map((r) => r.id);
    expect(forSearch).toEqual(expect.arrayContaining([wide.id, searchOnly.id]));
    expect(forSearch).not.toContain(paymentsOnly.id);

    // A run with no test — still pending, or one that failed before the worker
    // could read its simulation class. It gets the project-wide rule and
    // nothing else: it is not a run of anything a test rule could be about.
    expect(await listEnabledFor(null)).toEqual([expect.objectContaining({ id: wide.id })]);
  });

  it('still honours enabled, so silencing a test rule silences it for that test', async () => {
    const payments = await seedTest('payments-sweep', 'shop.PaymentsSimulation');
    const scoped = await createRule({ testSlug: 'payments-sweep' });

    expect((await listEnabledFor(payments.id)).map((r) => r.id)).toContain(scoped.id);
    await asSession('patch', `${RULES}/${scoped.id}`).send({ enabled: false });
    expect((await listEnabledFor(payments.id)).map((r) => r.id)).not.toContain(scoped.id);
  });

  /**
   * ═══ THE LIST FILTER IS A UNION, NOT AN EQUALITY ═══
   *
   * `?test=` answers "what gates this test". Reading it as `test_id = <id>`
   * would hide every gate the project applies to everything — so a reader
   * checking whether their org's error-rate floor was configured would find it
   * missing from the one page they went to look.
   */
  it('lists a test’s own rules AND the project-wide ones under ?test=', async () => {
    await seedTest('payments-sweep', 'shop.PaymentsSimulation');
    await seedTest('search-latency', 'shop.SearchSimulation');
    const wide = await createRule({ name: 'Project error floor', metric: 'error_rate' });
    const paymentsOnly = await createRule({ name: 'Payments p95', testSlug: 'payments-sweep' });
    const searchOnly = await createRule({ name: 'Search p95', testSlug: 'search-latency' });

    const res = await asSession('get', `${RULES}?test=payments-sweep`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const ids = (res.body.rules as { id: string }[]).map((r) => r.id);
    expect(ids).toEqual(expect.arrayContaining([wide.id, paymentsOnly.id]));
    expect(ids).not.toContain(searchOnly.id);
  });

  it('lists every rule in the project when no test is named', async () => {
    await seedTest('payments-sweep', 'shop.PaymentsSimulation');
    const wide = await createRule({ metric: 'error_rate' });
    const scoped = await createRule({ testSlug: 'payments-sweep' });

    const res = await asSession('get', RULES);
    const ids = (res.body.rules as { id: string }[]).map((r) => r.id);
    expect(ids).toEqual(expect.arrayContaining([wide.id, scoped.id]));
  });

  it('404s ?test= for a slug that names nothing, rather than answering unfiltered', async () => {
    await createRule();
    const res = await asSession('get', `${RULES}?test=no-such-test`);
    expect(res.status, JSON.stringify(res.body)).toBe(404);
  });

  /**
   * ═══ CASCADE, WHERE `run.test_id` IS SET NULL ═══
   *
   * A run is history and survives its test being deleted, ungrouped. A rule is
   * configuration: one pointing at a test that no longer exists would judge
   * nothing forever while still reading as configured protection in an
   * authoring list. Verdicts already recorded are untouched either way —
   * `run_assertion` has no foreign key here and keeps its own snapshot.
   */
  it('deletes a test’s rules with the test, and leaves the project-wide ones', async () => {
    const payments = await seedTest('payments-sweep', 'shop.PaymentsSimulation');
    const wide = await createRule({ metric: 'error_rate' });
    const scoped = await createRule({ testSlug: 'payments-sweep' });

    await ctx.prisma.test.delete({ where: { id: payments.id } });

    const remaining = (await ctx.prisma.slaRule.findMany()).map((r) => r.id);
    expect(remaining).toContain(wide.id);
    expect(remaining).not.toContain(scoped.id);
  });
});
