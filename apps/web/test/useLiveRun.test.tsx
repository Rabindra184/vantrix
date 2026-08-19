import '@testing-library/jest-dom/vitest';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveDelta, SeriesResponse, UsersResponse } from '@perfportal/contracts';
import { errorsQueryKey, seriesQueryKey, usersQuery, usersQueryKey } from '../src/api/metrics';
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
    sla: { evaluated: 0, breaching: [] },
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

  it('does not reconnect after a 4401 close, and surfaces it as unauthorized', async () => {
    const client = new QueryClient();
    const { result } = renderHook(() => useLiveRun(RUN_ID, true), { wrapper: wrapperFor(client) });
    await flush();
    expect(result.current.unauthorized).toBe(false);

    // CLOSE_UNAUTHORIZED (live.gateway.ts) — the session is invalid, or the
    // run belongs to another org. Permanent: no reconnect can fix WHO is
    // asking.
    act(() => lastConnection().close(4401));
    expect(result.current.connected).toBe(false);
    expect(result.current.unauthorized).toBe(true);

    // Advancing well past the maximum possible backoff proves no reconnect
    // was merely delayed — retrying this close code forever, every ~30s, for
    // as long as the tab stays open, is exactly the bug this fix closes.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MAX_BACKOFF_MS + 1);
    });
    expect(server.connections).toHaveLength(1);
  });

  it('still reconnects after an ordinary close, and does not report unauthorized', async () => {
    const client = new QueryClient();
    const { result } = renderHook(() => useLiveRun(RUN_ID, true), { wrapper: wrapperFor(client) });
    await flush();

    // 1006 (abnormal closure) — the code a real dropped connection or a
    // restarting pod produces, and the transient counterpart to 4401 above.
    act(() => lastConnection().close(1006));
    expect(result.current.unauthorized).toBe(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(MAX_BACKOFF_MS + 1);
    });
    expect(server.connections).toHaveLength(2);
    expect(result.current.unauthorized).toBe(false);
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

/**
 * `seq` GAP DETECTION — the field `LiveDeltaSchema`'s docstring says the
 * browser uses to detect a dropped message, carried end to end and, until
 * now, consumed by nobody.
 *
 * Two paths lose a delta silently: the hub's ioredis subscriber dropping and
 * auto-resubscribing, and `parseFrame` refusing a frame. Its comment calls
 * that "self-corrected by the next tick", which holds for `users`, `errors`
 * and `summary` — all sent whole — and not for `responseTime`, an upsert
 * with a short lookback that simply loses those buckets for the rest of the
 * run.
 */
describe('useLiveRun — a dropped delta', () => {
  it('reconnects from the last delta it applied when a seq is skipped', async () => {
    const client = new QueryClient();
    renderHook(() => useLiveRun(RUN_ID, true), { wrapper: wrapperFor(client) });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await send({ type: 'snapshot', delta: deltaFixture({ seq: 4 }), partial: false, lastSeq: 4 });
    const first = lastConnection();
    act(() => first.emit({ type: 'delta', delta: deltaFixture({ seq: 5 }) }));

    // seq 6 never arrives. The delta that does is NOT applied — its buckets
    // would sit on top of a series missing whatever 6 carried.
    const afterGap = deltaFixture({ seq: 7, summary: { ...deltaFixture().summary, count: 999 } });
    act(() => first.emit({ type: 'delta', delta: afterGap }));
    expect(first.readyState).toBe(FakeSocket.CLOSED);
    expect(errorSpy).toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(MAX_BACKOFF_MS + 1);
    });
    // Resumed from 5, the last delta actually applied — not from 7, which
    // would ask the server to skip the very delta that was lost.
    expect(lastConnection()).not.toBe(first);
    expect(lastConnection().url).toContain('lastSeq=5');
    errorSpy.mockRestore();
  });

  it('does not reconnect on a contiguous stream', async () => {
    const client = new QueryClient();
    renderHook(() => useLiveRun(RUN_ID, true), { wrapper: wrapperFor(client) });

    await send({ type: 'snapshot', delta: deltaFixture({ seq: 2 }), partial: false, lastSeq: 2 });
    const socket = lastConnection();
    for (const seq of [3, 4, 5]) act(() => socket.emit({ type: 'delta', delta: deltaFixture({ seq }) }));

    expect(socket.readyState).toBe(FakeSocket.OPEN);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MAX_BACKOFF_MS + 1);
    });
    expect(server.connections).toHaveLength(1);
  });

  /**
   * THE REGRESSION THIS RULE IS EASIEST TO BREAK WITH. The gateway writes the
   * snapshot frame stamped with the LAST entry its replay will deliver, then
   * delivers that replay — so the deltas immediately after a snapshot arrive
   * with LOWER seqs than the frame's own `lastSeq`, in order. Comparing them
   * against the resume cursor would call every ordinary fresh connect a gap
   * and reconnect forever.
   */
  it('treats the replay behind a snapshot cursor as ordinary, not as a gap', async () => {
    const client = new QueryClient();
    const { result } = renderHook(() => useLiveRun(RUN_ID, true), { wrapper: wrapperFor(client) });

    // The seed: a snapshot holding state through seq 7, stamped with the last
    // entry the replay will deliver (10), exactly as the gateway writes it.
    const seed = deltaFixture({
      seq: 8,
      responseTime: { widthMs: 1000, replaces: true, buckets: [bucketFixture(0)] },
    });
    await send({ type: 'snapshot', delta: seed, partial: false, lastSeq: 10 });

    const socket = lastConnection();
    const replayed = [8, 9, 10, 11];
    for (const seq of replayed) {
      act(() =>
        socket.emit({
          type: 'delta',
          delta: deltaFixture({
            seq,
            responseTime: { widthMs: 1000, replaces: false, buckets: [bucketFixture(seq * 1000)] },
          }),
        }),
      );
    }

    // No reconnect — checking these against the resume cursor would read the
    // whole replay as one long gap.
    expect(socket.readyState).toBe(FakeSocket.OPEN);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MAX_BACKOFF_MS + 1);
    });
    expect(server.connections).toHaveLength(1);
    // And every replayed delta was APPLIED, not merely tolerated: treating
    // "behind the resume cursor" as "already held" would drop the seed's own
    // replay and leave the series short of exactly the buckets it exists to
    // deliver.
    expect(result.current.lastDelta?.seq).toBe(replayed.at(-1));
    expect(client.getQueryData<SeriesResponse>(liveSeriesCacheKey(RUN_ID))?.buckets.map((b) => b.startOffsetMs))
      .toEqual([0, ...replayed.map((seq) => seq * 1000)]);
  });

  /**
   * THE FAIL-SAFE FOR THE WORST DELTA TO LOSE. If the dropped message is the
   * re-bucketing one, its `replaces: true` never arrives — while the very
   * next ordinary delta still carries the new `widthMs`, which this client
   * adopts. Merged into the old-width series that is a doubled bucket count
   * and halved rates, with nothing thrown.
   */
  it('treats a changed bucket width as a replacement even when the flag says otherwise', async () => {
    const client = new QueryClient();
    renderHook(() => useLiveRun(RUN_ID, true), { wrapper: wrapperFor(client) });

    const seed = deltaFixture({
      seq: 0,
      responseTime: { widthMs: 1000, replaces: true, buckets: [bucketFixture(0), bucketFixture(1000)] },
    });
    await send({ type: 'snapshot', delta: seed, partial: false, lastSeq: 0 });

    // The re-bucketing delta was lost; this is the one AFTER it — an
    // ordinary upsert, `replaces: false`, at the new width.
    const wider = bucketFixture(4000);
    act(() =>
      lastConnection().emit({
        type: 'delta',
        delta: deltaFixture({ seq: 1, responseTime: { widthMs: 2000, replaces: false, buckets: [wider] } }),
      }),
    );

    const series = client.getQueryData<SeriesResponse>(liveSeriesCacheKey(RUN_ID));
    expect(series?.buckets).toEqual([wider]);
    expect(series?.bucketWidthMs).toBe(2000);
  });
});

/**
 * A REPEATABLE HOLE. `expectSeq` survives a reconnect — the gateway's resume
 * path sends no snapshot frame when the stream still reaches the client's
 * cursor, and only a snapshot resets it — so a `seq` that is PERMANENTLY
 * missing from the stream (a frame `parseFrame` refuses without advancing
 * the server's own cursor, or one the worker's `#publish` catch path
 * advanced `seq` past after a failed `xadd`) reads as the identical gap
 * every single time this client resumes. Before this fix `ws.onopen` reset
 * `attempt` to 0 unconditionally, and every one of these reconnects
 * genuinely DOES open — so the backoff computed at `BASE_BACKOFF_MS` forever:
 * a full WebSocket upgrade, a session lookup, two DB queries and a
 * whole-stream `XRANGE`, roughly once a second, for as long as the hole
 * stays inside the replay window (`REPLAY_MAX_ENTRIES` x `liveTickMs`, about
 * 17 minutes). A reviewer's probe measured exactly that shape: five rounds
 * of the identical gap produced six connections.
 */
describe('useLiveRun — a repeatable hole', () => {
  it('escalates the backoff instead of retrying at a flat ~1Hz when the same gap repeats every time', async () => {
    // Pins `backoffDelayMs`'s full-jitter draw to its own ceiling, so every
    // delay used below is the value `backoffDelayMs` itself computes for a
    // given `attempt` — no timing is hand-written independently of it.
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(1);
    const client = new QueryClient();
    renderHook(() => useLiveRun(RUN_ID, true), { wrapper: wrapperFor(client) });

    await send({ type: 'snapshot', delta: deltaFixture({ seq: 4 }), partial: false, lastSeq: 4 });
    act(() => lastConnection().emit({ type: 'delta', delta: deltaFixture({ seq: 5 }) }));

    // The gateway would replay this VERBATIM every round: seq 7 where 6 was
    // expected, byte-for-byte identical each time — never seq 6 itself.
    const theHole = () => deltaFixture({ seq: 7, summary: { ...deltaFixture().summary, count: 999 } });

    // Round 1. `attempt` is 0 here under BOTH the pre-fix and the fixed
    // code — this round only advances the clock to a known point, and
    // proves nothing about the fix by itself.
    act(() => lastConnection().emit({ type: 'delta', delta: theHole() }));
    expect(lastConnection().readyState).toBe(FakeSocket.CLOSED);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(backoffDelayMs(0, () => 1) + 1);
    });
    expect(server.connections).toHaveLength(2);

    // Round 2: the identical gap again, on the fresh connection — exactly
    // what a hole that never reaches the stream produces.
    act(() => lastConnection().emit({ type: 'delta', delta: theHole() }));
    expect(lastConnection().readyState).toBe(FakeSocket.CLOSED);

    // THE ASSERTION. Advance only as far as round 1's OWN delay again. The
    // pre-fix code resets `attempt` to 0 in `onopen` before this gap is even
    // detected, so round 2's delay is identical to round 1's and a third
    // connection would already exist here — the ~1Hz loop the probe
    // measured. The fix leaves `attempt` at 1 across a gap-triggered close,
    // so round 2's delay has escalated and nothing has reconnected yet at
    // this point on the clock.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(backoffDelayMs(0, () => 1) + 1);
    });
    expect(server.connections).toHaveLength(2); // still bounded, not a third connection

    // Not stuck forever, though — advancing out to round 2's own (escalated)
    // delay reconnects it just the same.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(backoffDelayMs(1, () => 1));
    });
    expect(server.connections).toHaveLength(3);

    randomSpy.mockRestore();
  });

  it('resets the backoff once a genuinely forward-progressing delta arrives, so a later unrelated drop still recovers fast', async () => {
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(1);
    const client = new QueryClient();
    renderHook(() => useLiveRun(RUN_ID, true), { wrapper: wrapperFor(client) });

    await send({ type: 'snapshot', delta: deltaFixture({ seq: 4 }), partial: false, lastSeq: 4 });
    act(() => lastConnection().emit({ type: 'delta', delta: deltaFixture({ seq: 5 }) }));

    // One gap, to move `attempt` off the floor — round 1 from the case above.
    act(() =>
      lastConnection().emit({
        type: 'delta',
        delta: deltaFixture({ seq: 7, summary: { ...deltaFixture().summary, count: 999 } }),
      }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(backoffDelayMs(0, () => 1) + 1);
    });
    expect(server.connections).toHaveLength(2);

    // This time the hole is genuinely gone: the reconnected socket gets
    // exactly the delta it was missing, seq 6, and applies it cleanly.
    act(() => lastConnection().emit({ type: 'delta', delta: deltaFixture({ seq: 6 }) }));

    // An UNRELATED transient drop — a restarting pod, an abnormal closure —
    // with no gap involved at all.
    act(() => lastConnection().close(1006));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(backoffDelayMs(0, () => 1) + 1);
    });
    // Back on the BASE schedule, not whatever the already-resolved gap had
    // escalated `attempt` to — a healthy stream must not keep paying for a
    // hole that already closed.
    expect(server.connections).toHaveLength(3);

    randomSpy.mockRestore();
  });
});

/**
 * `partial` — computed carefully by the gateway, parsed by
 * `SnapshotFrameSchema`, and then dropped on the floor. A seed that begins at
 * minute 20 of a soak said nothing; a holed stream drew as complete; and with
 * neither Redis key present the reader got a whole dashboard of fabricated
 * zeros.
 */
describe('useLiveRun — a partial seed', () => {
  it('surfaces the gateway’s own partial flag', async () => {
    const client = new QueryClient();
    const { result } = renderHook(() => useLiveRun(RUN_ID, true), { wrapper: wrapperFor(client) });
    expect(result.current.partial).toBe(false);

    await send({ type: 'snapshot', delta: deltaFixture(), partial: true, lastSeq: 0 });
    expect(result.current.partial).toBe(true);
  });

  it('keeps it set as deltas arrive — a hole in the seed is not filled by later ticks', async () => {
    const client = new QueryClient();
    const { result } = renderHook(() => useLiveRun(RUN_ID, true), { wrapper: wrapperFor(client) });

    await send({ type: 'snapshot', delta: deltaFixture({ seq: 0 }), partial: true, lastSeq: 0 });
    act(() => lastConnection().emit({ type: 'delta', delta: deltaFixture({ seq: 1 }) }));

    expect(result.current.partial).toBe(true);
  });

  it('clears it on a later complete seed', async () => {
    const client = new QueryClient();
    const { result } = renderHook(() => useLiveRun(RUN_ID, true), { wrapper: wrapperFor(client) });

    await send({ type: 'snapshot', delta: deltaFixture(), partial: true, lastSeq: 0 });
    act(() => lastConnection().emit({ type: 'snapshot', delta: deltaFixture(), partial: false, lastSeq: 0 }));

    expect(result.current.partial).toBe(false);
  });
});

/**
 * THE COMPLETION TRANSITION — the one edge no suite exercised at all.
 *
 * `useLiveRun` writes `liveSeriesKey`/`usersQueryKey`/`errorsQueryKey`, which
 * are the SAME keys the finished run page subscribes to, and every one of
 * those factories carries `staleTime: Infinity` (`api/metrics.ts`). An
 * operator who opens a running run and watches it finish in the same tab
 * therefore got the finished report drawn from the live fold's last delta,
 * beside a REST-fetched statistics table showing the full totals — two
 * contradicting sets of numbers for one run, on one screen, until a reload.
 *
 * The edge itself is `enabled` going false: the caller's `enabled` IS
 * `run.status === 'running' && !compact` (`RunDetail`), so a `rerender` with
 * `enabled: false` is exactly what the run leaving `running` does to this
 * hook.
 */
describe('useLiveRun — handing the cache back to REST when the run ends', () => {
  const writtenKeys = (runId: string) => [
    liveSeriesCacheKey(runId),
    usersQueryKey(runId),
    errorsQueryKey(runId),
  ];

  function renderLive(client: QueryClient) {
    return renderHook(({ enabled }: { enabled: boolean }) => useLiveRun(RUN_ID, enabled), {
      wrapper: wrapperFor(client),
      initialProps: { enabled: true },
    });
  }

  it('leaves what it wrote valid while the run is still streaming', async () => {
    const client = new QueryClient();
    renderLive(client);
    await send({ type: 'snapshot', delta: deltaFixture(), partial: false, lastSeq: 0 });

    // Invalidating mid-run would send the still-live page to REST for a run
    // whose persisted rows do not exist yet (`MetricWriter` has not run), and
    // that emptier payload would race the socket's own writes.
    for (const key of writtenKeys(RUN_ID)) {
      expect(client.getQueryState(key)?.isInvalidated).toBe(false);
    }
  });

  it('invalidates all three keys it wrote once the run stops streaming', async () => {
    const client = new QueryClient();
    const { rerender } = renderLive(client);
    await send({ type: 'snapshot', delta: deltaFixture(), partial: false, lastSeq: 0 });

    rerender({ enabled: false });

    for (const key of writtenKeys(RUN_ID)) {
      expect(client.getQueryState(key)?.isInvalidated).toBe(true);
    }
    // The DATA is still there — §4.4's frozen dashboard keeps drawing the
    // last delta while the run finalizes. Invalidated, not removed.
    expect(client.getQueryData(usersQueryKey(RUN_ID))).toBeDefined();
  });

  /**
   * The user-visible half. `staleTime: Infinity` means a mount that finds
   * cached data does NOT fetch — which is why the finished page rendered the
   * last delta forever. This proves the observer the finished page mounts
   * actually goes back to the network.
   */
  it('makes the finished page refetch rather than redraw the last delta', async () => {
    const client = new QueryClient();
    const { rerender } = renderLive(client);
    await send({ type: 'snapshot', delta: deltaFixture(), partial: false, lastSeq: 0 });
    rerender({ enabled: false });

    const refetch = vi.fn().mockResolvedValue({ runId: RUN_ID, window: null, scenarios: [], total: [] });
    // The REAL key the finished page's `RunShell` subscribes to, with only
    // the fetcher swapped — a hand-written key here would prove nothing about
    // the one the socket wrote.
    renderHook(() => useQuery({ ...usersQuery(RUN_ID), queryFn: refetch }), {
      wrapper: wrapperFor(client),
    });
    await flush();

    expect(refetch).toHaveBeenCalled();
  });

  it('invalidates nothing when the socket never delivered a delta', async () => {
    const client = new QueryClient();
    // A payload REST fetched for itself, under one of the same keys — a
    // session that wrote nothing has no claim on it, and marking it stale
    // would cost the reader a needless refetch.
    client.setQueryData(usersQueryKey(RUN_ID), { runId: RUN_ID, window: null, scenarios: [], total: [] });
    const { rerender } = renderLive(client);
    await flush();

    rerender({ enabled: false });

    expect(client.getQueryState(usersQueryKey(RUN_ID))?.isInvalidated).toBe(false);
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
