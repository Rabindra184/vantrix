import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LiveHub, type LiveSink } from '../src/live/live-hub.js';

// Same fallback every other integration suite in this directory uses for a
// raw ioredis client (see live.integration.test.ts, trends.integration.test.ts).
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6380';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A `LiveSink` that records what it was handed. `send` is the whole of the
 * interface, which is the point of the interface -- real sockets, framing and
 * backpressure belong to `LiveGateway`, and this suite is about the fan-out
 * plumbing underneath all three.
 */
function fakeSocket(): { sent: string[] } & LiveSink {
  const sent: string[] = [];
  return {
    sent,
    send(data: string) {
      sent.push(data);
    },
  };
}

let hubs: LiveHub[] = [];
let publisher: Redis | undefined;

afterEach(async () => {
  await Promise.all(hubs.map((hub) => hub.close()));
  hubs = [];
  await publisher?.quit();
  publisher = undefined;
});

function newHub(): LiveHub {
  const hub = new LiveHub(REDIS_URL);
  hubs.push(hub);
  return hub;
}

describe('LiveHub', () => {
  // FR-LIVE-7's actual claim: any pod can serve any viewer. Two hubs against
  // one Redis stand in for two pods.
  it('delivers one publish to sockets on different pods', async () => {
    const runId = randomUUID();
    const a = newHub();
    const b = newHub();
    const sa = fakeSocket();
    const sb = fakeSocket();
    publisher = new Redis(REDIS_URL);

    await a.join(runId, sa);
    await b.join(runId, sb);

    await publisher.publish(`live:${runId}`, JSON.stringify({ seq: 1 }));
    await vi.waitFor(() => expect(sa.sent.length === 1 && sb.sent.length === 1).toBe(true));

    expect(JSON.parse(sa.sent[0]!).seq).toBe(1);
    expect(JSON.parse(sb.sent[0]!).seq).toBe(1);
  });

  // A subscriber connection per socket would put a Redis connection count on
  // the viewer count.
  it('subscribes once for a run however many sockets join, and unsubscribes on the last leave', async () => {
    const runId = randomUUID();
    const hub = newHub();
    const s1 = fakeSocket();
    const s2 = fakeSocket();
    publisher = new Redis(REDIS_URL);

    await hub.join(runId, s1);
    await hub.join(runId, s2);
    expect(hub.size(runId)).toBe(2);

    await hub.leave(runId, s1);
    expect(hub.size(runId)).toBe(1);
    await publisher.publish(`live:${runId}`, JSON.stringify({ seq: 2 }));
    await vi.waitFor(() => expect(s2.sent.length).toBe(1));

    await hub.leave(runId, s2);
    expect(hub.size(runId)).toBe(0);
    await publisher.publish(`live:${runId}`, JSON.stringify({ seq: 3 }));
    // No event to wait for on the negative side (nothing SHOULD happen), so
    // this gives pub/sub delivery a generous window before asserting its
    // absence, same technique live.integration.test.ts uses for its own
    // negative pub/sub cases.
    await delay(100);
    expect(s2.sent).toHaveLength(1); // nothing after the last leave
  });

  // The race the brief calls out by name: the room must be visible to a
  // second join before the first join's SUBSCRIBE resolves, or two
  // concurrent joins for the same run open two SUBSCRIBEs for one channel.
  it('a second concurrent join for the same run does not open a second SUBSCRIBE', async () => {
    const runId = randomUUID();
    const hub = newHub();
    const s1 = fakeSocket();
    const s2 = fakeSocket();

    await Promise.all([
      hub.join(runId, s1),
      hub.join(runId, s2),
    ]);

    expect(hub.size(runId)).toBe(2);
  });

  // One dead socket in a room must not deny the live ones behind it.
  // `ws.send()` throws outright on a CONNECTING socket, and the fan-out ran
  // the whole room inside one synchronous `for` -- so a single throw
  // abandoned every subscriber after it in iteration order, silently, and
  // did so again for every delta while the dead one stayed in the room.
  it('delivers to the rest of a room when one socket throws on send', async () => {
    const runId = randomUUID();
    const hub = newHub();
    const healthy = fakeSocket();
    const broken: LiveSink = {
      send() {
        throw new Error('socket is not open');
      },
    };
    publisher = new Redis(REDIS_URL);

    // Joined FIRST, so it precedes the healthy one in the room's iteration
    // order -- otherwise the test passes whether or not the guard exists.
    await hub.join(runId, broken);
    await hub.join(runId, healthy);

    await publisher.publish(`live:${runId}`, JSON.stringify({ seq: 4 }));

    await vi.waitFor(() => expect(healthy.sent).toHaveLength(1));
    expect(JSON.parse(healthy.sent[0]!).seq).toBe(4);
  });
});
