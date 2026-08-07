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

  it('caps at the limit and rolls the remainder into "other" preserving the total', () => {
    const r = new ErrorRollup();
    for (let i = 0; i < 250; i++) for (let k = 0; k <= i; k++) r.add(`msg-${i}`);
    const top = r.top(200);
    expect(top.length).toBe(201);                       // 200 + other
    expect(top.at(-1)!.message).toBe('other');
    const total = top.reduce((n, e) => n + e.count, 0);
    expect(total).toBe((250 * 251) / 2);
  });
});
