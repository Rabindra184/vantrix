// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import RunSectionRedirect from '../src/routes/RunSectionRedirect';

afterEach(cleanup);

function Where() {
  const { pathname, search, hash } = useLocation();
  return <p data-testid="where">{`${pathname}${search}${hash}`}</p>;
}

function landAt(url: string) {
  render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/runs/:runId" element={<Where />} />
        <Route path="/runs/:runId/report" element={<Where />} />
        <Route path="/runs/:runId/charts" element={<RunSectionRedirect to="report" />} />
        <Route path="/runs/:runId/load-generators" element={<RunSectionRedirect to="report" hash="load-generators" />} />
        <Route path="/runs/:runId/errors" element={<RunSectionRedirect to="summary" hash="errors" />} />
      </Routes>
    </MemoryRouter>,
  );
  return screen.getByTestId('where').textContent;
}

describe('RunSectionRedirect — old tab URLs land on their new place', () => {
  it('sends Charts to the Report, window kept', () => {
    expect(landAt('/runs/r1/charts?from=1000&to=5000')).toBe('/runs/r1/report?from=1000&to=5000');
  });
  it('sends Load generators to the Report with that section named', () => {
    expect(landAt('/runs/r1/load-generators?from=1000&to=5000')).toBe('/runs/r1/report?from=1000&to=5000#load-generators');
  });
  it('sends Errors to the Summary’s errors section, filter kept', () => {
    expect(landAt('/runs/r1/errors?request=Place%20Order')).toBe('/runs/r1?request=Place%20Order#errors');
  });

  // `replace` is the claim the component's own comment makes, and a navigation
  // that merely lands in the right place satisfies every case above without it.
  // Without it Back returns to the OLD URL, which redirects again — the reader
  // is bounced forward and can never leave.
  it('replaces the old URL, so Back leaves rather than bouncing through the redirect', async () => {
    function Back() {
      const navigate = useNavigate();
      return <button type="button" onClick={() => navigate(-1)}>back</button>;
    }
    render(
      <MemoryRouter initialEntries={['/start', '/runs/r1/charts']} initialIndex={1}>
        <Routes>
          <Route path="/start" element={<Where />} />
          <Route path="/runs/:runId/report" element={<><Where /><Back /></>} />
          <Route path="/runs/:runId/charts" element={<RunSectionRedirect to="report" />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByTestId('where').textContent).toBe('/runs/r1/report');
    await userEvent.click(screen.getByRole('button', { name: 'back' }));
    expect(screen.getByTestId('where').textContent).toBe('/start');
  });
});
