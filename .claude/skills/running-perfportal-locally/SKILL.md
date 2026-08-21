---
name: running-perfportal-locally
description: Use when starting, demoing, or clicking through the PerfPortal web app on a dev machine — "run the app", "show me the UI", "check this in a browser" — or when seeding a login or sample run data, or diagnosing "Invalid origin" at sign-in, a signed-in user who sees zero runs, an uploaded run stuck at pending, or port 5173 already in use.
---

# Running PerfPortal locally

## Overview

Containers → build → bootstrap → API + worker → browser.

**The one rule that costs a debugging cycle:** the browser's origin must
EXACTLY equal the API's `BETTER_AUTH_URL`, or sign-in fails.

Which URL is correct is therefore **a property of a process, not of this
document** — and if you did not start that process, you cannot see it and it
can change under you when someone restarts the stack. Never open a URL on
faith: run the checks in *Already running?* first. The instructions below say
`http://localhost:3000` because *you* started the API in step 6 with no
`BETTER_AUTH_URL`, so it defaulted there.

## Already running? Check these three first

Skipping this is how you debug a machine that was never in the state you assumed.

```bash
# 1. Is an API up, and what origin does it trust?
API_PID=$(lsof -nP -iTCP:3000 -sTCP:LISTEN -t)
[ -n "$API_PID" ] && ps eww "$API_PID" | tr ' ' '\n' | grep BETTER_AUTH_URL
# no output but a live PID => it defaulted to http://localhost:3000

# 2. Is the WORKER up? `pgrep -f dist/main.js` cannot tell it from the API —
#    both are `node dist/main.js`. Distinguish by working directory:
for p in $(pgrep -f "dist/main.js"); do
  printf '%s %s\n' "$p" "$(lsof -a -p "$p" -d cwd -Fn | sed -n 's/^n//p')"
done

# 3. Which org owns the existing runs? A session is scoped to ONE org, so
#    bootstrapping into the wrong one gives a working login and an empty list.
docker exec infra-postgres-1 psql -U perfportal -d perfportal -c \
  "select o.slug org, p.slug project, r.status, count(*) \
     from run r join project p on p.id=r.project_id join org o on o.id=p.org_id \
    group by 1,2,3 order by 1,2;"
```

If the database already has complete runs, skip *Getting real data* entirely —
bootstrap into the org that owns them and go straight to the browser.

## Do this

```bash
source ~/.nvm/nvm.sh && nvm use          # Node 22 — the repo's floor

# 1. Credentials. NOT free values, despite infra/README.md saying 'change-me':
#    they must match what the existing containers were created with AND what
#    CLAUDE.md hard-codes for the test suites. No compose service has a volume,
#    so you cannot change them without destroying the database.
export PERFPORTAL_DB_PASSWORD=perfportal
export PERFPORTAL_S3_ACCESS_KEY=perfportal
export PERFPORTAL_S3_SECRET_KEY=perfportal123
export PERFPORTAL_RUNNER_ORG_ID=dummy    # never used here; compose interpolates
                                         # the WHOLE file, so it must be set
docker compose -f infra/docker-compose.yml up -d postgres redis minio

# 2. What the app processes read (different names from the compose vars above)
export DATABASE_URL=postgresql://perfportal:perfportal@localhost:5433/perfportal
export REDIS_URL=redis://localhost:6380
export S3_ENDPOINT=http://localhost:9000
export S3_ACCESS_KEY=perfportal
export S3_SECRET_KEY=perfportal123

# 3. Migrate AND generate the Prisma client — use the SCRIPT, not the raw
#    binary. `migrate:deploy` is `prisma migrate deploy && prisma generate`;
#    calling `exec prisma migrate deploy` yourself silently skips the generate
#    half, and bootstrap then dies with "@prisma/client did not initialize
#    yet". Nothing else generates it: the root build does not, and there is no
#    postinstall.
pnpm --filter @perfportal/persistence run migrate:deploy

# 4. Build. REQUIRED BEFORE BOOTSTRAP — `pnpm bootstrap` runs
#    `node dist/scripts/bootstrap.js`, which is build output, so bootstrapping
#    first cannot work on a clean checkout. It is also what puts the SPA in
#    apps/web/dist for the API to serve; without it GET / is Nest's 404.
pnpm build

# 5. An org, a project, and a human login. Prints the password ONCE.
#    Org and project ARE reused if they already exist — safe to re-run against
#    an existing org, which is what you want when adding a login to seeded
#    data. Only --admin-email is non-idempotent; give a fresh address.
pnpm bootstrap checkout web-demo --admin-email you@example.test

# 6. Both processes. The worker is not optional: without it an uploaded run
#    sits at `pending` forever and nothing on screen says why.
pnpm --filter @perfportal/api start &
pnpm --filter @perfportal/worker start &
```

Then open **`http://localhost:3000`** and sign in with the printed credentials.

## Getting real data on screen

Only if the org has no runs (check with the psql query above). Ingest the
reference bundle through the real endpoint; the worker parses it in about a
second:

```bash
TOKEN='<the pp_… token bootstrap printed>'
mkdir -p /tmp/pp/run-1
cp fixtures/gatling-3.15.1.2/reference-report/simulation.log /tmp/pp/run-1/
tar -czf /tmp/pp/bundle.tgz -C /tmp/pp run-1

curl -s -X POST http://localhost:3000/v1/runs \
  -H "Authorization: Bearer $TOKEN" \
  -F 'metadata={"tool":"gatling","waitMs":0,"environment":"staging","branch":"main"}' \
  -F 'bundle=@/tmp/pp/bundle.tgz' -w '\nHTTP %{http_code}\n'   # expect 202
```

Expect `895` total requests, `2.68%` error rate, `228 ms` mean, p95 `659 ms` —
the fixture's own numbers. If you see them, the whole pipeline worked.

Repeat with a second bootstrapped project to give the rail more than one row.

## Choosing an origin (the trap)

`createAuth` sets `trustedOrigins: [baseUrl]` — a **one-element** list — from
`BETTER_AUTH_URL` (`apps/api/src/config.ts`), which defaults to
`http://localhost:3000`.

| You want | Browse | Also export |
|---|---|---|
| Just see the app (default) | `http://localhost:3000` | nothing — API serves `apps/web/dist` |
| HMR while editing UI | `http://localhost:5173` | `BETTER_AUTH_URL=http://localhost:5173` **before starting the API**, then `pnpm --filter @perfportal/web dev` |

Any port works, **provided `BETTER_AUTH_URL` names that same port**.
`apps/web/vite.config.ts` hard-codes 5173, so another port needs
`vite --port N --strictPort` and a matching `BETTER_AUTH_URL`.

**Probe it in one call rather than round-tripping a browser.** You must send
the header yourself: a curl that omits `Origin` sails through the check, which
is why every curl-based smoke test in this repo passes while the browser is
refused.

The origin check runs BEFORE credentials, so use a deliberately wrong password
and read the status — you need no real account to test this:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  http://localhost:3000/auth/sign-in/email \
  -H 'Content-Type: application/json' -H "Origin: $ORIGIN_YOU_WILL_BROWSE" \
  -d '{"email":"nobody@example.test","password":"wrong-on-purpose"}'
```

| Status | Meaning |
|---|---|
| `403` `{"code":"INVALID_ORIGIN"}` | that origin is **not** trusted — fix before touching a browser |
| `401` `INVALID_EMAIL_OR_PASSWORD` | origin **is** trusted; it got past the check to the credentials |

## Common mistakes

| Symptom | Cause | Fix |
|---|---|---|
| `@prisma/client did not initialize yet` at bootstrap | Ran `exec prisma migrate deploy` instead of the `migrate:deploy` script, skipping `prisma generate` | `pnpm --filter @perfportal/persistence run migrate:deploy` |
| `Cannot find module '.../dist/scripts/bootstrap.js'` | Bootstrapped before building | `pnpm build` first — step 4 |
| `Invalid origin` under the password field | Browser origin ≠ the API's `BETTER_AUTH_URL` | Probe with the curl above; match them; restart the API after changing it |
| Signed in fine, but **zero runs** and empty rail | Bootstrapped a different org than the one holding the data | Run the psql query above; bootstrap into that org. Bare `pnpm bootstrap` defaults to `demo`/`demo` |
| `password authentication failed for user "perfportal"` | Used `change-me` from infra/README.md | Use the values in step 1 |
| Compose: `required variable PERFPORTAL_RUNNER_ORG_ID is missing` | Compose interpolates the whole file even for `up postgres` | Export all four vars in step 1 |
| Run stuck at `pending` | Worker not running | Start it (step 6); confirm with the cwd loop above |
| `GET /` returns Nest's 404 | No `apps/web/dist` | `pnpm build` |
| Port 5173 in use | A dev server is already up, possibly someone else's | Do not kill it. Either browse `:3000` (if the API trusts it) or point `BETTER_AUTH_URL` at 5173 and use that server |
| Bootstrap fails on re-run | `--admin-email` is deliberately non-idempotent | Use a new address. Org/project reuse is fine |
| Everything worked, now the DB is empty | `pnpm test:integration` truncates every table | Re-run steps 5–6 |

## Verifying it actually works

Not "the server started" — that only proves a port bound:

1. `curl -s -o /dev/null -w '%{http_code}' http://localhost:3000/` → `200`.
   **This passes with the worker dead.**
2. Confirm the worker by PID and working directory, using the loop in
   *Already running?*. **Do not judge it by its log:** the worker prints
   nothing at all on startup, so a healthy worker and one that exited
   immediately produce byte-identical output. The app-level proof is a run
   reaching `complete` rather than sitting at `pending`.
3. **Sign out first, then sign in**, in a browser. Cookies are scoped by HOST,
   not by port, so a session established at `localhost:5173` leaves you
   already signed in at `localhost:3000` and vice versa — you can conclude
   sign-in works at an origin that would actually refuse it. Landing on the
   runs list while already authenticated tests nothing.
4. Open a run: charts draw and the tiles show the fixture numbers above.
5. Console is clean — this app draws ten ECharts instances plus a theme
   observer, and a broken chart logs rather than throws.

## Stopping

```bash
# Scoped to THIS repo — a bare `pkill -f dist/main.js` kills every unrelated
# node stack on the machine.
for p in $(pgrep -f "dist/main.js"); do
  case "$(lsof -a -p "$p" -d cwd -Fn | sed -n 's/^n//p')" in
    */perf-dashboard/*) kill "$p" ;;
  esac
done
```

Leave the containers up; they hold the data.
