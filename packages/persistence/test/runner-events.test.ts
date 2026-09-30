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
      name: 'checkout load',
      bytes: 1_887_437,
    })).toEqual([
      'Start requested.',
      "Starting the simulation: 'com.example.CheckoutSimulation'",
      "Using package: 'checkout load' (1.8 MiB)",
    ]);
  });

  it('caps a message built from an operator-chosen name', () => {
    const [, , pkg] = queuedEventMessages({ simulationClass: 'A', name: 'x'.repeat(5000), bytes: 1 });
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
