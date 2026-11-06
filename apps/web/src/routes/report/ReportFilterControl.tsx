import { displayPath } from '@perfportal/contracts';
import { useId, type ReactNode } from 'react';

/**
 * Why a value a link asked for is not what the control shows (ruling R12).
 * A plain string is the first reason, which is all a remote or a hostname can
 * have.
 *
 *   unknown   the run never recorded it
 *   empty     a group the run cannot offer because it holds no requests
 *             (ruling R10a): recorded, or "(no group)" in a run where every
 *             request sits in a group
 *   outside   a request the run recorded that is not in `group`, the group
 *             the link named and the run offers (a stored path; `''` is no
 *             group)
 *
 * `within`, when present, is the group (a stored path) the control's values
 * are narrowed to — the Request picker under a picked group — so the note can
 * say what is shown in the value's place rather than "all requests".
 */
export type NamedValue = { readonly value: string; readonly within?: string } & (
  | { readonly reason: 'unknown' }
  | { readonly reason: 'empty' }
  | { readonly reason: 'outside'; readonly group: string }
);

/**
 * The note's sentence: what the link named, the true reason it is not shown,
 * and what is shown instead. A plain-string `named` on a filter with nothing
 * narrowed reads exactly as it always has, so Connections and DNS are
 * unchanged.
 *
 * What is shown instead is the value the control does show when it shows one
 * (a group with a single request answers that request), else every value in
 * the group it is narrowed to, else every value. "(no group)" is a set of
 * requests, not a group (ruling R9), so it is never called "the group (no
 * group)" or put after "not in". And where "(no group)" is the control's ONE
 * value — a run with no groups, whose Group field reads "(no group)" — what
 * is shown is the requests in no group: "all groups" there would name groups
 * the run does not have.
 */
function noteText(
  named: string | NamedValue,
  ctx: {
    readonly value: string;
    readonly values: readonly string[];
    readonly allLabel: string;
    readonly verb: string;
    readonly labelOf: (v: string) => string;
  },
): string {
  const n: NamedValue = typeof named === 'string' ? { value: named, reason: 'unknown' } : named;
  const all = ctx.allLabel.toLowerCase();
  const instead =
    ctx.value !== '*'
      ? ctx.labelOf(ctx.value)
      : ctx.values.length === 1 && ctx.values[0] === ''
        ? 'the requests in no group'
        : n.within === undefined
          ? all
          : n.within === ''
            ? 'the requests in no group'
            : `${all} in ${displayPath(n.within)}`;
  const why =
    n.reason === 'unknown'
      ? `which this run never ${ctx.verb}`
      : n.reason === 'empty'
        ? 'which holds no requests in this run'
        : n.group === ''
          ? 'which is not one of the requests in no group'
          : `which is not in ${displayPath(n.group)}`;
  return `This link named ${ctx.labelOf(n.value)}, ${why}; showing ${instead}.`;
}

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
 * them deserves to be told why, in one line beside the control. The Requests
 * pickers can name a value for other reasons than that (`NamedValue`), and
 * the line says the true one: a request the run recorded is "not in Cart",
 * never "never recorded".
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
  /** A value the link named that the control does not show, or null; a
   *  string is one the run never recorded. */
  readonly named: string | NamedValue | null;
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
        {noteText(named, { value, values, allLabel, verb, labelOf })}
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
