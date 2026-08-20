# `dev.vantrix.gatling` — the Gradle plugin

Applied beside `io.gatling.gradle`. It opens a live run when `gatlingRun`
starts, streams `simulation.log` to Vantrix as Gatling writes it, and closes
the run when the task finishes (even when the task fails). Watch it happen on
the run's live page while the build runs; read the finished report on the
same page afterwards.

It does not run your test — Gradle/Gatling still does that, exactly as
today. It only ships bytes. See
`docs/superpowers/specs/2026-08-20-gatling-gradle-live-streaming-design.md`
§0 for why that boundary matters.

## Requirements

- **JDK 21+.** The plugin ships Java-21 bytecode (class-file version 65). A
  Gradle daemon running on JDK 17 fails at `apply` with
  `UnsupportedClassVersionError` — before any of the plugin's own error
  handling exists to catch it, so this is the one failure mode that is *not*
  covered by the "never fails the build" guarantee below.
- **Gradle 8.x.**
- **Gradle configuration-cache builds are not supported in 0.1.** Running
  with `--configuration-cache` fails at store time, outside this plugin's
  control — see Failure semantics below.

## Apply it

```kotlin
// settings.gradle.kts
pluginManagement {
    repositories {
        maven {
            url = uri("https://maven.pkg.github.com/Rabindra184/vantrix")
            credentials {
                username = System.getenv("GH_PKG_USER")
                password = System.getenv("GH_PKG_TOKEN") // PAT with read:packages
            }
        }
        gradlePluginPortal()
        mavenCentral()
    }
}
```

```kotlin
// build.gradle.kts
plugins {
    id("io.gatling.gradle") version "3.15.1.2"
    id("dev.vantrix.gatling") version "0.1.0-SNAPSHOT"
}
```

No further wiring is needed — the plugin attaches to whatever task is
literally named `gatlingRun`, and every other setting has an env-var
fallback (see the config table below), so a build file that applies the
plugin and nothing else is a valid, fully-CI-driven configuration.

**The plugin bundles its two runtime libraries (gson, commons-compress)
relocated under `dev.vantrix.gradle.shaded.*`** — its published POM declares
zero dependencies, so nothing it uses can conflict with any other plugin on
your build classpath, whatever versions they carry. A build-time check
(`verifyShadedJar`) fails the plugin's own CI if an unrelocated third-party
class ever leaks into the jar.

**Today, `https://maven.pkg.github.com/Rabindra184/vantrix` is a GitHub
Packages repository, and it REQUIRES authentication to download — measured,
not assumed: an unauthenticated (or under-scoped) request answers 401 even
though the repository is public.** A consumer needs a personal access token
carrying `read:packages`; a `gh` CLI login is typically NOT enough, because
its token lacks that scope. Inside GitHub Actions, the workflow's own
`GITHUB_TOKEN` suffices with `permissions: packages: read` — CI's
`plugin-consume` job is the standing demonstration.

Versioned releases are published by pushing a `v<semver>` tag
(`.github/workflows/release.yml`); `main` republishes `0.1.0-SNAPSHOT` on
every push. **The local-dev path** is `mavenLocal()` plus
`./gradlew publishToMavenLocal` run once from `clients/gatling-gradle/` —
that publishes `dev.vantrix:gatling-gradle-plugin:0.1.0-SNAPSHOT` (and its
plugin marker) to your local Maven cache, which is exactly what
`clients/gatling-gradle/e2e/e2e-project` does (see its `settings.gradle.kts`,
which lists `mavenLocal()` first for that reason).

## Configuration

Everything lives in an optional `vantrix { }` block. Every key falls back to
an env var of the same shape, so CI can configure the build entirely through
its own environment and touch the build file not at all — the DSL value
wins when both are set.

```kotlin
vantrix {
    url = "https://perf.example"     // or VANTRIX_URL
    environment = "staging"           // optional
    branch = "main"                   // optional
    commitSha = "a1b2c3d"             // optional
    tickSeconds = 5                   // optional, default 5
    uploadIfLiveUnavailable = false   // optional, default false — see below
}
```

| `vantrix { }` key | env fallback | default | meaning |
|---|---|---|---|
| `url` | `VANTRIX_URL` | *(required — one of the two must be set)* | Vantrix base URL. A trailing slash is trimmed automatically. If neither is set, the plugin logs why and does nothing else — the build is never failed for it. |
| `environment` | `VANTRIX_ENVIRONMENT` | none | Free-text tag sent when the run opens (e.g. `staging`). |
| `branch` | `VANTRIX_BRANCH` | none | Free-text tag sent when the run opens. Never inferred by shelling out to `git` — a detached CI checkout makes that confidently wrong, and the field is optional in the request schema, so absent beats wrong. |
| `commitSha` | `VANTRIX_COMMIT_SHA` | none | Same reasoning as `branch`. |
| `tickSeconds` | `VANTRIX_TICK_SECONDS` | `5` | How often the tailer polls `simulation.log` and, if there's anything new, ships it. Does not change how often Gatling itself flushes — see Liveness expectations below. |
| `uploadIfLiveUnavailable` | `VANTRIX_UPLOAD_IF_LIVE_UNAVAILABLE` | `false` | Opt-in post-run bundle upload when the live run could never be opened. See its own section below. |
| `resultsDir` | *(none — build-file only)* | `build/reports/gatling` (Gradle's own `layout.buildDirectory`) | Where Gatling writes its results directories. Only needed if your build customises Gatling's own output location away from the default. |

There is no `vantrix.token` key. That is not an omission — see the token
rule.

## The token rule

**`VANTRIX_TOKEN` is the only way to supply the token — an env var, and
nothing else.** `VantrixExtension` has no `token` property at all, so there
is no build-file value that could carry it: `build.gradle.kts` is committed
to git, and a token in it is a token in git history forever, including every
fork and every CI log that ever printed the diff. There is likewise no
`--token` flag, for the same reason this repository's Go load-generator
agent (`agent/cmd/perfportal-agent/main.go`) has no `--token` flag: a
process's command line lands in `ps` output and, on Linux, in the
world-readable `/proc/<pid>/cmdline` — visible to any other local user on a
shared build box — whereas `/proc/<pid>/environ` is readable only by the
process owner. The environment variable is materially safer, not merely a
different convention.

Mint a token with the **`stream`** scope — that alone is enough to open,
feed, and close a live run. Add **`read`** only if you intend to poll the
run's own status yourself (for example, to assert on the final verdict from
a CI script). **If `uploadIfLiveUnavailable` is on, the SAME token also
needs the `ingest` scope** — the fallback POSTs to `/v1/runs`, the batch
ingest endpoint, which the server guards with `@Scopes('ingest')`
independently of `stream`; a `stream`-only token streams live runs fine but
gets a 403 the first time the fallback actually fires. See
`uploadIfLiveUnavailable` below for the full failure shape. One token can
carry any combination of these scopes at once —
`clients/gatling-gradle/e2e/run-e2e.sh` mints a single token with
`scopes: ['stream', 'read']` (it never exercises the fallback, so it has no
need of `ingest`) and the script uses
that same value both as `VANTRIX_TOKEN` for the plugin and to poll the run
it opened.

## Liveness expectations

Gatling writes `simulation.log` through
`io.gatling.core.stats.writer.BufferedFileChannelWriter`, which flushes in
**8 KiB blocks, not per record.** The plugin cannot see a record before
Gatling itself has written it to disk. Sampling a real ~95s run of
`example.BasicSimulation` at ~18 req/s, reading `simulation.log`'s size
every 5s, measured:

```
t+20s        0 bytes          <- nothing at all for the first 20 seconds
t+25s     8191
t+40s    16383                <- +8 KiB
t+50s    24574
t+60s    32764
t+75s    49146
t+95s    65529                <- steady 8 KiB steps
t+115s   66826                <- final partial block, only at close
```

Two consequences follow directly, and neither is a defect in this plugin:

- **A low-throughput test updates rarely.** Update cadence tracks how fast
  the run fills 8 KiB of Gatling's own buffer, not the plugin's
  `tickSeconds`. A 5 req/s smoke test may show nothing on the live page for
  a minute at a time.
- **The tail of every run arrives in one step, at close.** Gatling flushes
  its final partial block only when it closes the file, so the last handful
  of requests always appear together, right before the run finishes.

If a run looks "laggy" on the live page, check throughput and elapsed time
against the table above before filing it as a bug — it is very likely
Gatling's own buffering, not a delivery problem on this plugin's side. The
plugin still ships whatever bytes exist on every tick, including a partial
8 KiB block; the server's `StreamingLogDecoder` already retains a partial
record at a chunk boundary, so a partial flush is not a new case.

## Failure semantics

**The build never fails because of this plugin's own runtime behaviour.**
Every action the tailer and its finalizer take is wrapped in a swallowed
`try/catch` — streaming is best-effort observability, and losing it must
never cost anyone a 40-minute soak or a blocked deploy. Each situation gets
its own response rather than one blanket catch:

| Situation | Response |
|---|---|
| Open fails (unreachable, 401, 403) | Warn with the API's own `remediation` (or the first 200 chars of the body); skip streaming for that simulation; the Gradle task proceeds untouched |
| Stream POST fails (network, or a 5xx) | Retries up to 3 attempts total, sleeping 1s then 2s between them (no sleep after the third and final attempt); gives up quietly after that; `close` is still attempted at the end |
| `409` on a stream POST | Not an error — resume from the `nextOffset` the response names, no retry needed |
| Any other non-2xx/409/401/403 status (e.g. an unexpected `413`) | Should not occur in normal operation — reads are capped at 4 MiB, half the server's `MAX_STREAM_CHUNK_BYTES`. Logged loudly as a bug; that chunk is abandoned |
| `401`/`403` on a stream POST | Stops immediately, no retry — a bad or revoked token will not fix itself on the next tick. This gates the tailer's whole tick loop, not just the current run: directory *discovery* is skipped too, so one auth failure halts streaming for every remaining simulation in that `gatlingRun` execution, not only the one being streamed when it happened |
| Build killed (no graceful shutdown) | There is deliberately no JVM shutdown hook — a hook racing JVM teardown is worse than letting the designed path run. `close` never executes; the server's sweeper ages the run out of `running` on `stream_updated_at` and finalizes it `incomplete` |
| A results directory's `open()` call fails | Recorded as an "open failure" for that directory; if `uploadIfLiveUnavailable` is on, its `simulation.log` is uploaded as a batch bundle once the task finishes (see below) |

This guarantee covers the plugin's own code paths only — it does not cover
the Requirements above. A JDK 17 daemon fails with
`UnsupportedClassVersionError` before the plugin's `apply()` ever runs, so
there is no `try/catch` here to catch it, and **Gradle configuration-cache
builds are not supported in 0.1**: `VantrixPlugin` reads `System.getenv()`
and resolves `resultsRoot` from inside a task action rather than at
configuration time (see its class doc), so a build run with
`--configuration-cache` fails at store time — after the task graph has
already executed, outside this plugin's own error handling entirely.

## Two things the real end-to-end run found

Two behaviours only showed up once this plugin talked to a real Vantrix
stack rather than the fake HTTP server the unit tests use — worth knowing
before you file either as a bug.

**The client pins HTTP/1.1, on purpose.** The platform's live endpoints are
plain HTTP, served by Node today. `java.net.http.HttpClient`'s default
version preference is HTTP_2, and for a cleartext `http://` URI that means
every request first attempts an h2c (HTTP/2-over-cleartext) upgrade. Node's
`http` server does not speak h2c and resets the connection on that exact
upgrade attempt, after zero response bytes — on every single call, with no
partial success. `LiveClient` therefore builds its shared `HttpClient` with
`.version(HttpClient.Version.HTTP_1_1)` explicitly, which removes the
upgrade attempt entirely. The one deliberate trade-off: pinning HTTP/1.1
also forecloses ALPN-negotiated h2 against a possible future HTTPS
endpoint — accepted because the live endpoints are plain HTTP today, and
h2c is exactly what breaks against them; revisit the pin if the live
endpoints ever move behind TLS.

**Results-directory recognition is a snapshot taken once per task
execution, not a wall-clock filter — so nothing needs cleaning between
runs.** `RunTailer` records the *names* of every results directory already
present under `resultsDir` the moment it is constructed (in `gatlingRun`'s
`doFirst`, strictly before Gatling's own task action can create anything),
and only a directory absent from that snapshot is ever treated as new. A
stale directory left over from an earlier `gatlingRun` — including one from
a previous JVM/CI run entirely — is never re-streamed, because it was
already on disk (and therefore already in the snapshot) before this
execution's tailer was constructed. You do not need to, and should not need
to, delete `build/reports/gatling` between runs for the plugin to behave
correctly.

## `uploadIfLiveUnavailable`

Default **off**. When a simulation's live run could never be opened (bad
token, unreachable Vantrix, an outage — anything that made `open()` return
null), this flag tells the plugin's finalizer to tar and gzip that
simulation's finished `simulation.log` and POST it to `/v1/runs` — the same
batch-ingest endpoint a manual upload would use — after `gatlingRun`
completes. The run then shows up late instead of not at all.

**This POST needs the `ingest` scope, separately from `stream`.** `/v1/runs`
is guarded by `@Scopes('ingest')` (`apps/api/src/ingest/ingest.controller.ts`),
which a token minted for streaming alone does not have — see the token rule
above. Turning this flag on without also adding `ingest` to the token means
the fallback fires, 403s, and the simulation is lost exactly as before,
just with an extra failed HTTP call and a warning in the log.

**A duplicate is possible, and that is a known, accepted trade-off, not
silent data loss.** If a live `open()` call actually succeeds on the server
but its 201 response is lost in transit (a rare but real failure mode —
timeout, connection reset after the response was sent), the plugin sees
`open()` return null, records an open failure, and — with this flag on —
uploads the completed `simulation.log` as a batch bundle. Meanwhile the
platform still holds the orphaned live run it already opened; its sweeper
eventually finalizes that one `incomplete` once `stream_updated_at` goes
stale. The result is two runs for one simulation: one `incomplete` (empty),
one `complete` (from the fallback). Know to expect this rather than treat
it as a bug when it shows up.

It is off by default deliberately, not by oversight: it is a **second code
path with its own failure mode** (a separate HTTP call, a separate
multipart body, its own retry-less one-shot semantics), and **a run
appearing minutes after the test finished is a genuinely different thing
from the run this plugin announced at the start** — a reader watching the
live page during the test saw nothing, and the fallback run was never
"live" in any sense. Teams who would rather have guaranteed capture than
that distinction should opt in explicitly.

The upload is capped client-side at **512 MiB** — the same number as the
server's own `MAX_BUNDLE_BYTES` default (`apps/api/src/config.ts`,
`maxBundleBytes`). A `simulation.log` over that is skipped with a logged
reason rather than sent, since the server would answer 413 anyway. **This
is a constant, not a live lookup** — if a server operator raises their own
`MAX_BUNDLE_BYTES`, this plugin's 512 MiB cap does not follow automatically
and needs its own update.

## The end-to-end test

`clients/gatling-gradle/e2e/run-e2e.sh` is the real-stack gate: a real
Gatling run, streamed live by this plugin, into a real running Vantrix (API
+ worker + Postgres/Redis/MinIO), asserting the run reaches `complete` with
re-evaluated assertions matching the fixture simulation's deliberately
mixed pass/fail shape. It is **manual, on demand** — it is not part of any
`pnpm` gate and not part of the CI `plugin` job, because it needs a seeded
local stack. Prerequisites: the Docker Compose stack up
(`docker compose -f infra/docker-compose.yml up -d`), the API and worker
both running against it, Node 22+ on `PATH`, and a JDK 21 `JAVA_HOME`. Run
it from `clients/gatling-gradle/e2e/`; it prints its own remediation for
whichever prerequisite is missing.
