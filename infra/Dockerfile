FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates openjdk-17-jre-headless tar unzip \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages

RUN pnpm install --frozen-lockfile --ignore-scripts \
  && pnpm --filter @perfportal/persistence exec prisma generate --schema prisma/schema.prisma \
  && pnpm build

RUN groupadd --system perfportal \
  && useradd --system --gid perfportal --create-home perfportal \
  && install -d -o perfportal -g perfportal \
    /var/lib/perfportal/runner-artifacts \
    /var/lib/perfportal/runner-work \
    /var/log/perfportal/runner \
  && chown -R perfportal:perfportal /app

ENV NODE_ENV=production
USER perfportal

CMD ["pnpm", "--filter", "@perfportal/api", "start"]
