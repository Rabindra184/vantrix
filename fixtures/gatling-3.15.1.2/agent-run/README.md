# A paired agent run: `simulation.log` and `agent.ndjson` from ONE JVM

One real Gatling run with the PerfPortal agent (`clients/gatling-agent`) loaded,
and the two files it produced. Both were written by the same JVM, so their
clocks agree: an agent line's `at` minus the log header's run start is an
offset on the run's own time axis, which is what the agent figures are built
from.

**Recorded 2026-10-24 · Gatling 3.15.1 (`gatling-http` / `gatling-http-client`
3.15.1) · Linux (Docker `eclipse-temurin:21-jdk`, linuxkit aarch64) · OpenJDK
21.0.12.1 · agent 0.1.0, format `perfportal-agent/1`**

## How it was made

`GatlingRunE2ETest.recordsEveryEventOfARealGatlingRun`, run inside
`eclipse-temurin:21-jdk` with `--hostname loadgen-1` and the test's own
`-DkeepDir` hook, which copies the two files only AFTER every assertion in that
case has passed:

```bash
docker run --rm --hostname loadgen-1 -v "$PWD/clients/gatling-agent:/work" \
  -v "$PWD/out:/keep" -w /work eclipse-temurin:21-jdk \
  ./gradlew test --no-daemon \
    --tests 'io.perfportal.agent.GatlingRunE2ETest.recordsEveryEventOfARealGatlingRun' \
    -DkeepDir=/keep
```

(It was run from a copy of `clients/gatling-agent` without `build/` and
`.gradle/`, so the container wrote nothing into the checkout.) Linux is the
point: only there does the agent collect machine figures, and the header reads
`"collects":{"http":true,"machine":true}`.

The simulation is `clients/gatling-agent/src/test/java/probe/ProbeSimulation.java`:
30 users over 3 s (`rampUsers(30).during(3s)`), each making three requests
against servers the test starts on loopback — `Ok` (`GET /ok`, 200), `Missing`
(`GET /missing`, 404, checked as `status().is(404)`) and `Secure` (HTTPS
`GET /ok`, 200) — with a warm-up to the IP literal `127.0.0.1`.

## What it contains

| | |
|---|---|
| `simulation.log` | 2,682 bytes, simulation `probe.ProbeSimulation`, run start `1792800316284`, **90 request records, all OK** (30 × `Ok`, `Missing`, `Secure`), last request end `1792800319909` (3,625 ms after the run start) |
| `agent.ndjson` | 27,000 bytes, 309 lines: 1 `header`, **90 `status`** (60 × 200, 30 × 404 — one per request), 61 `connect`, 61 `close`, 60 `dns`, 30 `tls`, 6 `s` |

The header names the load generator: `"host":"loadgen-1"` (the container's
`--hostname`), `"os":"Linux"`, `"java":"21.0.12.1"`.

Shapes a test against this pair should know about:

- **Warm-up.** One `connect` carries `"warmup":true` — the warm-up request to
  `127.0.0.1/127.0.0.1:<http port>` — and its channel's `close`. Every other
  connect is to `localhost/127.0.0.1:<port>`: 30 to the HTTP port, 30 to the
  HTTPS port. The warm-up is to an IP literal, so it has no `dns` line.
- **No failures.** Every `connect`, `tls` and `dns` is `"ok":true`, and every
  request is OK. The harness's targets are loopback servers that always answer,
  so this run cannot produce a failed connect or DNS lookup, and the simulation
  was deliberately not changed to manufacture one. A KO path needs a
  hand-built input.
- **Samples straddle the run.** The agent starts before Gatling's run does:
  the header's `startedAt` is `1792800314379`, and the first TWO `s` lines
  (`1792800315000`, `1792800316001`) are BEFORE the run start `1792800316284` —
  only the later of them serves, as the predecessor the first in-run delta is
  taken from. The last `s` is the shutdown's `"final":true` sample at
  `1792800319940`, 31 ms after the last request ended.
- **Machine figures** are present on every `s`: `cpu`, `mem`, `tcp`, `gc`,
  `heap`, `netty`, `bytes` per remote, and `states` (empty on the first three
  samples, then per-remote kernel state codes `1` ESTABLISHED and `6` TIME_WAIT,
  ending at 30 TIME_WAIT per remote).
- **The run is short** (~3.6 s, six samples), so most figures fall into a
  handful of 1 s buckets.

The ports (`33357` HTTP, `36137` HTTPS) are the ephemeral ones the test's
servers took on that run; nothing depends on them.
