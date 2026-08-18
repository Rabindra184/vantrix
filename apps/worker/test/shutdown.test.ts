import { afterEach, describe, expect, it, vi } from 'vitest';
import { runShutdown } from '../src/shutdown.js';

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * `LiveFoldOwner.close()` throws an `AggregateError` BY DESIGN when a run's
 * advisory-lock release fails. In `main.ts`'s original plain sequence of
 * awaits, that designed report was fatal to the shutdown itself: the throw
 * propagated past `pool.end()` and `prisma.$disconnect()`, so the one
 * condition `close()` exists to REPORT became "SIGTERM leaves the pool and
 * Prisma's connections open" -- and, because the handlers were
 * `process.on('SIGTERM', () => void shutdown())` with no `.catch()`, on
 * Node 22 the process died with `ERR_UNHANDLED_REJECTION` rather than
 * printing the message the error was built to carry.
 */
describe('runShutdown', () => {
  it('runs every step, in order', async () => {
    const order: string[] = [];
    await runShutdown([
      { name: 'a', run: () => { order.push('a'); } },
      { name: 'b', run: async () => { order.push('b'); } },
      { name: 'c', run: () => { order.push('c'); } },
    ]);
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('keeps going past a step that rejects, and never rejects itself', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const after: string[] = [];

    // The real shape: LiveFoldOwner.close() reporting a failed release.
    const designed = new AggregateError(
      [new Error('unlock failed')],
      'LiveFoldOwner.close(): failed to release 1 of 3 owned run(s)',
    );

    await expect(
      runShutdown([
        { name: 'foldOwner.close', run: () => Promise.reject(designed) },
        { name: 'pool.end', run: () => { after.push('pool.end'); } },
        { name: 'prisma.$disconnect', run: () => { after.push('prisma.$disconnect'); } },
      ]),
    ).resolves.toBeUndefined();

    // The whole point: the steps AFTER the failure still ran.
    expect(after).toEqual(['pool.end', 'prisma.$disconnect']);

    // And the operator is told which step failed, by name -- a stack from
    // inside ioredis or pg says nothing about which of six teardowns
    // produced it.
    const logged = errors.mock.calls.map((c) => String(c[0]));
    expect(logged.some((line) => line.includes('foldOwner.close'))).toBe(true);
    expect(errors.mock.calls.some((c) => c[1] === designed)).toBe(true);
  });

  it('isolates a synchronous throw as well as a rejection', async () => {
    // `clearInterval` cannot throw, but `worker.close()` and `pool.end()`
    // reach out to Redis and Postgres over a network that is by definition
    // being torn down around them, and a library is free to throw
    // synchronously before ever returning a promise.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const after: string[] = [];

    await runShutdown([
      { name: 'sync-thrower', run: () => { throw new Error('boom'); } },
      { name: 'later', run: () => { after.push('later'); } },
    ]);

    expect(after).toEqual(['later']);
  });
});
