import type { RunnerJob, RunnerJobStatus } from '@perfportal/contracts';

/**
 * WHAT WILL HAPPEN TO A RUN QUEUED RIGHT NOW — review M16.
 *
 * ═══ THIS INSTANCE CANNOT SEE THE RUNNER, AND THAT IS THE POINT ═══
 *
 * The launch form shipped a static panel reading "Concurrency: one active
 * job", which is a fact about the PRODUCT and says nothing about the machine
 * an engineer is about to send work to. The review asks for availability
 * "where supported, with explicit unknown/unavailable states".
 *
 * There is no runner-health endpoint and no heartbeat table: the on-prem
 * runner is a separate deployable that POLLS for work, so nothing in the API
 * is told when one connects or leaves. Inventing an "Online" badge out of
 * that would be the worst possible answer — an engineer would read a green
 * light and wait on a queue nothing is draining.
 *
 * What the API DOES expose is every job this project has queued, with its
 * status and its timestamps, and that is real evidence of a different kind:
 *
 *   - a job in `starting`/`running`/`closing` was CLAIMED, so a runner was
 *     alive as recently as that claim, and the node is busy;
 *   - a job sitting in `queued` is the one shape that distinguishes a runner
 *     between polls from no runner at all — by how LONG it has sat there;
 *   - a project whose jobs are all terminal tells you when a runner last
 *     finished something, and NOTHING about whether one is connected now;
 *   - a project that has never queued a job has no evidence either way.
 *
 * Each of those is a different sentence, and the last two are honestly
 * "unknown" rather than "available". `kind` is what a caller styles on;
 * `headline` and `detail` are what it prints.
 */
export type RunnerReadinessKind = 'busy' | 'waiting' | 'stalled' | 'idle' | 'unknown';

export interface RunnerReadiness {
  readonly kind: RunnerReadinessKind;
  readonly headline: string;
  /** One sentence a reader can act on. Never claims more than is known. */
  readonly detail: string;
  /** How many jobs a run queued now would wait behind. */
  readonly ahead: number;
  /**
   * ═══ THE SETUP ACTION THIS STATE EARNS (review 09-13 copy table) ═══
   *
   * The row is "No runner seen yet + inference paragraphs" -> "`Runner
   * availability unknown` + a useful connection/setup action". M12 already
   * delivered the headline and killed the "queue one to find out" affordance;
   * what it left was a state that says what is not known and offers nothing
   * to do about it.
   *
   * TRUE FOR `unknown` ALONE, and that is the scope the row names. `idle` and
   * `stalled` are states where a runner HAS been seen — the reader's problem
   * there is a process that stopped claiming, not one that was never
   * deployed, and sending them to set one up would be the wrong advice
   * confidently given. Those keep their own sentences.
   */
  readonly needsSetup: boolean;
}

/** The statuses that mean a runner has taken the job and is working on it. */
const CLAIMED: ReadonlySet<RunnerJobStatus> = new Set(['starting', 'running', 'closing']);

/**
 * How long a `queued` job may sit unclaimed before this reads as a problem
 * rather than as a poll interval.
 *
 * The runner's poll is seconds, not minutes, so two minutes is far outside
 * normal and still short enough to be useful. It is deliberately NOT tuned to
 * the runner's actual interval: that value lives in a different deployable and
 * would be a number this page could not verify.
 */
const UNCLAIMED_STALE_MS = 2 * 60 * 1000;

export function runnerReadiness(
  jobs: readonly { readonly job: RunnerJob }[],
  now: number = Date.now(),
): RunnerReadiness {
  if (jobs.length === 0) {
    return {
      kind: 'unknown',
      ahead: 0,
      needsSetup: true,
      headline: 'Runner availability unknown',
      /* ═══ DO NOT ASK FOR WORK AS A HEALTH CHECK (review 09-13 M12) ═══
       *
       * This ended "Queue one to find out whether a node is connected", which
       * asks the reader to SCHEDULE A LOAD TEST to answer a question about
       * connectivity. The honest version says what is and is not known and
       * points at the thing that would make a runner exist, which is a
       * deployment step rather than a run.
       *
       * A heartbeat would replace all of this with a fact. That needs a
       * backend the on-prem runner does not have — it polls, so nothing is
       * told when one connects — and is a product decision rather than a
       * wording one. */
      detail:
        'No run has been queued from this project, so nothing here has ever seen a runner. ' +
        'A runner is a process you deploy alongside this instance; until one claims a job, ' +
        'this page cannot tell whether any are connected.',
    };
  }

  const claimed = jobs.filter((item) => CLAIMED.has(item.job.status));
  const queued = jobs.filter((item) => item.job.status === 'queued');

  if (claimed.length > 0) {
    const ahead = claimed.length + queued.length;
    return {
      kind: 'busy',
      ahead,
      needsSetup: false,
      headline: 'A runner is working',
      detail:
        `A node claimed a job, so one is connected. It runs a single job at a time, so a run ` +
        `queued now waits behind ${countLabel(ahead, 'job')}.`,
    };
  }

  if (queued.length > 0) {
    // The OLDEST queued job is the one that says whether anything is draining
    // the queue — a newer one has had no chance to be claimed yet.
    const oldest = queued.reduce((a, b) => (a.job.createdAt <= b.job.createdAt ? a : b));
    const waited = now - Date.parse(oldest.job.createdAt);

    if (waited >= UNCLAIMED_STALE_MS) {
      return {
        kind: 'stalled',
        ahead: queued.length,
        needsSetup: false,
        headline: 'Nothing is claiming work',
        detail:
          `A job has been queued for ${durationLabel(waited)} and no runner has claimed it. ` +
          'Check that a runner is running and pointed at this instance before queueing more.',
      };
    }

    return {
      kind: 'waiting',
      ahead: queued.length,
      needsSetup: false,
      headline: 'Waiting to be claimed',
      detail:
        `${countLabel(queued.length, 'job')} queued, none claimed yet. A runner polls for work, ` +
        'so a few seconds here is normal.',
    };
  }

  /* EVERY JOB IS TERMINAL, which tells us when a runner last worked and
     nothing whatever about now. The wording says so out loud rather than
     rounding "it worked twenty minutes ago" up to "it is available". */
  const last = jobs.reduce((a, b) => (a.job.updatedAt >= b.job.updatedAt ? a : b));
  return {
    kind: 'idle',
    ahead: 0,
    needsSetup: false,
    headline: 'No job in flight',
    detail:
      `A runner last finished a job ${agoLabel(now - Date.parse(last.job.updatedAt))}. ` +
      'This instance is not told when a runner connects or leaves, so whether one is listening ' +
      'right now is unknown until a job is claimed.',
  };
}

/** `1 job` / `3 jobs` — a count that reads as a phrase. */
function countLabel(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/**
 * A coarse elapsed time, deliberately imprecise, and SEPARATE from the "ago"
 * wording that usually wraps it.
 *
 * The precision `formatOffset` gives (`1m 30s`) is right for a run's own
 * elapsed time, where the reader is comparing against a chart. Here it would
 * imply a measurement: these are wall-clock differences against a row's
 * `createdAt`/`updatedAt`, and "23 minutes" is the whole of what they support.
 *
 * Two functions rather than one because the same number is read two ways on
 * this page — a job has been queued FOR a duration, and a runner last worked
 * a duration AGO — and a single "… ago" string produced the sentence "queued
 * for 2 minutes ago".
 */
export function durationLabel(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return 'an unknown time';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 45) return 'less than a minute';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return countLabel(Math.max(1, minutes), 'minute');
  const hours = Math.round(minutes / 60);
  if (hours < 24) return countLabel(hours, 'hour');
  return countLabel(Math.round(hours / 24), 'day');
}

/** The same coarse elapsed time, read as a point in the past. */
export function agoLabel(ms: number): string {
  const span = durationLabel(ms);
  if (span === 'less than a minute') return 'just now';
  if (span === 'an unknown time') return 'at an unknown time';
  return `${span} ago`;
}
