import { describe, expect, it } from 'vitest';
import { isExact } from '../src/routes/statsMethod.js';

describe('isExact', () => {
  it('is true only for exact-v1; absent (an older API) is not exact', () => {
    expect(isExact('exact-v1')).toBe(true);
    expect(isExact('estimated')).toBe(false);
    expect(isExact(undefined)).toBe(false);
  });
});
