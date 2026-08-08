import type { CanonicalEvent } from '@perfportal/core';
import { describe, expect, it } from 'vitest';
import { runEngine } from '../src/engine.js';

/**
 * The worker needs the load test's own start time (not ingest time) to
 * populate run.tool_started_at. It is only available after parsing, carried
 * on the 'meta' event — so the engine must surface it on EngineResult rather
 * than swallowing it into internal warm-up bookkeeping.
 */
describe('runEngine exposes the run\'s own start time', () => {
  it('reports the meta event\'s startedAtMs on the result', () => {
    const events: CanonicalEvent[] = [
      { type: 'meta', simulation: 'S', toolVersion: '3.15.1', startedAtMs: 1700000000000 },
    ];
    const result = runEngine(events);
    expect(result.runStartedAtMs).toBe(1700000000000);
  });

  it('is null when no meta event is present, rather than defaulting to epoch 0', () => {
    const result = runEngine([]);
    expect(result.runStartedAtMs).toBeNull();
  });
});
