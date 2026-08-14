import { ScatterResponseSchema } from '@perfportal/contracts';
import { describe, expect, it } from 'vitest';
import { toScatter } from '../src/charts/transforms/scatter';
import fixture from './fixtures/reference-run.json';

const scatter = ScatterResponseSchema.parse(fixture.scatter);

// `scatter` above (`Catalog/List Products`) has ZERO KO points, so nothing
// below that reads it can tell `{ name: 'KO', data: s.ko }` apart from the
// bug `{ name: 'KO', data: s.ok }` — both produce an empty KO series against
// this payload. `scatterWithFailures` (`Cart/Add To Cart`, captured
// specifically because it fails: 15 KO against 48 OK) is what makes that
// distinction assertable. See scripts/capture-chart-fixture.mjs for why this
// second payload exists.
const scatterWithFailures = ScatterResponseSchema.parse(fixture.scatterWithFailures);

describe('toScatter', () => {
  it('plots one point per bucket as an [x, y] pair', () => {
    const data = toScatter(scatter);
    const ok = data.series.find((s) => s.name === 'OK')!;
    expect(ok.data).toEqual(scatter.ok);
  });

  it('keeps OK and KO as independent series, not a split of one', () => {
    const data = toScatter(scatter);
    expect(data.series.map((s) => s.name)).toEqual(['OK', 'KO']);
  });

  it('tables every point, because the table is the parity surface', () => {
    const data = toScatter(scatter);
    expect(data.rows).toHaveLength(scatter.ok.length + scatter.ko.length);
    expect(data.columns).toEqual(['Series', 'Requests per second', 'p95 (ms)']);
  });

  it('says why it is empty rather than drawing empty axes', () => {
    const data = toScatter({ ...scatter, ok: [], ko: [] });
    expect(data.series).toEqual([]);
    expect(data.empty).toBeDefined();
  });
});

describe('toScatter — a request with real KO points (Cart/Add To Cart)', () => {
  it('plots the KO series from its own data, not a copy of OK', () => {
    // The assertion `scatter` above cannot make: its `ko` is `[]`, so a
    // transform written as `{ name: 'KO', data: s.ok }` would pass every test
    // in the block above too. This fixture's 15 real KO points are the only
    // bytes in this file that can catch that swap.
    const data = toScatter(scatterWithFailures);
    const ko = data.series.find((s) => s.name === 'KO')!;
    expect(ko.data).toEqual(scatterWithFailures.ko);
    expect(ko.data.length).toBeGreaterThan(0);
  });

  it('tables rows from both series, at a length a KO-free payload could not reach', () => {
    const data = toScatter(scatterWithFailures);
    // 48 OK + 15 KO = 63. Against a payload whose `ko` is `[]` (like `scatter`
    // above), this length collapses to `ok.length` alone — so reaching past
    // it here is proof the KO rows are actually present, not merely a count
    // that happens to match.
    expect(data.rows).toHaveLength(scatterWithFailures.ok.length + scatterWithFailures.ko.length);
    expect(data.rows.filter((r) => r.label === 'KO')).toHaveLength(scatterWithFailures.ko.length);
    expect(data.rows.filter((r) => r.label === 'OK')).toHaveLength(scatterWithFailures.ok.length);
  });

  it('keeps OK and KO independent — their points do not pair up by index', () => {
    const data = toScatter(scatterWithFailures);
    const ok = data.series.find((s) => s.name === 'OK')!;
    const ko = data.series.find((s) => s.name === 'KO')!;
    // 48 OK points against 15 KO in this fixture: an implementation that
    // zipped the two arrays by index — pairing ok[i] with ko[i], or
    // truncating one to the other's length — could not reproduce both at
    // their real, UNEQUAL lengths. `scatter` above (60 OK, 0 KO) cannot make
    // this point: a 0-length series trivially "pairs" with anything.
    expect(ok.data).toHaveLength(scatterWithFailures.ok.length);
    expect(ko.data).toHaveLength(scatterWithFailures.ko.length);
    expect(ok.data.length).not.toBe(ko.data.length);
  });
});
