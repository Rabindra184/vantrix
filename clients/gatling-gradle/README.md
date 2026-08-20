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

## Apply it

```kotlin
// settings.gradle.kts
pluginManagement {
    repositories {
        maven {
            url = uri("https://maven.pkg.github.com/Rabindra184/vantrix")
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

**Today, `https://maven.pkg.github.com/Rabindra184/vantrix` is a GitHub
Packages repository** — resolving from it may require the consumer to be
authenticated to GitHub Packages themselves, same as any other GitHub
Packages consumer. **The local-dev path** is `mavenLocal()` plus
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
a CI script, the way `clients/gatling-gradle/e2e/run-e2e.sh` mints a second,
separate read-scoped token to poll what the stream-scoped token opened).

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

**The build never fails because of this plugin.** Every action the tailer
and its finalizer take is wrapped in a swallowed `try/catch` — streaming is
best-effort observability, and losing it must never cost anyone a 40-minute
soak or a blocked deploy. Each situation gets its own response rather than
one blanket catch:

| Situation | Response |
|---|---|
| Open fails (unreachable, 401, 403) | Warn with the API's own `remediation` (or the first 200 chars of the body); skip streaming for that simulation; the Gradle task proceeds untouched |
| Stream POST fails (network, or a 5xx) | Retries up to 3 attempts total, waiting 1s / 2s / 4s between them; gives up quietly after that; `close` is still attempted at the end |
| `409` on a stream POST | Not an error — resume from the `nextOffset` the response names, no retry needed |
| Any other non-2xx/409/401/403 status (e.g. an unexpected `413`) | Should not occur in normal operation — reads are capped at 4 MiB, half the server's `MAX_STREAM_CHUNK_BYTES`. Logged loudly as a bug; that chunk is abandoned |
| `401`/`403` on a stream POST | Stops streaming immediately for that run, no retry — a bad or revoked token will not fix itself on the next tick |
| Build killed (no graceful shutdown) | There is deliberately no JVM shutdown hook — a hook racing JVM teardown is worse than letting the designed path run. `close` never executes; the server's sweeper ages the run out of `running` on `stream_updated_at` and finalizes it `incomplete` |
| A results directory's `open()` call fails | Recorded as an "open failure" for that directory; if `uploadIfLiveUnavailable` is on, its `simulation.log` is uploaded as a batch bundle once the task finishes (see below) |

## `uploadIfLiveUnavailable`

Default **off**. When a simulation's live run could never be opened (bad
token, unreachable Vantrix, an outage — anything that made `open()` return
null), this flag tells the plugin's finalizer to tar and gzip that
simulation's finished `simulation.log` and POST it to `/v1/runs` — the same
batch-ingest endpoint a manual upload would use — after `gatlingRun`
completes. The run then shows up late instead of not at all.

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
