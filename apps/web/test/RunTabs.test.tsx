import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import RunTabs from '../src/routes/RunTabs';

// No global setup runs `afterEach(cleanup)` for us (see StatisticsTable.test.tsx)
// — without it, each `renderAt` call below leaves its `<nav>` mounted
// alongside the next one, and two links named "Summary" collide.
afterEach(cleanup);

const RUN = 'a66548b7-2962-43ff-8b93-7149a6f2a1b8';

function renderAt(path: string, hasLogs = false) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <RunTabs runId={RUN} hasLogs={hasLogs} />
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
    renderAt(`/runs/${RUN}`);
    expect(screen.getAllByRole('link')).toHaveLength(4);
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
  });

  /**
   * GATLING ENTERPRISE'S RUN SECTIONS: Summary and Report, then the sections
   * this product adds. The tab that answered "what did the charts say" and the
   * tab that answered "what went wrong" are two halves of the Report and the
   * Summary now, so neither has a tab of its own.
   */
  it('offers GE’s run sections: Summary, Report, then Logs, Trends, Compare', () => {
    renderAt(`/runs/${RUN}`, true);
    expect(screen.getAllByRole('link').map((a) => a.textContent?.trim())).toEqual([
      'Summary',
      'Report',
      'Logs',
      'Trends',
      'Compare',
    ]);
    expect(screen.getByRole('link', { name: 'Report' })).toHaveAttribute('href', `/runs/${RUN}/report`);
  });

  it('puts Trends and Compare last, after the sections that are about this run alone', () => {
    // The order is the argument, so it is asserted rather than left to the
    // reading order of the JSX: Summary and Report answer questions about THIS
    // run; Trends and Compare leave it for the cohort.
    renderAt(`/runs/${RUN}`);
    const names = screen.getAllByRole('link').map((link) => link.textContent);
    expect(names).toEqual(['Summary', 'Report', 'Trends', 'Compare']);
  });

  it('marks Trends current on its own URL', () => {
    renderAt(`/runs/${RUN}/trends`);
    expect(screen.getByRole('link', { name: 'Trends' })).toHaveAttribute('aria-current', 'page');
    // `end` on Summary is what stops the run's own path matching this one.
    expect(screen.getByRole('link', { name: 'Summary' })).not.toHaveAttribute('aria-current');
  });

  it('marks Compare current on its own URL', () => {
    renderAt(`/runs/${RUN}/compare`);
    expect(screen.getByRole('link', { name: 'Compare' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Trends' })).not.toHaveAttribute('aria-current');
  });

  it('marks the current tab with aria-current', () => {
    renderAt(`/runs/${RUN}/report`);
    expect(screen.getByRole('link', { name: 'Report' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Summary' })).not.toHaveAttribute('aria-current');
  });

  /** The bare run path is the Summary, so it is current there too. */
  it('treats the index path as the Summary', () => {
    renderAt(`/runs/${RUN}`);
    expect(screen.getByRole('link', { name: 'Summary' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Report' })).not.toHaveAttribute('aria-current');
  });
});

/**
 * REVIEW C04 — THE SELECTED INTERVAL MUST SURVIVE A TAB CHANGE.
 *
 * The window lives in the URL as `?from=&to=` (`useRunWindow`), and these
 * links were built from bare section paths — no query string. So narrowing to
 * 10–30s on one tab and then opening another silently threw the selection
 * away: the reader was returned to the whole run mid-investigation, with the
 * From/To fields empty and nothing saying why.
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
    renderAt(withWindow(`/runs/${RUN}`));
    for (const link of screen.getAllByRole('link')) {
      expect(link.getAttribute('href')).toMatch(/[?&]from=10000(&|$)/);
      expect(link.getAttribute('href')).toMatch(/[?&]to=30000(&|$)/);
    }
  });

  it('leaves the links clean when no window is selected', () => {
    renderAt(`/runs/${RUN}`);
    for (const link of screen.getAllByRole('link')) {
      expect(link.getAttribute('href')).not.toContain('?');
    }
  });

  /** A half-specified window is still the reader's selection and must travel;
   *  `useRunWindow` is the one place that decides what it means. */
  it('carries a from with no to', () => {
    renderAt(`${`/runs/${RUN}`}?from=10000`);
    for (const link of screen.getAllByRole('link')) {
      expect(link.getAttribute('href')).toContain('from=10000');
      expect(link.getAttribute('href')).not.toContain('to=');
    }
  });

  /** Only the window travels. An unrelated parameter belongs to the tab that
   *  set it, and carrying it would leak one tab's state onto another. */
  it('does not carry unrelated query parameters between tabs', () => {
    renderAt(`${`/runs/${RUN}`}?from=10000&runs=abc&metric=p99`);
    const href = screen.getAllByRole('link')[0]!.getAttribute('href') ?? '';
    expect(href).toContain('from=10000');
    expect(href).not.toContain('runs=abc');
    expect(href).not.toContain('metric=p99');
  });
});

/**
 * LOGS ONLY WHERE THERE CAN BE ANY (docs/superpowers/specs/2026-09-29-run-logs-design.md).
 * A control over a section that can never have content is a false claim, so a
 * run the on-prem runner did not execute gets no Logs tab at all.
 */
describe('RunTabs — the Logs tab', () => {
  it('offers Logs after Report on a run the on-prem runner executed', () => {
    renderAt(`/runs/${RUN}`, true);
    expect(screen.getAllByRole('link').map((link) => link.textContent)).toEqual([
      'Summary', 'Report', 'Logs', 'Trends', 'Compare',
    ]);
  });

  it('offers no Logs tab on any other run', () => {
    renderAt(`/runs/${RUN}`, false);
    expect(screen.queryByRole('link', { name: 'Logs' })).toBeNull();
  });

  it('marks Logs current on its own URL', () => {
    renderAt(`/runs/${RUN}/logs`, true);
    expect(screen.getByRole('link', { name: 'Logs' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Summary' })).not.toHaveAttribute('aria-current');
  });

  it('carries the window onto Logs too', () => {
    renderAt(`/runs/${RUN}?from=10000&to=30000`, true);
    const href = screen.getByRole('link', { name: 'Logs' }).getAttribute('href') ?? '';
    expect(href.startsWith(`/runs/${RUN}/logs?`)).toBe(true);
    expect(href).toMatch(/[?&]from=10000(&|$)/);
    expect(href).toMatch(/[?&]to=30000(&|$)/);
  });
});
