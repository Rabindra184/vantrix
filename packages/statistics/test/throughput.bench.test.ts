import { describe, expect, it } from 'vitest';
import { runEngine } from '../src/engine.js';
import { generateEvents } from './support/generate.js';

const EVENTS = Number(process.env.BENCH_EVENTS ?? 1_000_000);
const ENDPOINTS = 100;

describe('throughput (PRD NFR-PF-4)', () => {
  it(`aggregates ${EVENTS.toLocaleString()} events within budget`, () => {
    const before = process.memoryUsage().heapUsed;
    const t0 = performance.now();
    const r = runEngine(generateEvents(EVENTS, ENDPOINTS));
    const seconds = (performance.now() - t0) / 1000;
    const peakMb = (process.memoryUsage().heapUsed - before) / 1024 / 1024;
    const rate = Math.round(EVENTS / seconds);

    // Reported, not gated — see PRD 20.2. Budget is 5M events in 180s => ~28k/s.
    console.log(`\n  events/sec: ${rate.toLocaleString()}  wall: ${seconds.toFixed(1)}s  heap delta: ${peakMb.toFixed(0)} MB`);
    console.log(`  extrapolated 5M events: ${(5_000_000 / rate).toFixed(0)}s (budget 180s)\n`);

    expect(r.stats.length).toBeGreaterThan(0);
    expect(peakMb).toBeLessThan(1024);          // hard guard: must not approach the 8 GiB worker
  }, 600_000);
});
