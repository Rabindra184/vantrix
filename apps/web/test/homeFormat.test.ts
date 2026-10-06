import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActivityResponseSchema, type ActivityResponse } from '@perfportal/contracts';
import {
  ACTIVITY_POLL_MS,
  activityQueryKey,
  activityRefetchInterval,
  browserTimeZone,
  fetchActivity,
} from '../src/api/activity';
import { ProblemError } from '../src/api/fetch';
import {
  attentionRowLabel,
  attentionState,
  daysAgo,
  greetingName,
  passRateLabel,
  reasonLabel,
  reasonMark,
} from '../src/home/homeFormat';
import { STATUS, VERDICT } from '../src/routes/marks';

/**
 * ═══ THE HOME PAGE'S SMALL DECISIONS, BELOW THE PAGE ═══
 *
 * Everything here is a pure function or a one-line client, so every case reads
 * its expectation off the input rather than off a literal that a re-capture
 * could move. The fixture is parsed by the real `ActivityResponseSchema`: a
 * hand-built object that the contract would refuse is a test of nothing.
 */

const id = (n: number) => `1a2b3c4d-0000-4000-8000-${String(n).padStart(12, '0')}`;
const CHECKOUT = { slug: 'checkout', name: 'Checkout' };

/** The seven days the fixture's window starts on: `window.from` is the first's midnight. */
const DAYS = ['2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06'].map(
  (date) => ({ date, total: 0, successful: 0, needsAttention: 0 }),
);

const ROW = {
  test: { slug: 'soak', name: 'Soak' },
  project: CHECKOUT,
  run: {
    id: id(1),
    runNumber: 4,
    status: 'complete',
    verdict: 'failed',
    startedAt: '2026-10-05T09:00:00.000Z',
    durationMs: 60_000,
    checks: null,
    simulation: 'example.SoakSimulation',
  },
  reasons: ['gate_failed'],
};

const LAST_RUN = {
  id: id(2),
  runNumber: 3,
  test: { slug: 'soak', name: 'Soak' },
  project: CHECKOUT,
  startedAt: '2026-08-16T09:00:00.000Z',
};

function activity(over: Record<string, unknown> = {}): ActivityResponse {
  return ActivityResponseSchema.parse({
    window: { from: '2026-09-30T00:00:00.000Z', to: '2026-10-06T12:00:00.000Z', tz: 'UTC' },
    days: DAYS,
    runCount: 0,
    passRate: null,
    running: 0,
    byProject: [],
    attention: [],
    attentionTotal: 0,
    lastRun: null,
    ...over,
  });
}

describe('attentionState', () => {
  it('is filled when any test needs attention, whatever else is true', () => {
    expect(attentionState(activity({ attention: [ROW], attentionTotal: 1, runCount: 9 }))).toBe('filled');
  });

  it('is clean when runs arrived and none needs attention', () => {
    expect(attentionState(activity({ runCount: 9, passRate: 1, lastRun: LAST_RUN }))).toBe('clean');
  });

  it('is a gap when the window is quiet but the org has run before', () => {
    expect(attentionState(activity({ runCount: 0, lastRun: LAST_RUN }))).toBe('gap');
  });

  /**
   * The org whose only run arrived in the slice before the oldest day's
   * midnight — inside the 168 hours before now and outside the window — as
   * `activity.integration.test.ts` has the API answer it: nothing listed,
   * nothing counted, and that run as the last one. One window, so the page
   * reads a coverage gap rather than listing a run under seven empty columns.
   */
  it('is a gap for an org whose only run arrived before the window’s first instant', () => {
    const from = '2026-09-30T00:00:00.000Z';
    const arrivedBefore = { ...LAST_RUN, startedAt: '2026-09-29T23:00:00.000Z' };
    const answer = activity({
      window: { from, to: '2026-10-06T12:00:00.000Z', tz: 'UTC' },
      runCount: 0,
      attention: [],
      attentionTotal: 0,
      lastRun: arrivedBefore,
    });
    expect(Date.parse(answer.lastRun!.startedAt)).toBeLessThan(Date.parse(answer.window.from));
    expect(attentionState(answer)).toBe('gap');
  });

  it('is empty when the org has never had a run', () => {
    expect(attentionState(activity({ runCount: 0, lastRun: null }))).toBe('empty');
  });
});

describe('greetingName', () => {
  it('is the first word of the trimmed name', () => {
    expect(greetingName({ name: '  Ada Lovelace ', email: 'x@y' })).toBe('Ada');
  });

  it('falls back to the local part of the email when the name is blank', () => {
    expect(greetingName({ name: ' ', email: 'grace@navy.mil' })).toBe('grace');
    expect(greetingName({ name: '', email: 'grace@navy.mil' })).toBe('grace');
  });
});

describe('passRateLabel', () => {
  it('rounds DOWN, so 199 of 200 never reads as 100%', () => {
    expect(passRateLabel(199 / 200)).toBe('99%');
    expect(passRateLabel(1)).toBe('100%');
    expect(passRateLabel(0)).toBe('0%');
  });

  /**
   * `29 / 100 * 100` is 28.999999999999996 in IEEE doubles, so the bare
   * `Math.floor(rate * 100)` the brief spells reads 29 of 100 as 28% — and 57
   * and 58 of 100 the same way, 16 ratios in all with a denominator up to 400.
   * That is a figure wrong by a whole point on a screen whose one job is to
   * state it, so the product is nudged by less than any real ratio can sit from
   * a whole percent. The expectation is INTEGER arithmetic, which has no such
   * error, over every ratio the loop reaches; 199 of 200 above still reads 99%.
   */
  it('does not lose a whole percent to floating point', () => {
    const wrong: string[] = [];
    for (let d = 1; d <= 400; d += 1) {
      for (let n = 0; n <= d; n += 1) {
        const exact = Math.floor((n * 100) / d);
        if (passRateLabel(n / d) !== `${exact}%`) wrong.push(`${n}/${d}`);
      }
    }
    expect(wrong).toEqual([]);
    expect(passRateLabel(29 / 100)).toBe('29%');
  });
});

describe('reasonLabel', () => {
  it('says each reason in the words the rest of the product uses', () => {
    expect(reasonLabel('gate_failed', null)).toBe('SLA failed');
    expect(reasonLabel('failed', null)).toBe('Could not be ingested');
    expect(reasonLabel('incomplete', null)).toBe('Incomplete');
  });

  it('counts the failed checks, in the singular and the plural', () => {
    expect(reasonLabel('assertion_failed', { failed: 1, total: 3 })).toBe('1 assertion failed');
    expect(reasonLabel('assertion_failed', { failed: 2, total: 3 })).toBe('2 assertions failed');
  });

  it('does not invent a count when the run recorded no checks', () => {
    expect(reasonLabel('assertion_failed', null)).toBe('Assertion failed');
  });
});

describe('reasonMark', () => {
  it('borrows the shape and colour an outcome already has elsewhere, under the reason’s own words', () => {
    const failed = reasonMark('failed', null);
    expect([failed.glyph, failed.colour]).toEqual([STATUS.failed.glyph, STATUS.failed.colour]);
    expect(failed.label).toBe(reasonLabel('failed', null));

    const incomplete = reasonMark('incomplete', null);
    expect([incomplete.glyph, incomplete.colour]).toEqual([
      STATUS.incomplete.glyph,
      STATUS.incomplete.colour,
    ]);

    const gate = reasonMark('gate_failed', null);
    expect([gate.glyph, gate.colour]).toEqual([VERDICT.failed.glyph, VERDICT.failed.colour]);

    const checks = { failed: 2, total: 5 };
    const assertion = reasonMark('assertion_failed', checks);
    expect([assertion.glyph, assertion.colour]).toEqual([STATUS.failed.glyph, STATUS.failed.colour]);
    expect(assertion.label).toBe(reasonLabel('assertion_failed', checks));
  });
});

describe('daysAgo', () => {
  const now = new Date('2026-10-06T12:00:00.000Z');
  const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();
  const DAY = 24 * 60 * 60 * 1000;

  it('says today, one day and n days', () => {
    expect(daysAgo(now.toISOString(), now)).toBe('today');
    expect(daysAgo(ago(DAY), now)).toBe('1 day ago');
    expect(daysAgo(ago(51 * DAY), now)).toBe('51 days ago');
  });

  it('counts whole days, floored', () => {
    expect(daysAgo(ago(DAY - 1), now)).toBe('today');
    expect(daysAgo(ago(2 * DAY - 1), now)).toBe('1 day ago');
  });

  it('never reads a clock that is slightly ahead as a negative number of days', () => {
    expect(daysAgo(ago(-60_000), now)).toBe('today');
  });
});

describe('attentionRowLabel', () => {
  it('names a row by its test, then its simulation, then its upload', () => {
    expect(attentionRowLabel(activity({ attention: [ROW], attentionTotal: 1 }).attention[0]!)).toBe('Soak');

    const noTest = activity({ attention: [{ ...ROW, test: null }], attentionTotal: 1 }).attention[0]!;
    expect(attentionRowLabel(noTest)).toBe('example.SoakSimulation');

    const nothing = activity({
      attention: [{ ...ROW, test: null, run: { ...ROW.run, simulation: null } }],
      attentionTotal: 1,
    }).attention[0]!;
    expect(attentionRowLabel(nothing)).toBe(`Upload ${nothing.run.id.slice(0, 8)}`);
    expect(attentionRowLabel(nothing)).toBe('Upload 1a2b3c4d');
  });
});

describe('the activity client', () => {
  it('keys one answer per zone', () => {
    expect(activityQueryKey('Asia/Kolkata')).toEqual(['activity', 'Asia/Kolkata']);
    expect(activityQueryKey('UTC')).not.toEqual(activityQueryKey('Asia/Kolkata'));
  });

  describe('activityRefetchInterval', () => {
    it('polls every thirty seconds while something is running, and never otherwise', () => {
      expect(ACTIVITY_POLL_MS).toBe(30_000);
      expect(activityRefetchInterval(activity({ running: 1 }))).toBe(30_000);
      expect(activityRefetchInterval(activity({ running: 0 }))).toBe(false);
      expect(activityRefetchInterval(undefined)).toBe(false);
    });
  });

  describe('browserTimeZone', () => {
    afterEach(() => vi.restoreAllMocks());

    it('is the zone the browser reports', () => {
      expect(browserTimeZone()).toBe(new Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
    });

    it('is UTC when the browser reports none, or refuses to say', () => {
      vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(function () {
        return { resolvedOptions: () => ({ timeZone: '' }) } as unknown as Intl.DateTimeFormat;
      });
      expect(browserTimeZone()).toBe('UTC');

      vi.restoreAllMocks();
      vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(function () {
        throw new Error('Intl is unavailable');
      });
      expect(browserTimeZone()).toBe('UTC');
    });

    /**
     * ICU's "could not detect a zone" is a NAME, `Etc/Unknown`, and no zone
     * database holds it: Node 22 refuses it, so sending it would earn a 400
     * on every load. The precondition is checked here rather than assumed.
     */
    it('is UTC when ICU answers its own “could not detect”, which no server accepts', () => {
      expect(() => new Intl.DateTimeFormat('en', { timeZone: 'Etc/Unknown' })).toThrow(RangeError);
      vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(function () {
        return { resolvedOptions: () => ({ timeZone: 'Etc/Unknown' }) } as unknown as Intl.DateTimeFormat;
      });
      expect(browserTimeZone()).toBe('UTC');
    });
  });

  describe('fetchActivity', () => {
    let fetchMock: ReturnType<typeof vi.fn>;
    beforeEach(() => {
      fetchMock = vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify(activity({ runCount: 2 })), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        ),
      );
      vi.stubGlobal('fetch', fetchMock);
    });
    afterEach(() => vi.unstubAllGlobals());

    it('asks for the zone, percent-encoded, and parses the answer with the contract', async () => {
      const answer = await fetchActivity('Asia/Kolkata');
      const [raw] = fetchMock.mock.calls[0] as [string];
      const url = new URL(raw, 'http://localhost');
      expect(url.pathname).toBe('/v1/activity');
      expect(url.searchParams.get('tz')).toBe('Asia/Kolkata');
      // The slash is encoded: a raw one is a path separator to any proxy that
      // normalises before it forwards.
      expect(raw).toBe('/v1/activity?tz=Asia%2FKolkata');
      expect(answer.runCount).toBe(2);
    });

    /**
     * ═══ A ZONE THE SERVER REFUSES ASKS AGAIN IN UTC, ONCE ═══
     *
     * The one 400 this client can earn from this endpoint is the zone, and a
     * browser reader cannot act on "send an IANA zone". So a 400 is asked
     * again with `tz=UTC`, exactly once; anything else is not about the zone
     * and is not retried.
     */
    const answers = (...responses: Response[]) => {
      fetchMock.mockReset();
      for (const response of responses) fetchMock.mockImplementationOnce(() => Promise.resolve(response));
    };
    const refusal = (status: number) =>
      new Response(
        JSON.stringify({
          code: status === 400 ? 'INVALID_TIMEZONE' : 'INTERNAL',
          detail: 'Refused.',
          remediation: 'Send an IANA time zone name such as Europe/London.',
        }),
        { status, headers: { 'Content-Type': 'application/problem+json' } },
      );
    const asked = () =>
      fetchMock.mock.calls.map(([raw]) => new URL(raw as string, 'http://localhost').searchParams.get('tz'));

    it('asks again in UTC after a 400, and answers with the UTC payload', async () => {
      const inUtc = activity({ runCount: 5, window: { ...activity().window, tz: 'UTC' } });
      answers(
        refusal(400),
        new Response(JSON.stringify(inUtc), { status: 200, headers: { 'Content-Type': 'application/json' } }),
      );
      const answer = await fetchActivity('America/Ciudad_Juarez');
      expect(asked()).toEqual(['America/Ciudad_Juarez', 'UTC']);
      expect(answer.runCount).toBe(5);
      expect(answer.window.tz).toBe('UTC');
    });

    it('rejects when the UTC ask is refused too, having asked exactly twice', async () => {
      answers(refusal(400), refusal(400));
      const failure = fetchActivity('America/Ciudad_Juarez');
      await expect(failure).rejects.toBeInstanceOf(ProblemError);
      await expect(failure).rejects.toMatchObject({ status: 400 });
      expect(asked()).toEqual(['America/Ciudad_Juarez', 'UTC']);
    });

    it('does not retry a failure that is not about the zone', async () => {
      answers(refusal(500));
      await expect(fetchActivity('America/Ciudad_Juarez')).rejects.toMatchObject({ status: 500 });
      expect(asked()).toEqual(['America/Ciudad_Juarez']);
    });

    it('does not ask UTC twice', async () => {
      answers(refusal(400), refusal(400));
      await expect(fetchActivity('UTC')).rejects.toMatchObject({ status: 400 });
      expect(asked()).toEqual(['UTC']);
    });
  });
});
