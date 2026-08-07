const TRANSIENT_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN', 'ENOTFOUND',
  'NetworkingError', 'TimeoutError', 'RequestTimeout', 'SlowDown',
  '53300', // too_many_connections
  '57P01', // admin_shutdown
  '08006', // connection_failure
  '08003', // connection_does_not_exist
]);

/**
 * Only transient failures are retried. A parse failure, an unsupported bundle,
 * or a cardinality violation is deterministic: retrying burns a worker slot to
 * reach the identical conclusion. An unknown error is treated as deterministic
 * for the same reason — a bug retried three times is a bug three times.
 */
export function isTransient(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  if ((err as Error).name === 'IngestError') return false;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' && TRANSIENT_CODES.has(code);
}
