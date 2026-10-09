import { describe, expect, it } from 'vitest';
import type { RedisCommands } from '../src/common/redis-commands.js';
import {
  DEFAULT_PASSWORD_ATTEMPT_POLICY,
  PASSWORD_ATTEMPT_LIMIT,
  PASSWORD_ATTEMPT_WINDOW_SECONDS,
  PasswordAttempts,
  passwordAttemptKey,
} from '../src/me/password-attempts.js';

/*
 * ═══ PasswordAttempts' ARITHMETIC, OVER A REDIS THAT ANSWERS WHAT WE SAY ═══
 *
 * What real Redis does with the transaction — the fixed window, the expiry —
 * is me.integration.test.ts's. This file is about what `take` makes of the
 * replies, including the one a real server produces only by timing: a TTL of
 * 0, which is what Redis reports with under half a second left.
 */

interface Chain {
  incr(): Chain;
  expire(...args: unknown[]): Chain;
  ttl(): Chain;
  exec(): Promise<unknown>;
}

/** A RedisCommands whose MULTI answers `exec()`, recording EXPIRE's arguments. */
function commandsAnswering(exec: () => Promise<unknown>): { commands: RedisCommands; expireArgs: unknown[][] } {
  const expireArgs: unknown[][] = [];
  const chain: Chain = {
    incr: () => chain,
    expire: (...args) => {
      expireArgs.push(args);
      return chain;
    },
    ttl: () => chain,
    exec,
  };
  return { commands: { client: { multi: () => chain } } as unknown as RedisCommands, expireArgs };
}

/** A RedisCommands whose MULTI answers `count` to INCR and `ttl` to TTL. */
function fakeCommands(count: number, ttl: number): { commands: RedisCommands; expireArgs: unknown[][] } {
  return commandsAnswering(async () => [
    [null, count],
    [null, 1],
    [null, ttl],
  ]);
}

describe('PasswordAttempts.take', () => {
  it('lets an attempt within the limit go ahead', async () => {
    const { commands } = fakeCommands(PASSWORD_ATTEMPT_LIMIT, 4);
    expect(await new PasswordAttempts(commands).take('u')).toBeNull();
  });

  it('refuses the attempt past the limit with the seconds left in the window', async () => {
    const { commands } = fakeCommands(PASSWORD_ATTEMPT_LIMIT + 1, 7);
    expect(await new PasswordAttempts(commands).take('u')).toBe(7);
  });

  /**
   * Redis rounds a TTL to the nearest second, so a window with 0.4 s left
   * reports 0. `Retry-After` is "at least 1" by its docstring and by the
   * OpenAPI document's `minimum: 1`; this pins the code to both.
   */
  it('never answers a Retry-After below 1, even when Redis reports a TTL of 0', async () => {
    const { commands } = fakeCommands(PASSWORD_ATTEMPT_LIMIT + 1, 0);
    expect(await new PasswordAttempts(commands).take('u')).toBe(1);
  });

  it('defaults to production’s policy: 3 attempts per 10 seconds', async () => {
    expect(DEFAULT_PASSWORD_ATTEMPT_POLICY).toEqual({
      limit: PASSWORD_ATTEMPT_LIMIT,
      windowSeconds: PASSWORD_ATTEMPT_WINDOW_SECONDS,
    });
    expect([PASSWORD_ATTEMPT_LIMIT, PASSWORD_ATTEMPT_WINDOW_SECONDS]).toEqual([3, 10]);

    const { commands, expireArgs } = fakeCommands(1, 10);
    await new PasswordAttempts(commands).take('u');
    expect(expireArgs[0]?.slice(0, 2)).toEqual([passwordAttemptKey('u'), PASSWORD_ATTEMPT_WINDOW_SECONDS]);
  });

  it('takes its limit and its window from the policy it is given', async () => {
    const policy = { limit: 1, windowSeconds: 60 };
    const second = fakeCommands(2, 55);
    expect(await new PasswordAttempts(second.commands, policy).take('u')).toBe(55);
    expect(second.expireArgs[0]?.slice(0, 2)).toEqual([passwordAttemptKey('u'), 60]);

    const first = fakeCommands(1, 60);
    expect(await new PasswordAttempts(first.commands, policy).take('u')).toBeNull();
  });

  /** It fails CLOSED: an error it cannot count through is thrown, never read as "go ahead". */
  it('throws when Redis answers an error, and when the transaction is aborted', async () => {
    const failing = commandsAnswering(async () => [
      [new Error('READONLY'), null],
      [null, 1],
      [null, 10],
    ]).commands;
    await expect(new PasswordAttempts(failing).take('u')).rejects.toThrow('READONLY');

    const aborted = commandsAnswering(async () => null).commands;
    await expect(new PasswordAttempts(aborted).take('u')).rejects.toThrow(/aborted/);
  });
});
