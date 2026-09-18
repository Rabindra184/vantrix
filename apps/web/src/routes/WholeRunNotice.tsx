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

/**
 * "This verdict is the whole run's" -- for a gate or a simulation check shown
 * on a page whose STATISTICS are windowed.
 *
 * ═══ A DIFFERENT CLAIM FROM `WholeRunNotice`, WHICH IS WHY IT IS A SECOND
 *     COMPONENT AND NOT A PROP ═══
 *
 * That one is about an ENDPOINT: the drill-downs carry `from`/`to` and their
 * endpoints take none, so the figures CANNOT narrow. This one is about WHEN a
 * decision was made. A platform gate and a simulation assertion are evaluated
 * ONCE, at finalize, against the whole run -- there is no windowed verdict to
 * compute, and computing one would invent a judgement nobody configured. That
 * is the same line `RunStats` draws when it WITHHOLDS the SLA tint from a
 * windowed tile rather than recolouring it.
 *
 * ═══ AND ITS CLOSING SENTENCE HAS TO DIFFER ═══
 *
 * `WholeRunNotice` ends "The run page's own figures still honour it", which is
 * help for a reader who has LEFT the run page. Here the windowed figures are on
 * screen directly above: the reader does not need to be sent anywhere, they
 * need to know that the number and the verdict are scoped differently. Reusing
 * the other wording would answer a question nobody on this page is asking.
 *
 * ═══ RENDERED ONLY UNDER A WINDOW, AND ONLY WITH SOMETHING TO DISCLAIM ═══
 *
 * With no window there is nothing to say, and over an empty gate list there is
 * no verdict to scope -- both would be the over-explanation review N04 removed
 * four rows of.
 */
export function FinalizedVerdictNotice({ what }: { readonly what: string }) {
  return (
    <p
      data-testid="finalized-verdict-notice"
      className="rounded-lg border border-default bg-sunken px-3 py-2 text-[0.8125rem] text-muted"
    >
      {what} were decided when the run finished, against the whole run — the selected time window
      narrows the statistics on this page, not this verdict.
    </p>
  );
}
