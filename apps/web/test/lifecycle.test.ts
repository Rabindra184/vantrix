import { describe, expect, it } from 'vitest';
import { lifecycleSteps, type LifecycleInput, type StepName } from '../src/routes/lifecycle';
import { releaseWord } from '../src/routes/decision';
import { formatDuration } from '../src/routes/format';

/**
 * ═══ THE RUN'S JOURNEY, DERIVED ═══
 * (docs/superpowers/specs/2026-09-26-run-lifecycle-strip-design.md)
 *
 * Times follow a real run (b01d731e, 108.5 s) where a real one fits; the
 * states are the ones each path can reach. Cases that print a time of day pin
 * Asia/Kolkata and assert the pin took — this machine's own zone IS
 * Asia/Kolkata, so a pin that silently failed would still pass here.
 */
const T = Date.parse('2026-09-19T16:39:56.406Z');
const iso = (ms: number): string => new Date(ms).toISOString();

function input(
  identity: LifecycleInput['identity'],
  status: LifecycleInput['status'],
  verdict: LifecycleInput['verdict'] = null,
  assertions: LifecycleInput['assertions'] = [],
): LifecycleInput {
  return { identity, status, verdict, assertions };
}
const names = (i: LifecycleInput): StepName[] => lifecycleSteps(i).map((s) => s.name);
const step = (i: LifecycleInput, name: StepName) => lifecycleSteps(i).find((s) => s.name === name)!;

async function inKolkata(body: () => void): Promise<void> {
  const original = process.env.TZ;
  try {
    process.env.TZ = 'Asia/Kolkata';
    expect(new Date('2026-08-15T00:00:00Z').getHours()).toBe(5);
    body();
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
}

const FINISHED_RUNNER = input(
  {
    queuedAt: iso(T - 41_000),
    startedAt: iso(T),
    toolStartedAt: iso(T + 1_000),
    activityMs: 107_701,
    durationMs: 108_532,
    streamUpdatedAt: iso(T + 109_000),
    parsingStartedAt: iso(T + 110_000),
    ingestedAt: iso(T + 112_000),
  },
  'complete',
  'failed',
);

describe('lifecycleSteps — the steps a path has', () => {
  it('walks a runner run from its queue', () => {
    expect(names(FINISHED_RUNNER)).toEqual(['queued', 'load-test', 'processing', 'verdict']);
    expect(step(FINISHED_RUNNER, 'queued')).toMatchObject({ state: 'done', text: 'Queued · 41s', durationMs: 41_000 });
  });

  it('starts a live stream at its load test', () => {
    const live = input({ startedAt: iso(T), streamUpdatedAt: iso(T + 60_000) }, 'complete', 'passed');
    expect(names(live)).toEqual(['load-test', 'processing', 'verdict']);
  });

  it('puts an upload’s arrival after its load test', () => {
    const upload = input({ startedAt: iso(T + 600_000), toolStartedAt: iso(T), activityMs: 62_136 }, 'complete');
    expect(names(upload)).toEqual(['load-test', 'received', 'processing', 'verdict']);
  });

  /** Only a stream can end incomplete, so the status decides a row with no
   *  stamps — the e2e suite's seeded incomplete run is exactly that. */
  it('treats an incomplete run as streamed even when no stamp says so', () => {
    expect(names(input({ startedAt: iso(T) }, 'incomplete', 'not_evaluated'))).toEqual([
      'load-test',
      'processing',
      'verdict',
    ]);
  });
});

describe('lifecycleSteps — each state says what it is', () => {
  it('counts a streaming load test to its last chunk, and leaves the rest pending', () => {
    const streaming = input({ startedAt: iso(T), streamUpdatedAt: iso(T + 42_000) }, 'running', undefined, undefined);
    expect(step(streaming, 'load-test')).toMatchObject({
      state: 'active',
      text: 'Load test · streaming · 42s',
      endMs: null,
    });
    expect(step(streaming, 'processing').state).toBe('pending');
    expect(step(streaming, 'verdict')).toMatchObject({ state: 'pending', text: 'Verdict' });
  });

  /** The load test stopped at the producer's last sign of life. The sweeper
   *  gave up five minutes later; counting that silence as load would be a
   *  claim nobody measured. */
  it('ends an unprocessed incomplete stream at its last chunk, with nothing retained', () => {
    const quiet = input(
      { startedAt: iso(T), streamUpdatedAt: iso(T + 30_000), ingestedAt: iso(T + 330_500) },
      'incomplete',
      'not_evaluated',
    );
    expect(step(quiet, 'load-test')).toMatchObject({
      state: 'stopped',
      endMs: T + 30_000,
      durationMs: 30_000,
      text: 'Load test stopped early · 30s',
    });
    expect(step(quiet, 'processing')).toMatchObject({ state: 'stopped', text: 'Nothing retained' });
  });

  it('ends a processed incomplete stream where its own log says the test ended', () => {
    const processed = input(
      {
        startedAt: iso(T),
        toolStartedAt: iso(T + 1_000),
        activityMs: 36_028,
        durationMs: 36_500,
        streamUpdatedAt: iso(T + 37_500),
        parsingStartedAt: iso(T + 337_500),
        ingestedAt: iso(T + 339_500),
      },
      'incomplete',
      'not_evaluated',
    );
    expect(step(processed, 'load-test')).toMatchObject({
      state: 'stopped',
      endMs: T + 1_000 + 36_028,
      durationMs: 36_028,
      text: 'Load test stopped early · 36s',
    });
    expect(step(processed, 'processing')).toMatchObject({ state: 'done', text: 'Processed · 2s' });
  });

  /** The sweeper began processing, and its assembly found nothing decodable:
   *  the run was finalized with no statistics, so no span was ever measured. */
  it('says nothing was retained when processing began and measured nothing', () => {
    const empty = input(
      {
        startedAt: iso(T),
        streamUpdatedAt: iso(T + 30_000),
        parsingStartedAt: iso(T + 330_000),
        ingestedAt: iso(T + 331_000),
      },
      'incomplete',
      'not_evaluated',
    );
    expect(step(empty, 'processing')).toMatchObject({ state: 'stopped', text: 'Nothing retained' });
  });

  it('says an upload nobody has picked up is waiting for a worker, since it arrived', async () => {
    await inKolkata(() => {
      const waiting = input({ startedAt: '2026-08-14T10:43:49.546Z' }, 'pending', undefined, undefined);
      expect(step(waiting, 'processing')).toMatchObject({
        state: 'active',
        text: 'Waiting for a worker since 16:13:49',
      });
      expect(step(waiting, 'load-test')).toMatchObject({ state: 'pending', text: 'Load test · known once processed' });
      expect(step(waiting, 'received').state).toBe('done');
    });
  });

  it('says since when a run has been processing', async () => {
    await inKolkata(() => {
      const parsing = input(
        { startedAt: '2026-08-14T10:43:49.546Z', parsingStartedAt: '2026-08-14T10:43:50.000Z' },
        'parsing',
        undefined,
        undefined,
      );
      expect(step(parsing, 'processing')).toMatchObject({ state: 'active', text: 'Processing since 16:13:50' });
    });
  });

  it('notes how long after the test an upload arrived', () => {
    const upload = input(
      {
        startedAt: '2026-08-14T10:43:49.546Z',
        toolStartedAt: '2026-08-07T05:30:02.171Z',
        activityMs: 62_136,
      },
      'complete',
    );
    const gap = Date.parse('2026-08-14T10:43:49.546Z') - (Date.parse('2026-08-07T05:30:02.171Z') + 62_136);
    expect(step(upload, 'received')).toMatchObject({
      text: 'Received',
      note: `${formatDuration(gap)} after the test ended`,
    });
  });

  it('shows no duration for a skewed pair rather than a negative one', () => {
    const skewed = input(
      { startedAt: iso(T), parsingStartedAt: iso(T + 5_000), ingestedAt: iso(T + 4_000) },
      'complete',
    );
    expect(step(skewed, 'processing')).toMatchObject({ durationMs: null, text: 'Processed' });
  });

  /** Unreachable on the page today — the API answers a failed run with the
   *  ingest problem instead of an identity — and kept so the day it is
   *  reachable it says the right thing rather than "stopped early". */
  it('defensively reads a failed run as processing failed', () => {
    const failed = input({ startedAt: iso(T) }, 'failed', null, undefined);
    expect(step(failed, 'processing')).toMatchObject({ state: 'failed', text: 'Processing failed' });
    expect(step(failed, 'load-test').text).not.toMatch(/stopped early/);
  });
});

describe('lifecycleSteps — agreement with the rest of the page', () => {
  it('reads the band’s own word for every verdict', () => {
    for (const [verdict, assertions] of [
      ['passed', []],
      ['failed', []],
      ['not_evaluated', []],
      ['not_evaluated', undefined],
      [null, []],
    ] as const) {
      // Built literally, not through `input()`: its `assertions = []` default
      // would turn the `undefined` case — gates not reported, "Not evaluated" —
      // into `[]`, which the band calls "Not configured".
      const judged: LifecycleInput = {
        identity: { startedAt: iso(T), streamUpdatedAt: iso(T + 1_000) },
        status: 'complete',
        verdict,
        assertions,
      };
      expect(step(judged, 'verdict')).toMatchObject({
        state: 'done',
        text: `Verdict: ${releaseWord(verdict, assertions)}`,
        verdict,
      });
    }
  });

  it('carries the run’s own span, the Duration chip’s `activityMs ?? durationMs`', () => {
    const both = input({ startedAt: iso(T), toolStartedAt: iso(T), activityMs: 62_136, durationMs: 63_161 }, 'complete');
    expect(step(both, 'load-test').durationMs).toBe(62_136);
    const legacy = input({ startedAt: iso(T), toolStartedAt: iso(T), durationMs: 63_161 }, 'complete');
    expect(step(legacy, 'load-test').durationMs).toBe(63_161);
  });
});
