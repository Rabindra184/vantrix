import { useEffect, useState } from 'react';

/**
 * `value`, once it has stopped changing for `ms` milliseconds.
 *
 * The palette searches as the reader types, and a request per keystroke would
 * ask for `c`, `ch` and `che` when only the last was ever wanted — three
 * answers, two of them thrown away, and the slowest one free to land last and
 * overwrite the right one. Every change restarts the wait, so the value that
 * comes out is the one the reader paused on.
 *
 * The first render returns `value` itself, with no wait: there is nothing to
 * debounce before anything has changed, and a palette that opens empty must
 * not spend 150 ms showing something else first.
 */
export function useDebouncedValue<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}
