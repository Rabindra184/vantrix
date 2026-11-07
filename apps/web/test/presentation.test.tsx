import { cleanup, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  RunPresentationProvider,
  useRunPaths,
  useRunPresentation,
  type RunPresentation,
} from '../src/routes/presentation';
import {
  projectPath,
  projectTestPath,
  runComparePath,
  runGroupPath,
  runLogsPath,
  runPath,
  runReportPath,
  runRequestPath,
  runTrendsPath,
  shareSectionPath,
} from '../src/routes/paths';

afterEach(() => {
  cleanup();
});

const RUN_ID = 'a66548b7-2962-43ff-8b93-7149a6f2a1b8';
const SECRET = 'ppl_0123456789abcdefghijklmnopqrstuvwxyzAB-_CDE';
const PUBLIC: RunPresentation = { kind: 'public', secret: SECRET, expiresAt: '2026-11-13T00:00:00.000Z' };

function within(value: RunPresentation) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <RunPresentationProvider value={value}>{children}</RunPresentationProvider>;
  };
}

describe('useRunPresentation', () => {
  /** The app has one run shell and no provider around it: the default IS the
   *  app, and only the public page says otherwise. */
  it('is the app when nothing says otherwise', () => {
    const { result } = renderHook(() => useRunPresentation());
    expect(result.current).toEqual({ kind: 'app' });
  });

  it('is what the nearest provider says', () => {
    const { result } = renderHook(() => useRunPresentation(), { wrapper: within(PUBLIC) });
    expect(result.current).toEqual(PUBLIC);
  });
});

describe('shareSectionPath', () => {
  it('puts the Summary at the link itself and the Report and Logs one segment under it', () => {
    expect(shareSectionPath(SECRET, 'summary')).toBe(`/share/${SECRET}`);
    expect(shareSectionPath(SECRET, 'report')).toBe(`/share/${SECRET}/report`);
    expect(shareSectionPath(SECRET, 'logs')).toBe(`/share/${SECRET}/logs`);
  });
});

describe('useRunPaths in the app', () => {
  it('builds every destination with the app’s own path helpers', () => {
    const { result } = renderHook(() => useRunPaths(RUN_ID));
    const paths = result.current;
    expect(paths.section('report')).toBe(runReportPath(RUN_ID));
    expect(paths.section('summary')).toBe(runPath(RUN_ID));
    expect(paths.section('logs')).toBe(runLogsPath(RUN_ID));
    expect(paths.section('trends')).toBe(runTrendsPath(RUN_ID));
    expect(paths.section('compare')).toBe(runComparePath(RUN_ID));
    expect(paths.request('Cart/Add To Cart')).toBe(runRequestPath(RUN_ID, 'Cart/Add To Cart'));
    expect(paths.group('Catalog/Recommendations')).toBe(runGroupPath(RUN_ID, 'Catalog/Recommendations'));
    expect(paths.project('checkout')).toBe(projectPath('checkout'));
    expect(paths.test('checkout', 'checkout-soak')).toBe(projectTestPath('checkout', 'checkout-soak'));
  });

  /** The drill-down spelling `StatisticsTable`'s `detailPathFor` already uses:
   *  the run id and the name each ONE encoded segment. */
  it('encodes a drill-down name as one path segment', () => {
    expect(runRequestPath(RUN_ID, 'Cart/Add To Cart')).toBe(`/runs/${RUN_ID}/requests/Cart%2FAdd%20To%20Cart`);
    expect(runGroupPath(RUN_ID, 'Catalog/Recommendations')).toBe(`/runs/${RUN_ID}/groups/Catalog%2FRecommendations`);
  });
});

describe('useRunPaths behind a public link', () => {
  it('builds the three sections the link reaches at share paths', () => {
    const { result } = renderHook(() => useRunPaths(RUN_ID), { wrapper: within(PUBLIC) });
    expect(result.current.section('report')).toBe(`/share/${SECRET}/report`);
    expect(result.current.section('summary')).toBe(`/share/${SECRET}`);
    expect(result.current.section('logs')).toBe(`/share/${SECRET}/logs`);
  });

  /** Everything a link does not reach has NO destination — not the app's,
   *  which would send a stranger to a sign-in page, and not a share path that
   *  the link's allowlist would refuse. */
  it('has no destination for anything the link does not reach', () => {
    const { result } = renderHook(() => useRunPaths(RUN_ID), { wrapper: within(PUBLIC) });
    const paths = result.current;
    expect(paths.section('trends')).toBeNull();
    expect(paths.section('compare')).toBeNull();
    expect(paths.request('x')).toBeNull();
    expect(paths.group('x')).toBeNull();
    expect(paths.project('s')).toBeNull();
    expect(paths.test('s', 't')).toBeNull();
  });

  it('never puts the run’s own app path behind a link', () => {
    const { result } = renderHook(() => useRunPaths(RUN_ID), { wrapper: within(PUBLIC) });
    for (const name of ['summary', 'report', 'logs'] as const) {
      expect(result.current.section(name)).not.toContain(RUN_ID);
    }
  });
});
