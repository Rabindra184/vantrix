// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchProjects } from '../src/api/projects.js';
import { fetchRunnerJobs } from '../src/api/runner.js';
import ProjectSetup from '../src/routes/ProjectSetup.js';

/**
 * ═══ REVIEW M15 — THE PAGE THAT WAS FOUR PAGES ═══
 *
 * `ProjectSetup` used to mint tokens, revoke tokens, explain importing and
 * author SLA rules. The tokens moved to `ProjectAccess` (and their tests with
 * them, in `ProjectAccess.test.tsx`, which is where this file's history is);
 * the rules moved to their own page. What is left is the one job the review
 * says was buried: getting a run into the project at all.
 *
 * So this file is about the THREE CHOICES and about their STATUS. The status
 * is the half worth testing hardest, because it is the half that is easy to
 * fake: two of the three are available because an endpoint exists, and the
 * third depends on a machine this instance cannot see. The cases below spend
 * most of their effort on the states that must NOT read as "available".
 */

vi.mock('../src/api/projects.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/api/projects.js')>()),
  fetchProjects: vi.fn(async () => ({
    items: [
      { id: '00000000-0000-4000-8000-0000000000a1', slug: 'alpha', name: 'Alpha', latestRun: null },
    ],
  })),
}));

vi.mock('../src/api/runner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/api/runner.js')>()),
  fetchRunnerJobs: vi.fn(async () => ({ items: [] })),
}));

const fetchProjectsMock = vi.mocked(fetchProjects);
const fetchRunnerJobsMock = vi.mocked(fetchRunnerJobs);

afterEach(() => {
  cleanup();
  fetchProjectsMock.mockClear();
  fetchRunnerJobsMock.mockClear();
});

/** A runner job list item, shaped enough for the readiness rules. */
function job(status: string, agedMs: number) {
  const at = new Date(Date.now() - agedMs).toISOString();
  return {
    artifact: {
      id: '00000000-0000-4000-8000-0000000000b1',
      name: 'artifact',
      filename: 'sim.jar',
      kind: 'gatling_jar' as const,
      simulationClass: 'example.BasicSimulation',
      gatlingVersion: null,
      sha256: 'x'.repeat(64),
      bytes: 10,
      createdAt: at,
    },
    job: {
      id: '00000000-0000-4000-8000-0000000000c1',
      artifactId: '00000000-0000-4000-8000-0000000000b1',
      runId: null,
      status,
      requestedBy: 'someone@example.test',
      environment: null,
      branch: null,
      commitSha: null,
      testSlug: null,
      javaOptions: null,
      systemProperties: {},
      error: null,
      createdAt: at,
      updatedAt: at,
    },
  } as unknown as Awaited<ReturnType<typeof fetchRunnerJobs>>['items'][number];
}

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/projects/alpha/setup']}>
        <Routes>
          <Route path="/projects/:slug/setup" element={<ProjectSetup />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/**
 * One entry card, awaited.
 *
 * ASYNC because the whole page sits behind a project lookup — `ProjectConfigPage`
 * renders a loading state until `fetchProjects` resolves, so a synchronous
 * `getByTestId` here races the query and fails with "unable to find" for a
 * card that is about to exist. Four cases were written that way first and
 * failed for that reason alone.
 */
const entry = (name: string): Promise<HTMLElement> =>
  screen.findByTestId(`entry-${name.toLowerCase().replace(/\s+/g, '-')}`);

describe('ProjectSetup — the three ways in', () => {
  it('offers import, run and CI as named choices rather than one recipe', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { name: 'Add results', level: 1 })).toBeInTheDocument();

    for (const name of ['Import results', 'Run a test', 'Configure CI']) {
      expect(screen.getByRole('heading', { name, level: 2 })).toBeInTheDocument();
    }
  });

  /**
   * THE POINT OF THE SPLIT, ASSERTED AS AN ABSENCE AND A PRESENCE.
   *
   * Importing needs a credential, and the old page satisfied that by BEING
   * the credentials page — which is what made it the only route to import
   * instructions. Naming the prerequisite and linking to it is the opposite
   * arrangement, so the presence of the link matters; so does the absence of
   * a mint form, because re-adding one would quietly rebuild the old page.
   */
  it('names the token it needs and links to it, instead of managing tokens', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Add results', level: 1 });

    /* ═══ THE LINK CALLS ITS DESTINATION WHAT THAT PAGE CALLS ITSELF ═══
     *
     * This read "Mint one under Access" — wording M18 had already retired on
     * the page it points at, which is now headed "API tokens" with a "Create
     * a token" button. A cross-reference that names a screen by a word the
     * screen no longer uses sends the reader looking for something that is
     * not there, and it is exactly the vocabulary drift review 09-13 N01 is
     * about. Asserted by DESTINATION plus the two words that must agree, so a
     * future rename of that page fails here rather than drifting again. */
    const link = within(await entry('Import results')).getByRole('link', {
      name: /create one under api tokens/i,
    });
    expect(link).toHaveAttribute('href', '/projects/alpha/access');
    expect(link.textContent ?? '').not.toMatch(/mint/i);

    expect(screen.queryByRole('button', { name: /create token/i })).toBeNull();
    expect(screen.queryByLabelText(/token name/i)).toBeNull();
  });

  /**
   * REVIEW M14 — THE ONBOARDING RECIPE COULD NOT BE RUN.
   *
   * The curl example ended in a bare `/v1/runs`. A shell does not resolve that
   * against the page's origin, so the one command this product hands a new
   * user failed with "URL rejected: No host part in the request URL". Kept
   * from the old file verbatim in intent: the command moved pages, and the
   * defect it guards against is a property of the command, not of the page.
   */
  it('carries an absolute URL in both recipes, not a bare path', async () => {
    renderPage();
    for (const id of ['upload-command', 'ci-command']) {
      const command = await screen.findByTestId(id);
      expect(command.textContent).toMatch(/https?:\/\/[^\s]+\/v1\/runs/);
      expect(command.textContent).not.toMatch(/\s\/v1\/runs\s*$/m);
    }
  });

  /** The secret never appears in a command here: it is named as a variable,
   *  which is also the only correct form for the CI recipe. */
  it('refers to the token by environment variable rather than pasting one in', async () => {
    renderPage();
    const command = await screen.findByTestId('upload-command');
    expect(command.textContent).toContain('$PERFPORTAL_TOKEN');
  });
});

/* ======================================================================== *
 * STATUS — WHAT MUST NOT READ AS "AVAILABLE"
 * ======================================================================== */

describe('ProjectSetup — the runner’s status is only as strong as the evidence', () => {
  const runnerStatus = async () => within(await entry('Run a test')).getByTestId('entry-status');

  it('says nothing is known when this project has never queued a job', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { name: 'Add results', level: 1 })).toBeInTheDocument();

    const card = await entry('Run a test');
    /* "Runner availability unknown", not "No runner seen yet" — review 09-13
       M12. The old copy ended "Queue one to find out whether a node is
       connected", which asks the reader to schedule a LOAD TEST to answer a
       connectivity question. */
    await within(card).findByText(/runner availability unknown/i);
    // Still the load-bearing half: no claim of availability anywhere in it.
    expect(card.textContent ?? '').not.toMatch(/\bavailable now\b|\bonline\b/i);
    // And it does not ask for work as a diagnostic.
    expect(card.textContent ?? '').not.toMatch(/queue one to find out/i);
  });

  /**
   * ═══ REVIEW 09-13 N04 — ONLY THE CARD WITH A STATE WEARS A BADGE ═══
   *
   * Import and CI both read `Available now`, which was true the moment the
   * endpoint existed and could never have said anything else. Three identical
   * green dots teach a reader to skip the one that varies — and the runner's
   * is the one that varies, which is the whole point of the panel M16 built.
   *
   * Asserted as a PAIR. "No badge on Import" alone would pass just as well
   * against a page that had lost the runner's status too, which is the
   * regression that would actually matter.
   */
  it('wears a status badge only where there is a state to report', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Add results', level: 1 });

    for (const name of ['Import results', 'Configure CI']) {
      const card = await entry(name);
      expect(within(card).queryByTestId('entry-status')).toBeNull();
      expect(card.textContent ?? '').not.toMatch(/available now/i);
    }
    // And the one that does vary still reports.
    expect(within(await entry('Run a test')).getByTestId('entry-status')).toBeInTheDocument();
  });

  it('reports a claimed job as a runner that is there', async () => {
    fetchRunnerJobsMock.mockResolvedValueOnce({ items: [job('running', 5_000)] });
    renderPage();
    expect(await within(await entry('Run a test')).findByText(/a runner is working/i)).toBeInTheDocument();
  });

  /**
   * THE CASE THAT WOULD HAVE BEEN GOT WRONG. A project whose jobs all
   * finished proves a runner worked once and says nothing about now — the
   * instance is never told when one connects or leaves. Rounding that up to
   * "Available" is the failure this whole panel exists to avoid, because it
   * sends an engineer to wait on a queue nothing is draining.
   */
  it('will not call a project with only finished jobs available', async () => {
    fetchRunnerJobsMock.mockResolvedValueOnce({ items: [job('complete', 20 * 60_000)] });
    renderPage();

    const card = await entry('Run a test');
    await within(card).findByText(/no job in flight/i);
    expect(card.textContent ?? '').toMatch(/unknown/i);
    expect((await runnerStatus()).textContent ?? '').not.toMatch(/available|ready|online/i);
  });

  /**
   * A FAILED QUERY IS ITS OWN STATUS. "This page could not ask" is a
   * different claim from "no runner is there", and rendering the second for
   * the first sends somebody to restart a healthy machine.
   */
  it('distinguishes not being able to ask from a bad answer', async () => {
    fetchRunnerJobsMock.mockRejectedValueOnce(new Error('gateway down'));
    renderPage();

    const card = await entry('Run a test');
    await within(card).findByText(/status unavailable/i);
    expect(card.textContent ?? '').toMatch(/nothing is known about the runner either way/i);
  });

  /** Whatever the status, the action is still reachable — a status panel that
   *  hid the button would make an unknown state into a refusal. */
  it('still offers the launch form when the status is unknown', async () => {
    renderPage();
    const link = await within(await entry('Run a test')).findByRole('link', { name: /new on-prem run/i });
    expect(link).toHaveAttribute('href', '/projects/alpha/run/new');
  });
});
