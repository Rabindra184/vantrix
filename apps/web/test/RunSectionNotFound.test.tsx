import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import RunSectionNotFound from '../src/routes/RunSectionNotFound';

afterEach(cleanup);

const RUN_ID = '00000000-0000-4000-8000-000000000001';

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/runs/:runId/*" element={<RunSectionNotFound />} />
        <Route path="*" element={<RunSectionNotFound />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('RunSectionNotFound', () => {
  it('says the section does not exist and offers the run it is still inside', () => {
    renderAt(`/runs/${RUN_ID}/telemetry`);
    expect(screen.getByText('This run has no such section')).toBeInTheDocument();
    // The way back is the RUN, not the run list: this renders inside
    // `RunShell`'s outlet, so the reader has not lost the run and must not be
    // offered an exit that implies they have.
    expect(screen.getByRole('link', { name: 'Back to the overview' })).toHaveAttribute(
      'href',
      `/runs/${RUN_ID}`,
    );
  });

  /**
   * It names no tab. The set of sections is `App.tsx`'s to know and the tab
   * strip immediately above this panel is already showing it — a list
   * restated in this copy would go stale the next time a tab is added, and
   * would do so silently, since nothing would fail.
   */
  it('does not restate the list of sections', () => {
    renderAt(`/runs/${RUN_ID}/telemetry`);
    const body = document.body.textContent ?? '';
    for (const tab of ['Overview', 'Charts', 'Load generators', 'Errors', 'Trends', 'Compare']) {
      expect(body).not.toContain(tab);
    }
  });

  it('renders without a link at all rather than a broken one when there is no run in the path', () => {
    renderAt('/nowhere');
    expect(screen.getByText('This run has no such section')).toBeInTheDocument();
    expect(screen.queryByRole('link')).toBeNull();
  });
});
