import type { RunnerJobError } from '@perfportal/persistence';
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
