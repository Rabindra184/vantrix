/**
 * A TOOL'S OWN ASSERTIONS — Appendix A G-05.
 *
 * ═══ NOT THE SAME THING AS AN SLA RULE, AND DELIBERATELY NOT UNIFIED ═══
 *
 * `run_assertion` and `contracts`' `Assertion` model THIS platform's SLA rules:
 * they carry a `ruleId`, they are configured per project, they are edited over
 * time, and their outcome drives the 200/422 verdict a CI job gates on.
 *
 * These are the assertions the LOAD TEST ITSELF declared — written into the
 * tool's own result file at run start, immutable, and owned by whoever wrote
 * the simulation. Collapsing the two would mean either giving a Gatling
 * assertion a rule id it does not have, or widening the SLA comparator set to
 * include `between` and `in` and then having the SLA engine refuse to evaluate
 * most of it. They are reported side by side and never merged.
 *
 * ═══ TOOL-AGNOSTIC BY CONSTRUCTION ═══
 *
 * Nothing here names Gatling. Every concept below — a scope, a measure, a
 * comparison — exists in k6 thresholds and JMeter assertions too, so a second
 * plugin populates the same shape rather than the presentation layer learning
 * a second vocabulary (PRD tenet 3: tool knowledge terminates at the plugin
 * boundary).
 */

/** Which slice of the run an assertion is about. */
export type AssertionPath =
  /** The run as a whole. */
  | { kind: 'global' }
  /**
   * EVERY request, individually — the assertion holds only if it holds for
   * each one. Distinct from `global`, which asks the same question of the
   * run's combined statistics and can pass while an individual endpoint fails.
   */
  | { kind: 'forAll' }
  /**
   * One named path through the run — a request, or a group, or a group and the
   * request inside it. `parts` is outermost first and is joined with '/' to
   * reach the statistics tree, exactly as a request's own identity is built.
   */
  | { kind: 'details'; parts: readonly string[] };

/** Which requests a count or percentage is over. */
export type AssertionStatus = 'all' | 'ok' | 'ko';

/** The quantity being asserted on. */
export type AssertionTarget =
  | { kind: 'count'; status: AssertionStatus }
  | { kind: 'percent'; status: AssertionStatus }
  | {
      kind: 'responseTime';
      stat: 'min' | 'max' | 'mean' | 'stddev' | 'percentile';
      /** Set only when `stat` is `percentile`; 0–100. */
      rank?: number;
    }
  | { kind: 'meanRequestsPerSecond' };

/**
 * The comparison.
 *
 * `between` carries `inclusive` because the tool records it, and `in` carries a
 * list because a tool can assert membership of a set. Neither maps onto the SLA
 * engine's `lte`/`gte` pair, which is the concrete reason these are not one
 * model — see the file docstring.
 */
export type AssertionCondition =
  | { kind: 'lt' | 'lte' | 'gt' | 'gte' | 'is'; value: number }
  | { kind: 'between'; lo: number; hi: number; inclusive: boolean }
  | { kind: 'in'; values: readonly number[] };

/**
 * One assertion, as the tool declared it.
 *
 * DEFINITION ONLY — there is no outcome and no actual value here, because the
 * result file carries none. Gatling's own report recomputes both at render
 * time from the same log. This platform does the same, against its own
 * statistics, which is what lets the verdict be exact where the tool's
 * percentiles are estimates (PRD §A.9 F-6).
 */
export interface ToolAssertion {
  readonly path: AssertionPath;
  readonly target: AssertionTarget;
  readonly condition: AssertionCondition;
}
