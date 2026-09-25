import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Window } from '@perfportal/contracts';
import * as paths from '../src/api/metricPaths';

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
  it('lets neither caller spell a metrics URL for itself', () => {
    const files = ['apps/web/src/api/metrics.ts', 'scripts/capture-chart-fixture.mjs'];
    for (const file of files) {
      const src = read(file);
      // Vacuity: an empty or renamed file would satisfy every assertion below.
      expect(src.length, `${file} is empty — the path has rotted`).toBeGreaterThan(2000);
      expect(src, `${file} no longer imports the shared builders`).toContain('metricPaths');
      expect(strip(src).match(/\/v1\//g) ?? [], `${file} hand-writes a metrics URL`).toEqual([]);
    }
  });
});
