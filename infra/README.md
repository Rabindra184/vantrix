# Local infrastructure

    docker compose -f infra/docker-compose.yml up -d

Ports are deliberately offset so an existing local Postgres or Redis is never
shadowed:

| Service    | Port | Credentials              |
|------------|------|--------------------------|
| PostgreSQL | 5433 | perfportal / perfportal  |
| Redis      | 6380 | —                        |
| MinIO      | 9000 | perfportal / perfportal123 |

## Environment

    export DATABASE_URL='postgresql://perfportal:perfportal@localhost:5433/perfportal'
    export REDIS_URL='redis://localhost:6380'
    export S3_ENDPOINT='http://localhost:9000'
    export S3_ACCESS_KEY='perfportal'
    export S3_SECRET_KEY='perfportal123'
    export BETTER_AUTH_URL='http://localhost:3000'   # optional — defaults to
                                                       # http://localhost:<PORT>;
                                                       # set to the public origin
                                                       # in any real deployment

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

The session cookie is minted `secure: true` (see the root `README.md`'s
Authentication section), so this recipe working over plain `http://localhost`
is specific to `curl`, which — unlike a browser — replays a `Secure` cookie
over plain HTTP regardless of host. A real, non-TLS deployment reachable by
hostname gets no session at all from a browser: sign-in appears to succeed,
but no cookie is ever stored, and every subsequent `/v1` request 401s as if
uncredentialed.

## Running the slice

    pnpm --filter @perfportal/api start &
    pnpm --filter @perfportal/worker start &

Then post the reference fixture, using the token from the previous step:

    tar -czf /tmp/bundle.tgz -C fixtures/gatling-3.15.1.2 reference-report
    curl -sS -X POST http://localhost:3000/v1/runs \
      -H "Authorization: Bearer $PERFPORTAL_TOKEN" \
      -F 'metadata={"tool":"gatling"}' \
      -F bundle=@/tmp/bundle.tgz
