import '@testing-library/jest-dom/vitest';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveDelta, SeriesResponse, UsersResponse } from '@perfportal/contracts';
import { errorsQueryKey, seriesQueryKey, usersQueryKey } from '../src/api/metrics';
import { BASE_BACKOFF_MS, MAX_BACKOFF_MS, backoffDelayMs, useLiveRun } from '../src/api/live';

const RUN_ID = '00000000-0000-4000-8000-000000000001';

/* ------------------------------------------------------------------ *
 * A minimal WebSocket double.
 *
 * `mock-socket` is not a dependency of this workspace, and jsdom 30's own
 * `WebSocket` (CLAUDE.md: "jsdom 30 pulls an undici…") makes a REAL network
 * connection rather than staying inside the test process — one layer further
 * down the same stack that warning is about. So `global.WebSocket` is
 * replaced outright with this class, which speaks only the surface `live.ts`
 * actually touches: `new WebSocket(url)`, `.close()`, and the three `on*`
 * handler properties `live.ts` assigns.
 *
 * OPENS ASYNCHRONOUSLY, via `setTimeout(…, 0)` rather than synchronously in
 * the constructor. A real WebSocket always opens asynchronously — that is
 * what lets a caller attach `onopen` AFTER `new WebSocket()` returns, before
 * any event can fire. `live.ts` relies on exactly that ordering (it assigns
 * `ws.onopen` right after constructing `ws`), so a synchronous fake would
 * make the open event fire into a not-yet-attached handler and silently miss
 * it. `setTimeout` rather than `queueMicrotask` so the SAME advance
 * (`vi.advanceTimersByTimeAsync`) drives it under fake timers as under real
 * ones — the reconnect test below needs fake timers for the backoff delay,
 * and a microtask untouched by `vi.useFakeTimers()` would open the socket a
 * tick before the test could observe the CONNECTING state at all.
 */
class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;

  readonly url: string;
  readyState: number = FakeSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    server.connections.push(this);
    setTimeout(() => {
      if (this.readyState !== FakeSocket.CONNECTING) return;
      this.readyState = FakeSocket.OPEN;
      this.onopen?.();
    }, 0);
  }

  send(): void {
    // The live gateway (Task 6) reads its resume cursor from the URL's query
    // string, never from a client frame — live.ts has nothing to send, and
    // this class exists only so `new WebSocket(url)` does not throw.
  }

  close(code = 1000): void {
    if (this.readyState === FakeSocket.CLOSED) return;
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.({ code });
  }

  /** Test-only: deliver a frame exactly as the gateway's `write()` does — a
   *  JSON string, never a pre-parsed object. */
  emit(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

const server = {
  connections: [] as FakeSocket[],
  reset(): void {
    server.connections = [];
  },
};

/** Flushes both the microtask queue and one macrotask turn, under whichever
 *  timer mode the current test is in. */
async function flush(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

function lastConnection(): FakeSocket {
  const socket = server.connections.at(-1);
  if (socket === undefined) throw new Error('useLiveRun test: expected a socket to have been opened');
  return socket;
}

/** Waits for the most recently opened socket to reach OPEN, then delivers
 *  `frame` on it — the shape the brief's own example calls `server.send`. */
async function send(frame: unknown): Promise<void> {
  await flush();
  const socket = lastConnection();
  expect(socket.readyState).toBe(FakeSocket.OPEN);
  act(() => socket.emit(frame));
}

function wrapperFor(client: QueryClient) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

/** The key a mounted chart actually subscribes to — see `liveSeriesKey` in
 *  live.ts for why this is not the bare `seriesQueryKey(...)` result. */
function liveSeriesCacheKey(runId: string) {
  return [...seriesQueryKey(runId, 'run', '', 'response_time'), null, null] as const;
}

function bucketFixture(
  startOffsetMs: number,
  overrides: Partial<LiveDelta['responseTime']['buckets'][number]> = {},
): LiveDelta['responseTime']['buckets'][number] {
  return {
    startOffsetMs,
    startedCount: 5,
    endedCount: 5,
    okCount: 4,
    koCount: 1,
    startedOkCount: 4,
    startedKoCount: 1,
    minMs: 10,
    maxMs: 500,
    meanMs: 120,
    percentiles: { p50: 100 },
    percentilesOk: { p50: 95 },
    percentilesKo: { p50: 500 },
    ...overrides,
  };
}

function deltaFixture(overrides: Partial<LiveDelta> = {}): LiveDelta {
  return {
    runId: RUN_ID,
    seq: 0,
    summary: {
      count: 10,
      okCount: 9,
      koCount: 1,
      errorRate: 0.1,
      percentiles: { p50: 100, p95: 400 },
      maxUsers: 5,
      durationMs: 12_000,
    },
    responseTime: {
      widthMs: 1000,
      replaces: true,
      buckets: [bucketFixture(0), bucketFixture(1000)],
    },
    users: {
      widthMs: 1000,
      buckets: [
        { scenario: 'Checkout', startOffsetMs: 0, started: 3, ended: 1, active: 3 },
        { scenario: 'Browse', startOffsetMs: 0, started: 2, ended: 0, active: 2 },
      ],
    },
    errors: { rows: [{ message: 'timeout', count: 1 }, { message: null, count: 3 }] },
    ...overrides,
  };
}

beforeEach(() => {
  server.reset();
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('useLiveRun', () => {
  it('writes a delta into the cache under the keys the REST queries use', async () => {
    const client = new QueryClient();
    renderHook(() => useLiveRun(RUN_ID, true), { wrapper: wrapperFor(client) });

    const delta = deltaFixture();
    await send({ type: 'snapshot', delta, partial: false, lastSeq: 0 });

    const series = client.getQueryData<SeriesResponse>(liveSeriesCacheKey(RUN_ID));
    expect(series).toBeDefined();
    // Computed from the payload just sent, never written down twice: a live
    // bucket and a persisted `SeriesBucket` are field-for-field the same
    // shape (live-delta.ts's own docstring), so the merge should carry it
    // through with no transform at all.
    expect(series?.buckets).toEqual(delta.responseTime.buckets);
    expect(series?.bucketWidthMs).toBe(delta.responseTime.widthMs);

    const errors = client.getQueryData(errorsQueryKey(RUN_ID));
    expect(errors).toBeDefined();
    expect(errors).toEqual({ runId: RUN_ID, errors: delta.errors.rows });

    const users = client.getQueryData<UsersResponse>(usersQueryKey(RUN_ID));
    expect(users).toBeDefined();
    // Two scenarios in the fixture, both starting at offset 0 — the total is
    // their SUM at that offset, matching Gatling's own "All users" convention
    // (UsersResponseSchema's docstring). Derived from the fixture buckets
    // rather than written down, so this keeps proving the sum regardless of
    // what values the fixture happens to carry.
    const fixtureBuckets = delta.users.buckets;
    expect(users?.scenarios.map((s) => s.scenario).sort()).toEqual(['Browse', 'Checkout']);
    expect(users?.total).toEqual([
      {
        startOffsetMs: 0,
        started: fixtureBuckets.reduce((n, b) => n + b.started, 0),
        ended: fixtureBuckets.reduce((n, b) => n + b.ended, 0),
        maxConcurrent: fixtureBuckets.reduce((n, b) => n + b.active, 0),
      },
    ]);
    // Both scenarios' buckets carry their OWN started/ended through
    // unchanged, not zeroed — the defect this fix closes.
    for (const scenario of users?.scenarios ?? []) {
      for (const b of scenario.buckets) {
        const source = fixtureBuckets.find(
          (f) => f.scenario === scenario.scenario && f.startOffsetMs === b.startOffsetMs,
        );
        expect(b.started).toBe(source?.started);
        expect(b.ended).toBe(source?.ended);
      }
    }
  });

  // CLAUDE.md §22.6: a phone holding an open socket to draw nothing is
  // exactly the "degrading badly" the compact rule exists to prevent.
  it('never opens the socket when disabled', () => {
    renderHook(() => useLiveRun(RUN_ID, false), { wrapper: wrapperFor(new QueryClient()) });
    expect(server.connections).toHaveLength(0);
  });

  it('upserts response-time buckets by startOffsetMs rather than appending', async () => {
    const client = new QueryClient();
    renderHook(() => useLiveRun(RUN_ID, true), { wrapper: wrapperFor(client) });

    const seed = deltaFixture({ seq: 0 });
    await send({ type: 'snapshot', delta: seed, partial: false, lastSeq: 0 });

    // The frontier bucket (offset 1000) is RE-SENT, corrected, alongside a
    // genuinely new one (offset 2000) — the "still filling" case the upsert
    // rule exists for.
    const correctedBucket = bucketFixture(1000, { okCount: 40, endedCount: 41 });
    const newBucket = bucketFixture(2000);
    const next = deltaFixture({
      seq: 1,
      responseTime: { widthMs: 1000, replaces: false, buckets: [correctedBucket, newBucket] },
    });
    await send({ type: 'delta', delta: next });

    const series = client.getQueryData<SeriesResponse>(liveSeriesCacheKey(RUN_ID));
    // Three offsets, not four: 0 (untouched from the seed), 1000 (corrected,
    // not duplicated) and 2000 (new) — an append would have left two rows at
    // offset 1000.
    expect(series?.buckets.map((b) => b.startOffsetMs)).toEqual([0, 1000, 2000]);
    const at1000 = series?.buckets.find((b) => b.startOffsetMs === 1000);
    // The CORRECTED values win, not the seed's partial ones.
    expect(at1000).toEqual(correctedBucket);
  });

  it('a replaces:true envelope discards the old series outright, not just the overlap', async () => {
    const client = new QueryClient();
    renderHook(() => useLiveRun(RUN_ID, true), { wrapper: wrapperFor(client) });

    const seed = deltaFixture({
      seq: 0,
      responseTime: { widthMs: 1000, replaces: true, buckets: [bucketFixture(0), bucketFixture(1000)] },
    });
    await send({ type: 'snapshot', delta: seed, partial: false, lastSeq: 0 });

    // The engine halved its resolution: every old offset is meaningless
    // against the new 2000ms width, so this delta carries ONE bucket at a
    // brand-new offset and says `replaces: true`.
    const coalesced = bucketFixture(4000);
    const next = deltaFixture({
      seq: 1,
      responseTime: { widthMs: 2000, replaces: true, buckets: [coalesced] },
    });
    await send({ type: 'delta', delta: next });

    const series = client.getQueryData<SeriesResponse>(liveSeriesCacheKey(RUN_ID));
    // Merging instead of replacing would leave offsets 0 and 1000 sitting
    // beside 4000, at the OLD width — three buckets, not one, and the chart
    // would silently double its count without anything throwing.
    expect(series?.buckets).toEqual([coalesced]);
    expect(series?.bucketWidthMs).toBe(2000);
  });

  it('assigns users and errors whole each tick, never merging with what came before', async () => {
    const client = new QueryClient();
    renderHook(() => useLiveRun(RUN_ID, true), { wrapper: wrapperFor(client) });

    const seed = deltaFixture({
      seq: 0,
      users: {
        widthMs: 1000,
        buckets: [
          { scenario: 'Checkout', startOffsetMs: 0, started: 3, ended: 0, active: 3 },
          { scenario: 'Browse', startOffsetMs: 0, started: 2, ended: 0, active: 2 },
        ],
      },
      errors: { rows: [{ message: 'timeout', count: 1 }, { message: 'reset', count: 2 }] },
    });
    await send({ type: 'snapshot', delta: seed, partial: false, lastSeq: 0 });

    // `Browse` has ENDED and 'reset' has stopped occurring — a real tick
    // sends only what is still true.
    const next = deltaFixture({
      seq: 1,
      users: {
        widthMs: 1000,
        buckets: [{ scenario: 'Checkout', startOffsetMs: 1000, started: 1, ended: 0, active: 4 }],
      },
      errors: { rows: [{ message: 'timeout', count: 2 }] },
    });
    await send({ type: 'delta', delta: next });

    const users = client.getQueryData<UsersResponse>(usersQueryKey(RUN_ID));
    // A merge would keep `Browse`'s last bucket forever. An assign does not.
    expect(users?.scenarios.map((s) => s.scenario)).toEqual(['Checkout']);

    const errors = client.getQueryData(errorsQueryKey(RUN_ID));
    // A merge would make 'reset' immortal at its last-seen count.
    expect(errors).toEqual({ runId: RUN_ID, errors: [{ message: 'timeout', count: 2 }] });
  });

  it('reports connected once the socket opens, and not once it closes', async () => {
    const client = new QueryClient();
    const { result } = renderHook(() => useLiveRun(RUN_ID, true), { wrapper: wrapperFor(client) });
    expect(result.current.connected).toBe(false);

    await flush();
    expect(result.current.connected).toBe(true);

    act(() => lastConnection().close());
    expect(result.current.connected).toBe(false);
  });

  it('keeps the last delta after the socket closes, for the frozen view', async () => {
    const client = new QueryClient();
    const { result } = renderHook(() => useLiveRun(RUN_ID, true), { wrapper: wrapperFor(client) });

    const delta = deltaFixture();
    await send({ type: 'snapshot', delta, partial: false, lastSeq: 0 });
    expect(result.current.lastDelta).toEqual(delta);

    act(() => lastConnection().close());
    // The socket is gone, but the last thing it said is still true: Task 8's
    // frozen view (design §4.4, "freeze, do not blank") reads this after
    // close, whether the run just ended or the compact flag just flipped.
    expect(result.current.connected).toBe(false);
    expect(result.current.lastDelta).toEqual(delta);
  });

  it('closes the socket and never reconnects once disabled/unmounted', async () => {
    const client = new QueryClient();
    const { unmount } = renderHook(() => useLiveRun(RUN_ID, true), { wrapper: wrapperFor(client) });
    await flush();
    const socket = lastConnection();

    unmount();
    expect(socket.readyState).toBe(FakeSocket.CLOSED);

    // Advancing well past the maximum possible backoff proves this was a
    // stopped reconnect loop, not merely one that had not fired yet.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MAX_BACKOFF_MS + 1);
    });
    expect(server.connections).toHaveLength(1);
  });

  it('reconnects using the SNAPSHOT FRAME lastSeq, never a delta.seq', async () => {
    const client = new QueryClient();
    renderHook(() => useLiveRun(RUN_ID, true), { wrapper: wrapperFor(client) });
    await flush();

    const first = lastConnection();
    // A fresh connect sends no cursor at all.
    expect(first.url).not.toContain('lastSeq');

    // Deliberately DIFFERENT from `delta.seq` (5) — exactly the shape
    // live.gateway.ts's own docstring warns about: the producer stamps a
    // snapshot with the seq of the delta it does NOT yet contain, so the
    // resume value the client must remember is the FRAME's `lastSeq` (7),
    // not the delta's own `seq`.
    const delta = deltaFixture({ seq: 5 });
    act(() => first.emit({ type: 'snapshot', delta, partial: false, lastSeq: 7 }));

    act(() => first.close());
    // The (jittered) backoff delay is bounded by MAX_BACKOFF_MS; advancing
    // past it guarantees the reconnect attempt has fired regardless of the
    // random draw.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MAX_BACKOFF_MS + 1);
    });

    const second = lastConnection();
    expect(second).not.toBe(first);
    expect(second.url).toContain('lastSeq=7');
    expect(second.url).not.toContain('lastSeq=5');
  });

  it('resumes from the latest delta.seq once one has arrived after the snapshot', async () => {
    const client = new QueryClient();
    renderHook(() => useLiveRun(RUN_ID, true), { wrapper: wrapperFor(client) });
    await flush();
    const first = lastConnection();

    await send({ type: 'snapshot', delta: deltaFixture({ seq: 5 }), partial: false, lastSeq: 7 });
    // An ordinary delta frame's resume value IS its own `seq` — unlike the
    // snapshot frame, there is no producer-side off-by-one here.
    act(() => first.emit({ type: 'delta', delta: deltaFixture({ seq: 8 }) }));

    act(() => first.close());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MAX_BACKOFF_MS + 1);
    });

    expect(lastConnection().url).toContain('lastSeq=8');
  });

  it('ignores a frame that fails to validate, rather than throwing', async () => {
    const client = new QueryClient();
    const { result } = renderHook(() => useLiveRun(RUN_ID, true), { wrapper: wrapperFor(client) });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await flush();
    expect(() => act(() => lastConnection().emit({ type: 'snapshot', delta: { nonsense: true } }))).not.toThrow();

    expect(result.current.lastDelta).toBeNull();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

describe('backoffDelayMs', () => {
  it('grows exponentially from BASE_BACKOFF_MS, capped at MAX_BACKOFF_MS', () => {
    // `random` pinned to 1 (the top of "full jitter"'s draw range) isolates
    // the exponential/cap shape from the jitter itself.
    expect(backoffDelayMs(0, () => 1)).toBe(BASE_BACKOFF_MS);
    expect(backoffDelayMs(1, () => 1)).toBe(BASE_BACKOFF_MS * 2);
    expect(backoffDelayMs(2, () => 1)).toBe(BASE_BACKOFF_MS * 4);
    expect(backoffDelayMs(10, () => 1)).toBe(MAX_BACKOFF_MS);
  });

  it('draws FULL jitter — a uniform pick across [0, capped], not a band around it', () => {
    expect(backoffDelayMs(3, () => 0)).toBe(0);
    expect(backoffDelayMs(3, () => 0.5)).toBe(BASE_BACKOFF_MS * 8 * 0.5);
  });
});
