const TRANSIENT_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN', 'ENOTFOUND',
  'NetworkingError', 'TimeoutError', 'RequestTimeout', 'SlowDown',
  '53300', // too_many_connections
  '57P01', // admin_shutdown
  '08006', // connection_failure
  '08003', // connection_does_not_exist
  // Prisma's own connection-failure codes. The pipeline reaches the database
  // through Prisma for findByIdUnscoped, markParsing, and
  // RuleRepository.listEnabled — those calls never surface a raw `pg` errno
  // or SQLSTATE, they surface these instead (thrown as
  // PrismaClientInitializationError, whose code lives on `.errorCode`, not
  // `.code` — see the lookup below).
  'P1001', // Can't reach database server
  'P1002', // The database server was reached but timed out
  'P1017', // Server has closed the connection
  // Not a networking or Prisma code -- PipelineService's own signal
  // (RunLockedError, pipeline.service.ts's #handleLockLost) meaning "the
  // live fold owner still holds this run's advisory lock; ask again once it
  // has released it." Genuinely transient in the same sense as the codes
  // above: the condition it names resolves itself within one liveTickMs
  // (<=5s by default) without any action this worker can take, and BullMQ's
  // exponential backoff from 2s comfortably outlasts that wait.
  'RUN_LOCKED',
]);

/**
 * pg-pool's own connect-timeout error (`pg-pool/index.js`'s pending-queue
 * path, `Pool.connect`): a bare `new Error('timeout exceeded when trying to
 * connect')`, with no `.code`, no `.errorCode`, and no distinguishing
 * subclass — there is nothing on it for the code-based lookup below to
 * find, unlike every other entry in `TRANSIENT_CODES`.
 *
 * Newly reachable since fix round 1 gave the worker's shared pool a real
 * `connectionTimeoutMillis` (`main.ts`): pool pressure now fails loud
 * instead of `connect()` hanging forever, which is strictly better, but
 * the resulting rejection was landing on `UnrecoverableError` for lack of
 * anything to match — permanent failure, no retry, for exactly the kind of
 * transient condition (temporary pool pressure) `53300 too_many_connections`
 * above already exists to cover from the server side of the same problem.
 *
 * Matched on the message TEXT, and EXACTLY rather than by substring,
 * deliberately narrow so this cannot swallow an unrelated bare `Error`
 * that merely happens to also lack a `.code` (a bug, a mistyped call, ...)
 * — `isTransient`'s own doc comment is explicit that an unknown error must
 * stay deterministic, and a broader pattern (e.g. matching on "timeout")
 * would risk exactly that, given this function already treats several
 * OTHER kinds of timeout as transient by code alone. This is inherently
 * coupled to pg-pool's own exact wording (pg-pool 3.14.0) and would
 * silently stop matching if a future pg-pool release rephrased it; accepted
 * because the alternative — a looser match — risks the opposite, worse
 * failure of treating a genuine bug as safe to retry three times.
 */
function isPoolConnectTimeout(err: Error): boolean {
  return err.name === 'Error' && err.message === 'timeout exceeded when trying to connect';
}

/**
 * Only transient failures are retried. A parse failure, an unsupported bundle,
 * or a cardinality violation is deterministic: retrying burns a worker slot to
 * reach the identical conclusion. An unknown error is treated as deterministic
 * for the same reason — a bug retried three times is a bug three times.
 *
 * IngestError stays deterministic even if some future code were added to
 * TRANSIENT_CODES that happened to collide with one of its detail fields —
 * the name check below short-circuits before the code lookup runs at all.
 */
export function isTransient(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  if ((err as Error).name === 'IngestError') return false;
  if (isPoolConnectTimeout(err as Error)) return true;
  // PrismaClientKnownRequestError puts its code on `.code`.
  // PrismaClientInitializationError — what connection failures actually are —
  // puts it on `.errorCode` instead; `.code` is absent on that class.
  const code = (err as { code?: unknown }).code ?? (err as { errorCode?: unknown }).errorCode;
  return typeof code === 'string' && TRANSIENT_CODES.has(code);
}
