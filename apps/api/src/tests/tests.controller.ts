import { Body, Controller, Get, NotFoundException, Param, Patch, Req, UseGuards } from '@nestjs/common';
import {
  TestListResponseSchema,
  TestSummarySchema,
  UpdateTestRequestSchema,
  type RunStatus,
  type RunVerdict,
  type TestListResponse,
  type TestSummary,
} from '@perfportal/contracts';
import { ProjectRepository, TestRepository, type TestRow } from '@perfportal/persistence';
import type { Request } from 'express';
import { Scopes } from '../auth/scopes.decorator.js';
import { SessionOnlyGuard } from '../auth/session-only.guard.js';
import { badRequest } from '../common/validation.js';

/**
 * The tests a project runs, and the layer between a project and its runs.
 *
 * ═══ GUARDS PER HANDLER, NOT PER CLASS ═══
 *
 * `ProjectsController`'s split, not `RulesController`'s. Reading a project's
 * tests is an ordinary read and a CI job has every reason to do it — resolving
 * "which test am I about to add a run to" is exactly the caller. So the two
 * GETs take `@Scopes('read')` and either credential.
 *
 * The PATCH is session-only. Not because renaming a test is dangerous — it is
 * a label, not a gate, and none of `RulesController`'s reasoning about a
 * credential raising its own threshold applies. It is that a name is a HUMAN's
 * choice about how their org reads, and a machine credential has no business
 * making it. A CI job that could rename a test would rename it on every run.
 *
 * ═══ THERE IS NO CREATE, AND THAT IS DELIBERATE ═══
 *
 * A test comes into existence because a run of it was parsed — the worker
 * resolves-or-creates by simulation class (see `PipelineService`). A create
 * endpoint would let a reader invent a test no run will ever match, because
 * the simulation class belongs to the tool, not to them.
 *
 * There is no delete either, in this slice. Deleting a test orphans its runs
 * (`ON DELETE SET NULL`, chosen so history survives), which is a real operation
 * that needs its own confirmation design rather than being added quietly.
 */
@Controller('/v1/projects/:slug/tests')
export class TestsController {
  constructor(
    private readonly tests: TestRepository,
    private readonly projects: ProjectRepository,
  ) {}

  @Get()
  @Scopes('read')
  async list(@Param('slug') slug: string, @Req() req: Request): Promise<TestListResponse> {
    const tenant = req.tenant!;
    const project = await this.resolveProject(tenant.orgId, slug);
    const rows = await this.tests.listForProject({ orgId: tenant.orgId, projectId: project.id });
    return TestListResponseSchema.parse({ tests: rows.map(toSummary) });
  }

  @Get(':testSlug')
  @Scopes('read')
  async get(
    @Param('slug') slug: string,
    @Param('testSlug') testSlug: string,
    @Req() req: Request,
  ): Promise<TestSummary> {
    const tenant = req.tenant!;
    const project = await this.resolveProject(tenant.orgId, slug);
    const row = await this.tests.findBySlug({ orgId: tenant.orgId, projectId: project.id }, testSlug);
    if (row === null) throw this.noSuchTest(testSlug);
    return toSummary(row);
  }

  /**
   * Rename or re-describe. What may change is narrow on purpose — see
   * `UpdateTestRequestSchema`, and in particular why `simulationClass` is not
   * in it: editing the key the worker matches on would silently split a test's
   * history in two, with nothing erroring.
   */
  @Patch(':testSlug')
  @UseGuards(SessionOnlyGuard)
  async update(
    @Param('slug') slug: string,
    @Param('testSlug') testSlug: string,
    @Req() req: Request,
    @Body() body: unknown,
  ): Promise<TestSummary> {
    const tenant = req.tenant!;
    const project = await this.resolveProject(tenant.orgId, slug);

    const parsed = UpdateTestRequestSchema.safeParse(body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw badRequest(
        'INVALID_TEST_UPDATE',
        `The update is not valid: ${issue?.message ?? 'unknown'}`,
        'Send at least one of "name" or "description". A test\'s simulation class is fixed — ' +
          'it is the key a parsed run is matched on, so changing it would split the test\'s ' +
          'history rather than rename it. Send "description": null to clear a description.',
      );
    }

    const row = await this.tests.update(
      { orgId: tenant.orgId, projectId: project.id },
      testSlug,
      parsed.data,
    );
    if (row === null) throw this.noSuchTest(testSlug);
    return toSummary(row);
  }

  /**
   * 404, NEVER 403, for a project outside the caller's org — the rule every
   * project-scoped controller here follows. A tenant learns nothing about what
   * exists elsewhere, including whether it exists.
   */
  private async resolveProject(orgId: string, slug: string): Promise<{ id: string }> {
    const project = await this.projects.findBySlugInOrg(orgId, slug);
    if (project === null) throw new NotFoundException(`No project "${slug}" in this organisation.`);
    return project;
  }

  private noSuchTest(testSlug: string): NotFoundException {
    return new NotFoundException(`No test "${testSlug}" in this project.`);
  }
}

/**
 * A stored row on the wire: instants as ISO strings, then through the schema.
 *
 * The `status`/`verdict` casts are provisional exactly as `ProjectsController`
 * documents — the repository reads them as plain strings and has no business
 * importing the contract's enums. `TestSummarySchema.parse` below is the
 * actual validation, and a stored value that fails it produces a 500 rather
 * than a 200 that violates the contract.
 */
function toSummary(row: TestRow): TestSummary {
  return TestSummarySchema.parse({
    id: row.id,
    slug: row.slug,
    name: row.name,
    simulationClass: row.simulationClass,
    description: row.description,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    runCount: row.runCount,
    latestRun:
      row.latestRun === null
        ? null
        : {
            id: row.latestRun.id,
            status: row.latestRun.status as RunStatus,
            verdict: row.latestRun.verdict as RunVerdict | null,
          },
  });
}
