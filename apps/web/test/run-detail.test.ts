import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { Processing } from '../src/routes/RunDetail.js';

/**
 * The polling cap's UI, rendered directly.
 *
 * WHY NOT A FULL COMPONENT TEST. The fix round asked for
 * `vi.useFakeTimers()` around a rendered `RunDetail`, advancing past
 * `POLL_CAP_MS` and asserting the cap copy appears. That cannot be done here
 * without adding a dependency, and the instruction was explicit that none may
 * be added:
 *
 *   - `apps/web/test/*` runs in Vitest's **node** environment. There is no
 *     `document`, so `react-dom/client`'s `createRoot` cannot mount anything.
 *   - `jsdom`, `happy-dom`, `@testing-library/react` and `react-test-renderer`
 *     are all absent from the lockfile — verified, not assumed.
 *   - `react-dom/server` IS present (react-dom 18.3.1 is already a pinned
 *     dependency of apps/web), and `renderToStaticMarkup` needs no DOM. But
 *     server rendering never runs effects, so `RunDetail`'s
 *     `useEffect`/`setTimeout` cannot fire under it at any clock setting —
 *     fake timers included.
 *
 * So this asserts the smallest honest thing available: that the cap UI EXISTS
 * and is genuinely conditional on `capReached`. What it does NOT cover is
 * stated plainly, because a reader deserves to know the shape of the hole
 * rather than to infer coverage from a green tick:
 *
 *   **`RunDetail`'s timer wiring — the `useEffect` that flips `capReached`
 *   from false to true, and the `refetchInterval` call site that consumes
 *   it — has no test that can fail.** Deleting that `useEffect`, or passing a
 *   literal `false` for `capReached`, leaves this file and every other suite
 *   green while the page polls a stuck run until the tab is closed.
 *
 * That is a real, known gap, not a solved one. Closing it needs a DOM
 * environment in `apps/web/test`, which needs a dependency.
 */
describe('Processing — the polling cap UI', () => {
  // Wrapped in a router because the component renders a "Back to all runs"
  // <Link>, which needs router context. `StaticRouter` rather than
  // `MemoryRouter`: both work without a DOM, but MemoryRouter calls
  // `useLayoutEffect`, which React warns about on every server render and
  // would put eight lines of stack trace into `pnpm test`'s output for a
  // passing test. StaticRouter is react-router's own answer for rendering
  // outside a browser. Already a pinned dependency (react-router-dom 7.18.2).
  function render(capReached: boolean): string {
    return renderToStaticMarkup(
      createElement(
        StaticRouter,
        { location: '/runs/abc' },
        createElement(Processing, { status: 'pending', capReached, onRetry: () => {} }),
      ),
    );
  }

  // True in both branches: the run is still processing, and the page says so
  // rather than showing a header full of zeros. Asserted in both so neither
  // branch can drop it.
  it('says the run is still processing whether or not the cap has been reached', () => {
    expect(render(false)).toContain('still processing');
    expect(render(true)).toContain('still processing');
  });

  /**
   * Before the cap: the page is checking on its own, and says so. Critically
   * it must NOT offer the manual control — a "Check again" button beside
   * "checks again every few seconds" is an instruction to do the thing the
   * page is already doing.
   */
  it('before the cap, promises to keep checking and offers no manual control', () => {
    const html = render(false);
    expect(html).toContain('checks again every few seconds');
    expect(html).not.toContain('Check again');
    expect(html).not.toContain('stopped checking automatically');
  });

  /**
   * After the cap: polling has stopped, and BOTH halves of that must be on
   * screen. A page that quietly stopped asking while still saying "checks
   * again every few seconds" would look like it was working and be making no
   * requests at all — which is worse than the runaway polling the cap exists
   * to prevent, because the reader would wait indefinitely on it.
   */
  it('after the cap, says it stopped and offers a manual retry', () => {
    const html = render(true);
    expect(html).toContain('stopped checking automatically');
    expect(html).toContain('Check again');
    // The promise from the other branch must be gone, not merely joined.
    expect(html).not.toContain('checks again every few seconds');
  });

  // The two branches must actually differ. Trivially true today, but it is
  // the statement that fails first if the conditional is ever flattened to
  // render one branch unconditionally.
  it('renders differently either side of the cap', () => {
    expect(render(true)).not.toBe(render(false));
  });
});
