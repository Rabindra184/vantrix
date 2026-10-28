import { spawn, type ChildProcess } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Queue } from 'bullmq';
import { createPool } from '@perfportal/persistence';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadWorkerConfig } from '../src/config.js';
import { RECOMPUTE_QUEUE } from '../src/recompute/recompute-queue.js';
import { VERIFY_QUEUE } from '../src/verify/verify-queue.js';

/**
 * ═══ SIGTERM MUST END THE WORKER, ON ITS OWN, PROMPTLY ═══
 *
 * `main.ts`'s `shutdown()` never calls `process.exit`: it closes every
 * resource and relies on the event loop draining. So one resource it forgets
 * is not a slow shutdown, it is a process that never exits -- and that is what
 * shipped. The sweeper's Redis publisher was created inline and never quit, so
 * an idle worker sat on that one socket after every teardown step had run,
 * until whoever was stopping it sent SIGKILL (CLAUDE.md recorded 20 to 60.3 s,
 * each of them the cap somebody chose, not the behaviour).
 *
 * No in-process test can see this: a vitest worker keeps its own loop alive
 * whatever the code under test leaks. So this case SPAWNS the real entry
 * point, `dist/main.js`, waits until it has started, sends SIGTERM, and times
 * the exit. Being the built file is the hazard, hence the staleness guard
 * below: `pnpm test:integration` builds first, but a file run on its own over
 * an old `dist` would measure a worker nobody is looking at. The guard covers
 * `apps/worker` alone; the workspace packages it imports run from their own
 * `dist`, which `tsc -b` builds and this does not check.
 */

const WORKER_ROOT = fileURLToPath(new URL('..', import.meta.url));
const ENTRY = join(WORKER_ROOT, 'dist', 'main.js');

/** Measured at 0.25-0.41 s after the fix; far below this, and nothing healthy comes near it. */
const EXIT_DEADLINE_MS = 10_000;
/** The worker logs both scans once its queues and pool have answered; start-up is a few seconds at most. */
const STARTUP_DEADLINE_MS = 30_000;

const config = loadWorkerConfig({ ...process.env, DATABASE_URL: process.env.DATABASE_URL ?? '' });
const pool = createPool(config.databaseUrl);

/** Every `src/**\/*.ts` must have a `dist` twin at least as new, or this case would time the wrong code. */
function staleOutputs(): string[] {
  const stale: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.ts')) {
        const out = join(WORKER_ROOT, 'dist', relative(join(WORKER_ROOT, 'src'), path)).replace(/\.ts$/, '.js');
        let outTime = 0;
        try {
          outTime = statSync(out).mtimeMs;
        } catch {
          // missing: stale by definition
        }
        if (outTime < statSync(path).mtimeMs) stale.push(relative(WORKER_ROOT, path));
      }
    }
  };
  walk(join(WORKER_ROOT, 'src'));
  return stale;
}

beforeAll(async () => {
  // The spawned worker consumes whatever an earlier file left queued on this
  // Redis index and scans whatever runs an earlier file left in this database.
  // Neither belongs to this case, and an active job would make the timing
  // about that job rather than about shutdown.
  await pool.query('TRUNCATE TABLE "run" CASCADE');
  for (const name of ['ingest', RECOMPUTE_QUEUE, VERIFY_QUEUE]) {
    const queue = new Queue(name, { connection: { url: config.redisUrl } });
    await queue.obliterate({ force: true });
    await queue.close();
  }
});

afterAll(async () => {
  await pool.end();
});

describe('the worker process', () => {
  it('exits by itself, with code 0, soon after SIGTERM', async () => {
    expect(staleOutputs(), 'apps/worker/dist is older than its source: run pnpm build').toEqual([]);

    const child: ChildProcess = spawn(process.execPath, [ENTRY], {
      cwd: WORKER_ROOT,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // A spawn-level failure (EAGAIN, EMFILE) is an `error` event, not an `exit`:
    // without this it would be thrown unhandled and `exited` would never settle.
    let spawnError: Error | null = null;
    child.once('error', (err) => (spawnError = err));
    let output = '';
    child.stdout?.on('data', (b: Buffer) => (output += b.toString()));
    child.stderr?.on('data', (b: Buffer) => (output += b.toString()));
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once('exit', (code, signal) => resolve({ code, signal }));
      child.once('error', () => resolve({ code: null, signal: null }));
    });

    try {
      // Started: both scans answer only once the database and the BullMQ
      // queues have. Nothing awaits the consumers' blocking connections or the
      // fold owner's subscribe, so one may still be connecting; that is fine,
      // because a connecting socket holds the loop just as an open one does.
      const startedBy = Date.now() + STARTUP_DEADLINE_MS;
      while (!(output.includes('recompute scan:') && output.includes('verify scan:'))) {
        if (spawnError) throw spawnError;
        if (child.exitCode !== null || child.signalCode !== null) {
          throw new Error(`worker exited during start-up (${String(child.exitCode ?? child.signalCode)}):\n${output}`);
        }
        if (Date.now() > startedBy) throw new Error(`worker did not start within ${STARTUP_DEADLINE_MS} ms:\n${output}`);
        await new Promise((r) => setTimeout(r, 100));
      }

      const sentAt = Date.now();
      child.kill('SIGTERM');
      const outcome = await Promise.race([
        exited,
        new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), EXIT_DEADLINE_MS)),
      ]);
      const tookMs = Date.now() - sentAt;

      expect(outcome, `still running ${EXIT_DEADLINE_MS} ms after SIGTERM:\n${output}`).not.toBe('timeout');
      // Exiting on the signal itself would mean no handler ran; a non-zero code, that one threw.
      expect(outcome).toEqual({ code: 0, signal: null });
      expect(output).not.toMatch(/shutdown: .* failed/);
      expect(tookMs).toBeLessThan(EXIT_DEADLINE_MS);
    } finally {
      // By PID, through the handle this case holds: never a pattern.
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
    }
  });
});
