import '@testing-library/jest-dom/vitest';
import type { ErrorsResponse } from '@perfportal/contracts';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import ErrorsTable from '../src/tables/ErrorsTable.js';
import { OTHER_LABEL } from '../src/charts/transforms/errorSeries.js';
import fixture from './fixtures/reference-run.json';

/**
 * §13.2 ⑥ the errors table — Appendix A G-17 — rendered in jsdom against
 * `fixtures/reference-run.json`, the payload captured from the live API for the
 * real Gatling reference run.
 *
 * WHAT THIS FILE IS CAREFUL ABOUT. The brief's three example tests were
 * MEASURED against nine wrong implementations rather than assumed to
 * discriminate (the standing rule, 10 for 10 across this plan's earlier
 * tasks). This payload has TWO rows, and two rows is the smallest number on
 * which a shares-sum-to-100 assertion means almost nothing:
 *
 * - **"shares are of the TOTAL errors, so they sum to 100" stays GREEN for
 *   three different wrong formulas on this fixture** — all three run, all
 *   three green. 15 and 9 of 24 are 62.5% and 37.5%; SWAPPING them still sums
 *   to 100, an EVEN SPLIT (50/50, i.e. `100 / rows.length`) sums to 100, and
 *   so does the COMPLEMENT `(1 - count/total) * 100`, which on two rows IS the
 *   swap. The sum says only that the denominator is *some* constant; it never
 *   says which row got which share. It also never reads the rendered TEXT, so
 *   it is green against a table that displays the counts in the percentage
 *   column while `data-value` stays right.
 * - **"shows every distinct message with its count" never reads a count.** It
 *   is `getByText(message)` and nothing else. Measured green against a table
 *   that puts the counts under the Percentage heading, one that pairs every
 *   message with its NEIGHBOUR's count, and one that renders no numbers at all
 *   — messages in an otherwise empty table.
 * - "says so when a run had no errors" is the one that discriminates as
 *   written — it names the message AND the absence of the table, so a
 *   component returning `null` fails it (measured). It still says nothing
 *   about the non-empty case: a component rendering the empty message
 *   UNCONDITIONALLY, above a perfectly correct table, leaves all three of the
 *   brief's tests green, and only the negative added below catches it.
 *
 * All three are kept verbatim. Each is followed by the assertions that can
 * fail: the message→count and message→share pairings row by row, computed from
 * the payload; the render order; the exact column set; and the non-empty
 * case's negative. Nine mutations were run against the finished component and
 * every one is caught — the sharpest by a single test are the count-swap and
 * the unconditional empty message.
 *
 * THE FALSIFICATION CHECKPOINT (§9 checkpoint 5) IS LIVE ON THIS FIXTURE, and
 * that was checked rather than assumed, because the brief was right to doubt
 * it: `count / count` gives every row 100%, so two rows sum to 200 and the
 * brief's test does go red (4 red in total). It would be VACUOUS on a one-row
 * payload — 100 sums to 100 — which is why the constructed five-row payload
 * below exists as well: there the same mutation sums to 500, and the even
 * split and the swap are separable from the truth and from each other.
 *
 * TWO TESTS HERE PASS AGAINST A COMPONENT THAT RENDERS NOTHING, and both do so
 * honestly: the fixture precondition reads the payload rather than the DOM,
 * and "claims nothing about which endpoints a message occurred on" is a
 * NEGATIVE guarding a column that must never appear (D-8). The exact
 * column-set assertion beside it is the one that fails for an empty table.
 */

const errors = fixture.errors as ErrorsResponse;

/**
 * What a row's header cell reads.
 *
 * `null` is the folded remainder — every message past the top 200, summed —
 * and the table names it rather than leaving the cell blank. The label is
 * imported from the chart on the same tab so the two cannot drift.
 */
const labelOf = (message: string | null): string => message ?? OTHER_LABEL;
const RUN_ID = errors.runId;

/** The denominator every share is taken against — computed here, not imported. */
const TOTAL = errors.errors.reduce((n, e) => n + e.count, 0);

afterEach(cleanup);

/* ======================================================================== *
 * helpers — nothing below names a row; every expectation is the payload's
 * ======================================================================== */

const rows = (): HTMLElement[] => screen.queryAllByTestId('error-row');

const cellIn = (row: HTMLElement, column: string): HTMLElement => {
  const cell = row.querySelector(`[data-column="${column}"]`);
  if (!(cell instanceof HTMLElement)) {
    throw new Error(`an error row has no ${column} cell`);
  }
  return cell;
};

/** What a reader sees in a cell. */
const textIn = (row: HTMLElement, column: string): string => cellIn(row, column).textContent ?? '';

/** The exact number the cell carries beside its rounded text, or NaN for a gap. */
const valueIn = (row: HTMLElement, column: string): number =>
  Number(cellIn(row, column).getAttribute('data-value'));

const headers = (): string[] => screen.getAllByRole('columnheader').map((h) => h.textContent ?? '');

/** `message → count`, one string per rendered row, in render order. */
const renderedCounts = (): string[] =>
  rows().map((row) => `${textIn(row, 'message')} → ${textIn(row, 'count')}`);

/** `message → share`, one string per rendered row, in render order. */
const renderedShares = (): string[] =>
  rows().map((row) => `${textIn(row, 'message')} → ${valueIn(row, 'share').toFixed(4)}`);

/**
 * A payload built here, not captured — used only where the fixture's two rows
 * cannot separate a right answer from a wrong one.
 */
const payloadOf = (counts: readonly number[]): ErrorsResponse => ({
  runId: RUN_ID,
  errors: counts.map((count, i) => ({ message: `failure ${i}`, count })),
});

describe('ErrorsTable — the payload these assertions describe', () => {
  /**
   * THE PRECONDITION FIRST, for the same reason the clamp tests state theirs:
   * every assertion below is only as sharp as the fixture, and the fixture can
   * be re-captured. If a future capture returns one row, or two equal counts,
   * several tests here quietly stop being able to fail — this one says so
   * instead.
   */
  it('is the captured two-row payload, and its two shares are distinguishable', () => {
    expect(errors.errors).toEqual([
      { message: 'status.find.is(200), found 500', count: 15 },
      { message: 'status.find.is(200), found 503', count: 9 },
    ]);
    expect(TOTAL).toBe(24);

    const shares = errors.errors.map((e) => (e.count * 100) / TOTAL);
    // Distinct from EACH OTHER, so a swap is visible…
    expect(new Set(shares).size).toBe(shares.length);
    // …and distinct from the even split, so `100 / rows.length` is visible.
    for (const share of shares) expect(share).not.toBeCloseTo(100 / shares.length, 6);
    // …and none is 100, so `count / count` is visible.
    for (const share of shares) expect(share).not.toBeCloseTo(100, 6);
  });
});

describe('ErrorsTable — the shares (§9 checkpoint 5)', () => {
  /* ------------------------------------------------------------------ *
   * the brief's test, verbatim
   * ------------------------------------------------------------------ */

  it('shares are of the TOTAL errors, so they sum to 100', () => {
    render(<ErrorsTable errors={errors} />);
    const shares = screen
      .getAllByTestId('error-share')
      .map((el) => Number(el.getAttribute('data-value')));
    expect(shares.reduce((a, b) => a + b, 0)).toBeCloseTo(100, 1);
  });

  /**
   * The discriminating form: WHICH MESSAGE GOT WHICH SHARE, computed from the
   * payload. The sum above is satisfied by a swap, by an even split and by the
   * complement — measured, all three green — and none of them survives this.
   */
  it('gives each message its own share of the run total, not a share of anything else', () => {
    render(<ErrorsTable errors={errors} />);
    expect(renderedShares()).toEqual(
      errors.errors.map((e) => `${labelOf(e.message)} → ${((e.count * 100) / TOTAL).toFixed(4)}`),
    );
  });

  /**
   * The same, on a payload the fixture's two rows cannot stand in for: five
   * rows, a total (200) that is not the row count and not any row's count, and
   * shares that are pairwise distinct, none equal to the even split (20), and
   * none equal to its own count. On two rows the swap and the complement are
   * the same mutation; here they are not, and neither sums to 100 —
   * `count / count` sums to 500.
   */
  it('takes the same denominator when there are more than two messages', () => {
    const payload = payloadOf([100, 50, 30, 12, 8]);
    render(<ErrorsTable errors={payload} />);

    expect(renderedShares()).toEqual([
      'failure 0 → 50.0000',
      'failure 1 → 25.0000',
      'failure 2 → 15.0000',
      'failure 3 → 6.0000',
      'failure 4 → 4.0000',
    ]);
    const shares = rows().map((row) => valueIn(row, 'share'));
    expect(shares.reduce((a, b) => a + b, 0)).toBeCloseTo(100, 10);
    for (const share of shares) expect(share).not.toBeCloseTo(100 / shares.length, 6);
  });

  /**
   * The rounded text is what a reader compares against Gatling; the exact
   * number stays beside it — the same split `StatisticsTable` makes, so a
   * parity spec working from the API's own figures never has to reach back
   * into the payload.
   *
   * The literals are Gatling's own, read out of
   * `fixtures/gatling-3.15.1.2/reference-report/index.html`
   * (`table#container_errors`): 15 / 62.5% and 9 / 37.5%, in that order.
   */
  it('writes the share as Gatling s own errors table writes it', () => {
    render(<ErrorsTable errors={errors} />);

    expect(rows().map((row) => textIn(row, 'share'))).toEqual(['62.5%', '37.5%']);
    expect(rows().map((row) => valueIn(row, 'share'))).toEqual([62.5, 37.5]);
    expect(rows().map((row) => textIn(row, 'count'))).toEqual(['15', '9']);
  });

  /** A count of zero across the board is a division by zero, not `NaN%`. */
  it('shows a gap rather than NaN when nothing was counted', () => {
    render(<ErrorsTable errors={payloadOf([0, 0])} />);
    expect(rows().map((row) => textIn(row, 'share'))).toEqual(['—', '—']);
    expect(rows().map((row) => cellIn(row, 'share').getAttribute('data-value'))).toEqual([
      null,
      null,
    ]);
    // The messages and their counts are still there: the run recorded them.
    expect(renderedCounts()).toEqual(['failure 0 → 0', 'failure 1 → 0']);
  });
});

describe('ErrorsTable — the messages and their counts (G-17)', () => {
  /* ------------------------------------------------------------------ *
   * the brief's test, verbatim
   * ------------------------------------------------------------------ */

  it('shows every distinct message with its count', () => {
    render(<ErrorsTable errors={errors} />);
    for (const e of errors.errors) {
      expect(screen.getByText(labelOf(e.message))).toBeTruthy();
    }
  });

  /**
   * The discriminating form. The brief's test never reads a count at all —
   * measured: it is green against a table that renders the counts under the
   * percentage heading, and against one that pairs every message with the
   * wrong count. So: the PAIRING, row by row, from the payload, and the count
   * read out of the count column specifically.
   */
  it('pairs every message with its own count, in the count column', () => {
    render(<ErrorsTable errors={errors} />);
    expect(renderedCounts()).toEqual(errors.errors.map((e) => `${labelOf(e.message)} → ${e.count}`));
    expect(rows()).toHaveLength(errors.errors.length);
  });

  /**
   * MOST FREQUENT FIRST, which is the order the API hands over —
   * `packages/persistence/src/metrics/read.ts` orders `count DESC, message ASC`
   * — and the order Gatling's own errors table shows. The table renders what it
   * was given rather than re-deciding it: one answer to "what order are errors
   * in", in the place that already owns it.
   *
   * The precondition is asserted first, because a payload whose counts happen
   * to be equal, or already ascending, would make the render-order assertion
   * unable to see a reversal.
   */
  it('renders in the order it was given, which is most frequent first', () => {
    const counts = errors.errors.map((e) => e.count);
    expect(counts).toEqual([...counts].sort((a, b) => b - a));
    expect(new Set(counts).size).toBe(counts.length);

    render(<ErrorsTable errors={errors} />);
    expect(rows().map((row) => textIn(row, 'message'))).toEqual(errors.errors.map((e) => labelOf(e.message)));
  });
});

describe('ErrorsTable — the columns, and the one that is absent (D-8)', () => {
  /**
   * DEVIATION D-8, PINNED AS A DECISION.
   *
   * §13.2 ⑥ asks for "distinct error message, count, percentage of total
   * errors, **affected endpoint count**; expandable to per-endpoint
   * breakdown". `ErrorsResponse` is `{ message, count }` and carries nothing
   * that links a message to the endpoints it occurred on, so the fourth column
   * cannot be computed — and a column filled with a guess is worse than a
   * column that is not there.
   *
   * This asserts the EXACT column set, in order, so the absence is a fact the
   * suite states rather than something nobody wrote down: a fourth column
   * appearing — filled from anywhere — turns this red and sends whoever added
   * it to the deviation.
   */
  it('has exactly the three columns the payload can support', () => {
    render(<ErrorsTable errors={errors} />);
    // "Share of errors", not "Percentage" — review 09-13 M15. A bare
    // percentage carries no denominator, so the caption had to supply one and
    // a reader who took it for a share of REQUESTS was out by a factor of
    // thirty-seven. The header is where somebody looks when they wonder what a
    // column means.
    expect(headers()).toEqual(['Error', 'Count', 'Share of errors']);
    for (const row of rows()) expect(row.children).toHaveLength(3);
  });

  /** …and no cell anywhere claims to know which endpoint an error came from. */
  it('claims nothing about which endpoints a message occurred on', () => {
    render(<ErrorsTable errors={errors} />);
    expect(screen.queryByRole('columnheader', { name: /endpoint/i })).toBeNull();
    for (const row of rows()) expect(within(row).queryByText(/endpoint/i)).toBeNull();
  });
});

describe('ErrorsTable — the table itself', () => {
  /* ------------------------------------------------------------------ *
   * the brief's test, verbatim
   * ------------------------------------------------------------------ */

  it('says so when a run had no errors, rather than rendering an empty table', () => {
    render(<ErrorsTable errors={{ runId: RUN_ID, errors: [] }} />);
    expect(screen.getByText(/no errors/i)).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });

  /**
   * The other half of it, which the brief's test cannot see: a component that
   * renders "No errors were recorded" UNCONDITIONALLY, above a perfectly
   * correct table, passes every test in the brief. The empty message and the
   * table are alternatives, and this is the assertion that says so.
   */
  it('does not say a run had no errors while it is showing them', () => {
    render(<ErrorsTable errors={errors} />);
    expect(screen.queryByText(/no errors/i)).toBeNull();
    expect(screen.getByRole('table', { name: /error/i })).toBeTruthy();
    expect(rows()).toHaveLength(errors.errors.length);
  });

  /**
   * A real `<table>` with a caption that names it — house style, and what
   * makes `getByRole('table', { name: /errors/i })` find it here and in the
   * Playwright specs piece 8 writes. The message is the row's own header, so a
   * screen reader announcing "15" out of context can say which error it
   * belongs to.
   */
  it('is a table, named, with headers scoped as columns and the message as its row header', () => {
    render(<ErrorsTable errors={errors} />);

    const table = screen.getByRole('table', { name: /errors/i });
    expect(table.tagName).toBe('TABLE');
    for (const header of screen.getAllByRole('columnheader')) {
      expect(header.getAttribute('scope')).toBe('col');
    }
    expect(cellIn(rows()[0]!, 'message').getAttribute('scope')).toBe('row');
  });

  /**
   * THE CAPTION NAMES THE DENOMINATOR, and it is the same `total` the shares
   * are taken against, so the table cannot tell a reader it is showing shares
   * of 24 errors while dividing by something else. It also says the shares are
   * of the ERRORS and not of the run's requests — 24 of 895 requests failed,
   * and "62.5%" beside a failure count invites exactly that misreading.
   */
  it('says in the caption what the percentages are a percentage of', () => {
    render(<ErrorsTable errors={errors} />);
    const caption = screen.getByRole('table').querySelector('caption');
    expect(caption?.textContent).toMatch(/24 errors/);
    expect(caption?.textContent).toMatch(/most frequent first/i);

    cleanup();
    render(<ErrorsTable errors={payloadOf([100, 50, 30, 12, 8])} />);
    expect(screen.getByRole('table').querySelector('caption')?.textContent).toMatch(/200 errors/);
  });

  /** One error is one error, not "1 errors". */
  it('counts the denominator in the singular when there is one of it', () => {
    render(<ErrorsTable errors={payloadOf([1])} />);
    expect(screen.getByRole('table').querySelector('caption')?.textContent).toMatch(/1 error\b/);
    expect(rows().map((row) => textIn(row, 'share'))).toEqual(['100%']);
  });
});

describe('ErrorsTable — the folded remainder', () => {
  /**
   * `message: null` means "every message past the top 200, summed". It is the
   * shape that replaced a row literally messaged `'other'`, which collided with
   * a genuine error of that name and — against `run_error`'s unique key — took
   * the whole ingest down with it.
   *
   * The table has to name it. An empty header cell would read as a failure
   * that carried no message, which is a DIFFERENT thing the engine already
   * spells `(no message)`.
   */
  const withRemainder: ErrorsResponse = {
    runId: RUN_ID,
    errors: [
      { message: 'status.find.is(200), found 500', count: 15 },
      { message: null, count: 9 },
    ],
  };

  it('names the remainder instead of rendering a blank row header', () => {
    render(<ErrorsTable errors={withRemainder} />);
    expect(rows().map((row) => textIn(row, 'message'))).toEqual([
      'status.find.is(200), found 500',
      OTHER_LABEL,
    ]);
  });

  it('uses the same words the chart on this tab uses', () => {
    // Imported, not retyped. A reader seeing one label on the chart and
    // another in the table would reasonably conclude they are different things.
    expect(OTHER_LABEL).toBeTruthy();
    render(<ErrorsTable errors={withRemainder} />);
    expect(screen.getByText(OTHER_LABEL)).toBeTruthy();
  });

  it('counts the remainder toward the shares like any other row', () => {
    render(<ErrorsTable errors={withRemainder} />);
    const total = withRemainder.errors.reduce((n, e) => n + e.count, 0);
    expect(renderedShares()).toEqual(
      withRemainder.errors.map((e) => `${labelOf(e.message)} → ${((e.count * 100) / total).toFixed(4)}`),
    );
  });

  it('renders a real message called "other" as itself, beside the remainder', () => {
    // The exact collision this shape exists to prevent, now representable:
    // two rows, distinguishable, neither pretending to be the other.
    render(
      <ErrorsTable
        errors={{ runId: RUN_ID, errors: [{ message: 'other', count: 5 }, { message: null, count: 3 }] }}
      />,
    );
    expect(rows().map((row) => textIn(row, 'message'))).toEqual(['other', OTHER_LABEL]);
  });
});

/**
 * REVIEW C01 — A SCOPED EMPTY RESULT MUST NOT READ AS A WHOLE-RUN CONCLUSION.
 *
 * `RequestDetail` renders this same component over `errorsQuery(runId,
 * 'request', name)`. Search has no failures of its own, so the empty branch
 * fired and told the reader "No errors were recorded for this run" and "Every
 * request this run made came back OK" — while the parent run had 24 failed
 * requests out of 895.
 *
 * That is the worst failure this product can produce: not a broken screen, but
 * a confident and precisely wrong sentence. An engineer checking whether a
 * regression touched Search reads it as clearing the whole run.
 *
 * The component cannot know its own scope, so the caller has to say. Absence
 * of the prop keeps the whole-run wording, which is what the two run-level
 * call sites want.
 */
describe('ErrorsTable — the empty state says what it actually checked', () => {
  const none = { runId: RUN_ID, errors: [] };

  it('speaks for the run when nothing narrows it', () => {
    render(<ErrorsTable errors={none} />);
    expect(screen.getByText(/no errors were recorded for this run/i)).toBeInTheDocument();
  });

  it('names the scope instead of the run when given one', () => {
    render(<ErrorsTable errors={none} scopeLabel="Search" />);
    expect(screen.getByText(/no errors recorded for search/i)).toBeInTheDocument();
  });

  /** The specific sentence that was false. A request-scoped empty result says
   *  nothing whatsoever about the requests this run made. */
  it('never claims the whole run came back OK from a scoped empty result', () => {
    render(<ErrorsTable errors={none} scopeLabel="Search" />);
    expect(screen.queryByText(/every request this run made came back ok/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/for this run/i)).not.toBeInTheDocument();
  });

  /** Acceptance in the review: a scoped table with failures names that scope
   *  in its caption too, so a screenshot of it cannot be misread as the run's. */
  it('names the scope in the caption when there are rows', () => {
    render(
      <ErrorsTable
        errors={{ runId: RUN_ID, errors: [{ message: 'boom', count: 2 }] }}
        scopeLabel="Search"
      />,
    );
    expect(screen.getByRole('table', { name: /search/i })).toBeInTheDocument();
  });

  it('keeps the run wording in the caption when unscoped', () => {
    render(<ErrorsTable errors={{ runId: RUN_ID, errors: [{ message: 'boom', count: 2 }] }} />);
    const table = screen.getByRole('table');
    expect(table.textContent).toMatch(/recorded in this run/i);
  });
});

/**
 * REVIEW C03 — WHOLE-RUN TOTALS UNDER A WINDOW MUST SAY SO.
 *
 * `/v1/runs/:id/errors` takes no `from`/`to` at all — by construction, not by
 * omission: the endpoint's sibling comment explains it deliberately has no
 * scope parameters. So selecting 10–30s narrows the errors CHART and leaves
 * this table at the run's own 24, directly beneath it. Two figures, one
 * screen, different scopes, nothing saying which.
 *
 * Windowed error aggregation is a backend change; saying what the number
 * actually covers is not, and it is the half that stops a wrong reading today.
 */
describe('ErrorsTable — it says when a window does not reach it', () => {
  const rows = { runId: RUN_ID, errors: [{ message: 'boom', count: 2 }] };

  it('says nothing extra when no window is selected', () => {
    render(<ErrorsTable errors={rows} />);
    expect(screen.queryByTestId('errors-window-note')).not.toBeInTheDocument();
  });

  it('states that the selected window does not narrow these totals', () => {
    render(<ErrorsTable errors={rows} windowSelected />);
    expect(screen.getByTestId('errors-window-note')).toHaveTextContent(/whole run/i);
  });

  /** The empty state is the more dangerous one under a window: "no errors"
   *  plus a visible 10–30s selection reads as "no errors in that interval". */
  it('states it on the empty result too, where the misreading is worst', () => {
    render(<ErrorsTable errors={{ runId: RUN_ID, errors: [] }} windowSelected />);
    expect(screen.getByTestId('errors-window-note')).toHaveTextContent(/whole run/i);
  });
});

/**
 * REVIEW M09 — "ERRORS (2)" AND THE OCCURRENCE COUNT ARE BOTH TRUE.
 *
 * The tab counts distinct error MESSAGES; this line counts the occurrences
 * they sum to. Two numbers, an order of magnitude apart, neither labelled as
 * to which it is — so a reader reconciling them assumes one is wrong. The
 * table holds both already: `rows.length` and the `total` it divides its
 * shares by.
 *
 * ═══ AND THE LABEL IT SHIPPED WITH WAS THE ONE THING `total` IS NOT ═══
 *
 * It read "failed requests". A Gatling ERROR record — a session or EL
 * failure — is recorded in this payload and belongs to NO request, so it is
 * in `total` and in no row's `koCount`. Measured on a real 1,724-request
 * run: 310 recorded errors against 294 KO requests, a gap of 16, displayed
 * as "310 failed requests" on a page whose own KO tile read 294.
 *
 * ═══ WHY THESE CASES COULD NOT SEE IT ═══
 *
 * They assert against the reference fixture's 15 + 9 = 24 — the run where
 * `total` and `koCount` COINCIDE, because that simulation emits no
 * standalone ERROR record at all. So "24 failed requests" was true of the
 * fixture and false of the product, and pinning it verbatim is what would
 * have kept it. Asserted as a CLAIM now: this file already records that a
 * test pinning prose protects it from correction.
 */
describe('ErrorsTable — it distinguishes error types from occurrences', () => {
  const two = {
    runId: RUN_ID,
    errors: [
      { message: 'status.find.is(200), but actually found 500', count: 15 },
      { message: 'j.u.c.TimeoutException: Request timeout', count: 9 },
    ],
  };

  it('states both counts and names which is which', () => {
    render(<ErrorsTable errors={two} />);
    const tally = screen.getByTestId('errors-tally');
    expect(tally).toHaveTextContent(/2 error types/i);
    expect(tally).toHaveTextContent(/24 recorded errors/i);
  });

  it('reads in the singular for one of each', () => {
    render(<ErrorsTable errors={{ runId: RUN_ID, errors: [{ message: 'boom', count: 1 }] }} />);
    const tally = screen.getByTestId('errors-tally');
    expect(tally).toHaveTextContent(/1 error type/i);
    expect(tally).toHaveTextContent(/1 recorded error/i);
  });

  /**
   * THE TALLY AND THE CAPTION DESCRIBE ONE NUMBER AND MUST AGREE ABOUT IT.
   *
   * `total` appears twice in this component — once in the tally and once in
   * the caption, which has always called it "errors ... not of the requests
   * it made". The tally called the same number "failed requests". The claim
   * is the AGREEMENT, not either wording, so this asserts the noun the
   * caption uses is the noun the tally uses.
   *
   * ASSERTED AS A PAIR. The absence alone ("the tally does not say failed
   * requests") passes against a tally that failed to render at all, and the
   * presence alone passes against one that says both.
   */
  it('calls the occurrence count what the caption calls it, never failed requests', () => {
    render(<ErrorsTable errors={two} />);
    const tally = screen.getByTestId('errors-tally');
    const caption = screen.getByRole('table', { name: /errors/i }).textContent ?? '';

    expect(tally).toHaveTextContent(/24 recorded errors/i);
    expect(tally.textContent ?? '').not.toMatch(/failed requests?/i);

    // The caption's own claim about the same number, unchanged by this fix —
    // it is the half that was right.
    expect(caption).toMatch(/24 errors/i);
    expect(caption).toMatch(/not of the requests it made/i);
  });

  it('says nothing at all when there are no errors', () => {
    render(<ErrorsTable errors={{ runId: RUN_ID, errors: [] }} />);
    expect(screen.queryByTestId('errors-tally')).not.toBeInTheDocument();
  });
});
