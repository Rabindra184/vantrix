import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { TelemetryResponse } from '@perfportal/contracts';
import { EmptyState } from '../components/States';
import { telemetryQuery } from '../api/metrics';
import TelemetryCharts from '../charts/TelemetryCharts';
import { CLOCK_SKEW_WARN_MS } from './clockSkew';
import { formatDuration } from './format';
import { Payload, Undrawn, type Slot } from './payload';
import { useWindowFromShell } from './useRunWindow';

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
 * Hovering a response-time chart moves the pointer on generator CPU at the
 * same instant. That is the reason this lives on the run's page rather than in
 * Grafana, and it works only because the endpoint returns the run's own
 * offsets at the run's own bucket width — see `TelemetryCharts.tsx`, which
 * actually assigns the group.
 *
 * ═══ THREE DIFFERENT "NOTHING TO SHOW", NOT ONE ═══
 * `available: false` means the agent never reported for this run's window at
 * all — `toolStartedAt` is null, or nothing overlapped it — and gets the one
 * `EmptyState` below, with **no figure on the page**: six empty charts would
 * read as "measured and found idle", which is the one claim `available`
 * exists to rule out (see `TelemetryResponseSchema`'s own doc comment).
 * `hosts.length === 0` while `available` is true is a NARROWER window over an
 * otherwise-recorded run — `MetricsController.telemetry` computes `available`
 * from the whole series before filtering `hosts` to the requested range — and
 * gets six `Undrawn` charts explaining themselves individually, the same
 * pattern `GroupDetail` uses for a series a run predates. A host with points
 * gets the real six `<Chart>`s via `TelemetryCharts`.
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
  const window = useWindowFromShell();
  const telemetry = useQuery({
    ...telemetryQuery(runId ?? '', window),
    enabled: runId !== undefined,
  });

  // The reader's own pick, or `undefined` until they make one. Derived from
  // the payload at render time rather than synchronised with a `useEffect`:
  // `hosts.find(...) ?? hosts[0]!` below falls back to the first host on its
  // own the moment a payload arrives whose host list no longer contains the
  // selected name (a narrower window, a different run) — no effect needed to
  // notice the mismatch and no stale selection ever rendered.
  const [selectedHost, setSelectedHost] = useState<string | undefined>(undefined);

  return (
    <Payload query={telemetry} slots={TELEMETRY_SLOTS}>
      {(data) => {
        if (!data.available) {
          // Not an empty chart — that would read as an idle machine. This
          // exact phrase is load-bearing: Task 11's e2e suite matches
          // `/no telemetry was recorded/i` against it.
          return (
            <EmptyState
              title="No telemetry was recorded for this run."
              body="The load-generator agent has to be running on the machines driving this run for these charts to have anything to show."
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

            <TelemetryCharts host={host} />
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
