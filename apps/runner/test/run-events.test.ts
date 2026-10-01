import { describe, expect, it } from 'vitest';
import {
  endedEarly,
  endedEarlyEvent,
  endedEarlyMessage,
  endedEarlyRemediation,
  failureEventMessage,
  injectionEndReason,
  wasTerminated,
} from '../src/run-events.js';

describe('injectionEndReason — Gatling Enterprise’s words for how injection ended', () => {
  it('reads a clean exit as the run completing normally', () => {
    expect(injectionEndReason({ code: 0, signal: null })).toBe('Run completed normally');
  });

  it('names a non-zero exit code', () => {
    expect(injectionEndReason({ code: 2, signal: null })).toBe('Gatling exited with code 2');
  });

  it('names the signal, which wins over any code', () => {
    expect(injectionEndReason({ code: null, signal: 'SIGKILL' })).toBe('Gatling was terminated by SIGKILL');
    expect(injectionEndReason({ code: 143, signal: 'SIGTERM' })).toBe('Gatling was terminated by SIGTERM');
  });
});

/**
 * GATLING'S OWN EXIT CODES, read out of `io.gatling.app.cli.StatusCode` in
 * gatling-app 3.15.1: Success 0, InvalidArguments 1, AssertionsFailed 2. A
 * simulation that ran to its end exits 0 or 2; anything else, or a signal,
 * means the process ended before the simulation did. The JVM turns a SIGTERM
 * it handles into exit 143, which is the case a real kill produced — so the
 * rule cannot be "a signal was reported".
 */
describe('endedEarly — whether Gatling stopped before its simulation did', () => {
  it('reads a simulation that ran to its end as finished, its assertions failing or not', () => {
    expect(endedEarly({ code: 0, signal: null })).toBe(false);
    expect(endedEarly({ code: 2, signal: null })).toBe(false);
  });

  it('reads any other exit code as ending early, a JVM-handled SIGTERM included', () => {
    expect(endedEarly({ code: 143, signal: null })).toBe(true);
    expect(endedEarly({ code: 137, signal: null })).toBe(true);
    expect(endedEarly({ code: 1, signal: null })).toBe(true);
  });

  it('reads a signal as ending early, whatever code accompanies it', () => {
    expect(endedEarly({ code: null, signal: 'SIGKILL' })).toBe(true);
    expect(endedEarly({ code: 0, signal: 'SIGTERM' })).toBe(true);
  });
});

/**
 * A TERMINATION IS A SIGNAL OR AN EXIT CODE ABOVE 128. A JVM that handles
 * SIGTERM itself exits 143 with no signal reported, so the rule cannot be
 * "a signal was reported" — which sent a SIGTERM before Gatling's first flush
 * to "confirm the simulation class is correct".
 */
describe('wasTerminated — whether Gatling was killed rather than ending by itself', () => {
  it('reads a signal, or an exit code above 128, as a termination', () => {
    expect(wasTerminated({ code: null, signal: 'SIGKILL' })).toBe(true);
    expect(wasTerminated({ code: 143, signal: null })).toBe(true);
    expect(wasTerminated({ code: 137, signal: null })).toBe(true);
  });

  it('reads an ordinary exit code as an exit, a failing one included', () => {
    expect(wasTerminated({ code: 0, signal: null })).toBe(false);
    expect(wasTerminated({ code: 1, signal: null })).toBe(false);
    expect(wasTerminated({ code: 2, signal: null })).toBe(false);
    expect(wasTerminated({ code: 128, signal: null })).toBe(false);
  });
});

/**
 * THE JOB'S MESSAGE STATES THE EVIDENCE. Exit 1 can follow a simulation that
 * ran to its end — an `after {}` hook throwing, or the assertion re-read
 * running out of memory — so no sentence here may say where the simulation was.
 */
describe('endedEarlyMessage — the job’s failure for a Gatling that ended early', () => {
  it('says how the process ended and that it is not a finished simulation’s code', () => {
    expect(endedEarlyMessage({ code: 143, signal: null })).toBe(
      "Gatling exited with code 143 rather than a finished simulation's exit code (0, or 2 when a Gatling assertion failed).",
    );
    expect(endedEarlyMessage({ code: null, signal: 'SIGKILL' })).toBe(
      "Gatling was terminated by SIGKILL rather than a finished simulation's exit code (0, or 2 when a Gatling assertion failed).",
    );
  });

  it('never claims the simulation had not finished', () => {
    for (const result of [{ code: 1, signal: null }, { code: 143, signal: null }, { code: null, signal: 'SIGTERM' as const }]) {
      expect(endedEarlyMessage(result)).not.toMatch(/before the simulation|had not finished|died/i);
    }
  });
});

describe('endedEarlyEvent and endedEarlyRemediation — what became of the data', () => {
  it('ends the run’s log on the run’s outcome, which is not a failure', () => {
    expect(endedEarlyEvent({ code: 143, signal: null }, 'kept')).toBe(
      'Run ended early: Gatling exited with code 143. What it measured was kept.',
    );
    for (const outcome of ['empty', 'not_claimed'] as const) {
      expect(endedEarlyEvent({ code: null, signal: 'SIGKILL' }, outcome)).toBe(
        'Run ended early: Gatling was terminated by SIGKILL. Nothing it measured could be kept.',
      );
    }
  });

  it('tells the job’s reader only what the outcome supports', () => {
    expect(endedEarlyRemediation('kept')).toMatch(/keeps what it measured/);
    expect(endedEarlyRemediation('empty')).toMatch(/without statistics/);
    expect(endedEarlyRemediation('empty')).not.toMatch(/keeps what it measured/);
    expect(endedEarlyRemediation('not_claimed')).toMatch(/already closed the run/);
    expect(endedEarlyRemediation('not_claimed')).not.toMatch(/keeps what it measured/);
  });
});

describe('failureEventMessage — how a failed run ends its log', () => {
  const STORAGE = 'runner-artifacts/5f0c6a52-6d1e-4c1b-9b1e-2f5c7e8a9d10.jar';

  it('states the code and the message', () => {
    expect(failureEventMessage(
      { code: 'SIMULATION_LOG_NOT_FOUND', message: 'Gatling finished without producing a simulation.log file.' },
      STORAGE,
    )).toBe('Run failed: SIMULATION_LOG_NOT_FOUND: Gatling finished without producing a simulation.log file.');
  });

  it('never carries the artifact’s storage key, however the message spells its path', () => {
    expect(failureEventMessage(
      { code: 'ARTIFACT_NOT_FOUND', message: `Artifact file is not readable at /srv/perfportal/${STORAGE}.` },
      STORAGE,
    )).toBe('Run failed: ARTIFACT_NOT_FOUND: Artifact file is not readable at <artifact>.');
  });
});
