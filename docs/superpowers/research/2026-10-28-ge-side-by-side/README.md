# GE report parity: the side-by-side proof

Check 3 of `docs/superpowers/specs/2026-10-22-ge-report-parity-design.md`
section 9: one simulation run once on Gatling Enterprise and once through
PerfPortal on each path, the two reports compared. They should "agree in which
series exist and in kind and magnitude, not to the digit".

**Result: they do, with three differences that are explained below and one
that turned out to be a PerfPortal defect.** The proof also found three other
defects, listed at the end; none of them is fixed in this branch.

## What was run

All five runs are `example.BasicSimulation` from Gatling's own demo project
(`gatling-gradle-plugin-demo-kotlin`), Gatling 3.15.1, against
`api-ecomm.gatling.io`, 2026-10-28.

| Folder | Path | Generator | Run |
|---|---|---|---|
| `ge-run-2/` | Gatling Enterprise, package `perfportal-parity-demo` | one managed generator, Europe - Paris | test `perfportal-parity-basic`, Run 2 |
| `plugin-e2e-project-mac/` | Gradle plugin 0.3.0-SNAPSHOT, `clients/gatling-gradle/e2e/e2e-project` | this Mac (macOS, Java 21.0.11), India | `66bc422b` |
| `plugin-demo-project-mac/` | Gradle plugin 0.3.0-SNAPSHOT, the demo project itself, `--no-configuration-cache` | this Mac | `14c7ce2d` |
| `runner-linux-jdk-tls/` | on-prem runner in the `infra/Dockerfile` image, the same jar GE ran | Docker Linux aarch64, Java 21.0.13 | `c5ed901e` |
| `runner-linux-boringssl/` | the same, with `-Dio.netty.native.workdir` on the job (see "Sent bytes") | the same container | `6108dcb3` |

`ge-run-2/` is the JSON behind every GE report chart, recorded over a debug
Chrome's DevTools port as in section 2 of the spec; the user record is
redacted the same way `2026-10-22-ge-report-captures/` redacts it. Each
PerfPortal folder is the response of the ten read endpoints the Report draws
from (`/v1/runs/:id`, `/stats`, `/users`, `/errors`, `/series`, and the five
`/agent*` routes). The Mac hostname is replaced with `dev-mac.local`.

Two other runs were made and are left out on purpose: `ae5ec7b2`, which met
the target's rate limiter for its whole length (every response 403), and
`d064ecab`, a stray macOS runner job.

## The table

Regenerate it with

```
python3 compare.py ge-run-2 plugin-e2e-project-mac plugin-demo-project-mac runner-linux-jdk-tls runner-linux-boringssl
```

| Figure | GE | plugin e2e (Mac) | plugin demo (Mac) | runner Linux, JDK TLS | runner Linux, BoringSSL |
|---|---|---|---|---|---|
| Requests total | 1724 | 1736 | 1724 | 1738 | 1704 |
| Error ratio % | 16.76 | 15.38 | 18.33 | 15.71 | 21.24 |
| Status codes | 200/401/403/404 | same set | same set | same set | same set |
| Users started (Browse / Checkout) | 300 / 180 | 300 / 180 | 300 / 180 | 300 / 180 | 300 / 180 |
| Connections opened/closed | 480/480 | 479/479 | 480/480 | 480/480 | 480/480 |
| Bits sent/received (Mb) | 9.6/24.1 | 9.6/24.2 | 9.6/23.9 | **6.0**/24.2 | 9.5/23.6 |
| p50 / p95 response ms | 44 / 321 | 272 / 1933 | 252 / 899 | 264 / 1735 | 251 / 832 |
| TCP connect p50 / p95 ms | 1 / 2 | 210 / 10003 | 191 / 10001 | 198 / 10001 | 192 / 10001 |
| TLS handshake p50 ms | 3 | 230 | 205 | 213 | 204 |
| TCP connect KO | 0 | 42 | 40 | 34 | 35 |
| DNS lookups | 17 | 480 | 480 | 480 | 480 |
| Remotes | 6 | 3 | 3 | 3 | 3 |
| TCP states series | 11 | not Linux | not Linux | 9 | 9 |
| TCP events, TCP segments | present | not Linux | not Linux | present | present |
| CPU user+sys peak % | 26 | not Linux | not Linux | 12.2 | 14.4 |
| RAM used peak / total GB | 4.3 / 7.6 | not Linux | not Linux | 1.8 / 7.7 | 1.8 / 7.7 |
| GC collectors | ZGC, 4 series | G1, 3 | G1, 3 | G1, 3 | G1, 3 |

The full table, every row the script computes, is what `compare.py` prints.

## What agrees

Every series GE draws exists in PerfPortal on the Linux runner: connections,
bandwidth, TCP connect and TLS handshake durations, TCP states, DNS, GC, CPU,
memory, TCP events and segments, and responses by status. On the Mac the
machine series are absent and the Report says why, as the spec requires.

The figures that depend only on the simulation agree: the request count to
within 1%, the users each scenario started exactly, the same four status
codes, 480 connections opened and closed, and bytes received to within 2%.

## What differs, and why

**Latency, on every timing figure.** GE's generator is in Paris and the
target's AWS region is Paris; ours is in India. A TCP connect takes 1 ms there
and about 200 ms here, and the 10-second p95 is the 34 to 42 connects that
timed out. The kind and shape match (one TLS handshake per connection, the
same percentile rows); the magnitude is geography. The error ratio moves with
the target's rate limiter, which answers 403 for several minutes after each
run: the BoringSSL run's 136 403s against GE's 59 are that.

**DNS, 480 against 17.** Not a fault on either side. Gatling resolves the host
again for every new connection, 480 times for one hostname, and the agent
counts every call into the resolver. On the Linux run the median call took
50 µs and only 3 of 480 took longer than 1 ms: the JDK answered almost all of
them from its own cache. GE's 17 most likely counts only lookups that reached
a DNS server. The two figures answer different questions and are not to be
read against each other.

**Remotes, 6 against 3.** The target is behind several AWS addresses and a
resolver hands out a subset; the Paris generator was given more of them.

**Machine figures in kind, not magnitude.** GE's generator ran ZGC on a
3.9 GB heap; ours ran G1 on 1 to 2 GB. Our TCP events `established` (1,278)
is higher than GE's (491) because, at 200 ms per round trip, more sockets are
open at once; it is the same per-second gauge summed on both sides.

## Sent bytes: the difference that was a defect

On the Linux runner, bits sent read **6.0 Mb** against GE's 9.6, while both
Mac runs read 9.6. Received agreed everywhere, and the shortfall was about
940 bytes per connection, the size of a post-quantum key share
(X25519MLKEM768) in a TLS ClientHello.

The cause is the runner's container. `infra/docker-compose.yml` gives the
runner service `tmpfs: - /tmp`, Docker mounts a tmpfs `noexec` by default,
and netty-tcnative unpacks its BoringSSL library into `java.io.tmpdir` before
loading it. Measured inside the running container:

```
/tmp as shipped (noexec tmpfs)          OpenSsl.isAvailable() = false
                                        Failed to load any of the given libraries:
                                        [netty_tcnative_linux_aarch_64, ...]
-Dio.netty.native.workdir=<ext4 volume> OpenSsl.isAvailable() = true, BoringSSL
```

So every on-prem runner job runs Gatling on the JDK's TLS, silently, where GE
and a plain `gatlingRun` use BoringSSL. That changes the load test itself, not
just the figure: a different TLS stack with different CPU cost and different
handshakes. The `runner-linux-boringssl` run passes the work directory through
the job's own `javaOptions`, and bits sent reads **9.5 Mb**.

## Defects found, each its own branch

1. **The runner loses BoringSSL** (above). Move Netty's native directory off
   `/tmp` in the runner's default JVM options, or mount `/tmp` executable.
2. **The runner leaks every job's results directory.** Gatling, running as
   uid 20001, creates `results/<simulation>/` with mode 755, and the runner
   (root with `cap_drop: ALL`, so no `CAP_DAC_OVERRIDE`) cannot unlink inside
   it: `failed to clean work dir: EACCES ... unlink .../simulation.log` on
   every job.
3. **The Gradle plugin breaks under Gradle's configuration cache.** Gatling's
   demo project ships `org.gradle.configuration-cache=true`. With it, the
   agent never attaches (`AgentLauncher` reads `Task.project` at execution
   time) and the build fails with three configuration-cache problems
   (`vantrixClose` and the `gatlingRun` hook capture `Project`), breaking the
   plugin's own rule that it must never be the reason a build fails. The run
   itself still streams and completes. The demo-project leg here was run with
   `--no-configuration-cache` for that reason.
4. **The agent counts resolver calls, not DNS lookups.** Not a correctness
   defect, but the DNS charts will read 480 where GE reads 17 for the same
   test. Whether to count only lookups that miss the JDK cache is a product
   decision.

The Report was not opened in a browser for these runs; the comparison is of
the data behind each chart, on both sides.
