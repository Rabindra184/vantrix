// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

/* Mocked before the import below, because sign out posts on select and jsdom
   has no server — an unmocked call would reject and paint the failure state
   over every case here. */
let signOutCalls = 0;
vi.mock('../src/api/session.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/api/session.js')>()),
  signOut: async () => {
    signOutCalls += 1;
  },
}));

const { default: AccountMenu } = await import('../src/AccountMenu');

/**
 * ═══ REVIEW 09-13 N03 — THE TWO LEAST-USED CONTROLS HELD PERMANENT CHROME ═══
 *
 * The header carried a brand, a truncated email, three theme buttons and Sign
 * out at equal weight. Theme is set once and Sign out is pressed at the end of
 * a session; the identity — the question the chrome should actually answer —
 * was a 12px span that disappeared below `sm`.
 *
 * ═══ IT IS A REAL MENU, AND THAT IS THE POINT ═══
 *
 * The first cut refused `role="menu"` because a menu promises arrow keys,
 * typeahead and Home/End, and half-keeping a role is worse than not claiming
 * it — the lesson the old `ThemeToggle` earned by shipping `role="radio"` with
 * no arrow handling. Radix keeps the promise instead, so these cases assert
 * the promise is kept: `menuitemradio` for the theme, arrows that actually
 * move, and a tick on exactly one option.
 *
 * WHAT THESE CASES GUARD. The menu content is PORTALLED and mounted only when
 * open, which is what keeps the "exactly one Sign out control" assertions in
 * `AppShell.test.tsx` and two e2e specs honest — jsdom applies no CSS, so a
 * CSS-hidden panel would be fully present there and read as the duplication
 * they exist to catch.
 */

afterEach(() => {
  cleanup();
  signOutCalls = 0;
  delete document.documentElement.dataset.theme;
});

function renderMenu(identity: string | null = 'qa@perfportal.test') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <AccountMenu identity={identity} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const trigger = () => screen.getByTestId('account-menu-trigger');

describe('AccountMenu — the closed state', () => {
  it('carries neither control until it is opened', () => {
    renderMenu();
    expect(screen.queryByRole('menuitem', { name: /sign out/i })).toBeNull();
    expect(screen.queryAllByRole('menuitemradio')).toHaveLength(0);
    expect(trigger()).toHaveAttribute('aria-expanded', 'false');
  });

  /**
   * THE IDENTITY IS IN THE ACCESSIBLE NAME AT EVERY WIDTH. It is `sr-only`
   * below `sm` rather than `hidden`, so the button does not change its name
   * when the viewport changes — the same spelling `SignOutButton` uses for its
   * own label, and for the same reason.
   */
  it('names itself by the account it opens', () => {
    renderMenu();
    expect(trigger()).toHaveAccessibleName('Account: qa@perfportal.test');
  });

  /** A session that could not be read still has to offer a way out — that is
   *  the state a stranded user is most likely to be in. */
  it('still opens when the session carried no identity', async () => {
    const user = userEvent.setup();
    renderMenu(null);
    await user.click(trigger());
    expect(await screen.findByRole('menuitem', { name: /sign out/i })).toBeInTheDocument();
  });
});

describe('AccountMenu — open', () => {
  it('holds the identity in full, the theme radios and Sign out', async () => {
    const user = userEvent.setup();
    renderMenu();
    await user.click(trigger());

    expect(trigger()).toHaveAttribute('aria-expanded', 'true');
    // In full and untruncated: an email clipped at 22 characters in the header
    // is the complaint this panel answers.
    expect(await screen.findByTestId('signed-in-as')).toHaveTextContent('qa@perfportal.test');
    expect(screen.getAllByRole('menuitemradio')).toHaveLength(3);
    expect(screen.getByRole('menuitem', { name: /sign out/i })).toBeInTheDocument();
  });

  /**
   * THE PROMISE THE FIRST CUT DECLINED TO MAKE. `menuitemradio` tells a screen
   * reader this is a choice among three, and the arrows have to actually move
   * — which is precisely what `ThemeToggle` once announced and did not do.
   */
  it('announces the theme as menu radios with exactly one checked', async () => {
    const user = userEvent.setup();
    renderMenu();
    await user.click(trigger());

    const radios = await screen.findAllByRole('menuitemradio');
    expect(radios.map((r) => r.getAttribute('aria-checked')).filter((v) => v === 'true')).toHaveLength(1);
    expect(radios.map((r) => r.textContent?.trim())).toEqual(['System', 'Light', 'Dark']);
  });

  it('moves between items with the arrow keys', async () => {
    const user = userEvent.setup();
    renderMenu();
    await user.click(trigger());
    await screen.findAllByRole('menuitemradio');

    await user.keyboard('{ArrowDown}');
    const first = document.activeElement;
    expect(first).not.toBeNull();
    await user.keyboard('{ArrowDown}');
    // A menu that announced arrow support and ignored it is the defect here;
    // asserting focus MOVED is what catches that, not that a key was handled.
    expect(document.activeElement).not.toBe(first);
  });

  it('picks a theme and writes it to the document', async () => {
    const user = userEvent.setup();
    renderMenu();
    await user.click(trigger());

    await user.click(await screen.findByRole('menuitemradio', { name: 'Dark' }));
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('closes on Escape and returns focus to the trigger', async () => {
    const user = userEvent.setup();
    renderMenu();
    await user.click(trigger());
    await screen.findByRole('menu');

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    await waitFor(() => expect(trigger()).toHaveFocus());
  });

  /** Sign out must not close the menu by selection — that would unmount the
   *  item mid-request and take any failure message with it. */
  it('runs sign out from the menu', async () => {
    const user = userEvent.setup();
    renderMenu();
    await user.click(trigger());

    const item = await screen.findByRole('menuitem', { name: /sign out/i });
    await user.click(item);
    await waitFor(() => expect(signOutCalls).toBeGreaterThan(0));
  });
});
