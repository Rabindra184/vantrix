import { Controller, Get, NotFoundException, Param, Query, Req } from '@nestjs/common';
import type { DistributionResponse, ScatterResponse, UsersResponse } from '@perfportal/contracts';
import { MetricReader, RunRepository, type StoredBucket } from '@perfportal/persistence';
import { Histogram, distribution, inferBucketWidthMs } from '@perfportal/statistics';
import type { Request } from 'express';
import { Scopes } from '../auth/scopes.decorator.js';
import { uuidParam } from '../common/validation.js';
import { inRange, resolveRange, snapWindow } from '../common/window.js';

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
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<DistributionResponse> {
    const run = await this.#run(req, id);
    const tenant = { orgId: run.orgId, projectId: run.projectId };
    const range = await resolveRange(this.reader, run, from, to);

    // Two sources for the same shape. Unwindowed reads run_stat's whole-run
    // histograms; windowed merges the bucket histograms for the range — the
    // same pair of classes either way, so `distribution` cannot tell them
    // apart and neither can the chart.
    let h: { ok: Histogram; ko: Histogram } | null;
    let window: DistributionResponse['window'] = null;
    if (range === null) {
      h = await this.reader.histograms(tenant, run.id, { scope, name, family });
    } else {
      const rows = await this.reader.windowedBuckets(
        tenant, run.id, run.startedOn, { scope, family }, range,
      );
      window = snapWindow(rows.map((r) => r.startOffsetMs), range);
      const mine = rows.filter((r) => r.name === name);
      const ok = new Histogram();
      const ko = new Histogram();
      for (const row of mine) {
        if (row.histogramOk) ok.merge(row.histogramOk);
        if (row.histogramKo) ko.merge(row.histogramKo);
      }
      // Absent, not empty: a name with no rows in this scope never existed,
      // which is the same 404 the unwindowed path gives.
      h = mine.length === 0 ? null : { ok, ko };
    }

    if (!h) throw new NotFoundException(`No ${family} histogram for ${scope} "${name}" in run ${id}.`);
    const d = distribution(h.ok, h.ko);
    return {
      runId: run.id,
      window,
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
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<UsersResponse> {
    const run = await this.#run(req, id);
    const range = await resolveRange(this.reader, run, from, to);
    const all = await this.reader.users(
      { orgId: run.orgId, projectId: run.projectId }, run.id, run.startedOn,
    );
    const rows = all.filter((r) => inRange(r.startOffsetMs, range));

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
      // Snapped from the WHOLE series, so the reported width is the run's own
      // resolution rather than whatever gap a narrow window happens to leave.
      window: range === null ? null : snapWindow(all.map((r) => r.startOffsetMs), range),
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
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<ScatterResponse> {
    const run = await this.#run(req, id);
    const tenant = { orgId: run.orgId, projectId: run.projectId };
    const range = await resolveRange(this.reader, run, from, to);
    const [global, own] = await Promise.all([
      this.reader.series(tenant, run.id, run.startedOn, { scope: 'run', name: '', family: 'response_time' }),
      this.reader.series(tenant, run.id, run.startedOn, { scope: 'request', name, family: 'response_time' }),
    ]);

    // x is a RATE over the global REQUESTS series (started_count, both
    // statuses), matching Gatling's getRequestsPerSecBuffer(None, None).
    // Not responses - that is a different chart.
    //
    // The global (run-scope) and own (request-scope) series each coalesce
    // INDEPENDENTLY: BucketSeries (packages/statistics/src/buckets.ts) halves
    // its own resolution once ITS OWN occupied-bucket count exceeds ITS OWN
    // cap - maxBucketsRun defaults to 1200, maxBucketsEndpoint to 300
    // (packages/statistics/src/engine.ts) - so for any run long enough to make
    // either series coalesce, their widths can diverge. Inferring one width
    // and using it to look up the OTHER series by offset - as this used to -
    // is wrong twice over: it silently misreads the rate's window size, and
    // whenever an own offset does not land exactly on a global bucket
    // boundary the lookup finds nothing, silently dropping that point (e.g.
    // half the points on a long run with a short-lived endpoint). So: infer
    // width from the OWN series being iterated below, and for each own bucket
    // sum the global series' startedCount over the window
    // [ownOffset, ownOffset + ownWidthMs) before converting to a rate -
    // rather than a point lookup keyed by a shared-width assumption.
    const ownWidthMs = inferBucketWidthMs(own.map((b) => b.startOffsetMs));
    // global is already ORDER BY start_offset_ms (SERIES_SQL), so a single
    // forward-advancing pointer suffices: own buckets are visited in
    // increasing-offset order too, and their windows never overlap or go
    // backwards, so no global bucket needs revisiting once passed.
    let gIdx = 0;
    const rateForOwnBucket = (ownOffsetMs: number): number | undefined => {
      if (global.length === 0) return undefined; // degenerate: no global series at all
      while (gIdx < global.length && (global[gIdx] as StoredBucket).startOffsetMs < ownOffsetMs) gIdx++;
      let sum = 0;
      let i = gIdx;
      while (i < global.length) {
        const gb = global[i] as StoredBucket;
        if (gb.startOffsetMs >= ownOffsetMs + ownWidthMs) break;
        sum += gb.startedCount;
        i++;
      }
      return Math.round((sum / ownWidthMs) * 1000);
    };

    // y is quantile(0.95).toInt - TRUNCATED, not rounded.
    // Gatling emits a point per status-filtered digest that exists in a bucket,
    // so a bucket with both successes and failures yields TWO points - one on
    // each series. Routing a mixed bucket to a single series drops the KO point
    // entirely and contaminates the OK one.
    //
    // The gate is presence of the status-filtered digest (percentiles.p95 !==
    // undefined), not okCount/koCount. Those counters are fed on the request's
    // END edge (buckets.ts), while the sketches - and this p95 - are fed on the
    // START edge, so they can disagree about which bucket a straddling request
    // belongs to. Gatling's own gate
    // (LogFileData.timeAgainstGlobalNumberOfRequestsPerSec) is "does a digest
    // exist for this bucket", not a response count - matching that means
    // reading it off the same start-edge sketch the value comes from.
    const ok: [number, number][] = [];
    const ko: [number, number][] = [];
    for (const b of own) {
      // Filtered on the OWN bucket's offset, which is the point each drawn
      // marker sits at. `rateForOwnBucket` still reads the whole global series
      // — the x is a rate at that instant, and clipping the global series
      // would leave the boundary markers without one.
      if (!inRange(b.startOffsetMs, range)) continue;
      const x = rateForOwnBucket(b.startOffsetMs);
      if (x === undefined) continue;
      const pOk = b.percentilesOk.p95;
      const pKo = b.percentilesKo.p95;
      if (pOk !== undefined) ok.push([x, Math.trunc(pOk)]);
      if (pKo !== undefined) ko.push([x, Math.trunc(pKo)]);
    }
    ok.sort((a, b) => a[0] - b[0]);
    ko.sort((a, b) => a[0] - b[0]);
    return {
      runId: run.id,
      name,
      window: range === null ? null : snapWindow(own.map((b) => b.startOffsetMs), range),
      ok,
      ko,
    };
  }
}
