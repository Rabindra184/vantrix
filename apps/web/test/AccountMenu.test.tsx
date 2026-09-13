// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import AccountMenu from '../src/AccountMenu';

/**
 * ═══ REVIEW 09-13 N03 — THE TWO LEAST-USED CONTROLS HELD PERMANENT CHROME ═══
 *
 * The header carried a brand, a truncated email, three theme buttons and Sign
 * out at equal weight. Theme is set once and Sign out is pressed at the end of
 * a session; the identity — the question the chrome should actually answer —
 * was a 12px span that disappeared below `sm`.
 *
 * ═══ WHAT THESE CASES ARE REALLY GUARDING ═══
 *
 * Two things a "make it a dropdown" change gets wrong by default.
 *
 * The panel must be UNMOUNTED when shut, not hidden: three other assertions in
 * this suite count Sign out controls, and jsdom applies no CSS, so a
 * CSS-hidden panel is fully present there and reads as exactly the duplication
 * those tests exist to catch.
 *
 * And it must not claim `role="menu"`. A menu's children have to be menuitems,
 * which the theme control (a `radiogroup`) is not — and a menu role promises
 * arrow-key and typeahead behaviour this does not implement. `ThemeToggle`'s
 * own history is the argument: it shipped `role="radio"` with no arrow
 * handling and a screen reader duly announced "radio button, 1 of 3" for a
 * control that ignored the arrows its user then pressed.
 */

afterEach(cleanup);

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
    expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull();
    expect(screen.queryByRole('radiogroup', { name: 'Colour theme' })).toBeNull();
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
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
  });
});

describe('AccountMenu — open', () => {
  it('holds the identity in full, the theme control and Sign out', async () => {
    const user = userEvent.setup();
    renderMenu();
    await user.click(trigger());

    expect(trigger()).toHaveAttribute('aria-expanded', 'true');
    // In full and untruncated: an email clipped at 22 characters in the header
    // is the complaint this panel answers.
    expect(screen.getByTestId('signed-in-as')).toHaveTextContent('qa@perfportal.test');
    expect(screen.getByRole('radiogroup', { name: 'Colour theme' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
  });

  /**
   * IT IS A DISCLOSURE, AND SAYS SO. `aria-controls` has to resolve to the
   * element that actually appeared, or the relationship is decorative.
   */
  it('controls the panel it opened', async () => {
    const user = userEvent.setup();
    const { container } = renderMenu();
    await user.click(trigger());

    const id = trigger().getAttribute('aria-controls');
    expect(id).toBeTruthy();
    const panel = container.querySelector('#' + CSS.escape(id!));
    expect(panel).not.toBeNull();
    expect(panel).toContainElement(screen.getByRole('button', { name: 'Sign out' }));
  });

  /** AND IT DOES NOT CLAIM TO BE A MENU. Asserted as an absence because the
   *  obvious implementation reaches for `role="menu"`, which would be invalid
   *  around a radiogroup and would promise keyboard behaviour absent here. */
  it('does not announce itself as a menu', async () => {
    const user = userEvent.setup();
    renderMenu();
    await user.click(trigger());

    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.queryAllByRole('menuitem')).toHaveLength(0);
    expect(trigger()).not.toHaveAttribute('aria-haspopup', 'menu');
  });

  it('closes again on a second press', async () => {
    const user = userEvent.setup();
    renderMenu();
    await user.click(trigger());
    await user.click(trigger());
    expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull();
  });

  /**
   * ESCAPE IS THE ONE KEYBOARD AFFORDANCE A POPUP OWES ITS USER, and giving
   * the caret back is the half that is easy to miss: closing the panel while
   * focus is still inside it strands a keyboard user at the document root.
   */
  it('closes on Escape and returns focus to the trigger', async () => {
    const user = userEvent.setup();
    renderMenu();
    await user.click(trigger());
    await user.keyboard('{Escape}');

    expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull();
    await waitFor(() => expect(trigger()).toHaveFocus());
  });

  it('closes when something outside it is pressed', async () => {
    const user = userEvent.setup();
    renderMenu();
    await user.click(trigger());
    await user.click(document.body);
    expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull();
  });

  /** A press INSIDE the panel must not close it — the theme control lives
   *  there, and a menu that shut on its own contents would be unusable. */
  it('stays open when the theme control inside it is used', async () => {
    const user = userEvent.setup();
    renderMenu();
    await user.click(trigger());

    await user.click(screen.getByRole('radio', { name: 'Dark theme' }));
    expect(screen.getByRole('radiogroup', { name: 'Colour theme' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Dark theme' })).toHaveAttribute('aria-checked', 'true');
  });
});
