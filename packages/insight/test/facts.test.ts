import type { ToolAssertion } from '@perfportal/contracts';
import type { StoredFigures } from '@perfportal/persistence';
import { describe, expect, it } from 'vitest';
import {
  buildRunFacts,
  FACTS_VERSION,
  type Fact,
  type FactsFigures,
  type FactsFigureSeriesBucket,
  type FactsFigureStat,
  type FactsInput,
  type RunFacts,
} from '../src/facts.js';
import { formatCount, formatElapsed, formatMs, formatPercent, formatRate } from '../src/format.js';

/**
 * ═══ THE FIXTURE IS GATLING ENTERPRISE'S OWN RUN, AS FAR AS IT WAS MEASURED ═══
 *
 * docs/superpowers/research/2026-11-02-ge-ai-run-analysis/README.md records
 * the run GE's analysis got wrong: 1,724 requests, 289 KO (16.76%), 18.95/s,
 * p95 321 / p99 2383 / max 4159 / mean 150 / SD 387 ms; Place Order 172/172 KO
 * with p95 195 / p99 2143 / max 2191; Add To Cart holding the run's max (4159)
 * and p99 (4095) with NO failures; errors 170 / 60 / 31 / 28 / 16. Its three
 * mistakes are what these cases pin: it added Place Order's 172 to the 401s
 * (342 against 289), blamed the tail on the request that failed rather than
 * the one that was slow, and read the final drain as a failure point.
 *
 * The four other requests' counts are invented to make the real totals sum.
 */

/** A request row; anything not given is a plausible healthy value. */
function req(name: string, o: Partial<FactsFigureStat> & { count: number; koCount: number }): FactsFigureStat {
  return {
    scope: 'request',
    name,
    family: 'response_time',
    okCount: o.count - o.koCount,
    errorRate: o.count === 0 ? 0 : o.koCount / o.count,
    maxMs: 400,
    meanMs: 120,
    stddevMs: 50,
    throughputRps: o.count / 91,
    percentiles: { p50: 100, p95: 250, p99: 350 },
    ...o,
  };
}

const RUN_ROW: FactsFigureStat = {
  scope: 'run',
  name: '',
  family: 'response_time',
  count: 1724,
  okCount: 1435,
  koCount: 289,
  errorRate: 289 / 1724,
  maxMs: 4159,
  meanMs: 150.2,
  stddevMs: 387.4,
  throughputRps: 18.945054945054945,
  percentiles: { p50: 97, p95: 321, p99: 2383.4 },
};

const REQUESTS: FactsFigureStat[] = [
  req('Session', { count: 330, koCount: 60 }),
  req('Search', { count: 400, koCount: 30 }),
  req('List Products', { count: 300, koCount: 27 }),
  req('Add To Cart', { count: 330, koCount: 0, maxMs: 4159, percentiles: { p50: 120, p95: 555, p99: 4095 } }),
  req('Get Product', { count: 192, koCount: 0 }),
  req('Place Order', { count: 172, koCount: 172, maxMs: 2191, percentiles: { p50: 90, p95: 195, p99: 2143 } }),
];

const ERRORS = [
  { scope: 'run', name: '', message: 'status.find.is(200), but actually found 401', isOther: false, count: 170 },
  { scope: 'run', name: '', message: 'status.find.is(200), but actually found 404', isOther: false, count: 60 },
  { scope: 'run', name: '', message: 'status.find.is(200), but actually found 403', isOther: false, count: 31 },
  { scope: 'run', name: '', message: 'status.find.in(200,201), found 403', isOther: false, count: 28 },
  { scope: 'run', name: '', message: "No attribute named 'sessionId' is defined", isOther: false, count: 16 },
  // A request-scoped copy of the first: the Errors table reads run scope only,
  // and counting this one too would double every share.
  { scope: 'request', name: 'Place Order', message: 'status.find.is(200), but actually found 401', isOther: false, count: 40 },
];

/** One run-scope series bucket a second wide. */
function bucket(startOffsetMs: number, okCount: number, koCount: number): FactsFigureSeriesBucket {
  return { scope: 'run', name: '', family: 'response_time', startOffsetMs, okCount, koCount };
}

/** Users starting every second until `lastStartMs`, then only ending. */
function users(lastStartMs: number, endMs: number) {
  const rows = [];
  for (let t = 0; t <= endMs; t += 1000) {
    rows.push({ scenario: 'Shop', startOffsetMs: t, started: t <= lastStartMs ? 1 : 0, ended: 0, maxConcurrent: 15 });
  }
  return rows;
}

function figures(over: Partial<FactsFigures> = {}): FactsFigures {
  return {
    stats: [RUN_ROW, ...REQUESTS],
    seriesBuckets: [bucket(0, 19, 2), bucket(1000, 18, 3)],
    errors: ERRORS,
    userBuckets: users(85_000, 90_000),
    ...over,
  };
}

function input(over: Partial<FactsInput> = {}): FactsInput {
  return {
    run: { simulation: 'example.BasicSimulation', status: 'complete', durationMs: 91_400, activityMs: 90_800 },
    figures: figures(),
    platformAssertions: [],
    toolAssertions: [],
    ...over,
  };
}

function byId(facts: RunFacts): Map<string, Fact> {
  return new Map(facts.facts.map((f) => [f.id, f]));
}

function fact(facts: RunFacts, id: string): Fact {
  const f = byId(facts).get(id);
  if (f === undefined) throw new Error(`no fact ${id}; have ${facts.facts.map((x) => x.id).join(', ')}`);
  return f;
}

/** The request facts' indices, by request name. */
function requestIndex(facts: RunFacts): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of facts.facts) {
    const m = /^request\.(\d+)\.name$/.exec(f.id);
    if (m !== null && f.text !== null) out.set(f.text, m[1]!);
  }
  return out;
}

describe('buildRunFacts', () => {
  it('stamps its version', () => {
    expect(buildRunFacts(input()).version).toBe(FACTS_VERSION);
  });

  it('accepts persistence’s stored figures as they are read', () => {
    // A type-level check: the worker hands `readStoredFigures`' result
    // straight in, so persistence's type must be assignable to the one this
    // package declares for itself (it may not import persistence in src).
    const stored = {} as StoredFigures;
    const accepted: FactsFigures = stored;
    expect(accepted).toBe(stored);
  });

  it('partitions KO by request so the parts sum to the run’s KO', () => {
    const facts = buildRunFacts(input());
    const parts = facts.facts.filter((f) => f.id.startsWith('derived.koByRequest.'));
    const sum = parts.reduce((s, f) => s + (f.value ?? 0), 0);
    expect(sum).toBe(fact(facts, 'run.ko').value);
    expect(sum).toBe(289);
    // Largest first, and Place Order's is its own 172 — not added to the 401s.
    expect(parts[0]).toMatchObject({ text: 'Place Order', value: 172, display: '172' });
    // A request that failed nothing is not a part of the KO.
    expect(parts.map((f) => f.text)).not.toContain('Add To Cart');
  });

  it('names a request that failed every time', () => {
    const facts = buildRunFacts(input());
    expect(fact(facts, 'derived.alwaysFailed')).toMatchObject({ text: 'Place Order', value: 1, display: '1' });
  });

  it('emits no alwaysFailed fact when every request succeeded at least once', () => {
    const facts = buildRunFacts(
      input({ figures: figures({ stats: [RUN_ROW, ...REQUESTS.filter((r) => r.name !== 'Place Order')] }) }),
    );
    expect(byId(facts).has('derived.alwaysFailed')).toBe(false);
  });

  it('names the tail’s owner by the run maximum, not by failures', () => {
    const facts = buildRunFacts(input());
    expect(fact(facts, 'derived.tailOwner')).toMatchObject({ text: 'Add To Cart', value: 4159, display: '4,159 ms' });
    expect(fact(facts, 'derived.p99Owner')).toMatchObject({ text: 'Add To Cart', value: 4095, display: '4,095 ms' });
    expect(fact(facts, 'derived.slowestP95')).toMatchObject({ text: 'Add To Cart', value: 555, display: '555 ms' });
    // And the request that failed every time keeps its own, smaller tail.
    const placeOrder = requestIndex(facts).get('Place Order');
    expect(fact(facts, `request.${placeOrder}.max`).display).toBe('2,191 ms');
    expect(fact(facts, `request.${placeOrder}.ko`).value).toBe(172);
  });

  it('says an OK drop happened only in the final drain', () => {
    // The last user starts at 85 s; OK reads zero at 88–90 s, when the only
    // requests left are each user's last step — Place Order.
    const series = [bucket(0, 19, 2), bucket(85_000, 18, 3), bucket(88_000, 0, 19), bucket(89_000, 0, 19), bucket(90_000, 0, 12)];
    const facts = buildRunFacts(input({ figures: figures({ seriesBuckets: series }) }));
    expect(fact(facts, 'derived.okZero')).toMatchObject({
      text: 'only in the final drain',
      display: '00:01:28',
      value: 88_000,
    });
  });

  it('says an OK drop happened during the run', () => {
    // Zero OK at 40 s while users are still starting until 85 s — the run
    // proper, even though OK also reads zero in the drain afterwards.
    const series = [bucket(0, 19, 2), bucket(40_000, 0, 20), bucket(41_000, 18, 2), bucket(89_000, 0, 19)];
    const facts = buildRunFacts(input({ figures: figures({ seriesBuckets: series }) }));
    expect(fact(facts, 'derived.okZero')).toMatchObject({ text: 'during the run', display: '00:00:40', value: 40_000 });
  });

  it('emits no okZero fact when OK never fell to zero', () => {
    // A bucket with no responses at all is not OK falling to zero: nothing
    // was answered, so nothing failed.
    const series = [bucket(0, 19, 2), bucket(1000, 0, 0), bucket(2000, 18, 3)];
    const facts = buildRunFacts(input({ figures: figures({ seriesBuckets: series }) }));
    expect(byId(facts).has('derived.okZero')).toBe(false);
  });

  it('reads only the run-scope series for okZero', () => {
    // Place Order's own series is zero OK throughout; the run's is not.
    const series = [
      bucket(0, 19, 2),
      { scope: 'request', name: 'Place Order', family: 'response_time', startOffsetMs: 10_000, okCount: 0, koCount: 4 },
    ];
    const facts = buildRunFacts(input({ figures: figures({ seriesBuckets: series }) }));
    expect(byId(facts).has('derived.okZero')).toBe(false);
  });

  it('shares errors of recorded errors, which may exceed KO', () => {
    const facts = buildRunFacts(input());
    expect(fact(facts, 'errors.total')).toMatchObject({ value: 305, display: '305' });
    expect(fact(facts, 'errors.total').value).toBeGreaterThan(fact(facts, 'run.ko').value!);
    expect(fact(facts, 'error.0.message').text).toBe('status.find.is(200), but actually found 401');
    expect(fact(facts, 'error.0.count')).toMatchObject({ value: 170, display: '170' });
    // 170 of 305 recorded errors — never 170 of 1,724 requests (GE's 9.86%).
    expect(fact(facts, 'error.0.share').value).toBeCloseTo((170 * 100) / 305, 10);
    expect(fact(facts, 'error.0.share').display).toBe('55.74%');
    expect(fact(facts, 'error.4.count').value).toBe(16);
    expect(byId(facts).has('error.5.message')).toBe(false);
  });

  it('labels the folded remainder as other errors', () => {
    const errors = [
      { scope: 'run', name: '', message: 'boom', isOther: false, count: 3 },
      { scope: 'run', name: '', message: '', isOther: true, count: 7 },
    ];
    const facts = buildRunFacts(input({ figures: figures({ errors }) }));
    // The remainder is a different kind of row, so it comes last however
    // large it is, and it reads as the Errors table reads it.
    expect(fact(facts, 'error.0.message').text).toBe('boom');
    expect(fact(facts, 'error.1.message').text).toBe('Other errors');
    expect(fact(facts, 'error.1.share').display).toBe('70.00%');
  });

  it('bounds per-request facts on a wide run', () => {
    const wide: FactsFigureStat[] = [];
    for (let i = 0; i < 300; i += 1) {
      wide.push(req(`ep-${String(i).padStart(3, '0')}`, { count: 1000 - i, koCount: 0 }));
    }
    // The run's tail and failures live in requests far down the count order.
    wide[250] = req('ep-250', { count: 750, koCount: 0, maxMs: 9000, percentiles: { p50: 1, p95: 2, p99: 3 } });
    wide[260] = req('ep-260', { count: 740, koCount: 740 });
    const run = { ...RUN_ROW, maxMs: 9000 };
    const facts = buildRunFacts(input({ figures: figures({ stats: [run, ...wide] }) }));
    const names = [...requestIndex(facts).keys()];

    const derivedNames = new Set(
      facts.facts.filter((f) => f.id.startsWith('derived.') && f.text !== null).flatMap((f) => f.text!.split(', ')),
    );
    expect(names.length).toBeLessThanOrEqual(20 + derivedNames.size);
    expect(names.length).toBeLessThan(30);
    // The top twenty by count, and every request a derived fact names.
    expect(names).toContain('ep-000');
    expect(names).toContain('ep-019');
    expect(names).not.toContain('ep-020');
    expect(names).toContain('ep-250');
    expect(names).toContain('ep-260');
    expect(fact(facts, 'derived.tailOwner').text).toBe('ep-250');
  });

  it('displays with the page’s rounding', () => {
    const facts = buildRunFacts(input());
    expect(fact(facts, 'run.errorRate')).toMatchObject({ display: '16.76%' });
    expect(fact(facts, 'run.errorRate').value).toBeCloseTo((289 * 100) / 1724, 12);
    expect(fact(facts, 'run.p99')).toMatchObject({ display: '2,383 ms', value: 2383.4 });
    expect(fact(facts, 'run.throughput')).toMatchObject({ display: '18.95/s', value: 18.945054945054945 });
    expect(fact(facts, 'run.requests')).toMatchObject({ display: '1,724', value: 1724 });
    expect(fact(facts, 'run.ok')).toMatchObject({ display: '1,435', value: 1435 });
    expect(fact(facts, 'run.mean')).toMatchObject({ display: '150 ms', value: 150.2 });
    expect(fact(facts, 'run.stddev')).toMatchObject({ display: '387 ms' });
    expect(fact(facts, 'run.max')).toMatchObject({ display: '4,159 ms' });
    expect(fact(facts, 'run.peakUsers')).toMatchObject({ display: '15', value: 15 });
    // The Duration chip's span: activity, the page's own choice over durationMs.
    expect(fact(facts, 'run.duration')).toMatchObject({ value: 90_800, display: '91s' });
  });

  it('formats as the facts are displayed', () => {
    expect(formatMs(2383.4)).toBe('2,383 ms');
    expect(formatMs(179.5)).toBe('180 ms');
    expect(formatCount(1724)).toBe('1,724');
    expect(formatPercent(289 / 1724)).toBe('16.76%');
    expect(formatRate(18.945054945054945)).toBe('18.95/s');
    expect(formatElapsed(88_999)).toBe('00:01:28');
    expect(formatElapsed(26 * 3_600_000)).toBe('26:00:00');
  });

  it('states each assertion with its outcome and actual', () => {
    const tool: ToolAssertion[] = [
      {
        expression: 'Global: max of response time is less than 30000.0',
        assertion: {
          path: { kind: 'global' },
          target: { kind: 'responseTime', stat: 'max' },
          condition: { kind: 'lt', value: 30000 },
        },
        actualValue: 4159,
        outcome: 'passed',
      },
      {
        expression: 'Global: percentage of successful events is greater than 60.0',
        assertion: { path: { kind: 'global' }, target: { kind: 'percent', status: 'ok' }, condition: { kind: 'gt', value: 60 } },
        actualValue: 83.23665893271462,
        outcome: 'passed',
      },
      {
        expression: 'Place Order: count of failed events is less than 1.0',
        assertion: {
          path: { kind: 'details', parts: ['Place Order'] },
          target: { kind: 'count', status: 'ko' },
          condition: { kind: 'lt', value: 1 },
        },
        actualValue: 172,
        outcome: 'failed',
      },
      { expression: 'Nowhere: max of response time is less than 1.0', actualValue: null, outcome: 'not_applicable' },
    ];
    const platform = [{ description: 'Whole-run p95 response time', outcome: 'passed', actualDisplay: '321 ms' }];
    const facts = buildRunFacts(input({ toolAssertions: tool, platformAssertions: platform }));

    expect(fact(facts, 'assertion.platform.0')).toMatchObject({
      text: 'Whole-run p95 response time',
      display: 'passed · 321 ms',
    });
    expect(fact(facts, 'assertion.tool.0')).toMatchObject({ display: 'passed · 4,159 ms', value: 4159 });
    // Never "83.23665893271462%": the raw value stays in `value`.
    expect(fact(facts, 'assertion.tool.1')).toMatchObject({ display: 'passed · 83.24%', value: 83.23665893271462 });
    expect(fact(facts, 'assertion.tool.2')).toMatchObject({
      text: 'Place Order: count of failed events is less than 1.0',
      display: 'failed · 172',
      value: 172,
    });
    expect(fact(facts, 'assertion.tool.3')).toMatchObject({ display: 'not applicable', value: null });
  });

  it('takes a group’s figures from its cumulated row, as the statistics table does', () => {
    const groupRow = (family: string, maxMs: number): FactsFigureStat => ({
      ...req('Cart', { count: 85, koCount: 0, maxMs }),
      scope: 'group',
      family,
    });
    const facts = buildRunFacts(
      input({ figures: figures({ stats: [RUN_ROW, ...REQUESTS, groupRow('group_duration', 264), groupRow('group_cumulated', 179)] }) }),
    );
    expect(fact(facts, 'group.0.name').text).toBe('Cart');
    expect(fact(facts, 'group.0.max').display).toBe('179 ms');
    expect(byId(facts).has('group.1.name')).toBe(false);
  });

  it('still returns what it can without a run-scope row', () => {
    const facts = buildRunFacts(input({ figures: figures({ stats: REQUESTS }) }));
    expect(byId(facts).has('run.requests')).toBe(false);
    expect(fact(facts, 'derived.alwaysFailed').text).toBe('Place Order');
    expect(byId(facts).has('derived.tailOwner')).toBe(false);
  });

  it('gives every fact a unique id and a display', () => {
    const facts = buildRunFacts(input());
    const ids = facts.facts.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const f of facts.facts) expect(f.display.length).toBeGreaterThan(0);
  });
});
