/**
 * Captures the run's AGENT payloads, from the live API, into
 * `apps/web/test/fixtures/agent-run.json`.
 *
 * WHY THIS EXISTS. `capture-chart-fixture.mjs` gives every chart transform the
 * bytes the browser receives for the reference run; this is the same thing for
 * the Report's Connections, DNS and Load generators sections, whose transforms
 * read the five `/v1/runs/:id/agent*` endpoints. That reference run carries no
 * agent file at all, so it cannot serve here: every agent read would answer
 * `available: false` and every transform test would be a test of the empty
 * case.
 *
 * THE INPUT IS THE PAIRED FIXTURE, `fixtures/gatling-3.15.1.2/agent-run/` —
 * one JVM's `simulation.log` and agent file, recorded on Linux so the header
 * reads `"collects":{"http":true,"machine":true}`. Its README says what it
 * holds. The agent file goes into the bundle as `AGENT_BUNDLE_FILE` beside
 * `simulation.log`, which is where the worker looks for it in an upload.
 *
 * WHAT IT WRITES. The raw response bodies, exactly as served:
 *
 *   summary              GET /v1/runs/:id/agent
 *   connections          GET /v1/runs/:id/agent/connections        (every remote)
 *   connectionsByRemote  GET /v1/runs/:id/agent/connections?remote= one per remote
 *   dns                  GET /v1/runs/:id/agent/dns                (every hostname)
 *   injectors            GET /v1/runs/:id/agent/injectors
 *   status               GET /v1/runs/:id/agent/status
 *
 * plus a `_capture` block recording where they came from. Nothing is reshaped.
 * Every URL comes from `apps/web/src/api/metricPaths.ts`, which `api/agent.ts`
 * also imports, so the fixture is captured from the requests the app makes.
 *
 * ---------------------------------------------------------------------------
 * HOW TO RE-CAPTURE IT
 * ---------------------------------------------------------------------------
 *
 * Against a SCRATCH database, bucket and Redis index — never the developer
 * database. Two shells, the same exports in both:
 *
 *   export DATABASE_URL=postgresql://perfportal:perfportal@localhost:5433/perfportal_pr3
 *   export REDIS_URL=redis://localhost:6380/12
 *   export S3_ENDPOINT=http://localhost:9000 S3_ACCESS_KEY=perfportal S3_SECRET_KEY=perfportal123
 *   export S3_BUCKET=perfportal-pr3 PORT=3810 PLAYWRIGHT_BASE_URL=http://localhost:3810
 *
 *   # once: create the database and migrate it
 *   pnpm --filter @perfportal/persistence exec prisma migrate deploy --schema prisma/schema.prisma
 *
 *   pnpm build
 *   node apps/api/dist/main.js            # shell 1, leave running; stop it by PID afterwards
 *   node --experimental-strip-types scripts/capture-agent-fixture.mjs   # shell 2
 *
 * NO WORKER PROCESS IS NEEDED. Parsing goes through `parseUploadedRun` in
 * `apps/web/e2e/fixtures.ts`, which drives `PipelineService` in-process — the
 * same stand-in every e2e seed uses, and the same code the worker runs. The
 * run is still POSTED over HTTP with a real ingest token, and every read is a
 * real HTTP request to the running API.
 *
 * NEVER run this while `pnpm test:integration` is using the same DATABASE_URL:
 * that suite truncates every table and would delete the org seeded here.
 *
 * ---------------------------------------------------------------------------
 *
 * THE INGEST TOKEN IS MINTED THROUGH THE API (`POST /v1/projects/:slug/tokens`)
 * with the seeded admin's session, because `POST /v1/runs` refuses a session
 * (a session names no project). READS USE THE SESSION COOKIE, as
 * `capture-chart-fixture.mjs` argues: the browser is a cookie client.
 */

import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { parseUploadedRun, seedAdmin } from '../apps/web/e2e/fixtures.ts';
import {
  agentConnectionsPath,
  agentDnsPath,
  agentInjectorsPath,
  agentStatusPath,
  agentSummaryPath,
  runPath,
} from '../apps/web/src/api/metricPaths.ts';

// `@perfportal/core` is a dependency of `apps/web`, not of the workspace root,
// and Node resolves a bare specifier relative to the IMPORTING FILE — so it is
// resolved from `apps/web`'s own manifest, the way `infra/clean-test-buckets.mjs`
// reaches the S3 SDK. The bundle file name then comes from the module the
// worker reads it with, rather than being spelled a second time here.
const webRequire = createRequire(new URL('../apps/web/package.json', import.meta.url));
const { AGENT_BUNDLE_FILE } = await import(pathToFileURL(webRequire.resolve('@perfportal/core')).href);

const BASE_URL =
  process.env.PLAYWRIGHT_BASE_URL ?? `http://localhost:${process.env.PERFPORTAL_E2E_PORT ?? '3000'}`;

const FIXTURE_DIR = fileURLToPath(new URL('../fixtures/gatling-3.15.1.2/agent-run/', import.meta.url));
const OUT = fileURLToPath(new URL('../apps/web/test/fixtures/agent-run.json', import.meta.url));

/** Fails with the server's own words rather than a bare status code. */
async function expectOk(res, what) {
  if (!res.ok) throw new Error(`${what} → HTTP ${res.status}\n${await res.text()}`);
  return res;
}

/** As in `capture-chart-fixture.mjs`: Node's fetch has no cookie jar, and Better Auth wants an Origin. */
async function signIn({ email, password }) {
  const res = await expectOk(
    await fetch(`${BASE_URL}/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: BASE_URL },
      body: JSON.stringify({ email, password }),
    }),
    'POST /auth/sign-in/email',
  );
  const cookies = res.headers.getSetCookie().map((c) => c.split(';')[0]);
  if (cookies.length === 0) throw new Error('sign-in returned 200 but set no cookie');
  return cookies.join('; ');
}

/** `run-1/simulation.log` and `run-1/<AGENT_BUNDLE_FILE>`, gzipped — the upload shape the worker reads. */
function agentBundle() {
  const dir = mkdtempSync(join(tmpdir(), 'agent-capture-'));
  const results = join(dir, 'run-1');
  mkdirSync(results, { recursive: true });
  copyFileSync(join(FIXTURE_DIR, 'simulation.log'), join(results, 'simulation.log'));
  copyFileSync(join(FIXTURE_DIR, 'agent.ndjson'), join(results, AGENT_BUNDLE_FILE));
  const out = join(dir, 'bundle.tgz');
  execFileSync('tar', ['-czf', out, '-C', dir, 'run-1']);
  return readFileSync(out);
}

async function main() {
  await expectOk(
    await fetch(`${BASE_URL}/health`).catch(() => {
      throw new Error(`No API answering at ${BASE_URL}. Start it first: node apps/api/dist/main.js`);
    }),
    `GET ${BASE_URL}/health`,
  );

  console.log('seeding an admin, minting an ingest token, posting the paired bundle…');
  const admin = await seedAdmin();
  const cookie = await signIn(admin);

  // `seedAdmin` makes exactly one project, slugged `checkout`.
  const minted = await (
    await expectOk(
      await fetch(`${BASE_URL}/v1/projects/checkout/tokens`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: BASE_URL, cookie },
        body: JSON.stringify({ name: 'agent-fixture-capture', scopes: ['ingest'] }),
      }),
      'POST /v1/projects/checkout/tokens',
    )
  ).json();

  const form = new FormData();
  form.set('metadata', JSON.stringify({ tool: 'gatling', waitMs: 0 }));
  form.set('bundle', new Blob([new Uint8Array(agentBundle())]), 'bundle.tgz');
  const posted = await fetch(`${BASE_URL}/v1/runs`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${minted.token}` },
    body: form,
  });
  if (posted.status !== 202) throw new Error(`POST /v1/runs expected 202, got ${posted.status}: ${await posted.text()}`);
  const { id: runId } = await posted.json();

  // The worker, in-process. It finds the org's newest pending run, which is
  // this one: `seedAdmin` gave this capture an org of its own.
  const parsed = await parseUploadedRun(admin.orgId);
  if (parsed !== runId) throw new Error(`parsed run ${parsed}, but the upload created ${runId}`);

  // Terminal by the API's own answer, not just the pipeline's: 202 is still processing.
  const deadline = Date.now() + 30_000;
  for (;;) {
    const res = await fetch(`${BASE_URL}${runPath(runId)}`, { headers: { cookie } });
    if (res.status === 200) break;
    if (res.status !== 202 || Date.now() > deadline) {
      throw new Error(`GET ${runPath(runId)} → ${res.status}: ${await res.text()}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  console.log(`  run ${runId}`);

  const read = async (url) => {
    const res = await expectOk(await fetch(`${BASE_URL}${url}`, { headers: { cookie } }), `GET ${url}`);
    console.log(`  captured ${url}`);
    return res.json();
  };

  const summary = await read(agentSummaryPath(runId));
  const connections = await read(agentConnectionsPath(runId, '*'));
  const connectionsByRemote = {};
  for (const remote of summary.remotes) {
    connectionsByRemote[remote] = await read(agentConnectionsPath(runId, remote));
  }
  const dns = await read(agentDnsPath(runId, '*'));
  const injectors = await read(agentInjectorsPath(runId));
  const status = await read(agentStatusPath(runId));

  // Post-conditions. A fixture that captured cleanly but describes a run with
  // no agent, or a macOS one, would turn every transform test downstream into
  // a test of the unavailable case while reporting green.
  const checks = [
    ['summary.available', summary.available === true],
    ['summary.header.collects.http', summary.header?.collects.http === true],
    ['summary.header.collects.machine', summary.header?.collects.machine === true],
    ['summary.remotes.length >= 2', summary.remotes.length >= 2],
    ['summary.hostnames.length >= 1', summary.hostnames.length >= 1],
    ['every figure read is available', [connections, dns, injectors, status].every((p) => p.available === true)],
    ['every figure read carries a width', [connections, dns, injectors, status].every((p) => p.bucketWidthMs !== null)],
  ];
  const failed = checks.filter(([, ok]) => !ok).map(([what]) => what);
  if (failed.length > 0) {
    throw new Error(`the captured agent run does not hold: ${failed.join(', ')} — refusing to write the fixture`);
  }

  const output = {
    _capture: {
      script: 'scripts/capture-agent-fixture.mjs',
      capturedAt: new Date().toISOString(),
      runId,
      bundle: ['fixtures/gatling-3.15.1.2/agent-run/simulation.log', `fixtures/gatling-3.15.1.2/agent-run/agent.ndjson as ${AGENT_BUNDLE_FILE}`],
      baseUrl: BASE_URL,
      endpoints: {
        summary: agentSummaryPath(runId),
        connections: agentConnectionsPath(runId, '*'),
        connectionsByRemote: Object.fromEntries(summary.remotes.map((r) => [r, agentConnectionsPath(runId, r)])),
        dns: agentDnsPath(runId, '*'),
        injectors: agentInjectorsPath(runId),
        status: agentStatusPath(runId),
      },
    },
    summary,
    connections,
    connectionsByRemote,
    dns,
    injectors,
    status,
  };

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(output, null, 2)}\n`);
  console.log(`\nwrote ${OUT}`);
  console.log(`  collects ${JSON.stringify(summary.header.collects)}`);
  console.log(`  remotes ${JSON.stringify(summary.remotes)}`);
  console.log(`  hostnames ${JSON.stringify(summary.hostnames)}`);
  console.log(`  bucketWidthMs ${summary.bucketWidthMs}`);
}

await main();
// The seeds hold a Prisma client and a pg Pool open at module scope.
process.exit(0);
