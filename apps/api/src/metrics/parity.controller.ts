import { Controller, Get, NotFoundException, Param, Query, Req } from '@nestjs/common';
import type { DistributionResponse, ScatterResponse, UsersResponse } from '@perfportal/contracts';
import { MetricReader, RunRepository } from '@perfportal/persistence';
import { distribution, inferBucketWidthMs } from '@perfportal/statistics';
import type { Request } from 'express';
import { Scopes } from '../auth/scopes.decorator.js';
import { uuidParam } from '../common/validation.js';

@Controller('/v1/runs/:id')
export class ParityController {
  constructor(
    private readonly runs: RunRepository,
    private readonly reader: MetricReader,
  ) {}

  async #run(req: Request, id: string) {
    const tenant = req.tenant!;
    const run = await this.runs.findById({ orgId: tenant.orgId, projectId: tenant.projectId }, id);
    if (!run) throw new NotFoundException(`No run ${id} in this project.`);
    return run;
  }

  @Get('distribution')
  @Scopes('read')
  async distribution(
    @Param('id', uuidParam('id')) id: string,
    @Req() req: Request,
    @Query('scope') scope = 'run',
    @Query('name') name = '',
    @Query('family') family = 'response_time',
  ): Promise<DistributionResponse> {
    const run = await this.#run(req, id);
    const h = await this.reader.histograms(
      { orgId: run.orgId, projectId: run.projectId }, run.id, { scope, name, family },
    );
    if (!h) throw new NotFoundException(`No ${family} histogram for ${scope} "${name}" in run ${id}.`);
    const d = distribution(h.ok, h.ko);
    return {
      runId: run.id,
      scope: scope as DistributionResponse['scope'],
      name,
      family: family as DistributionResponse['family'],
      labels: d.labels,
      okCount: d.okCount,
      koCount: d.koCount,
      okPercent: d.okPercent,
      koPercent: d.koPercent,
      exactValues: d.exactValues,
      overflowCount: d.overflowCount,
    };
  }

  @Get('users')
  @Scopes('read')
  async users(
    @Param('id', uuidParam('id')) id: string,
    @Req() req: Request,
  ): Promise<UsersResponse> {
    const run = await this.#run(req, id);
    const rows = await this.reader.users(
      { orgId: run.orgId, projectId: run.projectId }, run.id, run.startedOn,
    );

    const byScenario = new Map<string, UsersResponse['scenarios'][number]['buckets']>();
    const total = new Map<number, { startOffsetMs: number; started: number; ended: number; maxConcurrent: number }>();
    for (const r of rows) {
      let list = byScenario.get(r.scenario);
      if (!list) { list = []; byScenario.set(r.scenario, list); }
      list.push({
        startOffsetMs: r.startOffsetMs, started: r.started,
        ended: r.ended, maxConcurrent: r.maxConcurrent,
      });
      // Gatling's own 'All users' series is the per-scenario SUM in both
      // charts - verified across all 63 fixture buckets. Summing maxima is
      // normally wrong (max(a+b) != max(a)+max(b)); here it is what parity
      // requires. Do not "fix" this to a true max-of-sums.
      const t = total.get(r.startOffsetMs) ?? {
        startOffsetMs: r.startOffsetMs, started: 0, ended: 0, maxConcurrent: 0,
      };
      t.started += r.started;
      t.ended += r.ended;
      t.maxConcurrent += r.maxConcurrent;
      total.set(r.startOffsetMs, t);
    }

    return {
      runId: run.id,
      scenarios: [...byScenario].map(([scenario, buckets]) => ({ scenario, buckets }))
        .sort((a, b) => a.scenario.localeCompare(b.scenario)),
      total: [...total.values()].sort((a, b) => a.startOffsetMs - b.startOffsetMs),
    };
  }

  @Get('scatter')
  @Scopes('read')
  async scatter(
    @Param('id', uuidParam('id')) id: string,
    @Req() req: Request,
    @Query('name') name = '',
  ): Promise<ScatterResponse> {
    const run = await this.#run(req, id);
    const tenant = { orgId: run.orgId, projectId: run.projectId };
    const [global, own] = await Promise.all([
      this.reader.series(tenant, run.id, run.startedOn, { scope: 'run', name: '' }),
      this.reader.series(tenant, run.id, run.startedOn, { scope: 'request', name }),
    ]);

    // x is a RATE over the global REQUESTS series (started_count, both
    // statuses), matching Gatling's getRequestsPerSecBuffer(None, None).
    // Not responses - that is a different chart.
    const widthMs = inferBucketWidthMs(global.map((b) => b.startOffsetMs));
    const rateAt = new Map<number, number>();
    for (const b of global) {
      rateAt.set(b.startOffsetMs, Math.round((b.startedCount / widthMs) * 1000));
    }

    // y is quantile(0.95).toInt - TRUNCATED, not rounded.
    // Gatling emits a point per status-filtered digest that exists in a bucket,
    // so a bucket with both successes and failures yields TWO points - one on
    // each series. Routing a mixed bucket to a single series drops the KO point
    // entirely and contaminates the OK one.
    const ok: [number, number][] = [];
    const ko: [number, number][] = [];
    for (const b of own) {
      const x = rateAt.get(b.startOffsetMs);
      if (x === undefined) continue;
      const pOk = b.percentilesOk.p95;
      const pKo = b.percentilesKo.p95;
      if (b.okCount > 0 && pOk !== undefined) ok.push([x, Math.trunc(pOk)]);
      if (b.koCount > 0 && pKo !== undefined) ko.push([x, Math.trunc(pKo)]);
    }
    ok.sort((a, b) => a[0] - b[0]);
    ko.sort((a, b) => a[0] - b[0]);
    return { runId: run.id, name, ok, ko };
  }
}
