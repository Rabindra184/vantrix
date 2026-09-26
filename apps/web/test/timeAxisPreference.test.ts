import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  readTimeAxisMode,
  TIME_AXIS_STORAGE_KEY,
  writeTimeAxisMode,
} from '../src/timeAxisPreference';

/** A `Storage` stand-in: the node project has no `localStorage` of its own. */
function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the time-axis preference', () => {
  it('is Offset when nothing is stored, Gatling Enterprise’s own default', () => {
    vi.stubGlobal('localStorage', memoryStorage());
    expect(readTimeAxisMode()).toBe('offset');
  });

  it('round-trips a choice', () => {
    const storage = memoryStorage();
    vi.stubGlobal('localStorage', storage);
    writeTimeAxisMode('datetime');
    expect(storage.getItem(TIME_AXIS_STORAGE_KEY)).toBe('datetime');
    expect(readTimeAxisMode()).toBe('datetime');
  });

  it('reads an unknown stored value as Offset', () => {
    vi.stubGlobal('localStorage', memoryStorage({ [TIME_AXIS_STORAGE_KEY]: 'wallclock' }));
    expect(readTimeAxisMode()).toBe('offset');
  });

  it('survives a storage that throws, in both directions', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    });
    expect(readTimeAxisMode()).toBe('offset');
    expect(() => writeTimeAxisMode('datetime')).not.toThrow();
  });
});
