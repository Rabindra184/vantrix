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

function renderAt(path: string, errorCount: number) {
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
    expect(screen.getAllByRole('link')).toHaveLength(3);
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
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
    expect(screen.getByRole('link', { name: /Errors/ })).toHaveTextContent('0');
  });
});
