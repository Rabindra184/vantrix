import { useParams } from 'react-router-dom';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { TelemetryResponse } from '@perfportal/contracts';
import { EmptyState } from '../components/States';
import { telemetryQuery } from '../api/metrics';
import TelemetryCharts from '../charts/TelemetryCharts';
import { CLOCK_SKEW_WARN_MS } from './clockSkew';
import { formatDuration } from './format';
import { Payload, Undrawn, type Slot } from './payload';
import { useRunTerminal, useTimeDomainFromShell, useWindowFromShell } from './useRunWindow';
import DesktopOnly from './DesktopOnly';
import useIsCompact from '../useIsCompact';

/**
 * `/runs/:runId/load-generators`, a child under `RunShell` (design §3, §6) —
 * spec §7's six host-telemetry charts, one load generator at a time.
 *
 * ═══ NO ICON, NO DECORATIVE SVG IN ANY CHART FIGURE ═══
 * `Chart` renders its data table INSIDE the `<figure>`, and the e2e suite
 * proves a chart really drew by counting SVG elements within it —
 * `toHaveCount(1)` per chart. An icon makes the count wrong AND destroys the
 * invariant it rests on. `EmptyState`'s `InboxIcon` below is fine: it REPLACES
 * the six charts rather than nesting inside one, and renders a `div`, never a
 * `figure`.
 *
 * ═══ NO `uppercase` ON THE SECTION HEADING OR THE SELECT LABEL ═══
 * Playwright applies `text-transform` when computing an accessible name;
 * jsdom does not. A heading or label queried by name must not carry it.
 *
 * ═══ THE `run-time` GROUP IS THE WHOLE POINT ═══
 * Hovering any one of the six telemetry charts moves the pointer on the
 * other five at the same instant — the reason this tab exists rather than a
 * link out to Grafana. It works only because the endpoint returns the run's
 * own offsets at the run's own bucket width — see `TelemetryCharts.tsx`,
 * which actually assigns the group.
 *
 * ═══ THREE DIFFERENT "NOTHING TO SHOW", NOT ONE ═══
 * `available: false` means there is no telemetry to place on this run's own
 * elapsed axis — `toolStartedAt` is null, or nothing overlapped it — and gets
 * the one `EmptyState` below, with **no figure on the page**: six empty
 * charts would read as "measured and found idle", which is the one claim
 * `available` exists to rule out (see `TelemetryResponseSchema`'s own doc
 * comment). `hosts.length === 0` while `available` is true is a NARROWER
 * window over an otherwise-recorded run — `MetricsController.telemetry`
 * computes `available` from the whole series before filtering `hosts` to the
 * requested range — and gets six `Undrawn` charts explaining themselves
 * individually, the same pattern `GroupDetail` uses for a series a run
 * predates. A host with points gets the real six `<Chart>`s via
 * `TelemetryCharts`.
 *
 * ═══ `available: false` HAS TWO HONEST READINGS, AND ONLY ONE OF THEM IS
 * EVER FETCHED (Task 11, fix round — CRITICAL 1) ═══
 * `toolStartedAt` is null for EVERY non-terminal run — it is set from the
 * parsed report, which does not exist until the run finishes — so
 * `available: false` is the answer for a run still streaming as much as for
 * a finished one the agent genuinely never reported for. Those are different
 * facts: "wait, this arrives once the run finishes" versus "this run
 * finished and nothing was ever recorded". `terminal` (`useRunTerminal`) used
 * to decide only which sentence the `EmptyState` showed, AFTER letting the
 * query run either way — and `telemetryQuery` carries `staleTime: Infinity`
 * (`api/metrics.ts`), so the honest "wait" answer for a live run got fetched,
 * cached forever under `telemetryQueryKey`, and then silently relabelled as
 * the dishonest "nothing was ever recorded" once the run went terminal and
 * nothing re-fetched it (`invalidateLiveWrites` never touches this key — it
 * is not one of the three the socket writes). The `!terminal` branch below
 * now returns the "wait" `EmptyState` directly, and `enabled` carries
 * `terminal` too, so a live run's tab never asks `/telemetry` at all — there
 * is nothing for a later terminal transition to have left stale.
 */

const TELEMETRY_SLOTS: readonly Slot[] = [
  { id: 'telemetry-cpu', title: 'CPU usage' },
  { id: 'telemetry-memory', title: 'Memory usage' },
  { id: 'telemetry-bandwidth', title: 'Bandwidth' },
  { id: 'telemetry-connection-events', title: 'TCP connection events' },
  { id: 'telemetry-segment-events', title: 'TCP segment events' },
  { id: 'telemetry-tcp-states', title: 'Connections by state' },
];

const NO_SAMPLES_IN_WINDOW =
  'No telemetry samples fall within the selected time window for any load generator. Widen ' +
  "the range to see this run's host metrics.";

export default function RunTelemetry() {
  const { runId } = useParams<{ runId: string }>();
  // Gates BOTH the query's `enabled` and the early return below (CRITICAL 1):
  // telemetry is never fetched while live, and the live wording never comes
  // from a fetch at all — `available` would always read `false` for a
  // non-terminal run, and caching that under `staleTime: Infinity` is
  // exactly the bug this gate exists to prevent.
  const { terminal } = useRunTerminal(runId);
  const window = useWindowFromShell();
  // The same time domain the run's other tabs draw on (§22.5) — these six
  // charts share `run-time` with the shell's own brush.
  const domainMs = useTimeDomainFromShell();
  // §22.6: deep analysis is a desktop task. Gated on the QUERY as well as the
  // render, so a phone does not fetch a payload it has been told not to draw.
  const compact = useIsCompact();
  const [shown, setShown] = useState(false);
  // The reader's own pick, or `undefined` until they make one. Derived from
  // the payload at render time rather than synchronised with a `useEffect`:
  // `hosts.find(...) ?? hosts[0]!` below falls back to the first host on its
  // own the moment a payload arrives whose host list no longer contains the
  // selected name (a narrower window, a different run) — no effect needed to
  // notice the mismatch and no stale selection ever rendered.
  const [selectedHost, setSelectedHost] = useState<string | undefined>(undefined);

  // EVERY HOOK ABOVE THIS LINE RUNS ON EVERY RENDER, UNCONDITIONALLY.
  // `useQuery` used to sit AFTER the `compact && !shown` early return below,
  // which is a hook-order bug: a phone reader pressing "Show it anyway"
  // flips `shown` false -> true on the SAME mounted instance, so the render
  // that follows calls a hook (`useQuery`, and `selectedHost`'s `useState`)
  // that the previous render never reached — "Rendered more hooks than
  // during the previous render." `wanted` is what used to be implicit in
  // "the query is never even constructed while compact and not shown"; now
  // that construction is unconditional, `wanted` has to say so explicitly
  // through `enabled` instead. `terminal` joins it in `enabled` for a
  // different reason — see CRITICAL 1's note above `RunTelemetry`'s own
  // docstring: a non-terminal run's `available: false` must never be
  // fetched, because `staleTime: Infinity` would cache that honest "wait"
  // answer forever, past the moment the run actually finishes.
  const wanted = !compact || shown;
  const telemetry = useQuery({
    ...telemetryQuery(runId ?? '', window),
    enabled: runId !== undefined && wanted && terminal,
  });

  // NOT TERMINAL (CRITICAL 1 fix): the live wording, returned BEFORE the
  // query above is ever consulted — the same shape `RunTrends.tsx` uses for
  // its own `!terminal` return, and AHEAD OF THE COMPACT GATE BELOW for the
  // same reason that file states: this is a few sentences, not six ECharts
  // instances, so a phone reader is told the same thing a desktop is rather
  // than a SECOND withheld notice ("Show it anyway") for content that was
  // never coming this session regardless of viewport.
  if (!terminal) {
    return (
      <EmptyState
        // NOT the terminal branch's "No telemetry was recorded for this run."
        // That sentence is past tense and definitive, and this run has not
        // finished: the agent may be reporting right now. It reads as a
        // measurement of nothing over a run nobody has finished measuring —
        // and the body directly beneath it then walks the claim back, which
        // is worse than either sentence alone.
        //
        // The terminal branch keeps that wording, and must: it is pinned by
        // `RunTelemetry.test.tsx`'s "never reported" case and by
        // `run-telemetry.spec.ts`, which is the one sentence distinguishing
        // "never measured" from "measured and found idle". Only THIS branch
        // changes.
        title="Load generator telemetry is not available yet."
        body="Load generator telemetry appears once the run finishes — it is placed on the run's own elapsed axis, which needs the tool's start time from the parsed report."
      />
    );
  }

  if (compact && !shown) {
    return (
      <DesktopOnly compact what="Load-generator telemetry" onShow={() => setShown(true)}>
        {() => null}
      </DesktopOnly>
    );
  }

  return (
    <Payload query={telemetry} slots={TELEMETRY_SLOTS}>
      {(data) => {
        if (!data.available) {
          // Not an empty chart — that would read as an idle machine. This
          // exact phrase is load-bearing: Task 11's e2e suite matches
          // `/no telemetry was recorded/i` against it.
          //
          // ALWAYS THE TERMINAL SENTENCE HERE NOW (CRITICAL 1 fix). The
          // `!terminal` branch above already returned the "wait" wording for
          // a live run, so by the time this callback runs the run is
          // terminal and `available: false` really is the agent's own
          // silence — there is no ternary left to get wrong.
          return (
            <EmptyState
              title="No telemetry was recorded for this run."
              body="No load generator reported for this run's window."
            />
          );
        }

        const hosts = data.hosts;

        if (hosts.length === 0) {
          return (
            <section
              aria-labelledby="load-generators-heading"
              className="grid grid-cols-1 gap-6 2xl:grid-cols-2"
            >
              <h2 id="load-generators-heading" className="sr-only">
                Load generators
              </h2>
              {TELEMETRY_SLOTS.map((slot) => (
                <Undrawn key={slot.id} slot={slot} reason={NO_SAMPLES_IN_WINDOW} />
              ))}
            </section>
          );
        }

        const host = hosts.find((h) => h.host === selectedHost) ?? hosts[0]!;

        return (
          <div className="flex flex-col gap-4">
            {/* Hidden below two hosts: a single-generator run has nothing to
                choose between, and a control with one option is a control
                that does nothing. */}
            {hosts.length > 1 && (
              <div className="flex items-center gap-2">
                <label htmlFor="load-generator-host" className="shrink-0 text-[12px] text-muted">
                  Load generator
                </label>
                <select
                  id="load-generator-host"
                  value={host.host}
                  onChange={(event) => setSelectedHost(event.target.value)}
                  className="rounded border border-default bg-surface px-2 py-1 text-sm text-primary"
                >
                  {hosts.map((h) => (
                    <option key={h.host} value={h.host}>
                      {h.host}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {Math.abs(host.clockSkewMs) > CLOCK_SKEW_WARN_MS && (
              // `role="status"`, like `TimeBrush`'s applied-window line: this
              // is the page telling the reader every point below might be
              // shifted, without interrupting them the way `role="alert"`
              // would.
              <p
                role="status"
                className="rounded-lg border border-default bg-sunken px-3 py-2 text-[13px] text-muted"
              >
                {skewMessage(host)}
              </p>
            )}

            <TelemetryCharts host={host} domainMs={domainMs} />
          </div>
        );
      }}
    </Payload>
  );
}

/**
 * A large NEGATIVE `clockSkewMs` means the AGENT's clock is ahead of the
 * server's — `clockSkewMs` is `receivedAt - sampledAt` at its widest gap
 * (`packages/statistics/src/telemetry.ts`), and that comes out very negative
 * when the agent's own timestamp on a sample already reads later than the
 * moment the server receives it.
 */
function skewMessage(host: TelemetryResponse['hosts'][number]): string {
  const magnitude = formatDuration(Math.abs(host.clockSkewMs));
  const direction = host.clockSkewMs < 0 ? 'ahead of' : 'behind';
  return (
    `${host.host}'s clock reports samples roughly ${magnitude} ${direction} the server's, so ` +
    'its points on these charts may be misaligned by about that much against every other ' +
    "chart on this run's page."
  );
}
