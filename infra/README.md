# Local infrastructure

    export PERFPORTAL_DB_PASSWORD='change-me'
    export PERFPORTAL_S3_ACCESS_KEY='change-me'
    export PERFPORTAL_S3_SECRET_KEY='change-me-too'
    docker compose -f infra/docker-compose.yml up -d

**Those three are the whole list.** Compose interpolates the entire file
before it decides which profiles are active, so a `${VAR:?}` inside a service
behind the `onprem` profile aborts this command too — which is exactly what
`PERFPORTAL_RUNNER_ORG_ID` used to do, failing the documented quick start
before a single container started. Every onprem-only variable now defaults to
empty here and is validated by the process that needs it; `pnpm compose:check`
(and CI's `compose` job) run `docker compose config` with nothing but the
three above exported, which is the condition that regression reproduced under.

Ports are deliberately offset so an existing local Postgres or Redis is never
shadowed:

| Service    | Port | Credentials              |
|------------|------|--------------------------|
| PostgreSQL | 5433 | perfportal / `$PERFPORTAL_DB_PASSWORD` |
| Redis      | 6380 | —                        |
| MinIO      | 9000 | `$PERFPORTAL_S3_ACCESS_KEY` / `$PERFPORTAL_S3_SECRET_KEY` |

## Data, and how to not lose it

Postgres and MinIO write to **named** volumes, `infra_postgres-data` and
`infra_minio-data`. They did not always: with no `volumes:` key those images
still declare `VOLUME` internally, so each service ran on an ANONYMOUS volume
with a 64-hex name — `docker compose down` orphaned it, the next `up` created
a fresh empty one, and the old data sat on disk with nothing pointing at it.
The symptom was a database that had lost its schema for no visible reason.

    docker compose -f infra/docker-compose.yml down      # keeps the data
    docker compose -f infra/docker-compose.yml down -v   # deletes it, deliberately

**THE ORPHANS ARE NOT MERELY WASTED SPACE — THEY BROKE THE TEST STACK.**
Measured on a machine that had been running this compose file for a while:
`/var/lib/docker/volumes` inside the Docker VM held **3.3 million of the
filesystem's 3.9 million inodes**, almost all of it in six anonymous volumes
belonging to Postgres and MinIO containers that had long since been replaced.
`df -h` reported 22 GB free, so nothing looked wrong — but there were about
20,000 inodes left, and the integration suite exhausted them mid-run:

    error: could not create file "base/16384/64222": No space left on device
    XMinioStorageFull: Storage backend has reached its minimum free drive threshold

Neither message mentions inodes, and both read as a broken stack rather than a
full disk. **`df -i`, not `df -h`, is the check** — and `docker volume prune`
is the fix when the answer is 100%. With named volumes those orphans are no
longer created in the first place.

**Editing `infra/docker-compose.yml` still recreates a container**, and a
recreated container starts from whatever its volume holds. That is now the
data you had, not an empty disk — but if you ever do lose the database, the
migrations are the way back:

    pnpm --filter @perfportal/persistence exec prisma migrate deploy --schema prisma/schema.prisma

Backup and restore are ordinary `pg_dump`/`mc mirror`:

    docker compose -f infra/docker-compose.yml exec -T postgres \
      pg_dump -U perfportal perfportal | gzip > perfportal-$(date +%F).sql.gz

    gunzip -c perfportal-2026-08-29.sql.gz | \
      docker compose -f infra/docker-compose.yml exec -T postgres psql -U perfportal perfportal

The MinIO bucket holds the uploaded bundles and assembled live logs. A dump of
Postgres without it restores every run's statistics and verdict but not the
raw artefacts behind them.

## Environment

    export PERFPORTAL_DB_PASSWORD='change-me'
    export PERFPORTAL_S3_ACCESS_KEY='change-me'
    export PERFPORTAL_S3_SECRET_KEY='change-me-too'
    export DATABASE_URL="postgresql://perfportal:${PERFPORTAL_DB_PASSWORD}@localhost:5433/perfportal"
    export REDIS_URL='redis://localhost:6380'
    export S3_ENDPOINT='http://localhost:9000'
    export S3_ACCESS_KEY="$PERFPORTAL_S3_ACCESS_KEY"
    export S3_SECRET_KEY="$PERFPORTAL_S3_SECRET_KEY"
    export BETTER_AUTH_URL='http://localhost:3000'   # optional — defaults to
                                                       # http://localhost:<PORT>;
                                                       # set to the public origin
                                                       # in any real deployment
    # Signs every session cookie. Optional in development, REQUIRED whenever
    # NODE_ENV=production — apps/api/src/config.ts refuses to start without
    # it, and without one Better Auth would otherwise fall back to a built-in
    # default that it then rejects at the first /auth request rather than at
    # startup. At least 32 characters.
    export BETTER_AUTH_SECRET="$(openssl rand -base64 32)"

## First run

    nvm use                      # Node 22 — the repo floor, and what CI pins
    pnpm install
    pnpm --filter @perfportal/persistence exec prisma migrate deploy --schema prisma/schema.prisma
    pnpm --filter @perfportal/persistence exec prisma generate --schema prisma/schema.prisma
    pnpm build                   # REQUIRED before running either app: the packages
                                 # resolve to dist/ at runtime, source only under vitest
    pnpm test                    # unit
    pnpm test:integration        # needs the services above

## Getting a credential

There is no admin API and no seed data — nothing outside the test harness
creates an org, a project, or an API token. `packages/persistence/scripts/bootstrap.ts`
closes that gap: it creates (or, on re-run, reuses) an org and a project by
slug and mints a fresh API token scoped for both `ingest` and `read`. It
requires the packages to be built (`pnpm build`) and `DATABASE_URL` to point
at a migrated database:

    pnpm bootstrap
    # or, to control the org/project slugs:
    pnpm --filter @perfportal/persistence run bootstrap my-org my-project
    # (or PERFPORTAL_ORG_SLUG / PERFPORTAL_PROJECT_SLUG)

The plaintext token is printed to stdout exactly once — it is hashed with
Argon2id before being stored, and is not recoverable after this point. Copy
it immediately:

    export PERFPORTAL_TOKEN='pp_...'

Re-running the script is safe: the org and project are reused by slug, never
duplicated. It does mint a new token each run, which is fine — old tokens are
left alone, never silently invalidated.

## Getting a human account

Pass `--admin-email` to also create a session-authenticated admin account, a
member of the same org, via Better Auth's own sign-up (never raw SQL, so the
password hash is one Better Auth's own login path can verify):

    pnpm bootstrap --admin-email you@example.test

This is **not** safe to re-run with the same address — Better Auth rejects a
second sign-up for an email already in use, so re-running fails loudly rather
than silently minting a second password. The plaintext password is printed
to stdout exactly once, the same way the API token is; copy it immediately.

Log in with it against `/auth/*` (Better Auth's own error/response shapes,
not this API's RFC 9457 `problem+json` — see the root `README.md`'s
Authentication section), and use the returned session cookie on `/v1`.
A session names no project, so it can't ingest, but it can list every run
across the whole org via `GET /v1/runs` (see the root `README.md`'s
Authentication section) — no run id needed up front:

    curl -sS -c /tmp/cookies.txt -X POST http://localhost:3000/auth/sign-in/email \
      -H 'Content-Type: application/json' \
      -d '{"email":"you@example.test","password":"<printed password>"}'
    curl -sS -b /tmp/cookies.txt http://localhost:3000/v1/runs

On `http://localhost` the cookie is minted WITHOUT `Secure` — see the root
`README.md`'s Authentication section for why that exemption is loopback-only
and why Safari is the reason it exists. A real, non-TLS deployment reachable
by hostname still gets `Secure`, and therefore no session at all from a
browser: sign-in appears to succeed, no cookie is ever stored, and every
subsequent `/v1` request 401s as if uncredentialed.

## Running the slice

    pnpm --filter @perfportal/api start &
    pnpm --filter @perfportal/worker start &
    pnpm --filter @perfportal/runner start &

Then post the reference fixture, using the token from the previous step:

    tar -czf /tmp/bundle.tgz -C fixtures/gatling-3.15.1.2 reference-report
    curl -sS -X POST http://localhost:3000/v1/runs \
      -H "Authorization: Bearer $PERFPORTAL_TOKEN" \
      -F 'metadata={"tool":"gatling"}' \
      -F bundle=@/tmp/bundle.tgz

## Running Gatling from the UI

The on-prem runner uses the same local services as the API and worker. It also
needs Java on the host and shared artifact/log directories:

    export RUNNER_ARTIFACT_DIR='.perfportal/runner-artifacts'
    export RUNNER_WORK_DIR='.perfportal/runner-work'
    export RUNNER_LOG_DIR='.perfportal/runner-logs'
    export RUNNER_ORG_ID='<org uuid this runner is allowed to claim>'
    # Optional: restrict this runner to one project inside that org.
    export RUNNER_PROJECT_ID='<project uuid>'
    export RUNNER_ARTIFACT_RETENTION_DAYS='30'
    export JAVA_BIN='java'
    # A Gatling distribution this runner LENDS to a jar that carries none.
    # `gradlew gatlingEnterprisePackage` deliberately builds a thin jar --
    # simulations and their dependencies, no framework -- because Gatling
    # Enterprise supplies the runtime when it runs the test. Without this, such
    # an upload dies with "Could not find or load main class
    # io.gatling.app.Gatling". Unpack any Gatling bundle and point at it; the
    # runner uses <home>/lib, or the directory itself if it holds the jars.
    # A fat jar that bundles Gatling needs none of this and ignores it.
    export RUNNER_GATLING_HOME='/opt/gatling'

`JAVA_BIN` must be **Java 21 or newer**. A jar built by a current Gatling
packager carries class file version 65, which a Java 17 runtime refuses with
`UnsupportedClassVersionError` before Gatling is reached. The `onprem` image
installs 21 and sets `RUNNER_GATLING_HOME` itself, so neither applies there.

Start `apps/runner` beside `apps/api` and `apps/worker`. From the project runs
page, choose **New on-prem run**, upload a Gatling fat jar or runnable bundle,
and queue the job. The runner claims one queued job at a time, streams the
generated `simulation.log` into a live run, then hands it to the worker so the
normal reports appear under the attached run id. Runner stdout/stderr is
written under `RUNNER_LOG_DIR` and can be tailed from the same UI.

For a containerized single-node deployment, use the `onprem` compose profile:

    export PERFPORTAL_DB_PASSWORD='change-me'
    export PERFPORTAL_S3_ACCESS_KEY='change-me'
    export PERFPORTAL_S3_SECRET_KEY='change-me-too'
    # REQUIRED for the onprem profile. It becomes BETTER_AUTH_SECRET, which
    # signs every session cookie; infra/Dockerfile sets NODE_ENV=production,
    # and the API refuses to start without one. Under 32 characters is
    # refused too.
    export PERFPORTAL_AUTH_SECRET="$(openssl rand -base64 32)"
    # The origin a BROWSER will use. It becomes BETTER_AUTH_URL, which Better
    # Auth derives its CSRF trusted-origin check from — leave it at the
    # localhost default and a deployment reached by hostname refuses its own
    # sign-in as an invalid origin. It must be https:// for a real
    # deployment: the session cookie is `secure: true`, so a browser stores
    # nothing over plain HTTP unless the host is literally localhost. See the
    # root README's "Deploying it" section for the reverse proxy.
    export PERFPORTAL_PUBLIC_URL='https://perf.example.com'
    export PERFPORTAL_RUNNER_ORG_ID='<org uuid this runner is allowed to claim>'
    export PERFPORTAL_RUNNER_ARTIFACT_RETENTION_DAYS='30'
    docker compose -f infra/docker-compose.yml --profile onprem up --build

### TLS

Add `--profile tls` and Caddy fronts the API with an automatic Let's Encrypt
certificate:

    export PERFPORTAL_DOMAIN='perf.example.com'
    export PERFPORTAL_PUBLIC_URL="https://$PERFPORTAL_DOMAIN"
    docker compose -f infra/docker-compose.yml --profile onprem --profile tls up --build

Both variables, not one. Caddy terminating TLS does not tell the API what
origin it is being served at, and Better Auth refuses a sign-in from an origin
it does not trust.

**It is opt-in because it cannot work without two things this file cannot
supply**: `PERFPORTAL_DOMAIN` must already resolve to this host from the
public internet (Caddy answers an HTTP-01 challenge on port 80 of that name at
first boot), and ports 80 and 443 must be free. Left unset it issues a local
certificate instead, which is enough to try the profile and trusted by nothing
else. `infra/Caddyfile` is the whole configuration — a reverse proxy, no
buffering so live-run deltas are not held back, and no security headers of its
own, because the API sets those itself and a second differing copy of any of
them is worse than none.

Without TLS from somewhere, **a browser cannot sign in at all** at anything
other than `localhost`: the session cookie is `secure: true`, so it is never
stored, and every request afterwards 401s as though it carried no credential.

`PERFPORTAL_RUNNER_ORG_ID` is validated by `apps/runner` at startup, not by
Compose: making it a `${VAR:?}` here is what broke the plain
`docker compose up -d` at the top of this file, because interpolation does not
respect profiles. Leave it unset and the runner exits with
`Missing required environment variable RUNNER_ORG_ID`; the other three
services come up regardless.

The app services share named volumes for uploaded artifacts and runner logs;
the profile also runs Prisma migrations before starting API, worker and runner.
Terminal runner jobs, their uploaded artifacts and their runner logs are removed
after `RUNNER_ARTIFACT_RETENTION_DAYS`; the attached report run remains in the
normal run history, but retrying that old runner job is intentionally no longer
available after retention.
Gatling child processes run with a sanitized environment and, in the container
profile, a separate unprivileged UID. The runner service itself starts as root
only so Node can spawn Gatling with that lower UID; the compose profile drops
all other Linux capabilities, keeping only `SETUID`/`SETGID`, and sets
`no-new-privileges`. Database, Redis and S3
credentials above stay in the runner control plane rather than in uploaded
simulations. Treat this single-node runner as a single-tenant on-prem executor
unless you add a stronger per-job sandbox boundary.
