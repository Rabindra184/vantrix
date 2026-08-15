import type { ReactNode } from 'react';
import { AlertIcon, InboxIcon } from './icons';

/**
 * The three answers a data screen gives when it has no data: nothing here,
 * something broke, still waiting.
 *
 * WHY ONE MODULE. Before this, six routes each wrote their own — `<p>No runs
 * yet.</p>`, `<div role="alert">` with a heading, `<p role="status">Loading
 * run…</p>` — and they had drifted in every dimension that matters: some had
 * a heading and some a paragraph, some showed the server's `remediation` and
 * some dropped it, the alert on one page was a bare sentence and on another a
 * heading plus two paragraphs. None of that was decided; it is what six
 * separate writings of the same idea look like. What a reader needs is the
 * same on all six: what happened, what it means, and what to do next.
 *
 * THIS IS THE ONE FILE OUTSIDE `routes/marks.tsx` THAT PAINTS IN THE STATUS
 * PALETTE, and it is why `test/tokens.test.ts` exempts it. Status colour is
 * deliberately kept out of `@theme` so that no `text-status-failed` utility
 * exists to be reached for as a chart FILL — the fill palette
 * (`--chart-status-*`) is a different set of values from the text palette
 * (`--color-status-*`), see `charts/theme.ts`. Concentrating the one legitimate
 * text use here means the exemption covers a single component rather than
 * growing by one route every time a page learns to fail.
 *
 * `ErrorState` renders `role="alert"` and the other two do not, and the split
 * is deliberate. An alert interrupts a screen reader mid-sentence; that is
 * correct for "your data did not load" and wrong for "this project has no
 * runs", which is not an error at all — it is the answer. `LoadingState` uses
 * `role="status"`, which is polite and waits its turn.
 *
 * `titleAs` EXISTS BECAUSE A HEADING IS NOT A STYLE. These states appear in
 * two structurally different positions and the markup has to differ:
 *
 *   Under a page that still renders its own `<h1>` — the run list's error
 *   branch keeps "Runs" above it — the state's title is a paragraph. A second
 *   `<h1>` there would give the document two, and Playwright's
 *   `getByRole('heading', { level: 1 })` resolves to a strict-mode violation
 *   rather than to either of them.
 *
 *   Replacing the whole page — `RunDetail`'s three failure branches render
 *   nothing else at all — the title IS the page's heading and must be an
 *   `<h1>`, or the document has none and a screen-reader user navigating by
 *   heading finds an empty page.
 *
 * Defaulting to `p` is what makes the first case, which is the common one,
 * correct without anyone thinking about it.
 */

/**
 * The tinted warning disc — an alert icon in the status-failed colour, with a
 * wash and ring derived from it by `tint`.
 *
 * EXPORTED so that a page needing this mark inside its own layout does not
 * have to reach for the status token itself. `AuthGate`'s outage page is the
 * caller: it cannot use `ErrorState` wholesale, because its `role="alert"`
 * must wrap ONLY the two sentences the server sent and not the `<h1>` above
 * them (an assertive region containing a heading is announced as an
 * interruption instead of read as a title — see that component's docstring).
 * Without this export, `AuthGate` would need a fourth entry in
 * `test/tokens.test.ts`'s exemption list for one icon; with it, the count of
 * files allowed to paint in the status palette stays where it is.
 */
export function AlertMark() {
  return (
    <span className="tint flex h-11 w-11 items-center justify-center rounded-full border text-[color:var(--color-status-failed)]">
      <AlertIcon className="h-5 w-5" />
    </span>
  );
}

/**
 * There is nothing here, and that is the truthful answer rather than a
 * failure.
 *
 * Centred in a dashed box rather than left-aligned prose, because an empty
 * state that looks like body copy reads as a page that failed to finish
 * rendering. The dashed border says "a container, currently empty", which is
 * exactly the fact.
 */
export function EmptyState({
  title,
  titleAs = 'p',
  body,
  action,
}: {
  readonly title: string;
  readonly titleAs?: TitleElement;
  readonly body?: string;
  readonly action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-default px-6 py-14 text-center">
      <span className="flex h-11 w-11 items-center justify-center rounded-full bg-sunken text-muted">
        <InboxIcon className="h-5 w-5" />
      </span>
      <Title as={titleAs}>{title}</Title>
      {body !== undefined && (
        <p className="max-w-sm text-[13px] leading-relaxed text-muted">{body}</p>
      )}
      {action}
    </div>
  );
}

type TitleElement = 'p' | 'h1' | 'h2';

/**
 * One visual weight for the state's title whatever element it is. A heading
 * that looked bigger than a paragraph here would make the choice of element
 * a visual decision, which is exactly what it must not be.
 */
function Title({ as: Element, children }: { readonly as: TitleElement; readonly children: string }) {
  return <Element className="text-[15px] font-semibold tracking-tight text-primary">{children}</Element>;
}

/**
 * Something failed, in the server's own words.
 *
 * `detail` and `remediation` are separate props rather than one blob because
 * every `/v1` error is required to carry both and they say different things —
 * what happened, and what the reader can do about it. A component that
 * concatenated them would lose the ability to render the second more quietly
 * than the first, which is the whole reason the API sends two fields.
 *
 * NEVER invents copy. A caller with no `remediation` (a transport failure, a
 * schema mismatch) passes none, and this renders none, rather than
 * substituting "please try again later" and attributing it to a server that
 * said no such thing.
 */
export function ErrorState({
  title,
  titleAs = 'p',
  detail,
  remediation,
  remediationTestId,
  action,
}: {
  readonly title: string;
  readonly titleAs?: TitleElement;
  readonly detail?: string;
  readonly remediation?: string;
  /**
   * Names the remediation paragraph for a test.
   *
   * `RunDetail`'s error branch passes `problem-remediation`, which
   * `run-detail.spec.ts` asserts exists and is non-empty when the API answers
   * a 404 for a run in another organisation. That is a real requirement about
   * this app's behaviour — every `/v1` error carries a `remediation` and the
   * UI must actually show it — so the hook is a prop rather than something
   * stamped on unconditionally: a caller with no problem document has no
   * remediation to name, and a testid on an element that is not rendered
   * would make `toHaveCount(1)` pass for the wrong reason.
   */
  readonly remediationTestId?: string;
  readonly action?: ReactNode;
}) {
  return (
    <div
      role="alert"
      className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-default px-6 py-14 text-center"
    >
      <AlertMark />
      <Title as={titleAs}>{title}</Title>
      {detail !== undefined && (
        <p className="max-w-md text-[13px] leading-relaxed text-primary">{detail}</p>
      )}
      {remediation !== undefined && (
        <p data-testid={remediationTestId} className="max-w-md text-[13px] leading-relaxed text-muted">
          {remediation}
        </p>
      )}
      {action}
    </div>
  );
}

/**
 * Still waiting.
 *
 * `label` is announced; `children` is the sighted reader's placeholder (a
 * `Skeleton`, usually). When `children` is given the label goes `sr-only`, so
 * the page does not render the same sentence twice — see `Skeleton`'s
 * docstring on why both a live region and a skeleton, rather than either.
 */
export function LoadingState({
  label,
  children,
}: {
  readonly label: string;
  readonly children?: ReactNode;
}) {
  return (
    <>
      <p role="status" className={children === undefined ? 'text-muted' : 'sr-only'}>
        {label}
      </p>
      {children}
    </>
  );
}
