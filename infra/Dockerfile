# ═══ TRIXIE, BECAUSE BOOKWORM CANNOT SUPPLY JAVA 21 ANY MORE ═══
#
# This was `node:22-bookworm-slim` plus `bookworm-backports` for the JDK, and
# it stopped building — not on a change in this repository, but because Debian
# pruned openjdk-21 from bookworm-backports. Reproduced on a clean build:
#
#     Package openjdk-21-jre-headless is not available, but is referred to by
#     another package.
#     E: Package 'openjdk-21-jre-headless' has no installation candidate
#
# THE LESSON IS ABOUT BACKPORTS, NOT ABOUT JAVA. `-backports` is a suite whose
# contents are explicitly not stable over time; pinning a RUNTIME the image
# must execute to one was always a build that would fail on somebody else's
# schedule, and the `onprem` profile is in no `pnpm` gate, so nothing noticed
# until a release audit tried it. Debian 13 carries openjdk-21-jre-headless in
# `main` (21.0.12 at the time of writing), so this is one apt install from a
# suite with a support policy — and `.github/workflows/ci.yml`'s `compose` job
# now builds this image on every run, so the next such break is loud.
FROM node:22-trixie-slim

# ═══ JAVA 21, NOT THE 17 THIS IMAGE ONCE SHIPPED ═══
#
# A jar built by `gatlingEnterprisePackage` on a modern toolchain carries class
# file version 65, and a Java 17 runtime reads up to 61 — so every such upload
# died with `UnsupportedClassVersionError` before Gatling was even reached. The
# JVM runs OLDER bytecode happily, so raising this floor cannot break an
# artifact that already worked.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
      ca-certificates curl tar unzip openjdk-21-jre-headless \
  && rm -rf /var/lib/apt/lists/* \
  # A runtime that cannot answer "which Java am I" is not a runtime; fail the
  # build here rather than at the first queued Gatling job.
  && java -version

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
# ═══ THE BUNDLE HAS NO `lib/` ANY MORE, AND THIS STEP ASSUMED IT DID ═══
#
# This used to be `find … -type d -name lib` followed by `mv "$lib"
# /opt/gatling/lib`, which is the layout every Gatling bundle had up to about
# 3.13. The 3.15.1 bundle is a MAVEN PROJECT instead: `pom.xml`, `mvnw`, and a
# pre-populated `.m2/repository`, with no `lib/` anywhere in it. So `find`
# returned nothing, `test -n "$lib"` failed, and the build died at exit 1 with
# no message at all — the checksum had already printed `OK` one line above,
# which is exactly the wrong place for a reader to stop looking.
#
# FLATTENING `.m2/repository` IS NOT THE FIX, THOUGH IT LOOKS LIKE ONE. That
# repository is what Maven needs to BUILD the demo project, so it carries the
# build toolchain too — 301 jars including three different `slf4j-api`
# versions (1.7.32, 1.7.36 and 2.0.18). Copying them all into one directory
# makes `-cp lib/*` pick whichever the filesystem hands over first; measured,
# it picked 1.7.32 and Gatling started with `Failed to load class
# org.slf4j.impl.StaticLoggerBinder … Defaulting to no-operation (NOP) logger`,
# i.e. a run whose logging was silently dead.
#
# So Maven resolves its own closure, offline, from the repository the bundle
# ships. That is version mediation done by the tool that owns the question:
# 95 jars, 52 MB, exactly one slf4j-api (2.0.18) and logback present and
# bound. `-DincludeScope=test` because Gatling's own archetype declares
# `gatling-charts-highcharts` at `test` scope — `runtime` resolves to nothing
# here, which would have produced an empty directory and the SAME
# "Could not find or load main class" this whole step exists to prevent.
#
# The wrapper fetches Maven 3.9.12 (pinned by the bundle's own
# `maven-wrapper.properties`) over HTTPS from repo.maven.apache.org, the same
# host the zip above comes from; everything else is offline (`-o`).
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
  # The bundle's top-level directory name carries the version, so take
  # whatever single directory the zip produced rather than spelling it out.
  && bundle="$(find /tmp/gatling -mindepth 1 -maxdepth 1 -type d | head -1)" \
  && test -n "$bundle" \
  && export JAVA_HOME="$(dirname "$(dirname "$(readlink -f "$(command -v java)")")")" \
  && (cd "$bundle" && ./mvnw -o -B -q \
        -Dmaven.repo.local="$bundle/.m2/repository" \
        dependency:copy-dependencies \
        -DincludeScope=test \
        -DoutputDirectory=/opt/gatling/lib) \
  # `/root/.m2` is where the wrapper unpacked Maven itself; none of it is
  # needed once the jars are copied, and leaving it would add ~10 MB of build
  # tooling to a runtime image.
  && rm -rf /tmp/gatling.zip /tmp/gatling /root/.m2 \
  # The simulation runs as the unprivileged `gatling` uid, never as the runner
  # — so the lent runtime has to be readable by a user that owns none of it.
  && chmod -R a+rX /opt/gatling \
  # A runtime that cannot answer "which Gatling am I" makes the runner's
  # version check silently decline to run; fail the build here instead.
  # `apps/runner/src/artifact.ts` reads this exact filename.
  && ls /opt/gatling/lib/gatling-core-*.jar > /dev/null
ENV RUNNER_GATLING_HOME=/opt/gatling

WORKDIR /app

# ═══ THE APPLICATION USER EXISTS BEFORE THE INSTALL, NOT AFTER ═══
#
# This block used to sit AFTER `pnpm install && pnpm build` and end with
# `chown -R perfportal:perfportal /app`. On an overlay filesystem a recursive
# chown rewrites the metadata of every file it touches, which COPIES the
# entire node_modules tree into a new layer — roughly a gigabyte of duplicate
# content in the final image, and a gigabyte of scratch space the build needs
# on top of everything else. It is also the step that fails first when a
# machine is short of disk, and it fails ten minutes in, after the install and
# the build have already been paid for.
#
# Creating the user first and installing as them removes the step entirely.
# `corepack enable` stays as root because it writes shims into
# /usr/local/bin; everything after `USER perfportal` runs unprivileged, which
# is also the posture the container ends up in either way.
#
# `gatling` (uid 20001) is a SECOND, separate account: the on-prem runner
# spawns simulations under it so an uploaded jar never runs as the process
# that has the database and object-store credentials. It owns nothing here.
RUN corepack enable \
  && groupadd --system --gid 20001 gatling \
  && useradd --system --uid 20001 --gid gatling --no-create-home gatling \
  && groupadd --system perfportal \
  && useradd --system --gid perfportal --create-home perfportal \
  && install -d -o perfportal -g perfportal \
    /var/lib/perfportal/runner-artifacts \
    /var/lib/perfportal/runner-work \
    /var/log/perfportal/runner \
  # Non-recursive: /app is still empty, and the COPYs below carry their own
  # ownership.
  && chown perfportal:perfportal /app

USER perfportal

COPY --chown=perfportal:perfportal package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json tsconfig.base.json ./
COPY --chown=perfportal:perfportal apps ./apps
COPY --chown=perfportal:perfportal packages ./packages

RUN pnpm install --frozen-lockfile --ignore-scripts \
  && pnpm --filter @perfportal/persistence exec prisma generate --schema prisma/schema.prisma \
  && pnpm build

# Set LAST, so it cannot affect the install above — `pnpm install` under
# NODE_ENV=production skips devDependencies, and this build needs them
# (typescript, vite, the Nest CLI's compiler) to run `pnpm build` at all.
#
# It is also what makes BETTER_AUTH_SECRET mandatory: Better Auth refuses its
# built-in default secret in production, and apps/api/src/config.ts turns that
# into a startup failure naming the variable. See infra/docker-compose.yml.
ENV NODE_ENV=production

CMD ["pnpm", "--filter", "@perfportal/api", "start"]
