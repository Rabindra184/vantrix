import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseSimulationLog, StreamingLogDecoder } from '@perfportal/plugin-gatling';
import { Bucket, LiveEngine, runEngine } from '../src/index.js';

const LOG = new URL(
  '../../../fixtures/gatling-3.15.1.2/reference-report/simulation.log',
  import.meta.url,
);

/**
 * THE test that licenses `close` finalizing from the live accumulators.
 *
 * If this fails, the design's section 2.2 is wrong and close must re-parse the
 * finished log instead of trusting the fold. Do not weaken it to make a change
 * pass.
 */
describe('chunk invariance', () => {
  const comparable = (r: ReturnType<typeof runEngine>) => {
    const projectedBucket = (b: Bucket) => ({
      // Numeric bucket fields (these stringify fine)
      startOffsetMs: b.startOffsetMs, startedCount: b.startedCount, endedCount: b.endedCount,
      okCount: b.okCount, koCount: b.koCount, startedOkCount: b.startedOkCount, startedKoCount: b.startedKoCount,
      // Sketch accumulators — project through public accessors
      sketch: {
        count: b.sketch.count, min: b.sketch.min, max: b.sketch.max, sum: b.sketch.sum,
        p50: b.sketch.quantile(0.5), p95: b.sketch.quantile(0.95),
      },
      sketchOk: {
        count: b.sketchOk.count, min: b.sketchOk.min, max: b.sketchOk.max, sum: b.sketchOk.sum,
        p50: b.sketchOk.quantile(0.5), p95: b.sketchOk.quantile(0.95),
      },
      sketchKo: {
        count: b.sketchKo.count, min: b.sketchKo.min, max: b.sketchKo.max, sum: b.sketchKo.sum,
        p50: b.sketchKo.quantile(0.5), p95: b.sketchKo.quantile(0.95),
      },
      // Histogram accumulators — project through snapshot()
      histogramOk: b.histogramOk.snapshot(),
      histogramKo: b.histogramKo.snapshot(),
    });

    return JSON.parse(JSON.stringify({
      stats: r.stats.map((s) => ({
        scope: s.scope, name: s.name, family: s.family, count: s.count,
        okCount: s.okCount, koCount: s.koCount, errorRate: s.errorRate,
        minMs: s.minMs, maxMs: s.maxMs, meanMs: s.meanMs, stddevMs: s.stddevMs,
        percentiles: s.percentiles, throughputRps: s.throughputRps,
        okTotal: s.histogramOk.total, koTotal: s.histogramKo.total,
      })),
      series: [...r.series.entries()].map(([k, v]) => [k, v.buckets.map(projectedBucket)]),
      users: r.users, errors: r.errors, errorSeries: r.errorSeries,
      endpointCount: r.endpointCount, runStartedAtMs: r.runStartedAtMs,
      simulation: r.simulation, description: r.description,
      durationMs: r.durationMs, toolAssertions: r.toolAssertions,
    }));
  };

  it('streamed at random boundaries, equals a batch fold of the whole log', () => {
    const buf = readFileSync(LOG);
    const expected = comparable(runEngine(parseSimulationLog(buf)));

    let seed = 1178;
    const nextCut = (max: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return 1 + (seed % Math.max(1, max));
    };

    for (let trial = 0; trial < 10; trial++) {
      const decoder = new StreamingLogDecoder();
      const engine = new LiveEngine();
      let at = 0;
      while (at < buf.length) {
        const n = Math.min(nextCut(8192), buf.length - at);
        for (const e of decoder.push(buf.subarray(at, at + n))) engine.add(e);
        at += n;
      }
      expect(comparable(engine.snapshot({ clone: true }))).toEqual(expected);
    }
  });

  it('bucket widths agree, so coalescing happened at the same points', () => {
    const buf = readFileSync(LOG);
    const batch = runEngine(parseSimulationLog(buf));

    const decoder = new StreamingLogDecoder();
    const engine = new LiveEngine();
    for (let at = 0; at < buf.length; at += 997) {          // prime stride
      for (const e of decoder.push(buf.subarray(at, at + 997))) engine.add(e);
    }
    const live = engine.snapshot({ clone: true });

    // Derived from the payload: whatever widths the batch fold chose, the live
    // fold must have chosen the same ones for the same keys.
    const widths = (r: typeof batch) => [...r.series.entries()].map(
      ([k, v]) => [k, v.buckets.length, v.buckets[0]?.startOffsetMs ?? null] as const,
    );
    expect(widths(live)).toEqual(widths(batch));
  });
});
