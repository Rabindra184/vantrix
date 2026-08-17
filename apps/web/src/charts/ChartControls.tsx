import type { ReactNode } from 'react';

/**
 * The controls a chart owns — bands, outcome, scale — as one labelled bar.
 *
 * ═══ WHY THESE ARE PRIMITIVES AND NOT THREE ROWS OF BARE BUTTONS ═══
 *
 * They used to be bare buttons in a `<div>` rendered ABOVE `<Chart/>`, which
 * put them OUTSIDE the card they drive. On the run page that produced a
 * floating cluster of chips sitting in the page background between two figures,
 * belonging visually to neither — and with two such clusters on one screen
 * (percentiles, and percentile distribution) there was nothing on screen tying
 * either set to the chart it controlled. They are now passed to `Chart` as
 * `controls` and drawn inside the figure, under its heading.
 *
 * ═══ THREE SEMANTICS, THREE SHAPES ═══
 *
 * The old buttons were one visual idiom for three different interactions, so a
 * multi-select (bands), a pick-one (outcome) and a binary toggle (scale) were
 * indistinguishable until operated. Each now looks like what it is:
 *
 *   `ChipGroup`      many-of-N — separate chips, each independently pressed
 *   `SegmentedGroup` one-of-N  — joined segments in a single track
 *   `SwitchControl`  on/off    — a track and a knob
 *
 * ═══ AND THEY SAY WHICH IS SELECTED ═══
 *
 * Selection was carried by border colour alone, which reads as
 * enabled-vs-disabled rather than on-vs-off — the unselected bands looked
 * greyed out rather than available. Selected controls now take the accent
 * border, the sunken fill and primary-weight text together, so the state
 * survives a glance and does not rest on one hairline.
 *
 * Every control keeps `aria-pressed` and its `data-testid`: that is the
 * contract the unit and Playwright suites already hold, and none of this
 * changes what the controls DO.
 */

/** The bar itself. Sits under the chart's heading, above the drawing. */
export function ControlBar({ children }: { readonly children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end gap-x-5 gap-y-3 border-b border-divider pb-3">
      {children}
    </div>
  );
}

/**
 * A named group of controls.
 *
 * The label is VISIBLE, where it used to be `sr-only`. A sighted reader had to
 * infer that `min 25% 50% …` were percentile bands and that `OK KO All` was an
 * outcome filter — an inference that gets harder, not easier, with two control
 * groups on one screen.
 *
 * `<legend>` inside a flex container is laid out inconsistently across
 * browsers, so the fieldset stays a block and only the inner row is flex.
 *
 * NO `uppercase` HERE, deliberately: Playwright computes accessible names with
 * `text-transform` applied, so a fieldset labelled `BANDS` could not be found
 * by the name `Bands` — the same trap `tableStyles.ts` and `SectionHeading.tsx`
 * both carry a comment about.
 */
export function ControlGroup({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <fieldset className="min-w-0">
      <legend className="mb-1.5 text-[11px] font-medium tracking-wide text-muted">{label}</legend>
      <div className="flex flex-wrap items-center gap-1">{children}</div>
    </fieldset>
  );
}

/**
 * NO focus styling here, deliberately. `tokens.css` carries one app-wide
 * `:focus-visible` rule — a 2px `--color-ring` outline at a 2px offset — and a
 * component restating it in utilities would be a second spelling of the same
 * treatment, free to drift from the first. It would also have to reach
 * `--color-ring` by arbitrary value, which `tokens.test.ts` gates against,
 * because that token is deliberately not published through `@theme`.
 */
const CHIP_BASE =
  'inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[13px] leading-none transition-colors';

/**
 * One chip in a many-of-N group.
 *
 * `swatch` is the colour of the series this chip turns on, drawn as a mark
 * beside the label. That is the other half of the problem the old chips had:
 * the chart drew ten ordered bands on a green-to-red ramp and the chips were
 * all the same colour, so a reader who wanted to know which line `95%` was had
 * to toggle it off and watch what disappeared.
 *
 * Passed as a CSS custom property NAME (`--chart-pct-p95`), not a resolved
 * hex: `var()` follows the theme through `tokens.css`'s three blocks on its
 * own, so the swatch repaints on a light/dark switch with no JS and no second
 * source of truth for a colour `theme.ts` already owns.
 */
export function Chip({
  pressed,
  swatch,
  testId,
  onClick,
  children,
}: {
  readonly pressed: boolean;
  readonly swatch?: string;
  readonly testId: string;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      data-testid={testId}
      onClick={onClick}
      className={`${CHIP_BASE} ${
        pressed
          ? 'border-accent bg-sunken font-medium text-primary'
          : 'border-default bg-surface text-muted hover:border-accent hover:text-primary'
      }`}
    >
      {swatch !== undefined && (
        <span
          // Decorative: the label beside it already names the band, and the
          // colour is a second encoding of it, never the only one.
          aria-hidden="true"
          className={`h-2.5 w-2.5 shrink-0 rounded-[3px] ${pressed ? '' : 'opacity-40'}`}
          style={{ backgroundColor: `var(${swatch})` }}
        />
      )}
      {children}
    </button>
  );
}

/**
 * A one-of-N control, drawn as joined segments so it cannot be mistaken for
 * the multi-select chips beside it.
 *
 * Still `aria-pressed` buttons rather than radios, matching what the suites
 * already assert and what the chips use — the DIFFERENCE this draws is between
 * "these combine" and "these replace each other", which is a visual claim, not
 * an ARIA one.
 */
export function Segmented({
  options,
  value,
  testId,
  onChange,
}: {
  readonly options: readonly { readonly value: string; readonly label: string }[];
  readonly value: string;
  /** Given the option's value, returns its `data-testid`. */
  readonly testId: (value: string) => string;
  readonly onChange: (value: string) => void;
}) {
  return (
    <div className="inline-flex overflow-hidden rounded-md border border-default">
      {options.map(({ value: option, label }, i) => (
        <button
          key={option}
          type="button"
          aria-pressed={value === option}
          data-testid={testId(option)}
          onClick={() => onChange(option)}
          className={`px-2.5 py-1 text-[13px] leading-none transition-colors ${
            i > 0 ? 'border-l border-default' : ''
          } ${
            value === option
              ? 'bg-accent font-medium text-on-accent'
              : 'bg-surface text-muted hover:text-primary'
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/**
 * A binary toggle, drawn as a switch.
 *
 * The scale control was previously a button reading `Log scale` / `Linear
 * scale`, styled identically to the outcome buttons next to it — so it looked
 * like a third member of a pick-one group whose other members had gone
 * missing, and its label named the CURRENT state while the buttons beside it
 * named the state they would SELECT. The label here is fixed and the knob
 * carries the state, which is the one arrangement that cannot be read
 * backwards.
 */
export function Switch({
  pressed,
  label,
  testId,
  onClick,
}: {
  readonly pressed: boolean;
  readonly label: string;
  readonly testId: string;
  readonly onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      data-testid={testId}
      onClick={onClick}
      className={`${CHIP_BASE} ${
        pressed
          ? 'border-accent bg-sunken font-medium text-primary'
          : 'border-default bg-surface text-muted hover:border-accent hover:text-primary'
      }`}
    >
      <span
        aria-hidden="true"
        className={`flex h-3.5 w-6 shrink-0 items-center rounded-full p-0.5 transition-colors ${
          pressed ? 'bg-accent' : 'bg-sunken'
        }`}
      >
        <span
          className={`h-2.5 w-2.5 rounded-full bg-surface transition-transform ${
            pressed ? 'translate-x-2.5' : ''
          }`}
        />
      </span>
      {label}
    </button>
  );
}
