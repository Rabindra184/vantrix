import { Controller, Get, Query, Req } from '@nestjs/common';
import {
  OrgTestListResponseSchema,
  type OrgTestListResponse,
  type OrgTestSummary,
  type RunStatus,
  type RunVerdict,
} from '@perfportal/contracts';
import { TestRepository, type OrgTestRow } from '@perfportal/persistence';
import type { Request } from 'express';
import { Scopes } from '../auth/scopes.decorator.js';
import { parseLimit, singleValue } from '../common/validation.js';
import { checkTally } from '../runs/check-tally.js';
import { NotProjectScoped } from '../auth/access.decorator.js';

/**
 * Every test the caller may see, in one list: the portfolio home page's table
 * and the command palette's "Tests" group are both this response, so neither
 * has to ask per project, and neither per test for its newest run.
 *
 * ═══ SCOPED BY CREDENTIAL, NOT BY URL — `GET /v1/runs`'s RULE ═══
 *
 * A session is org-scoped on purpose (`Tenant.projectId` is absent for one) and
 * sees every test in its organisation. A bearer token is minted against ONE
 * project and sees that project's tests alone, exactly as it sees only that
 * project's runs. The scope below is that one rule, and nothing here names a
 * project by slug — which is why this route needs none of
 * `TestsController.resolveProject`'s cross-project refusal: there is no slug to
 * point at another project with.
 *
 * ═══ ITS OWN CONTROLLER, NOT ANOTHER GET ON `TestsController` ═══
 *
 * That class is mounted at `/v1/projects/:slug/tests`, and the decorator
 * metadata the route-coverage guard reads is per class: a second prefix is a
 * second `@Controller`. The two also differ in what they list — a project's
 * tests with their descriptions, against the org's with their project, newest
 * run and p95 history — so sharing a class would share nothing but a name.
 *
 * ═══ THE CURSOR IS OPAQUE, AND `parseCursor` IS DELIBERATELY NOT USED ═══
 *
 * `parseCursor` answers 400 `INVALID_CURSOR` for anything that is not a UUID,
 * which is right for the run lists whose cursor IS an item id. This list's
 * `nextCursor` is a base64url position (see `test-cursor.ts`), so that guard
 * would refuse every real one. `TestRepository.listOrg` decodes it and answers
 * an empty page for anything it did not mint, so the raw string goes straight
 * through.
 */
@Controller('/v1/tests')
export class OrgTestsController {
  constructor(private readonly tests: TestRepository) {}

  @Get()
  @NotProjectScoped()
  @Scopes('read')
  async list(
    @Req() req: Request,
    @Query('q') q?: unknown,
    @Query('limit') limit = '25',
    @Query('cursor') cursor?: unknown,
  ): Promise<OrgTestListResponse> {
    const tenant = req.tenant!;
    const page = await this.tests.listOrg(
      { orgId: tenant.orgId, projectId: tenant.projectId },
      {
        limit: parseLimit(limit),
        // An empty cursor is how a form says "the first page" and is not one.
        cursor: singleValue('cursor', cursor) || undefined,
        // TRIMMED HERE, because the repository only asks whether `q` is truthy:
        // a blank box submitted as "  " would otherwise become `%  %`, match
        // nothing, and make "no filter" answer an empty list.
        q: singleValue('q', q)?.trim() || undefined,
      },
    );
    return OrgTestListResponseSchema.parse({
      items: page.items.map(toSummary),
      nextCursor: page.nextCursor,
    });
  }
}

/**
 * A stored row on the wire: the instant as an ISO string, the assertions as a
 * tally, then through the schema.
 *
 * `toISOString()` and not the driver's own serialisation because the contract's
 * `startedAt` is `z.string().datetime()`, which accepts a Z-suffixed instant
 * only. The `status`/`verdict` casts are provisional exactly as
 * `TestsController` documents: the repository reads them as plain strings and
 * has no business importing the contract's enums, and the parse above is the
 * actual validation.
 *
 * Every field is NAMED, never spread: `tsc`'s excess-property check applies to
 * an object literal and not to a spread, so a mistyped key inside one would
 * compile and send nothing.
 */
function toSummary(row: OrgTestRow): OrgTestSummary {
  const run = row.latestRun;
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    simulationClass: row.simulationClass,
    runCount: row.runCount,
    project: { slug: row.project.slug, name: row.project.name },
    latestRun:
      run === null
        ? null
        : {
            id: run.id,
            runNumber: run.runNumber,
            status: run.status as RunStatus,
            verdict: run.verdict as RunVerdict | null,
            startedAt: run.startedAt.toISOString(),
            durationMs: run.durationMs,
            checks: checkTally(run.toolAssertions),
            p95Ms: run.p95Ms,
          },
    p95History: row.p95History.map((point) => ({
      runId: point.runId,
      runNumber: point.runNumber,
      p95Ms: point.p95Ms,
    })),
  };
}
