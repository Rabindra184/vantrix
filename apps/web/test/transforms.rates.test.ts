import type { SeriesResponse } from '@perfportal/contracts';
import { describe, expect, it } from 'vitest';
import { toRequestRate, toResponseRate } from '../src/charts/transforms/rates';
import type { ChartData } from '../src/charts/types';
import fixture from './fixtures/reference-run.json';

/**
 * §13.2 ⑩ requests per second (Appendix A G-23) and ⑪ responses per second
 * (G-24), both folded out of `GET /v1/runs/:id/series`.
 *
 * Read against `fixtures/reference-run.json` — the payload captured from the
 * live API for the real Gatling reference run, the same bytes the browser gets.
 *
 * WHAT THIS FILE MEASURED BEFORE IT ASSERTED, because two of the brief's three
 * tests cannot fail against this payload as it stands and one of the three
 * things this task exists to get right is invisible to it entirely:
 *
 *   - THE DIVISOR. `bucketWidthMs` is 1000 here, so `count / (width/1000)` and
 *     `count / 1` are the same number in every bucket of every series. No
 *     assertion written against this payload alone can tell a correct divisor
 *     from a hard-coded 1000. Every divisor test below therefore builds a
 *     payload with a DIFFERENT width, and `the fixture cannot discriminate the
 *     divisor on its own` records why.
 *   - THE UNAVAILABLE SPLIT. `startedSplitAvailable` is `true` here, so the
 *     branch that the nullable columns exist for is unreachable from the
 *     fixture. Constructed, likewise.
 *   - THE KO EDGE. `startedKoCount === koCount` in ALL 62 buckets — every KO
 *     request in this run starts and ends inside one second — so a KO series
 *     read off the WRONG edge is byte-identical to one read off the right one.
 *     The All and OK series do discriminate (33 of 62 buckets disagree, the
 *     first of them being bucket 0), the KO series does not, and
 *     `the KO series reads its own edge too` is the constructed case that pins
 *     it. This is the same trap Task 2 found on the way in.
 */

const series = fixture.series as unknown as SeriesResponse;

/** One drawn series' values, by name. */
function line(chart: ChartData, name: string): readonly (number | null)[] {
  const found = chart.series.find((s) => s.name === name);
  expect(found, `expected a series named ${name}`).toBeDefined();
  return found!.data as readonly (number | null)[];
}

/** How many buckets disagree between two of the bucket's counters. */
function disagreeing(
  a: (b: SeriesResponse['buckets'][number]) => number | null,
  b: (bucket: SeriesResponse['buckets'][number]) => number | null,
): number {
  return series.buckets.filter((bucket) => a(bucket) !== b(bucket)).length;
}

describe('the reference payload — what it can and cannot discriminate', () => {
  it('cannot discriminate the divisor on its own: its bucket width IS 1000 ms', () => {
    // The precondition every constructed-width test below exists because of.
    // If the fixture is ever recaptured from a long run whose buckets were
    // halved in resolution, this fails and says so, rather than letting the
    // notes above quietly become false.
    expect(series.bucketWidthMs).toBe(1000);
  });

  it('cannot exercise the unavailable split on its own: the flag is true', () => {
    expect(series.startedSplitAvailable).toBe(true);
    for (const bucket of series.buckets) {
      expect(typeof bucket.startedOkCount).toBe('number');
      expect(typeof bucket.startedKoCount).toBe('number');
    }
  });

  it('DOES discriminate the start and end edges on All and on OK', () => {
    // 33 of 62 buckets in each case, and — what makes the brief's own
    // `data[0]` assertions mean anything — the very first bucket is one of
    // them: 7 started, 6 ended; 7 started OK, 6 ended OK.
    expect(disagreeing((b) => b.startedCount, (b) => b.endedCount)).toBeGreaterThan(0);
    expect(disagreeing((b) => b.startedOkCount, (b) => b.okCount)).toBeGreaterThan(0);
    expect(series.buckets[0]!.startedCount).not.toBe(series.buckets[0]!.endedCount);
    expect(series.buckets[0]!.startedOkCount).not.toBe(series.buckets[0]!.okCount);
  });

  it('does NOT discriminate the edges on KO — recorded as a fact about this run', () => {
    // Every one of the 24 failures starts and ends within the same second, so
    // a KO series plotted off `koCount` instead of `startedKoCount` is
    // identical here. Asserted as `toBe(0)` rather than assumed: the day a
    // recaptured fixture can tell them apart, this fails and the constructed
    // case below can be retired.
    expect(disagreeing((b) => b.startedKoCount, (b) => b.koCount)).toBe(0);
  });

  it('ends with a bucket that only the END edge counts', () => {
    // A request that started at 62.x s and finished at 63.x s. Requests/s must
    // draw 0 for that second and responses/s must draw 1.
    const last = series.buckets.at(-1)!;
    expect(last.startOffsetMs).toBe(63_000);
    expect(last.startedCount).toBe(0);
    expect(last.endedCount).toBe(1);
    expect(last.okCount).toBe(1);
  });
});

describe('the rate is per second, not per bucket', () => {
  // The fixture with its width changed and nothing else — the only payload in
  // this file that can fail against a hard-coded 1000.
  const wide: SeriesResponse = { ...series, bucketWidthMs: 2000 };

  it('divides by the reported bucket width, never a hard-coded 1000', () => {
    const d = toRequestRate(wide);
    expect(line(d, 'All')[0]).toBeCloseTo(series.buckets[0]!.startedCount / 2, 6);
  });

  it('divides EVERY series of BOTH charts, in every bucket', () => {
    // The headline test above reads one point of one series of one chart. A
    // divisor applied to `All` and forgotten on the split — or applied to
    // requests/s and forgotten on responses/s — passes it.
    const req = toRequestRate(wide);
    const res = toResponseRate(wide);
    expect(line(req, 'All')).toEqual(series.buckets.map((b) => b.startedCount / 2));
    expect(line(req, 'OK')).toEqual(series.buckets.map((b) => (b.startedOkCount ?? 0) / 2));
    expect(line(req, 'KO')).toEqual(series.buckets.map((b) => (b.startedKoCount ?? 0) / 2));
    expect(line(res, 'All')).toEqual(series.buckets.map((b) => b.endedCount / 2));
    expect(line(res, 'OK')).toEqual(series.buckets.map((b) => b.okCount / 2));
    expect(line(res, 'KO')).toEqual(series.buckets.map((b) => b.koCount / 2));
  });

  it('scales the data table by the same divisor as the drawing', () => {
    // The table is the parity surface (design §7). A rate drawn correctly and
    // tabulated as a raw count is two different answers to one question, and
    // the table is the one a reader quotes.
    const d = toResponseRate(wide);
    expect(d.rows[0]!.values).toEqual([
      series.buckets[0]!.endedCount / 2,
      series.buckets[0]!.okCount / 2,
      series.buckets[0]!.koCount / 2,
    ]);
  });

  it('says the window is not a second, when it is not', () => {
    // Dividing silently is its own dishonesty: the chart is titled "per
    // second" and a one-second spike inside a two-second bucket is averaged
    // away with nothing on the drawing to say so.
    expect(toRequestRate(wide).limitation).toMatch(/2000 ms/);
    expect(toResponseRate(wide).limitation).toMatch(/2000 ms/);
  });

  it('says nothing of the kind at a one-second width', () => {
    expect(toRequestRate(series).limitation ?? '').not.toMatch(/ms buckets/);
    expect(toResponseRate(series).limitation ?? '').not.toMatch(/ms buckets/);
  });
});

describe('the START edge and the END edge, never crossed', () => {
  it('splits requests/s on the START edge and responses/s on the END edge', () => {
    const req = toRequestRate(series);
    const res = toResponseRate(series);
    expect(req.series.map((s) => s.name)).toEqual(['All', 'OK', 'KO']);
    expect(res.series.map((s) => s.name)).toEqual(['All', 'OK', 'KO']);
    const w = series.bucketWidthMs / 1000;
    expect(line(req, 'OK')[0]).toBeCloseTo((series.buckets[0]!.startedOkCount ?? 0) / w, 6);
    expect(line(res, 'OK')[0]).toBeCloseTo(series.buckets[0]!.okCount / w, 6);
  });

  it('reads every bucket off its own edge, All and OK alike', () => {
    const req = toRequestRate(series);
    const res = toResponseRate(series);
    expect(line(req, 'All')).toEqual(series.buckets.map((b) => b.startedCount));
    expect(line(req, 'OK')).toEqual(series.buckets.map((b) => b.startedOkCount));
    expect(line(res, 'All')).toEqual(series.buckets.map((b) => b.endedCount));
    expect(line(res, 'OK')).toEqual(series.buckets.map((b) => b.okCount));

    // And the two charts are genuinely different curves on this run, which is
    // the fact that makes the four assertions above capable of failing.
    expect(line(req, 'All')).not.toEqual(line(res, 'All'));
    expect(line(req, 'OK')).not.toEqual(line(res, 'OK'));
  });

  it('the KO series reads its own edge too', () => {
    // CONSTRUCTED, because the fixture cannot see this (see the top of the
    // file): every KO in the reference run starts and ends in one second, so
    // `startedKoCount === koCount` everywhere and a crossed KO series is
    // invisible. Here the first bucket's two KO counters disagree.
    const crossed: SeriesResponse = {
      ...series,
      buckets: series.buckets.map((b, i) =>
        i === 0
          ? {
              ...b,
              // 5 of the 7 that STARTED here failed; 2 of the 6 that ENDED
              // here failed. Both splits still sum to their own total, so a
              // transform reading the wrong pair produces an entirely
              // self-consistent chart.
              startedOkCount: 2,
              startedKoCount: 5,
              okCount: 4,
              koCount: 2,
            }
          : b,
      ),
    };
    expect(line(toRequestRate(crossed), 'KO')[0]).toBe(5);
    expect(line(toResponseRate(crossed), 'KO')[0]).toBe(2);
    expect(line(toRequestRate(crossed), 'OK')[0]).toBe(2);
    expect(line(toResponseRate(crossed), 'OK')[0]).toBe(4);
  });

  it('draws the last second as 0 requests and 1 response', () => {
    // The real end-vs-start case in the payload, asserted on the drawing
    // rather than on the fixture: a request that started at 62.x s and ended
    // at 63.x s. A requests/s chart showing 1 there is reading `endedCount`.
    expect(line(toRequestRate(series), 'All').at(-1)).toBe(0);
    expect(line(toResponseRate(series), 'All').at(-1)).toBe(1);
  });

  it('shares one x-axis in elapsed seconds, so the crosshair means the same thing', () => {
    const expected = series.buckets.map((b) => b.startOffsetMs / 1000);
    expect(toRequestRate(series).axisLabels).toEqual(expected);
    expect(toResponseRate(series).axisLabels).toEqual(expected);
  });
});

describe('a run ingested before the start-edge split existed', () => {
  // The flag is the API's own (`metrics.controller.ts` derives it from both
  // columns being non-null in every bucket), and nulls are what a pre-migration
  // run actually carries.
  const preMigration: SeriesResponse = {
    ...series,
    startedSplitAvailable: false,
    buckets: series.buckets.map((b) => ({ ...b, startedOkCount: null, startedKoCount: null })),
  };

  it('draws All alone and explains, when the split was never recorded', () => {
    const d = toRequestRate(preMigration);
    expect(d.series.map((s) => s.name)).toEqual(['All']);
    // Two flat zero lines would read as "no failures"; the truth is "not recorded".
    expect(JSON.stringify(d)).toMatch(/not recorded|unavailable/i);
  });

  it('says it in the limitation prose, which is the part that gets rendered', () => {
    // `JSON.stringify` above is satisfied by the phrase appearing ANYWHERE —
    // a series named "OK (not recorded)" would pass it while drawing the very
    // zero line the flag exists to prevent.
    expect(toRequestRate(preMigration).limitation).toMatch(/not recorded|unavailable/i);
  });

  it('drops the OK and KO COLUMNS too, rather than tabulating zeros', () => {
    // The data table is the parity surface and is rendered unconditionally, so
    // a chart that draws one line while the table underneath it shows two
    // columns of 0 has told the reader "no failures" in the more quotable of
    // the two places.
    const d = toRequestRate(preMigration);
    expect(d.columns).toEqual(['Elapsed (s)', 'All']);
    expect(d.rows[0]!.values).toEqual([series.buckets[0]!.startedCount]);
  });

  it('still draws the All series in full', () => {
    // "Draw All alone" must not decay into "draw nothing".
    const all = line(toRequestRate(preMigration), 'All');
    expect(all).toEqual(series.buckets.map((b) => b.startedCount));
  });

  it('leaves responses/s untouched — the END-edge split is always recorded', () => {
    // `startedSplitAvailable` is a fact about two columns that only requests/s
    // reads. A responses/s chart that consulted it would drop a split it has.
    const d = toResponseRate(preMigration);
    expect(d.series.map((s) => s.name)).toEqual(['All', 'OK', 'KO']);
    expect(line(d, 'KO')).toEqual(series.buckets.map((b) => b.koCount));
    expect(d.limitation ?? '').not.toMatch(/not recorded|unavailable/i);
  });
});

describe('a missing count where the flag says there should be one', () => {
  // The flag says available, one bucket's counters are null anyway. Not
  // reachable through today's API — it derives the flag from every bucket —
  // but the columns are nullable and the two are separate fields, so the
  // question "what is drawn here" has to have an answer that is not a lie.
  const holed: SeriesResponse = {
    ...series,
    buckets: series.buckets.map((b, i) =>
      i === 3 ? { ...b, startedOkCount: null, startedKoCount: null } : b,
    ),
  };

  it('leaves a gap rather than plotting a zero', () => {
    const d = toRequestRate(holed);
    expect(line(d, 'OK')[3]).toBeNull();
    expect(line(d, 'KO')[3]).toBeNull();
    // The neighbours are untouched: this is a gap, not a truncation.
    expect(line(d, 'OK')[4]).toBe(series.buckets[4]!.startedOkCount);
  });

  it('shows the gap as a dash in the table, not as 0', () => {
    expect(toRequestRate(holed).rows[3]!.values).toEqual([
      series.buckets[3]!.startedCount,
      '—',
      '—',
    ]);
  });
});

describe('the data table', () => {
  it('carries one row per bucket, headed by elapsed seconds', () => {
    const d = toRequestRate(series);
    expect(d.rows).toHaveLength(series.buckets.length);
    expect(d.columns).toEqual(['Elapsed (s)', 'All', 'OK', 'KO']);
    expect(d.rows[0]!.label).toBe(String(series.buckets[0]!.startOffsetMs / 1000));
  });

  it('shows the same values it plots', () => {
    const d = toResponseRate(series);
    for (let i = 0; i < d.rows.length; i++) {
      expect(d.rows[i]!.values).toEqual([
        line(d, 'All')[i],
        line(d, 'OK')[i],
        line(d, 'KO')[i],
      ]);
    }
  });
});

describe('nothing to draw', () => {
  const none: SeriesResponse = { ...series, buckets: [] };

  it('explains itself instead of rendering empty axes', () => {
    const req = toRequestRate(none);
    expect(req.series).toHaveLength(0);
    expect(req.empty).toMatch(/no requests/i);

    const res = toResponseRate(none);
    expect(res.series).toHaveLength(0);
    // Not the same sentence: "nothing was sent" and "nothing came back" are
    // different facts, and on a run that timed out entirely only one is true.
    expect(res.empty).toMatch(/no responses/i);
  });
});
