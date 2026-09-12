import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import RunTabs from '../src/routes/RunTabs';

// No global setup runs `afterEach(cleanup)` for us (see StatisticsTable.test.tsx)
// — without it, each `renderAt` call below leaves its `<nav>` mounted
// alongside the next one, and two links named "Errors" collide.
afterEach(cleanup);

const RUN = 'a66548b7-2962-43ff-8b93-7149a6f2a1b8';

function renderAt(path: string, errorCount: number | null) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <RunTabs runId={RUN} errorCount={errorCount} />
    </MemoryRouter>,
  );
}

describe('RunTabs', () => {
  /**
   * LINKS, not role="tab". The ARIA tab pattern describes in-page panels that
   * swap without navigation and promises arrow-key movement between them.
   * These change the URL and the browser navigates; wearing the roles would
   * make a promise the implementation cannot keep.
   */
  it('renders navigation links, not ARIA tabs', () => {
    renderAt(`/runs/${RUN}`, 2);
    expect(screen.getAllByRole('link')).toHaveLength(6);
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
  });

  it('puts Trends and Compare last, after the four that are about this run alone', () => {
    // The order is the argument, so it is asserted rather than left to the
    // reading order of the JSX: Overview, Charts, Load generators and Errors
    // narrow in on THIS run; Trends and Compare leave it for the cohort.
    renderAt(`/runs/${RUN}`, 2);
    const names = screen.getAllByRole('link').map((link) => link.textContent);
    expect(names).toEqual([
      'Overview',
      'Charts',
      'Load generators',
      'Errors (2)',
      'Trends',
      'Compare',
    ]);
  });

  it('marks Trends current on its own URL', () => {
    renderAt(`/runs/${RUN}/trends`, 2);
    expect(screen.getByRole('link', { name: 'Trends' })).toHaveAttribute('aria-current', 'page');
    // `end` on Overview is what stops the run's own path matching this one.
    expect(screen.getByRole('link', { name: 'Overview' })).not.toHaveAttribute('aria-current');
  });

  it('marks Compare current on its own URL', () => {
    renderAt(`/runs/${RUN}/compare`, 2);
    expect(screen.getByRole('link', { name: 'Compare' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Trends' })).not.toHaveAttribute('aria-current');
  });

  it('marks the current tab with aria-current', () => {
    renderAt(`/runs/${RUN}/errors`, 2);
    expect(screen.getByRole('link', { name: /Errors/ })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Overview' })).not.toHaveAttribute('aria-current');
  });

  /** The bare run path is Overview, so it is current there too. */
  it('treats the index path as Overview', () => {
    renderAt(`/runs/${RUN}`, 0);
    expect(screen.getByRole('link', { name: 'Overview' })).toHaveAttribute('aria-current', 'page');
  });

  it('shows the error count, including zero', () => {
    renderAt(`/runs/${RUN}`, 0);
    // The exact name, not a substring: `toHaveTextContent('0')` would also
    // pass for "Errors (10)" or the bare "Errors" this component renders for
    // `null` — neither of which is what a genuine zero must say.
    expect(screen.getByRole('link', { name: 'Errors (0)' })).toBeInTheDocument();
  });

  /**
   * `null` — not yet known, distinct from a genuine zero — renders a bare
   * label rather than a number that has not arrived. `RunShell.tsx` used to
   * pass `errors.data?.errors.length ?? 0`, which made "not yet known" and
   * "genuinely none" the same glyph; this is the case that distinction is
   * for.
   */
  it('renders a bare label until the count is known', () => {
    renderAt(`/runs/${RUN}`, null);
    expect(screen.getByRole('link', { name: 'Errors' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Errors \(/ })).not.toBeInTheDocument();
  });
});

/**
 * REVIEW C04 — THE SELECTED INTERVAL MUST SURVIVE A TAB CHANGE.
 *
 * The window lives in the URL as `?from=&to=` (`useRunWindow`), and these
 * links were built from `runChartsPath(runId)` and friends — paths with no
 * query string. So narrowing to 10–30s on Overview and then opening Charts
 * silently threw the selection away: the reader was returned to the whole run
 * mid-investigation, with the From/To fields empty and nothing saying why.
 *
 * Carrying the parameters is also what makes the RETURN journey work. Trends
 * and Compare deliberately answer whole-run questions (see C03), but they must
 * still hand the interval back when the reader returns to a tab that honours
 * it — so the parameters ride along everywhere rather than being stripped for
 * the tabs that ignore them.
 */
describe('RunTabs — the analysis window rides along', () => {
  const withWindow = (path: string) => `${path}?from=10000&to=30000`;

  it('carries from/to onto every tab', () => {
    renderAt(withWindow(`/runs/${RUN}`), 2);
    for (const link of screen.getAllByRole('link')) {
      expect(link.getAttribute('href')).toMatch(/[?&]from=10000(&|$)/);
      expect(link.getAttribute('href')).toMatch(/[?&]to=30000(&|$)/);
    }
  });

  it('leaves the links clean when no window is selected', () => {
    renderAt(`/runs/${RUN}`, 2);
    for (const link of screen.getAllByRole('link')) {
      expect(link.getAttribute('href')).not.toContain('?');
    }
  });

  /** A half-specified window is still the reader's selection and must travel;
   *  `useRunWindow` is the one place that decides what it means. */
  it('carries a from with no to', () => {
    renderAt(`${`/runs/${RUN}`}?from=10000`, 2);
    for (const link of screen.getAllByRole('link')) {
      expect(link.getAttribute('href')).toContain('from=10000');
      expect(link.getAttribute('href')).not.toContain('to=');
    }
  });

  /** Only the window travels. An unrelated parameter belongs to the tab that
   *  set it, and carrying it would leak one tab's state onto another. */
  it('does not carry unrelated query parameters between tabs', () => {
    renderAt(`${`/runs/${RUN}`}?from=10000&runs=abc&metric=p99`, 2);
    const href = screen.getAllByRole('link')[0]!.getAttribute('href') ?? '';
    expect(href).toContain('from=10000');
    expect(href).not.toContain('runs=abc');
    expect(href).not.toContain('metric=p99');
  });
});
