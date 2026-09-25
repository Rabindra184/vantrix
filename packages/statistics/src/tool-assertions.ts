import type {
  AssertionCondition,
  AssertionPath,
  AssertionStatus,
  AssertionTarget,
  ToolAssertion,
} from '@perfportal/core';
import { clampPercentile } from './percentile.js';
import type { StatRollup } from './rollup.js';

/**
 * Appendix A G-05 — the tool's own assertions, rendered and RE-EVALUATED.
 *
 * ═══ THE RESULT FILE CARRIES DEFINITIONS ONLY ═══
 *
 * There is no actual value and no pass/fail in a Gatling log: its report
 * recomputes both at render time from the same events. So does this — against
 * this platform's own statistics, which is what makes the verdict *better*
 * than the report rather than merely equal to it. Gatling's percentiles are
 * histogram estimates (PRD §A.9 F-6, measured 9.47% low on the p99 of a real
 * run, reporting a value that occurs nowhere in the data); the sketch behind
 * `StatRollup` answers the same question within 1%, against the true
 * distribution.
 *
 * ═══ THE WORDING IS NOT INVENTED ═══
 *
 * Every phrase `describe()` produces was read off a generated report — the
 * corpus run in `fixtures/gatling-3.15.1.2/assertion-corpus/`, whose 29
 * assertions cover every Path x Target x Condition the DSL offers. G-05's
 * tolerance is "exact", and an expression we phrased ourselves would fail it
 * on wording while being right about the numbers.
 */

export type ToolAssertionOutcome = 'passed' | 'failed' | 'not_applicable';

export interface EvaluatedToolAssertion {
  /** The definition, as the tool declared it. */
  readonly assertion: ToolAssertion;
  /**
   * The assertion in prose, in the tool's own words — G-05's "expression"
   * column.
   */
  readonly expression: string;
  /** Null when nothing could be measured; see `not_applicable`. */
  readonly actualValue: number | null;
  /**
   * `not_applicable` when the path matched no statistics at all. Gatling calls
   * that a failure and prints `Could not find stats matching assertion path`;
   * this platform reports it as its own state, because "the endpoint you named
   * does not exist" and "the endpoint is too slow" are different facts a
   * reader acts on differently (PRD §22.1 tenet 6).
   */
  readonly outcome: ToolAssertionOutcome;
}

/**
 * Scala's `Double.toString`, which is what the report's numbers are formatted
 * with: a whole number keeps its `.0`, so `30000` prints as `30000.0` and
 * `99.9` prints unchanged. `String(30000)` in JS gives `30000`, which would
 * differ from the report on every integer threshold.
 */
function num(v: number): string {
  return Number.isInteger(v) ? `${v}.0` : String(v);
}

/** `50th`, `75th`, `99.9th` — the report's own ordinal for a percentile rank. */
function rank(v: number): string {
  return `${num(v).replace(/\.0$/, '')}th`;
}

const STATUS_NOUN: Record<AssertionStatus, string> = {
  all: 'all events',
  ok: 'successful events',
  ko: 'failed events',
};

function describeTarget(target: AssertionTarget): string {
  switch (target.kind) {
    case 'count':
      return `count of ${STATUS_NOUN[target.status]}`;
    case 'percent':
      return `percentage of ${STATUS_NOUN[target.status]}`;
    case 'meanRequestsPerSecond':
      // No "of" — the report reads "Global: mean requests per second is …".
      return 'mean requests per second';
    case 'responseTime':
      switch (target.stat) {
        case 'min': return 'min of response time';
        case 'max': return 'max of response time';
        case 'mean': return 'mean of response time';
        case 'stddev': return 'standard deviation of response time';
        case 'percentile': return `${rank(target.rank ?? 0)} percentile of response time`;
      }
  }
}

function describeCondition(condition: AssertionCondition): string {
  switch (condition.kind) {
    case 'lt': return `is less than ${num(condition.value)}`;
    case 'lte': return `is less than or equal to ${num(condition.value)}`;
    case 'gt': return `is greater than ${num(condition.value)}`;
    case 'gte': return `is greater than or equal to ${num(condition.value)}`;
    case 'is': return `is ${num(condition.value)}`;
    case 'between':
      return `is between ${num(condition.lo)} and ${num(condition.hi)}${
        condition.inclusive ? ' inclusive' : ''
      }`;
    case 'in':
      return `is in List(${condition.values.map(num).join(', ')})`;
  }
}

/** One assertion in prose, given the name its path resolved to. */
export function describe(assertion: ToolAssertion, pathLabel: string): string {
  return `${pathLabel}: ${describeTarget(assertion.target)} ${describeCondition(assertion.condition)}`;
}

function holds(actual: number, condition: AssertionCondition): boolean {
  switch (condition.kind) {
    case 'lt': return actual < condition.value;
    case 'lte': return actual <= condition.value;
    case 'gt': return actual > condition.value;
    case 'gte': return actual >= condition.value;
    case 'is': return actual === condition.value;
    case 'between':
      return condition.inclusive
        ? actual >= condition.lo && actual <= condition.hi
        : actual > condition.lo && actual < condition.hi;
    case 'in': return condition.values.includes(actual);
  }
}

/**
 * The measured value for a target, off one statistics row.
 *
 * Returns null where the row cannot answer — a percentile of a row whose
 * sketch is empty, say — so the caller reports `not_applicable` rather than
 * asserting against a zero nobody measured.
 */
function measure(target: AssertionTarget, row: StatRollup): number | null {
  switch (target.kind) {
    case 'count':
      return target.status === 'all' ? row.count
        : target.status === 'ok' ? row.okCount
        : row.koCount;
    case 'percent': {
      if (row.count === 0) return null;
      const n = target.status === 'all' ? row.count
        : target.status === 'ok' ? row.okCount
        : row.koCount;
      return (n / row.count) * 100;
    }
    case 'meanRequestsPerSecond':
      return row.throughputRps;
    case 'responseTime':
      if (row.count === 0) return null;
      switch (target.stat) {
        case 'min': return row.minMs;
        case 'max': return row.maxMs;
        case 'mean': return row.meanMs;
        case 'stddev': return row.stddevMs;
        // ARBITRARY RANKS ARE AVAILABLE because the sketch is stored, not just
        // the four projected columns: `percentile(99.9)` is answerable even
        // though 99.9 is not one of the per-bucket bands. The sketch spans both
        // statuses, which is the same population Gatling's own assertion reads.
        //
        // CLAMPED, like every other assembler that reports an estimate beside
        // the extremes it was taken from. `row.percentiles` is already clamped
        // by `RollupBuilder.finish`; this branch re-derives from the sketch to
        // reach ranks that projection does not carry, and re-derives the raw
        // estimate with it. Measured on the reference run, the two disagreed:
        //
        //   row.percentiles.p99   2503                  <- the statistics table
        //   sketch.quantile(.99)  2515.4601126102525    <- this verdict
        //   row.maxMs             2503                  <- `case 'max'`, 3 lines up
        //
        // so `99th percentile of response time is less than 2510.0` was
        // reported FAILED on a run whose slowest request was 2503 ms and whose
        // true p99 is 2501 — a verdict this module's own docstring says is
        // BETTER than the tool's, disagreeing with the tool by being worse.
        case 'percentile':
          return clampPercentile(row.sketch.quantile((target.rank ?? 0) / 100), row);
      }
  }
}

/**
 * The statistics row a path names, or null when it names nothing.
 *
 * `forAll` is excluded from the parameter type rather than handled: it does not
 * name ONE row, it ranges over every request, and the caller expands it before
 * getting here. Encoding that in the type means a future caller cannot pass one
 * by accident and silently get `null`.
 */
function rowFor(
  path: Exclude<AssertionPath, { kind: 'forAll' }>,
  byKey: Map<string, StatRollup>,
): StatRollup | null {
  if (path.kind === 'global') return byKey.get('run\0') ?? null;
  const name = path.parts.join('/');
  // A path can name a request or a group, and the tool does not say which.
  // REQUEST FIRST, and the order is load-bearing: a name that is both
  // resolves to the request, which is what Gatling itself does.
  return byKey.get(`request\0${name}`) ?? byKey.get(`group\0${name}`) ?? null;
}

/**
 * A row's name as the TOOL writes it in an assertion: `Cart / Add To Cart`.
 *
 * The engine keys a row by `[...groups, name].join('/')` (`engine.ts`), so the
 * hierarchy arrives here already flattened into one string, and Gatling renders
 * that same hierarchy with SPACES around the separator. G-05's tolerance is
 * exact on the expression, because a reader holding the two reports side by
 * side is comparing strings.
 *
 * THE `details` BRANCH ALREADY DID THIS (`parts.join(' / ')`); `forAll` did
 * not, labelling each expanded row from `row.name` directly. Nothing caught
 * it: the assertion corpus has one request and NO groups, so it has no
 * hierarchy to space. Measured against a real run — Gatling wrote
 * `Cart / Add To Cart` where this wrote `Cart/Add To Cart`.
 *
 * SPLITTING ON `/` INHERITS A DECISION THIS CODEBASE HAS ALREADY MADE rather
 * than inventing one. A request genuinely named `GET /catalog` inside a group
 * is indistinguishable from nesting at this layer — but that is already true
 * of `rowFor` above, and of `buildTree`, which parents rows by `/`-prefix and
 * draws exactly that tree on the statistics table. Re-spacing here agrees with
 * what the rest of the product shows the same reader.
 */
const assertionLabel = (rowName: string): string => rowName.split('/').join(' / ');

/**
 * Evaluates every assertion against a run's statistics.
 *
 * ═══ `forAll` EXPANDS, IT DOES NOT AGGREGATE ═══
 *
 * Gatling's report renders one ROW PER REQUEST for a `forAll` assertion, named
 * after that request — verified in the corpus, where `forAll()...lt(2)` came
 * back as `Session: max of response time is less than 2.0` rather than as
 * anything mentioning "all requests". Reproduced here, so the row set matches:
 * a `forAll` over seven endpoints is seven rows, each independently pass/fail.
 */
export function evaluateToolAssertions(
  assertions: readonly ToolAssertion[],
  stats: readonly StatRollup[],
): EvaluatedToolAssertion[] {
  /* ═══ TWO FAMILIES, BECAUSE A GROUP KEEPS ITS TIMINGS IN A DIFFERENT ONE ═══
   *
   * This filtered to `response_time` alone, and said the group families were
   * "a different measure that no Gatling assertion can name". Half right — and
   * the wrong half made `rowFor`'s `group` lookup UNREACHABLE, because
   * `engine.ts` files a group's timings only under `group_cumulated` and
   * `group_duration`, never under `response_time`. So every assertion naming a
   * group resolved to nothing and reported `not_applicable`, on every run,
   * while reading as configured protection.
   *
   * `group_cumulated` is the right family, and that is MEASURED rather than
   * reasoned. Gatling itself RESOLVES the path: a real run declaring
   * `details("Cart").responseTime().max()` reported `actual : 193.0` instead
   * of "Could not find stats matching assertion path List(Cart)", and its
   * group page reports Max 193 — this repo's `group_cumulated` row to the
   * millisecond. `group_duration` on the same run sits ~80ms higher
   * throughout, that being the Cart group's own pause between its two
   * requests. They are PRD GR-01 and GR-02, and only the first is what the
   * tool means by a group's response time.
   *
   * The wire format agrees structurally: there is exactly one RESPONSE_TIME
   * target tag and no group-duration variant (`plugin-gatling/assertions.ts`),
   * so the family can only be chosen by the PATH — which is what this does.
   */
  const responseTime = stats.filter((s) => s.family === 'response_time');
  const groups = stats.filter((s) => s.family === 'group_cumulated' && s.scope === 'group');
  /* `\0` AS THE KEY SEPARATOR, WRITTEN AS AN ESCAPE. It was a literal NUL
     BYTE in the source here and in all three `rowFor` lookups — invisible in
     an editor, in a diff, and in a review, so retyping any one of these lines
     as a space silently stops every lookup matching. Same bytes at runtime,
     and the choice is a good one: a NUL cannot occur in a request or group
     name, so `run`/`request`/`group` can never collide with one. */
  const byKey = new Map(
    [...responseTime, ...groups].map((r) => [`${r.scope}\0${r.name}`, r] as const),
  );
  /* REQUESTS ONLY, and this is the half a fix here could widen by accident.
     `forAll` ranges over requests and never over groups — measured on a run
     with 7 requests and 3 groups, which expands to exactly 7 rows. The corpus
     answered the same question from a run with one request and NO groups,
     which cannot tell the two apart. */
  const requests = responseTime.filter((r) => r.scope === 'request');

  const out: EvaluatedToolAssertion[] = [];

  const evaluate = (
    assertion: ToolAssertion,
    label: string,
    row: StatRollup | null,
    /** The path's parts, for the not-found message. */
    parts: readonly string[],
  ): void => {
    if (row === null) {
      out.push({
        assertion,
        // The tool's own wording for a path that matched nothing, so a reader
        // comparing the two reports sees the same sentence.
        expression: `Could not find stats matching assertion path List(${parts.join(', ')})`,
        actualValue: null,
        outcome: 'not_applicable',
      });
      return;
    }
    const actual = measure(assertion.target, row);
    out.push({
      assertion,
      expression: describe(assertion, label),
      actualValue: actual,
      outcome: actual === null ? 'not_applicable'
        : holds(actual, assertion.condition) ? 'passed'
        : 'failed',
    });
  };

  for (const assertion of assertions) {
    const path = assertion.path;
    if (path.kind === 'forAll') {
      for (const row of requests) {
        evaluate(assertion, assertionLabel(row.name), row, [row.name]);
      }
      // A run with no requests at all yields no rows, which is honest: there
      // was nothing for "every request" to range over.
      continue;
    }
    const parts = path.kind === 'details' ? path.parts : ['Global'];
    const label = path.kind === 'global' ? 'Global' : path.parts.join(' / ');
    evaluate(assertion, label, rowFor(path, byKey), parts);
  }

  return out;
}
