import { ScatterResponseSchema } from '@perfportal/contracts';
import { describe, expect, it } from 'vitest';
import { toScatter } from '../src/charts/transforms/scatter';
import fixture from './fixtures/reference-run.json';

const scatter = ScatterResponseSchema.parse(fixture.scatter);

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
