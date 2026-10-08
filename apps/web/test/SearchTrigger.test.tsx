import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import AccountMenu from '../src/AccountMenu';
import SearchTrigger from '../src/palette/SearchTrigger';
import { isApplePlatform, isPaletteShortcut } from '../src/palette/shortcut';
import useIsCompact from '../src/useIsCompact';

vi.mock('../src/useIsCompact.js', () => ({ default: vi.fn(() => false) }));
const useIsCompactMock = vi.mocked(useIsCompact);

/*
 * ═══ WHAT THESE CASES ARE FOR ═══
 *
 * The trigger owns one decision — when the palette is open — and the rest is
 * the palette's. So what is asserted here is the part only this file can get
 * wrong: which keystrokes open it, that opening it from the place a reader is
 * already typing costs them nothing, that the shortcut still works when a menu
 * has focus, and that what the control says about itself is true.
 *
 * jsdom lacks two things the mounted palette calls (see CommandPalette.test.tsx,
 * which stubs the same pair): `scrollIntoView` and `ResizeObserver`.
 */
const hadScrollIntoView = 'scrollIntoView' in Element.prototype;
beforeAll(() => {
  if (!hadScrollIntoView) Element.prototype.scrollIntoView = () => {};
});
afterAll(() => {
  if (!hadScrollIntoView) delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
});

class InertResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', InertResizeObserver);
  // The palette's project list is the one request an empty query makes.
  vi.stubGlobal('fetch', (input: RequestInfo | URL) => {
    const { pathname } = new URL(String(input), 'http://localhost');
    return Promise.resolve(
      new Response(JSON.stringify(pathname === '/v1/projects' ? { items: [] } : {}), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  });
  useIsCompactMock.mockReset();
  useIsCompactMock.mockReturnValue(false);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderTrigger() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        {/* Somewhere a reader is already typing — the run list's own box. */}
        <input aria-label="Search runs" defaultValue="" />
        <AccountMenu identity="qa@perfportal.test" isAdmin={false} />
        <SearchTrigger />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const trigger = () => screen.getByRole('button', { name: 'Search' });
const dialog = () => screen.queryByRole('dialog', { name: 'Search PerfPortal' });

describe('isPaletteShortcut — which keystrokes are ours', () => {
  const key = (init: KeyboardEventInit) => new KeyboardEvent('keydown', init);

  it('takes ⌘K and Ctrl+K, in either case', () => {
    expect(isPaletteShortcut(key({ key: 'k', metaKey: true }))).toBe(true);
    expect(isPaletteShortcut(key({ key: 'k', ctrlKey: true }))).toBe(true);
    // Caps Lock reports the capital.
    expect(isPaletteShortcut(key({ key: 'K', metaKey: true }))).toBe(true);
  });

  /** Each of these is somebody else's: Alt+K types a character on some
   *  layouts, and Shift+⌘K is a browser's. */
  it('leaves every neighbouring chord alone', () => {
    expect(isPaletteShortcut(key({ key: 'k' }))).toBe(false);
    expect(isPaletteShortcut(key({ key: 'k', metaKey: true, altKey: true }))).toBe(false);
    expect(isPaletteShortcut(key({ key: 'k', metaKey: true, shiftKey: true }))).toBe(false);
    expect(isPaletteShortcut(key({ key: 'j', metaKey: true }))).toBe(false);
  });
});

describe('isApplePlatform', () => {
  it('reads navigator.platform', () => {
    expect(isApplePlatform({ platform: 'MacIntel' } as Navigator)).toBe(true);
    expect(isApplePlatform({ platform: 'iPhone' } as Navigator)).toBe(true);
    expect(isApplePlatform({ platform: 'Win32' } as Navigator)).toBe(false);
    expect(isApplePlatform({ platform: 'Linux x86_64' } as Navigator)).toBe(false);
  });

  /** `navigator.platform` is deprecated and `userAgentData` is where a current
   *  browser says it; when both are present the newer one wins. */
  it('prefers userAgentData.platform when the browser offers it', () => {
    const mac = { userAgentData: { platform: 'macOS' }, platform: 'Win32' } as unknown as Navigator;
    const windows = { userAgentData: { platform: 'Windows' }, platform: 'MacIntel' } as unknown as Navigator;
    expect(isApplePlatform(mac)).toBe(true);
    expect(isApplePlatform(windows)).toBe(false);
  });

  it('is false when the browser says nothing at all', () => {
    expect(isApplePlatform({} as Navigator)).toBe(false);
  });
});

describe('SearchTrigger — opening', () => {
  it('opens on Meta+K and on Ctrl+K', async () => {
    const user = userEvent.setup();
    renderTrigger();
    expect(dialog()).toBeNull();

    await user.keyboard('{Meta>}k{/Meta}');
    expect(await screen.findByRole('dialog', { name: 'Search PerfPortal' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(dialog()).toBeNull());

    await user.keyboard('{Control>}k{/Control}');
    expect(await screen.findByRole('dialog', { name: 'Search PerfPortal' })).toBeInTheDocument();
  });

  it('ignores Alt+K and Shift+Meta+K', async () => {
    const user = userEvent.setup();
    renderTrigger();

    await user.keyboard('{Alt>}k{/Alt}');
    await user.keyboard('{Shift>}{Meta>}k{/Meta}{/Shift}');
    expect(dialog()).toBeNull();
  });

  it('opens from the button', async () => {
    const user = userEvent.setup();
    renderTrigger();
    await user.click(trigger());
    expect(await screen.findByRole('dialog', { name: 'Search PerfPortal' })).toBeInTheDocument();
  });

  /**
   * THE SHORTCUT HAS TO WORK FROM THE PLACE A READER IS ALREADY TYPING, which
   * is also the place a stray "k" would land. user-event types the character
   * unless the keydown was prevented (a held Meta does not stop it, a held
   * Ctrl does), so this fails if `preventDefault` is dropped.
   */
  it('opens from inside a text field without typing a k', async () => {
    const user = userEvent.setup();
    renderTrigger();
    const field = screen.getByRole('textbox', { name: 'Search runs' });
    await user.click(field);
    await user.keyboard('ab');
    expect(field).toHaveFocus();

    await user.keyboard('{Meta>}k{/Meta}');

    expect(await screen.findByRole('dialog', { name: 'Search PerfPortal' })).toBeInTheDocument();
    expect(field).toHaveValue('ab');
    /* Not only the field it came from: the dialog takes focus as it opens, and
       user-event types its keypress into whatever is focused THEN — so a "k"
       that a dropped `preventDefault` let through lands in the palette's own
       input, which is where this has to look for it. */
    expect(screen.getByRole('combobox')).toHaveValue('');
  });

  /** The palette's own input holds focus while it is open, so the second press
   *  is a keydown inside the dialog — and still has to reach this listener. */
  it('closes on a second Meta+K', async () => {
    const user = userEvent.setup();
    renderTrigger();

    await user.keyboard('{Meta>}k{/Meta}');
    expect(await screen.findByRole('dialog', { name: 'Search PerfPortal' })).toBeInTheDocument();

    await user.keyboard('{Meta>}k{/Meta}');
    await waitFor(() => expect(dialog()).toBeNull());
  });

  /**
   * FOCUS GOES BACK TO WHERE IT WAS. A palette opened from a text field and
   * closed with Escape that left focus on <body> would cost the reader their
   * place — Radix returns it only to its own `Dialog.Trigger`, and this
   * dialog has none, so the guarantee is the palette's own code, asserted
   * here through the component a reader actually opens it with.
   */
  it('returns focus to the element focused before it opened', async () => {
    const user = userEvent.setup();
    renderTrigger();
    const field = screen.getByRole('textbox', { name: 'Search runs' });
    await user.click(field);

    await user.keyboard('{Meta>}k{/Meta}');
    expect(await screen.findByRole('dialog', { name: 'Search PerfPortal' })).toBeInTheDocument();
    expect(field).not.toHaveFocus();

    await user.keyboard('{Escape}');
    await waitFor(() => expect(dialog()).toBeNull());
    expect(document.activeElement).toBe(field);
  });

  it('returns focus to the button when the button opened it', async () => {
    const user = userEvent.setup();
    renderTrigger();
    await user.click(trigger());
    expect(await screen.findByRole('dialog', { name: 'Search PerfPortal' })).toBeInTheDocument();

    await user.keyboard('{Escape}');
    await waitFor(() => expect(dialog()).toBeNull());
    expect(document.activeElement).toBe(trigger());
  });

  /**
   * WHEN WHAT HAD FOCUS IS GONE, THE SEARCH BUTTON GETS IT. Opened from the
   * account menu, the palette records a menu node — and the menu shuts as the
   * palette takes focus, so by Escape that node is no longer in the document.
   * Handing focus to it would drop a keyboard reader on <body>; the header's
   * Search button opens this palette and is on every page.
   */
  it('returns focus to the Search button when what had focus has gone', async () => {
    const user = userEvent.setup();
    renderTrigger();
    await user.click(screen.getByTestId('account-menu-trigger'));
    const menu = await screen.findByRole('menu');
    expect(menu).toContainElement(document.activeElement as HTMLElement);

    await user.keyboard('{Meta>}k{/Meta}');
    expect(await screen.findByRole('dialog', { name: 'Search PerfPortal' })).toBeInTheDocument();
    // The premise: the menu that held focus has closed and left the document.
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    expect(menu.isConnected).toBe(false);

    await user.keyboard('{Escape}');
    await waitFor(() => expect(dialog()).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger()));
  });

  /**
   * The listener is on `window` in the CAPTURE phase so that nothing between
   * the key and the window can eat it. A Radix menu handles its own keys on its
   * content; this is the case that says an open one does not get to decide
   * whether the shortcut works.
   */
  it('opens while the account menu is open', async () => {
    const user = userEvent.setup();
    renderTrigger();
    await user.click(screen.getByTestId('account-menu-trigger'));
    expect(await screen.findByRole('menu')).toBeInTheDocument();

    await user.keyboard('{Meta>}k{/Meta}');

    expect(await screen.findByRole('dialog', { name: 'Search PerfPortal' })).toBeInTheDocument();
  });

  /**
   * THE CASE ABOVE PASSES WITH A BUBBLE-PHASE LISTENER TOO — Radix's menu does
   * not take a modified key — so it cannot be what says the phase matters.
   * This one puts something between the key and the window that does: a
   * handler on an ancestor that stops the event, as a menu's own key handling
   * might. Only a capture listener, which runs before any of them, is still
   * told.
   */
  it('opens even when something between the key and the window stops it', async () => {
    const user = userEvent.setup();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <div onKeyDown={(event) => event.stopPropagation()}>
            <input aria-label="Swallows keys" />
          </div>
          <SearchTrigger />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await user.click(screen.getByRole('textbox', { name: 'Swallows keys' }));

    await user.keyboard('{Meta>}k{/Meta}');

    expect(await screen.findByRole('dialog', { name: 'Search PerfPortal' })).toBeInTheDocument();
  });

  /**
   * A held key repeats its keydown. Toggling on each one would flicker the
   * dialog shut a frame after it opened, so a repeat does nothing — but it is
   * still ours, and a browser must not act on it either.
   */
  it('does not flicker on a held key', async () => {
    renderTrigger();
    fireEvent.keyDown(document.body, { key: 'k', metaKey: true });
    expect(await screen.findByRole('dialog', { name: 'Search PerfPortal' })).toBeInTheDocument();

    // `fireEvent` answers false when the event's default was prevented.
    const acted = fireEvent.keyDown(document.activeElement ?? document.body, {
      key: 'k',
      metaKey: true,
      repeat: true,
    });
    expect(acted).toBe(false);
    expect(screen.getByRole('dialog', { name: 'Search PerfPortal' })).toBeInTheDocument();
  });

  /**
   * ASSERTED ON WHAT A LEAKED LISTENER STILL DOES, which is `preventDefault`.
   * Its `setOpen` would land on an unmounted component — a silent no-op — and
   * no dialog would appear either way, so "no dialog" passes with the cleanup
   * deleted. `fireEvent` answers false when the event's default was prevented,
   * so a listener left on `window` shows up as the key being taken from a page
   * that no longer has a palette.
   */
  it('stops listening when it unmounts', () => {
    const { unmount } = renderTrigger();
    // Paired positive: while mounted, the key IS taken.
    expect(fireEvent.keyDown(document.body, { key: 'k', metaKey: true })).toBe(false);
    unmount();

    expect(fireEvent.keyDown(document.body, { key: 'k', metaKey: true })).toBe(true);
    expect(dialog()).toBeNull();
  });

  /**
   * A FULL-SCREEN CHART IS A NATIVE MODAL `<dialog>` (`Chart.tsx` calls
   * `showModal()`), and HTML makes everything outside one inert and paints it
   * beneath. The palette is portalled to <body>, outside it — so opening it
   * there would show nothing and take no focus, while Radix's own modal side
   * effects (`aria-hidden` on the page, `pointer-events: none` on <body>) would
   * still engage and stop the chart's Close button responding. So the shortcut
   * does nothing while one is open, and does not take the key either: the
   * browser keeps ⌘K for the chart.
   *
   * jsdom reflects the `open` attribute without `showModal`, which is all the
   * guard reads.
   */
  it('does nothing, and leaves the key alone, while a native dialog is open', async () => {
    renderTrigger();
    const chart = document.createElement('dialog');
    chart.setAttribute('open', '');
    document.body.appendChild(chart);

    // `fireEvent` answers true when nothing prevented the default.
    expect(fireEvent.keyDown(document.body, { key: 'k', metaKey: true })).toBe(true);
    expect(dialog()).toBeNull();

    // Paired positive, so the case cannot pass against a trigger that never
    // opens anything: the same key opens it once the chart is closed again.
    chart.removeAttribute('open');
    expect(fireEvent.keyDown(document.body, { key: 'k', metaKey: true })).toBe(false);
    expect(await screen.findByRole('dialog', { name: 'Search PerfPortal' })).toBeInTheDocument();
    chart.remove();
  });
});

describe('SearchTrigger — what it says about itself', () => {
  it('is named Search, and says which keys open it', () => {
    renderTrigger();
    expect(trigger()).toHaveAttribute('aria-keyshortcuts', 'Meta+K Control+K');
    expect(trigger()).toHaveAttribute('type', 'button');
  });

  /** The hint is decoration for the eye: the name stays "Search" and the
   *  shortcut is carried by `aria-keyshortcuts`, not read out twice. */
  it('shows ⌘K on Apple platforms and Ctrl K elsewhere', () => {
    const platform = vi.spyOn(navigator, 'platform', 'get');

    platform.mockReturnValue('MacIntel');
    const mac = renderTrigger();
    expect(trigger().querySelector('kbd')).toHaveTextContent('⌘K');
    expect(trigger().querySelector('kbd')).toHaveAttribute('aria-hidden', 'true');
    mac.unmount();

    platform.mockReturnValue('Win32');
    renderTrigger();
    expect(trigger().querySelector('kbd')).toHaveTextContent('Ctrl K');
    expect(trigger()).toHaveAccessibleName('Search');

    platform.mockRestore();
  });

  it('shows the word Search beside the hint on a desktop', () => {
    renderTrigger();
    expect(trigger()).toHaveTextContent('Search');
  });

  it('is an icon button named Search below 768px', () => {
    useIsCompactMock.mockReturnValue(true);
    renderTrigger();

    expect(trigger()).toHaveAccessibleName('Search');
    expect(trigger().textContent).toBe('');
    expect(trigger().querySelector('kbd')).toBeNull();
    expect(trigger().querySelector('svg')).not.toBeNull();
    // The shortcut is still what a keyboard attached to a tablet would press.
    expect(trigger()).toHaveAttribute('aria-keyshortcuts', 'Meta+K Control+K');
  });
});
