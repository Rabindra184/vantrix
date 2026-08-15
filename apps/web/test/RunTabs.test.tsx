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
    expect(screen.getAllByRole('link')).toHaveLength(4);
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
  });

  it('puts Trends last, after the three that are about this run alone', () => {
    // The order is the argument, so it is asserted rather than left to the
    // reading order of the JSX: Overview, Charts and Errors narrow in on THIS
    // run; Trends is the only tab that leaves it.
    renderAt(`/runs/${RUN}`, 2);
    const names = screen.getAllByRole('link').map((link) => link.textContent);
    expect(names).toEqual(['Overview', 'Charts', 'Errors (2)', 'Trends']);
  });

  it('marks Trends current on its own URL', () => {
    renderAt(`/runs/${RUN}/trends`, 2);
    expect(screen.getByRole('link', { name: 'Trends' })).toHaveAttribute('aria-current', 'page');
    // `end` on Overview is what stops the run's own path matching this one.
    expect(screen.getByRole('link', { name: 'Overview' })).not.toHaveAttribute('aria-current');
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
