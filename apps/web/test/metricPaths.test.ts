import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Window } from '@perfportal/contracts';
import * as paths from '../src/api/metricPaths';
import { seriesQuery, seriesQueryKey, statsQuery, statsQueryKey } from '../src/api/metrics';

/**
 * THE DEFECT THESE GUARD. `scripts/capture-chart-fixture.mjs` used to spell
 * every metrics URL a second time, by hand, and one of the eight had drifted:
 * it asked `/series?scope=run&name=` where the browser asks
 * `?scope=run&name=&family=response_time`. The bytes matched only because
 * `MetricsController.series` defaults `family` to the same word, so the
 * fixture every `apps/web` transform test asserts against was captured from a
 * request the app does not make and nothing anywhere went red.
 *
 * `src/api/metricPaths.ts` is now the one definition and both callers import
 * it, so the drift cannot recur by divergence — only by somebody going back to
 * a literal. That is what the last case bans.
 */

const strip = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

const read = (rel: string): string => readFileSync(`${process.cwd()}/${rel}`, 'utf8');

const ID = '4518cd74-f245-452a-a9db-937d9853c1c5';
const WINDOW: Window = { fromMs: 1000, toMs: 5000, bucketWidthMs: 0 };

/**
 * Each builder, invoked. The TABLE is hand-written because the builders take
 * different arguments in different positions and no generic caller can know
 * where the window goes — but the COVERAGE is derived: the first case below
 * fails if this table and the module's exports disagree, so a builder added
 * later cannot be silently skipped. That is the `fk-free-tables.sql` shape,
 * with only the invocation left explicit.
 */
const PROBES: Record<string, { windowed: (w: Window | null) => string } | { unwindowed: string }> = {
  runPath: { unwindowed: paths.runPath(ID) },
  statsPath: { windowed: (w) => paths.statsPath(ID, w) },
  seriesPath: { windowed: (w) => paths.seriesPath(ID, 'run', '', 'response_time', w) },
  usersPath: { windowed: (w) => paths.usersPath(ID, w) },
  distributionPath: {
    windowed: (w) => paths.distributionPath(ID, 'run', '', 'response_time', w),
  },
  // Takes no window BY THE ENDPOINT'S OWN SHAPE, not by omission here:
  // `/v1/runs/:id/errors` declares no from/to, which is why `ErrorsTable`
  // renders a whole-run notice under a window.
  errorsPath: { unwindowed: paths.errorsPath(ID) },
  errorSeriesPath: { windowed: (w) => paths.errorSeriesPath(ID, w) },
  scatterPath: { windowed: (w) => paths.scatterPath(ID, 'Cart/Add To Cart', w) },
  telemetryPath: { windowed: (w) => paths.telemetryPath(ID, w) },
  trendsPath: { unwindowed: paths.trendsPath(ID) },
  // The run's agent summary takes no window: it names the remotes and
  // hostnames the four figure reads accept, which a window cannot change.
  agentSummaryPath: { unwindowed: paths.agentSummaryPath(ID) },
  // Probed WITH a filter, because that is the case where the window has to
  // join with `&`; `agentApi.test.ts` pins the `*` case, where it joins with `?`.
  agentConnectionsPath: { windowed: (w) => paths.agentConnectionsPath(ID, 'localhost/127.0.0.1:443', w) },
  agentDnsPath: { windowed: (w) => paths.agentDnsPath(ID, 'localhost', w) },
  agentInjectorsPath: { windowed: (w) => paths.agentInjectorsPath(ID, w) },
  agentStatusPath: { windowed: (w) => paths.agentStatusPath(ID, w) },
};

describe('every metrics URL has one definition', () => {
  it('probes every path builder this module exports, so a new one cannot be skipped', () => {
    const exported = Object.entries(paths)
      .filter(([name, v]) => typeof v === 'function' && name.endsWith('Path'))
      .map(([name]) => name)
      .sort();

    // Vacuity: a filter that stopped matching would make this pass against an
    // empty set and every case below assert nothing.
    expect(exported.length, 'collected no path builders — the filter has rotted').toBeGreaterThan(5);
    expect(exported).toEqual(Object.keys(PROBES).sort());
  });

  /**
   * THE HAZARD THIS CLOSES BY CONSTRUCTION. `rangeSuffix` takes its join
   * character as an argument — `?` for a bare path, `&` for one that already
   * carries a query string — and every call site used to restate that fact
   * about a URL written elsewhere. `seriesQuery`'s own comment argued it: "a
   * `?` here would produce two query strings and the server would see neither
   * bound." The builders choose it now, beside the query string they wrote.
   */
  it('joins the window with the right character on every builder that takes one', () => {
    for (const [name, probe] of Object.entries(PROBES)) {
      if (!('windowed' in probe)) continue;
      const url = probe.windowed(WINDOW);
      expect(url, `${name}: ${url}`).toContain('from=1000&to=5000');
      expect((url.match(/\?/g) ?? []).length, `${name} has two query strings: ${url}`).toBe(1);
    }
  });

  it('leaves an unwindowed read exactly as it was', () => {
    for (const [name, probe] of Object.entries(PROBES)) {
      const url = 'windowed' in probe ? probe.windowed(null) : probe.unwindowed;
      expect(url, name).toMatch(/^\/v1\/runs\//);
      expect(url, `${name} carries a bound nobody asked for: ${url}`).not.toContain('from=');
    }
  });

  /**
   * COMMENTS ARE STRIPPED FIRST, AND THAT WAS MEASURED RATHER THAN ASSERTED.
   * Both scanned files QUOTE the two drifted URLs while explaining the defect,
   * so without the strip this case fails on the prose describing the rule
   * instead of on code breaking it — verified by replacing `strip` with the
   * identity and watching it go red on a correct tree.
   *
   * The first version of this comment claimed the same thing and was FALSE:
   * the explanations happened, by accident of how they were worded, to name
   * no URL, so the defanged stripper passed. The prose names them now because
   * that is the better explanation anyway; the check that caught it is the one
   * this repository already prescribes — run the loose spelling against a
   * correct tree and see whether it still passes.
   */
  it('lets no caller spell a metrics URL for itself', () => {
    // The agent pair is the same arrangement one feature over: `api/agent.ts`
    // for the browser and `capture-agent-fixture.mjs` for the fixture its
    // transforms are tested against. Each file carries its own vacuity floor,
    // because `agent.ts` is legitimately small — and the agent capture is held
    // to the agent endpoints' own path segment rather than `/v1/`, because it
    // legitimately spells two URLs that are not metrics reads: the token mint
    // and the bundle upload, which no builder here owns.
    const files: [file: string, floor: number, banned: RegExp][] = [
      ['apps/web/src/api/metrics.ts', 2000, /\/v1\//g],
      ['scripts/capture-chart-fixture.mjs', 2000, /\/v1\//g],
      ['apps/web/src/api/agent.ts', 500, /\/v1\//g],
      ['scripts/capture-agent-fixture.mjs', 2000, /\/agent[/?'"`]/g],
    ];
    for (const [file, floor, banned] of files) {
      const src = read(file);
      // Vacuity: an empty or renamed file would satisfy every assertion below.
      expect(src.length, `${file} is empty — the path has rotted`).toBeGreaterThan(floor);
      expect(src, `${file} no longer imports the shared builders`).toContain('metricPaths');
      expect(strip(src).match(banned) ?? [], `${file} hand-writes a metrics URL`).toEqual([]);
    }
  });
});

/**
 * `?percentiles=` — the extra ranks Compare asks for (p90, p99.9, p99.99).
 *
 * LAST, after the window, so a URL carrying both still has one query string;
 * omitted when no rank is asked for, so every existing read is the same
 * request it was.
 */
describe('the percentiles parameter', () => {
  const RANKS = [99.9, 99.99];

  it('ends a stats URL with the ranks asked for', () => {
    const url = paths.statsPath(ID, null, [99.9]);
    expect(url.endsWith(`percentiles=${[99.9].join(',')}`), url).toBe(true);
    expect((url.match(/\?/g) ?? []).length, url).toBe(1);
  });

  it('joins after the window on stats', () => {
    const url = paths.statsPath(ID, WINDOW, RANKS);
    expect(url).toContain('from=1000&to=5000');
    expect(url.endsWith(`percentiles=${RANKS.join(',')}`), url).toBe(true);
    expect((url.match(/\?/g) ?? []).length, url).toBe(1);
  });

  it('ends a series URL with the ranks asked for, windowed or not', () => {
    for (const w of [null, WINDOW]) {
      const url = paths.seriesPath(ID, 'run', '', 'response_time', w, RANKS);
      expect(url.endsWith(`percentiles=${RANKS.join(',')}`), url).toBe(true);
      expect((url.match(/\?/g) ?? []).length, url).toBe(1);
    }
  });

  it('asks for nothing extra when no rank is named', () => {
    expect(paths.statsPath(ID, WINDOW, [])).toBe(paths.statsPath(ID, WINDOW));
    expect(paths.seriesPath(ID, 'run', '', 'response_time', null, [])).toBe(paths.seriesPath(ID));
  });

  /**
   * A response for different ranks is a different response, so it caches
   * under a different key — and a read naming none keeps the key it always
   * had, which `api/live.ts` writes live deltas into by spelling it out.
   */
  it('keys a read by its ranks, and leaves a rankless key exactly as it was', () => {
    expect(statsQuery(ID, null, RANKS).queryKey).not.toEqual(statsQuery(ID, null).queryKey);
    expect(statsQuery(ID, WINDOW).queryKey).toEqual(statsQueryKey(ID, WINDOW));
    expect(seriesQuery(ID, 'run', '', 'response_time', null, RANKS).queryKey).not.toEqual(
      seriesQuery(ID).queryKey,
    );
    expect(seriesQuery(ID).queryKey).toEqual([
      ...seriesQueryKey(ID, 'run', '', 'response_time'),
      null,
      null,
    ]);
  });
});
