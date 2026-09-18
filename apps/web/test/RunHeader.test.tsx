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
function renderHeader(run: RunResponse, peakUsers: number | null = null, compact = false) {
  return render(
    <MemoryRouter>
      <RunHeader
        identity={run}
        status={run.status}
        verdict={run.verdict}
        peakUsers={peakUsers}
        compact={compact}
      />
    </MemoryRouter>,
  );
}

// A terminal run's identity is every RunIdentity field — RunResponse is a
// structural superset — so the full fixture doubles as FULL_IDENTITY with no
// separate literal to drift from RUN.
const FULL_IDENTITY = { ...RUN };

describe('RunHeader', () => {
  /**
   * ═══ THE TEST LEADS, NOT THE CLASS (review.md 6) ═══
   *
   * One class is run as many tests — `declaredTestSlug` exists so that
   * `checkout-smoke` and `checkout-soak` can share `example.ParitySimulation`
   * — and with the class as the heading those two run pages are identical
   * above the fold. "Repeating the class as the main identity makes different
   * user tasks look the same."
   *
   * The negative is the half that carries the finding: a heading that merely
   * CONTAINS the test name is satisfied by one that appends it to the class,
   * which is the before-state wearing a new label.
   */
  it('leads with the test the run belongs to, and files the class beside it', () => {
    renderHeader({
      ...RUN,
      test: { id: TEST_ID, slug: 'checkout-smoke', name: 'Checkout smoke' },
    });

    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading).toHaveTextContent('Checkout smoke');
    expect(heading).not.toHaveTextContent('ParitySimulation');
    // WHICH run is then carried by the breadcrumb's current-page rung, one line
    // up — two runs of one test are distinguishable by nothing else on this
    // page once the heading names the test. That is the argument the class used
    // to carry, surviving the reversal one level down; `headingFor` records why
    // the id is not ALSO in the heading as review.md's wireframe draws it.
    expect(screen.getByText('a66548b7')).toHaveAttribute('aria-current', 'page');
    // Demoted, not deleted: the engineer who needs to know what executed still
    // has it, as the technical metadata the finding calls it.
    expect(screen.getByTestId('run-simulation')).toHaveTextContent('example.ParitySimulation');
  });

  /**
   * AND THE AUTO-CREATED CASE LOSES NOTHING, which is why the pair matters.
   * `test-resolver.ts` inserts `name` and `simulation_class` from ONE value, so
   * a run nobody declared a test for is still headed by its class.
   *
   * The chip is then ABSENT rather than repeating it. Asserted here and nowhere
   * else: on the majority of runs the heading is the class, so a chip that did
   * not know to keep quiet would print it twice on almost every run page in the
   * product — and the case above, which has a declared test, cannot see that.
   */
  it('falls back to the class when no test claims the run, and then says it once', () => {
    renderHeader(RUN, 42);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('example.ParitySimulation');
    expect(screen.queryByTestId('run-simulation')).toBeNull();
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
                   status="running" verdict={undefined} peakUsers={null} compact={false} />
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
                   status="running" verdict={undefined} peakUsers={null} compact={false} />
      </MemoryRouter>,
    );
    expect(screen.queryByTestId('run-verdict')).toBeNull();
    expect(screen.getByRole('link', { name: 'Checkout' })).toBeInTheDocument();
  });

  it('still renders the verdict badge for a terminal run', () => {
    render(
      <MemoryRouter>
        <RunHeader identity={FULL_IDENTITY} status="complete" verdict={null} peakUsers={8} compact={false} />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('run-verdict')).toBeInTheDocument();
  });
});

/**
 * ═══ REVIEW M02's REMAINDER — WHAT A PHONE LEADS WITH ═══
 *
 * "Keep run name, environment, outcome, and primary metrics BEFORE secondary
 * metadata." At 375px the chip strip was a 191px `grid-cols-2` block between
 * the `<h1>` and the decision band, and the run's own totals began at y=876 on
 * an 812px screen. Version, branch, commit, started, duration and peak users
 * fold into a closed disclosure there; ENVIRONMENT does not, because the
 * finding names it beside the run name and the outcome — and because it
 * changes what every number below it means.
 *
 * ═══ THESE ASSERT CONTAINMENT, AND THE OBVIOUS SPELLING IS VACUOUS ═══
 *
 * A closed `<details>` keeps its children in the DOM: jsdom applies no CSS, so
 * `getByTestId('run-branch')` resolves identically whether that chip sits in
 * the disclosure, beside it, or in the desktop strip. `RunList.compact.test.tsx`
 * records the same trap one component over — its folded filter prose is still
 * in `textContent` — and CLAUDE.md's M04 entry states the rule: assert on the
 * RELATIONSHIP, never on presence.
 *
 * So every case below asks WHERE a chip is, not whether it exists. The
 * geometry — that the fold actually buys the height M02 is about — is
 * `mobile.spec.ts`'s, at a real 375x812, which is the division of labour that
 * file's own docstring sets out.
 */
describe('RunHeader — the metadata a phone leads with', () => {
  const details = () => screen.getByTestId('run-metadata');

  it('folds the secondary metadata into a disclosure that starts closed', () => {
    renderHeader({ ...RUN, environment: 'staging', branch: 'release/24.8', commitSha: 'abc1234def5678' }, 8, true);

    expect(details().tagName).toBe('DETAILS');
    // CLOSED. One tap away is the whole point — hidden would be a different
    // change, and 24px of summary against 191px of grid is the saving.
    expect(details()).not.toHaveAttribute('open');

    for (const id of ['run-branch', 'run-commit', 'run-duration']) {
      expect(details(), `${id} belongs inside the disclosure`).toContainElement(
        screen.getByTestId(id),
      );
    }
    // Peak users carries no testid — it is pinned by its own whole text
    // elsewhere (see the module docstring) — so it is found the same way.
    expect(details()).toContainElement(screen.getByText('8 peak users'));
  });

  it('keeps environment out of the disclosure, where the finding puts it', () => {
    renderHeader({ ...RUN, environment: 'staging', branch: 'release/24.8' }, 8, true);

    const environment = screen.getByTestId('run-environment');
    expect(environment).toHaveTextContent('staging');
    // The assertion that separates this from folding EVERYTHING away, which
    // is the mutation a presence-only case cannot see.
    expect(details()).not.toContainElement(environment);
  });

  it('draws no disclosure at all above the breakpoint, and nothing moves', () => {
    renderHeader({ ...RUN, environment: 'staging', branch: 'release/24.8', commitSha: 'abc1234def5678' }, 8, false);

    expect(screen.queryByTestId('run-metadata')).toBeNull();
    // The paired positive: "no disclosure" passes just as happily against a
    // header that failed to render, which is the shape CLAUDE.md records for
    // every absence assertion in this repo.
    for (const id of ['run-environment', 'run-branch', 'run-commit', 'run-duration']) {
      expect(screen.getByTestId(id)).toBeInTheDocument();
    }
    expect(screen.getByText('8 peak users')).toBeInTheDocument();
  });

  it('names the action the summary will perform, in both directions', () => {
    // Both spellings are in the DOM at all times and CSS chooses between them
    // — `RunGlossary`'s pattern, and why the accessible name is stable and no
    // state lives in JavaScript. It also means the summary's own textContent
    // is both strings at once, so nothing may assert on that.
    renderHeader({ ...RUN, environment: 'staging' }, null, true);
    expect(screen.getByText('Run details')).toBeInTheDocument();
    expect(screen.getByText('Hide run details')).toBeInTheDocument();
  });
});
