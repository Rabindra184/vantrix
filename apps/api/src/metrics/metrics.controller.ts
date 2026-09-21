import { Controller, Get, NotFoundException, Param, Query, Req } from '@nestjs/common';
import type {
  ErrorSeriesResponse,
  ErrorsResponse,
  SeriesResponse,
  StatsResponse,
  TelemetryResponse,
  TrendsResponse,
} from '@perfportal/contracts';
import { parseProjectSettings } from '@perfportal/contracts';
import {
  MetricReader,
  ProjectRepository,
  RunRepository,
  TelemetryStore,
  TELEMETRY_LOOKBACK_MS,
} from '@perfportal/persistence';
import {
  Histogram,
  type IndicatorBands,
  bandsFrom,
  clampPercentile,
  inferBucketWidthMs,
  rollupFromHistograms,
  toTelemetrySeries,
} from '@perfportal/statistics';
import type { Request } from 'express';
import { Scopes } from '../auth/scopes.decorator.js';
import { badRequest, parseLimit, uuidParam } from '../common/validation.js';
import { inRange, resolveRange, snapWindow } from '../common/window.js';

// AuthGuard is registered globally via APP_GUARD (see auth.module.ts), so
// every route authenticates by default — @UseGuards(AuthGuard) here would be
// redundant. @Scopes('read') is still required per-route.
@Controller('/v1/runs/:id')
export class MetricsController {
  constructor(
    private readonly runs: RunRepository,
    private readonly reader: MetricReader,
    private readonly projects: ProjectRepository,
    // Named `telemetrySamples`, not `telemetry_` — a trailing underscore is a
    // workaround dressed as a name for dodging the collision with the
    // `telemetry()` handler method below, and this project's convention
    // (`runs`/`reader`/`projects` above) is to name the field for what it
    // holds instead.
    private readonly telemetrySamples: TelemetryStore,
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
     * THE PARSE IS GUARDED even though this endpoint only reads
     * `percentiles`. `parseProjectSettings` validates the WHOLE document, so a
     * project with inverted `indicators` bounds — which `/stats` proves is
     * reachable, since it has its own guard for exactly this — would throw a
     * ZodError here and turn a misconfigured setting into a 500 on a page that
     * never looks at indicators.
     *
     * It answers 400 rather than degrading to a default percentile set: a
     * silent fallback would put this trend on a DIFFERENT set from the
     * statistics table, which is the divergence the sketch recomputation above
     * exists to prevent. `/stats` fails the same way for the same project, so
     * the two stay consistent, and the message names the setting to fix.
     */
    let settings;
    try {
      settings = parseProjectSettings(
        await this.projects.settings({ orgId: run.orgId, projectId: run.projectId }),
      );
    } catch (err) {
      throw badRequest(
        'PROJECT_SETTINGS_INVALID',
        `This project's settings are invalid, so trend percentiles cannot be computed: ${message(err)}`,
        'Ask a project admin to fix the "indicators" setting (lowerMs must be below higherMs) and retry.',
      );
    }

    const { runs, cohortSize } = await this.reader.trends(
      { orgId: run.orgId, projectId: run.projectId },
      // The cohort is the TEST now, not the simulation string. For every run
      // the migration backfilled these select identically — a test IS
      // (project, simulation class) — so a reader's existing trend does not
      // move under them.
      { testId: run.test?.id ?? null },
      // THE REQUESTED RUN, passed so the query can add it back when it falls
      // outside the newest `limit`. Without it a run older than the window is
      // absent from its own trend — see TRENDS_SQL.
      run.id,
      // The same clamp the run list uses, imported rather than restated: two
      // answers to "how many is too many" is one too many.
      parseLimit(limit),
    );

    return {
      runId: run.id,
      simulation: run.simulation ?? null,
      test: run.test ?? null,
      cohortSize,
      runs: runs.map((r) => ({
        id: r.id,
        startedAt: r.startedAt.toISOString(),
        toolStartedAt: r.toolStartedAt?.toISOString() ?? null,
        durationMs: r.durationMs,
        verdict: (r.verdict ?? null) as TrendsResponse['runs'][number]['verdict'],
        // NAMED, not spread. A conditional spread is a hole in type checking —
        // `tsc` applies its excess-property check to object LITERALS and a
        // spread is not one, so a mistyped key inside `...(x ? { … } : {})`
        // compiles in silence. CLAUDE.md records a field that reached no
        // repository for exactly that reason.
        environment: r.environment,
        branch: r.branch,
        commitSha: r.commitSha,
        tool: r.tool,
        simulation: r.simulation,
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
        // CLAMPED against the row's own exact `minMs`/`maxMs`, which is what this
        // response reports beside these values. The sketch is DESERIALIZED here, so
        // its own extremes are bucket-approximate and would clamp to the very
        // over-estimate this is correcting — see `clampPercentile`.
        percentiles:
          r.sketch && r.count > 0
            ? Object.fromEntries(
                settings.percentiles.map((p) => [`p${p}`, clampPercentile(r.sketch!.quantile(p / 100), r)]),
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
    @Query('from') from?: string,
    @Query('to') to?: string,
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

    const range = await resolveRange(this.reader, run, from, to);
    const tenant = { orgId: run.orgId, projectId: run.projectId };
    if (range !== null) {
      return this.#windowedStats(run, tenant, range, settings, scope, name, family);
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

    // `bandsOrRefuse` converts the overflow-cap refusal into a 400 naming the
    // setting. It is shared with `#windowedStats`, which is the whole point:
    // this guard used to live here as a try/catch and the windowed path
    // answered 500 for the identical run and configuration.
    const stats: StatsResponse['stats'] = rows.map((s) => ({
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
      // CLAMPED against the row's own exact `minMs`/`maxMs`, which is what this
      // response reports beside these values. The sketch is DESERIALIZED here, so
      // its own extremes are bucket-approximate and would clamp to the very
      // over-estimate this is correcting — see `clampPercentile`.
      percentiles:
        s.sketch && s.count > 0
          ? Object.fromEntries(
              settings.percentiles.map((p) => [`p${p}`, clampPercentile(s.sketch!.quantile(p / 100), s)]),
            )
          : s.percentiles,
      indicators: s.histogramOk
        ? bandsOrRefuse(s.histogramOk, s.koCount, settings.indicators)
        : { under: 0, between: 0, over: 0, failed: s.koCount },
    }));

    const runRow = stats.find((s) => s.scope === 'run' && s.family === 'response_time');
    return {
      runId: run.id,
      stats,
      indicators: runRow?.indicators ?? { under: 0, between: 0, over: 0, failed: 0 },
      configurable,
      bounds: settings.indicators,
      window: null,
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
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<SeriesResponse> {
    const run = await this.#run(req, id);
    const range = await resolveRange(this.reader, run, from, to);
    const all = await this.reader.series(
      { orgId: run.orgId, projectId: run.projectId },
      run.id,
      run.startedOn,
      { scope, name, family },
    );
    // Filtered here rather than in SQL: the width has to be inferred from the
    // WHOLE series, or a narrow window over a coalesced run would infer its
    // own gap as the bucket width and scale every rate wrongly.
    const bucketWidthMs = inferBucketWidthMs(all.map((b) => b.startOffsetMs));
    const buckets = all.filter((b) => inRange(b.startOffsetMs, range));
    return {
      runId: run.id,
      scope: scope as SeriesResponse['scope'],
      name,
      family: family as SeriesResponse['family'],
      bucketWidthMs,
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
      window: range === null ? null : snapWindow(all.map((b) => b.startOffsetMs), range),
      buckets,
    };
  }



  /**
   * The statistics table re-aggregated over a time window.
   *
   * Every column comes from the merged histograms — see `rollupFromHistograms`
   * for why mixing them with the stored end-edge counts would describe two
   * different sets of requests in one row.
   */
  async #windowedStats(
    run: { id: string; orgId: string; projectId: string; startedOn: Date },
    tenant: { orgId: string; projectId: string },
    range: { fromMs: number; toMs: number },
    settings: { percentiles: number[]; indicators: { lowerMs: number; higherMs: number } },
    scope: string | undefined,
    name: string | undefined,
    family: string | undefined,
  ): Promise<StatsResponse> {
    /**
     * ═══ `scope` IS A FILTER HERE TOO, NOT A DEFAULT ═══
     *
     * This used to read `scope ?? 'run'` while the UNWINDOWED branch above
     * treats the same parameter as a filter (`scope ? s.scope === scope :
     * true`). One query parameter, one endpoint, two meanings — so applying
     * a time window silently dropped every per-request and per-group row and
     * collapsed the statistics table to the run's own totals, at precisely
     * the moment a reader brushes a spike to find out WHICH request it
     * belongs to.
     *
     * Passing the filters through as NULL lets one pass serve the whole
     * table, so this costs a wider result set rather than another query.
     * Deriving the (scope, family) pairs from `run_stat` instead was the
     * first attempt and is WRONG: the buckets are the source of truth for a
     * windowed read, and a run can carry buckets with no matching stats row
     * — `window-bench.integration.test.ts` seeds exactly that and returned
     * zero rows, which is how the mistake was caught.
     */
    const rows = await this.reader.windowedBuckets(
      tenant,
      run.id,
      run.startedOn,
      { scope: scope ?? null, family: family ?? null },
      range,
    );

    const window = snapWindow(rows.map((r) => r.startOffsetMs), range);

    const byKey = new Map<
      string,
      { scope: string; family: string; name: string; ok: Histogram; ko: Histogram }
    >();
    for (const row of rows) {
      // NUL joins the key because it cannot occur in a name — the same
      // reason `tool-assertions.ts` separates its scope prefix with one.
      const key = `${row.scope}\0${row.family}\0${row.name}`;
      let entry = byKey.get(key);
      if (!entry) {
        entry = {
          scope: row.scope,
          family: row.family,
          name: row.name,
          ok: new Histogram(),
          ko: new Histogram(),
        };
        byKey.set(key, entry);
      }
      if (row.histogramOk) entry.ok.merge(row.histogramOk);
      if (row.histogramKo) entry.ko.merge(row.histogramKo);
    }

    const stats: StatsResponse['stats'] = [...byKey.values()]
      .filter((e) => (name !== undefined ? e.name === name : true))
      .map((e) => ({
        scope: e.scope as StatsResponse['stats'][number]['scope'],
        name: e.name,
        family: e.family as StatsResponse['stats'][number]['family'],
        ...rollupFromHistograms(e.ok, e.ko, window.toMs - window.fromMs, settings.percentiles),
        // From the WINDOW's own OK histogram, so the bands describe the same
        // requests as every other column in the row.
        indicators: bandsOrRefuse(e.ok, e.ko.total, settings.indicators),
      }));

    const runRow = stats.find((s) => s.scope === 'run' && s.family === 'response_time');
    return {
      runId: run.id,
      stats,
      indicators: runRow?.indicators ?? { under: 0, between: 0, over: 0, failed: 0 },
      // Histograms are what a window is computed from, so a windowed response
      // is configurable by construction — there is no frozen-value fallback
      // here for `configurable: false` to warn about.
      configurable: true,
      bounds: settings.indicators,
      window,
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

  /**
   * Failures over time, RUN SCOPE ONLY — and it takes no `scope` or `name`
   * query parameters at all.
   *
   * That absence is deliberate. `errors` above has to defend itself against a
   * caller who sends `?name=X` and no `?scope=`, because the sibling endpoints
   * force `name` to `''` when `scope` is absent and silently answer for the
   * whole run. The surest way not to reproduce that trap is to have no such
   * parameters: this table holds one scope, and the signature says so.
   */
  @Get('errors/series')
  @Scopes('read')
  async errorSeries(
    @Param('id', uuidParam('id')) id: string,
    @Req() req: Request,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<ErrorSeriesResponse> {
    const run = await this.#run(req, id);
    const range = await resolveRange(this.reader, run, from, to);
    const scope = { orgId: run.orgId, projectId: run.projectId };

    const [all, flat] = await Promise.all([
      this.reader.errorSeries(scope, run.id, run.startedOn),
      this.reader.errors(scope, run.id),
    ]);

    /**
     * ONE EXPRESSION OVER BOTH COUNTS, not a lookup keyed on the flat table.
     *
     * Four states, and a rule keyed on `flat` alone gets one of them wrong: a
     * project with `warmupMs > 0` whose only failures fell inside the ramp has
     * bucket rows and NO flat rows, because series include warm-up and the
     * rollup does not. That run's data is present, not missing.
     *
     *   none / none  → the run genuinely had no failures     → available
     *   some / none  → ingested before this existed          → NOT available
     *   some / some  → recorded                              → available
     *   none / some  → warm-up-only failures                 → available
     */
    const available = all.length > 0 || flat.length === 0;
    // Availability is a property of the RUN, not of the window — asked before
    // filtering, so a window over a quiet stretch reports "no failures here"
    // rather than "this run was never recorded".
    const rows = all.filter((r) => inRange(r.startOffsetMs, range));

    // Grouped in first-seen order, which ERROR_SERIES_SQL's ORDER BY makes the
    // global rank order the engine emitted — most frequent first, so the
    // palette assigns its first hue to the biggest series.
    const byMessage = new Map<
      string | null,
      { total: number; points: { startOffsetMs: number; count: number }[] }
    >();
    for (const row of rows) {
      let entry = byMessage.get(row.message);
      if (!entry) {
        entry = { total: 0, points: [] };
        byMessage.set(row.message, entry);
      }
      entry.total += row.count;
      entry.points.push({ startOffsetMs: row.startOffsetMs, count: row.count });
    }

    return {
      runId: run.id,
      // The STORED width, constant per run — never `inferBucketWidthMs`, which
      // reads the smallest gap between offsets and is systematically wrong on
      // a sparse series. `?? 1000` only for a run with no rows at all, where
      // nothing is drawn at any width.
      bucketWidthMs: all[0]?.bucketWidthMs ?? 1000,
      available,
      window: range === null ? null : snapWindow(all.map((r) => r.startOffsetMs), range),
      series: [...byMessage.entries()].map(([message, entry]) => ({ message, ...entry })),
    };
  }

  /**
   * Host telemetry for this run, on this run's own elapsed axis.
   *
   * TAKES NO `scope`/`name`. Telemetry is a property of the MACHINE, not of a
   * request or a group, so the `?name=X` without `?scope=` trap the sibling
   * endpoints carry cannot arise here: there is nothing to forget to send. The
   * one dimension is `host`, and the client filters on it — six charts for one
   * host at a time, because an aggregate across a fleet would hide the single
   * saturated generator this whole feature exists to find.
   */
  @Get('telemetry')
  @Scopes('read')
  async telemetry(
    @Param('id', uuidParam('id')) id: string,
    @Req() req: Request,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<TelemetryResponse> {
    const run = await this.#run(req, id);
    const range = await resolveRange(this.reader, run, from, to);
    const scope = { orgId: run.orgId, projectId: run.projectId };

    // The run's OWN bucket width, from its own series — never a 1000ms
    // constant. The engine halves resolution on a long run, and assuming 1000
    // would put telemetry on a different x-grid from every chart beside it.
    const series = await this.reader.series(scope, run.id, run.startedOn, {
      scope: 'run', name: '', family: 'response_time',
    });
    const offsets = series.map((b) => b.startOffsetMs);
    const bucketWidthMs = offsets.length > 0 ? inferBucketWidthMs([...offsets].sort((a, b) => a - b)) : 1000;

    // A run that never finished parsing has no toolStartedAt, so it has no
    // window at all — and therefore no telemetry. Reported as unavailable
    // rather than as an empty chart, which would read as an idle generator.
    if (run.toolStartedAt === null) {
      return { runId: run.id, available: false, bucketWidthMs, window: null, hosts: [] };
    }

    const startMs = run.toolStartedAt.getTime();
    const durationMs = run.durationMs ?? 0;
    const samples = await this.telemetrySamples.forRun(
      scope,
      // The lookback is what gives the first in-run bucket a predecessor to
      // difference against; toTelemetrySeries drops the negative offsets.
      startMs - TELEMETRY_LOOKBACK_MS,
      startMs + durationMs,
    );

    /**
     * `available` IS COMPUTED FROM THE SERIES, NOT FROM `samples.length`.
     *
     * A run whose `durationMs` is null (worker-unset) or zero has EVERY
     * sample dropped by `toTelemetrySeries` as lookback-only: its window is
     * `[0, durationMs)`, so a sample that arrived moments before the run
     * started — the ordinary shape of a real agent report — resolves to a
     * negative offset and is skipped. `samples.length > 0` would report
     * `available: true` with `hosts: []`, a state TelemetryResponseSchema's
     * own doc comment says cannot happen.
     *
     * Computed BEFORE the range filter below, for the same reason
     * errors/series asks it before filtering: a window over a quiet stretch
     * of a run that WAS recorded must read as "nothing here", never as "this
     * run was never recorded".
     */
    const all = toTelemetrySeries(samples, startMs, bucketWidthMs, durationMs);
    const available = all.some((h) => h.points.length > 0);

    const hosts = all
      .map((h) => ({ ...h, points: h.points.filter((p) => inRange(p.startOffsetMs, range)) }))
      .filter((h) => h.points.length > 0);

    // From the WHOLE (unfiltered) series, exactly like snapWindow's other
    // callers — a narrow window must not mistake its own span for the run's
    // resolution. `bucketWidthMs` is passed explicitly rather than left for
    // snapWindow to infer from `everyOffset`: when the agent's sampling
    // interval is coarser than the run's own bucket width, consecutive
    // telemetry points are spaced by the INTERVAL, not the width, and
    // inference would report a `window.bucketWidthMs` that disagrees with
    // the top-level `bucketWidthMs` above — two bucket widths in one
    // response describing the same run.
    const everyOffset = all.flatMap((h) => h.points.map((p) => p.startOffsetMs));
    return {
      runId: run.id,
      available,
      bucketWidthMs,
      window: range === null ? null : snapWindow(everyOffset, range, bucketWidthMs),
      hosts,
    };
  }
}

/** Best-effort human-readable detail for an unexpected caught error. */
/**
 * Indicator bands, or a refusal that names the setting responsible.
 *
 * `bandsFrom` reaches `Histogram#countBelow`, which REFUSES a bound above the
 * 120s overflow cap while overflow observations exist — the exact count is
 * genuinely unrecoverable there, and that refusal is right. What a read
 * handler must not do is let it out: `ProblemFilter` turns it into a 500
 * whose remediation is "Retry the request", and retrying re-reads the same
 * buckets against the same setting for ever.
 *
 * ═══ WHY THIS IS A FUNCTION AND NOT A SECOND try/catch ═══
 *
 * There are TWO callers — the unwindowed `stats` and `#windowedStats` — and
 * only the first was guarded, so brushing a window turned a precise 400 into
 * that 500 for one run under one project configuration:
 *
 *     unwindowed  400 PROJECT_SETTINGS_INVALID   names higherMs, says to lower it
 *     windowed    500 INTERNAL                   "Retry the request…"
 *
 * Wrapping the second call site in its own try/catch would have restored the
 * wording by copying it, which is how two expressions deciding one thing come
 * to disagree. One definition, both callers.
 *
 * ═══ AND IT IS NARROWER THAN THE GUARD IT REPLACES ═══
 *
 * That try/catch wrapped the WHOLE row map — the sketch quantile included —
 * while its message asserts the cause is `indicators.higherMs`. A comment
 * argued "the only throw reachable from here is that overflow-cap case",
 * which is an argument rather than a guarantee: any future throw in that map
 * would have been reported as a settings problem the operator does not have.
 * Scoped to the one call that can raise it, the claim is true by construction.
 */
function bandsOrRefuse(
  ok: Histogram,
  koCount: number,
  indicators: { lowerMs: number; higherMs: number },
): IndicatorBands {
  try {
    return bandsFrom(ok, koCount, indicators);
  } catch (err) {
    throw badRequest(
      'PROJECT_SETTINGS_INVALID',
      `The project's "indicators.higherMs" (${indicators.higherMs}) cannot be applied to this run: ${message(err)}`,
      'Lower the project\'s "indicators.higherMs" setting to at most 120000 (the histogram overflow cap) and retry.',
    );
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
