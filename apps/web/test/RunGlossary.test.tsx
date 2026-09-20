// @vitest-environment jsdom
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import RunGlossary, { ENTRIES } from '../src/routes/RunGlossary';

afterEach(cleanup);

/** A repo-root-relative path, wherever the runner was invoked from. */
function fromRepo(rel: string): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i += 1) {
    if (existsSync(resolve(dir, rel))) return resolve(dir, rel);
    dir = resolve(dir, '..');
  }
  throw new Error(`could not find ${rel} from ${process.cwd()}`);
}

/**
 * ═══ REVIEW N01's LAST HALF, AND THE ONE THING THAT WILL BREAK IT ═══
 *
 * The glossary exists because three of N01's four steps standardised what
 * could be standardised and this one explains what deliberately could not —
 * chiefly the statistics table, which is a column-by-column mirror of
 * Gatling's own report and must stay that way to be readable beside it.
 *
 * EVERY ENTRY IS A CROSS-REFERENCE, which is precisely the shape that went
 * wrong twice while N01 was being done: the `Cnt/s` hint named a run-totals
 * label the tiles had just deleted, and "Mint one under Access" named a page
 * renamed three branches earlier. Prose that names another surface has no
 * compiler and no type — it goes stale in silence and stays wrong until
 * somebody reads it.
 *
 * So the load-bearing case here is not that the glossary renders. It is that
 * every word it defines is still a word the product says.
 */

/**
 * Where each defined WORD is rendered — one entry per headword, not per entry.
 *
 * ═══ PER-WORD, PER-FILE, AND A RED-VERIFY IS WHY ═══
 *
 * The first version mapped a whole entry to a LIST of files and searched their
 * concatenation. It passed when `Requests/s` was renamed away from the tile,
 * because the word still appeared — inside `StatisticsTable`'s hint, which
 * exists only to point AT that tile and would have been stale in the same
 * moment. A guard against stale cross-references that is satisfied by a stale
 * cross-reference is worth nothing, and only restoring the defect and watching
 * it pass revealed that.
 *
 * So each word names the file that actually renders it, and each is searched
 * alone. Comments are stripped first: a comment explaining a rename quotes the
 * word it replaced, and a source scan that counts prose as product reads the
 * documentation instead of the thing documented — `timeAxis.test.ts` learned
 * that one branch ago and `RunStats.test.tsx` an hour before it.
 */
const RENDERED_IN: Readonly<Record<string, string>> = {
  OK: 'apps/web/src/tables/StatisticsTable.tsx',
  KO: 'apps/web/src/tables/StatisticsTable.tsx',
  '% KO': 'apps/web/src/tables/StatisticsTable.tsx',
  'Error rate': 'apps/web/src/routes/RunStats.tsx',
  'Cnt/s': 'apps/web/src/tables/StatisticsTable.tsx',
  'Requests/s': 'apps/web/src/routes/RunStats.tsx',
  Requests: 'apps/web/src/tables/StatisticsTable.tsx',
  Executions: 'apps/web/src/tables/StatisticsTable.tsx',
  p95: 'apps/web/src/routes/RunStats.tsx',
  '95th': 'apps/web/src/tables/StatisticsTable.tsx',
  '95%': 'apps/web/src/charts/transforms/percentiles.ts',
  Errors: 'apps/web/src/tables/ErrorsTable.tsx',
  'recorded errors': 'apps/web/src/tables/ErrorsTable.tsx',
  'Platform gates': 'apps/web/src/routes/RunDetail.tsx',
  'Simulation assertions': 'apps/web/src/routes/RunDetail.tsx',
  Verdict: 'apps/web/src/routes/RunList.tsx',
  estimate: 'apps/web/src/routes/RunStats.tsx',
};

/**
 * ═══ AND ONE LABEL IS NOT A LITERAL ANYWHERE, WHICH THIS ALSO FOUND ═══
 *
 * `95th` is DERIVED: `percentileColumnLabel` reads the payload's own digits
 * and builds `${digits}${ordinalSuffix(...)}`, which is what lets a run
 * carrying p90 or p99.9 head its own columns. The word is genuinely on screen
 * and genuinely absent from the source, so a naive grep calls the glossary a
 * liar about a term it is right about.
 *
 * The guard names the PRODUCER for those instead. That is the honest check —
 * "something still builds this word" — and it fails just as loudly if the
 * derivation is deleted or renamed, which is the regression that would
 * actually strand the entry.
 */
const DERIVED: Readonly<Record<string, string>> = {
  '95th': 'percentileColumnLabel',
};

/** Every headword the glossary defines, in order. */
const WORDS = ENTRIES.flatMap((e) => e.term.split(',').map((w) => w.trim()));

const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

describe('RunGlossary — every word it defines is a word the product says', () => {
  /**
   * THE GUARD THE `req/s` BRIDGE NEVER HAD. Each entry names one or more
   * labels; every one of them must still appear in the file that renders it.
   * A rename anywhere in the product that leaves this list behind fails here,
   * naming the term and the file — which is the failure mode that shipped
   * twice in this review and was caught both times by a person reading the
   * page rather than by a suite.
   *
   * Terms are comma-separated headwords, so each is checked on its own: an
   * entry heading "Cnt/s, Requests/s" must find BOTH spellings, which is the
   * whole point of an entry that exists to bridge two of them.
   */
  it.each(WORDS)('still finds “%s” where the product renders it', (word) => {
    const file = RENDERED_IN[word];
    expect(file, `the glossary defines "${word}" and nothing says where it lives`).toBeDefined();

    const src = stripComments(readFileSync(fromRepo(file!), 'utf8'));
    const producer = DERIVED[word];
    if (producer !== undefined) {
      expect(src, `nothing builds "${word}" any more (was ${producer})`).toContain(producer);
      return;
    }
    expect(src, `"${word}" is defined by the glossary and rendered nowhere`).toContain(word);
  });

  /** A word nobody said where to find is a word nothing can check. */
  it('says where every headword lives, and defines nothing it cannot point at', () => {
    expect([...WORDS].sort()).toEqual(Object.keys(RENDERED_IN).sort());
  });
});

describe('RunGlossary — what it must not do to the page', () => {
  /**
   * NO HEADING, AT ANY LEVEL. `run-tables.spec.ts` asserts the Overview tab's
   * `<h2>` outline as the exact list ['Platform gates', 'Simulation
   * assertions', 'Statistics']; an `<h2>` here breaks that on every run, and
   * an `<h3>` puts a gap in the outline a screen-reader user navigating by
   * heading cannot explain. A `<summary>` contributes an ARIA group instead,
   * which is the mechanism N02's percentile disclosure already uses.
   */
  it('contributes no heading', () => {
    render(<RunGlossary />);
    expect(screen.queryByRole('heading')).toBeNull();
  });

  /** Closed, so it costs a reader who does not need it exactly one line. */
  it('starts closed', () => {
    render(<RunGlossary />);
    const details = screen.getByTestId('run-glossary') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(details.tagName).toBe('DETAILS');
  });

  /**
   * The summary flips its own words, the pattern `RunStats`' disclosure uses —
   * both spellings are in the DOM at all times and CSS chooses, so the
   * accessible name is stable and no state lives in JavaScript.
   */
  it('names the action it will perform, in both directions', () => {
    render(<RunGlossary />);
    const summary = screen.getByText('Which word means what');
    expect(summary).toBeInTheDocument();
    expect(screen.getByText('Hide which word means what')).toBeInTheDocument();
  });

  /**
   * A definition list, not paragraphs: the terms are the point, and a screen
   * reader announces a `<dl>`'s pairs as pairs.
   */
  it('pairs every term with a meaning', () => {
    const { container } = render(<RunGlossary />);
    const terms = container.querySelectorAll('dt');
    const meanings = container.querySelectorAll('dd');
    expect(terms.length).toBe(ENTRIES.length);
    expect(meanings.length).toBe(ENTRIES.length);
    expect(terms.length).toBeGreaterThan(5);
  });
});

/**
 * ═══ THE PARITY PROMISE HAS TO NAME ITS OWN EXCEPTION ═══
 *
 * The `OK, KO` entry tells a reader the statistics table can be read beside
 * Gatling's own report "column by column", and the module docstring says the
 * headings are byte-identical for exactly that purpose. True of the headings,
 * true of every exactly-tracked quantity — and NOT true of the percentile
 * columns, because the two products break the rank differently.
 *
 * MEASURED on a real 1,718-request run of the Gatling demo fixture: `List
 * Products` p99 reads 809 here and 1368 in Gatling's own report. Both are
 * right. Sorted, that request's tail is `… 435, 809, 1368, 1492, 1654` over
 * 300 samples, so the two answers are ONE ORDER STATISTIC apart — which in a
 * heavy tail is a 69% gap. The whole-run p99 diverges the other way (10617
 * here against Gatling's 7904, where the true nearest-rank value is 10513).
 *
 * So a reader who takes the promise at face value concludes this product is
 * wrong about its most scrutinised number. The glossary is where that is
 * cheapest to prevent, because it is already the page's answer to "why does
 * this word not mean what I expected".
 *
 * THE CLAIM IS ASSERTED AS A PAIR, and neither half is sufficient. A warning
 * with no exception list reads as "trust none of this table"; an exception
 * list with no warning is the promise that caused the problem. Asserted as a
 * CLAIM rather than as wording — this file already carries the lesson that
 * pinning prose verbatim is how a sentence becomes impossible to correct.
 */
describe('RunGlossary — the Gatling parity promise names its exception', () => {
  /** The entry that takes on the percentile/Gatling question, whichever it is. */
  const warning = ENTRIES.find(
    (e) => /percentile/i.test(e.meaning) && /gatling/i.test(e.meaning),
  );

  it('warns that a percentile here can differ from Gatling’s own report', () => {
    expect(
      warning,
      'no glossary entry connects percentiles to Gatling, so a reader diffing the two reports is unwarned',
    ).toBeDefined();
    expect(warning?.meaning, 'the entry mentions both but never says they can disagree').toMatch(
      /differ|disagree|not match|apart/i,
    );
  });

  it('names figures that are exact, so the warning does not read as “trust nothing”', () => {
    expect(
      warning?.meaning,
      'the warning never tells the reader which columns they CAN diff against Gatling',
    ).toMatch(/exact/i);
  });
});
