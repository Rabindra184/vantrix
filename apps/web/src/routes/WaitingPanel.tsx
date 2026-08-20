import type { RunProcessing } from '@perfportal/contracts';
import { Marked, STATUS } from './marks';

/**
 * What a tab shows when the run has produced nothing to draw yet.
 *
 * THE MIDDLE OF THE OLD `Processing` SCREEN, and only the middle. That
 * component's `<h1>` and its "Back to all runs" link are now the run header's
 * and the breadcrumb's job, because this panel renders INSIDE the shell rather
 * than instead of it. Its polling-cap block moved to the status strip, which
 * is where a fact about the page having stopped polling belongs — this
 * component takes no `capReached` prop, and never will; that affordance is
 * `LiveStatusStrip`'s alone.
 *
 * THE "CHECKS AGAIN" REASSURANCE LIVES IN `LiveStatusStrip` TOO, not here —
 * that was tried once (Task 7) and reverted (Task 7 fix round 1). This panel
 * has no way to learn `capReached` (no tab's outlet context carries it), so
 * showing "there is nothing to do" here unconditionally would keep saying so
 * directly under `LiveStatusStrip`'s OWN capped block once polling actually
 * had stopped — two contradictory claims on the same screen, which the old,
 * deleted `Processing` never produced (it showed exactly one or the other).
 * `LiveStatusStrip` owns both the reassurance and the capped block now, which
 * makes them structurally exclusive by construction rather than by two
 * components staying in sync some other way.
 *
 * THE STATUS MARK IS THE ILLUSTRATION, not a generic spinner. A spinner says
 * "something is happening"; this says which of `pending` and `parsing` is
 * happening, which is the one fact a reader can act on — a run stuck in
 * `pending` never reached the worker.
 *
 * The colour arrives as DATA on the `Mark`, through an inline `style`. That is
 * the same route `Marked` and `Badge` take and the reason `routes/marks.tsx`
 * is exempt from the arbitrary-value gate in `test/tokens.test.ts`; a token
 * written in here as a Tailwind arbitrary value would trip that gate, and not
 * only on a technicality — it would be a second place to edit on the day
 * `pending` and `parsing` stop sharing a colour.
 */
export default function WaitingPanel({ status }: { readonly status: RunProcessing['status'] }) {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-3 rounded-xl border border-dashed border-default px-6 py-14 text-center">
      <span
        className="tint relative flex h-11 w-11 items-center justify-center rounded-full border"
        style={{ color: STATUS[status].colour }}
      >
        <span className="absolute inset-0 animate-ping rounded-full bg-current opacity-20" />
        <span aria-hidden="true" className="relative text-lg leading-none">
          {STATUS[status].glyph}
        </span>
      </span>

      {/* `role="status"` on the sentence that changes, so a screen reader hears
          the transition rather than only the first paint. */}
      <p role="status" className="text-[13px] text-muted">
        This run is still processing.
      </p>
      <p className="text-[13px]">
        <Marked mark={STATUS[status]} />
      </p>
    </div>
  );
}
