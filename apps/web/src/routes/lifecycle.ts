import type { Assertion, RunIdentity, RunResponse, RunVerdict } from '@perfportal/contracts';
import { releaseWord } from './decision';
import { formatClockTime, formatDuration } from './format';

/**
 * ═══ THE RUN'S JOURNEY, DERIVED FROM ITS OWN STAMPS ═══
 * (docs/superpowers/specs/2026-09-26-run-lifecycle-strip-design.md)
 *
 * Pure: an identity in, ordered steps out, the way `window.ts` holds the time
 * window's math. Every time comes from a stamp PerfPortal recorded; nothing is
 * estimated, and nothing reads a client clock — a live run's Load test
 * advances with each identity refresh, from its own last chunk.
 *
 * WHICH STEPS: a runner run is Queued ❯ Load test ❯ Processing ❯ Verdict; a
 * live stream starts at its Load test; an upload's test ran before PerfPortal
 * saw anything, so its Received step comes after the Load test.
 */

export type StepName = 'queued' | 'load-test' | 'received' | 'processing' | 'verdict';
export type StepState = 'done' | 'active' | 'pending' | 'stopped' | 'failed';

export const STEP_LABEL: Record<StepName, string> = {
  queued: 'Queued',
  'load-test': 'Load test',
  received: 'Received',
  processing: 'Processing',
  verdict: 'Verdict',
};

export interface LifecycleStep {
  readonly name: StepName;
  /** What the strip says for this step. */
  readonly text: string;
  readonly state: StepState;
  /** Epoch milliseconds, or null where nothing was stamped. */
  readonly startMs: number | null;
  readonly endMs: number | null;
  /** How long it took, or null when a stamp is missing or the pair is skewed. */
  readonly durationMs: number | null;
  /** A second fact for the step's Step times row. */
  readonly note: string | null;
  /** The Verdict step only: which verdict its mark shows. */
  readonly verdict?: RunVerdict | null;
}

/**
 * The run as the page holds it. The shell is handed the run's body whole
 * (`RunDetail` passes `detail.run`), and a finished run's body is a
 * `RunResponse`, which also carries `ingestedAt` — processing's end, and not
 * an identity field. A live run's 202 body has none, and needs none.
 */
export type LifecycleIdentity = Partial<RunIdentity> & Partial<Pick<RunResponse, 'ingestedAt'>>;

export interface LifecycleInput {
  readonly identity: LifecycleIdentity;
  readonly status: RunResponse['status'];
  readonly verdict: RunResponse['verdict'] | undefined;
  readonly assertions: readonly Assertion[] | undefined;
}

function at(iso: string | null | undefined): number | null {
  if (iso == null) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/** End minus start, or null — a pair out of order is two clocks disagreeing,
 *  and a negative duration would be a claim nobody measured. */
function between(start: number | null, end: number | null): number | null {
  return start !== null && end !== null && end >= start ? end - start : null;
}

function withDuration(text: string, durationMs: number | null): string {
  return durationMs === null ? text : `${text} · ${formatDuration(durationMs)}`;
}

export function lifecycleSteps(input: LifecycleInput): LifecycleStep[] {
  const { identity, status, verdict, assertions } = input;
  const received = at(identity.startedAt);
  const toolStart = at(identity.toolStartedAt);
  // THE RUN'S OWN SPAN, the Duration chip's expression: one number under one word.
  const testSpan = identity.activityMs ?? identity.durationMs ?? null;
  const testEnd = toolStart !== null && testSpan !== null ? toolStart + testSpan : null;
  const parsing = at(identity.parsingStartedAt);
  const ingested = at(identity.ingestedAt);
  const lastChunk = at(identity.streamUpdatedAt);
  const queued = at(identity.queuedAt);

  const fromRunner = queued !== null;
  // ONLY A STREAM CAN END INCOMPLETE (the sweeper's `running` arm, or a close
  // with no bytes), so the status decides a row that carries no stamps.
  const streamed = fromRunner || status === 'running' || status === 'incomplete' || lastChunk !== null;

  const steps: LifecycleStep[] = [];

  if (fromRunner) {
    const durationMs = between(queued, received);
    steps.push({
      name: 'queued',
      text: withDuration('Queued', durationMs),
      state: 'done',
      startMs: queued,
      endMs: received,
      durationMs,
      note: null,
    });
  }

  if (streamed) {
    const startMs = toolStart ?? received;
    if (status === 'running') {
      const durationMs = between(received, lastChunk);
      steps.push({
        name: 'load-test',
        text: withDuration('Load test · streaming', durationMs),
        state: 'active',
        startMs,
        endMs: null,
        durationMs,
        note: null,
      });
    } else {
      // WHERE THE TEST ENDED: the processed log's own span when there is one,
      // else the last accepted chunk — the producer's last sign of life. Never
      // the sweeper's give-up, which would count the silence before it as load.
      const endMs = testEnd ?? lastChunk;
      const durationMs = testSpan ?? between(startMs, endMs);
      const stopped = status === 'incomplete';
      steps.push({
        name: 'load-test',
        text: withDuration(stopped ? 'Load test stopped early' : 'Load test', durationMs),
        state: stopped ? 'stopped' : 'done',
        startMs,
        endMs,
        durationMs,
        note: null,
      });
    }
  } else {
    steps.push(
      toolStart === null
        ? {
            name: 'load-test',
            text: 'Load test · known once processed',
            state: 'pending',
            startMs: null,
            endMs: null,
            durationMs: null,
            note: null,
          }
        : {
            name: 'load-test',
            text: withDuration('Load test', testSpan),
            state: 'done',
            startMs: toolStart,
            endMs: testEnd,
            durationMs: testSpan,
            note: null,
          },
    );
    const gap = between(testEnd, received);
    steps.push({
      name: 'received',
      text: 'Received',
      state: 'done',
      startMs: received,
      endMs: received,
      durationMs: null,
      note: gap === null ? null : `${formatDuration(gap)} after the test ended`,
    });
  }

  steps.push(processingStep(status, received, parsing, ingested, testSpan !== null));

  const judged = status === 'complete' || status === 'incomplete';
  steps.push(
    judged
      ? {
          name: 'verdict',
          text: `Verdict: ${releaseWord(verdict, assertions)}`,
          state: 'done',
          startMs: ingested,
          endMs: ingested,
          durationMs: null,
          note: null,
          verdict: verdict ?? null,
        }
      : {
          name: 'verdict',
          text: 'Verdict',
          state: 'pending',
          startMs: null,
          endMs: null,
          durationMs: null,
          note: null,
        },
  );

  return steps;
}

function processingStep(
  status: RunResponse['status'],
  received: number | null,
  parsing: number | null,
  ingested: number | null,
  /** Whether processing measured a span, i.e. the log became statistics. */
  measured: boolean,
): LifecycleStep {
  const base = { name: 'processing' as const, note: null };
  if (status === 'failed') {
    // UNREACHABLE ON THE PAGE TODAY: `GET /v1/runs/{id}` answers a failed run
    // with the ingest problem, which the page shows instead of the run shell.
    // Kept so that, if an identity ever arrives for one, it says "failed"
    // rather than claiming the stream stopped early.
    return {
      ...base,
      text: 'Processing failed',
      state: 'failed',
      startMs: parsing,
      endMs: ingested,
      durationMs: between(parsing, ingested),
    };
  }
  if (status === 'pending') {
    return {
      ...base,
      text: received === null ? 'Waiting for a worker' : `Waiting for a worker since ${formatClockTime(received)}`,
      state: 'active',
      startMs: received,
      endMs: null,
      durationMs: null,
    };
  }
  if (status === 'parsing') {
    return {
      ...base,
      text: parsing === null ? 'Processing' : `Processing since ${formatClockTime(parsing)}`,
      state: 'active',
      startMs: parsing,
      endMs: null,
      durationMs: null,
    };
  }
  if (status === 'running') {
    return { ...base, text: 'Processing', state: 'pending', startMs: null, endMs: null, durationMs: null };
  }
  if (status === 'incomplete' && (parsing === null || !measured)) {
    // NOTHING BECAME STATISTICS: nothing arrived to process (the sweeper
    // finalized the run in place, or a close carried no bytes), or the
    // sweeper's assembly found nothing decodable. The statistics table's own
    // words for it.
    return { ...base, text: 'Nothing retained', state: 'stopped', startMs: parsing, endMs: ingested, durationMs: null };
  }
  const durationMs = between(parsing, ingested);
  return {
    ...base,
    text: withDuration('Processed', durationMs),
    state: 'done',
    startMs: parsing,
    endMs: ingested,
    durationMs,
  };
}
