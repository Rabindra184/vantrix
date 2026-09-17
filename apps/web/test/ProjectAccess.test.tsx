// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchProjects } from '../src/api/projects.js';
import { fetchProjectTokens, mintProjectToken, revokeProjectToken } from '../src/api/tokens.js';
import ProjectAccess from '../src/routes/ProjectAccess.js';

vi.mock('../src/api/projects.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/api/projects.js')>()),
  fetchProjects: vi.fn(async () => ({
    items: [
      { id: '00000000-0000-4000-8000-0000000000a1', slug: 'alpha', name: 'Alpha', latestRun: null },
    ],
  })),
}));

vi.mock('../src/api/tokens.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/api/tokens.js')>()),
  fetchProjectTokens: vi.fn(async () => ({
    tokens: [
      {
        prefix: 'pp_existing',
        name: 'Existing CI',
        scopes: ['ingest', 'read'],
        createdAt: '2026-08-20T00:00:00.000Z',
        lastUsedAt: null,
        revokedAt: null,
      },
    ],
  })),
  mintProjectToken: vi.fn(async (_slug, body) => ({
    token: 'pp_abc123_secret456',
    prefix: 'pp_abc123',
    name: body.name,
    scopes: body.scopes,
    createdAt: '2026-08-20T00:00:00.000Z',
  })),
  revokeProjectToken: vi.fn(async () => ({
    prefix: 'pp_existing',
    name: 'Existing CI',
    scopes: ['ingest', 'read'],
    createdAt: '2026-08-20T00:00:00.000Z',
    lastUsedAt: null,
    revokedAt: '2026-08-21T00:00:00.000Z',
  })),
}));

/**
 * ═══ THE RULES MOCK IS GONE, BECAUSE THE RULES PANEL IS ═══
 *
 * It used to be mocked here for a reason worth keeping in mind: the panel was
 * a third data-dependent section of this page, its query failed against no
 * server, and it announced that in a `role="alert"` the token tests below then
 * resolved to instead of their own.
 *
 * Review M15 moved rules to `/projects/:slug/rules`. Two independently-failing
 * sections are left, and both assertions below are still SCOPED to the block
 * they mean (`token-mint`, `token-list`) rather than relying on there being
 * only one alert on the page — the scoping is what survives a page growing a
 * section again, and the mock was only ever the other half of it.
 */

const fetchProjectsMock = vi.mocked(fetchProjects);
const fetchProjectTokensMock = vi.mocked(fetchProjectTokens);
const mintProjectTokenMock = vi.mocked(mintProjectToken);
const revokeProjectTokenMock = vi.mocked(revokeProjectToken);

beforeEach(() => {
  Object.assign(navigator, {
    clipboard: { writeText: vi.fn(async () => undefined) },
  });
});

afterEach(() => {
  cleanup();
  fetchProjectsMock.mockClear();
  fetchProjectTokensMock.mockClear();
  mintProjectTokenMock.mockClear();
  revokeProjectTokenMock.mockClear();
});

describe('ProjectAccess', () => {
  // The two token blocks, so an assertion can name the one it means rather
  // than resolving to whichever of the page's alerts happened to render.
  /** The mint form and the once-only secret it reveals. */
  const mintCard = () => screen.getByTestId('token-mint');
  /** The token table and the revoke alert that sits above it. */
  const tokenList = () => screen.getByTestId('token-list');

  function renderSetup() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    return render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/projects/alpha/access']}>
          <Routes>
            <Route path="/projects/:slug/access" element={<ProjectAccess />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  /**
   * The page is ready when its own section is the current one in the shell's nav.
   *
   * IT USED TO BE A LEVEL-1 HEADING QUERY for "API tokens". Review M10 made the
   * `<h1>` the PROJECT and left the section to `ProjectShell`'s nav, which marks
   * exactly one link `aria-current="page"` — and that matters more here than
   * anywhere, because this page ALSO carries a plain "Add results" link beside
   * the minted secret. Two links can share a name; only one can be current.
   */
  const ready = (): Promise<HTMLElement> =>
    screen.findByRole('link', { name: 'API tokens', current: 'page' });

  it('mints a scoped token and renders the once-only secret', async () => {
    renderSetup();

    expect(await ready()).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/token name/i), { target: { value: 'Nightly CI' } });
    fireEvent.click(screen.getByRole('button', { name: /create token/i }));

    expect(await screen.findByText('pp_abc123_secret456')).toBeInTheDocument();
    expect(mintProjectTokenMock).toHaveBeenCalledWith('alpha', {
      name: 'Nightly CI',
      scopes: ['ingest', 'read'],
    });
  });

  /**
   * ═══ THE COMMAND USED TO BE ON THIS PAGE, WITH THE SECRET PASTED IN ═══
   *
   * Minting rendered a ready-to-run `curl` carrying the plaintext token, which
   * was genuinely convenient and was exactly what tied importing a report to
   * the credentials screen — review M15's objection. The command moved to
   * `Add results` and names an environment variable instead.
   *
   * What replaces it is a link, asserted here because the convenience is the
   * part a split most easily loses: somebody who came to get started should
   * not have to work out where to go next from a page that just handed them a
   * secret.
   */
  it('points a freshly-minted token at the page that uses it', async () => {
    renderSetup();

    expect(await ready()).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /create token/i }));
    expect(await screen.findByText('pp_abc123_secret456')).toBeInTheDocument();

    const next = within(mintCard()).getByRole('link', { name: /add results/i });
    expect(next).toHaveAttribute('href', '/projects/alpha/setup');

    // And the secret is NOT pasted into a command here any more — the whole
    // point of the move. Nothing on this page is a runnable ingest recipe.
    expect(screen.queryByText(/curl -H/)).toBeNull();
  });

  /**
   * THE ONE ACTION WHERE SILENCE IS DANGEROUS, and the only path the mint
   * side already covered by having its own `role="alert"`.
   *
   * A revoke that fails used to be indistinguishable from one that
   * succeeded: the spinner stopped, the row still read "Active", and nothing
   * was announced. An operator killing a LEAKED credential would conclude it
   * was dead while it was still live — so this asserts the alert exists, is
   * announced, names the token, and carries what the server actually said.
   */
  it('says so when a revoke fails, rather than looking like it worked', async () => {
    revokeProjectTokenMock.mockRejectedValueOnce(new Error('network down'));
    renderSetup();

    expect(await screen.findByText('pp_existing')).toBeInTheDocument();
    // Two clicks, because revoking is now deliberate: arm, then confirm.
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm revoke' }));

    // SCOPED to the token list, not `screen`. This page has several sections
    // that each announce their own failures, so a page-wide alert query
    // silently asks "did ANYTHING go wrong" rather than "did the revoke".
    const alert = await within(tokenList()).findByRole('alert');
    // Names the token, and does NOT overclaim: a request that failed on the
    // way back may still have succeeded on the server.
    expect(alert).toHaveTextContent('pp_existing');
    expect(alert).toHaveTextContent(/may still be active/i);
    // The server's own words reach the reader.
    expect(alert).toHaveTextContent('network down');
  });

  it('lists existing tokens and revokes by prefix', async () => {
    renderSetup();

    expect(await screen.findByText('Existing CI')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm revoke' }));
    await waitFor(() => {
      expect(revokeProjectTokenMock).toHaveBeenCalledWith('alpha', 'pp_existing');
    });
  });

  /**
   * THE CONFIRMATION IS THE TEST, not the revoke.
   *
   * This is the app's only destructive control, and it used to fire on one
   * click of a `ghost` button sitting in a dense table row: a misclick
   * revoked a live credential, every CI job using it began failing 401, and
   * there is no undo — only minting a replacement and redistributing it.
   *
   * Asserting the NEGATIVE is the whole point: arming the control must not
   * call the API. A test that only clicked twice and checked the call would
   * pass against the original one-click code.
   */
  it('does not revoke on the first click, and can be cancelled', async () => {
    renderSetup();

    expect(await screen.findByText('Existing CI')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    expect(revokeProjectTokenMock).not.toHaveBeenCalled();

    // Cancel disarms it and puts the original control back, so nothing is
    // left primed in the row.
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: 'Revoke' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Confirm revoke' })).toBeNull();
    expect(revokeProjectTokenMock).not.toHaveBeenCalled();
  });

  /**
   * The clipboard is absent on any page that is not a secure context —
   * plain http on anything but localhost, i.e. an ordinary way to reach an
   * on-prem install. The old code optional-chained it, so `await undefined`
   * resolved and the button said "Copied" over a secret that had gone
   * nowhere, shown once and never again.
   */
  it('admits it when the token could not be copied', async () => {
    Object.assign(navigator, { clipboard: undefined });
    renderSetup();

    expect(await ready()).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /create token/i }));
    expect(await screen.findByText('pp_abc123_secret456')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));

    expect(await within(mintCard()).findByRole('alert')).toHaveTextContent(/could not be copied/i);
    // And it must NOT claim success.
    expect(screen.queryByRole('button', { name: 'Copied' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument();
  });

  /* ======================================================================== *
   * VOCABULARY — REVIEW M18, AND THE HALF THAT SURVIVED IT
   * ======================================================================== */

  describe('ProjectAccess — the words M18 retired stay retired', () => {
    /**
     * ═══ M18 RENAMED THE CONTROLS AND MISSED THE PROSE AROUND THEM ═══
     *
     * "Mint" and "Scopes" are the jargon the review asked this page to drop, and
     * the visible CONTROLS were renamed: "Create a token", "Create token",
     * "Permissions", and a table cell that prints "Completed reports" instead of
     * `ingest`. Four sentences were not, and they shipped for two more branches:
     * the section intro ("Scoped API tokens for…"), the create card's
     * description ("Issue scoped credentials…"), the empty state ("Mint a scoped
     * project token…") and the table caption ("…never listed after minting").
     *
     * Nothing could have caught it. Every case in this file queries a control by
     * its accessible name, and all four of those strings are PROSE — no test in
     * any suite reads the sentences a page says about itself, which is exactly
     * how a page came to name its own primary action two different ways. It was
     * found by opening the page.
     *
     * ═══ THE CLAIM, NOT THE WORDS ═══
     *
     * Asserted as an ABSENCE of the retired vocabulary rather than as the
     * presence of the new sentences. CLAUDE.md records what pinning prose
     * verbatim costs: the M18 branch asserted "the words are not weakened" over
     * a run-health caveat that had already become false, and the suite became
     * the reason it survived correction. These sentences must stay rewritable;
     * what must not come back is the jargon.
     *
     * BOTH LIST STATES, because two of the four sentences live in branches that
     * are never on screen together — the caption needs a token, the empty state
     * needs none.
     */
    const prose = () => document.body.textContent ?? '';

    it('says neither "mint" nor "scope" with tokens in the list', async () => {
      renderSetup();
      await ready();
      /* The caption is the one that said "after minting", and it only renders
         beside a real table. `findAllBy`, not `findBy`: `TableFrame` draws the
         caption TWICE on purpose — a visible `aria-hidden` copy outside the
         scroll box, and the real `sr-only` `<caption>` inside it, so the
         sentence wraps at the viewport instead of scrolling sideways with the
         columns. Either node proves the branch rendered. */
      await screen.findAllByText(/every api token in this project/i);

      expect(prose()).not.toMatch(/\bmint/i);
      expect(prose()).not.toMatch(/\bscoped?s?\b/i);
    });

    it('says neither with an empty list', async () => {
      fetchProjectTokensMock.mockResolvedValueOnce({ tokens: [] });
      renderSetup();
      await ready();
      await screen.findByText(/no tokens yet/i);

      expect(prose()).not.toMatch(/\bmint/i);
      expect(prose()).not.toMatch(/\bscoped?s?\b/i);
    });

    /**
     * THE PAIRED POSITIVE. An absence assertion passes just as happily against a
     * page that failed to render at all — the trap `ProjectRail.test.tsx`
     * already keeps a positive beside every absence for. "Permissions" is the
     * word M18 chose, and it has to be the one on screen.
     */
    it('calls them permissions, in the form and in the table alike', async () => {
      renderSetup();
      await ready();

      expect(await screen.findByText('Permissions')).toBeInTheDocument();
      expect(screen.getByRole('columnheader', { name: 'Permissions' })).toBeInTheDocument();
      // The cell prints the humanised label, not the enum it is stored as.
      expect(screen.getByText('Completed reports, Read dashboards')).toBeInTheDocument();
    });
  });

  /* ====================================================================== *
   * REVIEW M18 — A TOKEN'S LIFETIME, AUTHORED AND THEN VISIBLE
   * ====================================================================== */

  /**
   * ═══ THE COLUMN AND THE STATUS ANSWER DIFFERENT QUESTIONS ═══
   *
   * "Expires" is a FACT about the credential — when it runs out, or never.
   * "Status" is whether it works right now, and a token can fail for two
   * independent reasons. Asserting only one of them would let the other drift:
   * a table printing a past date beside "Active" is precisely the state M18
   * exists to make impossible, and it reads fine column by column.
   *
   * Indexes are DERIVED from the header rather than written down, for the
   * reason this repo already paid for once: a column reorder made a `.nth(3)`
   * status assertion read the simulation cell instead, and failed for a reason
   * that was not the rule under test. Two columns here also print the word
   * "Never" (Last used and Expires), so an unindexed text query cannot tell
   * them apart at all.
   */
  const columnIndex = (label: string): number => {
    const headers = within(tokenList()).getAllByRole('columnheader');
    const index = headers.findIndex((h) => h.textContent?.trim() === label);
    expect(index, `no "${label}" column`).toBeGreaterThanOrEqual(0);
    return index;
  };
  const cellOf = (tokenName: string, column: string): HTMLElement => {
    const row = within(tokenList()).getByRole('row', { name: new RegExp(tokenName) });
    return within(row).getAllByRole('cell')[columnIndex(column)]!;
  };

  const tokenRow = (over: Record<string, unknown>) => ({
    prefix: 'pp_existing',
    name: 'Existing CI',
    scopes: ['ingest', 'read'],
    createdAt: '2026-08-20T00:00:00.000Z',
    lastUsedAt: null,
    revokedAt: null,
    ...over,
  });

  it('offers an expiry choice that starts at never, and sends no expiry for it', async () => {
    renderSetup();
    await ready();

    // The default is the one the FINDING asks for: no server policy, and no
    // lifetime imposed on a caller who did not choose one.
    expect(screen.getByTestId('token-expiry')).toHaveValue('');

    fireEvent.change(screen.getByLabelText(/token name/i), { target: { value: 'Nightly CI' } });
    fireEvent.click(screen.getByRole('button', { name: /create token/i }));

    await waitFor(() => expect(mintProjectTokenMock).toHaveBeenCalled());
    // Not `expiresAt: null` — the field is optional and its absence is what the
    // schema reads as "never". A null would be a value the contract refuses.
    expect(mintProjectTokenMock.mock.calls[0]![1].expiresAt).toBeUndefined();
  });

  it('sends the chosen lifetime as an instant that far ahead', async () => {
    renderSetup();
    await ready();

    fireEvent.change(screen.getByLabelText(/token name/i), { target: { value: 'Quarterly' } });
    fireEvent.change(screen.getByTestId('token-expiry'), { target: { value: '90' } });
    fireEvent.click(screen.getByRole('button', { name: /create token/i }));

    await waitFor(() => expect(mintProjectTokenMock).toHaveBeenCalled());
    const sent = mintProjectTokenMock.mock.calls[0]![1].expiresAt;
    expect(sent).toBeDefined();
    // COMPUTED, not written down: a hard-coded instant would break on the next
    // day this suite runs. The window is wide because the assertion is about
    // the ARITHMETIC — 90 days, not 90 hours or 90 minutes — and narrow enough
    // that an off-by-one unit fails it.
    const drift = Math.abs(Date.parse(sent!) - (Date.now() + 90 * 86_400_000));
    expect(drift).toBeLessThan(60_000);
  });

  it('prints Never for a token that does not expire, and the date for one that does', async () => {
    fetchProjectTokensMock.mockResolvedValueOnce({
      tokens: [
        tokenRow({ prefix: 'pp_forever', name: 'Forever CI', expiresAt: null }),
        tokenRow({ prefix: 'pp_dated', name: 'Dated CI', expiresAt: '2027-01-15T09:30:00.000Z' }),
      ],
    });
    renderSetup();
    await ready();
    await screen.findByText('Dated CI');

    expect(cellOf('Forever CI', 'Expires')).toHaveTextContent('Never');
    expect(cellOf('Forever CI', 'Status')).toHaveTextContent('Active');
    // The year is enough: `formatInstant` renders in the reader's own zone, so
    // pinning the rendered string would pin this suite's timezone rather than
    // the component.
    expect(cellOf('Dated CI', 'Expires')).toHaveTextContent('2027');
    expect(cellOf('Dated CI', 'Status')).toHaveTextContent('Active');
  });

  it('calls a token whose expiry has passed expired, not active', async () => {
    fetchProjectTokensMock.mockResolvedValueOnce({
      tokens: [tokenRow({ name: 'Lapsed CI', expiresAt: '2020-01-01T00:00:00.000Z' })],
    });
    renderSetup();
    await ready();
    await screen.findByText('Lapsed CI');

    expect(cellOf('Lapsed CI', 'Status')).toHaveTextContent('Expired');
    // The date stays visible beside the verdict: "Expired" with no date says a
    // credential stopped working and not when, which is half the answer.
    expect(cellOf('Lapsed CI', 'Expires')).toHaveTextContent('2020');
  });

  it('calls a token that is both revoked and expired revoked', async () => {
    // Revocation is a decision somebody made; expiry is time passing. Only the
    // first is actionable — "Expired" here would be true and would send the
    // reader to mint a replacement of a credential that was deliberately
    // killed. The ORDER inside `tokenStatus` is the whole function, so this is
    // the case that pins it: a row satisfying both conditions at once.
    fetchProjectTokensMock.mockResolvedValueOnce({
      tokens: [
        tokenRow({
          name: 'Killed CI',
          expiresAt: '2020-01-01T00:00:00.000Z',
          revokedAt: '2026-08-21T00:00:00.000Z',
        }),
      ],
    });
    renderSetup();
    await ready();
    await screen.findByText('Killed CI');

    expect(cellOf('Killed CI', 'Status')).toHaveTextContent('Revoked');
    expect(cellOf('Killed CI', 'Status')).not.toHaveTextContent('Expired');
  });

  it('reads a missing expiry as never, the way an API that predates the field reports it', async () => {
    // `undefined` is not a token without an expiry — it is a pod that has not
    // been deployed yet, mid-rolling-deploy. It must read exactly as the page
    // read before this column existed, which is the whole reason the contract
    // field is `.optional()` as well as `.nullable()`.
    //
    // AND THE COST OF GETTING IT WRONG IS NOT A WRONG LABEL. Measured by
    // narrowing the cell's guard to `=== null`: `formatInstant(undefined)`
    // throws `RangeError: Invalid time value`, which takes the whole token
    // table down — 11 of this file's 15 cases fail, not one. So the guard is
    // load-bearing for the PAGE, not just for this column.
    fetchProjectTokensMock.mockResolvedValueOnce({
      tokens: [tokenRow({ name: 'Old Pod CI' })],
    });
    renderSetup();
    await ready();
    await screen.findByText('Old Pod CI');

    expect(cellOf('Old Pod CI', 'Expires')).toHaveTextContent('Never');
    expect(cellOf('Old Pod CI', 'Status')).toHaveTextContent('Active');
  });

});
