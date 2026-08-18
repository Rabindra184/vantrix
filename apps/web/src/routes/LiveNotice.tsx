/**
 * What a section of the run page says when it genuinely has nothing to draw
 * yet — design part 2b §4.3 and §4.4.
 *
 * ═══ TWO KINDS, TWO DIFFERENT CLAIMS ═══
 *
 * `kind="withheld"` is for the three sections that cannot be live on ANY
 * path while a run streams — the statistics table, the response-time
 * distribution chart and the percentile-distribution chart. Each needs
 * per-endpoint rows or per-request data no delta ever carries (§1.3, §4.3),
 * so there is no version of this section, however small, that a socket could
 * feed. `subject` names WHICH one, the same way `DesktopOnly`'s `what` does:
 * a reader comparing three collapsed sections needs to tell them apart.
 *
 * `kind="finalizing"` is the different claim §4.4 makes: the run has
 * STOPPED streaming (the fold owner released it the moment status left
 * `running`) and REST does not have the final numbers yet either —
 * `MetricWriter` only runs once the parse pipeline does, after `close()`.
 * This is a banner drawn ABOVE a dashboard that is still fully populated
 * with its last delta, not a replacement for it — falling back to the
 * ordinary `Processing` screen there was rejected because it would take a
 * populated dashboard away and show a bare spinner at the exact moment
 * nothing has gone wrong.
 *
 * ═══ NEITHER IS A SPINNER ═══
 *
 * A spinner claims something is arriving. For `withheld` that is false on
 * every path until the run finishes; for `finalizing` the numbers ABOVE this
 * banner already arrived, and what is missing is a portion of a report a
 * background pipeline has not started writing, not a request in flight this
 * page is waiting on. `role="status"` announces the change without
 * interrupting, the same non-`alert` choice `DesktopOnly` makes for its own
 * layout notice — nothing here is a failure either.
 *
 * ═══ NO `<svg>` ═══
 *
 * `apps/web/e2e/run-charts.spec.ts` and `request-detail.spec.ts` prove a
 * chart drew by counting `<svg>` elements inside its `<figure>`; a decorative
 * icon on a notice that lands inside one of those figures would corrupt that
 * count. This component uses no icon at all, so it is safe wherever a caller
 * places it.
 */
export default function LiveNotice(
  props: { readonly kind: 'withheld'; readonly subject: string } | { readonly kind: 'finalizing' },
) {
  if (props.kind === 'finalizing') {
    return (
      <div
        role="status"
        data-testid="live-notice-finalizing"
        className="flex items-center gap-2 rounded-xl border border-default bg-surface px-4 py-3 text-[13px] text-muted"
      >
        <p>
          This run has finished streaming. Finalizing the results — this page will refresh with
          the full report once they are ready.
        </p>
      </div>
    );
  }

  return (
    <div
      role="status"
      data-testid="live-notice-withheld"
      className="flex flex-col gap-1.5 rounded-xl border border-dashed border-default bg-surface p-4"
    >
      {/* A `<p>`, not a heading — this is a caption for a notice, not a
          section of the page in its own right. A caller that wants this
          findable by heading navigation wraps it in its own `<h2>`/`<h3>`,
          the same way a chart's own withheld state is just a labelled
          `<figure>` and not a heading either. */}
      <p className="text-[13px] font-semibold text-primary">{props.subject}</p>
      <p className="text-[13px] leading-relaxed text-muted">
        Available when the run finishes — this run is still streaming, and this view needs data no
        live delta carries.
      </p>
    </div>
  );
}
