// This file needs jsdom for the `useTimeDomainFromShell` hook cases at the
// bottom (`renderHook` mounts a real `MemoryRouter`/`Outlet` tree, which needs
// a `document`) — but it lives at `apps/web/test/timeAxis.test.ts`, a `.ts`
// file, and `environmentMatchGlobs` in vitest.config.ts routes only
// `*.test.tsx` to jsdom. This magic comment overrides the environment for
// just this file rather than renaming it, which would also require rewriting
// every path a git-blame or another task's brief already points at. Every
// existing assertion above is plain data and runs identically under jsdom.
// @vitest-environment jsdom
import { createElement, Fragment, type ReactNode } from 'react';
import { renderHook } from '@testing-library/react';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { SeriesResponse, UsersResponse } from '@perfportal/contracts';
import { toPercentiles } from '../src/charts/transforms/percentiles';
import { toRequestRate, toResponseRate } from '../src/charts/transforms/rates';
import { toConcurrentUsers, toUserStartRate } from '../src/charts/transforms/users';
import { useTimeDomainFromShell, type RunWindowContext } from '../src/routes/useRunWindow';
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
      wrapper: wrapperFor({ window: null, durationMs: null, liveDurationMs: 42_000 }),
    });
    expect(result.current).toEqual([0, 42_000]);
  });

  it('still prefers an explicit window over the live duration', () => {
    // `bucketWidthMs` is a real, required field of `Window` (`WindowSchema`,
    // metrics.ts) that `useTimeDomainFromShell` never reads — supplied here
    // only so this object typechecks as one.
    const window = { fromMs: 5_000, toMs: 9_000, bucketWidthMs: 1_000 };
    const { result } = renderHook(() => useTimeDomainFromShell(), {
      wrapper: wrapperFor({ window, durationMs: null, liveDurationMs: 42_000 }),
    });
    expect(result.current).toEqual([5_000, 9_000]);
  });

  it('is undefined when a run reports no duration at all', () => {
    const { result } = renderHook(() => useTimeDomainFromShell(), {
      wrapper: wrapperFor({ window: null, durationMs: null, liveDurationMs: null }),
    });
    expect(result.current).toBeUndefined();
  });

  // The settled duration must WIN, unconditionally, once one exists — a live
  // delta from before the run finished must never override the ground truth
  // just because a caller forgot to clear it.
  it('prefers the settled duration over a stale live one', () => {
    const { result } = renderHook(() => useTimeDomainFromShell(), {
      wrapper: wrapperFor({ window: null, durationMs: 60_000, liveDurationMs: 42_000 }),
    });
    expect(result.current).toEqual([0, 60_000]);
  });
});
