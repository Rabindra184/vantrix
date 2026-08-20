import '@testing-library/jest-dom/vitest';
import type { ComponentProps } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useOutletContext } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LiveDelta, RunResponse } from '@perfportal/contracts';
import type { LiveRunState } from '../src/api/live';
import RunShell from '../src/routes/RunShell';
import type { RunWindowContext } from '../src/routes/useRunWindow';

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
function renderShellWith(overrides: Partial<ComponentProps<typeof RunShell>>) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const status = overrides.status ?? RUN.status;
  const props = {
    identity: RUN, status, verdict: RUN.verdict, windowable: RUN.windowable,
    terminal: TERMINAL_STATUSES.has(status),
    live: null, capReached: false, onRetry: () => {}, ...overrides,
  };
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/runs/${RUN.id}`]}>
        <Routes>
          <Route path="/runs/:runId" element={<RunShell {...props} />}>
            <Route index element={<div />} />
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
function renderProbeWith(overrides: Partial<ComponentProps<typeof RunShell>>) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const status = overrides.status ?? RUN.status;
  const props = {
    identity: RUN, status, verdict: RUN.verdict, windowable: RUN.windowable,
    terminal: TERMINAL_STATUSES.has(status),
    live: null, capReached: false, onRetry: () => {}, ...overrides,
  };
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/runs/${RUN.id}`]}>
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
