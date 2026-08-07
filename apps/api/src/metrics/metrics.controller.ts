import { Controller, Get, Inject, NotFoundException, Param, Query, Req } from '@nestjs/common';
import type {
  ErrorsResponse,
  SeriesResponse,
  StatsResponse,
} from '@perfportal/contracts';
import { MetricReader, RunRepository } from '@perfportal/persistence';
import type { Request } from 'express';
import pg from 'pg';
import { Scopes } from '../auth/scopes.decorator.js';

// AuthGuard is registered globally via APP_GUARD (see auth.module.ts), so
// every route authenticates by default — @UseGuards(AuthGuard) here would be
// redundant. @Scopes('read') is still required per-route.
@Controller('/v1/runs/:id')
export class MetricsController {
  constructor(
    private readonly runs: RunRepository,
    private readonly reader: MetricReader,
    // `pg.Pool` is a property-access type (a namespace member off a default
    // import), not a plain class reference. tsc's emitDecoratorMetadata can't
    // express that as a runtime value and silently degrades design:paramtypes
    // to Object here — see health.controller.ts for the full explanation. An
    // explicit @Inject sidesteps the reflection gap entirely.
    @Inject(pg.Pool) private readonly pool: pg.Pool,
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

  @Get('stats')
  @Scopes('read')
  async stats(
    @Param('id') id: string,
    @Req() req: Request,
    @Query('scope') scope?: string,
    @Query('family') family?: string,
  ): Promise<StatsResponse> {
    const run = await this.#run(req, id);
    const all = await this.reader.stats(
      { orgId: run.orgId, projectId: run.projectId },
      run.id,
    );
    const stats = all
      .filter((s) => (scope ? s.scope === scope : true))
      .filter((s) => (family ? s.family === family : true));

    return {
      runId: run.id,
      stats: stats.map((s) => ({
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
        percentiles: s.percentiles,
      })),
      indicators: await this.#indicators(run.id, run.orgId, run.projectId),
    };
  }

  /**
   * Indicator bands are persisted from the engine's exact counts (see
   * MetricWriter.persist) rather than recomputed from scalar buckets here, so
   * the global page's numbers can never disagree with the series it sits
   * above — recomputing from the response-time histogram would only be an
   * estimate of what the engine already counted precisely. `failed` used to
   * be threaded in from the caller (`run_stat.ko_count`) instead of read from
   * this table; the two happen to agree today only because the engine writes
   * both from the same loop over the same filtered events. All four bands now
   * come from this one query so that stops being a coincidence this endpoint
   * depends on.
   */
  async #indicators(
    runId: string,
    orgId: string,
    projectId: string,
  ): Promise<StatsResponse['indicators']> {
    const { rows } = await this.pool.query<{
      under: string;
      between_: string;
      over: string;
      failed: string;
    }>(
      `SELECT
         coalesce(sum(under), 0)::text    AS under,
         coalesce(sum(between_), 0)::text AS between_,
         coalesce(sum(over), 0)::text     AS over,
         coalesce(sum(failed), 0)::text   AS failed
       FROM run_indicator
       WHERE run_id = $1 AND org_id = $2 AND project_id = $3`,
      [runId, orgId, projectId],
    );
    const r = rows[0];
    return {
      under: Number(r?.under ?? 0),
      between: Number(r?.between_ ?? 0),
      over: Number(r?.over ?? 0),
      failed: Number(r?.failed ?? 0),
    };
  }

  @Get('series')
  @Scopes('read')
  async series(
    @Param('id') id: string,
    @Req() req: Request,
    @Query('scope') scope = 'run',
    @Query('name') name = '',
  ): Promise<SeriesResponse> {
    const run = await this.#run(req, id);
    const buckets = await this.reader.series(
      { orgId: run.orgId, projectId: run.projectId },
      run.id,
      run.startedOn,
      { scope, name },
    );
    return {
      runId: run.id,
      scope: scope as SeriesResponse['scope'],
      name,
      buckets,
    };
  }

  @Get('errors')
  @Scopes('read')
  async errors(@Param('id') id: string, @Req() req: Request): Promise<ErrorsResponse> {
    const run = await this.#run(req, id);
    const errors = await this.reader.errors(
      { orgId: run.orgId, projectId: run.projectId },
      run.id,
    );
    return { runId: run.id, errors };
  }
}
