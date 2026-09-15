import { expect, type Locator, type Page } from '@playwright/test';

/**
 * The SVG root ECharts drew, within some scope — a figure, the compare
 * overlay, the time-window strip.
 *
 * ═══ WHY THIS IS NOT `scope.locator('svg')` ═══
 *
 * It was, in twenty-two places, and that spelling quietly made a design rule
 * out of a test convenience: a chart `<figure>` could contain no other SVG,
 * ever, because `toHaveCount(1)` counted every one of them. CLAUDE.md carried
 * the rule as a flat prohibition on icons inside a chart card, which is a
 * strange thing for a design system to be told by its test suite.
 *
 * `[data-chart-canvas]` is the element `Chart` renders the instance into, so
 * this asks the question the assertions always meant — "did the plot draw?" —
 * and is strictly harder to satisfy than the old form, which an icon anywhere
 * in the card could have answered.
 *
 * Use it for anything reaching into what ECharts produced: counting the root,
 * hovering a point, reading axis labels, `evaluate`-ing the SVG element.
 */
export function plot(scope: Locator): Locator {
  return scope.locator('[data-chart-canvas] svg');
}

/**
 * ═══ GETTING TO /login, AND WHY IT HAS ITS OWN RETRY ═══
 *
 * EVERY cross-browser flake this suite has produced landed here. Measured
 * across six `e2e-cross-browser` runs, 8 of 8 retried tests failed inside
 * `signIn` — seven in this navigation, one in the `waitForURL` below — and
 * not one failed an assertion. The test NAME was simply whoever was running:
 * eight occurrences, eight different specs, across `auth`, `run-charts`,
 * `run-detail`, `run-tables` and `run-telemetry`.
 *
 * THE MISATTRIBUTION IS THE DEFECT THIS FIXES. A stall here is reported as
 * "[firefox] run-telemetry.spec.ts flaky", which sends the next reader into a
 * telemetry chart that was never involved — it cost exactly that here, before
 * anyone read the logs. Retrying the navigation in the ONE place it happens
 * means a single stall costs seconds and names itself, instead of a minute
 * charged to an innocent spec.
 *
 * WHAT IS RETRIED IS NOT UNDER TEST. This is arriving at the login page:
 * setup that eighteen specs share and none of them is about. The form's own
 * behaviour is asserted below and in `Login.test.tsx`, and neither is touched.
 *
 * WHAT IT IS, MEASURED: THE PAGE FINISHES LOADING AND `load` NEVER FIRES.
 * Both stalls in the run that first carried `trackRequests`' counters said the
 * same thing, and it is the one answer nothing before could express:
 *
 *   EVERY REQUEST COMPLETED AND `load` NEVER ARRIVED.
 *   requests issued 5, settled 5, still outstanding 0;
 *   browser answered 9/9 probes, last 1982ms ago.
 *
 * Five requests issued, five settled, none outstanding — and the browser
 * answered a liveness probe every two seconds throughout. So nothing hung,
 * nothing was dropped, and the browser was never wedged. `page.goto` resolves
 * on `load`, so it sat for the full twenty seconds on a page that was, by
 * every network measure available, already finished.
 *
 * AND THE `waitForURL` BELOW FAILS THE SAME WAY, which says these were never
 * two bugs. A WebKit run of `run-charts.spec.ts` failed there with
 * `page.waitForURL: Timeout 20000ms exceeded` under Playwright's own log line
 * `waiting for navigation until "load"` — same wait, same twenty seconds, same
 * instant recovery on retry. The record used to separate "seven in this
 * navigation, one in the waitForURL below" as though the second were a
 * curiosity; one phenomenon, two call sites.
 *
 * THAT IS AN INFERENCE ON THAT SIDE AND A MEASUREMENT ON THIS ONE — the
 * counters wrap this `goto` and nothing wraps the `waitForURL`, so the
 * settled-and-no-load shape is proven for the first and argued for the second.
 * Wrapping the second is the next thing worth doing.
 *
 * WHAT IS STILL NOT KNOWN IS WHY `load` DOES NOT FIRE. Two experiments failed
 * to reproduce it: 180 navigations of this app's own `/login` in Firefox and
 * WebKit after deliberate idle gaps (0 failures, worst 374ms), and 75 against
 * a bare server at Node's default 5s `keepAliveTimeout`, probing the classic
 * HTTP/1.1 keep-alive race (0 failures, worst 51ms). Chromium has never
 * produced it — 137 tests in each of two runs, zero — and neither has WebKit
 * in THIS call, though WebKit produced the `waitForURL` variety above.
 */
/**
 * What the browser was doing, at the moment a navigation gave up.
 *
 * ═══ WHAT THE FIRST VERSION OF THIS MEASURED, AND WHY IT WAS HALF AN ANSWER ═══
 *
 * `page.goto` resolves on `load`, which waits for the document AND every
 * subresource it references — for `/login` that is one JS bundle, one
 * stylesheet, and the faces that stylesheet pulls. So a timeout has several
 * quite different causes and the Playwright error names none of them. The
 * first version reported the requests still OUTSTANDING, which separates:
 *
 *   the DOCUMENT still in flight  → the connection never answered
 *   a SUBRESOURCE still in flight → that one file hung, and `load` waited
 *   NOTHING in flight             → ...one of two things, indistinguishable
 *
 * MEASURED, IT IS ALWAYS THAT THIRD ONE. Six stalls in one `e2e-cross-browser`
 * run, every one of them `(nothing)` — which rules out both hung-request
 * causes and lands on exactly the branch that outstanding-request tracking
 * cannot split. `inFlight() === []` is equally true of a request that was
 * NEVER ISSUED and of one that was issued, completed, and did not produce a
 * `load`. A count of requests STARTED is what tells those apart, and the
 * first version kept no such count: its map is keyed by URL and deletes on
 * completion, so a request that came and went leaves no trace in it.
 *
 * ═══ AND A COUNT ALONE STILL LEAVES TWO CAUSES IN ONE CELL ═══
 *
 * `issued === 0` means no request reached the network — but that is true both
 * when Firefox accepted the navigation and never acted on it, and when the
 * driver's connection to the browser was wedged, since a wedged transport
 * delivers no `request` events either. The two point at completely different
 * things (the navigation, or the harness), so the probe below asks the
 * BROWSER, on a path that has nothing to do with the stuck page.
 *
 * `context.cookies()` is that path, chosen because it is the cheapest call
 * here that provably round-trips: a cookie written by `document.cookie`
 * INSIDE the page comes back from it, which a driver-side cache could not
 * know about (measured, 15ms). So it answers iff the browser and the
 * transport are alive, and it touches no execution context — `evaluate()`
 * would, and a navigation destroys those. It is read-only, and at one probe
 * every two seconds against a navigation that healthily takes ~60ms, the
 * usual case fires ZERO probes and pays nothing.
 *
 * The four cells are then disjoint and each names a different suspect:
 *
 *   browser stopped answering     → the harness or the browser process
 *   a request still in flight     → the network or the server
 *   issued > 0, none outstanding  → everything arrived, `load` did not fire
 *   issued === 0, browser alive   → the navigation never left Firefox
 */
const STALL_PROBE_EVERY_MS = 2_000;

function trackRequests(page: Page): { report: () => string; stop: () => void } {
  const outstanding = new Map<string, number>();
  let issued = 0;
  let settled = 0;

  const begin = (r: { url: () => string }): void => {
    issued += 1;
    outstanding.set(r.url(), Date.now());
  };
  const end = (r: { url: () => string }): void => {
    settled += 1;
    outstanding.delete(r.url());
  };

  page.on('request', begin);
  page.on('requestfinished', end);
  page.on('requestfailed', end);

  let probes = 0;
  let answered = 0;
  let lastAnswer = Date.now();
  const probe = setInterval(() => {
    probes += 1;
    void page
      .context()
      .cookies()
      .then(
        () => {
          answered += 1;
          lastAnswer = Date.now();
        },
        () => {
          /* A refused probe is a datum, not a failure — and it must not become
             an unhandled rejection, which is why this handler exists at all.
             It stays uncounted, and `answered` falling behind `probes` is what
             the report reads. */
        },
      );
  }, STALL_PROBE_EVERY_MS);

  return {
    report: () => {
      const stuck = [...outstanding.entries()].map(
        ([url, at]) => `${url} (${String(Date.now() - at)}ms)`,
      );
      const since = Date.now() - lastAnswer;
      /* Two probe intervals of grace: one in flight when the stall was
         declared is normal and is not evidence of anything. `null` is "never
         probed", and it is REACHABLE — the caller catches every navigation
         failure, not only timeouts, and a fast one returns long before the
         first probe fires (measured at 16ms, red-verifying the 204 below). A
         liveness verdict from zero samples would be a guess, so it is spelled
         as one rather than defaulting to alive. */
      const alive = probes === 0 ? null : since < STALL_PROBE_EVERY_MS * 2;

      const verdict =
        alive === false
          ? 'THE BROWSER STOPPED ANSWERING — suspect the harness, not the page'
          : stuck.length > 0
            ? `A REQUEST WAS STILL IN FLIGHT: ${stuck.join(', ')}`
            : issued > 0
              ? 'EVERY REQUEST COMPLETED AND `load` NEVER ARRIVED'
              : alive === null
                ? 'NO REQUEST WAS ISSUED, and the browser was never probed'
                : 'NO REQUEST WAS ISSUED, and the browser kept answering';

      return (
        `${verdict}. requests issued ${String(issued)}, settled ${String(settled)}, ` +
        `still outstanding ${String(outstanding.size)}; browser answered ` +
        `${String(answered)}/${String(probes)} probes, last ${String(since)}ms ago.`
      );
    },
    stop: () => {
      clearInterval(probe);
      page.off('request', begin);
      page.off('requestfinished', end);
      page.off('requestfailed', end);
    },
  };
}

async function reachLogin(page: Page): Promise<void> {
  const tracker = trackRequests(page);
  try {
    await page.goto('/login');
    return;
  } catch (err) {
    const evidence = tracker.report();
    // Deliberately on stdout: a silent retry would hide how often this
    // happens, and that count is the only evidence anyone has about whether
    // the underlying stall is getting better or worse. The in-flight list is
    // the half that can actually name a cause — see `trackRequests`.
    console.warn(
      `signIn: navigating to /login stalled (${String(err).split('\n')[0]}); retrying once. ` +
        `Known CI-environment stall — see reachLogin's docstring. ${evidence}`,
    );
  } finally {
    tracker.stop();
  }
  /* SETTLE BEFORE RETRYING, and this is not padding — the red-verify found it.
     A navigation that has just failed is still unwinding, and an immediate
     second `goto` is rejected outright: "Navigation to .../login is
     interrupted by another navigation to chrome-error://chromewebdata/". So
     the retry failed for a reason that had nothing to do with the stall it
     exists to survive, and the helper reported two stalls where there was
     one. Half a second is enough for the browser to finish giving up. */
  await page.waitForTimeout(500);
  try {
    await page.goto('/login');
  } catch (err) {
    throw new Error(
      'signIn: navigating to /login stalled TWICE. This is the setup step every ' +
        'spec shares, not the behaviour under test — read it as an environment ' +
        'failure rather than a defect in whichever spec reported it.',
      { cause: err },
    );
  }
}

/**
 * Drives the real login form through the browser. The account itself is
 * created ahead of time by one of fixtures.ts's seed*() functions, via
 * Better Auth's server API — never through this page.
 *
 * This is the CONTRACT Task 5's /login page must satisfy, not an assumption
 * about markup that already exists (it doesn't yet — apps/web today renders
 * only `<h1>PerfPortal</h1>`): an email field and a password field with
 * accessible names "Email" and "Password", and a submit button named
 * "Sign in". A successful sign-in is expected to navigate away from
 * /login once the session cookie is set — that's what this waits on, so a
 * caller can act on an authenticated page immediately afterward instead of
 * racing the redirect.
 */
export async function signIn(page: Page, who: { email: string; password: string }): Promise<void> {
  await reachLogin(page);
  await page.getByLabel('Email').fill(who.email);
  await page.getByLabel('Password').fill(who.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  try {
    await page.waitForURL((url) => !url.pathname.startsWith('/login'));
  } catch (err) {
    // A plain timeout here reports nothing but "60s elapsed" — indistinguishable
    // from a slow network, a wrong password, or a login page that renders its
    // error in place rather than redirecting. Capture what's actually on
    // screen so the failure names its own likely cause instead of costing the
    // next implementer an hour of re-deriving it.
    const bodyText = await page
      .locator('body')
      .innerText()
      .catch(() => '(could not read page body)');
    throw new Error(
      `signIn: still on /login for ${who.email} after clicking "Sign in" — the app never ` +
        `navigated away. Visible page text at the time of failure:\n${bodyText}`,
      { cause: err },
    );
  }
}

/**
 * The id of the first row in whatever run list the current page is showing.
 * Another forward-declared contract: Task 6's run list must render each row
 * with `data-testid="run-row"` and a `data-run-id` attribute carrying the
 * run's id, so Task 7's tests (and any other later consumer) have a stable
 * hook that doesn't depend on visible text or column order.
 */
export async function firstRowId(page: Page): Promise<string> {
  const row = page.getByTestId('run-row').first();
  await expect(row).toBeVisible();
  const id = await row.getAttribute('data-run-id');
  if (!id) {
    throw new Error('firstRowId: the first run-row element has no data-run-id attribute');
  }
  return id;
}

/**
 * Fetches an endpoint THROUGH THE PAGE'S OWN SESSION, so a parity assertion
 * reads exactly what the browser read — not a second request made with
 * different credentials, against which "the page agrees with the API" would be
 * a weaker claim than it looks.
 *
 * Byte-identical in run-charts.spec.ts and group-detail.spec.ts before this
 * moved here; run-detail.spec.ts is the third caller, and three private
 * copies of the same function is the point past which the duplication itself
 * becomes the convention.
 */
export async function apiJson<T>(page: Page, path: string): Promise<T> {
  return page.evaluate(async (p) => {
    const res = await fetch(p, { credentials: 'same-origin' });
    if (!res.ok) throw new Error(`${p} answered ${res.status}: ${await res.text()}`);
    return res.json();
  }, path);
}

/**
 * Opens the header's account menu, where the theme control and Sign out live
 * since review 09-13 N03.
 *
 * A helper rather than three copies of the same two lines: the panel is
 * UNMOUNTED while shut, so every assertion about either control has to open it
 * first, and a future move should be one edit here rather than a hunt through
 * the specs.
 */
export async function openAccountMenu(page: Page): Promise<void> {
  const trigger = page.getByTestId('account-menu-trigger');
  await trigger.click();
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
}

/**
 * Opens the time-window control if it is closed.
 *
 * Review M01 collapsed it: measured at 1440x900 it ran 332px and pushed the
 * run's own totals to y937, eighty pixels below the fold on the page a reader
 * opens to read four numbers. It is 44px closed, and it OPENS ITSELF whenever
 * a window is applied — so a spec arriving at a narrowed URL needs nothing,
 * while one that means to narrow a fresh run has to open it first, exactly as
 * a reader does.
 *
 * Checks before clicking rather than toggling blindly: a spec that applies a
 * window, navigates, and comes back would otherwise CLOSE the control the
 * product had deliberately opened.
 */
export async function openTimeWindow(page: Page): Promise<void> {
  const details = page.locator('[data-testid="time-brush"] details');
  await details.waitFor();
  const open = await details.evaluate((d) => (d as HTMLDetailsElement).open);
  if (!open) await page.getByTestId('time-window-toggle').click();
  await expect(page.getByTestId('window-from')).toBeVisible();
}

/**
 * ═══ SLOW AND FAILING RESPONSES, WHICH THIS SUITE COULD NOT SEE ═══
 * (the 09-13 review's acceptance list: "slow loading and retry")
 *
 * Every response in these specs is a real, fast, local API answer. Until the
 * acceptance pass added one `page.route` for an expired session there was no
 * interception anywhere in the suite — so no loading state, no skeleton, no
 * error panel and no in-flight control had ever been drawn in a browser. They
 * are all reachable in under a second locally, which is precisely why nobody
 * had seen them.
 *
 * `stall` holds a request open; `failWith` answers it. Both take a glob so a
 * case can slow ONE endpoint and leave the rest of the page working, which is
 * the realistic shape — a page whose every request hangs tells you less than
 * one whose table is waiting while its header has arrived.
 */
export async function stall(page: Page, glob: string, ms = 2_000): Promise<void> {
  await page.route(glob, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, ms));
    await route.continue();
  });
}

/**
 * Answer a matching request with a problem document, the way the API would.
 *
 * `application/problem+json` and a `remediation`, because that is what
 * `apiFetch` parses and what `ErrorState` renders — a bare 500 with an HTML
 * body exercises the SYNTHESISED branch instead, which is a different claim
 * and deserves its own call rather than being the accidental default.
 */
export async function failWith(
  page: Page,
  glob: string,
  problem: { status: number; title: string; detail: string; remediation?: string; code?: string },
): Promise<void> {
  await page.route(glob, (route) =>
    route.fulfill({
      status: problem.status,
      contentType: 'application/problem+json',
      body: JSON.stringify({ type: 'about:blank', ...problem }),
    }),
  );
}
