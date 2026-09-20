/**
 * Which word means what, on the run page — review N01's remaining half.
 *
 * ═══ WHY A GLOSSARY IS THE RIGHT ANSWER TO THE REST OF N01 ═══
 *
 * The finding asks the product to standardise its vocabulary and to "retain
 * OK/KO or Cnt/s only when explicitly needed for Gatling parity, with a
 * glossary". Three of its four steps standardised what could be standardised;
 * this one explains what deliberately could not.
 *
 * And that set is larger than it looks, because the statistics table is a
 * column-by-column MIRROR of Gatling's own HTML report — `Requests`,
 * `Executions`, `Total`, `OK`, `KO`, `Min`, `Max`, `Mean`, `Count`, `Error`
 * are byte-identical to `fixtures/gatling-3.15.1.2/reference-report/index.html`.
 * Renaming them would cost a reader the ability to read the two side by side,
 * which is the one thing that surface is for. So they stay, and this says why
 * in the reader's own words rather than leaving them to infer it.
 *
 * ═══ A `<details>`, FOR THE REASON N02's DISCLOSURE IS ONE ═══
 *
 * A `<summary>` contributes an ARIA group and NOT a heading, so the Overview
 * tab's heading outline — which `run-tables.spec.ts` asserts as the exact list
 * `['Platform gates', 'Simulation assertions', 'Statistics']` — is untouched.
 * An `<h2>` here would break that spec on every run; an `<h3>` would put a gap
 * in the outline a screen-reader user navigating by heading cannot explain.
 *
 * THE REJECTED PLACEMENTS, because each is the obvious one:
 *
 *   A route of its own. A glossary you navigate away to read is read by
 *   nobody at the moment of confusion — and it would need a rail entry, whose
 *   vocabulary is reserved (`ProjectRail`'s names may not be reused).
 *
 *   A dialog. Buys nothing a disclosure does not, and costs focus management
 *   plus the `m-auto`-under-preflight trap `ChartActions` already paid for.
 *
 *   `RunShell`, so every tab has it. The shell renders above the `<Outlet/>`,
 *   so it would follow the reader onto Trends and Compare, which use almost
 *   none of these words — and this repo already records that shell chrome is
 *   what must not grow casually.
 *
 * ═══ IT MOUNTS ON A PHONE, DELIBERATELY ═══
 *
 * Not behind `DesktopOnly` and not gated on `useIsCompact`. That rule exists
 * to stop a phone paying for ten ECharts instances and four payloads to draw
 * none of them; this is static text with no query, no chart and no table. It
 * also sits below everything `mobile.spec.ts` measures, so it can move no
 * pinned geometry — and a phone is where a reader has the LEAST room for
 * explanation in place.
 *
 * ═══ BESIDE N02's PERCENTILE DISCLOSURE, NOT ABSORBING IT ═══
 *
 * They answer different questions. That one is HOW a number is computed — a
 * sketch, accurate to within 1%, against a tool whose own p99 reads 9.47% low
 * on this fixture. This one is WHICH WORD names which quantity. Folding a
 * methodology paragraph behind a vocabulary summary buries it, and absorbing
 * it would move it into `RunStats`, the one Overview component that mounts on
 * a phone. The last entry cross-references it instead.
 */
export default function RunGlossary() {
  return (
    <details className="group mt-3" data-testid="run-glossary">
      <summary className="w-fit cursor-pointer list-none text-[0.75rem] font-medium text-accent hover:underline hover:underline-offset-2">
        <span className="group-open:hidden">Which word means what</span>
        <span className="hidden group-open:inline">Hide which word means what</span>
      </summary>
      <dl className="mt-2 flex max-w-3xl flex-col gap-2 text-[0.75rem] leading-relaxed text-muted">
        {ENTRIES.map(({ term, meaning }) => (
          <div key={term}>
            <dt className="font-medium text-primary">{term}</dt>
            <dd>{meaning}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

/**
 * ═══ EXPORTED, BECAUSE THIS LIST IS A CROSS-REFERENCE AND THOSE ROT ═══
 *
 * Every `term` below names a label some other file renders, which is exactly
 * the shape that went wrong twice while N01 was being done: the statistics
 * table's `Cnt/s` hint pointed at a run-totals label the tiles had just
 * deleted, and "Mint one under Access" pointed at a page renamed three
 * branches earlier. Prose that names another surface has no compiler and no
 * type, so it goes stale silently and stays wrong until somebody reads it.
 *
 * `RunGlossary.test.tsx` walks this array and requires each term to still
 * appear in the source that renders it. That is the guard the `req/s` bridge
 * never had, and it is why the terms live in an array rather than in JSX.
 */
export const ENTRIES: readonly { term: string; meaning: string }[] = [
  {
    term: 'OK, KO',
    meaning:
      'Gatling’s words for a successful and a failed execution. The statistics table keeps them so it can be read beside Gatling’s own report column by column — its headings are the same words in the same order. Everywhere else this product says successful and failed.',
  },
  {
    term: '% KO, Error rate',
    meaning:
      'One number: failed requests as a percentage of all requests. “% KO” is the statistics table’s column, “Error rate” is the run totals tile.',
  },
  {
    term: 'Cnt/s, Requests/s',
    meaning:
      'One measurement: completed events per second. Gatling counts an entry into a group as an event too, which is why its column says Cnt rather than Requests — on a group row this is groups per second, not requests.',
  },
  {
    term: 'Requests',
    meaning:
      'Two things on this tab. The totals tile is how many requests the run made; the statistics table’s first column is which request each row is about. The table’s Total column is the same number as the tile.',
  },
  {
    term: 'Executions',
    meaning:
      'The statistics table’s heading over Total, OK and KO. One execution is one request, or one entry into a group.',
  },
  {
    term: 'p95, 95th, 95%',
    meaning:
      'The same rank, spelled for its surface: p95 on a tile and in an SLA rule, 95th as a table column, 95% in a chart legend whose axis is itself a percentile.',
  },
  {
    term: 'Errors, recorded errors',
    meaning:
      'Three numbers here, none of them meant to match. The Errors tab counts distinct messages. The line under its heading counts recorded errors — every occurrence of those messages — so it is usually the larger, because one message can fail many requests. KO, in the run totals and the statistics table, counts requests that failed. Recorded errors can exceed KO as well: Gatling records a session or expression failure as an error in its own right, belonging to no request, so it is counted here and in nothing’s KO.',
  },
  {
    term: 'Platform gates, Simulation assertions',
    meaning:
      'Two systems judge this run. Platform gates are the SLA rules your organisation configured here; simulation assertions are what the test author wrote into the simulation itself. Only platform gates produce the release verdict.',
  },
  {
    term: 'Verdict',
    meaning:
      'What the platform gates concluded: passed, failed, or not evaluated when no rule applied. A simulation assertion never produces one — it has an outcome instead.',
  },
  {
    term: 'estimate',
    meaning:
      'The p95 and p99 tiles say estimate because percentiles are read from a sketch rather than counted. “How percentiles are measured”, up beside the tiles, says how close. They are also taken at the nearest rank, so a percentile here can differ from the same column in Gatling’s own report by a whole measurement — on a small sample that gap can be wide, and both numbers are right. Total, OK, KO, Min, Max and Mean are exact, and are what to diff the two reports on.',
  },
];
