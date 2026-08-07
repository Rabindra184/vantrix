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

## Running the slice

    pnpm --filter @perfportal/api start &
    pnpm --filter @perfportal/worker start &

Then post the reference fixture:

    tar -czf /tmp/bundle.tgz -C fixtures/gatling-3.15.1.2 reference-report
    curl -sS -X POST http://localhost:3000/v1/runs \
      -H "Authorization: Bearer $PERFPORTAL_TOKEN" \
      -F 'metadata={"tool":"gatling"}' \
      -F bundle=@/tmp/bundle.tgz
