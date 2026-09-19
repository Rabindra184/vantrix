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

Nothing needs to be installed on the host — no Node, no pnpm, no Java. The
image carries all of it.

---

## Quick start

```bash
git clone https://github.com/Rabindra184/vantrix.git perfportal
cd perfportal
cp infra/.env.example infra/.env
```

Open `infra/.env` and set the three values that have no safe default:

```bash
PERFPORTAL_DB_PASSWORD=$(openssl rand -base64 24)
PERFPORTAL_S3_ACCESS_KEY=perfportal
PERFPORTAL_S3_SECRET_KEY=$(openssl rand -base64 24)
PERFPORTAL_AUTH_SECRET=$(openssl rand -base64 32)
```

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

### Change that password now

**The password above is written in this repository, so anybody who can reach
your instance already knows it.** Default credentials are among the most
reliably exploited weaknesses there is — automated scanners try the published
defaults of every product they can fingerprint, and they find new hosts within
hours.

Sign in, open the account menu, and change it. Bootstrap never re-passwords an
account that already exists, so your change survives every later `up`.

**Better: never seed it at all.** Set your own before the first deployment and
the published default never touches your disk:

```bash
# in infra/.env, BEFORE the first `up`
PERFPORTAL_ADMIN_PASSWORD=$(openssl rand -base64 24)
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

### Serving it somewhere other than localhost

| Variable | Default | Notes |
|---|---|---|
| `PERFPORTAL_PUBLIC_URL` | `http://localhost:3000` | The origin a **browser** uses. Sign-in is refused as an invalid origin if this is wrong |
| `PERFPORTAL_DOMAIN` | `localhost` | Hostname for the bundled Caddy, without the scheme |

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
