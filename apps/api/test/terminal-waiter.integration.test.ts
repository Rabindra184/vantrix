import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { TerminalWaiter } from '../src/runs/terminal-waiter.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://perfportal:perfportal@localhost:5433/perfportal';

let waiter: TerminalWaiter | undefined;
let notifier: pg.Client | undefined;

afterEach(async () => {
  await waiter?.onModuleDestroy();
  waiter = undefined;
  await notifier?.end();
  notifier = undefined;
});

async function makeNotifier(): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  return client;
}

describe('TerminalWaiter', () => {
  it('does not leak a #waiters map entry per run — timeout and notify paths both clean up', async () => {
    waiter = new TerminalWaiter(DATABASE_URL);
    await waiter.onModuleInit();
    notifier = await makeNotifier();

    // Three runs that will time out with nobody ever notifying them...
    const timedOutIds = [randomUUID(), randomUUID(), randomUUID()];
    const timeoutWaits = timedOutIds.map((id) => waiter!.waitFor(id, 100));

    // ...and three runs that will be woken by a real pg_notify.
    const wokenIds = [randomUUID(), randomUUID(), randomUUID()];
    const wokenWaits = wokenIds.map((id) => waiter!.waitFor(id, 5_000));

    // Give the subscriptions a moment to register before notifying.
    await new Promise((resolve) => setTimeout(resolve, 50));
    for (const id of wokenIds) {
      await notifier.query(`SELECT pg_notify('run_terminal', $1)`, [id]);
    }

    const [timeoutResults, wokenResults] = await Promise.all([
      Promise.all(timeoutWaits),
      Promise.all(wokenWaits),
    ]);

    expect(timeoutResults).toEqual([false, false, false]);
    expect(wokenResults).toEqual([true, true, true]);

    // The falsifiable claim: after every waiter above has settled (whether by
    // timeout or by notification), #waiters must not retain an entry for any
    // of the six distinct run ids used in this test.
    expect(waiter.waitingRunCount).toBe(0);
  });

  it('a run already terminal before the subscription is registered times out instead of hanging', async () => {
    waiter = new TerminalWaiter(DATABASE_URL);
    await waiter.onModuleInit();
    notifier = await makeNotifier();

    const runId = randomUUID();
    // The notification fires before anything is listening for this run id —
    // e.g. the worker finished and notified between the row write and this
    // call registering its subscription.
    await notifier.query(`SELECT pg_notify('run_terminal', $1)`, [runId]);
    await new Promise((resolve) => setTimeout(resolve, 20));

    const start = Date.now();
    const result = await waiter.waitFor(runId, 150);
    const elapsed = Date.now() - start;

    expect(result).toBe(false);
    // Proves it actually waited out the timeout rather than resolving
    // instantly for an unrelated reason, while staying well clear of a hang.
    expect(elapsed).toBeGreaterThanOrEqual(140);
    expect(elapsed).toBeLessThan(2_000);
    expect(waiter.waitingRunCount).toBe(0);
  });
});
