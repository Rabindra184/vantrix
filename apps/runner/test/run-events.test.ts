import { describe, expect, it } from 'vitest';
import { failureEventMessage, injectionEndReason } from '../src/run-events.js';

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
