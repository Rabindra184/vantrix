export default function StatTile({
  label,
  value,
  hint,
  testId,
}: {
  readonly label: string;
  readonly value: string;
  readonly hint?: string;
  readonly testId?: string;
}) {
  return (
    <div className="rounded-lg border border-default bg-surface p-4">
      <dt className="text-xs font-medium uppercase tracking-wide text-muted">{label}</dt>
      <dd data-testid={testId} className="mt-1 text-2xl font-semibold tabular-nums">
        {value}
      </dd>
      {hint !== undefined && <p className="mt-1 text-xs text-subtle">{hint}</p>}
    </div>
  );
}
