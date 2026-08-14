/**
 * One headline number, in a bordered card: a label, its value, and an
 * optional hint line giving the reading behind it (§6's six run-page tiles).
 *
 * `data-testid` lands on the `<dd>`, not the outer element: the `<dd>` is the
 * one node that holds the actual measurement, and a test reading it gets the
 * value text directly rather than having to descend into the tile's markup —
 * the same reason `Card`'s own `data-testid` names the element the caller
 * asked for rather than an arbitrary wrapper.
 */
export default function StatTile({
  label,
  value,
  hint,
  'data-testid': testId,
}: {
  readonly label: string;
  readonly value: string;
  readonly hint?: string;
  readonly 'data-testid'?: string;
}) {
  return (
    <div className="rounded-lg border border-default bg-surface p-4">
      <dt className="text-xs font-medium uppercase tracking-wide text-muted">{label}</dt>
      <dd data-testid={testId} className="mt-1 text-2xl font-semibold tabular-nums">
        {value}
      </dd>
      {hint !== undefined && <p className="mt-1 text-xs text-muted">{hint}</p>}
    </div>
  );
}
