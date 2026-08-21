/**
 * One headline number, in a bordered card: a label, its value, and an
 * optional hint line giving the reading behind it (§6's six run-page tiles).
 *
 * `data-testid` lands on the `<dd>`, not the outer element: the `<dd>` is the
 * one node that holds the actual measurement, and a test reading it gets the
 * value text directly rather than having to descend into the tile's markup —
 * the same reason `Card`'s own `data-testid` names the element the caller
 * asked for rather than an arbitrary wrapper.
 *
 * THE VALUE IS SET IN THE MONO FAMILY WITH TABULAR FIGURES. Six tiles sit in
 * one row and a reader compares them by scanning across; in a proportional
 * face `1` is narrower than `8`, so `895` and `228` centre differently and the
 * row visibly wobbles as the numbers change on a poll. `tabular-nums` fixes
 * the advance width and the mono family fixes the shapes. This is the same
 * argument `tableStyles.ts` makes for the statistics columns — one rule, two
 * surfaces.
 *
 * THE UNIT IS PART OF `value`, not a prop. `RunStats` builds strings like
 * `228 ms` and `14.40 req/s` from `StatisticsTable`'s own formatters, and the
 * whole point of that (see `RunStats`' docstring) is that a tile and the table
 * row beneath it cannot disagree about how a number is written. A `unit` prop
 * would put half of that formatting decision here.
 */
export default function StatTile({
  label,
  value,
  hint,
  delta,
  'data-testid': testId,
}: {
  readonly label: string;
  readonly value: string;
  readonly hint?: string;
  readonly delta?: {
    readonly label: string;
    readonly tone: 'better' | 'worse' | 'neutral';
  };
  readonly 'data-testid'?: string;
}) {
  return (
    <div className="flex flex-col rounded-xl border border-default bg-surface p-4 shadow-panel">
      <dt className="text-[10px] font-semibold uppercase tracking-[0.1em] text-muted">{label}</dt>
      {/* 20px, not 24. MEASURED against the widest value these six tiles
          actually render — `14.40 req/s`, eleven monospace characters — in the
          narrowest column the six-across grid produces (~167px at 1440). At
          24px that string is ~190px and wraps to a second line, which pushes
          one tile's hint down and leaves the row's baselines visibly out of
          step; at 20px it fits. The headline still reads as the headline
          because nothing else in the tile is above 11px. */}
      <dd
        data-testid={testId}
        className="mt-2 font-mono text-xl font-semibold leading-none tracking-tight tabular-nums text-primary"
      >
        {value}
      </dd>
      {delta !== undefined && (
        <p
          className="mt-2 text-[11px] font-medium leading-none"
          style={{ color: deltaColour(delta.tone) }}
        >
          {delta.label}
        </p>
      )}
      {/* `mt-auto` pins the hint to the bottom, so six tiles of differing hint
          lengths in one grid row keep their VALUES on a common baseline
          instead of each floating below its own label. */}
      {hint !== undefined && <p className="mt-auto pt-2 text-[11px] leading-snug text-muted">{hint}</p>}
    </div>
  );
}

function deltaColour(tone: 'better' | 'worse' | 'neutral'): string | undefined {
  if (tone === 'better') return 'var(--color-status-passed)';
  if (tone === 'worse') return 'var(--color-status-failed)';
  return undefined;
}
