import { useMemo } from 'react';
import type { Narrowed } from './transforms/narrowed';

/**
 * The chart's `narrowed` pick as an object whose IDENTITY changes only when
 * the pick does — keyed on its three primitives, `kind`, `name` and `label`.
 *
 * Every narrowable chart builds its `data` in a `useMemo`, and `Chart`'s
 * option effect depends on `data` by identity. Keyed on the `narrowed` object
 * itself, a caller passing `narrowed={{ kind: 'group', name }}` inline built a
 * new object every render, so the transform re-ran, `setOption(…, notMerge)`
 * fired on every render, and the reader's legend toggles were reset. That is
 * the rule `Chart.tsx` states for `yAxis` and `xAxis`, which it spreads into
 * primitives for the same reason: compared by identity, an object literal at
 * the call site is a new value every time.
 *
 * Absent and `null` both come back as `null`: the transforms read them alike.
 */
export default function useStableNarrowed(narrowed: Narrowed | undefined): Narrowed {
  const kind = narrowed?.kind;
  const name = narrowed?.name;
  const label = narrowed?.label;
  return useMemo(() => {
    if (kind === undefined || name === undefined) return null;
    return label === undefined ? { kind, name } : { kind, name, label };
  }, [kind, name, label]);
}
