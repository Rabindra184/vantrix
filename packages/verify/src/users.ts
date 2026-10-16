import type { CanonicalEvent } from '@perfportal/core';
import type { ExpectedUserBucket, VerifyOptions } from './figures.js';
import { BASE_WIDTH_MS } from './figures.js';

/**
 * ═══ `run_user_bucket`, RECOMPUTED FROM THE USER EVENTS ═══
 *
 * Appendix A of the PR 3 plan, implemented from the text:
 *
 *   Per scenario, every user event, warm-up included, sorted by time with a
 *   START before an END at the same millisecond. Walked at one-second
 *   buckets: a bucket is created holding `max_concurrent` = the concurrency
 *   standing at that moment; each start adds to `started` and the
 *   concurrency, each end to `ended` and takes one off; `max_concurrent`
 *   is the running peak. Every second between the first bucket and the last
 *   that has no event is filled with `{0, 0, standing}`. Then, while there are
 *   more than 1200 buckets, the width doubles and bucket `i` joins `⌊i/2⌋`:
 *   `started` and `ended` summed, `max_concurrent` the larger.
 *
 * Coalescing a contiguous run of indexes by `⌊i/2⌋` k times is `⌊i/2^k⌋`, and
 * the run stays contiguous, so the final width is known from the first and
 * last index alone. The second-by-second buckets — gap-filled ones included —
 * are folded straight into it rather than built and halved k times: the
 * answer is the same, and a soak run's millions of seconds are never held at
 * once.
 */

/** The bucket count a scenario's users are coalesced below. Not configurable. */
export const USER_BUCKET_CAP = 1200;

interface Second {
  started: number;
  ended: number;
  maxConcurrent: number;
}

export function expectedUsers(events: readonly CanonicalEvent[], opts: VerifyOptions): ExpectedUserBucket[] {
  const byScenario = new Map<string, { t: number; start: boolean }[]>();
  for (const e of events) {
    if (e.type !== 'user') continue;
    let list = byScenario.get(e.scenario);
    if (list === undefined) {
      list = [];
      byScenario.set(e.scenario, list);
    }
    list.push({ t: e.tsMs - opts.runStartMs, start: e.kind === 'start' });
  }

  const out: ExpectedUserBucket[] = [];
  const scenarios = [...byScenario.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const scenario of scenarios) out.push(...bucketsOf(scenario, byScenario.get(scenario)!));
  return out;
}

function bucketsOf(scenario: string, list: { t: number; start: boolean }[]): ExpectedUserBucket[] {
  // Stable: events at one millisecond and of one kind keep their log order.
  const sorted = [...list].sort((a, b) => a.t - b.t || Number(b.start) - Number(a.start));

  const seconds = new Map<number, Second>();
  let concurrency = 0;
  for (const ev of sorted) {
    const index = Math.floor(ev.t / BASE_WIDTH_MS);
    let s = seconds.get(index);
    if (s === undefined) {
      s = { started: 0, ended: 0, maxConcurrent: concurrency };
      seconds.set(index, s);
    }
    if (ev.start) {
      s.started += 1;
      concurrency += 1;
    } else {
      s.ended += 1;
      concurrency -= 1;
    }
    s.maxConcurrent = Math.max(s.maxConcurrent, concurrency);
  }

  const indexes = [...seconds.keys()].sort((a, b) => a - b);
  const first = indexes[0]!;
  const last = indexes[indexes.length - 1]!;

  // How many times the gap-filled run [first, last] halves before it fits.
  let factor = 1;
  while (Math.floor(last / factor) - Math.floor(first / factor) + 1 > USER_BUCKET_CAP) factor *= 2;
  const width = BASE_WIDTH_MS * factor;

  const coarse = new Map<number, Second>();
  let standing = 0;
  for (let i = first; i <= last; i += 1) {
    const s = seconds.get(i);
    let one: Second;
    if (s === undefined) one = { started: 0, ended: 0, maxConcurrent: standing };
    else {
      one = s;
      standing += s.started - s.ended;
    }
    const j = Math.floor(i / factor);
    const c = coarse.get(j);
    if (c === undefined) coarse.set(j, { ...one });
    else {
      c.started += one.started;
      c.ended += one.ended;
      c.maxConcurrent = Math.max(c.maxConcurrent, one.maxConcurrent);
    }
  }

  return [...coarse.entries()].map(([j, c]) => ({
    scenario,
    startOffsetMs: j * width,
    started: c.started,
    ended: c.ended,
    maxConcurrent: c.maxConcurrent,
  }));
}
