import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AppShell from '../src/AppShell';

afterEach(cleanup);

/**
 * A sentinel child route rather than the real run list. The property under
 * test is that the rail's failure does not reach `<main>`; a sentinel proves
 * it with ONE request in flight instead of two, so a red test names its own
 * cause instead of implicating the run list's own fetching.
 */
function renderShell() {
  vi.stubGlobal('fetch', (input: RequestInfo) =>
    Promise.resolve(
      String(input).includes('/v1/projects')
        ? new Response(
            JSON.stringify({ code: 'INTERNAL', detail: 'boom', remediation: 'Retry later.' }),
            { status: 500, headers: { 'Content-Type': 'application/problem+json' } },
          )
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
