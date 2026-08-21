import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../lib/cn';
import { SpinnerIcon } from './icons';

/**
 * The app's button, in three weights, as a cva variant map (shadcn/ui's
 * pattern: the variants are DATA, `cn` resolves conflicts by meaning).
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
export const buttonVariants = cva(
  [
    'transition-ui inline-flex touch-manipulation select-none items-center justify-center',
    'whitespace-nowrap rounded-lg font-medium',
    // The touch rule, stated once. `pointer: coarse` is the finger case;
    // everything else keeps the denser desktop heights below — 44px-tall
    // buttons in a table toolbar read as a mobile app embedded in a
    // dashboard, and WCAG 2.5.8's minimum is 24px for pointer targets.
    '[@media(pointer:coarse)]:min-h-11',
    // `cursor-not-allowed` is deliberate and `pointer-events-none` is
    // deliberately absent: the second would also suppress the title/tooltip
    // that explains WHY a control is unavailable.
    'disabled:cursor-not-allowed disabled:opacity-50',
    // An icon inside a button tracks the size variant's gap; `shrink-0` so a
    // narrow toolbar squeezes the label, never the glyph into an ellipse.
    '[&_svg]:shrink-0',
  ],
  {
    variants: {
      variant: {
        // `text-on-accent`, never `text-surface`. The two are both white in
        // light mode, which is how the old inline spelling looked correct —
        // but in dark mode the card is #101319 and the accent fill is a light
        // indigo, so `text-surface` on `bg-accent` was near-black on
        // light-indigo where it meant to be the reverse. The pair exists so
        // the fill and its text move together.
        //
        // `opacity`, not `brightness`, for the hover: a brightness filter
        // lightens the LABEL along with the fill (dropping its contrast
        // exactly when the pointer is on it), and it opens a stacking context
        // that would clip the focus outline's offset.
        primary: 'bg-accent text-on-accent shadow-panel hover:opacity-90 active:opacity-100',
        secondary:
          'border border-default bg-surface text-primary shadow-panel hover:bg-sunken active:bg-sunken',
        ghost: 'text-muted hover:bg-sunken hover:text-primary',
      },
      size: {
        sm: 'h-8 gap-1.5 px-2.5 text-[13px] [&_svg]:h-3.5 [&_svg]:w-3.5',
        // 36px, not 44 — see the coarse-pointer rule above for why the
        // desktop height stays dense.
        md: 'h-9 gap-2 px-3 text-sm [&_svg]:h-4 [&_svg]:w-4',
      },
    },
    defaultVariants: { variant: 'secondary', size: 'md' },
  },
);

export default function Button({
  variant,
  size,
  loading = false,
  children,
  className,
  disabled,
  ...props
}: {
  /**
   * An action in flight. Disables the button AND says so out loud — a
   * `disabled` control that merely stops responding is indistinguishable from
   * a broken one, which is what `aria-busy` and the spinner between them fix.
   */
  readonly loading?: boolean;
  readonly children: ReactNode;
} & VariantProps<typeof buttonVariants> &
  ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      // Never inherits `submit` by accident. A `<button>` with no `type`
      // inside a `<form>` submits it, which is how a "Show data table" toggle
      // comes to reload a page.
      type="button"
      disabled={disabled === true || loading}
      aria-busy={loading || undefined}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    >
      {/* The spinner is `aria-hidden` (icons.tsx's default), because the
          button already announces itself busy — a spinner exposed to
          assistive tech is either silent (and pointless) or announces
          "image" over the label. */}
      {loading && <SpinnerIcon className="h-3.5 w-3.5 animate-spin" />}
      {children}
    </button>
  );
}

/**
 * The `secondary` look, for a `<Link>` that must stay a link.
 *
 * Not a component: wrapping `<Link>` would either lose its props or
 * re-declare them, and the one thing callers need is the class string.
 */
export const linkButtonClasses = buttonVariants({ variant: 'secondary', size: 'md' });
