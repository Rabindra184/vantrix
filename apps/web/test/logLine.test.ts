import { describe, expect, it } from 'vitest';
import { highlightLogMessage } from '../src/routes/logLine';

/**
 * Gatling Enterprise's Logs tab highlights quoted values and numbers. The
 * split is lossless — the segments always rejoin into the message — so the
 * highlight can never change what a line says.
 */
describe('highlightLogMessage', () => {
  it('marks a quoted value and a number, and nothing else', () => {
    expect(highlightLogMessage("Using package: 'checkout load' (1.8 MiB)")).toEqual([
      { text: 'Using package: ', value: false },
      { text: "'checkout load'", value: true },
      { text: ' (', value: false },
      { text: '1.8', value: true },
      { text: ' MiB)', value: false },
    ]);
  });

  it('keeps a number inside quotes in its quoted value', () => {
    expect(highlightLogMessage("Claimed by the runner on 'node-12'")).toEqual([
      { text: 'Claimed by the runner on ', value: false },
      { text: "'node-12'", value: true },
    ]);
  });

  it('marks an exit code', () => {
    expect(highlightLogMessage('Gatling exited with code 137').at(-1)).toEqual({ text: '137', value: true });
  });

  it('does not mark digits inside a word', () => {
    expect(highlightLogMessage('job e0b6ec was SIGKILLed')).toEqual([{ text: 'job e0b6ec was SIGKILLed', value: false }]);
  });

  it('loses nothing', () => {
    for (const message of ["Starting the simulation: 'example.ParitySimulation'", 'Run ended', "Run injection ended with reason 'Gatling exited with code 2'"]) {
      expect(highlightLogMessage(message).map((s) => s.text).join('')).toBe(message);
    }
  });
});
