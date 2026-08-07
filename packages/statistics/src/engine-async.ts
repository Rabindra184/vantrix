import type { CanonicalEvent } from '@perfportal/core';
import { runEngine, type EngineOptions, type EngineResult } from './engine.js';

/**
 * Drains an AsyncIterable into the synchronous engine.
 *
 * This deliberately materializes the event array. Spec §5.1: at the 5M-event
 * target the whole Gatling log is ~150-250 MB and engine state is ~91 MB, well
 * inside an 8 GiB worker, so the cost of a true streaming rewrite of the
 * parity-verified decoder is not yet justified. The async signature is the seam
 * that makes that rewrite invisible to callers when measurement demands it.
 */
export async function runEngineAsync(
  events: AsyncIterable<CanonicalEvent>,
  opts: EngineOptions = {},
): Promise<EngineResult> {
  const collected: CanonicalEvent[] = [];
  for await (const e of events) collected.push(e);
  return runEngine(collected, opts);
}
