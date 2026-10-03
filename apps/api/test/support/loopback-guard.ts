import http from 'node:http';

/**
 * A SETUP FILE: refuses the one listen shape that let another process answer
 * this suite's requests.
 *
 * supertest, given a server that is not listening, calls `listen(0)` — an
 * ephemeral port on the WILDCARD address — and then connects to
 * `127.0.0.1:<port>`. macOS lets that wildcard bind share a port a specific
 * `127.0.0.1` listener already holds, and the connection reaches the more
 * specific listener. LogiPlugin holds three such ports and answers every
 * request `501` with an empty body, which this repository's CLAUDE.md
 * recorded for months as "the machine answering under load".
 *
 * So a test server must name its host. `listen(0)` and a bare `listen()` with
 * no host throw here, naming the fix; an explicit host, an explicit port, or
 * a socket path pass through untouched. Only `http.Server` is patched — the
 * class supertest creates — so nothing outside a test's own servers is
 * affected. The guard has its own witness: loopback.test.ts's first case
 * fails if this file is not loaded.
 */
const listen = http.Server.prototype.listen;

function wildcardEphemeral(args: unknown[]): boolean {
  const [first, second] = args;
  if (first === undefined || typeof first === 'function') return true;
  if (typeof first === 'number') return first === 0 && typeof second !== 'string';
  if (typeof first === 'object' && first !== null) {
    const opts = first as { port?: unknown; host?: unknown; path?: unknown };
    if (opts.path !== undefined) return false;
    return (opts.port === undefined || opts.port === 0) && opts.host === undefined;
  }
  return false;
}

http.Server.prototype.listen = function guardedListen(this: http.Server, ...args: unknown[]) {
  if (wildcardEphemeral(args)) {
    throw new Error(
      'A test server must listen on 127.0.0.1, named: listen(0) with no host binds the wildcard ' +
        'address, which can share a port another process holds on 127.0.0.1 and send this ' +
        "request to it. Use listenOnLoopback / listenNestOnLoopback from apps/api/test/support/loopback.ts, " +
        'or hand supertest a server that is already listening.',
    );
  }
  return (listen as (...a: unknown[]) => http.Server).apply(this, args);
} as typeof http.Server.prototype.listen;
