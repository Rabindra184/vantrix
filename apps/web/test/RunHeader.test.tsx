import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import type { RunResponse } from '@perfportal/contracts';
import RunHeader from '../src/routes/RunHeader';

// No global setup runs `afterEach(cleanup)` for us (see StatisticsTable.test.tsx)
// — without it, each `render` call below leaves its `<header>` mounted
// alongside the next one, and two headings collide.
afterEach(cleanup);

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const TEST_ID = '33333333-3333-4333-8333-333333333333';

const RUN: RunResponse = {
  id: 'a66548b7-2962-43ff-8b93-7149a6f2a1b8',
  project: { id: PROJECT_ID, slug: 'checkout', name: 'Checkout' },
  status: 'complete',
  verdict: 'not_evaluated',
  tool: 'gatling',
  toolVersion: '3.15.1',
  simulation: 'example.ParitySimulation',
  description: null,
  durationMs: 63161,
  startedAt: '2026-08-14T10:43:49.546Z',
  toolStartedAt: '2026-08-07T05:30:02.171Z',
  assertions: [],
};

// The header now contains a <Link> (to its project), which throws outside a
// router context — every render in this file needs the wrapper, so it lives
// in exactly one place rather than at each of the call sites below.
//
// Takes a whole RunResponse and splits it into the header's new prop shape —
// identity/status/verdict/peakUsers — so the existing terminal-run cases
// below stay expressed the way they always were: a full run in, an assertion
// on the render out.
function renderHeader(run: RunResponse, peakUsers: number | null = null) {
  return render(
    <MemoryRouter>
      <RunHeader identity={run} status={run.status} verdict={run.verdict} peakUsers={peakUsers} />
    </MemoryRouter>,
  );
}

// A terminal run's identity is every RunIdentity field — RunResponse is a
// structural superset — so the full fixture doubles as FULL_IDENTITY with no
// separate literal to drift from RUN.
const FULL_IDENTITY = { ...RUN };

describe('RunHeader', () => {
  it('names the run by its fully-qualified simulation', () => {
    renderHeader(RUN, 42);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('example.ParitySimulation');
  });

  it('falls back to the short id when the tool reported no simulation', () => {
    renderHeader({ ...RUN, simulation: null });
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Run a66548b7');
  });

  /** Zero is a measurement; a run with no user buckets had none taken. */
  it('omits peak users entirely when there are none', () => {
    renderHeader(RUN);
    expect(screen.queryByText(/peak users/)).toBeNull();
  });

  it('says the start is ingest time when the tool reported none', () => {
    renderHeader({ ...RUN, toolStartedAt: null });
    expect(screen.getByText(/ingest time/)).toBeInTheDocument();
  });

  it('names the project, linking to its tests', () => {
    renderHeader({ ...RUN, project: { id: PROJECT_ID, slug: 'checkout', name: 'Checkout' } });
    const link = screen.getByRole('link', { name: 'Checkout' });
    expect(link).toHaveAttribute('href', '/projects/checkout');
  });

  /**
   * ═══ THE TEST IS THE MIDDLE RUNG ═══
   *
   * `Organization → Project → Test → Run`, and this breadcrumb is the only
   * place on the run page that names the level the trend is computed at
   * (`TRENDS_SQL` cohorts on `test_id`). A reader wanting the other runs of
   * the same thing has one click from here and from nowhere else.
   *
   * The href is asserted, not just the text: the link is built from the
   * PROJECT's slug and the TEST's slug, two fields from two different objects,
   * and getting the pair the wrong way round renders a plausible-looking link
   * that 404s.
   */
  it('names the test between the project and the run', () => {
    renderHeader({
      ...RUN,
      test: { id: TEST_ID, slug: 'example-paritysimulation', name: 'Checkout smoke' },
    });
    const link = screen.getByRole('link', { name: 'Checkout smoke' });
    expect(link).toHaveAttribute('href', '/projects/checkout/tests/example-paritysimulation');
  });

  /**
   * BOTH ABSENCES RENDER THE SAME, and they are different facts.
   *
   * `null` is a run that belongs to no test — still pending, or one that
   * failed before the worker could read its simulation class. `undefined` is a
   * body from an API pod that predates the field, mid-rolling-deploy. A reader
   * cannot act on the difference, and a breadcrumb rung pointing at a test
   * that does not exist is worse than a two-rung breadcrumb, so neither draws
   * one.
   *
   * `it.each` rather than two cases, because the whole claim is that the two
   * inputs are indistinguishable on screen.
   */
  it.each([['null', null], ['absent', undefined]] as const)(
    'omits the test rung entirely when the run has %s for one, keeping the project and the id',
    (_label, test) => {
      renderHeader({ ...RUN, test });
      expect(screen.queryByTestId('run-test')).toBeNull();
      expect(screen.getByRole('link', { name: 'Checkout' })).toBeInTheDocument();
      // The breadcrumb still ENDS at this run — dropping the middle rung must
      // not drop the trailing segment with it.
      expect(screen.getByText('a66548b7')).toHaveAttribute('aria-current', 'page');
    },
  );

  /**
   * A run with no PROJECT has no breadcrumb at all (the rolling-deploy render,
   * where an old pod's 202 carried only `{ id, status, statusUrl }`) — so a
   * test rung that somehow arrived without one must not render alone. It has
   * nothing to build a URL from: `projectTestPath` needs both slugs.
   */
  it('draws no breadcrumb at all when the project is unknown, test or no test', () => {
    // `delete` rather than a rest destructure: `project` is REQUIRED on
    // `RunIdentity` (run.project_id is NOT NULL), so this state exists only as
    // a partial identity from an old pod and there is no honest typed literal
    // for it. The cast is the point of the case, not a shortcut around it.
    const withoutProject: Record<string, unknown> = { ...RUN };
    delete withoutProject.project;
    renderHeader({
      ...withoutProject,
      test: { id: TEST_ID, slug: 'example-paritysimulation', name: 'Checkout smoke' },
    } as unknown as RunResponse);
    expect(screen.queryByRole('navigation', { name: 'Breadcrumb' })).toBeNull();
    expect(screen.queryByTestId('run-test')).toBeNull();
  });

  it('shows no provenance chips for a run that carried none', () => {
    renderHeader({ ...RUN, environment: null, branch: null, commitSha: null });
    // Absent, not blank: a dash would claim we asked and got nothing back.
    expect(screen.queryByTestId('run-environment')).toBeNull();
    expect(screen.queryByTestId('run-branch')).toBeNull();
    expect(screen.queryByTestId('run-commit')).toBeNull();
  });

  it('shows each chip that has a value, and truncates the commit', () => {
    const commitSha = 'abc1234def5678';
    renderHeader({ ...RUN, environment: 'staging', branch: 'release/24.8', commitSha });
    expect(screen.getByTestId('run-environment')).toHaveTextContent('staging');
    expect(screen.getByTestId('run-branch')).toHaveTextContent('release/24.8');
    // Derived from the value, not written down: assert the visible text is a
    // strict prefix of the full sha rather than restating the slice length.
    const visible = screen.getByTestId('run-commit').textContent!;
    // Non-empty FIRST, and load-bearing: `commitSha.startsWith('')` is
    // vacuously true and `'' !== commitSha` is too, so without this a
    // regression that blanked the visible text — slice(0, 0), or the <code>
    // content dropped while the chip and its aria-label survive — would pass
    // both assertions below while showing a sighted reader nothing. The e2e
    // test cannot cover this: it asserts the aria-label, which sits on the
    // outer span and is unaffected by an empty <code>.
    expect(visible.length).toBeGreaterThan(0);
    expect(commitSha.startsWith(visible)).toBe(true);
    expect(visible).not.toBe(commitSha);
  });

  it('does not make the commit a link — the platform does not know the repo host', () => {
    renderHeader({ ...RUN, commitSha: 'abc1234def5678' });
    expect(screen.getByTestId('run-commit').querySelector('a')).toBeNull();
  });

  it('renders identity-only, omitting what an old pod did not send', () => {
    // The rolling-deploy render: a new browser polling an old API pod gets
    // { id, status, statusUrl } and nothing else. Thin, but coherent — and it
    // self-heals at the next poll that reaches a new pod.
    render(
      <MemoryRouter>
        <RunHeader identity={{ id: 'a66548b7-2962-43ff-8b93-7149a6f2a1b8' }}
                   status="running" verdict={undefined} peakUsers={null} />
      </MemoryRouter>,
    );
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Run a66548b7');
    expect(screen.getByTestId('run-status')).toHaveTextContent(/running/i);
    expect(screen.queryByRole('navigation', { name: 'Breadcrumb' })).toBeNull();
    expect(screen.queryByTestId('run-verdict')).toBeNull();
  });

  it('omits the verdict badge entirely while a run is non-terminal', () => {
    // NOT `VERDICT['none']`. "No verdict" reads as evaluated-and-nothing-found,
    // which is a claim about a run nobody has finished measuring. Same argument
    // RunTabs' `errorCount: number | null` already makes one line away.
    render(
      <MemoryRouter>
        <RunHeader identity={{ id: 'a66548b7-2962-43ff-8b93-7149a6f2a1b8',
                               project: { id: '11111111-1111-4111-8111-111111111111',
                                          slug: 'checkout', name: 'Checkout' },
                               tool: 'gatling', startedAt: '2026-08-20T10:43:49.546Z' }}
                   status="running" verdict={undefined} peakUsers={null} />
      </MemoryRouter>,
    );
    expect(screen.queryByTestId('run-verdict')).toBeNull();
    expect(screen.getByRole('link', { name: 'Checkout' })).toBeInTheDocument();
  });

  it('still renders the verdict badge for a terminal run', () => {
    render(
      <MemoryRouter>
        <RunHeader identity={FULL_IDENTITY} status="complete" verdict={null} peakUsers={8} />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('run-verdict')).toBeInTheDocument();
  });
});
