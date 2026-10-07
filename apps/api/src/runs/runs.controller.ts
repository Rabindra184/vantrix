import { Body, Controller, Get, Param, Put, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { problemFromIngestError } from '../common/problem.js';
import { badRequest, parseCursor, parseLimit, singleValue, uuidParam } from '../common/validation.js';
import { IngestError, type IngestErrorCode } from '@perfportal/core';
import {
  NOTE_MAX_LENGTH,
  RunNoteRequestSchema,
  RunStatusSchema,
  RunVerdictSchema,
  type RunListResponse,
  type RunNoteResponse,
  type RunStatus,
} from '@perfportal/contracts';
import { ProjectRepository, TestRepository, type RunListItem, type RunRecord, type RunVerdictFilter } from '@perfportal/persistence';
import { Scopes } from '../auth/scopes.decorator.js';
import { checkTally } from './check-tally.js';
import { noteOf, RunsService, warmupMsOf } from './runs.service.js';
import { notFound, projectNotFound, runNotFound } from '../common/validation.js';
import { SessionOnlyGuard } from '../auth/session-only.guard.js';
import { BearerOnly, NotProjectScoped, Requires } from '../auth/access.decorator.js';
import { canSeeProject, listScope } from '../auth/access.js';

// AuthGuard is registered globally via APP_GUARD (see auth.module.ts), so
// every route authenticates by default — @UseGuards(AuthGuard) here would be
// redundant. @Scopes('read') is still required per-route.
//
// @Get() is declared before @Get(':id') for readability, not because it must
// be: Express 5's named parameter (:id) matches exactly one NON-EMPTY path
// segment, so GET /v1/runs and GET /v1/runs/:id never overlap in the first
// place — declaration order between them is behaviourally irrelevant. Proved
// by reordering them and re-running session-auth.integration.test.ts (still
// 14/14); see the Task 9 report for that run.
@Controller('/v1/runs')
export class RunsController {
  constructor(
    private readonly runs: RunsService,
    private readonly projects: ProjectRepository,
    private readonly tests: TestRepository,
  ) {}

  /**
   * Org-scoped by credential, not by URL. A bearer token carries a projectId
   * and stays restricted to it, exactly as before. A session carries none: an
   * admin's sees every run in its org and anyone else's the runs of the
   * projects they hold a role in (`listScope`), unless "project" narrows it
   * by slug to one of those.
   */
  @Get()
  @NotProjectScoped()
  @Scopes('read')
  async list(
    @Req() req: Request,
    @Query('limit') limit = '25',
    @Query('cursor') cursorParam?: unknown,
    @Query('project') projectParam?: unknown,
    @Query('test') testParam?: unknown,
    @Query('q') qParam?: unknown,
    @Query('status') statusParam?: unknown,
    @Query('verdict') verdictParam?: unknown,
    // `unknown`, like the six above: a repeated `number` arrives as an array,
    // and `parseRunNumber` refuses anything that is not one string.
    @Query('number') number?: unknown,
  ): Promise<RunListResponse> {
    // One string each, or a 400 before anything reads them: a repeated
    // parameter arrives as an array (see `singleValue`).
    const cursor = singleValue('cursor', cursorParam);
    const project = singleValue('project', projectParam);
    const test = singleValue('test', testParam);
    const q = singleValue('q', qParam);
    const status = singleValue('status', statusParam);
    const verdict = singleValue('verdict', verdictParam);
    const tenant = req.tenant!;
    let projectId = tenant.projectId;

    if (project !== undefined) {
      const named = await this.projects.findBySlugInOrg(tenant.orgId, project);
      // 404, never 403 and never an empty 200: a 403 confirms the project
      // exists, and an empty 200 describes a project that exists and happens
      // to be idle. The status code must not distinguish "no such project"
      // from "not yours".
      if (!named) throw projectNotFound(project);
      // A bearer token is minted against exactly one project. Naming another
      // is a caller mistake, not a permission question — and answering with
      // that token's own runs under someone else's slug would be a silent
      // wrong answer.
      if (tenant.projectId && tenant.projectId !== named.id) {
        throw badRequest(
          'PROJECT_MISMATCH',
          `This token belongs to a different project than "${project}".`,
          `Omit "project" to list this token's own project, or use a signed-in session that can see "${project}".`,
        );
      }
      // A session naming a project it cannot see gets the missing project's
      // 404, for the reason above: once the list is narrowed to its own
      // projects, an empty 200 here would say the slug exists. A bearer token
      // has already matched its own project on the line above, so this
      // refuses sessions only.
      if (!canSeeProject(tenant, named.id)) throw projectNotFound(project);
      projectId = named.id;
    }

    // ═══ `test` IS RESOLVED, NOT PASSED THROUGH ═══
    //
    // A test slug is unique per PROJECT, so it means nothing without one.
    // Requiring `project` alongside it is the honest contract: the alternative
    // — search the org for a test with this slug — would answer differently
    // depending on how many projects happened to use the same simulation name,
    // which is the kind of wrong answer that looks right.
    //
    // 400 rather than 404 for the missing pair, because the request is
    // malformed rather than pointing at something absent.
    let testId: string | undefined;
    if (test !== undefined) {
      if (projectId === undefined) {
        throw badRequest(
          'TEST_NEEDS_PROJECT',
          'The "test" filter needs a "project" too.',
          'A test slug is unique within its project, not across the organisation. ' +
            'Add "project=<slug>", or use a bearer token, which already names one.',
        );
      }
      const named = await this.tests.findBySlug({ orgId: tenant.orgId, projectId }, test);
      // The same 404 as an unknown project, and for the same reason: the
      // status code must not distinguish "no such test" from "not yours".
      if (named === null) throw notFound(`No test "${test}" in that project.`, 'Check the test slug, or list the tests in this project with GET /v1/projects/{slug}/tests.');
      testId = named.id;
    }

    // ═══ `number` NEEDS THE TEST THE `test` ABOVE JUST RESOLVED ═══
    //
    // A run number counts within its test — the unique index is
    // `(test_id, run_number)` — so "run 12" alone names one run in EVERY test
    // in scope, and answering it would return whichever of them the sort put
    // first: a wrong answer with a 200 on it. It is checked here, after the
    // test is resolved rather than beside the raw query parameters, because
    // "has a test" is a fact about the RESOLVED request: a bearer token
    // supplies its project and a session supplies it through `project`, and
    // either way only a `test` that resolved gets this far.
    //
    // The needs-a-test check comes first so a request with neither a test nor
    // a well-formed number is told about the missing test, the thing the
    // caller has to add; the FORMAT check is the strict one. It refuses
    // anything that is not plain decimal digits with no leading zero — which
    // also rules out a sign, a fraction, an exponent and an array — and then
    // bounds it at the largest value the int column holds, because ten digits
    // admit values up to 9,999,999,999 and int4 stops at 2,147,483,647: an
    // unbounded one would reach Postgres as "out of range for type integer"
    // and answer 500 for a caller's typo. An EMPTY `number=` is
    // refused rather than read as "any" — unlike `status=`, which a form
    // submits to mean exactly that, nothing submits this one, and a request
    // naming a run by an empty number is not asking for the whole list.
    let runNumber: number | undefined;
    if (number !== undefined) {
      if (testId === undefined) {
        throw badRequest(
          'NUMBER_NEEDS_TEST',
          'The "number" filter needs a test.',
          'A run number names a run only within its test. Add "test=<slug>", and "project=<slug>" when using a session.',
        );
      }
      runNumber = parseRunNumber(number);
    }

    const parsedCursor = parseCursor(cursor);
    const filters = parseRunListFilters({ q, status, verdict });
    // The session's own projects ride along even when "project" names one:
    // that one was checked above, so the extra clause narrows nothing, and the
    // list stays defined by the same scope whichever filters arrive.
    const page = await this.runs.runs().list(
      {
        orgId: tenant.orgId,
        projectId: projectId ? projectId : undefined,
        projectIds: listScope(tenant).projectIds,
      },
      {
        limit: parseLimit(limit),
        cursor: parsedCursor ? parsedCursor : undefined,
        testId: testId ? testId : undefined,
        runNumber,
        ...filters,
      },
    );
    return { items: page.items.map(toListItem), nextCursor: page.nextCursor };
  }

  @Get(':id')
  @Requires('project:read')
  @Scopes('read')
  async get(
    @Param('id', uuidParam('id')) id: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const tenant = req.tenant!;
    const run = await this.runs
      .runs()
      .findById({ orgId: tenant.orgId, projectId: tenant.projectId }, id);
    if (!run) throw runNotFound(id);

    await respondWithRun(this.runs, run, res);
  }

  /**
   * Write, replace or remove the note a PERSON keeps on a run (spec
   * 2026-09-27-run-note-design.md).
   *
   * SESSION-ONLY and with no @Scopes, exactly as the tests PATCH is guarded:
   * a note is a human's words, and a machine credential names nobody to
   * attribute them to. A bearer token answers 403 whatever it can read.
   *
   * Allowed in EVERY run status — a note is about the run, not about its
   * processing, and "this one is flaky" is often written while it streams.
   */
  @Put(':id/note')
  @Requires('run:note')
  @UseGuards(SessionOnlyGuard)
  async putNote(
    @Param('id', uuidParam('id')) id: string,
    @Req() req: Request,
    @Body() body: unknown,
  ): Promise<RunNoteResponse> {
    const tenant = req.tenant!;
    const parsed = RunNoteRequestSchema.safeParse(body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw badRequest(
        'INVALID_RUN_NOTE',
        `The note is not valid: ${issue?.message ?? 'unknown'}`,
        `Send {"note": "<text>"} with 1 to ${NOTE_MAX_LENGTH} characters after trimming, or ` +
          '{"note": null} to remove the note. No other field is accepted: the time and the ' +
          'author are stamped by the server.',
      );
    }
    // SessionOnlyGuard admits sessions alone, and authenticateSession sets
    // userId on every one. Refusing here rather than writing an unattributed
    // note keeps a future change to either from failing silently.
    if (tenant.userId === undefined) {
      throw new Error('A signed-in session reached the note route without a user id.');
    }
    const run = await this.runs
      .runs()
      .setNote({ orgId: tenant.orgId, projectId: tenant.projectId }, id, {
        text: parsed.data.note,
        userId: tenant.userId,
      });
    // The run surface's ONE 404, the same `runNotFound` AccessGuard answers a
    // non-member with: an admin, or a member whose run was deleted between
    // the guard's lookup and this write, gets exactly that body too.
    if (run === null) throw runNotFound(id);
    return { note: noteOf(run) };
  }
}

/**
 * Shared by RunsController.list and ProjectRunsController.list so the two
 * response shapes cannot drift — the same "same code for the same state"
 * guarantee respondWithRun makes for a single run's status mapping.
 */
function toListItem(r: RunListItem): RunListResponse['items'][number] {
  return {
    id: r.id,
    project: r.project,
    simulation: r.simulation,
    status: r.status as RunListResponse['items'][number]['status'],
    verdict: (r.verdict ?? null) as RunListResponse['items'][number]['verdict'],
    tool: r.tool,
    startedAt: r.startedAt.toISOString(),
    toolStartedAt: r.toolStartedAt ? r.toolStartedAt.toISOString() : null,
    // NAMED, never spread. `tsc`'s excess-property check applies to object
    // LITERALS and not to a spread, so a mistyped key inside one compiles in
    // silence — CLAUDE.md records a field that reached no repository at all
    // for exactly that reason.
    environment: r.environment,
    branch: r.branch,
    commitSha: r.commitSha,
    durationMs: r.durationMs,
    test: r.test,
    runNumber: r.runNumber,
    checks: checkTally(r.toolAssertions),
    metrics: r.metrics,
    // The TEXT alone: the author and time belong to the run's own page.
    note: r.note,
  };
}

/**
 * Shared by GET and POST so the two cannot drift. This function IS the
 * "same code for the same state" guarantee.
 */
export async function respondWithRun(
  runs: RunsService,
  run: RunRecord,
  res: Response,
  retryAfterSeconds = 5,
): Promise<void> {
  const status = runs.statusFor(run);

  if (status === 202) {
    // IDENTITY, NOT MEASUREMENTS. Every field here is on the RunRecord this
    // function was handed — `project` is joined (see RunRecord's own comment
    // on why the worker pays that indexed join) — except `queuedAt` and
    // `runnerJobId`, which share ONE indexed runner-job lookup (`lifecycleOf`).
    // That is the whole reason
    // this is a widened 202 rather than a full `toResponse` at every status:
    // toResponse runs runAssertion.findMany and the isWindowable EXISTS, which
    // a poller would pay for every five seconds, per watcher, per live run.
    const lifecycle = await runs.lifecycleOf(run);
    res
      .status(202)
      .set('Retry-After', String(retryAfterSeconds))
      .json({
        id: run.id,
        status: run.status,
        statusUrl: `/v1/runs/${run.id}`,
        project: run.project,
        tool: run.tool,
        toolVersion: run.toolVersion,
        environment: run.environment,
        branch: run.branch,
        commitSha: run.commitSha,
        // Null on nearly every 202 — a run has no test until the worker has
        // read its simulation class — and that is the honest answer rather
        // than an omission. It stops being null the moment the parse lands,
        // which is exactly when the reader's breadcrumb should grow a rung.
        test: run.test,
        // THE LIVE HALF of the run number: a live run is numbered at its
        // header and read through THIS body while it streams, so a number
        // sent only by toResponse would be missing exactly then.
        runNumber: run.runNumber,
        simulation: run.simulation,
        description: run.description,
        durationMs: run.durationMs,
        activityMs: run.activityMs,
        // AC-STAT-4, and it belongs HERE most of all: this is the 202 a
        // RUNNING run answers, which is exactly when a reader is watching the
        // charts stream. Omitted, the warm-up band would be absent while the
        // run was live and appear the moment it finished — one run, one fact,
        // two answers split by whether it was still going, which is the shape
        // the live SLA banner already cost this project once.
        warmupMs: warmupMsOf(run.engineOptions),
        startedAt: run.startedAt.toISOString(),
        toolStartedAt: run.toolStartedAt ? run.toolStartedAt.toISOString() : null,
        // THE LIVE HALF of the lifecycle strip: a streaming run is read
        // through THIS body, so a stamp sent only by `toResponse` would be
        // missing exactly while a reader watches the run (CLAUDE.md, warmupMs).
        parsingStartedAt: lifecycle.parsingStartedAt,
        streamUpdatedAt: lifecycle.streamUpdatedAt,
        queuedAt: lifecycle.queuedAt,
        // THE LIVE HALF of the Logs tab: a streaming runner run is read
        // through THIS body, and its events are worth most while it runs.
        runnerJobId: lifecycle.runnerJobId,
        // THE LIVE HALF of the run note, for the reason the lifecycle stamps
        // above give: a note written while a run streams is read through THIS
        // body, and one sent only by toResponse would vanish until it ended.
        note: noteOf(run),
      });
    return;
  }

  if (run.status === 'failed') {
    const err = run.error ?? {
      code: 'INTERNAL',
      message: 'The run could not be ingested.',
      remediation: 'Retry the upload.',
    };
    const body = problemFromIngestError(
      new IngestError(err.code as IngestErrorCode, {
        message: err.message,
        remediation: err.remediation,
      }),
    );
    // `status` came from runs.statusFor(run) above, which now maps a failed
    // run through the same statusForCode(...) helper problemFromIngestError
    // uses internally to set body.status — so the two are guaranteed to
    // agree by construction. Using `status` here (rather than recomputing
    // via body.status) is what makes statusFor() authoritative rather than
    // decorative.
    res.status(status).type('application/problem+json').json(body);
    return;
  }

  res.status(status).json(await runs.toResponse(run));
}

// AuthGuard is registered globally via APP_GUARD (see auth.module.ts), so
// every route authenticates by default — @UseGuards(AuthGuard) here would be
// redundant. @Scopes('read') is still required per-route.
@Controller('/v1/projects/:slug/runs')
export class ProjectRunsController {
  constructor(
    private readonly runs: RunsService,
    private readonly projects: ProjectRepository,
  ) {}

  @Get()
  @BearerOnly()
  @Scopes('read')
  async list(
    @Param('slug') slug: string,
    @Req() req: Request,
    @Query('limit') limit = '25',
    @Query('cursor') cursorParam?: unknown,
    @Query('q') qParam?: unknown,
    @Query('status') statusParam?: unknown,
    @Query('verdict') verdictParam?: unknown,
  ): Promise<RunListResponse> {
    // The same single-value rule as GET /v1/runs, for the same reason.
    const cursor = singleValue('cursor', cursorParam);
    const q = singleValue('q', qParam);
    const status = singleValue('status', statusParam);
    const verdict = singleValue('verdict', verdictParam);
    const tenant = req.tenant!;
    // A session names no project, but this route names one in its URL and
    // has no other tenancy check: RunRepository.list (below) drops the
    // project filter entirely when projectId is absent, so skipping this
    // guard would list every run in the org under a single-project URL.
    // Resolving the project by slug within the org instead was considered
    // and rejected (human-ruled) — a session-holder uses GET /v1/runs,
    // which already lists every project the session can see (all of the
    // org's for an admin) and takes ?project= to narrow to one.
    const projectId = tenant.projectId;
    if (!projectId) {
      throw badRequest(
        'PROJECT_REQUIRED',
        'This endpoint requires a project-scoped credential.',
        'Use GET /v1/runs with a session, or a project API token here.',
      );
    }

    const project = await this.projects.byId(projectId);
    // The token names the project; the slug must agree with it. A token cannot
    // read a project it does not belong to by naming a different slug.
    if (!project || project.slug !== slug) {
      throw notFound(`No project "${slug}" available to this token.`, 'Check the slug, or list the projects this credential can reach with GET /v1/projects.');
    }

    const parsedCursor = parseCursor(cursor);
    const filters = parseRunListFilters({ q, status, verdict });
    const page = await this.runs.runs().list(
      { orgId: tenant.orgId, projectId },
      {
        limit: parseLimit(limit),
        cursor: parsedCursor ? parsedCursor : undefined,
        ...filters,
      },
    );
    return { items: page.items.map(toListItem), nextCursor: page.nextCursor };
  }
}

/** The largest value `run.run_number`'s int column holds. */
const MAX_RUN_NUMBER = 2_147_483_647;

/**
 * `?number=` as a positive whole number, or a 400 that says what a run number
 * looks like. Plain decimal digits, no leading zero, at most ten of them and
 * no more than `MAX_RUN_NUMBER` — see the call site for why each bound is
 * there. `typeof` first because a repeated parameter (`number=1&number=2`)
 * arrives as an array, which the regular expression would otherwise coerce to
 * "1,2" and refuse for the right reason by accident.
 */
function parseRunNumber(value: unknown): number {
  const invalid = () =>
    badRequest(
      'INVALID_RUN_NUMBER',
      '"number" must be a positive whole number.',
      'Pass the number a run page shows, e.g. number=12 for "Run 12".',
    );
  if (typeof value !== 'string' || !/^[1-9]\d{0,9}$/.test(value)) throw invalid();
  const parsed = Number(value);
  if (parsed > MAX_RUN_NUMBER) throw invalid();
  return parsed;
}

/**
 * The three list filters, validated once for both list routes.
 *
 * VALIDATED RATHER THAN PASSED THROUGH, even though `RunRepository.list`
 * binds every one of them as a query parameter and so cannot be injected.
 * An unknown status reaching the SQL returns an empty page, which reads as
 * "there are no runs like that" — a wrong answer with a 200 on it. 400
 * `RUN_FILTER_INVALID` says which value was not understood and lists the
 * ones that are, and `RunListOptions` types the fields so the guard and the
 * repository agree in the type system rather than by habit.
 *
 * `verdict=none` IS NOT A VERDICT and never reaches `RunVerdictSchema`: it
 * selects rows whose verdict is NULL, which is a different question from
 * `not_evaluated` (evaluated, and nothing to say). The repository draws the
 * same distinction with `r.verdict IS NULL`.
 *
 * An EMPTY string is not an error — `?status=` is how a form submits "any",
 * and refusing it would make the UI special-case its own controls.
 */
function parseRunListFilters(input: {
  readonly q?: string;
  readonly status?: string;
  readonly verdict?: string;
}): { q?: string; status?: RunStatus; verdict?: RunVerdictFilter } {
  const q = input.q?.trim();
  const status = input.status?.trim();
  const verdict = input.verdict?.trim();
  const filters: { q?: string; status?: RunStatus; verdict?: RunVerdictFilter } = {};
  if (q) filters.q = q;

  if (status) {
    const parsed = RunStatusSchema.safeParse(status);
    if (!parsed.success) {
      throw badRequest(
        'RUN_FILTER_INVALID',
        `Unknown run status "${status}".`,
        'Use pending, parsing, running, complete, failed, or incomplete.',
      );
    }
    filters.status = parsed.data;
  }

  if (verdict) {
    if (verdict === 'none') {
      filters.verdict = 'none';
      return filters;
    }
    const parsed = RunVerdictSchema.safeParse(verdict);
    if (!parsed.success) {
      throw badRequest(
        'RUN_FILTER_INVALID',
        `Unknown run verdict "${verdict}".`,
        'Use passed, failed, not_evaluated, or none.',
      );
    }
    filters.verdict = parsed.data;
  }

  return filters;
}
