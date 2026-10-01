import type { RunnerJobError } from '@perfportal/persistence';
import type { AbandonedOutcome } from './live-sink.js';
import type { ProcessResult } from './process.js';

/**
 * ═══ THE RUNNER'S HALF OF A RUN'S LOGS TAB ═══
 * (docs/superpowers/specs/2026-09-29-run-logs-design.md)
 *
 * `<reason>` in `Run injection ended with reason '<reason>'`. A signal wins
 * over an exit code: a killed process reports both, and the signal is what
 * happened to it.
 */
export function injectionEndReason(result: Pick<ProcessResult, 'code' | 'signal'>): string {
  if (result.signal !== null) return `Gatling was terminated by ${result.signal}`;
  if (result.code === 0) return 'Run completed normally';
  return `Gatling exited with code ${result.code ?? 'unknown'}`;
}

/**
 * ═══ WHETHER GATLING STOPPED BEFORE ITS SIMULATION DID ═══
 *
 * Gatling's own exit codes, read out of `io.gatling.app.cli.StatusCode` in
 * gatling-app 3.15.1: Success 0, InvalidArguments 1, AssertionsFailed 2. A
 * simulation that ran to its end therefore exits 0, or 2 when one of its own
 * assertions failed — and that run is complete. Anything else ended early: a
 * signal, a crash, or a SIGTERM the JVM handled itself, which it reports as
 * exit 143 with no signal at all (measured on a real kill), so the rule
 * cannot be "a signal was reported".
 */
export function endedEarly(result: Pick<ProcessResult, 'code' | 'signal'>): boolean {
  if (result.signal !== null) return true;
  return result.code !== 0 && result.code !== 2;
}

/**
 * Whether Gatling was TERMINATED rather than ending by itself: a signal, or an
 * exit code above 128, which is how a shell and a JVM both report one. A JVM
 * that handles SIGTERM exits 143 with NO signal reported (measured on a real
 * kill), so "a signal was reported" alone would call that an ordinary exit —
 * which is what sent a SIGTERM before Gatling's first flush to the
 * simulation-class advice.
 */
export function wasTerminated(result: Pick<ProcessResult, 'code' | 'signal'>): boolean {
  return result.signal !== null || (result.code ?? 0) > 128;
}

/**
 * ═══ THE JOB'S MESSAGE FOR A GATLING THAT ENDED EARLY ═══
 *
 * States the EVIDENCE — how the process ended, and that this is not what a
 * finished simulation's exit looks like — and NEVER a claim about the
 * simulation. Exit 1 can follow a finished simulation (an `after {}` hook that
 * throws, or the assertion re-read running out of memory), so "before the
 * simulation finished" would sometimes be false.
 */
export function endedEarlyMessage(result: Pick<ProcessResult, 'code' | 'signal'>): string {
  return `${injectionEndReason(result)} rather than a finished simulation's exit code (0, or 2 when a Gatling assertion failed).`;
}

/** What the job's remediation says about the run, by what became of its data. */
export function endedEarlyRemediation(outcome: AbandonedOutcome): string {
  const next = 'Check this job’s log and the host’s resource limits, then queue a new run.';
  if (outcome === 'kept') {
    return `The run keeps what it measured up to that point and is marked incomplete. ${next}`;
  }
  if (outcome === 'empty') {
    return `The run is marked incomplete without statistics: nothing it measured could be kept. ${next}`;
  }
  return `Another process had already closed the run, so it was left as that process found it. ${next}`;
}

/**
 * How the LOGS of a run end when Gatling ended early: the RUN did not fail —
 * it ended `incomplete`, keeping its data or not — so the line is not
 * `Run failed: …`, which is what the job (a different object, on the New
 * on-prem run page) is.
 */
export function endedEarlyEvent(
  result: Pick<ProcessResult, 'code' | 'signal'>,
  outcome: AbandonedOutcome,
): string {
  const kept = outcome === 'kept' ? 'What it measured was kept.' : 'Nothing it measured could be kept.';
  return `Run ended early: ${injectionEndReason(result)}. ${kept}`;
}

/**
 * How a failed run's log ends: `Run failed: <code>: <message>`.
 *
 * NEVER THE STORAGE KEY. `ARTIFACT_NOT_FOUND`'s message names the artifact's
 * path on the runner's disk, and that path contains the key; any token
 * carrying it becomes `<artifact>`. The job's own error, shown to an operator
 * on the New on-prem run page, keeps the path.
 */
export function failureEventMessage(
  error: Pick<RunnerJobError, 'code' | 'message'>,
  storagePath: string,
): string {
  // `!storagePath` rather than `=== ''`: a test double that omits the field
  // must not turn a job's failure into a crash of its catch block.
  const message = !storagePath
    ? error.message
    : error.message.replace(
      new RegExp(`\\S*${storagePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'g'),
      '<artifact>',
    );
  return `Run failed: ${error.code}: ${message}`;
}
