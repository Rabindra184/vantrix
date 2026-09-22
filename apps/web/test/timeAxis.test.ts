// This file needs jsdom for the `useTimeDomainFromShell` hook cases at the
// bottom (`renderHook` mounts a real `MemoryRouter`/`Outlet` tree, which needs
// a `document`) — but it lives at `apps/web/test/timeAxis.test.ts`, a `.ts`
// file, and `environmentMatchGlobs` in vitest.config.ts routes only
// `*.test.tsx` to jsdom. This magic comment overrides the environment for
// just this file rather than renaming it, which would also require rewriting
// every path a git-blame or another task's brief already points at. Every
// existing assertion above is plain data and runs identically under jsdom.
// @vitest-environment jsdom
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createElement, Fragment, type ReactNode } from 'react';
import { renderHook } from '@testing-library/react';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { SeriesResponse, UsersResponse } from '@perfportal/contracts';
import { toPercentiles } from '../src/charts/transforms/percentiles';
import { toRequestRate, toResponseRate } from '../src/charts/transforms/rates';
import { toConcurrentUsers, toUserStartRate } from '../src/charts/transforms/users';
import { growingDomainMs, useTimeDomainFromShell, type RunWindowContext } from '../src/routes/useRunWindow';
import fixture from './fixtures/reference-run.json';

/**
 * ═══ ONE TIME AXIS (§22.5), AND THE SILENT FAILURE THAT GUARDS IT ═══
 *
 * The run page's time charts share a crosshair. A connected `axisPointer` on a
 * CATEGORY axis syncs BY INDEX, so index 40 on one chart lines up with index 40
 * on another whether or not those are the same instant — and they are not: this
 * very fixture carries 62 response-time buckets and 63 user buckets, because
 * `/series` is sparse (a second with no request produces no bucket at all).
 * The charts therefore agreed on a pointer position while disagreeing about
 * what moment it pointed at.
 *
 * The fix is a value axis in milliseconds, which syncs by the number itself.
 * What makes that dangerous is recorded in capitals in CLAUDE.md: **a
 * `type: 'value'` x-axis needs PAIR-shaped series, and scalars on one fail
 * SILENTLY** — ECharts maps each scalar onto both axes and draws a 45° line,
 * throwing nothing and logging nothing. That is the bug that once turned a drag
 * over a third of a 63 s run into `?from=0&to=7`.
 *
 * So this file asserts the JOIN, which neither the transform's own tests nor
 * the chart's can see on their own: the numbers each transform hands the
 * renderer for x are elapsed milliseconds, matching its payload's own offsets.
 */

const series = fixture.series as unknown as SeriesResponse;
const users = fixture.users as unknown as UsersResponse;

/** Every x in a chart's series, asserted to be pair-shaped on the way past. */
function xsOf(data: { series: readonly { data: unknown }[] }): number[][] {
  return data.series.map((s) => {
    const points = s.data as readonly unknown[];
    return points.map((point) => {
      // The whole point of the file: a bare number here is the silent failure.
      expect(Array.isArray(point)).toBe(true);
      return (point as [number, number | null])[0];
    });
  });
}

describe('the run page draws one time axis', () => {
  const seriesOffsets = series.buckets.map((b) => b.startOffsetMs);
  const userOffsets = users.total.map((b) => b.startOffsetMs);

  it('has payloads that genuinely disagree on bucket count — the reason for all this', () => {
    // Derived from the payload, never written down: a re-capture moves both.
    // If these ever became equal the index-sync bug would stop reproducing,
    // and this file's premise would need re-stating rather than quietly
    // passing.
    expect(seriesOffsets.length).not.toBe(userOffsets.length);
  });

  it.each([
    ['toRequestRate', () => toRequestRate(series, { x: 'ms' })],
    ['toResponseRate', () => toResponseRate(series, { x: 'ms' })],
    ['toPercentiles', () => toPercentiles(series, undefined, 'ok', { x: 'ms' })],
  ])('%s plots elapsed milliseconds, in pairs', (_name, build) => {
    for (const xs of xsOf(build())) expect(xs).toEqual(seriesOffsets);
  });

  it.each([
    ['toConcurrentUsers', () => toConcurrentUsers(users, { x: 'ms' })],
    ['toUserStartRate', () => toUserStartRate(users, { x: 'ms' })],
  ])('%s plots elapsed milliseconds, in pairs', (_name, build) => {
    for (const xs of xsOf(build())) expect(xs).toEqual(userOffsets);
  });

  it('keeps the scalar form for a category axis, so the two cannot be confused', () => {
    // The default is unchanged. A caller that wants a category axis still gets
    // one value per label — what must never happen is a scalar series drawn on
    // a value axis, which is what the pair assertions above pin.
    const scalar = toRequestRate(series);
    for (const s of scalar.series) {
      for (const point of s.data as readonly unknown[]) {
        expect(Array.isArray(point)).toBe(false);
      }
    }
  });

  it('has a HOLE in the middle of one payload — the exact shape of the bug', () => {
    // The sharpest form of the problem, and this fixture happens to be a
    // perfect specimen of it: the two payloads start at the same instant AND
    // end at the same instant, yet one has a bucket the other does not. So
    // `/series` is missing a second somewhere in the middle — and every
    // category index PAST that hole refers to a moment one second later than
    // the same index on the users chart.
    //
    // A shared pointer could not have been right. That is not a range problem
    // an aligned min/max would have fixed; it is why the axes had to become
    // VALUE axes and sync on the number itself.
    expect(Math.min(...seriesOffsets)).toBe(Math.min(...userOffsets));
    expect(Math.max(...seriesOffsets)).toBe(Math.max(...userOffsets));
    expect(seriesOffsets.length).toBeLessThan(userOffsets.length);
  });
});

/**
 * ═══ `useTimeDomainFromShell` — THE DOMAIN GROWS THROUGH ONE CODE PATH ═══
 *
 * `useOutletContext` throws outside a matching `<Route>`'s element tree, so
 * there is no plain function to call here — every case below mounts a real
 * `MemoryRouter`/`Routes`/`Route`/`Outlet`, the shape `RunShell` itself
 * renders, with a `RunWindowContext` the test controls.
 *
 * `createElement` rather than JSX: this file is `.ts`, not `.tsx`, and
 * `vitest.config.ts` transforms `apps/*.ts` through swc's PLAIN TypeScript
 * parser (`syntax: 'typescript'`, no `tsx`) — JSX syntax here would be a
 * parse error, not a type error. `createElement` sidesteps that without
 * renaming the file the brief and every later task's cross-reference already
 * name.
 */
function wrapperFor(context: RunWindowContext) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(
      MemoryRouter,
      { initialEntries: ['/r'] },
      createElement(
        Routes,
        null,
        createElement(
          Route,
          { path: '/r', element: createElement(Outlet, { context }) },
          createElement(Route, { index: true, element: createElement(Fragment, null, children) }),
        ),
      ),
    );
  };
}

describe('useTimeDomainFromShell', () => {
  // One code path decides the domain for a live run and a finished one, or
  // the shared crosshair means one instant on one and something else on the
  // other.
  it('takes the domain from the live duration while a run is streaming', () => {
    const { result } = renderHook(() => useTimeDomainFromShell(), {
      wrapper: wrapperFor({ window: null, durationMs: null, liveDurationMs: 42_000, warmupMs: null, live: null }),
    });
    expect(result.current).toEqual([0, 42_000]);
  });

  it('still prefers an explicit window over the live duration', () => {
    // `bucketWidthMs` is a real, required field of `Window` (`WindowSchema`,
    // metrics.ts) that `useTimeDomainFromShell` never reads — supplied here
    // only so this object typechecks as one.
    const window = { fromMs: 5_000, toMs: 9_000, bucketWidthMs: 1_000 };
    const { result } = renderHook(() => useTimeDomainFromShell(), {
      wrapper: wrapperFor({ window, durationMs: null, liveDurationMs: 42_000, warmupMs: null, live: null }),
    });
    expect(result.current).toEqual([5_000, 9_000]);
  });

  it('is undefined when a run reports no duration at all', () => {
    const { result } = renderHook(() => useTimeDomainFromShell(), {
      wrapper: wrapperFor({ window: null, durationMs: null, liveDurationMs: null, warmupMs: null, live: null }),
    });
    expect(result.current).toBeUndefined();
  });

  // The settled duration must WIN, unconditionally, once one exists — a live
  // delta from before the run finished must never override the ground truth
  // just because a caller forgot to clear it.
  it('prefers the settled duration over a stale live one', () => {
    const { result } = renderHook(() => useTimeDomainFromShell(), {
      wrapper: wrapperFor({ window: null, durationMs: 60_000, liveDurationMs: 42_000, warmupMs: null, live: null }),
    });
    expect(result.current).toEqual([0, 60_000]);
  });
});

/**
 * ═══ TASK 9 C4's FORMULA, NOW PINNED FOR ITS OWN SAKE ═══
 *
 * This used to guard TWO production call sites that could not share one
 * call: the standalone `Live` component `RunDetail.tsx` used to render for a
 * still-processing run computed its own growing domain directly —
 * `growingDomainMs(delta.summary.durationMs)` — because it mounted no
 * `<Outlet/>` (a still-processing run rendered no `RunShell` at all back
 * then) and so could not call `useTimeDomainFromShell`, which reads
 * `RunWindowContext` off one.
 *
 * `Live` is gone — `RunShell` now mounts for every run status, processing
 * included, so `useTimeDomainFromShell` is `growingDomainMs`'s only
 * production caller. What this case still guards is narrower but real: it
 * calls `growingDomainMs` directly rather than hand-writing `[0, durationMs]`
 * as a second literal, so a change to the formula that this file did not
 * also make cannot silently pass by coincidence — and it exercises
 * `useTimeDomainFromShell`'s growing-domain branch (no window, no settled
 * duration) against that same call, so the hook and the exported formula are
 * proven to agree rather than merely assumed to.
 */
it('growingDomainMs and useTimeDomainFromShell agree on the growing-run domain formula', () => {
  const durationMs = 42_000;

  // The formula itself, independent of how useTimeDomainFromShell calls it below.
  expect(growingDomainMs(durationMs)).toEqual([0, durationMs]);

  // `useTimeDomainFromShell`'s own growing-domain branch (no window, no
  // settled duration) resolves through the identical function.
  const { result } = renderHook(() => useTimeDomainFromShell(), {
    wrapper: wrapperFor({ window: null, durationMs: null, liveDurationMs: durationMs, warmupMs: null, live: null }),
  });
  expect(result.current).toEqual(growingDomainMs(durationMs));
});

/**
 * ═══ REVIEW N01 — ONE AXIS, ONE NAME ═══
 *
 * Every time series on the run page shares a crosshair group and one
 * `[0, durationMs]` domain, which is what lets a reader correlate offered load
 * against latency and failures by eye. They did not share a NAME: the users
 * charts headed their time column `Time (s)` while every other chart, and
 * every telemetry chart, said `Elapsed (s)`.
 *
 * Asserted over the SOURCE rather than over one transform's output, because
 * the drift is between modules that never meet: `users.ts` owns its own column
 * constant and nothing imports it. CLAUDE.md records the same shape for
 * `tokens.test.ts` (reads the emitted CSS) and `paths.test.ts` (reads
 * `App.tsx`) — some agreements exist only between files.
 *
 * `Elapsed (ms)` is deliberately NOT swept up. Two charts really do draw
 * milliseconds on that axis (the telemetry label column and the compare
 * overlay, which passes no `tickUnit`), so their names are honest about what
 * is drawn; renaming them to seconds would put a false unit on a real axis.
 * That mismatch is a separate defect, recorded rather than papered over here.
 */
/** A repo-root-relative path, wherever the runner was invoked from. */
function fromRepo(rel: string): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i += 1) {
    if (existsSync(resolve(dir, rel))) return resolve(dir, rel);
    dir = resolve(dir, '..');
  }
  throw new Error(`could not find ${rel} from ${process.cwd()}`);
}

describe('the time axis is named once', () => {
  it('never calls elapsed time anything but “Elapsed”', () => {
    const dir = fromRepo('apps/web/src/charts');
    const files = readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter(
      (f) => typeof f === 'string' && (f.endsWith('.ts') || f.endsWith('.tsx')),
    ) as string[];

    const offenders: string[] = [];
    for (const f of files) {
      /* COMMENTS STRIPPED FIRST, and that is not an optimisation. The comment
         explaining a rule quotes the spelling the rule forbids — this guard's
         own `/* "Elapsed (s)", not "Time (s)" *\/` in `users.ts` made it fail
         against the very file it had just corrected. Same shape as the bridge
         regex in `RunStats.test.tsx`, which matched the paragraph documenting
         the defect instead of the product. A source-scanning assertion has to
         read CODE; prose about the rule is not a violation of it. */
      const src = readFileSync(join(dir, f), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '');
      // A quoted label spelling the time axis any other way.
      for (const m of src.matchAll(/['"]Time \((?:s|ms)\)['"]/g)) offenders.push(`${f}: ${m[0]}`);
    }
    expect(offenders).toEqual([]);
  });
});

/**
 * ═══ AN ELAPSED AXIS IN SECONDS ALWAYS CONVERTS ═══
 *
 * Every time series in this product plots raw `startOffsetMs` — a value axis
 * carries x per point — and every one of them names that axis `Elapsed (s)`
 * and passes `tickUnit: 'ms-as-s'`, so the ticks, and the axis POINTER's
 * label, read in seconds. The two are a pair: a name without the conversion
 * draws `42000` under a heading that says seconds, while the data table
 * beneath the same chart writes `42`.
 *
 * `CompareChart` was the one exception. It named its axis `Elapsed (ms)`,
 * which made it honest about its own ticks and silent about the table directly
 * below it listing the identical buckets in seconds — one screen, one
 * quantity, two units, and an axis pointer reading `42000`.
 *
 * COUNTED PER FILE, not globally: a file could otherwise gain an unconverted
 * axis while a sibling gained a spare `tickUnit`, and the totals would still
 * agree. And `Elapsed (ms)` is refused outright on a chart axis, because the
 * plotted value is always milliseconds — a chart that wants to say so is a
 * chart that forgot to convert.
 */
describe('every elapsed axis converts its own ticks', () => {
  it('pairs each “Elapsed (s)” axis with a tickUnit, in every chart file', () => {
    const dir = fromRepo('apps/web/src/charts');
    const files = (
      readdirSync(dir, { recursive: true, encoding: 'utf8' }) as unknown as string[]
    ).filter((f) => typeof f === 'string' && f.endsWith('.tsx'));

    const mismatched: string[] = [];
    let namedAxes = 0;
    for (const f of files) {
      // Comments stripped — the comment explaining this rule quotes both
      // spellings, and a scan that counts prose as product reads the
      // documentation instead of the thing documented. Third time in this
      // review; see `RunGlossary.test.tsx`.
      const src = readFileSync(join(dir, f), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '');
      const names = src.match(/name: 'Elapsed \(s\)'/g)?.length ?? 0;
      const units = src.match(/tickUnit: 'ms-as-s'/g)?.length ?? 0;
      namedAxes += names;
      if (names !== units) mismatched.push(`${f}: ${names} axes, ${units} tickUnit`);
      if (/name: 'Elapsed \(ms\)'/.test(src)) mismatched.push(`${f}: names an axis in milliseconds`);
    }

    expect(mismatched).toEqual([]);
    // A positive beside the absence: an empty chart directory would satisfy
    // the check above and prove nothing at all.
    expect(namedAxes).toBeGreaterThan(10);
  });
});
