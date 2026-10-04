import InfoTip from '../components/InfoTip';

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
 * ═══ A TAG, WITH THE EXPLANATION BEHIND AN INFO (clean UI, PR 2) ═══
 *
 * The note stays VISIBLE — it changes how every number on the page is read,
 * which is the text rule's data-integrity exception — but as two words. The
 * sentence explaining it is the info's description: a screen reader gets it
 * on focus, a sighted reader one click away.
 *
 * ═══ RENDERED ONLY UNDER A WINDOW ═══
 *
 * With no window there is nothing to disclaim, and a permanent "these are
 * whole-run figures" on a page whose figures are always whole-run is noise —
 * the over-explanation review N04 spent four rows removing.
 */
export default function WholeRunNotice({ what }: { readonly what: string }) {
  return (
    <p data-testid="whole-run-notice" className="flex items-center gap-1 text-[0.8125rem] text-muted">
      <span className="rounded-md border border-default bg-sunken px-2 py-0.5">Whole-run figures</span>
      <InfoTip label="About whole-run figures">
        The time window you selected does not narrow {what} — these endpoints report the whole run. The run’s
        Report still honours it.
      </InfoTip>
    </p>
  );
}
