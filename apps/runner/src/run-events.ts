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
