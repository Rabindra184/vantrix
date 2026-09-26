import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  canStep,
  parseWindow,
  presetWindow,
  serialiseWindow,
  snapBound,
  stepWindow,
  WINDOW_PRESETS,
  WINDOW_STEPS,
  type Span,
  type WindowStep,
} from '../src/routes/window';
// `rangeSuffix` moved to the module that builds the API URLs consuming it.
import { rangeSuffix } from '../src/api/metricPaths';
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

/* ======================================================================== *
 * THE SIX CONTROLS, AGAINST GATLING ENTERPRISE'S OWN FIGURES
 * ======================================================================== */

/**
 * Every expectation in the first block was measured on cloud.gatling.io
 * against a two-minute run that began 17:12:09 (the spec's table), and is
 * written here as the offset it is: 17:12:39 is 30 s.
 */
const GATLING_RUN_MS = 120_000;
const SECOND = 1_000;
const w = (fromMs: number, toMs: number) => ({ fromMs, toMs, bucketWidthMs: 0 });

describe('stepWindow — Gatling Enterprise’s measured steps', () => {
  it('zooms in by a quarter from each edge, keeping the centre', () => {
    // 17:12:09–17:14:09 became 17:12:39–17:13:39.
    expect(stepWindow({ fromMs: 0, toMs: 120_000 }, 'zoom-in', GATLING_RUN_MS, SECOND)).toEqual(
      w(30_000, 90_000),
    );
  });

  it('zooms out by a quarter from each edge, cut at the run’s end rather than slid', () => {
    // 17:13:09–17:14:09 became 17:12:54–17:14:09: 60 s to 75 s.
    expect(stepWindow({ fromMs: 60_000, toMs: 120_000 }, 'zoom-out', GATLING_RUN_MS, SECOND)).toEqual(
      w(45_000, 120_000),
    );
  });

  it('pans backward by a fifth of the width, keeping it', () => {
    // 17:12:39–17:13:39 became 17:12:27–17:13:27.
    expect(stepWindow({ fromMs: 30_000, toMs: 90_000 }, 'backward', GATLING_RUN_MS, SECOND)).toEqual(
      w(18_000, 78_000),
    );
  });

  it('pans forward by a fifth', () => {
    // 17:12:09–17:13:09 became 17:12:21–17:13:21.
    expect(stepWindow({ fromMs: 0, toMs: 60_000 }, 'forward', GATLING_RUN_MS, SECOND)).toEqual(
      w(12_000, 72_000),
    );
  });

  it('fast-pans by the whole width', () => {
    // 17:12:25–17:12:44 became 17:12:44–17:13:03.
    expect(stepWindow({ fromMs: 16_000, toMs: 35_000 }, 'fast-forward', GATLING_RUN_MS, SECOND)).toEqual(
      w(35_000, 54_000),
    );
  });

  it('slides a pan against the start, keeping the width', () => {
    // 17:12:27–17:13:27, fast back, became 17:12:09–17:13:09.
    expect(stepWindow({ fromMs: 18_000, toMs: 78_000 }, 'fast-backward', GATLING_RUN_MS, SECOND)).toEqual(
      w(0, 60_000),
    );
  });
});

describe('stepWindow — the resolution and the ends', () => {
  it('lands an interior bound on the nearest multiple of the resolution', () => {
    // A typed window is off the grid; a fifth of 20 s is 4 s.
    expect(stepWindow({ fromMs: 10_300, toMs: 30_300 }, 'backward', GATLING_RUN_MS, SECOND)).toEqual(
      w(6_000, 26_000),
    );
  });

  it('keeps the run’s own end exactly, so its last partial bucket is never dropped', () => {
    // 63,161 ms is the reference run's span; rounded it would be 63,000.
    expect(stepWindow({ fromMs: 40_000, toMs: 60_000 }, 'forward', 63_161, SECOND)).toEqual(
      w(43_000, 63_161),
    );
  });

  it('never zooms in narrower than one bucket', () => {
    // A quarter of 1.6 s rounds both edges onto 11 s; the bucket holding the
    // centre is what is left.
    expect(stepWindow({ fromMs: 10_200, toMs: 11_800 }, 'zoom-in', GATLING_RUN_MS, SECOND)).toEqual(
      w(11_000, 12_000),
    );
  });

  it('is the whole run, no window at all, once a step covers it', () => {
    expect(stepWindow({ fromMs: 10_000, toMs: 110_000 }, 'zoom-out', GATLING_RUN_MS, SECOND)).toBeNull();
  });

  it('snaps to a coarser resolution when the run has one', () => {
    // A long run's buckets widen in powers of two. The same zoom at 1 s would
    // be 25–75 s.
    expect(stepWindow({ fromMs: 0, toMs: 100_000 }, 'zoom-in', GATLING_RUN_MS, 4_000)).toEqual(
      w(24_000, 76_000),
    );
  });
});

/* ======================================================================== *
 * NARROW WINDOWS, WHERE GATLING WAS NEVER MEASURED
 * ======================================================================== */

/**
 * ═══ SNAPPING EACH BOUND ON ITS OWN CANCELLED THE STEP ═══
 *
 * Below about two and a half buckets, a fifth or a quarter of the width
 * rounds back to the bound it started from, so a button `canStep` enabled
 * changed nothing — reproduced on a real 108.5 s run, where six Zoom ins
 * reach one bucket and Zoom out, Backward and Forward then sat live and
 * inert. A window narrower than a bucket stepped to an EMPTY one, which
 * `TimeBrush` committed and `parseWindow` reads back as the whole run.
 *
 * Nothing above could see it: every measured case starts from a window at
 * least twenty seconds wide, and nothing stepped from the one-bucket floor
 * that Zoom in — the only control enabled on arrival — leads straight to.
 */
describe('stepWindow — a narrow window still moves', () => {
  const REFERENCE_MS = 63_161;

  it('moves a one-bucket window on every live control', () => {
    const bucket = { fromMs: 31_000, toMs: 32_000 };
    const at = (step: WindowStep) => stepWindow(bucket, step, REFERENCE_MS, SECOND);
    expect(at('zoom-out')).toEqual(w(30_000, 33_000));
    expect(at('backward')).toEqual(w(30_000, 31_000));
    expect(at('forward')).toEqual(w(32_000, 33_000));
    expect(at('fast-backward')).toEqual(w(30_000, 31_000));
    expect(at('fast-forward')).toEqual(w(32_000, 33_000));
  });

  it('pans a two-bucket window by a bucket, where a fifth of it rounded to nothing', () => {
    const two = { fromMs: 30_000, toMs: 32_000 };
    expect(stepWindow(two, 'backward', REFERENCE_MS, SECOND)).toEqual(w(29_000, 31_000));
    expect(stepWindow(two, 'forward', REFERENCE_MS, SECOND)).toEqual(w(31_000, 33_000));
  });

  it('never steps a window narrower than a bucket to an empty one', () => {
    // From 30.1 To 30.4, typed. Four of these five used to land on
    // [30000, 30000], which the URL reads as the whole run.
    const typed = { fromMs: 30_100, toMs: 30_400 };
    const at = (step: WindowStep) => stepWindow(typed, step, REFERENCE_MS, SECOND);
    expect(at('zoom-out')).toEqual(w(29_000, 31_000));
    expect(at('backward')).toEqual(w(29_000, 30_000));
    expect(at('fast-backward')).toEqual(w(29_000, 30_000));
    expect(at('forward')).toEqual(w(31_000, 32_000));
    expect(at('fast-forward')).toEqual(w(31_000, 32_000));
  });

  it('keeps the run’s last, partial bucket as one bucket, so Forward never moves back', () => {
    // A 2.457 s run's last bucket is 457 ms. Reading every result under one
    // resolution wide as "narrower than a bucket" swapped it for the bucket
    // before it: [1000, 2000], Forward moving BACK.
    expect(stepWindow({ fromMs: 1_365, toMs: 2_289 }, 'forward', 2_457, SECOND)).toEqual(w(2_000, 2_457));
    // And from inside that bucket the live steps still leave it.
    const last = { fromMs: 63_000, toMs: REFERENCE_MS };
    expect(stepWindow(last, 'backward', REFERENCE_MS, SECOND)).toEqual(w(62_000, 63_000));
    expect(stepWindow(last, 'zoom-out', REFERENCE_MS, SECOND)).toEqual(w(62_000, REFERENCE_MS));
  });

  /**
   * ═══ THE INVARIANTS, OVER EVERY SHAPE A WINDOW TAKES ═══
   *
   * Grid-aligned and off-grid windows, ones narrower than a bucket, ones
   * against either end and reproducible pseudo-random ones, on runs from
   * 2.457 s to an hour at three resolutions. For every step `canStep`
   * enables:
   *
   *   - the result is a DIFFERENT window: a live button moves something;
   *   - a non-null result is never empty;
   *   - a pan's leading edge moves the way it points — the emptiness rule's
   *     reason for being, where a width test moved Forward back;
   *   - zoom out contains the window it grew from, and zoom in narrows it.
   *
   * THE VACUITY COUNTERS COUNT THE CONSTRUCTS — steps checked, and the
   * narrow and off-grid windows among them — never how many passed.
   */
  it('holds for every enabled step over windows, runs and resolutions', () => {
    const failures: string[] = [];
    let checked = 0;
    let narrow = 0;
    let offGrid = 0;
    for (const runMs of [2_457, 63_161, 63_700, 108_532, 120_000, 3_600_000]) {
      for (const resolutionMs of [1_000, 2_000, 16_000]) {
        for (const current of windowsFor(runMs, resolutionMs)) {
          if (current.toMs - current.fromMs < resolutionMs) narrow += 1;
          if (current.fromMs % resolutionMs !== 0 || (current.toMs % resolutionMs !== 0 && current.toMs !== runMs)) {
            offGrid += 1;
          }
          for (const { step } of WINDOW_STEPS) {
            if (!canStep(current, step, runMs, resolutionMs)) continue;
            checked += 1;
            const next = stepWindow(current, step, runMs, resolutionMs);
            const from = next?.fromMs ?? 0;
            const to = next?.toMs ?? runMs;
            const problems = [
              from === current.fromMs && to === current.toMs && 'moved nothing',
              next !== null && !(next.fromMs < next.toMs) && 'is empty',
              (step === 'backward' || step === 'fast-backward') && !(from < current.fromMs) && 'kept its start',
              (step === 'forward' || step === 'fast-forward') && !(to > current.toMs) && 'kept its end',
              step === 'zoom-out' && !(from <= current.fromMs && to >= current.toMs) && 'lost part of the window',
              step === 'zoom-in' && !(to - from < current.toMs - current.fromMs) && 'is not narrower',
            ].filter((problem): problem is string => problem !== false);
            for (const problem of problems) {
              failures.push(
                `${step} from [${current.fromMs}, ${current.toMs}] (run ${runMs}, ${resolutionMs} ms) ${problem}: ${JSON.stringify(next)}`,
              );
            }
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(50_000);
    expect(narrow).toBeGreaterThan(3_000);
    expect(offGrid).toBeGreaterThan(10_000);
    expect({ failures: failures.length, first: failures.slice(0, 5) }).toEqual({ failures: 0, first: [] });
  });
});

/**
 * The windows the sweep steps from: every one satisfies `stepWindow`'s
 * precondition, `0 <= fromMs < toMs <= runMs`, as `parseWindow` guarantees.
 */
function windowsFor(runMs: number, resolutionMs: number): Span[] {
  const spans: Span[] = [{ fromMs: 0, toMs: runMs }];
  const add = (fromMs: number, toMs: number): void => {
    const from = Math.round(fromMs);
    const to = Math.round(toMs);
    if (from >= 0 && from < to && to <= runMs) spans.push({ fromMs: from, toMs: to });
  };
  const r = resolutionMs;
  const widths = [1, 300, r / 2, r - 1, r, r + 1, 1.5 * r, 2 * r, 2.5 * r, 3 * r, 10 * r, runMs / 3, runMs / 2, runMs - 1];
  const starts = [0, 1, r / 2, r, 1.3 * r, 31 * r, runMs / 4, runMs / 2];
  for (const width of widths) {
    for (const start of starts) {
      add(start, start + width);
      add(runMs - start - width, runMs - start); // the same, against the end
    }
  }
  // Pseudo-random, reproducibly: MINSTD with a fixed seed, exact in doubles,
  // so a failure names the same window on every run.
  let seed = 7;
  const next = (): number => (seed = (seed * 48_271) % 2_147_483_647) / 2_147_483_647;
  for (let i = 0; i < 300; i += 1) {
    const a = Math.floor(next() * runMs);
    const b = Math.floor(next() * runMs);
    add(Math.min(a, b), Math.max(a, b));
    const at = Math.floor(next() * runMs);
    add(at, at + 1 + Math.floor(next() * 3 * r));
  }
  return spans;
}

describe('snapBound', () => {
  it('keeps both ends of the run exactly and rounds everything between', () => {
    expect(snapBound(-5, 63_161, SECOND)).toBe(0);
    expect(snapBound(63_161, 63_161, SECOND)).toBe(63_161);
    expect(snapBound(70_000, 63_161, SECOND)).toBe(63_161);
    expect(snapBound(12_499, 63_161, SECOND)).toBe(12_000);
    expect(snapBound(12_500, 63_161, SECOND)).toBe(13_000);
  });
});

describe('canStep — the buttons at their limits', () => {
  const enabled = (current: Span, step: WindowStep): boolean =>
    canStep(current, step, GATLING_RUN_MS, SECOND);

  it('offers only Zoom in while the whole run is selected', () => {
    const whole = { fromMs: 0, toMs: GATLING_RUN_MS };
    expect(WINDOW_STEPS.filter(({ step }) => enabled(whole, step)).map(({ step }) => step)).toEqual([
      'zoom-in',
    ]);
  });

  it('stops backward at the start and forward at the end', () => {
    const atStart = { fromMs: 0, toMs: 30_000 };
    expect(enabled(atStart, 'backward')).toBe(false);
    expect(enabled(atStart, 'fast-backward')).toBe(false);
    expect(enabled(atStart, 'forward')).toBe(true);
    const atEnd = { fromMs: 90_000, toMs: GATLING_RUN_MS };
    expect(enabled(atEnd, 'forward')).toBe(false);
    expect(enabled(atEnd, 'fast-forward')).toBe(false);
    expect(enabled(atEnd, 'backward')).toBe(true);
  });

  it('stops zooming in at one bucket', () => {
    expect(enabled({ fromMs: 10_000, toMs: 11_000 }, 'zoom-in')).toBe(false);
    expect(enabled({ fromMs: 10_000, toMs: 12_000 }, 'zoom-in')).toBe(true);
  });

  it('names the six controls in Gatling’s order and words', () => {
    expect(WINDOW_STEPS.map(({ label }) => label)).toEqual([
      'Fast backward', 'Backward', 'Zoom out', 'Zoom in', 'Forward', 'Fast forward',
    ]);
  });
});

describe('presetWindow — measured back from the run’s end', () => {
  const FOUR_HOURS = 4 * 3_600_000;

  it('takes the final stretch of a long run', () => {
    expect(presetWindow(5 * 60_000, FOUR_HOURS, SECOND)).toEqual(w(FOUR_HOURS - 5 * 60_000, FOUR_HOURS));
  });

  it('is the whole run when the preset is at least as long as the run', () => {
    expect(presetWindow(5 * 60_000, 63_161, SECOND)).toBeNull();
    expect(presetWindow(63_161, 63_161, SECOND)).toBeNull();
  });

  it('is the whole run for Everything', () => {
    expect(presetWindow(null, FOUR_HOURS, SECOND)).toBeNull();
  });

  it('offers Gatling’s six presets, in its words', () => {
    expect(WINDOW_PRESETS.map((preset) => preset.label)).toEqual([
      'Last 5 Minutes', 'Last 15 Minutes', 'Last 30 Minutes', 'Last 1 hour', 'Last 1 day', 'Everything',
    ]);
  });
});
