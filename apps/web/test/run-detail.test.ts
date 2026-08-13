import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { Processing } from '../src/routes/RunDetail.js';

/**
 * The polling cap's UI, rendered directly to static markup.
 *
 * This file runs in Vitest's **node** environment — no `document`, no mount —
 * and asserts only that the cap UI exists and is genuinely conditional on
 * `capReached`. That is cheap and it is the whole of what a `renderToStaticMarkup`
 * test can honestly claim: server rendering never runs effects, so `RunDetail`'s
 * `useEffect`/`setTimeout` could not fire here at any clock setting.
 *
 * WHAT USED TO BE MISSING, and no longer is. For two sub-projects this file
 * carried a notice that `RunDetail`'s cap WIRING — the `useEffect` that flips
 * `capReached` from false to true — had no test that could fail, because
 * reaching the cap through the real component meant either two real minutes of
 * wall clock or a DOM environment nobody had yet paid for. That environment now
 * exists (`environmentMatchGlobs` in vitest.config.ts routes
 * `apps/web/test/**\/*.test.tsx` to jsdom) and the gap is closed by
 * `apps/web/test/RunDetail.polling.test.tsx`, which mounts `RunDetail` and
 * advances fake timers past `POLL_CAP_MS`. Falsified by deleting the
 * `useEffect`: that file goes red and THIS one stays green, which is precisely
 * the division of labour the two are meant to have.
 *
 * The `refetchInterval` CALL SITE is covered elsewhere again, by
 * `apps/web/e2e/run-detail.spec.ts`'s "a pending run is asked about again",
 * which counts requests actually leaving a real browser against a run no worker
 * will ever settle.
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
