import '@testing-library/jest-dom/vitest';
import type { ComponentProps } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useOutletContext } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LiveDelta, RunResponse } from '@perfportal/contracts';
import type { LiveRunState } from '../src/api/live';
import RunShell from '../src/routes/RunShell';
import { formatDuration } from '../src/routes/format';
import useIsCompact from '../src/useIsCompact';
import type { RunWindowContext } from '../src/routes/useRunWindow';
import { useTimeAxis } from '../src/charts/TimeAxisContext';

/* NOT compact by default, which is what every case above this file's last
   describe assumes and what `useIsCompact` itself falls back to where
   `matchMedia` does not exist. The M18 block at the foot flips it. */
vi.mock('../src/useIsCompact.js', () => ({ default: vi.fn(() => false) }));
const useIsCompactMock = vi.mocked(useIsCompact);

afterEach(cleanup);

const RUN: RunResponse = {
  id: 'a66548b7-2962-43ff-8b93-7149a6f2a1b8',
  project: { id: '11111111-1111-4111-8111-111111111111', slug: 'checkout', name: 'Checkout' },
  status: 'complete',
  verdict: 'not_evaluated',
  tool: 'gatling',
  toolVersion: '3.15.1',
  simulation: 'example.ParitySimulation',
  description: null,
  durationMs: 63161,
  startedAt: '2026-08-14T10:43:49.546Z',
  toolStartedAt: '2026-08-07T05:30:02.171Z',
  assertions: [],
};

const EMPTY_USERS = { runId: RUN.id, scenarios: [], total: [] };

/**
 * A wire `sla` field with nothing to report. Every partial `lastDelta` below
 * needs one: `RunShell` now reads `live.lastDelta.sla` unconditionally and
 * hands it to `SlaBanner`, which dereferences `sla.breaching` on its first
 * line — so a fixture omitting it does not fail a type check (these deltas
 * are deliberately partial, behind an `as LiveRunState`), it throws at render.
 */
const NO_SLA: LiveDelta['sla'] = {
  evaluated: 7, notJudged: 0, rulesUnavailable: false, breaching: [],
};

const BREACHING_SLA: LiveDelta['sla'] = {
  evaluated: 7,
  notJudged: 0,
  rulesUnavailable: false,
  breaching: [{ ruleId: 'a', description: 'p95 ≤ 100 — actual 900', actualValue: 900, sinceOffsetMs: 62_000 }],
};

/** A partial live state carrying a delta with the given `sla`. */
function liveWithSla(sla: LiveDelta['sla'], connected = true): LiveRunState {
  return {
    connected, unauthorized: false, partial: false,
    lastDelta: { summary: { durationMs: 42_000 }, sla },
  } as LiveRunState;
}

/**
 * Renders `RunShell` with `RUN`'s own identity/status/verdict/windowable and
 * no live state — the terminal-run shape every pre-existing test here was
 * written against, before `RunShell` took `identity`/`status`/... instead of
 * a whole `RunResponse`.
 */
function renderShell() {
  return renderShellWith({});
}

/**
 * The terminal statuses `RunShell` used to compute itself before IMPORTANT 3
 * — kept here ONLY as the test helpers' own convenience default, never
 * imported by `RunShell.tsx` again. A case that wants to prove the shell
 * trusts the `terminal` PROP rather than re-deriving it passes `terminal`
 * explicitly, diverging it from `status`; see the "trusts the terminal prop"
 * cases below.
 */
const TERMINAL_STATUSES: ReadonlySet<RunResponse['status']> = new Set([
  'complete', 'incomplete', 'failed',
]);

/** `RunShell`, with `RUN`'s own props as defaults and any prop overridden. */
function renderShellWith(
  overrides: Partial<ComponentProps<typeof RunShell>>,
  at = `/runs/${RUN.id}`,
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const status = overrides.status ?? RUN.status;
  const props = {
    identity: RUN, status, verdict: RUN.verdict, windowable: RUN.windowable,
    terminal: TERMINAL_STATUSES.has(status),
    live: null, capReached: false, onRetry: () => {}, ...overrides,
  };
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[at]}>
        <Routes>
          <Route path="/runs/:runId" element={<RunShell {...props} />}>
            <Route index element={<div />} />
            <Route path="trends" element={<div />} />
            <Route path="compare" element={<div />} />
            <Route path="charts" element={<div />} />
            <Route path="errors" element={<div />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Reads back exactly what `RunShell`'s `<Outlet/>` hands its children. */
function ContextProbe() {
  const context = useOutletContext<RunWindowContext>();
  return <div data-testid="context-probe">{JSON.stringify(context)}</div>;
}

/** Same as `renderShellWith`, but mounts `<ContextProbe/>` as the index child. */
function renderProbeWith(
  overrides: Partial<ComponentProps<typeof RunShell>>,
  at = `/runs/${RUN.id}`,
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const status = overrides.status ?? RUN.status;
  const props = {
    identity: RUN, status, verdict: RUN.verdict, windowable: RUN.windowable,
    terminal: TERMINAL_STATUSES.has(status),
    live: null, capReached: false, onRetry: () => {}, ...overrides,
  };
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[at]}>
        <Routes>
          <Route path="/runs/:runId" element={<RunShell {...props} />}>
            <Route index element={<ContextProbe />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/**
 * `RunShell` is what actually feeds `RunTabs` its `errorCount`, and nothing
 * before this test rendered it: `RunTabs.test.tsx` only ever exercised the
 * prop directly, never the `errors.data?.errors.length ?? 0` expression that
 * used to compute it — which is exactly the line that collapsed "not yet
 * known" and "genuinely none" into the same `Errors (0)`.
 */
describe('RunShell', () => {
  it('mounts the lifecycle strip between the header and the release decision', () => {
    renderShell();
    const heading = screen.getByRole('heading', { level: 1 });
    const strip = screen.getByRole('region', { name: 'Run lifecycle' });
    const band = screen.getByRole('region', { name: 'Release decision' });
    expect(heading.compareDocumentPosition(strip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(strip.compareDocumentPosition(band) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  /** One number under one word, one verdict in one vocabulary: the strip must
   *  agree with the header's Duration chip and the band's big word. The two
   *  spans differ here, so an expression reading the wrong one shows a
   *  different number. */
  it('says the Duration chip’s number and the band’s word', () => {
    expect(formatDuration(62_136)).not.toBe(formatDuration(RUN.durationMs));
    renderShellWith({ identity: { ...RUN, activityMs: 62_136 }, verdict: 'failed', assertions: [] });
    expect(screen.getByTestId('run-duration')).toHaveTextContent(formatDuration(62_136));
    expect(screen.getByTestId('lifecycle-load-test')).toHaveTextContent(formatDuration(62_136));
    const word = screen.getByTestId('decision-word').textContent ?? '';
    expect(word).not.toBe('');
    expect(screen.getByTestId('lifecycle-verdict')).toHaveTextContent(`Verdict: ${word}`);
  });

  /** Processing's END reaches the strip through the shell. `ingestedAt` is a
   *  `RunResponse` field, not an identity one, and the shell's own prop type
   *  once erased it — so this proves the value is carried, not just typed. */
  it('carries processing’s end from the run’s body to the strip', () => {
    renderShellWith({
      identity: { ...RUN, parsingStartedAt: '2026-08-14T10:44:00.000Z', ingestedAt: '2026-08-14T10:44:02.000Z' },
    });
    expect(screen.getByTestId('lifecycle-processing')).toHaveTextContent('Processed · 2s');
  });

  it('renders a bare Errors tab before the errors payload has resolved, not Errors (0)', () => {
    vi.stubGlobal('fetch', () => new Promise<Response>(() => {}));

    renderShell();

    expect(screen.getByRole('link', { name: 'Errors' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Errors \(/ })).not.toBeInTheDocument();
  });

  it('shows the resolved distinct-message count once the errors payload arrives', async () => {
    vi.stubGlobal('fetch', (input: RequestInfo) => {
      const url = String(input);
      if (url.includes('/errors')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              runId: RUN.id,
              errors: [
                { message: 'boom', count: 15 },
                { message: 'bang', count: 9 },
              ],
            }),
            { status: 200 },
          ),
        );
      }
      return Promise.resolve(new Response(JSON.stringify(EMPTY_USERS), { status: 200 }));
    });

    renderShell();

    expect(await screen.findByRole('link', { name: 'Errors (2)' })).toBeInTheDocument();
  });

  it('renders a bare Errors tab when the errors fetch fails, not a confident zero', async () => {
    vi.stubGlobal('fetch', (input: RequestInfo) => {
      const url = String(input);
      if (url.includes('/errors')) {
        return Promise.resolve(new Response('{}', { status: 500 }));
      }
      return Promise.resolve(new Response(JSON.stringify(EMPTY_USERS), { status: 200 }));
    });

    renderShell();

    // No `Errors (…)` of any kind ever appears — including the specific
    // wrong answer `?? 0` used to produce, and produce permanently, since a
    // failed fetch never resolves `errors.data`.
    await screen.findByRole('link', { name: 'Errors' });
    expect(screen.queryByRole('link', { name: 'Errors (0)' })).not.toBeInTheDocument();
  });

  /**
   * A terminal run passes `live: null` (there is no socket for a run that
   * has already finished), so `liveDurationMs` — `live?.lastDelta?.summary
   * .durationMs ?? null` — stays `null` for exactly the run this test
   * renders. This used to pin a hard-coded `null` that could never become
   * anything else, because `RunShell`'s one caller could never reach it with
   * a running run at all; now it pins the terminal branch of a value that
   * genuinely varies — see the two live-run cases below for the other one.
   */
  it('hands liveDurationMs: null through the outlet context for a terminal run with no live state', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(new Response(JSON.stringify(EMPTY_USERS), { status: 200 })));

    renderProbeWith({});

    const probe = await screen.findByTestId('context-probe');
    const context = JSON.parse(probe.textContent ?? '{}') as RunWindowContext;
    expect(context.liveDurationMs).toBeNull();
    // `durationMs` is unaffected -- this pins ONLY the field this case is about.
    expect(context.durationMs).toBe(RUN.durationMs);
  });

  it('mounts header and tabs for a running run', () => {
    renderShellWith({ status: 'running', verdict: undefined, windowable: undefined });
    expect(screen.getByRole('navigation', { name: 'Run sections' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Overview' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Trends' })).toBeInTheDocument();
  });

  it('offers no time brush while a run is live', () => {
    // A live view is never narrowed (useLiveRun's own rule), and identity
    // carries no `windowable`, so the brush cannot be offered. Pinned here so
    // nobody later "fixes" it by threading windowable onto identity.
    renderShellWith({ status: 'running', verdict: undefined, windowable: undefined });
    expect(screen.queryByRole('slider')).toBeNull();
  });

  it('does not FETCH the shared metric keys while a run is live', () => {
    // useLiveRun's applyDelta already writes usersQuery and errorsQuery
    // directly. A live REST fetch answers emptier for a run whose rows do not
    // exist yet, and TanStack applies whichever write resolves last — so the
    // socket's own numbers would lose a race to an empty payload.
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    renderShellWith({ status: 'running', verdict: undefined, windowable: undefined });
    const urls = fetchSpy.mock.calls.map((c) => String(c[0]));
    // `.some(...)`, NOT `expect(urls).not.toContain(expect.stringContaining(...))` —
    // toContain does not meaningfully take an asymmetric matcher, so that
    // spelling passes whether or not the fetch happened.
    expect(urls.some((u) => u.includes('/users'))).toBe(false);
    expect(urls.some((u) => u.includes('/errors'))).toBe(false);
    fetchSpy.mockRestore();
  });

  it('hands its children the live state through the outlet context', () => {
    const live = { connected: true, lastDelta: null, unauthorized: false, partial: false };
    renderProbeWith({ status: 'running', live });
    expect(screen.getByTestId('context-probe').textContent).toContain('"connected":true');
  });

  it('reports the growing domain from the live delta, not from a null duration', () => {
    // `LiveDelta` carries `responseTime`/`users`/`errors`/`seq` beyond
    // `summary`, none of which this assertion reads — a specific assertion
    // to the real type, not `any`, for a fixture that is genuinely partial.
    const live = {
      connected: true, unauthorized: false, partial: false,
      lastDelta: { summary: { durationMs: 42_000 }, sla: NO_SLA },
    } as LiveRunState;
    renderProbeWith({ status: 'running', live });
    expect(screen.getByTestId('context-probe').textContent).toContain('"liveDurationMs":42000');
  });

  /**
   * GAP-CLOSER (Task 7 fix round 2). `LiveStatusStrip.test.tsx` tests its own
   * `streamed` GATE in both directions, but nothing pinned the DERIVATION
   * that feeds it — `streamed={live?.lastDelta != null}` (`RunShell.tsx`).
   * Regressing that back to `status === 'parsing'` alone would make every
   * OTHER test in the repo stay green while silently restoring the worst bug
   * this sub-project found: a batch-uploaded run that never streamed being
   * told "Streaming has stopped" with no numbers on screen for the sentence
   * to be about. These two cases are what would actually catch that.
   */
  it('renders the frozen sentence for a parsing run WITH a delta this session', () => {
    const live = {
      connected: false, unauthorized: false, partial: false,
      lastDelta: { summary: { durationMs: 42_000 }, sla: NO_SLA },
    } as LiveRunState;
    renderShellWith({ status: 'parsing', verdict: undefined, windowable: undefined, live });
    expect(screen.getByText(/streaming has stopped/i)).toBeInTheDocument();
  });

  it('renders NEITHER streaming sentence for a parsing run that never streamed', () => {
    const live = { connected: false, unauthorized: false, partial: false, lastDelta: null };
    renderShellWith({ status: 'parsing', verdict: undefined, windowable: undefined, live });
    expect(screen.queryByText(/streaming has stopped/i)).not.toBeInTheDocument();
    expect(screen.queryByTestId('live-notice-finalizing')).not.toBeInTheDocument();
  });

  /**
   * IMPORTANT 3. `RunShell` used to compute `terminal` itself from an
   * allowlist of `status` values (`status === 'complete' || … === 'incomplete'
   * || … === 'failed'`) — a future terminal status `RunStatusSchema` grew
   * without a matching branch here would silently fall through to "not
   * terminal", rendering terminal tab content under a live status strip and a
   * socket that was never opened for it. These two cases prove the shell now
   * obeys the `terminal` PROP exclusively: `status` alone predicts nothing
   * about whether the metric queries fire or the strip renders.
   */
  it('trusts terminal=false over a `status` the old allowlist called terminal', () => {
    // `status: 'complete'` used to be terminal on its own; `terminal: false`
    // here proves the shell no longer looks at `status` to decide that. No
    // fetch mock is needed: `enabled: terminal` is `false`, so neither query
    // should call `fetch` at all regardless of `status`.
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    renderShellWith({ status: 'complete', terminal: false });
    // The non-terminal strip renders (its own "checks again" sentence for a
    // run that is neither streaming, frozen nor capped) — impossible for a
    // shell that still believed `status: 'complete'` meant terminal.
    expect(
      screen.getByText('This page checks again every few seconds; there is nothing to do.'),
    ).toBeInTheDocument();
    const urls = fetchSpy.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes('/users'))).toBe(false);
    expect(urls.some((u) => u.includes('/errors'))).toBe(false);
    fetchSpy.mockRestore();
  });

  it('trusts terminal=true over a `status` the old allowlist called non-terminal', () => {
    // `status: 'running'` used to be non-terminal on its own; `terminal:
    // true` here proves the shell fetches and hides the strip regardless.
    vi.stubGlobal('fetch', (input: RequestInfo) => {
      const url = String(input);
      if (url.includes('/errors')) {
        return Promise.resolve(new Response(JSON.stringify({ runId: RUN.id, errors: [] }), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify(EMPTY_USERS), { status: 200 }));
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    renderShellWith({
      status: 'running', verdict: undefined, windowable: undefined, terminal: true,
    });
    // No live status strip at all — `!terminal &&` above it is false.
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    const urls = fetchSpy.mock.calls.map((c) => String(c[0]));
    // The shell's own `users`/`errors` fetch fires — gated on `enabled:
    // terminal`, which the old `status === 'running'` derivation would have
    // forced to `false` regardless of what this test passes.
    expect(urls.some((u) => u.includes('/users'))).toBe(true);
    fetchSpy.mockRestore();
  });
});

/**
 * WHERE THE SLA BANNER LIVES, which is the only thing about it this file
 * tests. `SlaBanner.test.tsx` owns the component's own behaviour — what the
 * denominator counts, the condition-not-event rule, both tenses of `frozen`,
 * the rules-could-not-be-loaded state — and none of that is re-asserted here.
 *
 * What has no other home is the PLACEMENT, and it needs one because the
 * banner moved. It shipped inside `Live`, the standalone live page, whose
 * only route was `/runs/:runId` — so it was reachable on exactly one screen.
 * `Live` is gone; the shell mounts once above the `<Outlet/>` and the five
 * tabs swap underneath it, which is what puts a breach in front of a reader
 * watching Charts as much as one watching Overview. A future change that
 * pushed this down into `RunOverviewTab` would leave every case in
 * `SlaBanner.test.tsx` green while making the banner invisible on four tabs
 * out of five; these cases are what would catch it.
 */
describe('RunShell — the SLA breach banner', () => {
  it('renders the banner above the outlet, so it is on screen whichever tab is open', () => {
    // The index child is a bare `<div/>` — i.e. NOT the Overview tab, and not
    // any tab at all. The banner still renders, which is the assertion: it
    // belongs to the shell, not to whatever the outlet happens to be showing.
    renderShellWith({
      status: 'running', verdict: undefined, windowable: undefined,
      live: liveWithSla(BREACHING_SLA),
    });
    expect(screen.getByTestId('sla-banner')).toBeInTheDocument();
    expect(screen.getByText(/p95 ≤ 100 — actual 900/)).toBeInTheDocument();
  });

  it('reads in the present tense while the run is still running', () => {
    renderShellWith({
      status: 'running', verdict: undefined, windowable: undefined,
      live: liveWithSla(BREACHING_SLA),
    });
    expect(screen.getByText(/currently breaching/i)).toBeInTheDocument();
    expect(screen.queryByText(/when streaming stopped/i)).not.toBeInTheDocument();
  });

  /**
   * `frozen` is `status !== 'running'`, computed HERE — a run that has stopped
   * streaming but is still `parsing` keeps its last delta, and the fold owner
   * has already released it, so nothing will ever re-evaluate those rules.
   * "currently breaching" would be a claim about a live evaluation that is no
   * longer running. `LiveSummary`'s Duration tile draws the same distinction
   * off the same flag and the two must never disagree on one render.
   */
  it('switches to the past tense once the run has stopped streaming', () => {
    renderShellWith({
      status: 'parsing', verdict: undefined, windowable: undefined,
      live: liveWithSla(BREACHING_SLA, false),
    });
    expect(screen.getByText(/breaching when streaming stopped/i)).toBeInTheDocument();
    expect(screen.queryByText(/currently breaching/i)).not.toBeInTheDocument();
  });

  it('renders no banner for a run whose delta reports nothing breaching', () => {
    renderShellWith({
      status: 'running', verdict: undefined, windowable: undefined,
      live: liveWithSla(NO_SLA),
    });
    expect(screen.queryByTestId('sla-banner')).not.toBeInTheDocument();
  });

  /**
   * A run still streaming that has produced no delta YET has no `sla` to read
   * — the guard is `live?.lastDelta != null`, not `live != null`. Without it
   * this reads `.sla` off `null` and the whole shell throws, taking the header
   * and the tab strip down with it for every live run's first paint.
   */
  it('renders no banner before the first delta has arrived', () => {
    const live = { connected: true, lastDelta: null, unauthorized: false, partial: false };
    renderShellWith({ status: 'running', verdict: undefined, windowable: undefined, live });
    expect(screen.queryByTestId('sla-banner')).not.toBeInTheDocument();
  });

  it('renders no banner for a terminal run, which has no live state at all', () => {
    // `RunDetail` passes `live: null` the moment the run leaves the processing
    // union. The finished report's own assertions replace this.
    renderShellWith({});
    expect(screen.queryByTestId('sla-banner')).not.toBeInTheDocument();
  });
});

/**
 * REVIEW C03 — THE WINDOW CONTROL MUST NOT APPEAR OVER SECTIONS THAT IGNORE IT.
 *
 * The brush is rendered by the shell, so it sat above every tab — including
 * Trends, whose cohort query is historical and takes no window at all, and
 * Compare, which is the same. The control accepted 10–30s there, announced
 * that window, and changed nothing: an engineer reading a trend line had no
 * way to know it still covered the whole run.
 *
 * Hiding it on those two is the honest half. The PARAMETERS still travel
 * (`RunTabs`), so returning to Overview restores the selection — the reader
 * loses the control where it is meaningless, not their place.
 */
describe('RunShell — the window control only appears where it applies', () => {
  it('offers the brush on the tabs that honour a window', async () => {
    renderShellWith({ windowable: true }, `/runs/${RUN.id}/charts`);
    expect(await screen.findByTestId('time-brush')).toBeInTheDocument();
  });

  it('withholds it on Trends, whose query is whole-run by construction', async () => {
    renderShellWith({ windowable: true }, `/runs/${RUN.id}/trends`);
    await screen.findByRole('navigation', { name: /run sections/i });
    expect(screen.queryByTestId('time-brush')).not.toBeInTheDocument();
  });

  it('withholds it on Compare for the same reason', async () => {
    renderShellWith({ windowable: true }, `/runs/${RUN.id}/compare`);
    await screen.findByRole('navigation', { name: /run sections/i });
    expect(screen.queryByTestId('time-brush')).not.toBeInTheDocument();
  });

  it('still offers it on Overview', async () => {
    renderShellWith({ windowable: true }, `/runs/${RUN.id}`);
    expect(await screen.findByTestId('time-brush')).toBeInTheDocument();
  });
});

/**
 * ═══ ONE NUMBER UNDER "DURATION" (the time-window spec's deviation F) ═══
 *
 * `RunHeader`'s chip reads the run's activity span, and the navigator's own
 * header has to read the same, not the series span a second longer.
 * `TimeBrush` falls back to the series span when the shell passes nothing, so
 * dropping the prop would put 63s under the navigator beside a 62s chip with
 * every other case here still green.
 */
describe('RunShell — the navigator’s Duration', () => {
  it('reads the activity span the header calls Duration, not the series span', async () => {
    renderShellWith({ identity: { ...RUN, activityMs: 62_136 }, windowable: true });
    expect(await screen.findByTestId('window-duration')).toHaveTextContent('Duration: 62s');
  });
});

/**
 * ═══ REVIEW M18 — THE BRUSH IS NOT A PHONE CONTROL ═══
 *
 * Measured in Chromium at 375x812: the brush was 394px tall and sat between
 * the decision band and the run's own numbers, which began at y=1485 — two
 * screens down. It is also a DRAG control, the deepest kind of analysis §22.6
 * already calls a desktop task and the one gesture a phone is worst at.
 *
 * ═══ WITHHOLDING THE CONTROL IS NOT IGNORING THE WINDOW ═══
 *
 * That distinction is the whole of what these cases guard. A link carrying
 * `?from=&to=` is exactly the link most likely to be opened on a phone —
 * somebody pasted it into a chat BECAUSE of what it shows — so the data stays
 * narrowed and every tab keeps reading the same range. Dropping the control
 * silently would leave that reader looking at a tenth of a run with nothing
 * on screen admitting it.
 *
 * An implementation that simply hid the brush passes the first case below and
 * fails the second; one that also cleared the window passes both and fails the
 * third.
 */
describe('RunShell — the time brush on a narrow viewport', () => {
  const windowed = `/runs/${RUN.id}?from=10000&to=30000`;

  it('does not mount the brush', async () => {
    useIsCompactMock.mockReturnValue(true);
    renderShellWith({ windowable: true }, windowed);
    await screen.findByRole('navigation', { name: /run sections/i });
    expect(screen.queryByTestId('time-brush')).not.toBeInTheDocument();
  });

  it('says which stretch is being shown, rather than dropping the fact', async () => {
    useIsCompactMock.mockReturnValue(true);
    renderShellWith({ windowable: true }, windowed);

    const notice = await screen.findByTestId('compact-window-notice');
    // SECONDS, because that is what the brush's own axis and every time chart
    // on this page label their ticks with. Derived from the URL rather than
    // written down, so a different link moves the assertion with it.
    expect(notice).toHaveTextContent('10–30 s');
    expect(notice.textContent ?? '').toMatch(/whole run/i);
  });

  it('carries the window into the tabs, so the data really is narrowed', async () => {
    useIsCompactMock.mockReturnValue(true);
    renderProbeWith({ windowable: true }, windowed);

    const context = JSON.parse(
      (await screen.findByTestId('context-probe')).textContent ?? '{}',
    ) as RunWindowContext;
    // `toMatchObject`, not `toEqual`: the window object carries a third field
    // (the snapped/derived bound) that is not what this case is about, and
    // pinning it here would make an unrelated change to `useRunWindow` fail a
    // test about the compact layout.
    expect(context.window).toMatchObject({ fromMs: 10_000, toMs: 30_000 });
  });

  /** An unwindowed run is not told about a control it is not being offered:
   *  the notice exists for the reader who followed a narrowed link. */
  it('renders nothing at all when no window is applied', async () => {
    useIsCompactMock.mockReturnValue(true);
    renderShellWith({ windowable: true }, `/runs/${RUN.id}`);
    await screen.findByRole('navigation', { name: /run sections/i });
    expect(screen.queryByTestId('compact-window-notice')).not.toBeInTheDocument();
    expect(screen.queryByTestId('time-brush')).not.toBeInTheDocument();
  });

  /** And a desktop is untouched — the brush, not the notice. */
  it('leaves the brush in place on a wide viewport', async () => {
    useIsCompactMock.mockReturnValue(false);
    renderShellWith({ windowable: true }, windowed);
    expect(await screen.findByTestId('time-brush')).toBeInTheDocument();
    expect(screen.queryByTestId('compact-window-notice')).not.toBeInTheDocument();
  });
});

/**
 * THE RUN'S CLOCK REACHES EVERY TAB. `RunShell` provides the anchor its
 * charts read wall-clock time from, off the identity it already holds, so no
 * tab reads the run a second time to learn when it started.
 */
describe('RunShell — the run’s time axis reaches every tab', () => {
  function AxisProbe() {
    return <div data-testid="axis-probe">{String(useTimeAxis().anchorMs)}</div>;
  }

  function renderWithProbe(identity: ComponentProps<typeof RunShell>['identity']) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[`/runs/${RUN.id}`]}>
          <Routes>
            <Route
              path="/runs/:runId"
              element={
                <RunShell
                  identity={identity}
                  status="complete"
                  terminal
                  verdict={RUN.verdict}
                  windowable={RUN.windowable}
                  live={null}
                  capReached={false}
                  onRetry={() => {}}
                />
              }
            >
              <Route index element={<AxisProbe />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  it('anchors every chart beneath it to the run’s own start', async () => {
    renderWithProbe(RUN);
    expect(await screen.findByTestId('axis-probe')).toHaveTextContent(
      String(Date.parse(RUN.toolStartedAt!)),
    );
  });

  it('has no anchor for a run that recorded no start', async () => {
    renderWithProbe({ ...RUN, toolStartedAt: null });
    expect(await screen.findByTestId('axis-probe')).toHaveTextContent('null');
  });
});
