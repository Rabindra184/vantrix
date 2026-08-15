import { Controller, Get, NotFoundException, Param, Query, Req } from '@nestjs/common';
import type {
  ErrorsResponse,
  SeriesResponse,
  StatsResponse,
  TrendsResponse,
} from '@perfportal/contracts';
import { parseProjectSettings } from '@perfportal/contracts';
import { MetricReader, ProjectRepository, RunRepository } from '@perfportal/persistence';
import { bandsFrom, inferBucketWidthMs } from '@perfportal/statistics';
import type { Request } from 'express';
import { Scopes } from '../auth/scopes.decorator.js';
import { badRequest, parseLimit, uuidParam } from '../common/validation.js';

// AuthGuard is registered globally via APP_GUARD (see auth.module.ts), so
// every route authenticates by default — @UseGuards(AuthGuard) here would be
// redundant. @Scopes('read') is still required per-route.
@Controller('/v1/runs/:id')
export class MetricsController {
  constructor(
    private readonly runs: RunRepository,
    private readonly reader: MetricReader,
    private readonly projects: ProjectRepository,
  ) {}

  /**
   * Resolves the run first, for two reasons: it enforces tenancy, and it
   * supplies run.startedOn — the partition key. A series query filtering only
   * on run_id cannot prune and would scan every partition.
   */
  async #run(req: Request, id: string) {
    const tenant = req.tenant!;
    const run = await this.runs.findById(
      { orgId: tenant.orgId, projectId: tenant.projectId },
      id,
    );
    if (!run) throw new NotFoundException(`No run ${id} in this project.`);
    return run;
  }

  /**
   * A run in the context of its cohort — every complete run of the same
   * simulation in the same project.
   *
   * RUN-SCOPED RATHER THAN PROJECT-SCOPED (`/v1/projects/:slug/trends`),
   * because it needs no slug resolution and no new authorization reasoning:
   * `#run` already resolves and tenant-checks exactly as every sibling route
   * here does, so "another org's run is 404, not 403" is inherited rather than
   * re-argued. It also matches how a reader arrives — from a run, wanting that
   * run in context.
   *
   * `#run`'s other job, supplying the partition key, is not needed here:
   * `run_stat` is not partitioned. The run is still resolved first because the
   * COHORT KEY comes off it — the caller names a run, not a simulation, and
   * the server is what decides which cohort that run belongs to. A client
   * passing its own `?simulation=` would be able to read a cohort by guessing
   * a name.
   */
  @Get('trends')
  @Scopes('read')
  async trends(
    @Param('id', uuidParam('id')) id: string,
    @Req() req: Request,
    @Query('limit') limit = '20',
  ): Promise<TrendsResponse> {
    const run = await this.#run(req, id);

    /**
     * PERCENTILES ARE RECOMPUTED FROM EACH RUN'S SKETCH, at the project's
     * currently configured set — exactly as `/stats` does, and for the same
     * reason (spec §9.1, K-03): the sketch is persisted so that reconfiguring
     * the percentile set needs no re-ingest.
     *
     * Reading the frozen `percentiles` column here instead would put the
     * statistics table and the trend on DIFFERENT SETS the moment a project
     * reconfigured, silently — both would look like plausible numbers. It also
     * disagrees in the last decimal places even when the sets match, which is
     * what an integration test comparing the two endpoints caught.
     *
     * Unlike `/stats`, this does not need `indicators`, so a settings document
     * whose bounds are invalid is not this endpoint's problem — only
     * `percentiles` is read, and `parseProjectSettings` supplies a default set
     * when the document omits it.
     */
    const settings = parseProjectSettings(
      await this.projects.settings({ orgId: run.orgId, projectId: run.projectId }),
    );

    const { runs, cohortSize } = await this.reader.trends(
      { orgId: run.orgId, projectId: run.projectId },
      { simulation: run.simulation ?? null },
      // The same clamp the run list uses, imported rather than restated: two
      // answers to "how many is too many" is one too many.
      parseLimit(limit),
    );

    return {
      runId: run.id,
      simulation: run.simulation ?? null,
      cohortSize,
      runs: runs.map((r) => ({
        id: r.id,
        startedAt: r.startedAt.toISOString(),
        toolStartedAt: r.toolStartedAt?.toISOString() ?? null,
        durationMs: r.durationMs,
        verdict: (r.verdict ?? null) as TrendsResponse['runs'][number]['verdict'],
        count: r.count,
        okCount: r.okCount,
        koCount: r.koCount,
        errorRate: r.errorRate,
        minMs: r.minMs,
        maxMs: r.maxMs,
        meanMs: r.meanMs,
        throughputRps: r.throughputRps,
        // The same expression `/stats` uses, including the `count > 0` guard:
        // an empty stat has a sketch with nothing to quantile, and its frozen
        // column is the only answer available.
        percentiles:
          r.sketch && r.count > 0
            ? Object.fromEntries(
                settings.percentiles.map((p) => [`p${p}`, r.sketch!.quantile(p / 100)]),
              )
            : r.percentiles,
      })),
    };
  }

  @Get('stats')
  @Scopes('read')
  async stats(
    @Param('id', uuidParam('id')) id: string,
    @Req() req: Request,
    @Query('scope') scope?: string,
    @Query('name') name?: string,
    @Query('family') family?: string,
  ): Promise<StatsResponse> {
    const run = await this.#run(req, id);

    // parseProjectSettings throws (a ZodError) on stored settings that are
    // structurally invalid, most notably inverted indicator bounds. There is
    // no write-side validation yet (Task 12 is the first real reader of this
    // column), so a misconfigured project is reachable in practice, not just
    // in theory. That is a project-configuration problem, not a server bug —
    // it must come back as an actionable 4xx naming the setting to fix, not
    // an internal-error 500.
    let settings;
    try {
      settings = parseProjectSettings(await this.projects.settings({
        orgId: run.orgId,
        projectId: run.projectId,
      }));
    } catch (err) {
      throw badRequest(
        'PROJECT_SETTINGS_INVALID',
        `This project's settings are invalid, so indicator bands cannot be computed: ${message(err)}`,
        'Ask a project admin to fix the "indicators" setting (lowerMs must be below higherMs) and retry.',
      );
    }

    const all = await this.reader.stats({ orgId: run.orgId, projectId: run.projectId }, run.id);
    const rows = all
      .filter((s) => (scope ? s.scope === scope : true))
      .filter((s) => (name !== undefined ? s.name === name : true))
      .filter((s) => (family ? s.family === family : true));

    // A run ingested before the parity migration has no histogram. Its bands
    // cannot respond to a bounds change, and saying so is better than serving
    // frozen numbers that look live.
    const configurable = rows.every((s) => s.histogramOk !== null);

    // bandsFrom throws when higherMs sits above the histogram's 120s overflow
    // cap while overflow observations exist — the exact count is genuinely
    // unrecoverable there. Bounds are already validated non-inverted by
    // parseProjectSettings above, so the only throw reachable from here is
    // that overflow-cap case. It is still a project-configuration problem
    // (an unreasonably high "indicators.higherMs"), not a server bug.
    let stats: StatsResponse['stats'];
    try {
      stats = rows.map((s) => ({
        scope: s.scope as StatsResponse['stats'][number]['scope'],
        name: s.name,
        family: s.family as StatsResponse['stats'][number]['family'],
        count: s.count,
        okCount: s.okCount,
        koCount: s.koCount,
        errorRate: s.errorRate,
        minMs: s.minMs,
        maxMs: s.maxMs,
        meanMs: s.meanMs,
        stddevMs: s.stddevMs,
        throughputRps: s.throughputRps,
        // Recomputed from the persisted sketch at the project's currently
        // configured percentile set (spec §9.1, K-03) — the whole reason the
        // sketch is stored is so this needs no re-ingest, exactly like
        // indicators below. Falls back to the frozen `percentiles` column
        // for rows written before the sketch was persisted, or for an
        // empty stat where the sketch has nothing to quantile.
        percentiles:
          s.sketch && s.count > 0
            ? Object.fromEntries(
                settings.percentiles.map((p) => [`p${p}`, s.sketch!.quantile(p / 100)]),
              )
            : s.percentiles,
        indicators: s.histogramOk
          ? bandsFrom(s.histogramOk, s.koCount, settings.indicators)
          : { under: 0, between: 0, over: 0, failed: s.koCount },
      }));
    } catch (err) {
      throw badRequest(
        'PROJECT_SETTINGS_INVALID',
        `The project's "indicators.higherMs" (${settings.indicators.higherMs}) cannot be applied to this run: ${message(err)}`,
        'Lower the project\'s "indicators.higherMs" setting to at most 120000 (the histogram overflow cap) and retry.',
      );
    }

    const runRow = stats.find((s) => s.scope === 'run' && s.family === 'response_time');
    return {
      runId: run.id,
      stats,
      indicators: runRow?.indicators ?? { under: 0, between: 0, over: 0, failed: 0 },
      configurable,
      bounds: settings.indicators,
    };
  }

  @Get('series')
  @Scopes('read')
  async series(
    @Param('id', uuidParam('id')) id: string,
    @Req() req: Request,
    @Query('scope') scope = 'run',
    @Query('name') name = '',
    @Query('family') family = 'response_time',
  ): Promise<SeriesResponse> {
    const run = await this.#run(req, id);
    const buckets = await this.reader.series(
      { orgId: run.orgId, projectId: run.projectId },
      run.id,
      run.startedOn,
      { scope, name, family },
    );
    return {
      runId: run.id,
      scope: scope as SeriesResponse['scope'],
      name,
      family: family as SeriesResponse['family'],
      bucketWidthMs: inferBucketWidthMs(buckets.map((b) => b.startOffsetMs)),
      // Derived from the rows themselves, not from a run-level flag: the
      // columns are nullable and only rows written after the migration carry
      // the split. `every` over an empty array is vacuously true, hence the
      // length guard — no buckets is "nothing to draw", not "split available".
      // Both columns, not one. They are always written together today, but the
      // schema permits them to diverge, and a partial backfill is exactly the
      // case where they would — a flag derived from ok alone would report
      // `true` while the KO series plotted nulls.
      startedSplitAvailable:
        buckets.length > 0 &&
        buckets.every((b) => b.startedOkCount !== null && b.startedKoCount !== null),
      // Only asked when it can matter. A run-scope or request-scope caller does
      // not need it, and the extra query is not worth issuing for them.
      groupSeriesAvailable:
        scope === 'group'
          ? await this.reader.hasGroupSeries(
              { orgId: run.orgId, projectId: run.projectId }, run.id, run.startedOn,
            )
          : false,
      buckets,
    };
  }

  @Get('errors')
  @Scopes('read')
  async errors(
    @Param('id', uuidParam('id')) id: string,
    @Req() req: Request,
    @Query('scope') scope?: string,
    @Query('name') name?: string,
  ): Promise<ErrorsResponse> {
    const run = await this.#run(req, id);
    // Omitting ?scope means run scope, NOT "every scope": the engine writes a
    // row per (scope, name), so an unscoped read would return each failure
    // twice and double every count.
    const sel = { scope: scope ?? 'run', name: scope === undefined ? '' : (name ?? '') };
    const errors = await this.reader.errors(
      { orgId: run.orgId, projectId: run.projectId },
      run.id,
      sel,
    );
    return { runId: run.id, errors };
  }
}

/** Best-effort human-readable detail for an unexpected caught error. */
function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
