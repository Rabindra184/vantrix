import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseSimulationLog } from '@perfportal/plugin-gatling';
import { runEngine } from '../src/engine.js';

/**
 * ═══ A GATLING ASSERTION ON A GROUP HAS NEVER BEEN EVALUABLE ═══
 *
 * `evaluateToolAssertions` filtered its rows to `family === 'response_time'`
 * before building the lookup map. `engine.ts` files a group's timings ONLY
 * under `group_cumulated` and `group_duration` and never under
 * `response_time` — so `rowFor`'s `byKey.get('group ' + name)` could not
 * match, and every group-scoped assertion reported `not_applicable` on every
 * run, forever, while looking like configured protection.
 *
 * ═══ WHY NOTHING IN THIS REPO CAUGHT IT ═══
 *
 * Three fixtures, and each misses it for a different reason. The assertion
 * corpus declares no group at all (its only non-request path is
 * `details("A","B")`, which names nothing BY DESIGN). The reference simulation
 * has three groups and asserts only on `details("Search")`, a request. And
 * every hand-built event in `tool-assertions.test.ts` sets `groups: []`. The
 * branch had never been executed by any test.
 *
 * ═══ WHAT THIS FIXTURE IS, AND WHY IT IS A REAL LOG ═══
 *
 * `fixtures/gatling-3.15.1.2/group-assertions/` is a REAL Gatling 3.15.1.2 run
 * of `GroupAssertions.kt` — the parity simulation plus eight probe assertions
 * over its groups. Both sides of this test come out of the tool: the
 * definitions are decoded from that log's own header, the statistics are
 * computed from that same log's records, and the expected wording is
 * transcribed from the report Gatling printed for that run
 * (`gatling-report-assertions.txt`, kept beside it).
 *
 * That matters because the cheap version of this test — hand-build a group
 * event, hand-build a `details` path naming it — supplies both sides of the
 * join and proves only that the evaluator agrees with itself. CLAUDE.md
 * records what that costs: `test-entity`'s integration case drove
 * `resolveTestId` with the slug the test itself supplied, every gate was
 * green, and the feature had never worked on three of its four paths.
 */

const LOG = 'fixtures/gatling-3.15.1.2/group-assertions/simulation.log';
const events = [...parseSimulationLog(readFileSync(LOG))];

/**
 * THE ENGINE'S OWN OUTPUT, not a separate `evaluateToolAssertions` call.
 * `LiveEngine.snapshot()` evaluates the declared assertions against the
 * rollups it just built, so this is the production path end to end — decode,
 * aggregate, judge — rather than the evaluator driven in isolation with
 * statistics a test chose for it.
 */
const { stats, toolAssertions } = runEngine(events);
const evaluated = () => toolAssertions;

/** One statistics row, by scope/name/family — the shape `rowFor` looks up. */
const row = (scope: string, name: string, family: string) =>
  stats.find((s) => s.scope === scope && s.name === name && s.family === family);

describe('tool assertions — a path that names a GROUP', () => {
  /**
   * THE FIXTURE HAS TO CARRY WHAT THIS FILE CLAIMS, or every assertion below
   * is vacuous. A log whose header lost its group assertions would make the
   * "resolves" cases pass by finding nothing to check.
   */
  it('carries real group assertions and real group rows', () => {
    const paths = toolAssertions.map(({ assertion: a }) =>
      a.path.kind === 'details' ? a.path.parts.join('/') : a.path.kind,
    );
    expect(paths).toContain('Cart');
    expect(paths).toContain('Catalog/Recommendations');
    // And the engine really does file the group away from `response_time`,
    // which is the whole mechanism.
    expect(row('group', 'Cart', 'group_cumulated')).toBeDefined();
    expect(row('group', 'Cart', 'response_time')).toBeUndefined();
  });

  /**
   * THE DEFECT, STATED AS THE BEHAVIOUR IT BROKE. `not_applicable` means "the
   * path named something this run has no data for" — and this run has 85 Cart
   * groups. Reporting it as unmeasurable is a false statement about the run.
   */
  it('judges a group assertion instead of reporting it unmeasurable', () => {
    const cart = evaluated().filter((e) => e.expression.startsWith('Cart: max'));
    expect(cart.length).toBeGreaterThan(0);
    for (const e of cart) {
      expect(e.outcome).not.toBe('not_applicable');
      expect(e.actualValue).not.toBeNull();
    }
  });

  /**
   * ═══ WHICH MEASURE, AND IT IS DERIVED RATHER THAN WRITTEN DOWN ═══
   *
   * A group keeps two full statistic sets (PRD GR-01 cumulated response time,
   * GR-02 duration) and they diverge by the group's own internal pauses. The
   * expectation is this fixture's own cumulated row, so a re-capture moves the
   * test with the data instead of breaking it.
   *
   * Measured against the tool for this exact run: Gatling reported
   * `Cart: max of response time is less than 150.0 : false (actual : 193.0)`,
   * and its group page reports Max 193 — the cumulated row. The duration row
   * is ~80ms higher throughout, that being the Cart group's own pause between
   * its two requests.
   */
  it('reads a group as CUMULATED response time, not duration', () => {
    const cumulated = row('group', 'Cart', 'group_cumulated');
    const duration = row('group', 'Cart', 'group_duration');
    expect(cumulated).toBeDefined();
    expect(duration).toBeDefined();
    // The two really are different, or this case proves nothing.
    expect(cumulated!.maxMs).not.toBe(duration!.maxMs);

    const cart = evaluated().find((e) => e.expression.startsWith('Cart: max'));
    expect(cart?.actualValue).toBe(cumulated!.maxMs);
  });

  /** The non-responseTime targets resolve on a group too — Gatling reported
   *  `Cart: count of all events ... (actual : 85.0)`, the group's own count. */
  it('answers a count target on a group from that group’s own rows', () => {
    const counted = evaluated().find((e) => e.expression.startsWith('Cart: count'));
    expect(counted?.outcome).not.toBe('not_applicable');
    expect(counted?.actualValue).toBe(row('group', 'Cart', 'group_cumulated')!.count);
  });

  /** A NESTED group is the multi-part path shape, and the one most likely to
   *  be got wrong by a fix that special-cases a single segment. */
  it('resolves a nested group path', () => {
    const nested = evaluated().find((e) =>
      e.expression.startsWith('Catalog / Recommendations: max'),
    );
    expect(nested).toBeDefined();
    expect(nested?.outcome).not.toBe('not_applicable');
    expect(nested?.actualValue).toBe(
      row('group', 'Catalog/Recommendations', 'group_cumulated')!.maxMs,
    );
  });

  /**
   * AND A REQUEST STILL WINS OVER A GROUP OF THE SAME NAME. `rowFor` tries
   * `request` first and the fix must not reorder that: a name that is both is
   * the request, which is what Gatling itself resolves.
   */
  it('still prefers a request over a group when a name could be either', () => {
    const search = evaluated().find((e) => e.expression.startsWith('Search: max'));
    expect(search?.actualValue).toBe(row('request', 'Search', 'response_time')!.maxMs);
  });
});

/* ======================================================================== *
 * THE WORDING, WHICH IS A SEPARATE DEFECT THE SAME RUN EXPOSED
 * ======================================================================== */

/**
 * G-05's tolerance is EXACT on the expression, because a reader holding this
 * report beside Gatling's own is comparing strings.
 *
 * `forAll()` expands to one row per request, and this evaluator labelled each
 * row `row.name` — which for a request inside groups is `Cart/Add To Cart`,
 * unspaced, because that is how the engine keys a row. Gatling writes
 * `Cart / Add To Cart`. The `details` branch already spaced it
 * (`parts.join(' / ')`); `forAll` did not.
 *
 * The assertion corpus could not catch this: it has one request and no groups,
 * so there is nothing to space.
 */
describe('tool assertions — forAll over grouped requests', () => {
  /** Transcribed from the report Gatling generated for THIS log — see
   *  `gatling-report-assertions.txt` beside the fixture. */
  const TOOL_FOR_ALL: readonly string[] = [
    'Catalog / List Products: max of response time is less than 100000.0',
    'Catalog / Product Detail: max of response time is less than 100000.0',
    'Catalog / Recommendations / Related Items: max of response time is less than 100000.0',
    'Search: max of response time is less than 100000.0',
    'Cart / Add To Cart: max of response time is less than 100000.0',
    'Cart / View Cart: max of response time is less than 100000.0',
    'Place Order: max of response time is less than 100000.0',
  ];

  it('renders a grouped request the way the tool does, with spaces', () => {
    const ours = evaluated()
      .map((e) => e.expression)
      .filter((x) => x.endsWith('max of response time is less than 100000.0'))
      .filter((x) => !x.startsWith('Cart:') && !x.startsWith('Catalog / Recommendations:'));
    expect(new Set(ours)).toEqual(new Set(TOOL_FOR_ALL));
  });

  /** AND forAll RANGES OVER REQUESTS ONLY. Measured on this run: 7 requests
   *  and 3 groups in, exactly 7 rows out, no bare `Cart` or `Catalog`. The
   *  corpus answered this from a run with one request and NO groups, which
   *  cannot tell the two apart — so a fix that added groups to the lookup
   *  could have silently widened it here. */
  it('does not expand forAll over groups', () => {
    const expanded = evaluated().filter((e) =>
      e.expression.endsWith('max of response time is less than 100000.0'),
    );
    // 7 forAll rows + the two explicit details() probes (Cart, nested Catalog).
    const bare = expanded.filter(
      (e) => e.expression.startsWith('Cart:') || e.expression.startsWith('Catalog / Recommendations:'),
    );
    expect(expanded.length - bare.length).toBe(7);
  });
});
