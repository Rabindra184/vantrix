import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import AppShell from '../src/AppShell';

afterEach(cleanup);

/**
 * A sentinel child route rather than the real run list. The property under
 * test is that the rail's failure does not reach `<main>`; a sentinel proves
 * it with ONE request in flight instead of two, so a red test names its own
 * cause instead of implicating the run list's own fetching.
 */
function renderShell(session: unknown = {}) {
  vi.stubGlobal('fetch', (input: RequestInfo) =>
    Promise.resolve(
      String(input).includes('/v1/projects')
        ? new Response(
            JSON.stringify({ code: 'INTERNAL', detail: 'boom', remediation: 'Retry later.' }),
            { status: 500, headers: { 'Content-Type': 'application/problem+json' } },
          )
        : String(input).includes('/auth/get-session')
          ? new Response(JSON.stringify(session), { status: 200, headers: { 'Content-Type': 'application/json' } })
          : new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
    ),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/runs']}>
        <Routes>
          <Route element={<AppShell />}>
            <Route path="/runs" element={<p>page content stand-in</p>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('AppShell', () => {
  it('renders the page even when the rail cannot load its projects', async () => {
    renderShell();
    expect(await screen.findByText('Projects could not be loaded.')).toBeInTheDocument();
    // The point of the test: main is unaffected by the rail's failure.
    // Scoped to <main> itself, not just present anywhere in the document —
    // recorded here as a deferred item whose justification was false: nothing
    // on this branch previously asserted DOM order, so a sentinel rendered
    // inside the rail (a real regression) would have passed this assertion
    // just as easily as one rendered where it belongs.
    expect(within(screen.getByRole('main')).getByText('page content stand-in')).toBeInTheDocument();
  });

  it('renders the rail and exactly one Sign out control', async () => {
    const user = userEvent.setup();
    renderShell();
    expect(await screen.findByRole('navigation', { name: 'Projects' })).toBeInTheDocument();

    /* Sign out moved into the account menu (review 09-13 N03), and that panel
       is UNMOUNTED while shut — so the closed shell carries none, which is
       itself worth asserting: a panel hidden with a class would be fully
       present here, because jsdom applies no CSS. */
    expect(screen.queryAllByRole('menuitem', { name: /sign out/i })).toHaveLength(0);

    await user.click(screen.getByTestId('account-menu-trigger'));
    // Count, not visibility — still the cheapest place to catch the
    // duplication that would break auth.spec.ts under strict mode.
    expect(await screen.findAllByRole('menuitem', { name: /sign out/i })).toHaveLength(1);
  });

  /**
   * ONE trigger, in the header, between the brand and the account menu. The
   * count is the cheap guard against a second mount (a page that renders its
   * own) which would give the document two controls named Search and every
   * `getByRole` over it a strict-mode violation; the order is where the
   * header's own comment says it sits.
   */
  it('renders exactly one Search control in the header', async () => {
    renderShell();
    expect(await screen.findByRole('navigation', { name: 'Projects' })).toBeInTheDocument();

    const header = screen.getByRole('banner');
    const inHeader = within(header).getAllByRole('button', { name: 'Search' });
    expect(inHeader).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Search' })).toHaveLength(1);

    const brand = within(header).getByRole('link', { name: /PerfPortal/ });
    const account = screen.getByTestId('account-menu-trigger');
    expect(brand.compareDocumentPosition(inHeader[0]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(inHeader[0]!.compareDocumentPosition(account) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  /**
   * The brand is the way back to the front door — the home page now, the run
   * list until there was one — and it is named after the PRODUCT. "Home" is the
   * rail's row on every authenticated page; a brand link named that would be a
   * second link with one name in the document, which is the collision
   * CLAUDE.md records twice.
   */
  it('takes the brand back to the home page, under the product’s name and not the rail’s word', async () => {
    renderShell();
    expect(await screen.findByRole('navigation', { name: 'Projects' })).toBeInTheDocument();
    const header = screen.getByRole('banner');
    expect(within(header).getByRole('link', { name: 'PerfPortal' })).toHaveAttribute('href', '/');
    expect(within(header).queryByRole('link', { name: 'Home' })).toBeNull();
  });
});

/**
 * ═══ THE MENU'S ADMIN FLAG COMES FROM THE SESSION, AND ONLY `'admin'` IS ONE ═══
 *
 * `AccountMenu.test.tsx` hands the menu its `isAdmin`, so it proves the menu
 * reads the prop and nothing about where the prop comes from. These read it
 * off the session the shell is given — Better Auth's admin plugin's
 * `user.role` — including a session with no role at all, which an API older
 * than the plugin sends.
 */
describe('AppShell — the account menu’s Administration item', () => {
  const sessionOf = (user: Record<string, unknown>) => ({
    session: { id: 's1' },
    user: { id: 'u1', name: 'Ada', email: 'ada@perfportal.test', ...user },
  });

  async function openMenu(session: unknown) {
    const user = userEvent.setup();
    renderShell(session);
    // The menu's name carries the identity once the session has been read.
    await screen.findByRole('button', { name: 'Account: Ada' });
    await user.click(screen.getByTestId('account-menu-trigger'));
    await screen.findByRole('menuitem', { name: 'Change password' });
  }

  it('offers Administration to an admin', async () => {
    await openMenu(sessionOf({ role: 'admin' }));
    expect(screen.getByRole('menuitem', { name: 'Administration' })).toHaveAttribute('href', '/admin/users');
  });

  it.each([
    ['an ordinary account', sessionOf({ role: 'user' })],
    ['a session with no role', sessionOf({})],
  ])('offers no Administration to %s', async (_who, session) => {
    await openMenu(session);
    expect(screen.queryByRole('menuitem', { name: 'Administration' })).toBeNull();
  });
});

/**
 * ═══ ONE READ OF THE FLAG, HANDED TO THE RAIL AND THE PALETTE ═══
 *
 * The shell reads the admin flag once (`useIsAdmin`, the web's one definition
 * of it) and hands it to the rail and to the search palette. Their own tests
 * HAND THEMSELVES the flag, so they prove each reads the prop and nothing
 * about where the prop comes from; these read it off the session the shell is
 * given, on an org whose project list answers empty — where the rail's
 * sentence and the palette's New project both turn on it.
 */
describe('AppShell — the admin flag reaches the rail and the palette', () => {
  const hadScrollIntoView = 'scrollIntoView' in Element.prototype;
  beforeEach(() => {
    // cmdk scrolls its highlighted row into view and measures its list:
    // jsdom has neither, and either one missing throws inside an effect.
    if (!hadScrollIntoView) Element.prototype.scrollIntoView = () => {};
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      },
    );
  });
  afterEach(() => {
    if (!hadScrollIntoView) delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    vi.unstubAllGlobals();
  });

  function renderOnEmptyOrg(role: 'admin' | 'user') {
    vi.stubGlobal('fetch', (input: RequestInfo) => {
      const url = String(input);
      const body = url.includes('/v1/projects')
        ? { items: [] }
        : url.includes('/auth/get-session')
          ? { session: { id: 's1' }, user: { id: 'u1', name: 'Ada', email: 'ada@perfportal.test', role } }
          : {};
      return Promise.resolve(
        new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }),
      );
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/runs']}>
          <Routes>
            <Route element={<AppShell />}>
              <Route path="/runs" element={<p>page content stand-in</p>} />
            </Route>
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  async function goToOptions(): Promise<string[]> {
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Search' }));
    const goTo = await screen.findByRole('group', { name: 'Go to' });
    return within(goTo)
      .getAllByRole('option')
      .map((option) => option.textContent ?? '');
  }

  it('tells an admin the org has no projects, and offers them New project', async () => {
    renderOnEmptyOrg('admin');
    expect(await screen.findByText('No projects yet.')).toBeInTheDocument();
    expect(await goToOptions()).toEqual(['Home', 'All runs', 'New project']);
  });

  it('tells a person on no project to ask an admin, and offers them no New project', async () => {
    renderOnEmptyOrg('user');
    expect(
      await screen.findByText("You're not on any project yet. Ask an admin to add you."),
    ).toBeInTheDocument();
    expect(await goToOptions()).toEqual(['Home', 'All runs']);
  });
});

/* ======================================================================== *
 * REVIEW 09-13 C04 — A FRAGMENT LINK THAT ONLY CHANGED THE URL
 * ======================================================================== */

/**
 * ═══ WHY THE BROWSER DOES NOT DO THIS FOR US ═══
 *
 * The decision band's "See the failed simulation check" is a `<Link>` to the
 * path the reader is ALREADY on, plus `#simulation-assertions`. React Router
 * answers a same-path navigation with `pushState`, and a browser scrolls to a
 * fragment only on a real hash navigation or a document load. So the address
 * bar gained the fragment and nothing moved: measured in Chromium at scrollY
 * 82 with the target 1482px below the viewport, and again here at scrollY 0
 * with it 1463px below.
 *
 * After the fix, the same click leaves scrollY 1255 with the section 208px
 * into the viewport, fully visible and clear of the 98px of sticky chrome —
 * 208 rather than 98 only because the page is at its maximum scroll and
 * cannot go further, which is the correct place to stop.
 *
 * jsdom implements neither `scrollIntoView` nor layout, so what these cases
 * pin is that the right ELEMENT is asked and that focus follows it. The
 * geometry above is a browser measurement and belongs in the note, not in an
 * assertion this environment cannot make.
 */
describe('AppShell — a fragment reveals its target', () => {
  function renderWithHash(entry: string) {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[entry]}>
          <Routes>
            <Route element={<AppShell />}>
              <Route
                path="/runs/:runId"
                element={
                  <section id="simulation-assertions">
                    <h2>Simulation assertions</h2>
                  </section>
                }
              />
            </Route>
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  it('scrolls the named section into view and moves focus to it', async () => {
    // jsdom has no `scrollIntoView`; the spy is both the stub and the witness.
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;

    renderWithHash('/runs/abc#simulation-assertions');

    const target = await screen.findByRole('heading', { name: 'Simulation assertions' });
    const section = target.closest('section')!;
    await vi.waitFor(() => expect(scrollIntoView).toHaveBeenCalled());

    // The element asked to scroll is the one the fragment named — not the
    // page, and not whatever happened to be first.
    expect(scrollIntoView.mock.instances[0]).toBe(section);
    // AND FOCUS FOLLOWS IT. Scrolling without refocusing leaves a keyboard or
    // screen-reader user reading the link they just followed — the same
    // argument the skip link makes two components up.
    expect(document.activeElement).toBe(section);
    expect(section).toHaveAttribute('tabindex', '-1');
  });

  /** A fragment naming nothing must stop quietly rather than spin: the retry
   *  exists for a lazy child that has not rendered, not for a typo. */
  it('gives up on a fragment that names no element', async () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;

    renderWithHash('/runs/abc#no-such-section');
    await screen.findByRole('heading', { name: 'Simulation assertions' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  /** And a plain navigation still starts at the top — the behaviour this
   *  effect sits beside and must not have replaced. */
  it('leaves the scroll-to-top path alone when there is no fragment', async () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;

    renderWithHash('/runs/abc');
    await screen.findByRole('heading', { name: 'Simulation assertions' });
    expect(scrollIntoView).not.toHaveBeenCalled();
  });
});

/**
 * ═══ A FRAGMENT GOING AWAY IS NOT A NEW PAGE ═══
 *
 * `useSearchParams`' setter navigates to `"?" + params`, which drops the hash.
 * A reader who landed on `/runs/:id#errors` — the old `/errors` redirect, or
 * the band's `#simulation-assertions` link — and then changed a filter made a
 * same-path navigation with an empty hash, and the scroll-to-top effect read
 * that as a new page: measured in Chromium, ~1,500px up and away from the
 * table they were filtering. The path alone decides.
 *
 * What these cases pin is the call, since jsdom has no layout: `scrollTo` is
 * the witness, and the browser case in `run-summary-report.spec.ts` is the one
 * that measures where the table ends up.
 */
describe('AppShell — scroll restoration is keyed on the path', () => {
  let scrollTo: ReturnType<typeof vi.fn>;

  function renderAt(entry: string) {
    scrollTo = vi.fn();
    vi.spyOn(window, 'scrollTo').mockImplementation(scrollTo as never);
    Element.prototype.scrollIntoView = vi.fn();
    vi.stubGlobal('fetch', () =>
      Promise.resolve(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[entry]}>
          <Routes>
            <Route element={<AppShell />}>
              <Route
                path="/runs/:runId"
                element={
                  <section id="errors">
                    <h2>Errors</h2>
                    {/* What a `useSearchParams` setter does: the same path, a
                        new query, and no hash. */}
                    <Link to={{ search: '?request=Search' }}>narrow the table</Link>
                    <Link to="/runs/other">open another run</Link>
                    <Link to={{ pathname: '/runs/abc', hash: '#errors' }}>jump to errors</Link>
                  </section>
                }
              />
            </Route>
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not scroll when a same-path navigation only drops the fragment', async () => {
    renderAt('/runs/abc#errors');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('link', { name: 'narrow the table' }));
    // Wait on something the navigation changed — the focus the fragment effect
    // took is gone from nothing, so give the router a turn and read the call.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(scrollTo).not.toHaveBeenCalled();
  });

  /** The behaviour this sits beside and must not have replaced: a different
   *  path with no fragment is a new thing and starts at its own top. */
  it('still scrolls to the top for a different path', async () => {
    renderAt('/runs/abc#errors');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('link', { name: 'open another run' }));
    await vi.waitFor(() => expect(scrollTo).toHaveBeenCalledWith({ top: 0 }));
    expect(scrollTo).toHaveBeenCalledTimes(1);
  });

  /** A fragment on the SAME path is the fragment effect's move, and the top is
   *  not visited first. */
  it('does not scroll to the top for a same-path fragment link', async () => {
    renderAt('/runs/abc');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('link', { name: 'jump to errors' }));
    await vi.waitFor(() =>
      expect(Element.prototype.scrollIntoView as ReturnType<typeof vi.fn>).toHaveBeenCalled(),
    );
    expect(scrollTo).not.toHaveBeenCalled();
  });

  /** A deep link lands where the browser puts it. */
  it('does not scroll on the first render', async () => {
    renderAt('/runs/abc');
    await screen.findByRole('heading', { name: 'Errors' });
    expect(scrollTo).not.toHaveBeenCalled();
  });
});

/**
 * ═══ A REVEAL KEEPS THE TARGET WHERE IT PUT IT, UNTIL THE READER TAKES OVER ═══
 *
 * The one-shot reveal is right only on a page already laid out, and the run
 * Summary is not: its tiles and charts arrive after `#errors` exists and push
 * it back below the fold (measured numbers in `AppShell.tsx`, which `keepInPlace`
 * is documented in; the browser case in `run-summary-report.spec.ts` is the one
 * that measures where the table ends up).
 *
 * jsdom has no layout and no `ResizeObserver`, so what these cases pin is the
 * CONTRACT with the observer: the stub records what the page observes, the test
 * fires it by hand, and the target's `getBoundingClientRect().top` is the
 * variable a real layout shift would move. The call is the witness —
 * `scrollIntoView`, because that is the same call the reveal makes and so
 * `scroll-margin-top` still applies.
 *
 * WITHOUT A `ResizeObserver` the one-shot reveal is exactly as it was: every
 * case in the describe above runs in that state, which is the guard.
 */
describe('AppShell — a revealed fragment holds its place while the page settles', () => {
  /** Every observer the shell created, in order, so a case can fire or inspect it. */
  class FakeResizeObserver {
    static instances: FakeResizeObserver[] = [];
    private connected = true;
    readonly observe = vi.fn();
    readonly unobserve = vi.fn();
    /* A disconnected observer delivers nothing, as the real one does — so a
       `fire()` after the shell has stopped is a no-op unless the shell forgot
       to disconnect, which is exactly what the stop cases are asking. */
    readonly disconnect = vi.fn(() => {
      this.connected = false;
    });
    constructor(private readonly callback: () => void) {
      FakeResizeObserver.instances.push(this);
    }
    /** A layout change, as the browser would deliver it. */
    fire(): void {
      if (this.connected) this.callback();
    }
  }

  let scrollIntoView: Mock<(options?: ScrollIntoViewOptions) => void>;
  /** Where the target sits in the viewport — the thing a shift above it moves. */
  let top: number;
  /** Where a `scrollIntoView` leaves it: the page bottom clamps the scroll, so
   *  a correction lands short of the margin. */
  let landsAt: number;

  beforeEach(() => {
    FakeResizeObserver.instances = [];
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    top = 0;
    landsAt = 441; // where the REVEAL leaves the target: the page is still short
    scrollIntoView = vi.fn(() => {
      top = landsAt;
    });
    Element.prototype.scrollIntoView = scrollIntoView;
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(
      () => ({ top, bottom: top + 290, left: 0, right: 0, width: 0, height: 290, x: 0, y: top }) as DOMRect,
    );
    vi.stubGlobal('fetch', () =>
      Promise.resolve(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function renderRevealed() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/runs/abc#errors']}>
          <Routes>
            <Route element={<AppShell />}>
              <Route
                path="/runs/:runId"
                element={
                  <section id="errors">
                    <h2>Errors</h2>
                  </section>
                }
              />
            </Route>
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    return view;
  }

  /** The reveal has run and the shell is watching the layout. */
  async function revealed() {
    const view = renderRevealed();
    await vi.waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1));
    expect(FakeResizeObserver.instances).toHaveLength(1);
    expect(top).toBe(441);
    return view;
  }

  it('scrolls the target again when content above it pushes it away', async () => {
    await revealed();

    top = 784; // the tiles and charts arrived: the same section, 343px lower
    FakeResizeObserver.instances[0]!.fire();

    expect(scrollIntoView).toHaveBeenCalledTimes(2);
    expect(scrollIntoView.mock.instances[1]).toBe(screen.getByRole('heading', { name: 'Errors' }).closest('section'));
    expect(scrollIntoView).toHaveBeenLastCalledWith({ block: 'start' });
  });

  /** SCROLL ONLY. Focus moved once, at the reveal, and a correction taking it
   *  again would pull a keyboard user back from whatever they had moved to. */
  it('does not move focus again when it corrects', async () => {
    const focus = vi.spyOn(HTMLElement.prototype, 'focus');
    await revealed();
    expect(focus).toHaveBeenCalledTimes(1);

    top = 784;
    FakeResizeObserver.instances[0]!.fire();

    expect(scrollIntoView).toHaveBeenCalledTimes(2);
    expect(focus).toHaveBeenCalledTimes(1);
  });

  /** Most growth is NOT above the target — a table below it changes a height
   *  and moves nothing — and scrolling on every such callback would be a
   *  jolt for no reason. The target's own position decides. */
  it('leaves the scroll alone when the layout changed but the target did not move', async () => {
    await revealed();

    FakeResizeObserver.instances[0]!.fire();
    top += 0.4; // sub-pixel noise is not a shift either
    FakeResizeObserver.instances[0]!.fire();

    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  /** A correction lands the target somewhere new (clamped by the page bottom,
   *  it is not at the margin), and the NEXT shift is measured from there — not
   *  from the reveal's position, which would re-scroll on every callback after
   *  the first. */
  it('measures the next shift from where the last correction left it', async () => {
    await revealed();

    landsAt = 407; // the page has grown: its bottom now clamps the scroll lower
    top = 784;
    FakeResizeObserver.instances[0]!.fire();
    expect(scrollIntoView).toHaveBeenCalledTimes(2);
    expect(top).toBe(407); // the corrected scroll landed short of the margin

    // A stray callback with nothing moved must not scroll again: measured from
    // the reveal's 441, 407 would read as a shift and every callback after the
    // first would re-scroll.
    FakeResizeObserver.instances[0]!.fire();
    expect(scrollIntoView).toHaveBeenCalledTimes(2);

    // And a REAL shift from there is still followed.
    top = 600;
    FakeResizeObserver.instances[0]!.fire();
    expect(scrollIntoView).toHaveBeenCalledTimes(3);
  });

  /** Observes what it should: the root element and `<main>` — the two boxes a
   *  page settling above the target can grow. */
  it('observes the document and the main column', async () => {
    await revealed();
    const observed = FakeResizeObserver.instances[0]!.observe.mock.calls.map(([el]) => el);
    expect(observed).toContain(document.documentElement);
    expect(observed).toContain(document.getElementById('main'));
  });

  /** THE READER WINS. Taking the page away from someone who has started to
   *  scroll is worse than the defect, and all four are how a reader says so. */
  it.each(['wheel', 'touchstart', 'keydown', 'pointerdown'])(
    'stops for good at the first %s',
    async (type) => {
      await revealed();

      document.dispatchEvent(new Event(type, { bubbles: true }));
      expect(FakeResizeObserver.instances[0]!.disconnect).toHaveBeenCalled();

      // Even if the observer were delivered a late callback, the page is theirs.
      top = 784;
      FakeResizeObserver.instances[0]!.fire();
      expect(scrollIntoView).toHaveBeenCalledTimes(1);
    },
  );

  /** A fragment the reader navigated away from is not ours to hold. */
  it('tears the observer and the input listeners down on unmount', async () => {
    const added = vi.spyOn(document, 'addEventListener');
    const removed = vi.spyOn(document, 'removeEventListener');
    const view = await revealed();

    view.unmount();

    expect(FakeResizeObserver.instances[0]!.disconnect).toHaveBeenCalled();
    for (const type of ['wheel', 'touchstart', 'keydown', 'pointerdown']) {
      const [, listener, options] = added.mock.calls.find(([t]) => t === type) ?? [];
      expect(listener, `a ${type} listener was added`).toBeDefined();
      // The SAME listener and the SAME `capture`: that flag is part of a
      // listener's identity, and a removal that omits it removes nothing.
      expect(options, `${type} is added in the capture phase`).toMatchObject({ capture: true });
      expect(removed, `${type} listener removed`).toHaveBeenCalledWith(type, listener, expect.objectContaining({ capture: true }));
    }
    // And nothing the shell left behind can pull a page it no longer owns.
    top = 784;
    FakeResizeObserver.instances[0]!.fire();
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  /** A page that goes still is done settling: holding it for ever would fight
   *  a reader who has simply not scrolled yet. */
  it('stops once the layout has been still, and never outlives its cap', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      renderRevealed();
      await vi.waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1));
      const observer = FakeResizeObserver.instances[0]!;
      expect(observer.disconnect).not.toHaveBeenCalled();

      // A callback restarts the idle window, so a page still settling is held.
      vi.advanceTimersByTime(900);
      observer.fire();
      vi.advanceTimersByTime(900);
      expect(observer.disconnect).not.toHaveBeenCalled();

      vi.advanceTimersByTime(200); // 1.1s since the last change
      expect(observer.disconnect).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives up at the hard cap even while the layout keeps changing', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      renderRevealed();
      await vi.waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1));
      const observer = FakeResizeObserver.instances[0]!;

      // A live page: a change every 500ms for ever, so the idle window never expires.
      for (let elapsed = 0; elapsed < 4_500; elapsed += 500) {
        vi.advanceTimersByTime(500);
        observer.fire();
      }
      expect(observer.disconnect).not.toHaveBeenCalled();

      vi.advanceTimersByTime(600); // past 5s from the reveal
      expect(observer.disconnect).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  /** THE SILENCE WAS A BLOCKED THREAD, NOT A STILL PAGE. A task that moves the
   *  layout and outlasts the idle window leaves the idle timer overdue, and
   *  WebKit runs it before the rendering step that would have delivered the
   *  observer's callback — measured on CI, where `#errors` was left at a
   *  viewport ratio of 0.29. Here the target moves and the observer is never
   *  told: only a timer that measures before it decides can see it. */
  it('corrects a shift the observer never reported, and waits again rather than stop', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      renderRevealed();
      await vi.waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1));
      const observer = FakeResizeObserver.instances[0]!;

      top = 784; // the blocked task's layout, with no callback delivered
      vi.advanceTimersByTime(1_000);
      expect(scrollIntoView).toHaveBeenCalledTimes(2);
      expect(top).toBe(441);
      // A drift at the idle window's end means the page was still moving.
      expect(observer.disconnect).not.toHaveBeenCalled();

      // And a window that ends with nothing moved does stop.
      vi.advanceTimersByTime(1_000);
      expect(observer.disconnect).toHaveBeenCalled();
      expect(scrollIntoView).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  /** The cap is final, but it decides on the same fresh measurement: a page
   *  that moved under a blocked thread in its last second is corrected once,
   *  and then left alone. */
  it('makes one last correction at the cap before it stops', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      renderRevealed();
      await vi.waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1));
      const observer = FakeResizeObserver.instances[0]!;

      for (let elapsed = 0; elapsed < 4_500; elapsed += 500) {
        vi.advanceTimersByTime(500);
        observer.fire();
      }
      top = 784; // unreported, in the cap's last half-second

      vi.advanceTimersByTime(600); // past 5s from the reveal
      expect(scrollIntoView).toHaveBeenCalledTimes(2);
      expect(observer.disconnect).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  /** WHERE THE PAGE BOTTOM CLAMPED THE SCROLL, growth below is not "nothing
   *  moved". `#errors` is the last thing on the Summary, so the reveal stops at
   *  the page bottom with the target short of its rest; when its rows then
   *  arrive the section grows DOWNWARD — its top never moves, its bottom slides
   *  past the fold (measured on Firefox at a ratio of 0.96). The page now has
   *  room to go further, and the keeper takes it. Paired with the unclamped
   *  case below, because "scroll whenever the page grows" passes this one. */
  describe('a target the page bottom clamped short of its rest', () => {
    /** How far the page could still scroll down: `scrollHeight` is the
     *  viewport plus this, with `scrollY` at 0. */
    let room: number;
    const restore: Array<() => void> = [];

    beforeEach(() => {
      room = 0;
      const root = document.documentElement;
      Object.defineProperty(root, 'scrollHeight', { configurable: true, get: () => window.innerHeight + room });
      restore.push(() => delete (root as { scrollHeight?: number }).scrollHeight);
      // A scroll to the target consumes the room below it, as reaching the page
      // bottom does.
      scrollIntoView.mockImplementation(() => {
        top = landsAt;
        room = 0;
      });
    });

    afterEach(() => {
      for (const undo of restore.splice(0)) undo();
    });

    it('follows a section that grows downward under a clamped scroll', async () => {
      await revealed(); // room 0: the reveal stopped at the page bottom

      room = 300; // its rows arrived: taller page, the target's top unmoved
      FakeResizeObserver.instances[0]!.fire();
      expect(scrollIntoView).toHaveBeenCalledTimes(2);

      // At the bottom again, a callback with nothing new does not scroll.
      FakeResizeObserver.instances[0]!.fire();
      expect(scrollIntoView).toHaveBeenCalledTimes(2);
    });

    it('leaves an unclamped target alone when the page grows below it', async () => {
      room = 500; // the reveal reached its rest with page to spare
      scrollIntoView.mockImplementation(() => {
        top = landsAt;
      });
      await revealed();

      room = 800; // a table under the target grew; the target did not move
      FakeResizeObserver.instances[0]!.fire();
      expect(scrollIntoView).toHaveBeenCalledTimes(1);
    });
  });
});
