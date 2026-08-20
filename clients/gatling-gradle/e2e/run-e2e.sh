#!/usr/bin/env bash
#
# Task 7 (gatling-gradle-live-streaming): a REAL Gatling run, streamed live by
# the `dev.vantrix.gatling` Gradle plugin, into a REAL running Vantrix
# platform (API + worker + Postgres/Redis/MinIO) -- finishing as a complete
# run whose re-evaluated assertions match the fixture simulation's
# deliberate shape (two passing, one deliberately failing).
#
# This is a manual/on-demand gate: it needs Docker plus a seeded stack, so it
# is NOT part of `pnpm` gates and NOT part of the CI `plugin` job (see
# CLAUDE.md's own gate list, which is blind to clients/gatling-gradle
# entirely, and the plan's Task 8 doc for the same point made in prose).
#
# Re-runnable: every invocation seeds a fresh org/project/token (seed.mjs
# mints unique slugs), so nothing here needs to be reset between runs except
# whatever this script itself starts (target-server, killed in the trap
# below).
set -uo pipefail
# NOT `set -e`: this script's whole reason to exist is a command (gatlingRun)
# that is SUPPOSED to exit non-zero -- ParitySimulation carries one
# deliberately failing assertion (see fixtures/gatling-3.15.1.2/README.md).
# Every step below checks its own exit status explicitly instead.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$PLUGIN_DIR/../.." && pwd)"
E2E_PROJECT_DIR="$SCRIPT_DIR/e2e-project"
FIXTURE_DIR="$REPO_ROOT/fixtures/gatling-3.15.1.2/simulation"
API_DIR="$REPO_ROOT/apps/api"
SEED_SRC="$SCRIPT_DIR/seed.mjs"

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/vantrix-e2e.XXXXXX")"
GRADLE_LOG="$WORK_DIR/gatlingRun.log"
TARGET_LOG="$WORK_DIR/target-server.log"
STATUSES_LOG="$WORK_DIR/poll-statuses.log"
SEEN_RUNNING_FILE="$WORK_DIR/seen-running"
FINAL_JSON="$WORK_DIR/final-run.json"
SEED_JSON="$WORK_DIR/seed.json"
SEED_COPY="$API_DIR/__vantrix_e2e_seed_$$.mjs"

VANTRIX_URL_DEFAULT="http://localhost:3000"
TARGET_PORT=8099

log() { printf '[run-e2e] %s\n' "$*"; }
fail() {
  printf '\n[run-e2e] FAIL: %s\n' "$*" >&2
  exit 1
}

# ---------------------------------------------------------------------------
# Cleanup: target-server, the seed-copy that was placed in apps/api/, and any
# background pollers still running. Runs on every exit path (pass or fail).
# ---------------------------------------------------------------------------
TARGET_PID=""
POLLER_PID=""
GRADLE_PID=""
cleanup() {
  local ec=$?
  [ -n "$TARGET_PID" ] && kill "$TARGET_PID" >/dev/null 2>&1
  [ -n "$POLLER_PID" ] && kill "$POLLER_PID" >/dev/null 2>&1
  [ -n "$GRADLE_PID" ] && kill "$GRADLE_PID" >/dev/null 2>&1
  rm -f "$SEED_COPY"
  exit "$ec"
}
trap cleanup EXIT INT TERM

# ---------------------------------------------------------------------------
# Node 22 (the API build and seed.mjs both need it -- Node 20's undici cannot
# even load @perfportal/persistence's compiled better-auth wiring in some
# paths, and the seed's own JSON output would otherwise disagree with the
# server this script polls). Prefer whatever's already on PATH if it already
# qualifies; fall back to the known-good nvm install rather than failing
# immediately, since that fallback IS the documented remediation.
# ---------------------------------------------------------------------------
node_major() { node -v 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/'; }
if [ "$(node_major)" -lt 22 ] 2>/dev/null || [ -z "$(node_major)" ]; then
  NVM_NODE22="$HOME/.nvm/versions/node/v22.19.0/bin"
  [ -x "$NVM_NODE22/node" ] && export PATH="$NVM_NODE22:$PATH"
fi
[ "$(node_major)" -ge 22 ] 2>/dev/null || fail \
  "need Node 22+ on PATH. Try: export PATH=\"\$HOME/.nvm/versions/node/v22.19.0/bin:\$PATH\""
log "node: $(node -v) ($(command -v node))"

# ---------------------------------------------------------------------------
# JDK 21 (Gradle toolchain for both the plugin module and the e2e project).
# ---------------------------------------------------------------------------
if [ -z "${JAVA_HOME:-}" ] || ! "$JAVA_HOME/bin/java" -version 2>&1 | grep -q '"21\.'; then
  CANDIDATE="$HOME/Library/Java/JavaVirtualMachines/temurin-21.0.11/Contents/Home"
  [ -x "$CANDIDATE/bin/java" ] && export JAVA_HOME="$CANDIDATE"
fi
export PATH="$JAVA_HOME/bin:$PATH"
"$JAVA_HOME/bin/java" -version 2>&1 | grep -q '"21\.' || fail \
  "need a JDK 21 JAVA_HOME. Try: export JAVA_HOME=\"\$HOME/Library/Java/JavaVirtualMachines/temurin-21.0.11/Contents/Home\""
log "java: $("$JAVA_HOME/bin/java" -version 2>&1 | head -1)"

# ===========================================================================
# Step 1: preconditions -- fail fast, with remediation, rather than mid-run.
# ===========================================================================
log "checking preconditions..."

curl -sf "$VANTRIX_URL_DEFAULT/" -o /dev/null || fail \
  "API not reachable at $VANTRIX_URL_DEFAULT. Start it: export DATABASE_URL=postgresql://perfportal:perfportal@localhost:5433/perfportal REDIS_URL=redis://localhost:6380 S3_ENDPOINT=http://localhost:9000 S3_ACCESS_KEY=perfportal S3_SECRET_KEY=perfportal123 && (cd apps/api && nohup node dist/main.js > /tmp/api.log 2>&1 &)"

# `pgrep -f 'worker/dist/main.js'` (the brief's literal check) only matches a worker started
# with that path IN its invocation, e.g. `node apps/worker/dist/main.js`. A worker started the
# other documented way -- `cd apps/worker && node dist/main.js` -- has an argv of plain "node
# dist/main.js" with no "worker/" substring anywhere, which is indistinguishable by argv alone
# from apps/api's own "node dist/main.js". Match by each candidate's actual cwd instead, which
# is unambiguous regardless of how it was launched.
worker_running() {
  local pid cwd
  for pid in $(pgrep -f 'dist/main.js' 2>/dev/null); do
    cwd="$(lsof -p "$pid" 2>/dev/null | awk '$4=="cwd"{print $NF; exit}')"
    case "$cwd" in
      */apps/worker) return 0 ;;
    esac
  done
  return 1
}
worker_running || fail \
  "no worker process found (checked every 'dist/main.js' process's cwd for .../apps/worker). Start it: export DATABASE_URL=... REDIS_URL=... S3_*=... && (cd apps/worker && nohup node dist/main.js > /tmp/worker.log 2>&1 &)"

for hp in 5433:postgres 6380:redis 9000:minio; do
  port="${hp%%:*}"; name="${hp##*:}"
  nc -z -w2 localhost "$port" >/dev/null 2>&1 || fail \
    "$name not reachable on localhost:$port. Start the stack: docker compose -f infra/docker-compose.yml up -d"
done

log "preconditions OK: API up, worker running, postgres/redis/minio reachable."

# ===========================================================================
# Step 2: publish the plugin under test to mavenLocal().
# ===========================================================================
log "publishing dev.vantrix.gatling:gatling-gradle-plugin:0.1.0-SNAPSHOT to mavenLocal()..."
( cd "$PLUGIN_DIR" && ./gradlew publishToMavenLocal --no-daemon -q ) \
  || fail "publishToMavenLocal failed -- see output above."
log "published."

# ===========================================================================
# Step 3: seed a fresh org/project/token. Copied into apps/api/ so
# @perfportal/core and @perfportal/persistence resolve as workspace deps
# (F4 ruling, task-7-brief.md) -- and removed again in cleanup() either way.
# ===========================================================================
log "seeding org/project/token..."
[ -n "${DATABASE_URL:-}" ] || export DATABASE_URL="postgresql://perfportal:perfportal@localhost:5433/perfportal"
cp "$SEED_SRC" "$SEED_COPY"
( cd "$API_DIR" && node "$(basename "$SEED_COPY")" ) >"$SEED_JSON" 2>"$WORK_DIR/seed.stderr"
SEED_EC=$?
# seed.mjs already prefixes its own stderr lines with "[seed] " -- pass through verbatim
# rather than double-prefixing.
cat "$WORK_DIR/seed.stderr" >&2 || true
[ "$SEED_EC" -eq 0 ] || fail "seed.mjs failed (exit $SEED_EC) -- see [seed] lines above."

TOKEN="$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).token)' "$SEED_JSON")"
READ_TOKEN="$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).readToken)' "$SEED_JSON")"
PROJECT_SLUG="$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).projectSlug)' "$SEED_JSON")"
[ -n "$TOKEN" ] && [ -n "$READ_TOKEN" ] || fail "seed.mjs produced no token -- got: $(cat "$SEED_JSON")"
log "seeded project '$PROJECT_SLUG', token minted (stream+read)."

# ===========================================================================
# Step 4: start the local target server (fixture's own -- deterministic,
# 127.0.0.1:8099 only, no external traffic).
#
# Run from a COPY in $WORK_DIR, never in place: target-server.js is
# CommonJS (`require`), and Node picks a file's module system from the
# NEAREST package.json above ITS OWN path, regardless of caller or cwd --
# the repo root's package.json declares "type": "module", so `node
# fixtures/.../target-server.js` fails with "require is not defined in ES
# module scope" every time, unconditionally. $WORK_DIR (under mktemp) has no
# package.json above it, so a copy there is plain CommonJS again. This
# copies the fixture, exactly like the ParitySimulation.kt copy below --
# never edits it in place.
# ===========================================================================
if lsof -ti:"$TARGET_PORT" >/dev/null 2>&1; then
  fail "port $TARGET_PORT already in use -- stop whatever is listening (probably a stale target-server.js from an earlier aborted run) and retry."
fi
log "starting target-server.js on 127.0.0.1:$TARGET_PORT..."
cp "$FIXTURE_DIR/target-server.js" "$WORK_DIR/target-server.js"
node "$WORK_DIR/target-server.js" >"$TARGET_LOG" 2>&1 &
TARGET_PID=$!
for _ in $(seq 1 25); do
  nc -z -w1 127.0.0.1 "$TARGET_PORT" >/dev/null 2>&1 && break
  sleep 0.2
done
nc -z -w1 127.0.0.1 "$TARGET_PORT" >/dev/null 2>&1 || fail "target-server.js never opened port $TARGET_PORT -- see $TARGET_LOG"
log "target-server up (pid $TARGET_PID)."

# ===========================================================================
# Step 5: build the e2e project -- copy the FIXTURE simulation in (never
# modified in place) to the Gatling Gradle plugin's own default Kotlin
# source set, src/gatling/kotlin/ (confirmed against Gatling's own
# gatling-gradle-plugin-demo-kotlin reference project; NOT src/test or the
# project root -- the reference fixture's flattened layout under
# fixtures/gatling-3.15.1.2/simulation/ is documentation-only, not a real
# buildable source tree). Re-copied every run so it can never silently drift
# from the fixture; gitignored in e2e-project/.gitignore for the same reason
# a build/ output would be.
# ===========================================================================
log "copying fixture simulation into e2e-project..."
SIM_DEST_DIR="$E2E_PROJECT_DIR/src/gatling/kotlin/example"
mkdir -p "$SIM_DEST_DIR"
cp "$FIXTURE_DIR/ParitySimulation.kt" "$SIM_DEST_DIR/ParitySimulation.kt"

# ===========================================================================
# Step 6: run gatlingRun. EXPECT NON-ZERO EXIT -- ParitySimulation carries
# one deliberately failing assertion (Search's p50 < 100ms), so Gatling's
# own assertion check fails the build; that is correct behaviour here, not a
# crash. The plugin's finalizer (vantrixClose, finalizedBy'd onto
# gatlingRun) still runs and still closes the live run even though the task
# itself failed -- that handoff is the entire point of this test, see
# VantrixPlugin's own docstring.
#
# Run in the BACKGROUND so this script can tail the log for the "run
# opened" line the moment it appears (added to LiveClient.kt for exactly
# this) and start the concurrent liveness poller (step 9) while gatlingRun
# is still executing its ~60-100s of simulated load.
# ===========================================================================
log "running gatlingRun (expect it to fail on the deliberate assertion -- this takes ~60-100s of simulated load plus Gradle/Gatling startup)..."
(
  cd "$E2E_PROJECT_DIR"
  VANTRIX_URL="$VANTRIX_URL_DEFAULT" VANTRIX_TOKEN="$TOKEN" VANTRIX_TICK_SECONDS=2 \
    ./gradlew gatlingRun --no-daemon --stacktrace
) >"$GRADLE_LOG" 2>&1 &
GRADLE_PID=$!

# ---- watch the log for the plugin's "run opened" line -----------------
RUN_ID=""
RUN_URL=""
OPEN_DEADLINE=$(( $(date +%s) + 180 ))   # generous: first-time dependency resolution can be slow
while [ -z "$RUN_ID" ] && [ "$(date +%s)" -lt "$OPEN_DEADLINE" ]; do
  LINE="$(grep -oE 'vantrix: run opened: [0-9a-fA-F-]{36} -> [^[:space:]]+' "$GRADLE_LOG" 2>/dev/null | tail -1 || true)"
  if [ -n "$LINE" ]; then
    RUN_ID="$(echo "$LINE" | awk '{print $4}')"
    RUN_URL="$(echo "$LINE" | awk '{print $6}')"
    break
  fi
  if ! kill -0 "$GRADLE_PID" 2>/dev/null; then
    # process already exited -- one last look at the fully-flushed log, then give up
    LINE="$(grep -oE 'vantrix: run opened: [0-9a-fA-F-]{36} -> [^[:space:]]+' "$GRADLE_LOG" 2>/dev/null | tail -1 || true)"
    [ -n "$LINE" ] && { RUN_ID="$(echo "$LINE" | awk '{print $4}')"; RUN_URL="$(echo "$LINE" | awk '{print $6}')"; }
    break
  fi
  sleep 2
done
[ -n "$RUN_ID" ] || {
  log "----- last 80 lines of $GRADLE_LOG -----"
  tail -80 "$GRADLE_LOG" || true
  fail "never saw a 'vantrix: run opened: ...' line -- the plugin never opened a live run (bad token/URL, or a genuine build failure before gatlingRun started)."
}
log "run opened: $RUN_ID -> $RUN_URL"

# ===========================================================================
# Step 9 (started here, deliberately, so it overlaps step 6): background
# liveness poll -- while gatlingRun is still executing, confirm the run was
# genuinely observed in status "running" at least once. Without this, the
# whole exercise only proves the CLOSED/fallback path, not the live one.
# Bounded and short: RunRepository.createLive sets status: 'running' at
# INSERT time (verified by hand against the real API above), so this either
# sees it on the first poll or something is badly wrong.
# ===========================================================================
(
  for _ in $(seq 1 12); do
    body="$(curl -s -w '\n%{http_code}' "$VANTRIX_URL_DEFAULT/v1/runs/$RUN_ID" -H "Authorization: Bearer $READ_TOKEN" 2>/dev/null)"
    code="$(echo "$body" | tail -1)"
    json="$(echo "$body" | sed '$d')"
    status="$(echo "$json" | jq -r '.status // empty' 2>/dev/null)"
    echo "$(date +%s) http=$code status=${status:-?}" >>"$STATUSES_LOG"
    if [ "$status" = "running" ]; then
      touch "$SEEN_RUNNING_FILE"
      break
    fi
    sleep 3
  done
) &
POLLER_PID=$!

# ---- wait for gatlingRun (+ its vantrixClose finalizer) to finish ------
wait "$GRADLE_PID"
GRADLE_EC=$?
wait "$POLLER_PID" 2>/dev/null || true
POLLER_PID=""

log "gatlingRun exited $GRADLE_EC."
if [ "$GRADLE_EC" -ne 0 ]; then
  if grep -qi 'simulations failed assertions' "$GRADLE_LOG" || grep -qi 'reports generated' "$GRADLE_LOG"; then
    log "non-zero exit is the EXPECTED assertion-failure path (ParitySimulation's deliberate failing assertion) -- continuing."
  else
    log "----- last 120 lines of $GRADLE_LOG -----"
    tail -120 "$GRADLE_LOG" || true
    fail "gatlingRun failed for a reason that doesn't look like the deliberate assertion failure -- see log above."
  fi
else
  log "NOTE: gatlingRun exited 0 -- ParitySimulation's third assertion is designed to fail this build. Continuing anyway; the server-side toolAssertions check below is authoritative."
fi

if [ -f "$SEEN_RUNNING_FILE" ]; then
  log "liveness confirmed: GET /v1/runs/$RUN_ID reported status=\"running\" at least once during the build."
else
  log "----- poll log -----"
  cat "$STATUSES_LOG" 2>/dev/null || true
  fail "never observed status=\"running\" while gatlingRun executed -- this only proves the fallback/closed path, not live streaming."
fi

# ===========================================================================
# Step 7: sequential poll to terminal, now that the build (and its
# finalizer's close()) has actually finished. Cap ~90s.
# ===========================================================================
log "polling GET /v1/runs/$RUN_ID until terminal (cap ~90s)..."
POLL_DEADLINE=$(( $(date +%s) + 90 ))
FINAL_CODE=""
while [ "$(date +%s)" -lt "$POLL_DEADLINE" ]; do
  body="$(curl -s -w '\n%{http_code}' "$VANTRIX_URL_DEFAULT/v1/runs/$RUN_ID" -H "Authorization: Bearer $READ_TOKEN")"
  FINAL_CODE="$(echo "$body" | tail -1)"
  json="$(echo "$body" | sed '$d')"
  echo "$(date +%s) http=$FINAL_CODE status=$(echo "$json" | jq -r '.status // empty' 2>/dev/null || echo '?')" >>"$STATUSES_LOG"
  if [ "$FINAL_CODE" != "202" ]; then
    echo "$json" >"$FINAL_JSON"
    break
  fi
  sleep 3
done
[ -s "$FINAL_JSON" ] || fail "run $RUN_ID never reached a terminal status within the 90s cap. Poll log:\n$(cat "$STATUSES_LOG")"

# ===========================================================================
# Step 8: assert. status == "complete"; toolAssertions is exactly 3 entries
# whose outcomes are {failed, passed, passed} (order-independent -- see
# task-7-brief.md's own "sort outcomes if order is unstable"); simulation ==
# "example.ParitySimulation"; and the run id the PLUGIN printed during the
# build is the same run this script just polled to completion.
# ===========================================================================
log "asserting final run state..."
ASSERT_OUT="$(node - "$FINAL_JSON" "$RUN_ID" <<'NODE'
const fs = require('fs');
const [, , finalPath, expectedRunId] = process.argv;
const run = JSON.parse(fs.readFileSync(finalPath, 'utf8'));
const problems = [];

if (run.status !== 'complete') problems.push(`status: expected "complete", got "${run.status}"`);
if (run.simulation !== 'example.ParitySimulation') problems.push(`simulation: expected "example.ParitySimulation", got "${JSON.stringify(run.simulation)}"`);
if (run.id !== expectedRunId) problems.push(`run id: plugin printed "${expectedRunId}", server has "${run.id}"`);

const assertions = Array.isArray(run.toolAssertions) ? run.toolAssertions : null;
if (!assertions) {
  problems.push(`toolAssertions: expected an array of 3, got ${JSON.stringify(run.toolAssertions)}`);
} else if (assertions.length !== 3) {
  problems.push(`toolAssertions: expected exactly 3 entries, got ${assertions.length}: ${JSON.stringify(assertions)}`);
} else {
  const got = assertions.map((a) => a.outcome).sort();
  const want = ['failed', 'passed', 'passed'];
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    problems.push(`toolAssertions outcomes: expected ${JSON.stringify(want)} (sorted), got ${JSON.stringify(got)} (sorted) -- raw: ${JSON.stringify(assertions)}`);
  }
}

if (problems.length > 0) {
  console.log('FAIL');
  for (const p of problems) console.log(`  - ${p}`);
  process.exitCode = 1;
} else {
  console.log('PASS');
  console.log(`  status:        ${run.status}`);
  console.log(`  simulation:    ${run.simulation}`);
  console.log(`  run id:        ${run.id}`);
  console.log(`  toolAssertions:`);
  for (const a of assertions) {
    console.log(`    ${a.outcome.padEnd(8)} ${a.expression}  (actual: ${a.actualValue})`);
  }
}
NODE
)"
ASSERT_EC=$?
echo "$ASSERT_OUT"

echo
echo "======================================================================"
if [ "$ASSERT_EC" -eq 0 ]; then
  echo "PASS -- a real Gatling run streamed live into a real Vantrix, and the"
  echo "        re-ingested assertions match ParitySimulation's deliberate shape."
  echo "        run:      $RUN_URL"
  echo "        liveness: status=\"running\" observed during the build"
else
  echo "FAIL -- see problems above."
fi
echo "======================================================================"
exit "$ASSERT_EC"
