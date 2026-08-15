import type { ButtonHTMLAttributes, ReactNode } from 'react';

/**
 * The app's button, in three weights.
 *
 * WHY THIS EXISTS AT ALL, given the repo had been writing the classes inline:
 * there were five buttons across four files and four different spellings of
 * the same control — `rounded border border-default px-3 py-2`,
 * `… px-3 py-1`, `rounded bg-primary px-3 py-2 text-surface`, and one with
 * `disabled:opacity-60` while its neighbour had none. None of that was a
 * decision anyone made; it is what happens when a look is retyped. One
 * component is what makes "our buttons are 32px tall" a fact rather than an
 * average.
 *
 * THREE VARIANTS, and the important one is that there is exactly ONE
 * `primary` per screen (Apple HIG's single-primary-action rule). `secondary`
 * is the default because most buttons in a data product — Next, First page,
 * Check again — are peers, not the thing the page is for.
 *
 * THERE IS NO `danger` VARIANT, and its absence is a decision rather than an
 * omission. Nothing in this app destroys anything yet, and the red it would
 * need cannot be written as a utility: status colour is deliberately kept out
 * of `@theme` (see `test/tokens.test.ts`) precisely so nobody reaches for
 * `text-status-failed` and gets `--chart-status-failed`, a chart FILL that
 * fails contrast as text. A variant with no caller that also has to punch
 * through that rule is worth adding on the day something needs it, with the
 * token question answered then.
 *
 * NO `as`/`asChild` ESCAPE HATCH, and links are not buttons here. A `<Link>`
 * that looks like a button is still a link — it navigates, it opens in a new
 * tab on middle-click, and it must keep the link role the e2e suite selects
 * by. `linkButtonClasses` below is the shared LOOK for the places that
 * genuinely need it, with no change of element.
 */
type Variant = 'primary' | 'secondary' | 'ghost';
type Size = 'sm' | 'md';

const VARIANTS: Record<Variant, string> = {
  // `text-on-accent`, never `text-surface`. The two are both white in
  // light mode, which is how the old inline spelling looked correct — but in
  // dark mode the card is #101319 and the accent fill is a light indigo, so
  // `text-surface` on `bg-accent` was near-black on light-indigo where it
  // meant to be the reverse. The pair exists so the fill and its text move
  // together.
  //
  // `opacity`, not `brightness`, for the hover: a brightness filter lightens
  // the LABEL along with the fill (dropping its contrast exactly when the
  // pointer is on it), and it opens a stacking context that would clip the
  // focus outline's offset.
  primary: 'bg-accent text-on-accent shadow-panel hover:opacity-90 active:opacity-100',
  secondary:
    'border border-default bg-surface text-primary shadow-panel hover:bg-sunken active:bg-sunken',
  ghost: 'text-muted hover:bg-sunken hover:text-primary',
};

const SIZES: Record<Size, string> = {
  sm: 'h-8 gap-1.5 px-2.5 text-[13px]',
  // 36px, not 44. The WCAG 2.5.8 minimum is 24×24 CSS px and Apple's 44pt
  // guidance is for TOUCH; this is a desktop-first data product whose controls
  // are separated by more than 8px, and 44px-tall buttons in a table toolbar
  // read as a mobile app embedded in a dashboard. The coarse-pointer rule in
  // `tokens.css` is not what handles this — `min-h` below is: on a touch
  // device every button grows to 44px.
  md: 'h-9 gap-2 px-3 text-sm',
};

export default function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  children,
  className = '',
  disabled,
  ...props
}: {
  readonly variant?: Variant;
  readonly size?: Size;
  /**
   * An action in flight. Disables the button AND says so out loud — a
   * `disabled` control that merely stops responding is indistinguishable from
   * a broken one, which is what `aria-busy` and the spinner between them fix.
   */
  readonly loading?: boolean;
  readonly children: ReactNode;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      // Never inherits `submit` by accident. A `<button>` with no `type`
      // inside a `<form>` submits it, which is how a "Show data table" toggle
      // comes to reload a page.
      type="button"
      disabled={disabled === true || loading}
      aria-busy={loading || undefined}
      className={[
        'transition-ui inline-flex touch-manipulation items-center justify-center rounded-lg font-medium',
        // The touch rule, stated once. `pointer: coarse` is the finger case;
        // everything else keeps the denser desktop height above.
        '[@media(pointer:coarse)]:min-h-11',
        // `cursor-not-allowed` is deliberate and `pointer-events-none` is
        // deliberately absent: the second would also suppress the title/tooltip
        // that explains WHY a control is unavailable.
        'disabled:cursor-not-allowed disabled:opacity-50',
        SIZES[size],
        VARIANTS[variant],
        className,
      ].join(' ')}
      {...props}
    >
      {loading && <Spinner />}
      {children}
    </button>
  );
}

/**
 * The `secondary` look, for a `<Link>` that must stay a link.
 *
 * Not a component: wrapping `<Link>` would either lose its props or re-declare
 * them, and the one thing callers need is the class string.
 */
export const linkButtonClasses =
  'transition-ui inline-flex h-9 touch-manipulation items-center justify-center gap-2 rounded-lg border ' +
  'border-default bg-surface px-3 text-sm font-medium text-primary shadow-panel hover:bg-sunken ' +
  '[@media(pointer:coarse)]:min-h-11';

/**
 * `aria-hidden`, because the button already announces itself busy. A spinner
 * exposed to assistive tech is either silent (and pointless) or announces
 * "image" over the label.
 */
function Spinner() {
  return (
    <svg
      className="h-3.5 w-3.5 animate-spin"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="2" opacity="0.25" />
      <path
        d="M14.5 8A6.5 6.5 0 0 0 8 1.5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}
