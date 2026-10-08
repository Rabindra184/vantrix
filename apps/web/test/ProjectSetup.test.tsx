// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectRole } from '@perfportal/contracts';
import { fetchProjects } from '../src/api/projects.js';
import { fetchRunnerJobs } from '../src/api/runner.js';
import ProjectSetup from '../src/routes/ProjectSetup.js';
import { seedAccess } from './support/access';

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
  vi.unstubAllGlobals();
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

function renderPage(
  // An admin by default: every claim here before the token-link cases is
  // about the page a reader who MAY add results sees — and the shell offers
  // this section's tab, which `ready` waits on, only once access is known and
  // allows `run:upload`. `null` seeds nothing.
  who: { isAdmin: boolean; roles?: Readonly<Record<string, ProjectRole>> } | null = { isAdmin: true },
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  if (who !== null) seedAccess(client, who);
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
 * ASYNC because the cards are behind `fetchRunnerJobs`, so a synchronous
 * `getByTestId` here races the query and fails with "unable to find" for a
 * card that is about to exist. Four cases were written that way first and
 * failed for that reason alone.
 */
const entry = (name: string): Promise<HTMLElement> =>
  screen.findByTestId(`entry-${name.toLowerCase().replace(/\s+/g, '-')}`);

/**
 * The page is ready when its own section is the current one in the shell's nav.
 *
 * IT USED TO BE A LEVEL-1 HEADING QUERY for "Add results". Review M10 made the
 * `<h1>` the PROJECT and left the section to `ProjectShell`'s nav, which marks
 * exactly one link `aria-current="page"`. This is the stronger gate of the
 * two: it asserts the shell put the marker on the right tab, which a heading
 * query could not see at all.
 */
const ready = (): Promise<HTMLElement> =>
  screen.findByRole('link', { name: 'Add results', current: 'page' });

describe('ProjectSetup — the three ways in', () => {
  it('offers import, run and CI as named choices rather than one recipe', async () => {
    renderPage();
    expect(await ready()).toBeInTheDocument();

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
  /**
   * ═══ THE CHOICES ARE THE INTRO (review 09-13 copy table) ═══
   *
   * This page opened with "Three ways to get a run into this project. Pick the
   * one that matches what you already have." — a sentence that counted the
   * cards below it and told the reader to pick one. The copy table replaces
   * that whole pattern with "`Add results` with short workflow choices", and
   * M04 had already built the choices; the paragraph outlived its own job.
   *
   * PAIRED, because "the sentence is gone" passes just as happily against a
   * page that failed to render at all.
   */
  it('opens with the choices rather than a sentence counting them', async () => {
    renderPage();
    expect(await ready()).toBeInTheDocument();

    for (const name of ['Import results', 'Run a test', 'Configure CI']) {
      expect(await entry(name)).toBeInTheDocument();
    }
    expect(document.body.textContent ?? '').not.toMatch(/three ways to get a run/i);
  });

  /**
   * ═══ EACH CARD IS A TITLE AND ITS ACTION (clean UI PR 4) ═══
   *
   * Every card carried a description under its title, the runner card a
   * paragraph about streaming, CI a sentence about secret stores. The
   * picker — Import's action — sat behind "Show me how". It is on the card
   * now, outside any disclosure, and the descriptions are gone.
   */
  it('shows the picker at once and carries no description under any card', async () => {
    renderPage();
    await ready();

    const importCard = await entry('Import results');
    const picker = importCard.querySelector('input[type="file"]');
    expect(picker).not.toBeNull();
    expect(picker!.closest('details')).toBeNull();

    const text = document.body.textContent ?? '';
    for (const gone of [/finished Gatling report/, /No bundle yet/, /trend line keeps itself/, /streams the log/, /secret store/]) {
      expect(text).not.toMatch(gone);
    }
    for (const name of ['Import results', 'Run a test', 'Configure CI']) {
      expect(screen.getByRole('heading', { name, level: 2 })).toBeInTheDocument();
    }
  });

  it('names the token it needs and links to it, instead of managing tokens', async () => {
    renderPage();
    await ready();

    /* ═══ THE LINK CALLS ITS DESTINATION WHAT THAT PAGE CALLS ITSELF ═══
     *
     * This read "Mint one under Access" — wording M18 had already retired on
     * the page it points at, which is now headed "API tokens" with a "Create
     * a token" button. A cross-reference that names a screen by a word the
     * screen no longer uses sends the reader looking for something that is
     * not there, and it is exactly the vocabulary drift review 09-13 N01 is
     * about. Asserted by DESTINATION plus the two words that must agree, so a
     * future rename of that page fails here rather than drifting again. */
    const link = within(await entry('Import results')).getByRole('link', { name: 'Create one' });
    expect(link).toHaveAttribute('href', '/projects/alpha/access');
    expect(link.textContent ?? '').not.toMatch(/mint/i);

    /* ═══ THE TOKEN BELONGS TO THE TERMINAL, NOT TO THE CARD (clean UI PR 4) ═══
     *
     * The card said "Needs a token with the Completed reports permission" over
     * a picker that needs none: a signed-in upload goes through the session.
     * Only the curl needs `PERFPORTAL_TOKEN`, so the requirement lives inside
     * the disclosure that holds it — and nothing outside it mentions a token.
     * Still free of the vocabulary M18 retired ("mint", "scope"). */
    const card = await entry('Import results');
    const details = card.querySelector('details');
    expect(details).not.toBeNull();
    expect(details).toContainElement(link);
    expect(details!.textContent ?? '').toMatch(/PERFPORTAL_TOKEN.{0,3}\(Completed reports\)/);
    const outside = (card.textContent ?? '').replace(details!.textContent ?? '', '');
    expect(outside).not.toMatch(/token/i);
    expect(card.textContent ?? '').not.toMatch(/\bscoped?s?\b/i);

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
  const runnerStatus = async () => within(await entry('Run a test')).getByTestId('runner-status');

  it('says nothing is known when this project has never queued a job', async () => {
    renderPage();
    expect(await ready()).toBeInTheDocument();

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

    /* ═══ AND IT OFFERS SOMETHING TO DO (review 09-13 copy table) ═══
     *
     * The row asks for "`Runner availability unknown` + a useful
     * connection/setup action". M12 delivered the headline and removed the
     * bad affordance, leaving a state that explains what is unknown and hands
     * the reader nothing. The token is the half this app owns — deploying the
     * process is `infra/README.md`'s — so the action names the deployment and
     * links to the page that mints the credential it needs. */
    const setup = within(card).getByTestId('runner-setup');
    // One link, not a paragraph (clean UI PR 4): the action is the token.
    expect(setup).toHaveRole('link');
    expect(setup).toHaveAccessibleName('Create a runner token');
    expect(setup).toHaveAttribute('href', '/projects/alpha/access');
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
    await ready();

    for (const name of ['Import results', 'Configure CI']) {
      const card = await entry(name);
      expect(within(card).queryByTestId('runner-status')).toBeNull();
      expect(card.textContent ?? '').not.toMatch(/available now/i);
    }
    // And the one that does vary still reports.
    expect(within(await entry('Run a test')).getByTestId('runner-status')).toBeInTheDocument();
  });

  it('reports a claimed job as a runner that is there', async () => {
    fetchRunnerJobsMock.mockResolvedValueOnce({ items: [job('running', 5_000)] });
    renderPage();
    const card = await entry('Run a test');
    expect(await within(card).findByText(/a runner is working/i)).toBeInTheDocument();

    /* AND NO SETUP ACTION HERE, which is the half that keeps the one above
       honest. A runner has been seen, so telling this reader to go deploy one
       is wrong advice confidently given — the shape M12 was about. The
       unknown-state case asserts the link is present; without this one it
       would pass just as happily against a card that shows it always. */
    expect(within(card).queryByTestId('runner-setup')).toBeNull();
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
    // "Whether one is listening now" is the caveat every state shares, behind
    // the line's ⓘ (clean UI PR 4).
    expect(within(card).getByRole('button', { name: 'About runner status' })).toHaveAccessibleDescription(
      /known only once a job is claimed/,
    );
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
    expect(card.textContent ?? '').toMatch(/The job list could not be loaded/);
    // A failed list is not a runner state, so it carries none of the states'
    // caveat either.
    expect(within(card).queryByRole('button', { name: 'About runner status' })).toBeNull();
  });

  /** Whatever the status, the action is still reachable — a status panel that
   *  hid the button would make an unknown state into a refusal. */
  it('still offers the launch form when the status is unknown', async () => {
    renderPage();
    const link = await within(await entry('Run a test')).findByRole('link', { name: /new on-prem run/i });
    expect(link).toHaveAttribute('href', '/projects/alpha/run/new');
  });
});

/* ======================================================================== *
 * REVIEW M04 — THREE CHOICES, NOT THREE DOCUMENTS
 * ======================================================================== */

describe('ProjectSetup — the workflows are choices before they are documents', () => {
  /**
   * The finding is that this page "presented documentation as task UI": all
   * three paths showed their explanations, prerequisites, code and
   * implementation caveats at once. What it asks for is three short choices,
   * with only the chosen workflow expanded.
   *
   * ASSERTED ON `open`, NOT ON ABSENCE. jsdom applies no CSS and a closed
   * `<details>` keeps its children in the DOM, so `queryByTestId` finds the
   * curl command either way — the same reason the `truncate` and `max-sm:hidden`
   * claims elsewhere in this repo need a browser or an attribute. The
   * attribute is the honest thing to read here.
   */
  it('keeps each path’s commands closed until they are asked for', async () => {
    renderPage();
    await ready();

    for (const [name, command] of [
      ['Import results', 'upload-command'],
      ['Configure CI', 'ci-command'],
    ] as const) {
      const card = await entry(name);
      const disclosure = card.querySelector('details');
      expect(disclosure, `${name} shows its commands with no disclosure`).not.toBeNull();
      expect(disclosure!.open, `${name} starts expanded`).toBe(false);
      // The content is still THERE — closed, not deleted, so a reader who
      // opens it needs no request and the page needs no state.
      expect(card.querySelector(`[data-testid="${command}"]`)).not.toBeNull();
    }
  });

  /**
   * ═══ AN ACCORDION WITH NO JAVASCRIPT ═══
   *
   * A shared `name` is what makes a browser close the others — "expand only
   * the chosen workflow", for free. Where it is unsupported they open
   * independently, which is the behaviour this replaced and not a defect, so
   * the NAME is what this pins; `project-tests.spec.ts` proves the exclusion
   * itself in a real engine.
   *
   * ═══ AND A NESTED DISCLOSURE MUST NOT JOIN THE ACCORDION ═══
   *
   * This asserted the name of EVERY `<details>` in the document, which was the
   * same thing while every one of them was a card. M05's file picker took the
   * primary slot inside Import results and moved the curl recipe behind its own
   * summary, so there is now a disclosure INSIDE one of the three.
   *
   * It must stay nameless, and the failure if it does not is worth stating:
   * opening the terminal recipe would close the card that contains it, taking
   * the recipe off screen in the same gesture that asked for it. So the shape
   * is pinned rather than the count — every CARD-level disclosure shares the
   * name, every nested one has none — which is a rule the next disclosure
   * added to this page also has to satisfy.
   */
  it('groups the card disclosures so a browser can close the others', async () => {
    renderPage();
    await ready();

    /* ═══ TWO DISCLOSURES, NEITHER INSIDE THE OTHER (clean UI PR 4) ═══
     *
     * The terminal recipe sat behind its own `<details>` INSIDE Import's card
     * disclosure, which is the nesting Playwright's WebKit path cannot assert
     * through. With the picker on the card, Import's terminal recipe IS that
     * card's disclosure, so the page holds exactly two — Import's and CI's —
     * both in the accordion, and nothing nested. */
    const all = [...document.querySelectorAll('details')];
    expect(all).toHaveLength(2);
    expect(all.map((d) => d.getAttribute('name'))).toEqual(['add-results', 'add-results']);
    expect(all.filter((d) => d.parentElement?.closest('details') != null)).toEqual([]);
  });

  /** CI's notes ride behind an info; the plugin keeps one line (clean UI PR 4). */
  /** PR 4 cleanup: a static summary reads the same open or closed, so each
   *  carries a chevron that turns when its disclosure opens. Screen readers
   *  already hear expanded or collapsed, so the chevron is `aria-hidden`. */
  it('marks each disclosure open or closed with a chevron', async () => {
    renderPage();
    await ready();
    const all = [...document.querySelectorAll('details')];
    expect(all).toHaveLength(2);
    for (const details of all) {
      expect(details).toHaveClass('group');
      const chevron = details.querySelector('summary svg');
      expect(chevron).not.toBeNull();
      expect(chevron).toHaveAttribute('aria-hidden', 'true');
      expect(chevron!.getAttribute('class') ?? '').toContain('group-open:rotate-90');
    }
  });

  it('puts the CI notes behind an info and keeps one line about the plugin', async () => {
    renderPage();
    await ready();

    const details = (await entry('Configure CI')).querySelector('details')!;
    expect(within(details).getByRole('link', { name: 'Create one' })).toHaveAttribute('href', '/projects/alpha/access');
    expect(details.textContent ?? '').toMatch(/PERFPORTAL_TOKEN.{0,3}in your pipeline secrets/);
    expect(within(details).getByRole('button', { name: 'About the CI step' })).toHaveAccessibleDescription(/commitSha/);
    expect(details.textContent ?? '').toMatch(/Gradle plugin\s*dev\.vantrix\.gatling/);
    // FINAL REVIEW, IMPORTANT 3: and where it lives — it is on no public
    // portal, so a coordinate alone is "plugin not found".
    expect(details.textContent ?? '').toMatch(/clients\/gatling-gradle/);
  });

  /**
   * FINAL REVIEW, IMPORTANT (re-graded): "Create a runner token" is the
   * never-seen-a-runner action. A list that is still loading, or failed to
   * load, has seen nothing either way — offering setup there is the wrong
   * advice M12 was about, under a status that says it does not know.
   */
  it('offers no runner setup while the job list loads or after it fails', async () => {
    fetchRunnerJobsMock.mockReturnValueOnce(new Promise(() => {}));
    renderPage();
    const loading = await entry('Run a test');
    expect(within(loading).getByTestId('runner-status')).toHaveTextContent(/Checking…/);
    expect(within(loading).queryByTestId('runner-setup')).toBeNull();
    cleanup();

    fetchRunnerJobsMock.mockRejectedValueOnce(new Error('gateway down'));
    renderPage();
    const failed = await entry('Run a test');
    await within(failed).findByText(/status unavailable/i);
    expect(within(failed).queryByTestId('runner-setup')).toBeNull();
  });

  /**
   * THE RUNNER PATH HAS NOTHING TO HIDE, and wrapping it anyway would bury an
   * action rather than shorten a document. Its whole body is a sentence and
   * the button that starts a run — which is the choice, not documentation
   * about the choice. Stated as a case because "collapse everything" is the
   * tidier-looking change and the wrong one.
   */
  it('leaves the path whose content is already a choice alone', async () => {
    renderPage();
    await ready();

    const card = await entry('Run a test');
    expect(card.querySelector('details')).toBeNull();
    expect(within(card).getByRole('link', { name: /new on-prem run/i })).toBeInTheDocument();
  });

  /**
   * The three choices themselves stay on screen — the status badge included,
   * since M16 built it to be the one varying signal on this page. A page that
   * collapsed the titles too would be a menu, not a set of choices.
   */
  it('still shows all three choices, and the one status that varies', async () => {
    renderPage();
    await ready();

    for (const name of ['Import results', 'Run a test', 'Configure CI']) {
      expect(screen.getByRole('heading', { name, level: 2 })).toBeInTheDocument();
    }
    expect(within(await entry('Run a test')).getByTestId('runner-status')).toBeInTheDocument();
  });

  /* ====================================================================== *
   * REVIEW M05 — THE LABEL PROMISES WHAT THE PAGE CAN DO
   * ====================================================================== */

  /**
   * ═══ THE INTERIM IS OVER, AND THIS CASE IS ITS SUCCESSOR ═══
   *
   * This used to read "names the import path for the interaction it actually
   * offers", and asserted the heading was "Import via API" with NO file input
   * anywhere on the page. That was correct: `POST /v1/runs` refused a session,
   * so a picker had no route to post to, and a card headed "Import results"
   * over a page that could not import results was the lie M05 names.
   *
   * Its own docstring said how it should die — "when the picker is built, that
   * second assertion is what should fail" — and that is exactly what happened.
   * `POST /v1/projects/:slug/runs` exists now (`project-ingest.controller.ts`),
   * so both halves INVERT rather than being deleted: the honest label was
   * honest about an absence, and the absence is gone.
   *
   * STILL ASSERTED AS THE PAIR, for the reason the interim gave. A file input
   * under a title saying "via API" would be a card describing the wrong thing,
   * and a title promising an import over a page with no picker is the defect
   * the interim existed to prevent. Either half alone passes against one of
   * those two pages.
   */
  it('offers the import the card is named for', async () => {
    renderPage();
    await ready();

    expect(screen.getByRole('heading', { name: 'Import results', level: 2 })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /import via api/i })).toBeNull();

    // The picker itself — the assertion the interim case was written to fail on.
    expect(document.querySelector('input[type="file"]')).not.toBeNull();
  });
});

/**
 * ═══ A LINK TO API TOKENS IS A MANAGER'S (project access, PR 3) ═══
 *
 * Gate by destination: the API tokens page exists to manage tokens, which is
 * `tokens:manage`, so each of this page's three ways there — Import's and CI's
 * "Create one", and the runner card's "Create a runner token" — is drawn only
 * for a reader who may. Anyone else would follow it to a page that can only
 * tell them no.
 */
describe('ProjectSetup — the links to API tokens follow the role', () => {
  /**
   * Every link THIS PAGE draws to API tokens — outside the shell's nav, whose
   * own API tokens tab is `ProjectShell`'s to gate and is tested there.
   */
  const tokenLinks = () =>
    screen
      .queryAllByRole('link')
      .filter((a) => a.getAttribute('href') === '/projects/alpha/access' && a.closest('nav') === null);

  /**
   * Settled: the runner card's link waits on the job list (see `needsSetup`),
   * so its absence means something only once that list has answered — the
   * "unknown" headline is what an answered empty list says.
   */
  async function settled() {
    await within(await entry('Run a test')).findByText(/runner availability unknown/i);
  }

  it.each([
    ['a viewer', 'viewer'],
    ['a member', 'member'],
  ] as const)('draws none of the three for %s', async (_who, role) => {
    renderPage({ isAdmin: false, roles: { alpha: role } });
    await settled();

    expect(tokenLinks()).toEqual([]);
    expect(screen.queryByRole('link', { name: 'Create one' })).toBeNull();
    expect(screen.queryByTestId('runner-setup')).toBeNull();
    // The prerequisite is still named where it applies; only the way there goes.
    expect(within(await entry('Import results')).getByText('PERFPORTAL_TOKEN')).toBeInTheDocument();
  });

  it('draws all three for a manager', async () => {
    renderPage({ isAdmin: false, roles: { alpha: 'manager' } });
    await settled();

    expect(tokenLinks()).toHaveLength(3);
    expect(screen.getByTestId('runner-setup')).toHaveAttribute('href', '/projects/alpha/access');
  });

  /** Review Focus 2: while the session is held nothing is known, so none is drawn — and nobody is refused. */
  it('draws none while access is pending', async () => {
    vi.stubGlobal('fetch', () => new Promise<Response>(() => {}));
    renderPage(null);
    await settled();

    expect(tokenLinks()).toEqual([]);
    expect(screen.queryByText(/needs the .* role/)).toBeNull();
  });
});
