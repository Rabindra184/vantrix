#!/usr/bin/env bash
# Builds tools/gatling-method/build/gatling-method.jar.
#
# The tool depends on exactly one library, t-digest 3.3 — the copy Gatling's
# own runtime carries, so the method replays the same code that wrote the
# report. It is a COMPILE-time dependency here and a classpath entry at run
# time; it is not bundled into the jar, so the jar can never carry a different
# t-digest than the runtime it is meant to reproduce.
#
#   TDIGEST_JAR   default ${RUNNER_GATLING_HOME:-/opt/gatling}/lib/t-digest-3.3.jar,
#                 then ~/.perfportal/gatling-home/lib/t-digest-3.3.jar
#   JAVA_HOME     optional; javac and jar are taken from it when set
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ -z "${TDIGEST_JAR:-}" ]; then
  for candidate in \
    "${RUNNER_GATLING_HOME:-/opt/gatling}/lib/t-digest-3.3.jar" \
    "$HOME/.perfportal/gatling-home/lib/t-digest-3.3.jar"; do
    if [ -f "$candidate" ]; then TDIGEST_JAR="$candidate"; break; fi
  done
fi
if [ -z "${TDIGEST_JAR:-}" ] || [ ! -f "$TDIGEST_JAR" ]; then
  echo "build.sh: t-digest-3.3.jar not found; set TDIGEST_JAR" >&2
  exit 1
fi

bin="${JAVA_HOME:+$JAVA_HOME/bin/}"
classes="$here/build/classes"
rm -rf "$here/build"
mkdir -p "$classes"

"${bin}javac" --release 21 -Xlint:all -Werror \
  -cp "$TDIGEST_JAR" \
  -d "$classes" \
  "$here/src/io/perfportal/gatlingmethod/GatlingMethod.java"

"${bin}jar" --create \
  --file "$here/build/gatling-method.jar" \
  --main-class io.perfportal.gatlingmethod.GatlingMethod \
  -C "$classes" .

echo "built $here/build/gatling-method.jar against $TDIGEST_JAR"
