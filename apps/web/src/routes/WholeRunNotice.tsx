/**
 * "These figures are the whole run's" — for a page that carries a time window
 * in its URL and cannot honour it.
 *
 * ═══ WHY A PAGE NEEDS TO SAY THIS AT ALL ═══
 *
 * The request and group drill-downs keep `from`/`to` deliberately: a reader
 * arrives from a windowed table, and sending them back to an un-narrowed run
 * would discard the selection they were investigating with (`useWindowSuffix`,
 * and each page's own comment). But their endpoints take no `from`/`to` — the
 * figures they draw are the run's, whatever the URL says.
 *
 * So the window is VISIBLE in the address bar, was VISIBLE on the page the
 * reader came from, and silently does not apply here. That is the same
 * mistake `ErrorsTable` already corrects for its own totals and the same one
 * the run page's percentile note and SLA tint were corrected for: a number in
 * one scope under a context that claims another.
 *
 * ═══ RENDERED ONLY UNDER A WINDOW ═══
 *
 * With no window there is nothing to disclaim, and a permanent "these are
 * whole-run figures" on a page whose figures are always whole-run is noise —
 * the over-explanation review N04 spent four rows removing.
 */
export default function WholeRunNotice({ what }: { readonly what: string }) {
  return (
    <p
      data-testid="whole-run-notice"
      className="rounded-lg border border-default bg-sunken px-3 py-2 text-[0.8125rem] text-muted"
    >
      The time window you selected does not narrow {what} — these endpoints report the whole run.
      The run page’s own figures still honour it.
    </p>
  );
}
