FROM node:22-bookworm-slim

# ═══ JAVA 21, NOT THE 17 THIS IMAGE SHIPPED ═══
#
# A jar built by `gatlingEnterprisePackage` on a modern toolchain carries class
# file version 65, and a Java 17 runtime reads up to 61 — so every such upload
# died with `UnsupportedClassVersionError` before Gatling was even reached. The
# JVM runs OLDER bytecode happily, so raising this floor cannot break an
# artifact that already worked.
#
# bookworm's main archive stops at 17; 21 comes from backports, which is why
# this is two apt-get installs rather than one.
RUN echo 'deb http://deb.debian.org/debian bookworm-backports main' \
      > /etc/apt/sources.list.d/backports.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl tar unzip \
  && apt-get install -y --no-install-recommends -t bookworm-backports openjdk-21-jre-headless \
  && rm -rf /var/lib/apt/lists/*

# ═══ A GATLING RUNTIME FOR THE RUNNER TO LEND ═══
#
# `gatlingEnterprisePackage` builds a THIN jar on purpose — simulations and
# their dependencies, no framework — because Gatling Enterprise supplies the
# runtime when it executes the test. Without one here, the artifact Gatling's
# own documentation tells you to build cannot start:
#
#     Error: Could not find or load main class io.gatling.app.Gatling
#
# So the image carries a runtime and points RUNNER_GATLING_HOME at it, and an
# upload works with no operator setup. `apps/runner/src/artifact.ts` lends it
# ONLY to a jar that has no framework of its own, so a fat jar still runs
# exactly as it did.
#
# ONLY `lib/` IS KEPT. The published bundle is ~105 MB of launcher scripts,
# sample sources, docs and a `results/` skeleton; the jars are the only part a
# `java -cp` launch can use, and they are ~55 MB of it.
#
# PINNED BY CHECKSUM, because this is a runtime the image will EXECUTE. The
# version and its hash move together or not at all; a mismatch fails the build
# rather than baking in whatever the URL happened to serve.
ARG GATLING_VERSION=3.15.1
ARG GATLING_BUNDLE_SHA1=ea2409bacfaee18ce085b4f65c77435223d6016c
RUN curl -fsSL -o /tmp/gatling.zip \
      "https://repo1.maven.org/maven2/io/gatling/highcharts/gatling-charts-highcharts-bundle/${GATLING_VERSION}/gatling-charts-highcharts-bundle-${GATLING_VERSION}-bundle.zip" \
  && echo "${GATLING_BUNDLE_SHA1}  /tmp/gatling.zip" | sha1sum -c - \
  && unzip -q /tmp/gatling.zip -d /tmp/gatling \
  # The bundle's top-level directory name has changed across Gatling releases,
  # so find lib/ rather than assuming where it sits.
  && lib="$(find /tmp/gatling -maxdepth 3 -type d -name lib | head -1)" \
  && test -n "$lib" \
  && mkdir -p /opt/gatling \
  && mv "$lib" /opt/gatling/lib \
  && rm -rf /tmp/gatling.zip /tmp/gatling \
  # The simulation runs as the unprivileged `gatling` uid, never as the runner
  # — so the lent runtime has to be readable by a user that owns none of it.
  && chmod -R a+rX /opt/gatling \
  # A runtime that cannot answer "which Gatling am I" makes the runner's
  # version check silently decline to run; fail the build here instead.
  && ls /opt/gatling/lib/gatling-core-*.jar > /dev/null
ENV RUNNER_GATLING_HOME=/opt/gatling

WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages

RUN pnpm install --frozen-lockfile --ignore-scripts \
  && pnpm --filter @perfportal/persistence exec prisma generate --schema prisma/schema.prisma \
  && pnpm build

RUN groupadd --system --gid 20001 gatling \
  && useradd --system --uid 20001 --gid gatling --no-create-home gatling \
  && groupadd --system perfportal \
  && useradd --system --gid perfportal --create-home perfportal \
  && install -d -o perfportal -g perfportal \
    /var/lib/perfportal/runner-artifacts \
    /var/lib/perfportal/runner-work \
    /var/log/perfportal/runner \
  && chown -R perfportal:perfportal /app

ENV NODE_ENV=production
USER perfportal

CMD ["pnpm", "--filter", "@perfportal/api", "start"]
