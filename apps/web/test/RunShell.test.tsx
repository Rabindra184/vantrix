import '@testing-library/jest-dom/vitest';
import type { ComponentProps } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useOutletContext } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LiveDelta, RunNote as RunNoteValue, RunResponse } from '@perfportal/contracts';
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

// `cleanup` AND the global stubs: this file stubs `fetch` per case, and without
// the unstub a case inherited the previous case's stub — which hid whether the
// shell fetched anything of its own, the one thing the `/users` cases below
// are about.
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  // `mockReturnValue` persists across cases: a phone case that forgot to hand
  // the next describe a desktop would silently turn every later case compact.
  useIsCompactMock.mockReturnValue(false);
});

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
            <Route path="report" element={<div />} />
            <Route path="trends" element={<div />} />
            <Route path="compare" element={<div />} />
            <Route path="logs" element={<div />} />
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
            <Route path="report" element={<ContextProbe />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('RunShell', () => {
  /** Header, then the tab strip, then — on the Summary — the journey and the
   *  decision. GE draws its strip under the run's title; here it sits under the
   *  tab strip so the strip stays in one place on every page. */
  it('mounts the lifecycle strip below the tabs, above the release decision', () => {
    renderShell();
    const heading = screen.getByRole('heading', { level: 1 });
    const tabs = screen.getByRole('navigation', { name: 'Run sections' });
    const strip = screen.getByRole('region', { name: 'Run lifecycle' });
    const band = screen.getByRole('region', { name: 'Release decision' });
    expect(heading.compareDocumentPosition(tabs) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(tabs.compareDocumentPosition(strip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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

  /** The strip's live Load test reads the delta's `activityMs ?? durationMs` —
   *  the span the Duration chip reports once the run finishes, so the figure
   *  does not change basis when it ends. */
  it('reads a live load test off the socket’s latest delta', () => {
    const live = {
      connected: true, unauthorized: false, partial: false,
      lastDelta: { summary: { durationMs: 43_000, activityMs: 42_000 }, sla: NO_SLA },
    } as LiveRunState;
    renderShellWith({ status: 'running', verdict: undefined, windowable: undefined, live });
    expect(screen.getByTestId('lifecycle-load-test')).toHaveTextContent('Load test · streaming · 42s');
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
    expect(screen.getByRole('link', { name: 'Summary' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Trends' })).toBeInTheDocument();
  });

  it('offers no time brush while a run is live', () => {
    // A live view is never narrowed (useLiveRun's own rule), and identity
    // carries no `windowable`, so the brush cannot be offered. Pinned here so
    // nobody later "fixes" it by threading windowable onto identity.
    renderShellWith({ status: 'running', verdict: undefined, windowable: undefined });
    expect(screen.queryByRole('slider')).toBeNull();
  });

  it('does not FETCH the shared metric key while a run is live', () => {
    // useLiveRun's applyDelta already writes usersQuery directly. A live REST
    // fetch answers emptier for a run whose rows do not exist yet, and TanStack
    // applies whichever write resolves last — so the socket's own numbers would
    // lose a race to an empty payload. Rendered ON THE REPORT with `windowable:
    // true`, the one place and the one state where the shell would otherwise
    // ask for `/users`: anywhere else the absence would hold for a reason that
    // has nothing to do with the run being live.
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    renderShellWith({ status: 'running', verdict: undefined, windowable: true }, `/runs/${RUN.id}/report`);
    const urls = fetchSpy.mock.calls.map((c) => String(c[0]));
    // `.some(...)`, NOT `expect(urls).not.toContain(expect.stringContaining(...))` —
    // toContain does not meaningfully take an asymmetric matcher, so that
    // spelling passes whether or not the fetch happened.
    expect(urls.some((u) => u.includes('/users'))).toBe(false);
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
    // fetch mock is needed: `enabled` includes `terminal`, which is `false`, so
    // the query should not call `fetch` at all regardless of `status` — and the
    // run is windowable, on the Report, on a desktop, so `terminal` is the only
    // reason it does not.
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    renderShellWith({ status: 'complete', terminal: false, windowable: true }, `/runs/${RUN.id}/report`);
    // The non-terminal strip renders (its own "checks again" sentence for a
    // run that is neither streaming, frozen nor capped) — impossible for a
    // shell that still believed `status: 'complete'` meant terminal.
    expect(
      screen.getByText('This page checks again every few seconds; there is nothing to do.'),
    ).toBeInTheDocument();
    const urls = fetchSpy.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes('/users'))).toBe(false);
    fetchSpy.mockRestore();
  });

  /** Two tabs on two runs of one test used to read alike (both the
   *  simulation). A numbered run's tab names the test and the run. */
  it('titles the document with the test and the run’s number', () => {
    renderShellWith({
      identity: { ...RUN, test: { id: '33333333-3333-4333-8333-333333333333', slug: 'checkout-smoke', name: 'Checkout smoke' }, runNumber: 12 },
    });
    expect(document.title).toBe('Checkout smoke · Run 12 · PerfPortal');
  });

  it('trusts terminal=true over a `status` the old allowlist called non-terminal', () => {
    // `status: 'running'` used to be non-terminal on its own; `terminal:
    // true` here proves the shell fetches and hides the strip regardless.
    vi.stubGlobal('fetch', () =>
      Promise.resolve(new Response(JSON.stringify(EMPTY_USERS), { status: 200 })),
    );
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    renderShellWith(
      { status: 'running', verdict: undefined, windowable: true, terminal: true },
      `/runs/${RUN.id}/report`,
    );
    // No live status strip at all — `!terminal &&` above it is false.
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    const urls = fetchSpy.mock.calls.map((c) => String(c[0]));
    // The shell's own `users` fetch fires — gated on `enabled: terminal`,
    // which the old `status === 'running'` derivation would have forced to
    // `false` regardless of what this test passes.
    expect(urls.some((u) => u.includes('/users'))).toBe(true);
    fetchSpy.mockRestore();
  });

  /**
   * THE SHELL ASKS FOR `/users` ONLY WHERE THE BRUSH IS. The query exists for
   * one reason — the snapped window a response reports, which the brush states
   * as "Showing …". Gatling Enterprise's Summary never sends a window, so the
   * Summary and every other section have no use for it: the Summary's own Peak
   * users tile fetches its own copy, and a second request from here is paid for
   * by every page that does not draw the brush. Asserted in both directions
   * because "never fetches" and "always fetches" each pass one of them.
   *
   * "Where the brush is" is narrower than "on the Report": a Report with no
   * brush — a phone's (the compact block below), or a run that cannot honour a
   * window — has no use for it either, and for a non-windowable run opened on a
   * link carrying `?from=` the request would be a WINDOWED one, which the API
   * answers 400 WINDOW_UNAVAILABLE.
   */
  it('fetches /users on the Report, where the brush’s applied window comes from', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(new Response(JSON.stringify(EMPTY_USERS), { status: 200 })),
    );
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    renderShellWith({ windowable: true }, `/runs/${RUN.id}/report`);
    await screen.findByTestId('time-brush');
    expect(fetchSpy.mock.calls.some((c) => String(c[0]).includes('/users'))).toBe(true);
    fetchSpy.mockRestore();
  });

  it('fetches no /users for a run that cannot honour a window, even when the URL carries one', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(new Response(JSON.stringify(EMPTY_USERS), { status: 200 })),
    );
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    renderShellWith({ windowable: false }, `/runs/${RUN.id}/report?from=10000&to=30000`);
    // The paired positive: this is the Report, and it is the `windowable` gate
    // — not the page — that withheld both the brush and the request.
    expect(await screen.findByRole('link', { name: 'Report' })).toHaveAttribute('aria-current', 'page');
    expect(screen.queryByTestId('time-brush')).toBeNull();
    expect(fetchSpy.mock.calls.some((c) => String(c[0]).includes('/users'))).toBe(false);
    fetchSpy.mockRestore();
  });

  it.each([
    ['the Summary', ''],
    ['Trends', '/trends'],
    ['Compare', '/compare'],
  ])('does not fetch /users on %s', async (_where, section) => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(new Response(JSON.stringify(EMPTY_USERS), { status: 200 })),
    );
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    renderShellWith({ windowable: true }, `/runs/${RUN.id}${section}`);
    // The paired positive: the shell rendered, and (for the Summary) drew its
    // decision, so an absent fetch is not an absent page.
    await screen.findByRole('navigation', { name: 'Run sections' });
    expect(fetchSpy.mock.calls.some((c) => String(c[0]).includes('/users'))).toBe(false);
    fetchSpy.mockRestore();
  });
});

/**
 * ═══ GATLING ENTERPRISE'S SUMMARY AND REPORT, AROUND THE TAB STRIP ═══
 *
 * The lifecycle strip and the verdict band answer "how did the run go", which
 * is the Summary's question; the time window is how the Report's charts are
 * narrowed. The shell used to draw both above every section, so a reader on
 * Trends was shown a release decision they had not asked for and a window
 * control that changed nothing. Each now belongs to the one page it is about —
 * and BELOW the tab strip, so the strip stays in one place on every page.
 */
describe('RunShell — GE’s Summary and Report around the tab strip', () => {
  it('draws the lifecycle strip and the verdict band on the Summary only, below the tabs', () => {
    renderShellWith({}, `/runs/${RUN.id}`);
    const tabs = screen.getByRole('navigation', { name: 'Run sections' });
    const strip = screen.getByTestId('run-lifecycle');
    const band = screen.getByRole('region', { name: 'Release decision' });
    expect(tabs.compareDocumentPosition(strip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(tabs.compareDocumentPosition(band) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it.each(['report', 'logs', 'trends', 'compare'])('draws no lifecycle strip or band on %s', (section) => {
    renderShellWith({}, `/runs/${RUN.id}/${section}`);
    // The paired positive: the shell drew its tab strip, so the absences are
    // not an absent page.
    expect(screen.getByRole('navigation', { name: 'Run sections' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Release decision' })).toBeNull();
    expect(screen.queryByTestId('run-lifecycle')).toBeNull();
  });

  /** THE VERDICT ONCE PER PAGE, ON EVERY PAGE (clean UI PR 2's final review).
   *  The header's verdict badge was dropped on the belief that the lifecycle
   *  strip carries the verdict on every tab — and the strip, like the band,
   *  draws on the Summary alone. So a failed run's Report, Logs, Trends and
   *  Compare said nothing about how it went. The badge is back on those four
   *  and withheld on the Summary, where the band's word states it. */
  it.each(['report', 'logs', 'trends', 'compare'])('names a failed run’s verdict in the header on %s', (section) => {
    renderShellWith({ verdict: 'failed' }, `/runs/${RUN.id}/${section}`);
    expect(screen.getByTestId('run-verdict')).toHaveAccessibleName('failed');
  });

  it('names no verdict in the header on the Summary, where the band states it', () => {
    renderShellWith({ verdict: 'failed' }, `/runs/${RUN.id}`);
    // The paired positive: the band is there, so the absence is not a page
    // that failed to draw.
    expect(screen.getByRole('region', { name: 'Release decision' })).toBeInTheDocument();
    expect(screen.getByTestId('run-status')).toBeInTheDocument();
    expect(screen.queryByTestId('run-verdict')).toBeNull();
  });

  it('offers the time window on the Report and nowhere else', async () => {
    renderShellWith({ windowable: true }, `/runs/${RUN.id}/report`);
    expect(await screen.findByTestId('time-brush')).toBeInTheDocument();
    cleanup();
    renderShellWith({ windowable: true }, `/runs/${RUN.id}`);
    expect(screen.getByRole('region', { name: 'Release decision' })).toBeInTheDocument();
    expect(screen.queryByTestId('time-brush')).toBeNull();
  });

  it('renders the Report with no time window for a run that cannot honour one', () => {
    renderShellWith({ windowable: false }, `/runs/${RUN.id}/report`);
    expect(screen.queryByTestId('time-brush')).toBeNull();
    expect(screen.getByRole('navigation', { name: 'Run sections' })).toBeVisible();
  });

  /** THE ROUTER IGNORES CASE, SO THE SHELL MUST TOO. A hand-typed upper-case
   *  UUID — or `/Report` — is the same run page to React Router and to the tab
   *  strip's `NavLink`, while the run's own id arrives from the API in lower
   *  case. Compared exactly, the shell would draw neither the Summary's band
   *  nor the Report's window for a page everything else calls the Summary. */
  it('finds the Summary at an upper-case run id', () => {
    // The fixture id has letters, so upper-casing really changes the string.
    expect(RUN.id).not.toBe(RUN.id.toUpperCase());
    renderShellWith({ windowable: true }, `/runs/${RUN.id.toUpperCase()}`);
    expect(screen.getByRole('region', { name: 'Release decision' })).toBeInTheDocument();
    expect(screen.getByTestId('run-lifecycle')).toBeInTheDocument();
  });

  it('finds the Report at an upper-case run id and segment', async () => {
    renderShellWith({ windowable: true }, `/runs/${RUN.id.toUpperCase()}/Report`);
    expect(await screen.findByTestId('time-brush')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Release decision' })).toBeNull();
  });

  /** A TRAILING SLASH IS THE SAME PAGE to the router and a different string to
   *  a comparison, so the shell strips it before deciding which page this is.
   *  Without that, `/runs/<id>/` — a link pasted with the slash its address bar
   *  grew — would draw neither the Summary's band nor the Report's window, and
   *  the page would look like a section that exists and has nothing on it. */
  it('treats a trailing slash as the same page', async () => {
    renderShellWith({ windowable: true }, `/runs/${RUN.id}/`);
    expect(screen.getByRole('region', { name: 'Release decision' })).toBeInTheDocument();
    cleanup();
    renderShellWith({ windowable: true }, `/runs/${RUN.id}/report/`);
    expect(await screen.findByTestId('time-brush')).toBeInTheDocument();
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
 * `Live` is gone; the shell mounts once above the `<Outlet/>` and the run's
 * sections swap underneath it, which is what puts a breach in front of a
 * reader watching the Report as much as one watching the Summary. A future
 * change that pushed this down into `RunSummary` would leave every case in
 * `SlaBanner.test.tsx` green while making the banner invisible on every
 * section but one; these cases are what would catch it.
 */
describe('RunShell — the SLA breach banner', () => {
  it('renders the banner above the outlet, so it is on screen whichever tab is open', () => {
    // The index child is a bare `<div/>` — i.e. NOT the Summary, and not
    // any section at all. The banner still renders, which is the assertion: it
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
   * longer running.
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
 * The brush is rendered by the shell, so it once sat above every tab —
 * including Trends, whose cohort query is historical and takes no window at
 * all, and Compare, which is the same. The control accepted 10–30s there,
 * announced that window, and changed nothing: an engineer reading a trend line
 * had no way to know it still covered the whole run.
 *
 * It is a NAMED PLACE now rather than a list of exceptions: the Report, where
 * Gatling Enterprise puts it, and nowhere else. The Summary answers a
 * whole-run question and never sends a window, so a control over it would be
 * the same claim about a page that ignores it. The PARAMETERS still travel
 * (`RunTabs`), so returning to the Report restores the selection — the reader
 * loses the control where it is meaningless, not their place.
 */
describe('RunShell — the window control only appears where it applies', () => {
  it('offers the brush on the Report, the one section that honours a window', async () => {
    renderShellWith({ windowable: true }, `/runs/${RUN.id}/report`);
    expect(await screen.findByTestId('time-brush')).toBeInTheDocument();
  });

  it('withholds it on the Summary, which answers a whole-run question', async () => {
    renderShellWith({ windowable: true }, `/runs/${RUN.id}`);
    // The paired positive: the Summary's own band is on screen, so an absent
    // brush is not an absent page.
    expect(await screen.findByRole('region', { name: 'Release decision' })).toBeInTheDocument();
    expect(screen.queryByTestId('time-brush')).not.toBeInTheDocument();
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

  it('withholds it on Logs, whose events are read whole', async () => {
    // `GET /v1/runs/{id}/events` takes no `from`/`to`, so a drag over the log
    // would change nothing.
    renderShellWith({ windowable: true, identity: { ...RUN, runnerJobId: 'job-1' } }, `/runs/${RUN.id}/logs`);
    await screen.findByRole('navigation', { name: /run sections/i });
    expect(screen.queryByTestId('time-brush')).not.toBeInTheDocument();
  });
});

/**
 * A RUN THAT CANNOT HONOUR A WINDOW STILL HAS A REPORT. A run ingested before
 * per-bucket histograms answers every windowed call with 400 WINDOW_UNAVAILABLE,
 * so offering it a brush would invite a drag the API then refuses; the sections
 * themselves are unaffected, and a Report with no time window must still be a
 * Report — the tab strip, and the outlet under it, intact. (`windowable: false`
 * is pinned beside the Summary's own cases above.)
 *
 * `undefined` is the same answer: `windowable` is optional in the contract, so
 * a server that predates the field is treated as unable.
 */
describe('RunShell — the Report of a run whose server predates `windowable`', () => {
  it('offers no time window rather than guessing the run can honour one', async () => {
    renderShellWith({ windowable: undefined }, `/runs/${RUN.id}/report`);
    expect(await screen.findByRole('navigation', { name: 'Run sections' })).toBeVisible();
    expect(screen.queryByTestId('time-brush')).toBeNull();
    // On the Report, so it is the `windowable` gate and not the section that
    // withheld it: the same props with `windowable: true` draw the brush.
    expect(screen.getByRole('link', { name: 'Report' })).toHaveAttribute('aria-current', 'page');
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
    renderShellWith({ identity: { ...RUN, activityMs: 62_136 }, windowable: true }, `/runs/${RUN.id}/report`);
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
 * narrowed and the Report keeps reading the same range. Dropping the control
 * silently would leave that reader looking at a tenth of a run with nothing
 * on screen admitting it.
 *
 * An implementation that simply hid the brush passes the first case below and
 * fails the second; one that also cleared the window passes both and fails the
 * third.
 */
describe('RunShell — the time brush on a narrow viewport', () => {
  // On the Report: it is the one section that draws the brush on a desktop, so
  // it is the one whose phone reader the notice is for.
  const windowed = `/runs/${RUN.id}/report?from=10000&to=30000`;

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

  it('does not announce a window over the Logs tab, which shows the whole log', async () => {
    useIsCompactMock.mockReturnValue(true);
    renderShellWith(
      { windowable: true, identity: { ...RUN, runnerJobId: 'job-1' } },
      `/runs/${RUN.id}/logs?from=10000&to=30000`,
    );
    await screen.findByRole('navigation', { name: /run sections/i });
    expect(screen.queryByTestId('compact-window-notice')).not.toBeInTheDocument();
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

  /** Nor over the Summary, which never sends a window: "Showing 10–30 s of
   *  this run" there would be a claim about a page that ignores it. */
  it('does not announce a window over the Summary, which shows the whole run', async () => {
    useIsCompactMock.mockReturnValue(true);
    renderShellWith({ windowable: true }, `/runs/${RUN.id}?from=10000&to=30000`);
    await screen.findByRole('region', { name: 'Release decision' });
    expect(screen.queryByTestId('compact-window-notice')).not.toBeInTheDocument();
  });

  /** An unwindowed run is not told about a control it is not being offered:
   *  the notice exists for the reader who followed a narrowed link. */
  it('renders nothing at all when no window is applied', async () => {
    useIsCompactMock.mockReturnValue(true);
    renderShellWith({ windowable: true }, `/runs/${RUN.id}/report`);
    await screen.findByRole('navigation', { name: /run sections/i });
    expect(screen.queryByTestId('compact-window-notice')).not.toBeInTheDocument();
    expect(screen.queryByTestId('time-brush')).not.toBeInTheDocument();
  });

  /** The notice states a window the data already carries; it has no use for
   *  the snapped one the brush would report, so a phone on a narrowed Report
   *  asks for no `/users` — the hardest case, since a window is in the URL. */
  it('fetches no /users on a phone, which has no brush to state a window for', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(new Response(JSON.stringify(EMPTY_USERS), { status: 200 })),
    );
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    useIsCompactMock.mockReturnValue(true);
    renderShellWith({ windowable: true }, windowed);
    // The paired positive: the phone's notice is on screen, so the absent
    // request is not an absent page.
    expect(await screen.findByTestId('compact-window-notice')).toBeInTheDocument();
    expect(fetchSpy.mock.calls.some((c) => String(c[0]).includes('/users'))).toBe(false);
    fetchSpy.mockRestore();
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

/**
 * ═══ ITEM 1 — AN OPEN EDITOR DOES NOT SURVIVE A CHANGE OF RUN ═══
 *
 * The `/runs/:runId` route is not keyed and `RunShell` does not remount
 * between runs (CLAUDE.md's live-state entry records the identical shape for
 * `useLiveRun`), so without `key={identity.id}` on `<RunNote>`, its
 * `editing`/`draft` state would survive a REPLACED identity — Back, or the
 * baseline note's "vs previous" link, landing on the same route shape with a
 * different run. `rerender`, not a second `render`: the defect is in the
 * TRANSITION between two mounts of one tree, which a fresh `render` per run
 * cannot exercise at all.
 */
describe('RunShell — an open note editor does not survive a change of run', () => {
  const NOTE_A: RunNoteValue = { text: 'note for run A', updatedAt: null, updatedBy: null };
  const NOTE_B: RunNoteValue = { text: 'note for run B', updatedAt: null, updatedBy: null };
  const RUN_A: RunResponse = { ...RUN, id: 'a1111111-1111-4111-8111-111111111111', note: NOTE_A };
  const RUN_B: RunResponse = { ...RUN, id: 'b2222222-2222-4222-8222-222222222222', note: NOTE_B };

  /** The same shape `renderShellWith` builds, but as an ELEMENT rather than a
   *  render call, so the same one can be handed to `rerender` — reusing one
   *  `QueryClient` across both, as the app does across a real navigation. */
  function shellTree(identity: RunResponse, client: QueryClient) {
    const status = identity.status;
    const props = {
      identity, status, verdict: identity.verdict, windowable: identity.windowable,
      terminal: TERMINAL_STATUSES.has(status),
      live: null, capReached: false, onRetry: () => {},
    };
    return (
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[`/runs/${identity.id}`]}>
          <Routes>
            <Route path="/runs/:runId" element={<RunShell {...props} />}>
              <Route index element={<div />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    );
  }

  it('shows the new run’s own note, with no leftover editor or draft from the old one', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { rerender } = render(shellTree(RUN_A, client));

    await userEvent.click(await screen.findByRole('button', { name: 'Edit note' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Run note' }), ' — a draft for A, never saved');

    // Same tree, a different run — a real navigation between two run pages,
    // not a second `render` of a fresh tree.
    rerender(shellTree(RUN_B, client));

    expect(await screen.findByTestId('run-note-text')).toHaveTextContent(NOTE_B.text);
    expect(screen.queryByRole('textbox', { name: 'Run note' })).not.toBeInTheDocument();
    expect(screen.queryByText(/draft for A/)).not.toBeInTheDocument();
    expect(screen.queryByText(NOTE_A.text)).not.toBeInTheDocument();
  });
});

/**
 * The shell is what decides — from the run's own identity — whether the tab
 * strip offers Logs. `RunTabs.test.tsx` hands the strip its answer; this is
 * the seam that computes it.
 */
describe('RunShell — the Logs tab follows the run’s runner job', () => {
  const JOB = '7d9b8c85-1111-4111-8111-111111111111';

  it('offers Logs for a run its runner job produced', () => {
    renderShellWith({ identity: { ...RUN, runnerJobId: JOB } });
    expect(screen.getByRole('link', { name: 'Logs' })).toHaveAttribute('href', `/runs/${RUN.id}/logs`);
  });

  it('offers none for a run no runner job produced, or one whose API predates the field', () => {
    renderShellWith({ identity: { ...RUN, runnerJobId: null } });
    expect(screen.queryByRole('link', { name: 'Logs' })).toBeNull();
    cleanup();
    renderShellWith({ identity: RUN });
    expect(screen.queryByRole('link', { name: 'Logs' })).toBeNull();
  });
});
