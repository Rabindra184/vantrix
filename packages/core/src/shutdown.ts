/**
 * One step of a process's shutdown: a name for the log, and the call.
 *
 * A name rather than a function reference, because the name is the whole
 * point of the log line an operator reads at 3am -- `err.stack` from deep
 * inside ioredis says nothing about which of six teardowns produced it.
 */
export interface ShutdownStep {
  name: string;
  run: () => Promise<void> | void;
}

/**
 * Runs every step in order, and KEEPS GOING when one fails.
 *
 * ═══ WHY THIS IS NOT JUST `await a(); await b(); ...` ═══
 * `LiveFoldOwner.close()` throws an `AggregateError` BY DESIGN when a run's
 * advisory-lock release fails -- that surfacing is deliberate, documented
 * at length on the method, and covered by its own test. In a plain
 * sequential `shutdown()` it was also fatal to the shutdown: the throw
 * propagated past `pool.end()` and `prisma.$disconnect()`, so the one
 * condition `close()` was built to REPORT instead became "SIGTERM leaves
 * the pool and Prisma's connections open."
 *
 * Worse than that, actually. The signal handlers were
 * `process.on('SIGTERM', () => void shutdown())` with no `.catch()`, and on
 * Node 22 an unhandled rejection terminates the process -- so the operator
 * saw `ERR_UNHANDLED_REJECTION` and a stack, not the message the
 * `AggregateError` was carefully constructed to carry.
 *
 * ═══ WHY EVERY STEP, NOT JUST THAT ONE ═══
 * Special-casing `foldOwner.close()` would fix the case that was found and
 * leave the same shape everywhere else -- `worker.close()`, `sweeper.close()`
 * and `pool.end()` all reach out to Redis or Postgres over a network that
 * is, by definition, being torn down around them. The invariant worth
 * having is not "the designed throw is handled", it is "shutdown reaches
 * every step it was given, and says what failed."
 *
 * ═══ AND IT DOES NOT REJECT ═══
 * Deliberately. A caller that must `void` this (a signal handler cannot
 * await) has nowhere to put a rejection except an unhandled-rejection
 * crash, which is the failure this function exists to stop. Failures go to
 * `console.error`, one line each, named.
 */
export async function runShutdown(steps: ShutdownStep[]): Promise<void> {
  for (const step of steps) {
    try {
      await step.run();
    } catch (err) {
      console.error(`shutdown: ${step.name} failed; continuing`, err);
    }
  }
}
