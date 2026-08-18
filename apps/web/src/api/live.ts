import { useEffect, useState } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import {
  LiveDeltaSchema,
  type ErrorsResponse,
  type LiveDelta,
  type SeriesResponse,
  type UsersResponse,
} from '@perfportal/contracts';
import { z } from 'zod';
import { errorsQueryKey, seriesQueryKey, usersQueryKey } from './metrics';

/**
 * `useLiveRun(runId, enabled)` — the browser side of the socket Task 6 built.
 *
 * It opens `GET /v1/runs/:id/live` when `enabled`, applies every frame to the
 * React Query cache under the SAME keys the REST metric queries use, and
 * reconnects with backoff on any RETRYABLE close — never on `CLOSE_UNAUTHORIZED`
 * (4401), which `LiveRunState.unauthorized` surfaces instead of silently
 * retrying forever. The charts are never told any of this happened:
 * `RunChartsTab`/`RunOverviewTab`/`RunErrorsTab` and everything they render
 * are unmodified by this file, and read whatever is in the cache regardless
 * of whether it arrived over REST or over this socket (design part 1 §4,
 * part 2b §4.1).
 *
 * `statsQueryKey` (`./metrics.ts`) is deliberately NEVER written here. A live
 * delta's `summary` has `count`/`okCount`/`koCount`/`errorRate`/`percentiles`
 * — five of the nine fields a `StatRow` needs — and no `minMs`/`maxMs`/
 * `meanMs`/`stddevMs`/`throughputRps`, and no source for `StatsResponse`'s
 * top-level `indicators`/`bounds` at all: those are folded from a histogram
 * against project-configured bounds neither the wire nor the browser has.
 * `RunStats`'s own docstring states the rule this file follows instead:
 * "null, not zeroed tiles, when the payload carries no run-scope row … six
 * tiles reading 0/0.00%/— above [the table] would assert measurements nobody
 * took." Writing a fabricated `StatRow` with invented zeros would be exactly
 * that assertion. `/stats` is left to its own REST fetch, which honestly
 * returns empty rows for a running run (no `RunStat` rows exist until the
 * parse pipeline runs) and resolves for real once the run completes.
 */

/**
 * The gateway's two frame shapes (`apps/api/src/live/live.gateway.ts`),
 * validated against the SAME `LiveDeltaSchema` the server built the payload
 * from — `apiFetch`'s convention for a REST response (`./fetch.ts`), carried
 * across to a socket frame for the same reason: client and server share one
 * definition of the shape, and a frame this schema rejects is a protocol
 * bug, not data to render around.
 */
const SnapshotFrameSchema = z.object({
  type: z.literal('snapshot'),
  delta: LiveDeltaSchema,
  partial: z.boolean(),
  lastSeq: z.number().int(),
});
const DeltaFrameSchema = z.object({
  type: z.literal('delta'),
  delta: LiveDeltaSchema,
});
type LiveFrame = z.infer<typeof SnapshotFrameSchema> | z.infer<typeof DeltaFrameSchema>;

/**
 * Reconnect backoff: exponential, capped, FULL jitter — a uniform draw across
 * `[0, capped]`, not a narrower +/-50% wobble around it. Full jitter is what
 * actually decorrelates a fleet of clients that all dropped on the same
 * server hiccup; a narrower band leaves them still roughly synchronized and
 * re-arriving in the same clump. `random` is a parameter so the reconnect
 * test can pin specific draws instead of reading real entropy.
 */
export const BASE_BACKOFF_MS = 1_000;
export const MAX_BACKOFF_MS = 30_000;

export function backoffDelayMs(attempt: number, random: () => number = Math.random): number {
  const capped = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** attempt);
  return random() * capped;
}

/**
 * The resume query parameter's name — see `RESUME_PARAM` in
 * `live.gateway.ts`. Duplicated rather than imported: apps/web has no
 * dependency on apps/api, and crossing that boundary for one string would
 * cost more than the string being written twice.
 */
const RESUME_PARAM = 'lastSeq';

/**
 * The gateway's close code for "not authenticated, not a member, or not this
 * org's run" — see `CLOSE_UNAUTHORIZED` in `live.gateway.ts`. Duplicated for
 * the same reason `RESUME_PARAM` is: apps/web does not depend on apps/api.
 *
 * This is the ONE close code `useLiveRun` treats specially. It is a
 * permanent condition — reconnecting cannot fix who the caller is — so
 * scheduling a reconnect for it would retry the same refusal forever, every
 * ~30s, for as long as the tab stays open, and never tell the caller that
 * access rather than connectivity is the problem.
 */
const CLOSE_UNAUTHORIZED = 4401;

/**
 * `?lastSeq=N` is appended ONLY when `lastSeq` is non-null — a fresh connect
 * sends nothing, exactly as `live.gateway.ts`'s own docstring expects
 * ("fresh connects, which send nothing, are the common case"). `lastSeq` is
 * never the caller's guess: see `useLiveRun`'s own comment on where it comes
 * from.
 */
function liveUrl(runId: string, lastSeq: number | null): string {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  const path = `/v1/runs/${encodeURIComponent(runId)}/live`;
  const query = lastSeq === null ? '' : `?${RESUME_PARAM}=${lastSeq}`;
  return `${scheme}://${location.host}${path}${query}`;
}

/**
 * A frame that fails to parse or fails `LiveDeltaSchema` is skipped rather
 * than thrown: the server and this module are built against the identical
 * schema, so a mismatch is a real protocol bug, but a socket streaming for
 * the length of a load test must not go down over one bad message when the
 * alternative is a single missed delta, self-corrected by the next tick five
 * seconds later.
 */
function parseFrame(raw: unknown): LiveFrame | null {
  if (typeof raw !== 'string') return null;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const snapshot = SnapshotFrameSchema.safeParse(json);
  if (snapshot.success) return snapshot.data;
  const delta = DeltaFrameSchema.safeParse(json);
  if (delta.success) return delta.data;
  console.error('useLiveRun: received a frame that does not match the wire protocol', json);
  return null;
}

/**
 * A freshly-initialised run-scope response-time series, carrying every field
 * `SeriesResponse` needs beyond what a live envelope has:
 *
 * `scope`/`name`/`family` are fixed at `'run'`/`''`/`'response_time'` because
 * `LiveResponseTimeSchema` covers only the run-scope series (the same
 * per-endpoint-cardinality argument part 2b §1.3 makes for `errors`).
 * `startedSplitAvailable: true` because `LiveSeriesBucketSchema`'s
 * `startedOkCount`/`startedKoCount` are ALWAYS numbers, never the `null` a
 * pre-migration persisted row can carry (see that schema's own docstring).
 * `groupSeriesAvailable: false` because there is no live group-scope data at
 * all. `window: null` because a live view is never windowed — the domain
 * GROWS with the run instead (`useTimeDomainFromShell`).
 */
function emptySeries(runId: string): SeriesResponse {
  return {
    runId,
    scope: 'run',
    name: '',
    family: 'response_time',
    bucketWidthMs: 1000,
    startedSplitAvailable: true,
    groupSeriesAvailable: false,
    window: null,
    buckets: [],
  };
}

/**
 * TWO RULES, AND THE SECOND ONE IS WHY `replaces` IS ON THE WIRE.
 *
 * Buckets are upserted BY `startOffsetMs`, never appended: the newest bucket
 * is still filling when it is first published, and the producer deliberately
 * re-sends a lookback window so those partial buckets get corrected.
 * Appending would draw every re-sent bucket twice.
 *
 * A `replaces: true` envelope REPLACES the series outright. `BucketSeries`
 * halves its resolution in place once a run hits its bucket cap, rewriting
 * every offset — so merging a replacement leaves the old width's buckets
 * sitting beside the new width's, at offsets that no longer mean the same
 * thing. Nothing throws; the chart just doubles its bucket count and the
 * rates halve.
 */
function mergeResponseTime(
  runId: string,
  prev: SeriesResponse | undefined,
  envelope: LiveDelta['responseTime'],
): SeriesResponse {
  const base = envelope.replaces || prev === undefined ? [] : prev.buckets;
  const byOffset = new Map(base.map((b) => [b.startOffsetMs, b]));
  // `LiveSeriesBucketSchema` and `SeriesBucketSchema` are the SAME shape,
  // field for field (live-delta.ts's own docstring) — so a live bucket is
  // pushed onto the REST series with no transform at all.
  for (const b of envelope.buckets) byOffset.set(b.startOffsetMs, b);
  return {
    ...(prev ?? emptySeries(runId)),
    bucketWidthMs: envelope.widthMs,
    buckets: [...byOffset.values()].sort((a, b) => a.startOffsetMs - b.startOffsetMs),
  };
}

type UserBucket = UsersResponse['scenarios'][number]['buckets'][number];

/**
 * `LiveUserBucketSchema` now carries `started`/`ended` straight from the
 * source `UserBucket` (`packages/statistics/src/users.ts`), alongside
 * `active` (`= b.maxConcurrent`, `apps/worker/src/live/delta.ts`) — the
 * engine already computes all three every tick, so this is a field-for-field
 * copy, not a transform. `toConcurrentUsers` (fed by `maxConcurrent`) and
 * `toUserStartRate` (fed by `started`) are therefore both live and correct;
 * neither reads a fabricated zero for a measurement the wire never sent.
 */
function usersResponseFrom(runId: string, envelope: LiveDelta['users']): UsersResponse {
  const byScenario = new Map<string, UserBucket[]>();
  // Per-scenario counts SUMMED at each offset, matching how `maxConcurrent`
  // is already totalled below — `started`/`ended` are ordinary per-tick
  // counts, so summing them across concurrently-running scenarios is exactly
  // as valid as summing concurrency, with none of the max-of-sums caveat
  // that applies only to a peak.
  const totalByOffset = new Map<number, { started: number; ended: number; maxConcurrent: number }>();

  for (const b of envelope.buckets) {
    const buckets = byScenario.get(b.scenario) ?? [];
    buckets.push({ startOffsetMs: b.startOffsetMs, started: b.started, ended: b.ended, maxConcurrent: b.active });
    byScenario.set(b.scenario, buckets);
    const prior = totalByOffset.get(b.startOffsetMs) ?? { started: 0, ended: 0, maxConcurrent: 0 };
    totalByOffset.set(b.startOffsetMs, {
      started: prior.started + b.started,
      ended: prior.ended + b.ended,
      maxConcurrent: prior.maxConcurrent + b.active,
    });
  }

  const scenarios = [...byScenario.entries()].map(([scenario, buckets]) => ({
    scenario,
    buckets: buckets.sort((a, c) => a.startOffsetMs - c.startOffsetMs),
  }));

  // Per-scenario PEAKS SUMMED at each offset — the same rule `UsersResponse`'s
  // own docstring states ("Gatling's own 'All users' series is exactly this
  // sum") and the fold owner already applies for `summary.maxUsers`
  // (`apps/worker/src/live/delta.ts`). Never max-of-sums.
  const total = [...totalByOffset.entries()]
    .sort(([a], [c]) => a - c)
    .map(([startOffsetMs, agg]) => ({ startOffsetMs, ...agg }));

  return { runId, window: null, scenarios, total };
}

/** `LiveErrorRowSchema` and `ErrorsResponseSchema`'s row are the same two
 *  fields, so this is an assignment, not a transform. */
function errorsResponseFrom(runId: string, envelope: LiveDelta['errors']): ErrorsResponse {
  return { runId, errors: envelope.rows };
}

/**
 * `seriesQueryKey` (`./metrics.ts`) does NOT fold a window into itself the
 * way `usersQueryKey`/`errorsQueryKey` do — `seriesQuery` appends
 * `window?.fromMs ?? null, window?.toMs ?? null` EXTERNALLY, so the key a
 * mounted chart actually subscribes to (`RunChartsTab`, `RunOverviewTab`'s
 * sparkline) is eight elements, not six. A live view is never windowed — the
 * domain grows with the run instead of being narrowed — so the two trailing
 * nulls below are exactly what `seriesQuery(id, 'run', '', 'response_time',
 * null).queryKey` would produce, written out directly rather than importing
 * `seriesQuery` for a `queryFn` this file never calls.
 */
function liveSeriesKey(runId: string) {
  return [...seriesQueryKey(runId, 'run', '', 'response_time'), null, null] as const;
}

function applyDelta(queryClient: QueryClient, runId: string, delta: LiveDelta): void {
  queryClient.setQueryData<SeriesResponse>(liveSeriesKey(runId), (prev) =>
    mergeResponseTime(runId, prev, delta.responseTime));
  // `users` and `errors` are sent WHOLE every tick — ASSIGN, never merge. A
  // merge would let an ended scenario keep its last bucket forever, and an
  // error row that stopped occurring immortal.
  queryClient.setQueryData<UsersResponse>(usersQueryKey(runId), usersResponseFrom(runId, delta.users));
  queryClient.setQueryData<ErrorsResponse>(errorsQueryKey(runId), errorsResponseFrom(runId, delta.errors));
}

export interface LiveRunState {
  readonly connected: boolean;
  readonly lastDelta: LiveDelta | null;
  /**
   * True once the gateway has refused this run with `CLOSE_UNAUTHORIZED`
   * (4401) — the session is invalid, or the run belongs to another org.
   * Permanent for the life of this hook instance: once set, `useLiveRun`
   * stops reconnecting, because the condition a reconnect would be retrying
   * is WHO is asking, not whether the socket is up. A caller checks this to
   * tell "still trying to connect" (`connected: false`, this `false`) apart
   * from "will not connect, and retrying will not help" (this `true`).
   */
  readonly unauthorized: boolean;
}

/**
 * `enabled` is the CALLER's decision (`run.status === 'running' &&
 * !useIsCompact()`, design part 2b §4.1) — this hook only obeys it, so it
 * carries no opinion of its own about compactness or run status and can be
 * unit-tested without either.
 */
export function useLiveRun(runId: string, enabled: boolean): LiveRunState {
  const queryClient = useQueryClient();
  const [connected, setConnected] = useState(false);
  const [lastDelta, setLastDelta] = useState<LiveDelta | null>(null);
  const [unauthorized, setUnauthorized] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    // A fresh effect run (a new runId, or re-enabling after the caller
    // turned this off) starts a fresh access decision — carrying a STALE
    // `true` over from a previous runId would permanently withhold a run
    // this hook has not even asked the gateway about yet.
    setUnauthorized(false);

    let cancelled = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    // THE RESUME POINT. Set from the snapshot frame's OWN `lastSeq`, then
    // from each delta's own `seq` as frames arrive — NEVER derived any other
    // way. The producer stamps a snapshot with the seq of the delta it does
    // NOT yet contain (`live.gateway.ts`), so echoing a delta's `seq` back as
    // `?lastSeq=` would ask the server to skip precisely the delta the seed
    // is missing: a silent, permanent hole in the chart.
    let lastSeq: number | null = null;

    const connect = (): void => {
      if (cancelled) return;
      const ws = new WebSocket(liveUrl(runId, lastSeq));
      socket = ws;

      ws.onopen = () => {
        if (cancelled) return;
        attempt = 0;
        setConnected(true);
      };

      ws.onmessage = (event) => {
        if (cancelled) return;
        const frame = parseFrame(event.data as unknown);
        if (frame === null) return;
        lastSeq = frame.type === 'snapshot' ? frame.lastSeq : frame.delta.seq;
        applyDelta(queryClient, runId, frame.delta);
        setLastDelta(frame.delta);
      };

      // No `onerror` handler: a browser `WebSocket` that fails to open, or
      // that drops mid-stream, always fires `close` too (the WHATWG "fail
      // the WebSocket connection" algorithm fires both), so `close` is the
      // one place reconnection needs to live — an `error` with nothing
      // listening is silently dropped by the platform, not thrown.
      ws.onclose = (event) => {
        socket = null;
        if (cancelled) return;
        setConnected(false);
        // CLOSE_UNAUTHORIZED is permanent — see LiveRunState.unauthorized's
        // own comment. Every other close code (a dropped connection, a
        // restarting pod, CLOSE_TOO_FAR_BEHIND) is retryable, so it alone
        // skips the backoff schedule below instead of joining it.
        if (event.code === CLOSE_UNAUTHORIZED) {
          setUnauthorized(true);
          return;
        }
        const delay = backoffDelayMs(attempt);
        attempt += 1;
        reconnectTimer = setTimeout(connect, delay);
      };
    };

    connect();

    return () => {
      // ORDER MATTERS: `cancelled` flips BEFORE `close()` runs, so the
      // `onclose` this triggers sees it and skips scheduling a reconnect —
      // otherwise an intentional teardown would immediately reopen a socket
      // nobody asked for.
      cancelled = true;
      if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
      socket?.close();
      setConnected(false);
      // `lastDelta` is deliberately NOT cleared here. Task 8's frozen view
      // (design §4.4, "freeze, do not blank") reads it after the socket has
      // closed — on the compact flag flipping mid-session (§22.6) as much as
      // on the run ending — so clearing it here would blank the dashboard on
      // the one transition that must not lose what is already on screen.
    };
  }, [runId, enabled, queryClient]);

  return { connected, lastDelta, unauthorized };
}
