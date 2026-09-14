// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunListResponse } from '@perfportal/contracts';
import useIsCompact from '../src/useIsCompact';
import RunList from '../src/routes/RunList';

/**
 * ═══ REVIEW M18 — THE LIST, BELOW 768px ═══
 *
 * Measured in Chromium at 375x812 before this: the filter form was 314px, the
 * page-local tally's two caveats 117px, and the first run row began at
 * **y=908** — on an 812px screen, so nothing about any run was visible without
 * scrolling. The table itself then scrolled SIDEWAYS inside its box, so the
 * two columns triage actually turns on, p95 and Errors, were off the right
 * edge as well as below the fold.
 *
 * ═══ WHAT THESE CASES GUARD, AND IT IS NOT THE LAYOUT ═══
 *
 * jsdom lays everything out at 0x0, so nothing here can measure a height —
 * CLAUDE.md records that trap for `m-auto`, `truncate` and the decision band
 * alike. What jsdom CAN see is which elements exist, and every one of the
 * defects above is really a question about that: is the form inside a closed
 * disclosure, is the table replaced by a list, does the list still carry every
 * field the row did.
 *
 * The last is the one worth the most. A compact layout that quietly dropped a
 * column would be the harder failure to notice, because the reader has no way
 * to know what they are not being shown and would triage differently by
 * device. So the cases below assert the FIELDS, not the arrangement.
 */

vi.mock('../src/useIsCompact.js', () => ({ default: vi.fn(() => false) }));
const useIsCompactMock = vi.mocked(useIsCompact);

beforeEach(() => {
  useIsCompactMock.mockReset();
  useIsCompactMock.mockReturnValue(true);
});

afterEach(cleanup);

const ROWS: RunListResponse['items'] = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    status: 'complete',
    verdict: 'failed',
    tool: 'gatling',
    startedAt: '2026-08-15T10:00:00.000Z',
    toolStartedAt: '2026-08-15T09:00:00.000Z',
    project: { id: '22222222-2222-4222-8222-222222222222', slug: 'checkout', name: 'Checkout' },
    simulation: 'example.ParitySimulation',
    environment: 'staging',
    metrics: { p95Ms: 659.4, errorRate: 0.0268, count: 895, throughputRps: 14.4 },
  },
  {
    id: '33333333-3333-4333-8333-333333333333',
    status: 'pending',
    verdict: null,
    tool: 'gatling',
    startedAt: '2026-08-15T11:00:00.000Z',
    toolStartedAt: null,
    project: { id: '22222222-2222-4222-8222-222222222222', slug: 'checkout', name: 'Checkout' },
    simulation: null,
  },
] as unknown as RunListResponse['items'];

function renderList(items = ROWS, initialEntry = '/runs') {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ items, nextCursor: null }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    ),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <RunList />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('RunList — the filters fold away on a phone', () => {
  it('collapses them by default, and does not render a table', async () => {
    renderList();
    const details = await screen.findByTestId('compact-filters');
    expect(details).not.toHaveAttribute('open');
    // The form is still THERE — one tap, not a different feature set.
    expect(within(details).getByRole('button', { name: /apply/i })).toBeInTheDocument();
  });

  /**
   * ═══ FOUND IN A BROWSER, NOT BY THIS SUITE ═══
   *
   * The summary read `Filter runs “undefined”` on every unfiltered list.
   * `filtersFromParams` spells the search term `params.get('q') ?? undefined`,
   * and the first version of the summary tested for `null` and `''` — so the
   * absent case fell through and was interpolated. Nothing threw, no test
   * failed, and the case below existed and PASSED because it only ever
   * rendered the filtered URL.
   *
   * Asserting the unfiltered summary is the half that was missing: a control
   * that names what it is filtering by has to say nothing when it is filtering
   * by nothing.
   */
  it('names no filter when none is applied', async () => {
    renderList();
    const details = await screen.findByTestId('compact-filters');
    // The `<summary>` itself, not "whatever says Filter runs" — the form
    // inside no longer repeats the words, and pinning the element rather than
    // the text is what keeps this about the disclosure's own label.
    const summary = details.querySelector('summary')!;
    expect(summary.textContent ?? '').not.toMatch(/undefined|null|“”/);
    expect((summary.textContent ?? '').trim()).toBe('Filter runs');

    // And the words appear ONCE on the page: the panel inside drops its own
    // header when the disclosure is carrying it.
    expect(screen.getAllByText(/^filter runs$/i)).toHaveLength(1);
  });

  /**
   * COLLAPSED BY DEFAULT IS RIGHT ONLY WHEN NOTHING IS FILTERING.
   *
   * A shortened list under a closed control is a list that looks like it is
   * missing runs, and the reader most likely to meet one is whoever followed a
   * filtered link — which is exactly the link most likely to be opened on a
   * phone. So `open` tracks whether anything is actually narrowing the view.
   */
  it('opens itself when the URL carries a filter, and names it on the summary', async () => {
    renderList(ROWS, '/runs?status=complete&q=parity');
    const details = await screen.findByTestId('compact-filters');
    expect(details).toHaveAttribute('open');
    // The summary says WHICH, because a bare count is a number the reader
    // would have to open the panel to interpret.
    expect(details.textContent ?? '').toContain('complete');
    expect(details.textContent ?? '').toContain('parity');
  });
});

describe('RunList — cards carry every field the row did', () => {
  it('replaces the table with a list, not a sideways-scrolling table', async () => {
    renderList();
    await screen.findAllByTestId('run-row');
    expect(screen.queryByRole('table')).toBeNull();
    // A real list, so the count is announced and the cells are not orphaned
    // `<td>`s stripped of the headers that gave them meaning.
    expect(screen.getAllByRole('listitem')).toHaveLength(ROWS.length);
  });

  /**
   * THE FIELD SET, ASSERTED AGAINST THE PAYLOAD RATHER THAN WRITTEN DOWN.
   *
   * `p95` and `Errors` are the two the table put in columns 6 and 7, so they
   * were off the right edge of a 375px screen — they are the reason a reader
   * consults this list at all without opening a run, and they come first on a
   * card.
   */
  it('shows the triage numbers, the identity and the provenance', async () => {
    renderList();
    const cards = await screen.findAllByTestId('run-row');
    const first = cards[0]!;
    const row = ROWS[0]!;

    expect(within(first).getByTestId('run-p95')).toHaveTextContent(
      `${Math.round(row.metrics!.p95Ms!)} ms`,
    );
    expect(within(first).getByTestId('run-error-rate')).toHaveTextContent(
      `${(row.metrics!.errorRate * 100).toFixed(2)}%`,
    );
    expect(within(first).getByTestId('run-environment')).toHaveTextContent('staging');
    expect(within(first).getByTestId('run-started')).toBeInTheDocument();
    expect(within(first).getByRole('link', { name: `View run ${row.id}` })).toHaveAttribute(
      'href',
      `/runs/${row.id}`,
    );
    // Status AND verdict, both, because a card that showed one would make a
    // failed gate on a complete run invisible.
    expect(first.textContent ?? '').toContain('complete');
    expect(first.textContent ?? '').toContain('failed');
  });

  /** An unparsed run has no p95 and no error rate. `—`, never `0` — a zero in
   *  a latency column is a measurement, which is the wrong claim entirely. */
  it('draws an absent measurement as an absence', async () => {
    renderList();
    const cards = await screen.findAllByTestId('run-row');
    const pending = cards[1]!;
    expect(within(pending).getByTestId('run-p95')).toHaveTextContent('—');
    expect(within(pending).getByTestId('run-error-rate')).toHaveTextContent('—');
  });

  /**
   * THE CAPTION TRAVELS WITH THE CARDS, IN THE SHAPE `TableFrame` GIVES IT.
   *
   * It lived inside `TableFrame`, so dropping the table would have dropped it
   * — and rendering the WHOLE thing as a paragraph was the first attempt here,
   * measured at 127px sitting directly above the list on the very screen this
   * change exists to shorten. `TableFrame` had already solved that: a short
   * line, and the rest behind a disclosure.
   *
   * What is NOT copied is the `aria-hidden` on `TableFrame`'s visible block.
   * That is hidden because the table's own `<caption class="sr-only">` carries
   * the same words; a list of cards has no caption element, so hiding it would
   * simply delete the explanation for a screen-reader user. Asserted, because
   * it is exactly the detail a later copy-paste would reintroduce.
   */
  it('keeps the caption prose, short line first and the rest on request', async () => {
    renderList();
    const section = await screen.findByRole('region', { name: 'Runs' });

    // The short line, visible and not hidden from assistive tech.
    const short = within(section).getByText('Every run in your organisation, newest first.');
    expect(short.closest('[aria-hidden="true"]')).toBeNull();

    // The long caption, present and folded.
    const details = within(section).getByRole('group');
    expect(details).not.toHaveAttribute('open');
    expect(details.textContent ?? '').toMatch(/Focus is the first operational action/i);
  });
});

describe('RunList — the tally keeps both caveats', () => {
  /**
   * THE WORDS ARE NOT WEAKENED, ONLY FOLDED.
   *
   * One caveat says the counts are page-local; the other says WHICH systems
   * they count, and that second one is why "Needs attention: 0" is not a claim
   * about a simulation's own assertions. A phone quietly reading a shorter
   * caveat than a desktop is the failure this guards — nobody would notice
   * until somebody triaged on it.
   */
  it('puts them behind a disclosure without shortening them', async () => {
    renderList();
    await screen.findAllByTestId('run-row');

    const section = screen.getByRole('region', { name: 'Run health on this page' });
    const details = within(section).getByRole('group');
    expect(details).not.toHaveAttribute('open');
    expect(details.textContent ?? '').toMatch(/not totals for the whole list/i);
    expect(details.textContent ?? '').toMatch(/checks a simulation declares/i);
  });

  /**
   * ═══ THE CAVEAT HAS TO AGREE WITH `needsAttention`, AND ONCE DID NOT ═══
   *
   * It read "NOT the assertions a simulation declares for itself" — true when
   * the list endpoint could not see them, and false from the moment M02 put
   * `checks` on the contract and `needsAttention` started counting them. The
   * page then spent two branches contradicting its own number.
   *
   * THIS FILE HELPED. The case above asserted the words were "not weakened"
   * and so pinned a sentence that had already gone false. A test that pins
   * prose verbatim protects it from correction as effectively as from
   * regression, which is why the assertion here is on the CLAIM rather than on
   * the wording: the denial must not come back, whatever words carry it.
   */
  it('does not deny counting the checks it counts', async () => {
    renderList();
    await screen.findAllByTestId('run-row');
    const section = screen.getByRole('region', { name: 'Run health on this page' });
    expect(section.textContent ?? '').not.toMatch(/not the assertions a simulation declares/i);
  });

  /** The four are independent questions, not a breakdown that sums to the
   *  page — a run with a failed check and no verdict is in two of them. Said
   *  on screen rather than left for a reader to reconcile. */
  it('admits that a run can be counted in more than one tile', async () => {
    renderList();
    await screen.findAllByTestId('run-row');
    const section = screen.getByRole('region', { name: 'Run health on this page' });
    expect(section.textContent ?? '').toMatch(/counted more than once/i);
  });

  /**
   * ═══ ONE SHAPE AT EVERY WIDTH NOW (review 09-13 copy table) ═══
   *
   * This case asserted the OPPOSITE — `queryByRole('group')` was null on a
   * wide viewport, pinning the caveat as plain prose there while a phone got
   * the disclosure. That was M18's deliberate split, and it is the half the
   * copy table objects to: "Long run-health caveat" -> "`On this page` +
   * accessible `How counts work` disclosure", written against a 1440x900
   * viewport where 67 words of methodology sat above the tally.
   *
   * Inverted rather than deleted, so the claim it now makes is the one that
   * replaced it: the SCOPE is visible at both widths and the METHODOLOGY is
   * behind a disclosure at both.
   */
  it('shows the scope visibly and folds the methodology, at both widths', async () => {
    for (const compact of [false, true]) {
      cleanup();
      useIsCompactMock.mockReturnValue(compact);
      renderList();
      await screen.findAllByTestId('run-row');

      const section = screen.getByRole('region', { name: 'Run health on this page' });
      const where = compact ? 'compact' : 'wide';

      // The scope, visible and unfolded — the fact a reader needs without asking.
      expect(within(section).getByTestId('health-scope').textContent, where).toMatch(
        /^On this page · \d+ runs?$/,
      );
      // The methodology, behind a real control. A `<summary>` contributes an
      // ARIA group, which is what this queries — and what the old case
      // asserted was absent here.
      expect(within(section).queryByRole('group'), where).not.toBeNull();
      expect(within(section).getByText('How counts work'), where).toBeInTheDocument();
      // jsdom keeps a closed `<details>`'s children, so this proves the words
      // are still THERE, not that they are on screen — the geometry is
      // `mobile.spec.ts`'s.
      expect(section.textContent ?? '', where).toMatch(/not totals for the whole list/i);
    }
  });
});
