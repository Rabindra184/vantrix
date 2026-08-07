import type { CanonicalEvent } from '@perfportal/core';

/** Deterministic synthetic load, roughly log-normal latency across N endpoints. */
export function* generateEvents(count: number, endpoints: number): Generator<CanonicalEvent> {
  const base = 1_700_000_000_000;
  yield { type: 'meta', simulation: 'synthetic', toolVersion: '0', startedAtMs: base };
  let seed = 12345;
  const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return Math.abs(seed) / 2147483647; };
  for (let i = 0; i < count; i++) {
    const r = rnd();
    const dur = r < 0.9 ? 20 + rnd() * 180 : r < 0.99 ? 300 + rnd() * 500 : 1500 + rnd() * 1500;
    const start = base + Math.floor((i / count) * 3_600_000);
    yield {
      type: 'request',
      name: `endpoint-${i % endpoints}`,
      groups: [],
      userId: String(i % 500),
      startMs: start,
      endMs: start + Math.round(dur),
      ok: rnd() > 0.02,
      message: undefined,
    };
  }
}
