import { useId, type ReactNode } from 'react';

/**
 * A labelled value that is not a control: the one remote, the one hostname,
 * the load generator. Its own export because the Load generators section names
 * its machine this way whatever the run holds.
 */
export function ReadOnlyField({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <dl className="flex items-center gap-2">
      <dt className="shrink-0 text-[0.75rem] text-muted">{label}</dt>
      <dd className="min-w-0 break-all text-sm text-primary">{children}</dd>
    </dl>
  );
}

/**
 * A section filter (`?remote=`, `?hostname=` — `useReportFilter`), sized to
 * what the run has:
 *
 *   none        no control: there is nothing to choose and nothing to name
 *   one         a read-only field naming it — a select whose options all draw
 *               the same data is a control that does nothing (the rule
 *               `RunTelemetry`'s host picker already follows)
 *   two or more the select, "All …" first, whose value is `*` — the value the
 *               API takes as every one together
 *
 * The control's name is its `label` ("Remote", "Hostname"): one filter per
 * section, scoping every chart in it, so the section's own name is the context.
 */
export default function ReportFilterControl({
  label,
  allLabel,
  values,
  value,
  onChange,
}: {
  readonly label: string;
  /** The `*` option's words ("All remotes"). */
  readonly allLabel: string;
  /** The summary's own list, in its order. */
  readonly values: readonly string[];
  /** `useReportFilter`'s answer: one of `values`, or `*`. */
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  const id = useId();
  if (values.length === 0) return null;
  if (values.length === 1) return <ReadOnlyField label={label}>{values[0]}</ReadOnlyField>;
  return (
    <div className="flex items-center gap-2">
      <label htmlFor={id} className="shrink-0 text-[0.75rem] text-muted">
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="min-w-0 rounded border border-default bg-surface px-2 py-1 text-sm text-primary"
      >
        <option value="*">{allLabel}</option>
        {values.map((v) => (
          <option key={v} value={v}>
            {v}
          </option>
        ))}
      </select>
    </div>
  );
}
