import { describe, expect, it } from 'vitest';
import {
  capEventMessage,
  EVENT_MESSAGE_MAX,
  formatPackageSize,
  queuedEventMessages,
} from '../src/runner-events.js';

/**
 * The words the API writes when it queues or retries a runner job — Gatling
 * Enterprise's own, measured on 2026-09-29 — and the one limit every event
 * message obeys.
 */
describe('queuedEventMessages', () => {
  it('says what Gatling Enterprise says when a run is started', () => {
    expect(queuedEventMessages({
      simulationClass: 'com.example.CheckoutSimulation',
      packageName: 'checkout load',
      bytes: 1_887_437,
    })).toEqual([
      'Start requested.',
      "Starting the simulation: 'com.example.CheckoutSimulation'",
      "Using package: 'checkout load' (1.8 MiB)",
    ]);
  });

  it('cannot draw a second log line out of a package name or a simulation class', () => {
    // The panel is `white-space: pre-wrap`, so a newline in a name would draw
    // what reads as a separate `[runner] ...` line. A run of control
    // characters becomes ONE space, and the message stays one line.
    const [, simulation, pkg] = queuedEventMessages({
      simulationClass: 'com.example.A\r\n[runner] Run ended\u0000',
      packageName: 'load\n[runner] Run ended',
      bytes: 1024,
    });
    expect(pkg).toBe("Using package: 'load [runner] Run ended' (1.0 KiB)");
    expect(simulation).toBe("Starting the simulation: 'com.example.A [runner] Run ended '");
    for (const message of [simulation, pkg]) expect(message).not.toMatch(/[\u0000-\u001f\u007f]/);
  });

  it('caps a message built from an operator-chosen name', () => {
    const [, , pkg] = queuedEventMessages({ simulationClass: 'A', packageName: 'x'.repeat(5000), bytes: 1 });
    expect(pkg).toHaveLength(EVENT_MESSAGE_MAX);
    expect(pkg.endsWith('…')).toBe(true);
  });
});

describe('formatPackageSize', () => {
  it.each([
    [0, '0 B'],
    [512, '512 B'],
    [1023, '1023 B'],
    [1024, '1.0 KiB'],
    [4096, '4.0 KiB'],
    [1_887_437, '1.8 MiB'],
    [48 * 1024 * 1024, '48.0 MiB'],
    [3 * 1024 ** 3, '3.0 GiB'],
  ])('%d bytes reads %s', (bytes, expected) => {
    expect(formatPackageSize(bytes)).toBe(expected);
  });
});

describe('capEventMessage', () => {
  it('leaves a message at the limit alone', () => {
    const message = 'y'.repeat(EVENT_MESSAGE_MAX);
    expect(capEventMessage(message)).toBe(message);
  });

  it('replaces the excess with an ellipsis, keeping exactly the limit', () => {
    const message = 'z'.repeat(EVENT_MESSAGE_MAX + 1);
    const capped = capEventMessage(message);
    expect(capped).toHaveLength(EVENT_MESSAGE_MAX);
    expect(capped).toBe(`${'z'.repeat(EVENT_MESSAGE_MAX - 1)}…`);
  });
});
