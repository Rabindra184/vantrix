import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * `value`, once it has stopped changing for `ms` milliseconds — and a `flush`
 * that ends the wait now.
 *
 * The palette searches as the reader types, and a request per keystroke would
 * ask for `c`, `ch` and `che` when only the last was ever wanted — three
 * answers, two of them thrown away, and the slowest one free to land last and
 * overwrite the right one. Every change restarts the wait, so the value that
 * comes out is the one the reader paused on.
 *
 * `flush` is for a reader who does not pause: Enter pressed inside the wait
 * means "this is what I typed", so the wait is over. It hands out the latest
 * value through the same state the timer would have set — one timer, never a
 * second racing it — and cancels that timer, which is tidiness rather than a
 * guard: had it fired, it would have set the value just flushed, a no-op.
 *
 * The first render returns `value` itself, with no wait: there is nothing to
 * debounce before anything has changed, and a palette that opens empty must
 * not spend 150 ms showing something else first.
 */
export function useDebouncedValue<T>(value: T, ms: number): readonly [T, () => void] {
  const [debounced, setDebounced] = useState(value);
  const latest = useRef(value);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    latest.current = value;
    timer.current = setTimeout(() => {
      timer.current = null;
      // A function updater, so a `T` that is itself a function is stored, not called.
      setDebounced(() => value);
    }, ms);
    return () => {
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
    };
  }, [value, ms]);

  const flush = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    setDebounced(() => latest.current);
  }, []);

  return [debounced, flush] as const;
}
