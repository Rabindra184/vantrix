import { describe, expect, it } from 'vitest';
import { ErrorRollup } from '../src/errors-rollup.js';

describe('ErrorRollup', () => {
  it('counts distinct messages, most frequent first', () => {
    const r = new ErrorRollup();
    for (let i = 0; i < 15; i++) r.add('found 500');
    for (let i = 0; i < 9; i++) r.add('found 503');
    expect(r.top()).toEqual([
      { message: 'found 500', count: 15 },
      { message: 'found 503', count: 9 },
    ]);
  });

  it('caps at the limit and rolls the remainder into one null row, preserving the total', () => {
    const r = new ErrorRollup();
    for (let i = 0; i < 250; i++) for (let k = 0; k <= i; k++) r.add(`msg-${i}`);
    const top = r.top(200);
    expect(top.length).toBe(201);                       // 200 + the remainder
    expect(top.at(-1)!.message).toBeNull();
    const total = top.reduce((n, e) => n + e.count, 0);
    expect(total).toBe((250 * 251) / 2);
  });

  it('does not collide when a real message is literally "other"', () => {
    // THE BUG THIS SHAPE EXISTS TO PREVENT. The remainder used to be a row
    // messaged 'other', appended unconditionally after the top slice. A run
    // with more than `limit` distinct messages, one of which is really called
    // "other" and frequent enough to be kept, produced TWO entries with that
    // message — and `run_error`'s UNIQUE (run_id, scope, name, message) turned
    // that into an aborted transaction and a lost run, not a mislabelled row.
    const r = new ErrorRollup();
    for (let i = 0; i < 5_000; i++) r.add('other');     // real, and the most frequent
    for (let i = 0; i < 250; i++) r.add(`msg-${i}`);    // 250 one-offs, so the cap bites

    const top = r.top(200);
    const messages = top.map((e) => e.message);
    expect(messages.filter((m) => m === 'other')).toHaveLength(1);
    expect(messages.filter((m) => m === null)).toHaveLength(1);

    // The real one keeps its own count; the remainder is separate and the
    // total still reconciles with everything added.
    expect(top.find((e) => e.message === 'other')!.count).toBe(5_000);
    expect(top.reduce((n, e) => n + e.count, 0)).toBe(5_000 + 250);
  });

  it('emits no remainder row when nothing was folded', () => {
    const r = new ErrorRollup();
    r.add('boom');
    expect(r.top(200).every((e) => e.message !== null)).toBe(true);
  });
});
