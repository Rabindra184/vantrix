<div align="center">

<img src="docs/images/logo.svg" width="72" height="72" alt="">

# PerfPortal

**Performance clarity over time.**

Self-hosted analytics for [Gatling](https://gatling.io) load tests. Send a run
from CI or stream it live, gate releases on SLAs, and see how every test
trends from one run to the next.

[![CI](https://github.com/Rabindra184/vantrix/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Rabindra184/vantrix/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/Rabindra184/vantrix?sort=semver)](https://github.com/Rabindra184/vantrix/releases)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522-339933?logo=nodedotjs&logoColor=white)](.nvmrc)

[Quick start](#quick-start) ·
[Send a run](#send-your-first-run) ·
[Deploy](DEPLOYMENT.md) ·
[API](docs/api.md) ·
[Architecture](docs/architecture.md)

</div>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/run-summary-dark.png">
  <img src="docs/images/run-summary-light.png" alt="A run's Summary page: a FAILED release gate with the platform gate and simulation assertion that failed it, followed by error rate, request count, peak users and p95, each compared with the previous run.">
</picture>

## Contents

- [Why PerfPortal](#why-perfportal)
- [Features](#features)
- [Quick start](#quick-start)
- [Send your first run](#send-your-first-run)
- [How it works](#how-it-works)
- [Development](#development)
- [Documentation](#documentation)
- [Releases](#releases)
- [Contributing](#contributing)
- [License](#license)

## Why PerfPortal

Gatling writes an excellent report for one run. A team running load tests
every day needs more than that: one place where every run lands, a verdict
CI can fail a build on, and an honest answer to *"is this run better or worse
than the last one?"*

PerfPortal gives every Gatling test a history:

- **Every run in one place**, whether uploaded from CI, streamed while it
  runs, or launched from the UI.
- **A release verdict**, from SLA rules you configure plus the simulation's
  own Gatling assertions.
- **Trends and comparisons** across runs, with a warning when two runs were
  not measured under the same conditions.
- **Numbers that match Gatling's own report.** A parity suite checks the
  counts, timings and error figures against Gatling's reference output.

## Features

### Bring runs in

- **Upload from CI.** Post a Gatling results `.tgz`; the HTTP status is the
  gate (`200` passed, `422` failed).
- **Stream live from Gradle.** The `dev.vantrix.gatling` plugin streams
  `simulation.log` while `gatlingRun` executes, and the run page updates as
  it goes.
- **Run it from the UI.** The on-prem runner executes an uploaded Gatling
  jar or bundle. Keep artifacts as reusable **packages**.
- **Upload in the browser.** Pick a finished bundle on **Add results**.
- **Load-generator telemetry.** A small Go agent reports CPU, memory and
  network from the machines generating load.

### Understand a run

- **Summary:** the verdict and what decided it, headline numbers compared
  with the previous run, and the errors table.
- **Report:** Gatling's charts (throughput, percentiles over time,
  distribution, errors, response-time ranges, virtual users, groups, load
  generators) over a time window you can zoom and pan.
- **Statistics table:** per request and group. Sortable, filterable and
  exportable to CSV; a sorted, filtered view is a shareable URL.
- **Drill-downs, logs and notes:** per-request and per-group pages, the
  runner's lifecycle log, a note on any run, and run numbers per test
  (`Run 12`).

### Gate releases

- **SLA rules** on percentiles, mean, max, error rate, throughput or count,
  for the whole run, a group or a single request; project-wide or for one
  test.
- **Gatling assertions** declared in the simulation are decoded from the log
  and checked again.
- **CI-friendly verdicts.** Upload and poll return the same status for the
  same state, with the evaluation exportable as JSON or CSV.

### Track over time

- **Home:** tests that need attention, a seven-day activity glance, and runs
  per project.
- **Trends:** response status, percentiles and throughput across a test's
  runs. The line breaks where the environment or simulation changed, so
  staging and production are never silently joined.
- **Compare:** overlay up to five runs, with per-request deltas and a
  comparability check.
- **⌘K search:** jump to any test, run (`#12`) or project.

### Run it your way

- **Self-hosted:** one Docker Compose command brings up the app, database,
  queue and object store, and creates the first admin. Optional TLS via the
  bundled Caddy.
- **Access control:** projects, tests, and API tokens with scoped
  permissions and optional expiry.
- **Comfortable to use:** light and dark themes, a phone-friendly summary,
  and interactive API docs at `/v1/docs`.

<table>
  <tr>
    <td width="50%"><img src="docs/images/home.png" alt="Home: tests that need attention, a seven-day activity chart and runs per project"><br><b>Home</b>: what needs attention this week</td>
    <td width="50%"><img src="docs/images/report.png" alt="Report: requests per second and response-time percentiles over time"><br><b>Report</b>: Gatling's charts over a zoomable window</td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/images/trends.png" alt="Trends: response-time percentiles and throughput across eleven runs"><br><b>Trends</b>: one test, run after run</td>
    <td width="50%"><img src="docs/images/compare.png" alt="Compare: two runs overlaid, with per-request deltas"><br><b>Compare</b>: what changed, request by request</td>
  </tr>
</table>

## Quick start

You need **Docker Engine 24+ with the Compose plugin**. Nothing else is
installed on the host.

```bash
git clone https://github.com/Rabindra184/vantrix.git perfportal
cd perfportal
cp infra/.env.example infra/.env

# Generate the required secrets (Compose uses the last value of a repeated key)
cat >> infra/.env <<EOF
PERFPORTAL_DB_PASSWORD=$(openssl rand -hex 24)
PERFPORTAL_S3_SECRET_KEY=$(openssl rand -hex 24)
PERFPORTAL_AUTH_SECRET=$(openssl rand -hex 32)
PERFPORTAL_ADMIN_PASSWORD=$(openssl rand -hex 12)
EOF

docker compose -f infra/docker-compose.yml --profile onprem up -d --build
```

The first build takes a few minutes. Then open **<http://localhost:3000>**
and sign in:

| | |
|---|---|
| **Email** | `admin@perfportal.local` |
| **Password** | the value from `grep ADMIN_PASSWORD infra/.env` |

The first start also creates an org (`perfportal`) and a project (`demo`) to
put runs in.

> [!IMPORTANT]
> Leave `PERFPORTAL_ADMIN_PASSWORD` unset and the admin gets the published
> default `PerfPortal-Setup-2026`, and must choose a new password at first
> sign-in before anything else.

> [!NOTE]
> The `runner` service exits with code 1 until you configure it. That is
> expected: it is the optional on-prem executor. See
> [the runner](DEPLOYMENT.md#optional-the-on-prem-runner).

Serving it on a real hostname, TLS, upgrades, backups and troubleshooting are
covered in the **[deployment guide](DEPLOYMENT.md)**.

## Send your first run

Create a token on the project's **API tokens** page, then pick a path.

### From CI: upload a finished run

Archive the Gatling results directory that holds `simulation.log`, and post
it with a token that has the **Completed reports** (`ingest`) permission:

```bash
tar -czf results.tgz -C build/reports/gatling <run-directory>

curl -sS -X POST "$PERFPORTAL_URL/v1/runs" \
  -H "Authorization: Bearer $PERFPORTAL_TOKEN" \
  -F 'metadata={"tool":"gatling","environment":"staging","branch":"main"}' \
  -F 'bundle=@results.tgz' \
  -o verdict.json -w '%{http_code}\n'
```

The status code is the gate, so CI needs no extra scripting:

| Code | Meaning |
|---|---|
| `200` | Ingested. Every SLA rule passed, or none applied. |
| `422` | Ingested. **The performance gate failed**; the body lists each breach. |
| `202` | Still processing. Poll the `statusUrl` in the body. |
| `400` | The bundle could not be read; the body says why and how to fix it. |

The full contract, including idempotent retries and the `test` field for
running one simulation as several tests, is in the
[API guide](docs/api.md#the-verdict-contract).

### From Gradle: stream it live

Apply the plugin next to Gatling's and give it a token with the **Live run
stream** (`stream`) permission. The run appears as soon as `gatlingRun`
starts:

```kotlin
plugins {
    id("io.gatling.gradle") version "3.15.1.2"
    id("dev.vantrix.gatling") version "<version>"
}
```

```bash
VANTRIX_URL=https://perf.example.com VANTRIX_TOKEN=pp_… ./gradlew gatlingRun
```

The plugin is published to GitHub Packages, which needs a token to download
even from a public repository. Setup is in the
[plugin's README](clients/gatling-gradle/README.md).

### From the UI: launch it on your own hardware

Upload a Gatling jar or bundle as a **package**, then start a run from
**New on-prem run**. The runner executes it and streams the results back.
See [the runner](DEPLOYMENT.md#optional-the-on-prem-runner).

### Optional: watch the load generators

Run the [telemetry agent](agent/README.md) beside Gatling, with a token that
has the **Generator telemetry** permission. Its CPU, memory and network
samples appear in the run's Report.

## How it works

```mermaid
flowchart LR
  ci["CI upload"] --> api
  plugin["Gradle plugin<br/>live stream"] --> api
  browser["Browser"] --> api
  agent["Telemetry agent"] --> api
  api["API + web app"] -->|"bundles · log chunks"| s3[("S3 / MinIO")]
  api -->|"jobs"| redis[("Redis")]
  api --> pg[("PostgreSQL")]
  redis --> worker["Worker<br/>parse · aggregate · judge"]
  worker --> pg
  worker --> s3
  runner["On-prem runner"] --> pg
  runner --> s3
```

- **API** (NestJS): `/v1`, authentication, the live WebSocket feed, and the
  built web app.
- **Worker:** parses Gatling's binary log, computes exact counts and DDSketch
  percentiles, evaluates SLA rules and Gatling assertions, and keeps running
  statistics for live runs. Parsing never happens in the API process.
- **Runner:** an optional single-node executor that launches Gatling and
  tails its log as it is written.
- **Web** (React, Vite, ECharts, Tailwind): served by the API as static,
  precompressed assets.

The full picture, including the live-streaming design and the statistics
model, is in **[docs/architecture.md](docs/architecture.md)**.

### Repository layout

```text
apps/
  api/        HTTP API, auth, OpenAPI, serves the web app
  worker/     ingest pipeline, live fold, sweeper
  runner/     on-prem Gatling executor
  web/        React single-page app
packages/
  core/            event model and error taxonomy (pure)
  contracts/       shared request/response schemas
  plugin-gatling/  simulation.log decoder (pure)
  statistics/      bucketing, percentiles, roll-ups (pure)
  sla/             SLA rule evaluation (pure)
  persistence/     Prisma schema, migrations, repositories, bootstrap
  storage/         S3 blob store and bundle reading
clients/gatling-gradle/   Gradle plugin (Kotlin)
agent/                    load-generator telemetry agent (Go)
infra/                    Docker Compose, Dockerfile, ops scripts
fixtures/                 Gatling reference runs used by the tests
```

## Development

**Prerequisites:** Node 22 ([`.nvmrc`](.nvmrc)), pnpm 9 (via
`corepack enable`), Docker. Go 1.24 for the agent and JDK 21 for the Gradle
plugin, only if you work on those.

```bash
nvm use && corepack enable && pnpm install

# Postgres :5433, Redis :6380, MinIO :9000
export PERFPORTAL_DB_PASSWORD=perfportal PERFPORTAL_S3_ACCESS_KEY=perfportal PERFPORTAL_S3_SECRET_KEY=perfportal123
docker compose -f infra/docker-compose.yml up -d

export DATABASE_URL=postgresql://perfportal:perfportal@localhost:5433/perfportal
export REDIS_URL=redis://localhost:6380
export S3_ENDPOINT=http://localhost:9000 S3_ACCESS_KEY=perfportal S3_SECRET_KEY=perfportal123

pnpm --filter @perfportal/persistence run migrate:deploy   # migrate + generate the Prisma client
pnpm build
pnpm bootstrap my-org my-project --admin-email you@example.test   # prints a token and a password once

pnpm --filter @perfportal/api start &       # http://localhost:3000
pnpm --filter @perfportal/worker start &
```

More detail, including backups and the full environment, is in
[`infra/README.md`](infra/README.md).

### Checks

| Command | What it runs |
|---|---|
| `pnpm typecheck` | TypeScript across every app, package and test project |
| `pnpm lint` | ESLint, including the rules that keep pure packages pure |
| `pnpm test:unit` | Unit and component tests (Vitest, jsdom) |
| `pnpm test:integration` | Integration tests against the local stack |
| `pnpm test:e2e` | Browser tests (Playwright, Chromium); `test:e2e:cross` adds Firefox and WebKit |
| `cd agent && go vet ./... && go test ./... -race` | The telemetry agent |
| `cd clients/gatling-gradle && ./gradlew build` | The Gradle plugin |

Run them in that order. The integration suite truncates every table and the
e2e suite seeds data through the API on port 3000, so point both at a scratch
database, never one holding runs you want to keep.

## Documentation

| Guide | What's in it |
|---|---|
| [Deployment guide](DEPLOYMENT.md) | Requirements, configuration, TLS, upgrades, backup, troubleshooting |
| [API guide](docs/api.md) | Tokens and permissions, sending runs, the verdict contract, live streaming |
| [Architecture](docs/architecture.md) | Components, data flow, statistics, security headers |
| [Local infrastructure](infra/README.md) | The development stack and its scripts |
| [Gradle plugin](clients/gatling-gradle/README.md) | Live streaming from `gatlingRun` |
| [Telemetry agent](agent/README.md) | Load-generator host metrics |
| `/v1/docs` on any instance | Interactive OpenAPI reference |

## Releases

Pushing a `v<semver>` tag publishes:

| Artifact | Where |
|---|---|
| `ghcr.io/rabindra184/perfportal:<tag>` (e.g. `v0.2.0`) and `:latest`, `linux/amd64` | GitHub Container Registry |
| `dev.vantrix:gatling-gradle-plugin:<version>` | GitHub Packages |
| `perfportal-agent-{linux,darwin}-{amd64,arm64}` with `SHA256SUMS` | [GitHub Releases](https://github.com/Rabindra184/vantrix/releases) |

`main` also publishes the plugin's current snapshot on every push.

> [!NOTE]
> **PerfPortal** is the product. **Vantrix** is the namespace of things
> already published under it (the plugin id `dev.vantrix.gatling`, its
> `VANTRIX_*` variables, the Go module path). Those names are kept so
> existing builds don't break.

## Contributing

Branch from `main` and open one pull request back to `main`; it is merged
with a merge commit, so write commit messages that explain *why*. Run the
[checks](#checks) before opening it. The conventions the codebase relies on,
and the reasons behind them, are recorded in [`CLAUDE.md`](CLAUDE.md).

## License

[Apache License 2.0](LICENSE)
