import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseWindow, rangeSuffix, serialiseWindow } from '../src/routes/window';
import { statsQuery, statsQueryKey, seriesQuery } from '../src/api/metrics';

const RUN_MS = 60_000;

describe('parseWindow', () => {
  it('is the whole run when the URL names no window', () => {
    expect(parseWindow(null, null, RUN_MS)).toBeNull();
  });

  it('honours one bound alone', () => {
    // Each is meaningful on its own: `from` runs to the end, `to` from the
    // start. Neither is ever silently dropped.
    expect(parseWindow('1000', null, RUN_MS)).toEqual({ fromMs: 1000, toMs: RUN_MS, bucketWidthMs: 0 });
    expect(parseWindow(null, '1000', RUN_MS)).toEqual({ fromMs: 0, toMs: 1000, bucketWidthMs: 0 });
  });

  it('falls back rather than throwing on a malformed value', () => {
    // `safeNext`'s stance: the reader asked to see a run, and a mangled query
    // string is no reason to refuse them one.
    expect(parseWindow('abc', 'def', RUN_MS)).toBeNull();
    expect(parseWindow('1.5', '900', RUN_MS)).toBeNull();
    expect(parseWindow('-1', '900', RUN_MS)).toBeNull();
  });

  it('falls back on an inverted range instead of 400ing every figure', () => {
    expect(parseWindow('900', '100', RUN_MS)).toBeNull();
    expect(parseWindow('500', '500', RUN_MS)).toBeNull();
  });

  it('clamps to the run rather than asking for time that does not exist', () => {
    expect(parseWindow('0', '999999', RUN_MS)?.toMs).toBe(RUN_MS);
  });

  it('round-trips through serialiseWindow', () => {
    const w = parseWindow('1000', '5000', RUN_MS);
    const { from, to } = serialiseWindow(w);
    expect(parseWindow(from ?? null, to ?? null, RUN_MS)).toEqual(w);
  });

  it('serialises the whole run as no parameters at all', () => {
    expect(serialiseWindow(null)).toEqual({});
  });
});

describe('rangeSuffix', () => {
  it('is empty for the whole run, so an unwindowed URL is unchanged', () => {
    expect(rangeSuffix(null)).toBe('');
  });

  it('joins with & when the URL already has a query string', () => {
    const w = { fromMs: 0, toMs: 1000, bucketWidthMs: 0 };
    expect(rangeSuffix(w)).toBe('?from=0&to=1000');
    expect(rangeSuffix(w, '&')).toBe('&from=0&to=1000');
  });
});

describe('query keys', () => {
  it('carries the window, so staleTime: Infinity stays correct', () => {
    // The concern the earlier spec raised about this feature. It dissolves
    // once the window is part of the key: a completed run's metrics FOR A
    // GIVEN WINDOW still never change.
    const whole = statsQueryKey('run-1', null);
    const part = statsQueryKey('run-1', { fromMs: 0, toMs: 1000, bucketWidthMs: 0 });
    const other = statsQueryKey('run-1', { fromMs: 1000, toMs: 2000, bucketWidthMs: 0 });
    expect(whole).not.toEqual(part);
    expect(part).not.toEqual(other);
  });

  /**
   * The URL is captured from a stubbed `fetch`, not read off
   * `queryFn.toString()` — that returns the function's SOURCE, where the
   * bounds are still an un-evaluated template expression, so it would pass
   * against a factory that never appended anything.
   */
  const urlFrom = async (factory: { queryFn: () => Promise<unknown> }): Promise<string> => {
    let seen = '';
    vi.stubGlobal('fetch', (input: RequestInfo) => {
      seen = String(input);
      return Promise.resolve(
        new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
      );
    });
    // The response is deliberately unparseable against the schema; the URL is
    // recorded before that matters.
    await factory.queryFn().catch(() => undefined);
    return seen;
  };

  it('puts the window on the URL of a windowed request', async () => {
    const url = await urlFrom(statsQuery('run-1', { fromMs: 0, toMs: 1000, bucketWidthMs: 0 }));
    expect(url).toContain('from=0');
    expect(url).toContain('to=1000');
  });

  it('leaves an unwindowed URL exactly as it was', async () => {
    expect(await urlFrom(statsQuery('run-1', null))).not.toContain('from=');
  });

  it('appends with & where the URL already carries parameters', async () => {
    // seriesQuery's URL already has ?scope=&name=&family=, so a `?` here would
    // produce two query strings and the server would see neither bound.
    const url = await urlFrom(seriesQuery('run-1', 'run', '', 'response_time', {
      fromMs: 0, toMs: 1000, bucketWidthMs: 0,
    }));
    expect(url).toContain('&from=0');
    expect(url).not.toContain('?from=');
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the duration argument is not decorative', () => {
  /**
   * THE BUG THIS PINS. `parseWindow` was called with the run's real duration
   * in `RunShell` and with `Number.MAX_SAFE_INTEGER` in each tab. For a URL
   * carrying BOTH bounds the two agree, which is why every existing test and
   * the whole e2e suite stayed green — but for a URL carrying only `?from=`
   * the open upper bound is the duration, so they produced different windows,
   * different query keys, and a duplicate fetch of the same data under a
   * heading promising one window for the page.
   *
   * The window is now parsed once in the shell and passed down, so there is
   * only one duration in play. This asserts the sensitivity that made the
   * divergence possible, so a future re-parse cannot reintroduce it quietly.
   */
  it('changes the open upper bound, so two callers with different durations disagree', () => {
    const short = parseWindow('1000', null, 60_000);
    const long = parseWindow('1000', null, Number.MAX_SAFE_INTEGER);
    expect(short).not.toEqual(long);
    expect(short?.toMs).toBe(60_000);
  });

  it('agrees regardless of duration when BOTH bounds are given', () => {
    // Which is why the e2e suite never caught it: the brush always writes both.
    const short = parseWindow('1000', '5000', 60_000);
    const long = parseWindow('1000', '5000', Number.MAX_SAFE_INTEGER);
    expect(short).toEqual(long);
  });
});
