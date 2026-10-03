import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { LOOPBACK, listenOnLoopback } from './support/loopback.js';

/**
 * ═══ A TEST SERVER LISTENS ON 127.0.0.1, NAMED, OR NOT AT ALL ═══
 *
 * The recurring `501 {}` this repository's CLAUDE.md read for months as "the
 * machine answering under load" was a different process answering. LogiPlugin
 * listens on `127.0.0.1:60503`, `:60505` and `:60507` and returns 501 with an
 * empty body to every method. supertest, handed a server that is not
 * listening, calls `listen(0)` — the WILDCARD address on an ephemeral port —
 * and then connects to `127.0.0.1:<port>`. macOS lets a wildcard bind take a
 * port a specific `127.0.0.1` listener already holds, and a connection to
 * `127.0.0.1` reaches the more specific listener: the other process.
 * Measured: `listen(0)` landed on a held port 3 times in 20,000, which is
 * 3 / 16,384, the ephemeral range.
 *
 * A server bound to `127.0.0.1` cannot be handed a port another `127.0.0.1`
 * listener holds, so every test server binds there, and the setup file
 * (`./support/loopback-guard.ts`) refuses the shape that caused this rather
 * than trusting each suite to remember.
 */

const opened: http.Server[] = [];
afterEach(async () => {
  await Promise.all(
    opened.splice(0).map((s) => new Promise<void>((done) => (s.listening ? s.close(() => done()) : done()))),
  );
});

function squatter(): Promise<http.Server> {
  return listenOnLoopback((_req, res) => {
    res.writeHead(501).end();
  }).then((s) => {
    opened.push(s);
    return s;
  });
}

describe('test servers bind the loopback address', () => {
  it('refuses a listen on an ephemeral port that names no host — the shape supertest falls back to', () => {
    const server = http.createServer();
    opened.push(server);
    // If the guard were not installed this would quietly bind the wildcard
    // address, and every case below would be measuring nothing.
    expect(() => server.listen(0)).toThrow(/127\.0\.0\.1/);
    expect(() => server.listen()).toThrow(/127\.0\.0\.1/);
    expect(server.listening).toBe(false);
  });

  it('lets a loopback listen through, on the address it names', async () => {
    const server = await listenOnLoopback((_req, res) => res.end('ours'));
    opened.push(server);
    expect(server.address()).toMatchObject({ address: LOOPBACK, family: 'IPv4' });
  });

  it('cannot be handed a port another loopback listener already holds', async () => {
    const held = (await squatter()).address() as AddressInfo;
    const second = http.createServer();
    opened.push(second);
    const outcome = await new Promise<string>((done) => {
      second.once('error', (e: NodeJS.ErrnoException) => done(e.code ?? 'error'));
      second.listen(held.port, LOOPBACK, () => done('listening'));
    });
    expect(outcome).toBe('EADDRINUSE');
  });

  /**
   * The defect itself, kept as evidence. Only macOS behaves this way — Linux
   * refuses the wildcard bind outright — so the case runs only there.
   */
  it.runIf(process.platform === 'darwin')(
    'on macOS a wildcard listener CAN share a held loopback port, and 127.0.0.1 reaches the other process',
    async () => {
      const held = (await squatter()).address() as AddressInfo;
      const wildcard = http.createServer((_req, res) => res.end('ours'));
      opened.push(wildcard);
      // An explicit port is allowed through the guard; only the ephemeral
      // no-host shape is refused.
      await new Promise<void>((done, fail) => {
        wildcard.once('error', fail);
        wildcard.listen(held.port, () => done());
      });
      const res = await fetch(`http://${LOOPBACK}:${held.port}/`, { method: 'POST' });
      expect(res.status).toBe(501);
      expect(await res.text()).toBe('');
    },
  );
});
