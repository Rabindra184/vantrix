import { createHash, randomUUID } from 'node:crypto';
import { createPrisma } from '@perfportal/persistence';
import pg from 'pg';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
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

/**
 * ═══ WHEN POSTGRES ENDS THE LISTEN SESSION ═══
 *
 * A restart, a failover or an operator's `pg_terminate_backend` ends this
 * waiter's dedicated session. node-postgres then emits `error` on the client
 * -- measured (8.22): an idle client whose backend is terminated emits two,
 * `57P01` then "Connection terminated unexpectedly" -- and an EventEmitter
 * with no `error` listener THROWS: an uncaught exception, which in the API is
 * the process. Vitest fails the file on one, which is the guard for that half.
 *
 * Surviving is not enough either. A session that never comes back leaves
 * every later `waitFor` waiting out its whole window for a run that went
 * terminal long ago -- `POST /v1/runs` answering after 25 seconds instead of
 * as soon as the worker finished, with nothing anywhere saying why.
 *
 * The session is ended with a real `pg_terminate_backend`, found by the one
 * thing only it runs, from an AUTOCOMMIT connection (`pg_stat_activity` read
 * inside a transaction is a snapshot frozen at the first read).
 */
describe('TerminalWaiter, when Postgres ends its LISTEN session', () => {
  const prisma = createPrisma(DATABASE_URL);
  const FAST = { initialMs: 50, maxMs: 200 };

  afterAll(async () => {
    await prisma.$disconnect();
  });

  /** Backends in THIS database whose last statement was the LISTEN. */
  async function listeners(observer: pg.Client): Promise<number[]> {
    const { rows } = await observer.query<{ pid: number }>(
      `SELECT pid FROM pg_stat_activity
        WHERE datname = current_database() AND query ILIKE 'LISTEN run_terminal%'
          AND pid <> pg_backend_pid()`,
    );
    return rows.map((r) => r.pid);
  }

  async function until<T>(what: string, probe: () => Promise<T | null | false>, ms = 15_000): Promise<T> {
    const deadline = Date.now() + ms;
    for (;;) {
      const got = await probe();
      if (got !== null && got !== false) return got;
      if (Date.now() > deadline) throw new Error(`timed out after ${ms}ms waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  /** A run row at `status`. The waiter's recovery reads `run.status`, so a
   * case about a run going terminal while nothing listened needs a real one. */
  async function seedRun(status: 'parsing' | 'complete'): Promise<string> {
    const org = await prisma.org.create({ data: { slug: `waiter-${randomUUID()}`, name: 'Waiter' } });
    const project = await prisma.project.create({
      data: { orgId: org.id, slug: 'checkout', name: 'Checkout', settings: {} },
    });
    const run = await prisma.run.create({
      data: {
        orgId: org.id, projectId: project.id, status, tool: 'gatling',
        bundleKey: `runs/${project.id}/${randomUUID()}.tgz`,
        bundleSha256: createHash('sha256').update(randomUUID()).digest('hex'),
        bundleBytes: BigInt(1),
        startedAt: new Date('2026-08-07T10:00:00Z'), startedOn: new Date('2026-08-07T00:00:00Z'),
        engineOptions: {},
      },
    });
    return run.id;
  }

  it('survives, listens again, and a notification after it is back still wakes a waiter', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      waiter = new TerminalWaiter(DATABASE_URL, { reconnectDelayMs: FAST });
      await waiter.onModuleInit();
      notifier = await makeNotifier();

      const before = await listeners(notifier);
      expect(before).toHaveLength(1);
      await notifier.query('SELECT pg_terminate_backend($1)', [before[0]]);

      // Said, with the SQLSTATE: an operator whose database restarted should
      // be able to find out the API noticed, and why.
      await until('the waiter to report the lost session', async () =>
        warn.mock.calls.some((c) => /57P01/.test(String(c[0]))),
      );
      const after = await until('a new LISTEN session', async () => {
        const pids = await listeners(notifier!);
        return pids.length === 1 && pids[0] !== before[0] ? pids : null;
      });
      expect(after).toHaveLength(1);

      const runId = randomUUID();
      const woken = waiter.waitFor(runId, 5_000);
      await notifier.query(`SELECT pg_notify('run_terminal', $1)`, [runId]);
      await expect(woken).resolves.toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('wakes a waiter whose run went terminal while nothing listened, and only that one', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const finished = await seedRun('parsing');
      const stillGoing = await seedRun('parsing');
      waiter = new TerminalWaiter(DATABASE_URL, { reconnectDelayMs: FAST });
      await waiter.onModuleInit();
      notifier = await makeNotifier();

      const started = Date.now();
      const finishedWait = waiter.waitFor(finished, 20_000);
      const goingWait = waiter.waitFor(stillGoing, 20_000);

      // The notification for this run is the one a real gap loses: the row
      // goes terminal and NOTHING arrives on the new session. Written before
      // the kill, rather than raced into the gap, so the case cannot pass or
      // fail on timing -- the waiter's view is identical either way.
      await prisma.run.update({ where: { id: finished }, data: { status: 'complete' } });
      const [pid] = await listeners(notifier);
      expect(pid).toBeDefined();
      await notifier.query('SELECT pg_terminate_backend($1)', [pid]);

      await expect(finishedWait).resolves.toBe(true);
      // Promptly -- on recovery, not on its 20-second timeout.
      expect(Date.now() - started).toBeLessThan(10_000);
      // A run still in progress is NOT woken by the recovery: its caller
      // would answer 202 early for no reason. It waits on -- a settled wait
      // leaves the map synchronously, so one entry left is exactly it -- and
      // its own notification, on the new session, is what ends the wait.
      expect(waiter.waitingRunCount).toBe(1);
      await notifier.query(`SELECT pg_notify('run_terminal', $1)`, [stillGoing]);
      await expect(goingWait).resolves.toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('stops trying to listen again once it is destroyed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // A slower first retry, so the destroy below lands inside it: a
      // reconnect scheduled before shutdown must not open a session after it.
      waiter = new TerminalWaiter(DATABASE_URL, { reconnectDelayMs: { initialMs: 400, maxMs: 400 } });
      await waiter.onModuleInit();
      notifier = await makeNotifier();

      const [pid] = await listeners(notifier);
      expect(pid).toBeDefined();
      await notifier.query('SELECT pg_terminate_backend($1)', [pid]);
      await until('the waiter to report the lost session', async () =>
        warn.mock.calls.some((c) => /57P01/.test(String(c[0]))),
      );

      await waiter.onModuleDestroy();
      waiter = undefined;
      await new Promise((r) => setTimeout(r, 1_200));
      expect(await listeners(notifier)).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });
});
