// Deterministic local target for the Gatling parity fixture.
// No dependencies. Latency profiles are seeded so runs are reproducible.

const http = require('http');

let seed = 42;
function rnd() {            // xorshift — deterministic across runs
  seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
  return Math.abs(seed) / 2147483647;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Each route has a distinct latency shape so the distribution histogram,
// percentile bands, and indicator bands all have something real to show.
const routes = {
  '/fast':   () => 15 + rnd() * 25,                          // tight, well under 800ms
  '/medium': () => 120 + rnd() * 180,                         // straddles nothing, mid band
  '/slow':   () => (rnd() < 0.12 ? 1400 + rnd() * 900         // heavy tail -> p99 >> p50
                                 : 400 + rnd() * 300),
  '/spiky':  () => (rnd() < 0.05 ? 2500 : 60 + rnd() * 90),   // rare extreme outlier
};

const server = http.createServer(async (req, res) => {
  const path = req.url.split('?')[0];

  // Two distinct failure modes, so the error table has >1 message to group.
  if (path === '/flaky') {
    await sleep(80 + rnd() * 60);
    if (rnd() < 0.18) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end('{"error":"internal server error"}');
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end('{"ok":true}');
  }

  if (path === '/unstable') {
    await sleep(50 + rnd() * 40);
    if (rnd() < 0.10) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      return res.end('{"error":"service unavailable"}');
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end('{"ok":true}');
  }

  const delay = routes[path];
  if (!delay) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    return res.end('{"error":"not found"}');
  }

  await sleep(delay());
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ path, ok: true }));
});

server.keepAliveTimeout = 65000;
server.listen(8099, '127.0.0.1', () => console.log('target-server listening on 127.0.0.1:8099'));
