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
 *
 * `named` is a value the URL asked for that the run never had
 * (`useReportFilter`). The hook reads it as every remote, so the charts are
 * right — but a reader who followed a link for one remote and sees all of
 * them deserves to be told why, in one line beside the control.
 *
 * Two additions for the Requests section's Group and Request pickers
 * (`useRequestsPick`):
 *
 *   - `labelOf` names a STORED value as a reader reads it: `''` is
 *     "(no group)", a nested group is `Catalog / Recommendations`. It names
 *     the options, the read-only field and the value a link asked for; the
 *     option's `value` stays the stored one, so `onChange` hands back what
 *     the URL holds.
 *   - `disabledReason` draws the select DISABLED, with that reason as a
 *     visible line beside it and as the select's description
 *     (`aria-describedby`). It wins over the 0 / 1 / many rule: the Request
 *     picker has nothing to list until a group is chosen, and a control that
 *     is simply absent does not tell the reader it exists or what unlocks it.
 *     The reason is text on screen, never only a `title` — a disabled control
 *     is out of the tab order, and a tooltip on it is unreachable by keyboard
 *     and invisible on touch (the rule `ChartActions` follows for its own
 *     refused items).
 */
export default function ReportFilterControl({
  label,
  allLabel,
  values,
  value,
  onChange,
  named,
  verb,
  labelOf = String,
  disabledReason,
}: {
  readonly label: string;
  /** The `*` option's words ("All remotes"). */
  readonly allLabel: string;
  /** The summary's own list, in its order. */
  readonly values: readonly string[];
  /** `useReportFilter`'s answer: one of `values`, or `*`. */
  readonly value: string;
  readonly onChange: (value: string) => void;
  /** A value the link named that the run does not have, or null. */
  readonly named: string | null;
  /** What the run would have had to do with it: "contacted", "resolved". */
  readonly verb: string;
  /** How a stored value reads; the value itself when absent. */
  readonly labelOf?: (value: string) => string;
  /** Why the control cannot be used yet; draws it disabled, described by this. */
  readonly disabledReason?: string;
}) {
  const note =
    named === null ? null : (
      <p data-testid="filter-unknown" className="text-[0.75rem] text-muted">
        This link named {labelOf(named)}, which this run never {verb}; showing {allLabel.toLowerCase()}.
      </p>
    );
  return (
    <div className="flex flex-col gap-1">
      <FilterField
        label={label}
        allLabel={allLabel}
        values={values}
        value={value}
        onChange={onChange}
        labelOf={labelOf}
        disabledReason={disabledReason}
      />
      {note}
    </div>
  );
}

function FilterField({
  label,
  allLabel,
  values,
  value,
  onChange,
  labelOf,
  disabledReason,
}: {
  readonly label: string;
  readonly allLabel: string;
  readonly values: readonly string[];
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly labelOf: (value: string) => string;
  readonly disabledReason: string | undefined;
}) {
  const id = useId();
  const reasonId = useId();
  const disabled = disabledReason !== undefined;
  if (!disabled && values.length === 0) return null;
  if (!disabled && values.length === 1) return <ReadOnlyField label={label}>{labelOf(values[0]!)}</ReadOnlyField>;
  return (
    <div className="flex items-center gap-2">
      <label htmlFor={id} className="shrink-0 text-[0.75rem] text-muted">
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        aria-describedby={disabled ? reasonId : undefined}
        className="min-w-0 rounded border border-default bg-surface px-2 py-1 text-sm text-primary disabled:cursor-not-allowed disabled:opacity-50"
      >
        <option value="*">{allLabel}</option>
        {values.map((v) => (
          <option key={v} value={v}>
            {labelOf(v)}
          </option>
        ))}
      </select>
      {disabled && (
        <span id={reasonId} className="text-[0.75rem] text-muted">
          {disabledReason}
        </span>
      )}
    </div>
  );
}
