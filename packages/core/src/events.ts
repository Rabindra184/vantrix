import type { ToolAssertion } from './assertions.js';
export type ToolId = 'gatling' | 'k6' | 'jmeter' | 'locust' | 'artillery' | (string & {});
export type MetricScope = 'run' | 'scenario' | 'group' | 'request';
export type MetricFamily = 'response_time' | 'latency' | 'group_cumulated' | 'group_duration';

export interface MetaEvent {
  type: 'meta';
  simulation: string;
  toolVersion: string;
  startedAtMs: number;
  description?: string;
  /**
   * The assertions the load test itself declared — Appendix A G-05.
   *
   * ON THE META EVENT, not an event of their own, because they are not
   * something that HAPPENED during the run: a tool writes them once, in its
   * result file's header, before any traffic. They describe the run the same
   * way `simulation` and `startedAtMs` do.
   *
   * DEFINITIONS ONLY — no outcome and no actual value, because the result file
   * carries neither. The engine recomputes both against its own statistics; see
   * `evaluateToolAssertions`.
   *
   * Optional: a tool that has no such concept omits it, and a run that declared
   * none yields an empty array from one that does.
   */
  assertions?: readonly ToolAssertion[];
}

/** startMs and endMs are both retained: FR-STAT-7 needs each edge independently. */
export interface RequestEvent {
  type: 'request';
  name: string;
  groups: string[];
  scenario?: string;
  userId: string;
  startMs: number;
  endMs: number;
  firstByteMs?: number;
  ok: boolean;
  message?: string;
}

export interface UserEvent {
  type: 'user';
  scenario: string;
  userId: string;
  kind: 'start' | 'end';
  tsMs: number;
}

/** cumulatedResponseTimeMs is carried explicitly — it diverges from (endMs - startMs)
 *  whenever requests inside the group overlap, and Gatling reports both. */
export interface GroupEvent {
  type: 'group';
  groups: string[];
  userId: string;
  startMs: number;
  endMs: number;
  cumulatedResponseTimeMs: number;
  ok: boolean;
}

/**
 * A failure that is NOT a request's failure — Appendix A G-17.
 *
 * ═══ WHY THIS IS ITS OWN EVENT AND NOT A FAILED REQUEST ═══
 *
 * A tool can record a failure that never belonged to a completed request: a
 * check that could not run, an expression that referenced a value the session
 * never had, an exception that aborted a virtual user mid-scenario. Gatling
 * writes these as their own record type and counts them in the global errors
 * table alongside request failures.
 *
 * They are NOT request KOs and must never be folded into one. On the reference
 * run the distinction is exactly measurable: 357 requests failed, and the
 * errors table totals 399 — the 42 difference is two classes of
 * `No attribute named 'sessionId' is defined`, raised when a `/session` call
 * had already failed so the next request never ran at all. Counting those as
 * request failures would move `koCount` off 357 and break every exact-value
 * parity row in §A.5 at once; dropping them, which is what this model did
 * before, leaves the errors table short by 42 and two rows narrower than the
 * report it claims parity with.
 *
 * So it carries no `name` and no `groups`: there is no request to attribute it
 * to, which is the entire point. `tsMs` is when the tool recorded it.
 */
export interface ErrorEvent {
  type: 'error';
  message: string;
  tsMs: number;
}

export type CanonicalEvent = MetaEvent | RequestEvent | UserEvent | GroupEvent | ErrorEvent;
