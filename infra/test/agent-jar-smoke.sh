#!/usr/bin/env bash
# Is this jar a Gatling agent the runner can safely load into a user's JVM?
#
#   infra/test/agent-jar-smoke.sh <path to gatling-agent.jar>
#
# Run twice: by `infra/Dockerfile`'s `gatling-agent` stage on the jar it has
# just built (so a bad jar fails the IMAGE BUILD), and by CI's `compose` job on
# the jar the finished image ships at /opt/perfportal/gatling-agent.jar.
#
# ═══ (a) NO UNRELOCATED BYTE BUDDY ═══
#
# The agent rides inside the simulation's own JVM, and a simulation can carry
# its own Byte Buddy. `clients/gatling-agent/build.gradle.kts` relocates the
# agent's copy to `io.perfportal.agent.shaded.bytebuddy`; a jar built without
# that `relocate(...)` puts `net/bytebuddy/...` at the top level, where it
# clashes with whatever version the user brought. Nothing else fails on that:
# the jar still loads, and the clash surfaces as a NoSuchMethodError inside
# somebody's load test. So any entry STARTING with `net/bytebuddy/` fails.
# (The shaded jar keeps some empty directories and metadata under
# `META-INF/versions/9/net/bytebuddy/` and `META-INF/maven/net.bytebuddy/`;
# those are not loadable packages and do not start with `net/bytebuddy/`.)
#
# A jar with no Byte Buddy at all would pass that check vacuously, so the
# relocated package is required to be present too.
#
# ═══ (b) THE PREMAIN ACTUALLY RUNS ═══
#
# A manifest with a wrong `Premain-Class`, or a premain that throws before its
# first write, produces a jar that `java -javaagent:` accepts silently (or
# refuses, depending on the fault) and records nothing. So the jar is loaded
# into a real JVM running `-version`, and the first line of its output must be
# the `perfportal-agent/1` header with `"http":false` — false because no
# Gatling is on that classpath, which is exactly what the header must say.
set -euo pipefail

jar="${1:?usage: agent-jar-smoke.sh <path to gatling-agent.jar>}"
if [ ! -f "$jar" ]; then
  echo "agent-jar-smoke: no such file: $jar" >&2
  exit 1
fi

# `unzip -Z1` is unzip's zipinfo mode: one bare entry name per line, so no
# column of `unzip -l` has to be parsed. A listing that fails (not a zip) stops
# the script here under `set -e`, rather than reading as zero bad entries.
entries="$(unzip -Z1 "$jar")"

# Here-strings, never `printf | grep -q`: under `pipefail` a `grep -q` that
# stops at its first match leaves `printf` writing into a closed pipe, and the
# SIGPIPE makes a MATCH read as a failure.
unrelocated="$(grep '^net/bytebuddy/' <<<"$entries" || true)"
if [ -n "$unrelocated" ]; then
  echo "agent-jar-smoke: $jar carries an UNRELOCATED Byte Buddy — these entries must live under io/perfportal/agent/shaded/bytebuddy/:" >&2
  head -n 20 <<<"$unrelocated" >&2
  echo "agent-jar-smoke: ($(wc -l <<<"$unrelocated" | tr -d ' ') entries in all; is relocate(...) missing from build.gradle.kts?)" >&2
  exit 1
fi
if ! grep -q '^io/perfportal/agent/shaded/bytebuddy/' <<<"$entries"; then
  echo "agent-jar-smoke: $jar carries no relocated Byte Buddy (io/perfportal/agent/shaded/bytebuddy/) — the check above passed only because there was nothing to check" >&2
  exit 1
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
out="$work/a.ndjson"

# `java -version` prints to stderr; it is not the subject, so it is kept out of
# the way unless the JVM itself fails.
if ! java -javaagent:"$jar"=out="$out" -version > "$work/java.txt" 2>&1; then
  echo "agent-jar-smoke: java -javaagent:$jar -version failed:" >&2
  cat "$work/java.txt" >&2
  exit 1
fi

if [ ! -s "$out" ]; then
  echo "agent-jar-smoke: the agent wrote nothing to $out — its premain never ran, or failed before its first line" >&2
  cat "$work/java.txt" >&2
  exit 1
fi

header="$(head -n 1 "$out")"
case "$header" in
  *'"format":"perfportal-agent/1"'*) ;;
  *)
    echo "agent-jar-smoke: line 1 is not a perfportal-agent/1 header:" >&2
    echo "$header" >&2
    exit 1
    ;;
esac
case "$header" in
  *'"http":false'*) ;;
  *)
    echo "agent-jar-smoke: the header does not say \"http\":false, with no Gatling on the classpath:" >&2
    echo "$header" >&2
    exit 1
    ;;
esac

echo "agent-jar-smoke: OK — no unrelocated Byte Buddy, and premain wrote: $header"
