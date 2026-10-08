# Deploying PerfPortal

Run the whole platform on one machine with Docker. A fresh deployment comes up
with a database, an object store, an org, a project, an API token and an admin
account you can sign in with immediately.

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
no **Add rule**, **New on-prem run** or package actions, a Member no **API
tokens**, and only an admin sees **New project**. Someone on no project yet is
told so, and to ask an admin. A role you change takes effect on the person's
next page load. When an admin resets, disables or removes someone, the
person's open page goes to sign-in on its next request.

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
