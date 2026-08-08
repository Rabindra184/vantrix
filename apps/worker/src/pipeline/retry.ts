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
]);

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
  // PrismaClientKnownRequestError puts its code on `.code`.
  // PrismaClientInitializationError — what connection failures actually are —
  // puts it on `.errorCode` instead; `.code` is absent on that class.
  const code = (err as { code?: unknown }).code ?? (err as { errorCode?: unknown }).errorCode;
  return typeof code === 'string' && TRANSIENT_CODES.has(code);
}
