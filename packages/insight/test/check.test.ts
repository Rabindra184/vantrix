import type { AiAnalysisContent } from '@perfportal/contracts';
import { describe, expect, it } from 'vitest';
import { checkNumbers } from '../src/check.js';
import { buildRunFacts, type Fact, type FactsFigureStat, type FactsInput, type RunFacts } from '../src/facts.js';

/**
 * ═══ THE FIXTURE IS GATLING ENTERPRISE'S RUN, BUILT INTO REAL FACTS ═══
 *
 * The check is only worth what it is tested against, so the facts are built by
 * `buildRunFacts` from the run GE's analysis got wrong (see facts.test.ts and
 * docs/superpowers/research/2026-11-02-ge-ai-run-analysis/): 1,724 requests,
 * 289 KO (16.76%), p99 2383 ms, Place Order 172/172 KO, 170 401s. GE wrote
 * "172 Place Order failures plus 170 401s" — 342, a sum no page shows — and
 * "2.38s" for 2,383 ms. Both must be refused; a figure copied as the facts
 * write it must not be.
 */

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

function input(over: Partial<FactsInput> = {}): FactsInput {
  return {
    run: { simulation: 'example.BasicSimulation', status: 'complete', durationMs: 91_400, activityMs: 90_800 },
    figures: {
      stats: [
        RUN_ROW,
        req('Session', { count: 330, koCount: 60 }),
        req('Search', { count: 400, koCount: 30 }),
        req('List Products', { count: 300, koCount: 27 }),
        req('Add To Cart', { count: 330, koCount: 0, maxMs: 4159, percentiles: { p50: 120, p95: 555, p99: 4095 } }),
        req('Get Product 2', { count: 192, koCount: 0 }),
        req('Place Order', { count: 172, koCount: 172, maxMs: 2191, percentiles: { p50: 90, p95: 195, p99: 2143 } }),
      ],
      seriesBuckets: [],
      errors: [
        { scope: 'run', name: '', message: 'status.find.is(200), but actually found 401', isOther: false, count: 170 },
        { scope: 'run', name: '', message: 'status.find.in(200,201), found 403', isOther: false, count: 28 },
      ],
      userBuckets: [],
    },
    platformAssertions: [],
    toolAssertions: [],
    ...over,
  };
}

const FACTS = buildRunFacts(input());

/** An analysis whose every string is `line`, unless a section is overridden. */
function content(over: Partial<{ [K in keyof AiAnalysisContent]: Partial<AiAnalysisContent[K]> }> = {}): AiAnalysisContent {
  return {
    health: { headline: 'The run finished.', bullets: ['It ran.'], ...over.health },
    insights: {
      headline: 'Insights.',
      errors: [],
      assertions: [],
      injectionProfile: [],
      responseTimes: [],
      ...over.insights,
    },
    recommendations: { headline: 'Next.', bullets: ['Look closer.'], ...over.recommendations },
  };
}

/** One line in the health bullets, checked against `facts`. */
function check(line: string, facts: RunFacts = FACTS): string[] {
  return checkNumbers(content({ health: { bullets: [line] } }), facts);
}

function facts(...list: Fact[]): RunFacts {
  return { version: 1, facts: list };
}

describe('checkNumbers', () => {
  it('passes an analysis with no numbers in it', () => {
    expect(checkNumbers(content(), FACTS)).toEqual([]);
  });

  it('passes a display string copied verbatim', () => {
    expect(
      check('1,724 requests, 289 KO (16.76%) at 18.95/s; p99 2,383 ms against a max of 4,159 ms over 91s.'),
    ).toEqual([]);
  });

  it('passes a value rounded to two decimals', () => {
    // 289 / 1724 = 16.7633…%: written exactly, or to 0, 1 or 2 decimals.
    expect(check('An error rate of 16.76%, about 16.8%, roughly 17%.')).toEqual([]);
    expect(check('Throughput was 18.945054945054945 per second.')).toEqual([]);
    // 2,383.4 ms to 0 and 1 decimals, ungrouped as well as grouped.
    expect(check('p99 2383 ms, or 2383.4 ms, or 2,383.4 ms.')).toEqual([]);
    // A rounding the facts never make is not a rounding of the fact.
    expect(check('An error rate of 16.763%.')).toEqual(['16.763']);
  });

  it('passes digits inside a request name and inside an error message', () => {
    expect(check('Get Product 2 never failed.')).toEqual([]);
    expect(check('The 170 errors read "status.find.is(200), but actually found 401".')).toEqual([]);
    expect(check('Then status.find.in(200,201), found 403 — 28 times.')).toEqual([]);
    // The same digits out of their verbatim span trace to nothing.
    expect(check('There were 401 responses.')).toEqual(['401']);
  });

  it('passes P95 and p99', () => {
    expect(check('P95 is 321 ms and p99 is 2,383 ms; p50 97 ms.')).toEqual([]);
    // A rank the facts never state is refused, and so is one glued to a word.
    expect(check('p90 was fine.')).toEqual(['90']);
    expect(check('step95 failed.')).toEqual(['95']);
  });

  it('refuses an invented sum', () => {
    const sum = buildRunFacts(input());
    expect(sum.facts.some((f) => f.value === 342)).toBe(false);
    // "401s" has a duration's shape and is reported whole; a status code is no fact's value either way.
    expect(check('Place Order’s 172 failures plus 170 401s make 342 failures.', sum)).toEqual(['401s', '342']);
    expect(
      check(
        '342 failures',
        facts(
          { id: 'derived.koByRequest.0', label: 'KO of Place Order', display: '172', value: 172, text: 'Place Order' },
          { id: 'error.0.count', label: 'found 401: count', display: '170', value: 170, text: null },
        ),
      ),
    ).toEqual(['342']);
  });

  it('refuses a converted unit', () => {
    expect(check('The p99 was 2.38s.')).toEqual(['2.38']);
    expect(
      check('The p99 was 2.38s.', facts({ id: 'run.p99', label: 'p99 response time', display: '2,383 ms', value: 2383, text: null })),
    ).toEqual(['2.38']);
  });

  it('checks every string in every section', () => {
    const bad = content({
      health: { headline: 'h 901', bullets: ['b 902', 'b 903'] },
      insights: {
        headline: 'i 904',
        errors: ['e 905'],
        assertions: ['a 906'],
        injectionProfile: ['p 907'],
        responseTimes: ['r 908'],
      },
      recommendations: { headline: 'r 909', bullets: ['r 910', 'r 911'] },
    });
    expect(checkNumbers(bad, FACTS)).toEqual(['901', '902', '903', '904', '905', '906', '907', '908', '909', '910', '911']);
  });

  it('lists a refused number once, in the order it first appears', () => {
    expect(check('342 then 7777 then 342 again.')).toEqual(['342', '7777']);
  });

  it('reads a trailing comma as punctuation, not part of the number', () => {
    expect(check('Of 1,724, 289 failed.')).toEqual([]);
    expect(check('It said found 401, then stopped.', facts({ id: 'e', label: 'e', display: 'found 401', value: null, text: 'found 401' }))).toEqual([]);
    expect(check('Of 4242, none.')).toEqual(['4242']);
  });

  it('checks every string the analysis carries, whatever its shape', () => {
    // A field added to the content later is checked without anybody listing it.
    const later = { ...content(), appendix: { notes: ['n 912', ['deeper 913']] } } as unknown as AiAnalysisContent;
    expect(checkNumbers(later, FACTS)).toEqual(['912', '913']);
  });

  it('refuses a leading-zero number even when its value is a fact', () => {
    // 1 is a fact on this run (one request always failed); 01 is not how any fact writes it.
    expect(FACTS.facts.some((f) => f.value === 1)).toBe(true);
    expect(check('Group 01 failed.')).toEqual(['01']);
    expect(check('Group 007 failed.')).toEqual(['007']);
    // A zero before the decimal point is not a leading zero.
    expect(check('An error rate of 0.5%.', facts({ id: 'x', label: 'x', display: '0.5%', value: 0.5, text: null }))).toEqual([]);
  });

  describe('a clock or a duration is one number, and only a fact’s words can pass it', () => {
    // On this run 0, 1 and 28 are all facts, so a check reading these shapes part by part
    // passes an invented clock or duration whose parts coincide with them.
    it('the fixture really has the coincidences', () => {
      for (const v of [0, 1, 28]) expect(FACTS.facts.some((f) => f.value === v)).toBe(true);
    });

    it('refuses an invented elapsed clock', () => {
      expect(check('OK fell to zero at 00:01:00.')).toEqual(['00:01:00']);
      expect(check('Errors began at 0:28.')).toEqual(['0:28']);
    });

    it('refuses an invented duration', () => {
      expect(check('The run lasted 1m 28s.')).toEqual(['1m 28s']);
      expect(check('It recovered within 28s.')).toEqual(['28s']);
    });

    it('still passes the run’s own duration, and a unit glued to a number is not a duration', () => {
      expect(check('Over 91s the run made 1,724 requests.')).toEqual([]);
      expect(check('A p95 of 321ms.')).toEqual([]);
    });
  });

  describe('a fact’s display is a span too', () => {
    it('passes a duration written the way the facts write it', () => {
      const long = buildRunFacts(input({ run: { simulation: null, status: 'complete', durationMs: 3_723_000, activityMs: null } }));
      const duration = long.facts.find((f) => f.id === 'run.duration');
      expect(duration).toMatchObject({ display: '1h 2m 3s', value: 3_723_000 });
      // Alone, so no other fact's value can pass these digits by coincidence.
      expect(check('The run lasted 1h 2m 3s.', facts(duration!))).toEqual([]);
      // Its parts, rearranged, are not its display.
      expect(check('The run lasted 2h 3m 1s.', facts(duration!))).toEqual(['2h 3m 1s']);
    });

    it('passes an elapsed clock written the way the facts write it', () => {
      const zero = facts({
        id: 'derived.okZero',
        label: 'OK responses fell to zero',
        display: '00:01:28',
        value: 88_000,
        text: 'only in the final drain',
      });
      expect(check('OK fell to zero at 00:01:28, only in the final drain.', zero)).toEqual([]);
      expect(check('OK fell to zero at 00:01:29.', zero)).toEqual(['00:01:29']);
    });

    it('passes a platform assertion’s actual, which has no value', () => {
      const withGate = buildRunFacts(
        input({ platformAssertions: [{ description: 'Cart mean response time', outcome: 'failed', actualDisplay: '812 ms' }] }),
      );
      const gate = withGate.facts.find((f) => f.id === 'assertion.platform.0');
      expect(gate).toMatchObject({ value: null, display: 'failed · 812 ms' });
      expect(withGate.facts.some((f) => f.value === 812)).toBe(false);
      // Cited whole, or the actual alone: the outcome and the actual are both parts of the display.
      expect(check('The gate read failed · 812 ms.', withGate)).toEqual([]);
      expect(check('The Cart gate failed at 812 ms.', withGate)).toEqual([]);
      // Ungrouped or unit-less, the actual is a number the facts never wrote.
      expect(check('The Cart gate failed at 812.', withGate)).toEqual(['812']);
    });

    it('passes digits inside a fact’s label', () => {
      const labelled = facts({ id: 'request.16.name', label: 'Request 17', display: 'Search', value: null, text: 'Search' });
      expect(check('Request 17 is Search.', labelled)).toEqual([]);
      expect(check('Request 18 is Search.', labelled)).toEqual(['18']);
    });
  });
});
