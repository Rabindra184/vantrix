# Deploying PerfPortal

Run the whole platform on one machine with Docker. A fresh deployment comes up
with a database, an object store, an org, a project, an API token and an admin
account you can sign in with immediately.

> **Raw logs are deleted after 90 days by default, once nothing needs them.**
> From the release that verifies every run, the worker deletes a run's stored
> `simulation.log` once it is older than the retention (90 days after its
> ingest unless you set otherwise) **and** the run no longer needs it: it has
> been verified or settled as not verifiable, any estimated figures have been
> recomputed or the recompute has given up on it, and its verification did not
> find a mismatch. Its figures stay; what goes is the ability to re-verify or
> recompute it. To keep every raw log, set
> `PERFPORTAL_RAW_LOG_RETENTION_DAYS=0` in `infra/.env`. See
> [Raw logs and verification](#raw-logs-and-verification).

- [Requirements](#requirements)
- [Quick start](#quick-start)
- [First sign-in](#first-sign-in)
- [Configuration](#configuration)
- [Before you expose it](#before-you-expose-it)
- [Upgrading](#upgrading)
- [Backup and restore](#backup-and-restore)
- [Troubleshooting](#troubleshooting)
- [Uninstalling](#uninstalling)

---

## Requirements

| | |
|---|---|
| **Docker** | Engine 24+ with the Compose plugin (`docker compose version`) |
| **CPU / RAM** | 2 vCPU and 4 GB is enough to evaluate; 4 vCPU and 8 GB for real load-test volumes |
| **Disk** | 20 GB to start. Runs are stored as compressed bundles plus per-second metrics |
| **Ports** | `3000` for the app. Postgres, Redis and MinIO stay on the internal network |
| **Redis** | The bundled one is 7.x. If you run your own instead, it must be **7.0 or later**: the password-attempt throttle uses `EXPIRE … NX`, which an older server refuses |

Nothing needs to be installed on the host — no Node, no pnpm, no Java. The
image carries all of it.

---

## Quick start

```bash
git clone https://github.com/Rabindra184/vantrix.git perfportal
cd perfportal
cp infra/.env.example infra/.env
```

Set the four values that have no safe default. Run this in your shell, which
generates them and appends them to `infra/.env`; when a key appears twice,
Compose uses the last one:

```bash
cat >> infra/.env <<EOF
PERFPORTAL_DB_PASSWORD=$(openssl rand -hex 24)
PERFPORTAL_S3_SECRET_KEY=$(openssl rand -hex 24)
PERFPORTAL_AUTH_SECRET=$(openssl rand -hex 32)
EOF
```

**Do not type `$(openssl …)` into `infra/.env` itself.** Compose does not run
commands in an env file, so the variable would hold that literal text, and the
API refuses a 26-character auth secret. Use hex rather than base64 for the
database password: it is placed inside `DATABASE_URL`, where a `/` or `+`
would break the URL.

Then bring it up:

```bash
docker compose -f infra/docker-compose.yml --profile onprem up -d --build
```

The first run builds the image and takes a few minutes. When it settles:

```bash
docker compose -f infra/docker-compose.yml --profile onprem ps
```

`postgres`, `redis`, `minio`, `api` and `worker` should be `running`.
`migrate` and `bootstrap` should be `exited (0)` — they are one-shot jobs, and
having finished is what success looks like for them.

Open **<http://localhost:3000>**.

> **`runner` exits with code 1 on a first boot, and that is correct.** It is
> the on-prem Gatling executor and it refuses to start until it knows whose
> jobs it runs. See [the runner](#optional-the-on-prem-runner) below; ignore it
> until you want one.

---

## First sign-in

```
Email     admin@perfportal.local
Password  PerfPortal-Setup-2026
```

### You choose your own password at first sign-in

**The password above is written in this repository, so anybody who can reach
your instance already knows it.** Default credentials are among the most
reliably exploited weaknesses there is — automated scanners try the published
defaults of every product they can fingerprint, and they find new hosts within
hours.

So the account it seeds is flagged: the first thing you see after signing in
is **Choose a new password**, and nothing else works until you have. Until
then every route a session could otherwise reach, except
`PUT /v1/me/password`, answers `403 PASSWORD_CHANGE_REQUIRED`. Bootstrap never
re-passwords an account that already exists, so your choice survives every
later `up`. Change it again any time from the account menu
(**Change password**).

**Better: never seed it at all.** Set your own before the first deployment and
the published default never touches your disk — and, because you chose it, you
are not asked to change it:

```bash
# BEFORE the first `up`; read it back with: grep ADMIN_PASSWORD infra/.env
echo "PERFPORTAL_ADMIN_PASSWORD=$(openssl rand -hex 12)" >> infra/.env
```

This exists because the alternative was worse. Without it, a correct,
healthy deployment came up with no account that could sign in, and the only
documented fix was a command on the host that a deployer using Compose does
not have. The trade is the same one ReportPortal, Grafana and GitLab make.

---

## Configuration

Everything lives in `infra/.env`. Compose reads it automatically for
`-f infra/docker-compose.yml` — note that the file must sit **next to the
compose file**, not at the repository root.

### Required

| Variable | Notes |
|---|---|
| `PERFPORTAL_DB_PASSWORD` | Postgres password. Set before the first `up`; changing it later means recreating the volume |
| `PERFPORTAL_S3_ACCESS_KEY` | MinIO access key |
| `PERFPORTAL_S3_SECRET_KEY` | MinIO secret key |
| `PERFPORTAL_AUTH_SECRET` | Signs session cookies. `openssl rand -base64 32`; under 32 characters is refused |

### The first account

| Variable | Default | Notes |
|---|---|---|
| `PERFPORTAL_ORG_SLUG` | `perfportal` | Created if absent, reused if present |
| `PERFPORTAL_PROJECT_SLUG` | `demo` | Same |
| `PERFPORTAL_ADMIN_EMAIL` | `admin@perfportal.local` | The account you sign in as |
| `PERFPORTAL_ADMIN_PASSWORD` | *(published default)* | **Set this.** Empty seeds `PerfPortal-Setup-2026` |

`bootstrap` runs on every `up` and is idempotent: the org and project are
upserted by slug, and an admin that exists is reused untouched.

**Bootstrap flags an account it creates exactly when nobody chose its
password** — the published default, or one it generated for `--admin-email` —
so its first sign-in leads to *Choose a new password*, and its output says so.
A `PERFPORTAL_ADMIN_PASSWORD` you set is yours, and is not flagged. A re-run
never sets or clears the flag on an account that exists.

### Adding a teammate

Sign-up is closed: nobody can make themselves an account. An admin adds
people in the app: open the account menu, choose **Administration**, then
**Users › Add user**.

- Give an email, a name and a **temporary password**, and choose the projects
  they hold a role in. Hand the password over privately: at first sign-in they
  must choose their own before anything else.
- **Admin** makes them an admin of the whole install, who sees every project
  and manages accounts. Leave it off for everyone else.
- A role is per project, and the API enforces it:

  | Role | Can |
  |---|---|
  | **Viewer** | read the project: runs, tests, SLA rules, members |
  | **Member** | also upload runs, start on-prem runner runs, manage packages, edit SLA rules and run notes |
  | **Manager** | also rename and delete tests, and manage API tokens |

  A project someone holds no role in is invisible to them: it answers as if
  it did not exist.
- Each row's menu edits their projects and roles, **resets their password**
  (a new temporary one; they are signed out everywhere and must choose again),
  **disables** or enables them (disabling signs them out and refuses sign-in),
  makes or removes an admin, and removes the account. The last active admin
  cannot be demoted, disabled or removed.
- **Administration › Projects** lists every project with its member count.
- Each project's **Members** section lists everyone with a role in it. An
  admin adds a person there, changes a role (pick it, then **Save**) and
  removes someone from the project; everybody else reads the list.

The same operations are `/v1/admin/users` and `/v1/projects/{slug}/members`
in the [API](docs/api.md#accounts-passwords-and-roles).

The app shows each person what their role lets them do: a Viewer is offered
no **Add results**, **Add rule**, **New on-prem run**, package actions or run
note editing, a Member no **API tokens**, and only an admin sees **New
project**. Someone on no project yet is told so, and to ask an admin. A role
you change reaches the person's open page at its next read of
`GET /v1/projects`. When an admin resets or disables someone, or removes their
account, the person's open page goes to sign-in on its next request. Removing
someone from a project is not that: the project then answers as if it did not
exist.

### Serving it somewhere other than localhost

| Variable | Default | Notes |
|---|---|---|
| `PERFPORTAL_PUBLIC_URL` | `http://localhost:3000` | The origin a **browser** uses. Sign-in is refused as an invalid origin if this is wrong |
| `PERFPORTAL_DOMAIN` | `localhost` | Hostname for the bundled Caddy, without the scheme |
| `PERFPORTAL_ALLOW_INSECURE_COOKIES` | `false` | Serve sessions over plain HTTP. See below |
| `PERFPORTAL_HTTP_PORT` | `3000` | Host port. Set to `80` to drop the port from the URL |

#### Reaching it from another machine

Two things have to agree, and the second one surprises people.

**1. `PERFPORTAL_PUBLIC_URL` must be exactly what the browser's address bar
shows** — scheme, host and port. It is what the CSRF origin check compares
against, so a mismatch refuses sign-in as an invalid origin.

**2. Over plain HTTP, sessions need `PERFPORTAL_ALLOW_INSECURE_COOKIES=true`.**
The session cookie is `Secure` by default, and a browser will not store a
`Secure` cookie that arrived over HTTP — except from `localhost`, `127.0.0.1`
and `[::1]`, which browsers treat as trustworthy origins.

So a deployment at `http://perfportal.internal:3000` with the default settings
does something worse than fail: the page loads, credentials are accepted,
sign-in returns 200, and every page after that says you are signed out. A
hostname behaves exactly like an IP here; DNS changes nothing.

```bash
# Plain HTTP on a LAN you trust
PERFPORTAL_PUBLIC_URL=http://perfportal.internal:3000
PERFPORTAL_ALLOW_INSECURE_COOKIES=true
```

**On port 80**, so the URL carries no port at all:

```bash
PERFPORTAL_HTTP_PORT=80
PERFPORTAL_PUBLIC_URL=http://perfportal.internal      # NOT :80 — see below
PERFPORTAL_ALLOW_INSECURE_COOKIES=true
```

Write the public URL **without** `:80`. A browser omits a default port from
the `Origin` header, so `http://perfportal.internal:80` never matches what
arrives and sign-in is refused as an invalid origin.

`PERFPORTAL_HTTP_PORT` moves the host side only — the container always listens
on 3000 — and it conflicts with the `tls` profile, whose Caddy binds 80 and
443. Behind TLS, leave it at the default: Caddy reaches the API on the compose
network and it needs no published port.

> **A session cookie sent in the clear can be read and replayed by anyone on
> the path.** That is the whole cost, and it is worth it only on a network
> where you already trust every host. For anything wider, use the `tls`
> profile — it is no more work and none of the exposure. The flag is ignored
> when `PERFPORTAL_PUBLIC_URL` is `https://`, so it cannot downgrade a TLS
> deployment by being left switched on.

**API tokens are unaffected.** CI posting runs, the Gatling plugin and the
on-prem runner all authenticate with `Authorization: Bearer …`, which touches
neither cookies nor the origin check. If only machines need to reach the
instance, plain HTTP over a DNS name works with no flag at all.

### Optional: the on-prem runner

| Variable | Notes |
|---|---|
| `PERFPORTAL_RUNNER_ORG_ID` | UUID — from the bootstrap output or the URL bar |
| `PERFPORTAL_RUNNER_PROJECT_ID` | UUID |
| `PERFPORTAL_RUNNER_ARTIFACT_RETENTION_DAYS` | Defaults to 30 |

Both ids only exist once bootstrap has run, which is why the runner exits on a
first boot. Fill them in, then:

```bash
docker compose -f infra/docker-compose.yml --profile onprem up -d runner
```

### The Gatling agent

The on-prem runner loads a Java agent (`clients/gatling-agent`, shipped in the
image at `/opt/perfportal/gatling-agent.jar`) into **every simulation JVM it
starts**, as the first `-javaagent` option on the command line. It records
what Gatling's own `simulation.log` does not: DNS lookups, TCP connects, TLS
handshakes and connection closes, each response's status code, and once a
second the JVM's garbage collection, heap, Netty memory and bytes sent and
received per remote — plus, on Linux, CPU, memory, the kernel's TCP counters
and the states of Gatling's own sockets. The HTTP events are collected only
under the Gatling version the agent was written for (3.15.1), and so are the
per-remote bytes, the socket states and the Netty memory figures, which come
from the same instrumentation. Under any other version it records garbage
collection and heap, plus CPU, memory and the kernel's TCP counters on Linux,
and says in its file why the rest is missing. It never stops or fails a simulation. It runs for jobs the on-prem
runner executes and, from plugin version 0.3.0, for runs the Gradle plugin
streams (below). A bundle uploaded by hand carries it only if it contains the
file.

The file is written in the job's work directory during the run and stored in
the bucket at `runs/<runId>/agent.ndjson` before the run is closed — also for
a run whose Gatling ended early, never for a cancelled job. A file that cannot
be stored is a warning in the job's log, not a failed job. It is deleted with
the run's raw log, by `PERFPORTAL_RAW_LOG_RETENTION_DAYS` above.

| Variable | Notes |
|---|---|
| `PERFPORTAL_RUNNER_AGENT_JAR` | The agent jar. **Unset means the image's own.** Set it **empty** to run every job without the agent, install-wide. A path the runner cannot read is a warning in each job's log, and the job runs without it |
| `PERFPORTAL_RUNNER_MAX_AGENT_LOG_BYTES` | The most stored for one run, in bytes. Empty, or anything that is not a whole number larger than 1024, means 268435456 (256 MiB). The agent stops writing as its file nears it and ends the file with a `capped` line |

Empty and unset differ for `PERFPORTAL_RUNNER_AGENT_JAR` on purpose: the
compose file reads it as `${PERFPORTAL_RUNNER_AGENT_JAR-…}`, so a line
`PERFPORTAL_RUNNER_AGENT_JAR=` with nothing after it is how the agent is
switched off. Apply either change with
`docker compose -f infra/docker-compose.yml --profile onprem up -d runner`.

**One job at a time:** New on-prem run → Advanced → untick *Collect
connection, DNS and JVM data* (through the API, `"agentEnabled": false` in
either start request: the upload's metadata or the start-from-package body).
A retry keeps the original job's choice.

**From the Gradle plugin.** The `dev.vantrix.gatling` plugin carries the same
agent jar and attaches it to `gatlingRun`'s simulation JVMs — Gatling starts
one JVM per simulation, so each writes its own file — then sends each run its
own file with `PUT /v1/runs/{id}/agent` before it closes the run. That needs
nothing new on the token: the plugin's `stream`-scoped token, the one it
already streams with, is what the API asks for. The API refuses the file once
the run has closed (409) and stores at most:

| Variable | Notes |
|---|---|
| `PERFPORTAL_MAX_AGENT_LOG_BYTES` | The most the API stores of one run's agent file from the plugin, in bytes. Empty, or anything that is not a whole number larger than 1024, means 268435456 (256 MiB) — the runner's own default. A bigger file is refused (413 `AGENT_LOG_TOO_LARGE`) and the run keeps everything else |

The plugin is switched off per build with `vantrix { agent = false }` or
`VANTRIX_AGENT=false` (its README says what it collects and how a file is
matched to its run). Upgrade the API before builds move to plugin 0.3.0: an
older API answers the upload 404, which the plugin logs once per run and
otherwise ignores — the run itself is unaffected, it just has no agent figures.

**Where the figures appear.** At ingest the worker builds the run's agent
figures from the stored file, on the run's own time buckets and with Gatling's
HTTP warm-up left out, and keeps them with the run — so they outlive the raw
log's retention. The API serves them with the read scope:
`GET /v1/runs/{id}/agent` (the agent's header, its remotes and hostnames),
`…/agent/connections`, `…/agent/dns`, `…/agent/injectors` and
`…/agent/status`. A run with nothing to show answers `available: false` and a
reason — `not_collected` for a job run without the agent, `unreadable` with
why, `http_not_collected` when the HTTP events were not recorded — never a row
of zeros. The Report draws them in its Connections, DNS and Load generators
sections. A missing or unreadable agent file never fails the run or changes
its other figures.

Verification checks the agent figures too, each against the stored agent file
(verifier version 3). Upgrading re-checks every run verified by the previous
version whose raw log is still stored, and each keeps its previous answer until
its re-check lands. A run whose agent file was recorded but can no longer be
read from the bucket reads *unverifiable*.

**What it costs.** Storage: about one line per response plus one a second — a
66-second run of 895 requests stored 81,361 bytes — and never more than the
cap above per run. In the measured JVM, on that run: Gatling's CPU time rose
from 7.97 s to 8.96 s (about 12%) and its peak memory from about 277 MB to
about 311 MB; wall-clock time, which the injection profile sets, was 63.8 s
against 64.6 s.

### Raw logs and verification

| Variable | Notes |
|---|---|
| `PERFPORTAL_RAW_LOG_RETENTION_DAYS` | Days after ingest a run's raw log becomes eligible for deletion. **Empty means 90.** `0` keeps raw logs for ever. Anything that is not a whole number of days from 0 to 36500 stops the worker (and the API) at startup, naming the variable |
| `PERFPORTAL_VERIFY_ENABLED` | Empty means on. `false` (exactly that word) defers verification; the backlog is checked once it is switched back on, and the raw logs it needs are kept meanwhile |
| `PERFPORTAL_VERIFY_SCAN_INTERVAL_MS` | How often the worker looks for runs still to verify, in milliseconds. Empty, or anything under 1000 (a second), means every 10 minutes (600000) |
| `PERFPORTAL_GATLING_METHOD_JAR` | The tool that replays Gatling's percentile method. Empty means `/opt/perfportal/gatling-method.jar`, where the image puts it |
| `PERFPORTAL_GATLING_METHOD_TDIGEST_JAR` | t-digest 3.3, the library Gatling's reports use. Empty means `$RUNNER_GATLING_HOME/lib/t-digest-3.3.jar` (`/opt/gatling` in the image) |
| `PERFPORTAL_GATLING_METHOD_SEEDS` | How many replays per run (Gatling breaks ties at random, so its report can change between two renderings). A whole number from 1 to 200; empty or anything else means 16 |
| `PERFPORTAL_GATLING_METHOD_TIMEOUT_MS` | How long the whole replay of one run (every seed) may take before it is stopped, in milliseconds. Empty, anything under 1000, or anything over 2147483647 (the longest a timer can wait), means 300000 (five minutes) |

After every upload and every recompute the worker re-reads the run's stored
`simulation.log` and checks every stored figure against it — each statistic
for the run, every request and group, every time-series bucket, the error
tables and the virtual-user series. The run header then reads **✓ Verified**,
**Verifying…**, **✕ Verification failed** (the panel lists each figure with
its stored and recomputed value) or **Not verified** with the reason, and
**Administration › Data integrity** lists failures and unverifiable runs and
states the retention setting.

The same check replays the run's response times through **Gatling's own
percentile method** (t-digest, as Gatling's HTML report computes them) and
records where that report would print a different percentile from the exact
one. It needs only what the image ships, and the worker says at startup
whether it is available. If it cannot run, the verification still completes
with its own outcome — ✓ Verified or not is never changed by it — and simply
records no differences:

- **A jar is missing** (moved, or a host install that never built it): the
  worker's startup line says "Gatling's method is not available" and names the
  missing file, and no run gets differences until it is restored. Nothing is
  logged per run.
- **`java` is older than 21** (the tool is compiled for Java 21; the image's
  runtime is 21): the startup line still says "available", because it checks
  the two files and not the runtime, and every verification logs one line,
  `verify: run <id>: Gatling's method did not run, so no differences were
  recorded: … UnsupportedClassVersionError …`. Put a Java 21 first on the
  worker's `PATH`.
- **The replay timed out**, or the tool failed: the same one line per run,
  naming the reason.

Upgrading re-checks every run verified by the previous version whose raw log
is still stored, to fill them in. Each run keeps its previous answer — ✓
Verified, or a failure with its list — until its own re-check lands, so the
upgrade never shows a backlog of "Verifying…".

**A run checked while the method could not run is not re-filled** by putting
Java 21 back or restoring a jar: it was verified by the current version, so
the scan has no reason to select it again. To re-check those runs once the
method is available, have the scan pick them up again:

```bash
docker compose -f infra/docker-compose.yml exec postgres \
  psql -U perfportal -d perfportal -c \
  "UPDATE run_verification SET verifier_version = 1
     WHERE gatling_replays IS NULL AND status IN ('verified', 'mismatch')
       AND run_id IN (SELECT id FROM run WHERE raw_log_deleted_at IS NULL);"
```

Each keeps its answer while it waits, as above.

**What it costs.** The replay is one single-threaded JVM per verification, and
its time grows with requests × seeds. Measured at the default 16 seeds on a
soak-shaped input of ten distinct requests: **1 million requests took 9.3 s and peaked
at 245 MB, 2 million took 18.2 s and 337 MB**. A ~900-request run takes well
under a second. The worker also holds the replay's input while the tool runs —
each response time as a number, about 30 MB per million requests, written to
the tool a small chunk at a time — beside the decoded log the verification
already holds, which is the larger of the two. The five-minute timeout is room
for roughly 30 million requests. Lowering
`PERFPORTAL_GATLING_METHOD_SEEDS` trades the width of the range for time, not
memory. The replay runs while the verification holds the run, so a re-ingest or
recompute of that one run waits behind it.

**Deleting a raw log is irreversible, and the worker does it on its own —
but only once nothing needs the log.** The sweeper (every 30 seconds) deletes
a log past retention, oldest first, only when the run:

- has been **verified**, or settled as **not verifiable** — a run the verifier
  has not reached yet, or last checked with an older version of it, keeps its
  log until it is checked;
- has **no estimated figures left to recompute** — a run still carrying ≈
  keeps its log until the exact-statistics backfill recomputes it, or gives up
  on it with a reason (Administration › Data integrity counts those);
- did **not** fail verification — a mismatched run's log is the evidence for
  what went wrong, and a fixed verifier or a recompute needs it, so it is kept.

A run whose verification is still to come reads **Verifying…** in the run
header, and the verification panel names the day retention may delete its log
under the current setting; that day moves with the setting. A run without
statistics (a failed upload) is never verified and its log is deleted on
schedule.

So on an install with history older than the retention, setting
`PERFPORTAL_RAW_LOG_RETENTION_DAYS=0` before upgrading is **optional**: the
backfill and the verifier reach those runs first, and only then are their logs
deleted. Set `0` if you want to keep every raw log regardless.

A large backlog is deleted **at most 500 runs per sweep**, each sweep carrying
on where the last stopped, so the sweeper's other work — finishing live runs
whose producer vanished, re-queueing stuck uploads — is never held up behind
it. Lowering the retention on an install with a hundred thousand old logs
therefore clears them over a couple of hours rather than in one long pass.

`PERFPORTAL_VERIFY_ENABLED=false` defers verification **and keeps the logs it
would need**: while it is off, every run not yet verified reads
**Verifying…** and keeps its raw log, however old. The deletions resume as the
backlog is checked once it is switched back on. The same holds for the
backfill with `PERFPORTAL_RECOMPUTE_ENABLED=false`.

---

## Before you expose it

Localhost is fine for evaluation. For anything reachable by other people:

- [ ] **`PERFPORTAL_ADMIN_PASSWORD` set**, or the default changed in the UI
- [ ] **`PERFPORTAL_AUTH_SECRET`** unique to this deployment
- [ ] **`PERFPORTAL_PUBLIC_URL`** set to the real origin, including `https://`
- [ ] **TLS terminated in front of the app**

TLS is not optional in practice. The session cookie is minted `secure: true`,
so a browser on plain HTTP stores no session at all — sign-in appears to work
and every later request is rejected. Only `localhost` is exempt.

The bundled Caddy will get a certificate for you:

```bash
docker compose -f infra/docker-compose.yml --profile onprem --profile tls up -d
```

Set `PERFPORTAL_DOMAIN` to your hostname and `PERFPORTAL_PUBLIC_URL` to
`https://` plus that hostname first.

---

## Upgrading

```bash
git pull
docker compose -f infra/docker-compose.yml --profile onprem up -d --build
```

Migrations run automatically; `bootstrap` re-runs and changes nothing that
exists. Your data lives in named volumes and is not touched by a rebuild.

**The project-access release cannot be rolled back by image alone.** Its
migration promotes every existing org member to admin and drops
`org_member.role`, which older images read. Under Compose an older image will
not start at all: its `bootstrap` reads that column, fails, and `api` waits on
it. Run directly, it answers every signed-in request with a 500. To go back
past it, restore the backup you took before upgrading
([below](#backup-and-restore)).

**Upgrading to run verification starts deleting raw logs older than 90
days, once nothing needs them.** That release adds
`PERFPORTAL_RAW_LOG_RETENTION_DAYS`, empty means 90. A stored log already past
it is kept until the verifier has checked its run and the exact-statistics
backfill has recomputed (or retired) it, and is never deleted for a run whose
verification found a mismatch — so nothing is deleted before it is checked,
and setting `0` before upgrading is optional. Set `0` to keep every raw log;
see [Raw logs and verification](#raw-logs-and-verification).

**Upgrading past exact statistics: migrate, then the API, then the worker.**
A run the new worker processes stores its histograms in a new format
(`sparse-ms-v2`), and an API still on the old image cannot read it: that
run's Statistics answers a 500 until the API is replaced. The other way round
is safe — an old worker under a new API writes rows the new API reads
correctly, and only that run's "exact" label is wrong (it says exact over
estimated figures). So never let a new worker get ahead of the API.

**A plain `up` does not keep that order.** In `infra/docker-compose.yml` the
worker waits only on `migrate`, while the API waits on `bootstrap`, which
waits on `migrate` — so the new worker can start, and process a run, before
the new API is serving. Run the migration, then the API, then the rest:

```bash
docker compose -f infra/docker-compose.yml --profile onprem run --rm --build migrate
docker compose -f infra/docker-compose.yml --profile onprem up -d --build --no-deps api
docker compose -f infra/docker-compose.yml --profile onprem up -d --build
```

**Upgrading to agent figures (verifier version 3): the same order — migrate,
then the API, then the worker — and the same three commands.** The new worker
verifies agent figures, and when one disagrees it records a mismatch naming one
of the new agent tables (`run_agent`, `run_agent_duration_bucket`,
`run_agent_metric_bucket`). An API still on the old image does not know those
table names and refuses the stored list, so that run's verification panel
(`GET /v1/runs/{id}/verification`) answers a 500 until the API is replaced. The
other way round is safe: an old worker under the new API writes no agent
figures, so its runs read `not_collected` and are verified on their
`simulation.log` alone.

**Runs from before exact statistics are recomputed by themselves.** After the
upgrade the worker finds every run that still carries estimated figures and
recomputes it, exactly, from the log it stored at ingest — one run at a time,
and only while no uploaded or finished run is waiting to be processed, so it
never delays new results. It looks for more every ten minutes. A run's
number, test, note and frozen SLA rules are kept; its statistics and its SLA
rule values are rewritten. If a rule's outcome changes, the run page says so
beside the release gate, with the old and the new value.

To finish the backlog now instead, run it in the foreground. It prints each
run, then a summary:

```bash
docker compose -f infra/docker-compose.yml --profile onprem run --rm worker pnpm recompute
docker compose -f infra/docker-compose.yml --profile onprem run --rm worker pnpm recompute --project <slug>
docker compose -f infra/docker-compose.yml --profile onprem run --rm worker pnpm recompute --run <run id>
```

`--project` matches the slug in **every org on the install**, and says how
many projects and orgs it matched before it starts. Running it beside the
worker is safe: a run the worker is holding is reported `locked` and left to
it.

To defer the backlog, set `PERFPORTAL_RECOMPUTE_ENABLED=false` in
`infra/.env` (exactly that word; empty means on) and `up` again; the worker
then leaves it for `pnpm recompute`. `PERFPORTAL_RECOMPUTE_SCAN_INTERVAL_MS`
sets how often the worker looks for runs still to recompute, in milliseconds
(empty, or anything under 1000, means every 10 minutes).

A run that cannot be recomputed — its stored log is gone, no longer matches
the checksum recorded at ingest, or cannot be parsed — keeps its estimated
figures, and its percentiles are marked **≈**. While runs remain,
Administration says how many, and how many could not be recomputed.

**The release that retires the sketch needs its own upgrade.** It is the one
whose migrations include `20261022120000_drop_run_stat_sketch`, which drops
the stored DDSketch every estimated run's percentiles used to be re-read
from. There is no release tag for it: you are taking it whenever that
migration is still pending when you upgrade — **including when you pull a
later commit**. So before every `git pull`, ask the database which migration
it applied last:

```bash
docker compose -f infra/docker-compose.yml exec -T postgres \
  psql -U perfportal -d perfportal -tAc \
  "SELECT max(migration_name) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL"
```

- **`20261022120000_drop_run_stat_sketch` or later:** you are past it. The
  one-line upgrade above is right.
- **`20261021120000_gatling_replays`:** the schema of commit `200c4843`, the
  last commit before the drop. Finish the backfill, then take the drop on
  its own — both below.
- **Anything earlier:** stop at `200c4843` first. **Never use the two-command
  sequence below from a schema older than `20261015120000_exact_statistics`**:
  there the new worker inserts `run_stat` rows without `sketch`, which is
  still `NOT NULL`, and the new API selects `stats_method`, which does not
  exist yet, so every finished run fails. From any schema before
  `20261021120000_gatling_replays` the new image is missing tables and columns it needs,
  so the rule is the same: check out `200c4843` and upgrade there, in the
  exact-statistics order above —

  ```bash
  git fetch origin
  git checkout 200c4843
  docker compose -f infra/docker-compose.yml --profile onprem run --rm --build migrate
  docker compose -f infra/docker-compose.yml --profile onprem up -d --build --no-deps api
  docker compose -f infra/docker-compose.yml --profile onprem up -d --build
  ```

  — and finish the backfill there.

**Finish the backfill before the drop.** `200c4843` carries the backfill
(#278), the verifier (#279) and the Gatling method (#280). Its worker
recomputes every estimated run in the background, and Administration › Data
integrity shows *Recomputing exact statistics: N of M runs* until it reaches
0. **That line alone is not proof.** It counts the signed-in admin's own org,
and it draws nothing at all when its request fails, so on an install with
more than one org its disappearing says nothing about the others. The
definitive way is the foreground recompute, which walks every org on the
install:

```bash
docker compose -f infra/docker-compose.yml --profile onprem run --rm worker pnpm recompute
```

Run it until a pass ends `Recomputed 0 runs; 0 could not be (…); 0 were
locked …` — nothing left. A run that could not be recomputed is retired with
its estimated figures, marked **≈**, and is not asked for again.

A run still waiting when you take the drop anyway is not lost: until it is
recomputed it answers only the percentile ranks it stored at ingest (each
held inside its own min and max — per request, group and run). A percentile
your project added since is simply absent for it: the run's own statistics
table builds its columns from the ranks its rows carry, so it has no column
for that rank, and only where other runs put the rank on screen — a mixed
trends cohort, Compare — does it show as a gap or a dash. `pnpm recompute`
still works afterwards. A run that could not be recomputed answers the same
way for good.

**For the drop: the API and the worker first, then `migrate`.** This
reverses the usual order on purpose. Its migration drops the `sketch` and
`sketch_kind` columns from `run_stat`. An API or worker still on the older
image fails the moment they are gone: the API answers a 500 on a run's
statistics, and the worker's insert of a finished run's statistics fails with
*column does not exist*, which it does not retry, so that run is marked
failed for good. The new image never reads or writes either column, and on
the `200c4843` schema both are still there and nullable, so it works on
either side of the migration.

**A plain `up` gets this wrong.** In `infra/docker-compose.yml` the worker
waits on `migrate`, and the API waits on `bootstrap`, which waits on
`migrate`, so the one-line upgrade runs the migration while the old API and
worker are still serving. Check out the commit that brought the drop into
`main`, replace those two first without their dependencies, then run the
usual `up`; only then come forward:

```bash
git fetch origin
git checkout "$(git log --first-parent -1 --format=%H origin/main -- packages/persistence/prisma/migrations/20261022120000_drop_run_stat_sketch)"
docker compose -f infra/docker-compose.yml --profile onprem up -d --build --no-deps api worker
docker compose -f infra/docker-compose.yml --profile onprem up -d --build
git checkout main && git pull
docker compose -f infra/docker-compose.yml --profile onprem up -d --build
```

The first `up` builds and restarts only `api` and `worker`, on the schema
they already have (`--no-deps` leaves `migrate`, `bootstrap` and the rest
alone). The second runs the migration and brings up everything else; the
runner never touches `run_stat`. Stopping at that commit is what makes the
reversed order safe: a later commit's API or worker may need a later
migration that has not run yet. From there on, the one-line upgrade is right
again.

**An upgrade sends nobody to *Choose a new password*.** The release that adds
that step adds its flag as `NOT NULL DEFAULT false`, so every account that
already exists comes through unflagged — an admin still signing in with the
published default included. If you never changed it, change it now from the
account menu (**Change password**).

### Keep upgrading at least once a year — the metrics tables are partitioned

The four tables holding time-series metrics (`run_series_bucket`,
`run_error_bucket`, `run_user_bucket`, `telemetry_sample`) are partitioned by
month on the run's own start date, which is what makes retention a cheap
partition drop rather than a mass delete. Partitions are created by
migrations, **a year at a time**, and there is deliberately no catch-all
partition: a row with no home fails the write rather than landing somewhere
retention cannot reach.

**So an instance that stops taking upgrades will stop accepting runs** on the
1st of January after its last partition — not gradually, and not only for new
features. Every run dated past the end fails to ingest, on all four tables at
once, and the error a client sees is the generic 500.

You are unlikely to meet this: the project's own test suite fails **180 days
before** any deployment would, so a release always exists in time. It is
documented because the failure is dated rather than caused, so nothing in
your own change log would predict it.

To see how much runway a running instance has:

```bash
docker compose -f infra/docker-compose.yml exec postgres \
  psql -U perfportal -d perfportal -tAc \
  "select p.relname, max(substring(pg_get_expr(c.relpartbound, c.oid) from 'TO ..([0-9-]+)')) \
     from pg_inherits i join pg_class c on c.oid=i.inhrelid join pg_class p on p.oid=i.inhparent \
    where p.relkind='p' group by 1 order by 1;"
```

Each row's date is the first day that table will refuse. If one is close and
you cannot upgrade, the remedy is one migration's worth of
`CREATE TABLE ... PARTITION OF ...` statements — see
`packages/persistence/prisma/migrations/20260925120000_partitions_2027`.

---

## Backup and restore

Everything durable is in two volumes: `postgres-data` and `minio-data`.

```bash
# database
docker compose -f infra/docker-compose.yml exec -T postgres \
  pg_dump -U perfportal perfportal | gzip > perfportal-$(date +%F).sql.gz

# restore
gunzip -c perfportal-2026-01-01.sql.gz | \
  docker compose -f infra/docker-compose.yml exec -T postgres psql -U perfportal -d perfportal
```

Back up the object store with any S3 client pointed at MinIO; it holds the
uploaded run bundles.

---

## Troubleshooting

**`required variable PERFPORTAL_DB_PASSWORD is missing a value`**
Compose interpolates the whole file before choosing a profile. Copy
`infra/.env.example` to `infra/.env` and fill in the required four.

**The login page rejects correct credentials with "Invalid origin".**
`PERFPORTAL_PUBLIC_URL` does not match the address in your browser's bar. They
must be identical, including scheme and port.

**Sign-in seems to work, then every page says signed out.**
You are on plain HTTP on a non-localhost host, so the browser is discarding a
`Secure` cookie. Put TLS in front of it.

**`runner` is `Exited (1)` and the logs say `Missing required environment
variable RUNNER_ORG_ID`.**
Expected on a first boot. Fill in the two runner ids, or ignore the service.

**A run stays `pending` forever.**
The `worker` container is not running. `docker compose ... logs worker`.

**Changing a password answers an error, for everybody, including the
*Choose a new password* step.**
Redis is down. The password-attempt throttle counts in Redis and fails
closed: while it cannot count, `PUT /v1/me/password` answers `500` rather
than let an attempt through uncounted. Bring Redis back
(`docker compose ... ps redis`); nothing else needs doing.

**Every page answers 403 `PASSWORD_CHANGE_REQUIRED`.**
The account must choose a new password first. Sign in through the web app,
which shows that step, or call `PUT /v1/me/password`.

**Everything broke at once after months of uptime.**
Check inodes, not bytes: `df -i`. Orphaned Docker volumes can exhaust them
while `df -h` still shows free space. `docker volume prune -f`.

---

## Uninstalling

```bash
# stop, keep data
docker compose -f infra/docker-compose.yml --profile onprem down

# stop and delete everything, irreversibly
docker compose -f infra/docker-compose.yml --profile onprem down -v
```

`down -v` removes the database and every stored run bundle.
