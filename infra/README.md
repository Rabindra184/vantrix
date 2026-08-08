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

## Running the slice

    pnpm --filter @perfportal/api start &
    pnpm --filter @perfportal/worker start &

Then post the reference fixture, using the token from the previous step:

    tar -czf /tmp/bundle.tgz -C fixtures/gatling-3.15.1.2 reference-report
    curl -sS -X POST http://localhost:3000/v1/runs \
      -H "Authorization: Bearer $PERFPORTAL_TOKEN" \
      -F 'metadata={"tool":"gatling"}' \
      -F bundle=@/tmp/bundle.tgz
