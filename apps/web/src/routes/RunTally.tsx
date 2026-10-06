import { needsAttention, type RunListResponse } from '@perfportal/contracts';
import InfoTip from '../components/InfoTip';

type RunListItem = RunListResponse['items'][number];

/**
 * ═══ A PAGE-LOCAL TALLY, AS ONE LINE (clean UI, PR 3) ═══
 *
 * Four counts over the rows on THIS page, between the filters and the list.
 * Keyset pagination never learns a total, so the counts cannot be the
 * filtered set's; they were demoted from four dashboard tiles to a caption
 * for that reason, and the clean-UI pass takes them the rest of the way: the
 * card, a description under each count and the "How counts work" disclosure
 * all go, and so does the scope line's run total WHERE the heading already
 * says it (All runs; see `showTotal`).
 *
 * WHAT STAYS VISIBLE is "On this page", because it changes what every number
 * beside it means. WHAT EACH COUNT INCLUDES, that a run can sit in two, and
 * that the counts cover this page alone ride behind one ⓘ — the trigger's
 * accessible description too, so a screen reader hears them on focus.
 *
 * "Needs attention" is the contract's own rule (`needsAttention` in
 * `@perfportal/contracts`), shared with the home page and the activity
 * endpoint, so the three cannot disagree about which runs count.
 *
 * All four always draw, zeros included, so the line keeps its shape from page
 * to page. Each count is its own `<div>` with a derived testid: the number,
 * its label, and nothing else.
 */
export default function RunTally({
  items,
  showTotal,
}: {
  readonly items: readonly RunListItem[];
  /**
   * Whether "On this page" also says how many runs that is. TRUE where no
   * heading above the list counts them — a project's list and a test's page
   * hide `RunList`'s heading — and false on All runs, whose heading already
   * says "23 runs" (final review, Important 2). Required, with no default: a
   * caller that forgot it would leave a page with no count at all, silently.
   */
  readonly showTotal: boolean;
}) {
  const counts = tally(items);
  return (
    <section
      aria-label="Run health on this page"
      className="flex flex-wrap items-baseline gap-x-5 gap-y-1 text-[0.75rem]"
    >
      <span data-testid="health-scope" className="font-medium text-muted">
        {showTotal
          ? `On this page · ${items.length} ${items.length === 1 ? 'run' : 'runs'}`
          : 'On this page'}
      </span>
      <Count label="Needs attention" value={counts.needsAttention} />
      <Count label="In flight" value={counts.inFlight} />
      <Count label="Passed gates" value={counts.passed} />
      <Count label="Unjudged" value={counts.unjudged} />
      <InfoTip label="About these counts">{COUNTS_INFO}</InfoTip>
    </section>
  );
}

/** In the Status badges' and filter's own words ("incomplete", "running"):
 *  one word per thing, so a reader can match a definition to a column. */
const COUNTS_INFO =
  'Needs attention: failed, incomplete, SLA verdict failed, or a simulation assertion failed. ' +
  'In flight: pending, parsing or running. Passed gates: SLA verdict passed. Unjudged: no verdict, ' +
  'or not evaluated. A run can sit in more than one count — Needs attention asks whether anything ' +
  'failed, Unjudged whether a gate reached a verdict. The counts cover this page only, not the ' +
  'whole list.';

function Count({ label, value }: { readonly label: string; readonly value: number }) {
  return (
    <div
      data-testid={`health-${label.toLowerCase().replace(/\s+/g, '-')}`}
      className="flex items-baseline gap-1.5"
    >
      <span className="font-mono text-[0.8125rem] font-semibold tabular-nums text-primary">
        {value}
      </span>
      <span className="text-muted">{label}</span>
    </div>
  );
}

function tally(items: readonly RunListItem[]) {
  return items.reduce(
    (next, run) => ({
      needsAttention: next.needsAttention + (needsAttention(run) ? 1 : 0),
      inFlight: next.inFlight + (isInFlight(run) ? 1 : 0),
      passed: next.passed + (run.verdict === 'passed' ? 1 : 0),
      unjudged: next.unjudged + (run.verdict === null || run.verdict === 'not_evaluated' ? 1 : 0),
    }),
    { needsAttention: 0, inFlight: 0, passed: 0, unjudged: 0 },
  );
}

function isInFlight(run: RunListItem): boolean {
  return run.status === 'pending' || run.status === 'parsing' || run.status === 'running';
}
