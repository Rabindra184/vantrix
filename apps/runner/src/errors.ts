import type { RunnerJobError } from '@perfportal/persistence';

export class RunnerExecutionError extends Error {
  readonly code: string;
  readonly remediation: string;

  constructor(code: string, message: string, remediation: string) {
    super(message);
    this.name = 'RunnerExecutionError';
    this.code = code;
    this.remediation = remediation;
  }
}

export function toRunnerJobError(err: unknown): RunnerJobError {
  if (err instanceof RunnerExecutionError) {
    return { code: err.code, message: err.message, remediation: err.remediation };
  }
  if (err instanceof Error) {
    return {
      code: 'RUNNER_INTERNAL_ERROR',
      message: err.message,
      remediation:
        'Check the runner process logs, confirm the artifact is readable from RUNNER_ARTIFACT_DIR, and retry the job.',
    };
  }
  return {
    code: 'RUNNER_INTERNAL_ERROR',
    message: String(err),
    remediation: 'Check the runner process logs and retry the job.',
  };
}
