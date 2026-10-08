import { randomUUID } from 'node:crypto';
import { Body, Controller, Delete, Param, Put } from '@nestjs/common';
import type { ApplicationConfig } from '@nestjs/core';
import { RunNoteRequestSchema } from '@perfportal/contracts';
import { RunRepository } from '@perfportal/persistence';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { Requires } from '../src/auth/access.decorator.js';
import { AccessGuard } from '../src/auth/access.guard.js';
import { AuthGuard } from '../src/auth/auth.guard.js';
import { PasswordChangeGuard } from '../src/auth/password-change.guard.js';
import { badRequest, uuidParam } from '../src/common/validation.js';
import { createTestApp, type TestContext } from './support/app.js';
import { signInAsProjectMember } from './support/session.js';

/**
 * ═══ AccessGuard RUNS LAST, AFTER THE PASSWORD GATE ═══
 *
 * `auth.module.ts` lists the APP_GUARDs AuthGuard, PasswordChangeGuard,
 * AccessGuard, and says the list order is the run order. That is Nest's
 * behaviour, not a guarantee of this codebase's, so it is read back from the
 * running app rather than from the module's source: `getGlobalGuards()` is
 * the array `GuardsConsumer` walks, in order, for every route. The gate has
 * to come before AccessGuard, or a session that has not chosen its password
 * is told by AccessGuard's 404s and ADMIN_REQUIRED which projects exist and
 * what it may do. A reordering — or a second registration of any — fails here
 * naming the actual list.
 *
 * `config` is NestApplication's own, private to TypeScript only.
 */
describe('the global guards', () => {
  let ctx: TestContext;
  afterEach(async () => {
    await ctx?.close();
  });

  it('run AuthGuard, then PasswordChangeGuard, then AccessGuard, and nothing else', async () => {
    ctx = await createTestApp();
    const config = (ctx.app as unknown as { config: ApplicationConfig }).config;

    expect(config.getGlobalGuards().map((g) => g.constructor)).toStrictEqual([
      AuthGuard,
      PasswordChangeGuard,
      AccessGuard,
    ]);
  });
});

/*
 * ═══ A MISSING TARGET AND AN INVISIBLE ONE GET THE SAME ANSWER ═══
 *
 * Guards run before parameter pipes and before the handler. So if the guard
 * let a target it could not find through to the controller, anything that
 * fails AFTER the guard and BEFORE the controller's own lookup — a uuid pipe
 * on a sub-parameter, a body check — would answer a missing target, while an
 * invisible one got the guard's 404. Comparing the two would list which
 * project slugs and run ids exist.
 *
 * These two test-only routes reproduce the two shapes that leaked, with
 * nothing else of a real handler around them: a project route with
 * a uuid-piped sub-parameter (a rule's DELETE, a package, a runner job), and a
 * run route whose handler checks its body before looking the run up (the
 * run note's PUT). Each mirrors its real counterpart's pipe and refusal.
 */
@Controller('/v1/projects/:slug/access-probe')
class ProjectRouteProbe {
  @Delete(':subId')
  @Requires('rules:edit')
  remove(@Param('subId', uuidParam('subId')) subId: string): { subId: string } {
    return { subId };
  }
}

@Controller('/v1/runs/:id/access-probe')
class RunRouteProbe {
  @Put()
  @Requires('run:note')
  put(@Param('id', uuidParam('id')) id: string, @Body() body: unknown): { id: string } {
    if (!RunNoteRequestSchema.safeParse(body).success) {
      throw badRequest('INVALID_RUN_NOTE', 'The note is not valid.', 'Send {"note": "<text>"} or {"note": null}.');
    }
    return { id };
  }
}

/** A problem body with its traceId dropped and the caller-supplied identifier masked. */
function masked(body: Record<string, unknown>, identifier: string): Record<string, unknown> {
  const { traceId, ...rest } = body;
  expect(typeof traceId).toBe('string');
  return JSON.parse(JSON.stringify(rest).replaceAll(identifier, '<target>')) as Record<string, unknown>;
}

describe('AccessGuard on a session that cannot see the target', () => {
  let ctx: TestContext;
  afterEach(async () => {
    await ctx?.close();
  });

  /** `checkout` (the fixture's project, holding one run) exists; the session manages only `search`. */
  async function arrange() {
    ctx = await createTestApp({}, [ProjectRouteProbe, RunRouteProbe]);
    const search = await ctx.prisma.project.create({
      data: { orgId: ctx.orgId, slug: 'search', name: 'Search', settings: {} },
    });
    const run = await new RunRepository(ctx.prisma).create({
      orgId: ctx.orgId,
      projectId: ctx.projectId,
      tool: 'gatling',
      bundleKey: 'bundles/x.tgz',
      bundleSha256: 'a'.repeat(64),
      bundleBytes: 1234,
      startedAt: new Date('2026-08-07T10:00:00Z'),
      engineOptions: { warmupMs: 0, percentiles: [50, 95] },
    });
    const outsider = await signInAsProjectMember(ctx, `outsider-${randomUUID()}@example.test`, [
      { projectId: search.id, role: 'manager' },
    ]);
    const member = await signInAsProjectMember(ctx, `member-${randomUUID()}@example.test`, [
      { projectId: ctx.projectId, role: 'member' },
    ]);
    return { runId: run.id, outsider: outsider.cookie, member: member.cookie };
  }

  it('answers a missing project exactly as an invisible one, before the sub-parameter pipe', async () => {
    const { outsider, member } = await arrange();
    const server = ctx.app.getHttpServer();

    const invisible = await request(server).delete('/v1/projects/checkout/access-probe/not-a-uuid').set('Cookie', outsider);
    const missing = await request(server).delete('/v1/projects/no-such-project/access-probe/not-a-uuid').set('Cookie', outsider);

    expect({ invisible: [invisible.status, invisible.body.detail], missing: [missing.status, missing.body.detail] })
      .toStrictEqual({
        invisible: [404, 'No project "checkout" in this organisation.'],
        missing: [404, 'No project "no-such-project" in this organisation.'],
      });
    expect(masked(missing.body, 'no-such-project')).toStrictEqual(masked(invisible.body, 'checkout'));

    // The route is real and the guard is what answered: a member reaches the pipe.
    const reached = await request(server).delete('/v1/projects/checkout/access-probe/not-a-uuid').set('Cookie', member);
    expect([reached.status, reached.body.code]).toStrictEqual([400, 'INVALID_ID']);
  });

  it('answers a missing run exactly as an invisible one, before the handler checks its body', async () => {
    const { runId, outsider, member } = await arrange();
    const server = ctx.app.getHttpServer();
    const missingId = randomUUID();

    const invisible = await request(server).put(`/v1/runs/${runId}/access-probe`).set('Cookie', outsider).send({ bogus: 1 });
    const missing = await request(server).put(`/v1/runs/${missingId}/access-probe`).set('Cookie', outsider).send({ bogus: 1 });

    expect({ invisible: [invisible.status, invisible.body.detail], missing: [missing.status, missing.body.detail] })
      .toStrictEqual({
        invisible: [404, `No run ${runId} in this project.`],
        missing: [404, `No run ${missingId} in this project.`],
      });
    expect(masked(missing.body, missingId)).toStrictEqual(masked(invisible.body, runId));

    const reached = await request(server).put(`/v1/runs/${runId}/access-probe`).set('Cookie', member).send({ bogus: 1 });
    expect([reached.status, reached.body.code]).toStrictEqual([400, 'INVALID_RUN_NOTE']);
  });

  /**
   * A malformed id names no run, so its 400 says nothing about which runs
   * exist — and every caller gets it, member or not. It is the one case the
   * guard leaves to the controller.
   */
  it("leaves a malformed run id to the controller's pipe, for a member and an outsider alike", async () => {
    const { outsider, member } = await arrange();
    const server = ctx.app.getHttpServer();

    for (const cookie of [outsider, member]) {
      const res = await request(server).put('/v1/runs/not-a-uuid/access-probe').set('Cookie', cookie).send({ note: 'x' });
      expect([res.status, res.body.code]).toStrictEqual([400, 'INVALID_ID']);
    }
  });
});
