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
  /**
   * The live Load test's duration when the page has a socket delta: its
   * summary's `activityMs ?? durationMs`, the "Duration so far" tile's own
   * expression. Null when there is none — a phone (no socket, §22.6), a
   * finished run, or before the first delta. REQUIRED, not optional: an
   * omitted one would silently fall back to the stamp-based figure, which
   * counts a runner's preparation as load.
   */
  readonly liveSpanMs: number | null;
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
  const { identity, status, verdict, assertions, liveSpanMs } = input;
  const received = at(identity.startedAt);
  const toolStart = at(identity.toolStartedAt);
  // THE RUN'S OWN SPAN, the Duration chip's expression: one number under one word.
  const testSpan = identity.activityMs ?? identity.durationMs ?? null;
  // WHERE THE TEST ENDED: its log's last response. `durationMs` runs from the
  // log header (`toolStartedAt`) to the last event, so their sum is a real
  // instant. `toolStart + testSpan` is not: `activityMs` starts at the FIRST
  // COUNTED event — `max(first event, header + warmupMs)` (engine.ts) — so that
  // sum lands a lead-in, or a whole warm-up, before the test actually ended.
  const testEnd =
    toolStart !== null && identity.durationMs != null
      ? toolStart + identity.durationMs
      : toolStart !== null && testSpan !== null
        ? toolStart + testSpan
        : null;
  // …and the counted span STARTS at that end minus the chip: the first request,
  // or the warm-up's end. Took = Ended − Started = the Duration chip, and both
  // printed instants happened.
  const testStart = testEnd !== null && testSpan !== null ? testEnd - testSpan : toolStart;
  // Why Started sits after the test's own start, said where it shows — and
  // only when the chip excludes the warm-up: a run with no `activityMs` falls
  // back to `durationMs`, which includes it.
  const warmupNote =
    identity.activityMs != null && identity.warmupMs != null && identity.warmupMs > 0
      ? `after a ${formatDuration(identity.warmupMs)} warm-up`
      : null;
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
    if (status === 'running') {
      // FROM THE RUN'S OPEN, the only stamp a live run has: nothing writes
      // `toolStartedAt` until the pipeline's terminal UPDATE, which also ends
      // `running`. The DURATION is the live span when the page has one — the
      // "Duration so far" tile's own `activityMs ?? durationMs`, so the two
      // agree, and so a runner's artifact preparation and JVM start-up, which
      // follow the moment it opens its live run, are neither counted as load
      // nor dropped when the run finishes. A phone has no socket and measures
      // open to last chunk.
      const durationMs = liveSpanMs ?? between(received, lastChunk);
      steps.push({
        name: 'load-test',
        text: withDuration('Load test · streaming', durationMs),
        state: 'active',
        startMs: received,
        endMs: null,
        durationMs,
        note: null,
      });
    } else {
      const startMs = testStart ?? received;
      // WHERE THE TEST ENDED: the processed log's own last response when there
      // is one, else the last accepted chunk — the producer's last sign of
      // life. Never the sweeper's give-up, which would count the silence
      // before it as load.
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
        note: warmupNote,
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
            startMs: testStart,
            endMs: testEnd,
            durationMs: testSpan,
            note: warmupNote,
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
