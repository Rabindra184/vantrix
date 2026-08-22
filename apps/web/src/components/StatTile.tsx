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
 * THE UNIT IS A SEPARATE PROP, AND IT USED TO BE PART OF `value`. The old
 * rule was "`RunStats` builds strings like `228 ms` from `StatisticsTable`'s
 * own formatters, so a tile and the table row beneath it cannot disagree
 * about how a number is written; a `unit` prop would put half of that
 * formatting decision here."
 *
 * The formatting decision has NOT moved: `RunStats` still builds the NUMBER
 * with the table's own formatter and still passes it as `value`. What it now
 * passes separately is the noun — `ms`, `req/s` — which no formatter was ever
 * responsible for. Splitting them is what lets the number be set at the size
 * the redesign asks of it: `14.40 req/s` at 24px overflows a six-across tile,
 * which is exactly why the size was pinned at 20px before, and `14.40` does
 * not.
 *
 * The unit is still drawn NEXT TO the value rather than dropped, and that is
 * deliberate: a bare `187` on a dashboard of milliseconds and requests per
 * second is a number the reader has to go looking for the meaning of.
 */
export default function StatTile({
  label,
  value,
  unit,
  hint,
  tone,
  delta,
  'data-testid': testId,
}: {
  readonly label: string;
  readonly value: string;
  /** The noun after the number — `ms`, `req/s`. See the module docstring. */
  readonly unit?: string;
  readonly hint?: string;
  /**
   * How this metric stands against the SLA rule that targets it — and NOTHING
   * when no rule does.
   *
   * `undefined` is the common case and must stay the default: colouring a
   * number red is a JUDGEMENT, and the platform has only made one where a
   * rule exists to make it. A tile tinted on a hunch is the same overclaim as
   * a verdict badge on a run nobody has evaluated.
   */
  readonly tone?: 'breach' | 'near';
  readonly delta?: {
    readonly label: string;
    readonly tone: 'better' | 'worse' | 'neutral';
  };
  readonly 'data-testid'?: string;
}) {
  return (
    <div className="flex flex-col rounded-xl border border-default bg-surface p-4 shadow-panel">
      <dt className="text-[10px] font-semibold uppercase tracking-[0.1em] text-muted">{label}</dt>
      {/* 24px — `text-2xl leading-8`, the size the redesign's own screens set
          this number at — and it is the unit SPLIT that pays for it. The old
          20px was measured against `14.40 req/s`, eleven monospace characters,
          wrapping in the narrowest column the six-across grid produces
          (~167px at 1440). With the unit lifted out the number alone is five
          characters and clears that column, so it can be set at full size.
          The unit rides beside it at 12px, baseline aligned, muted: present
          for meaning, too small to compete.

          `text-primary` stays on the element and the inline `color` overrides
          it only when a tone is set, so an untinted tile is styled by class
          like everything else rather than by an inline neutral. */}
      <dd
        data-testid={testId}
        className="mt-2 flex items-baseline gap-1.5 font-mono text-2xl font-semibold leading-8 tracking-tight tabular-nums text-primary"
        style={{ color: toneColour(tone) }}
      >
        {value}
        {/* The space is a real text node, not decoration. Flex ignores
            whitespace between items so it costs nothing visually (`gap-1.5`
            draws the gap), but it keeps this `<dd>`'s text content reading
            `228 ms` rather than `228ms` — which is what a screen reader
            announces and what any assertion on the tile's text sees. */}
        {unit !== undefined && (
          <>
            {' '}
            <span className="text-[12px] font-medium tracking-normal text-muted">{unit}</span>
          </>
        )}
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

/**
 * The value's colour, from the status TEXT palette — the 4.5:1-gated family,
 * never the brighter `--chart-status-*` marks, which are fills.
 *
 * `undefined` returns undefined rather than a neutral hex, so the `<dd>`
 * inherits `text-primary` from the cascade and an untinted tile has no inline
 * colour at all.
 */
function toneColour(tone?: 'breach' | 'near'): string | undefined {
  if (tone === 'breach') return 'var(--color-status-failed)';
  if (tone === 'near') return 'var(--color-status-pending)';
  return undefined;
}
