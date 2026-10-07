#!/usr/bin/env node
/**
 * Seeds a local instance with REAL data for manual testing.
 *
 * ═══ WHY THIS EXISTS ═══
 *
 * Most of what is worth exercising by hand is a STATE, not a screen: a run
 * whose SLA passed beside one that breached, a rule that resolves nothing, a
 * bundle that failed to parse, two environments in one test's cohort so the
 * comparability strip has something to warn about. Reaching those by clicking
 * takes longer than reading the page you were trying to check.
 *
 * ═══ REAL RUNS, NOT FABRICATED ROWS ═══
 *
 * Every run here is a genuine Gatling `simulation.log` posted through the real
 * `POST /v1/runs`, decoded by the real plugin and aggregated by the real
 * worker. Nothing writes to the database directly. That matters because this
 * project has already shipped a feature that passed every suite while being
 * broken on three of its four paths — a seeded row would have agreed with the
 * bug. The numbers below are the fixture's own and are worth knowing:
 *
 *   reference-report/   895 requests · 2.68% errors · mean 228ms · p95 659ms
 *   group-assertions/   a second real run, with assertions naming GROUPS
 *
 * ═══ AUTH: TWO CREDENTIALS, AND THEY ARE NOT INTERCHANGEABLE ═══
 *
 * Ingest takes a BEARER token. Rules, tokens and project creation are
 * session-only (`@UseGuards(SessionOnlyGuard)` on those controllers), so this
 * signs in with the bootstrap password and carries the cookie. Sign-in also
 * checks the Origin against `BETTER_AUTH_URL`, which is why the header below
 * is set explicitly rather than left to the runtime.
 *
 * ═══ USAGE ═══
 *
 *   node scripts/seed-manual-test.mjs \
 *     --email qa@perfportal.test --password '<from bootstrap>' \
 *     --token '<pp_… from bootstrap>'
 *
 *   --url        default http://localhost:3000 (must equal BETTER_AUTH_URL)
 *   --runs N     extra repeats per project (default 1)
 *
 * It is safe to re-run: runs accumulate (which is what you want for Trends),
 * and rules that already exist are reported rather than duplicated.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, copyFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/* ── arguments ──────────────────────────────────────────────────────────── */

const arg = (name, fallback = undefined) => {
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1 && process.argv[i + 1] !== undefined) return process.argv[i + 1];
  const env = process.env[`SEED_${name.toUpperCase().replace(/-/g, '_')}`];
  return env ?? fallback;
};

const URL_BASE = (arg('url', 'http://localhost:3000') ?? '').replace(/\/$/, '');
const EMAIL = arg('email');
const PASSWORD = arg('password');
const REPEATS = Number(arg('runs', '1'));

/**
 * ═══ ONE TOKEN PER PROJECT, AND THAT IS NOT A CONVENIENCE ═══
 *
 * The bearer token is what decides which project a run lands in — the
 * `test`/`environment` fields in the metadata do not, and cannot. Seeding
 * three projects with one project's token therefore files every run under
 * that one project while the metadata makes it LOOK right: `search-latency`
 * runs sitting in `checkout`, named correctly, with nothing on screen saying
 * they are in the wrong place. Caught exactly that way on the first run of
 * this script.
 *
 * Repeatable: --token checkout=pp_… --token search=pp_…
 */
const TOKENS = Object.fromEntries(
  process.argv
    .map((a, i) => (a === '--token' ? process.argv[i + 1] : null))
    .filter((v) => typeof v === 'string' && v.includes('='))
    .map((v) => [v.slice(0, v.indexOf('=')), v.slice(v.indexOf('=') + 1)]),
);

if (!EMAIL || !PASSWORD || Object.keys(TOKENS).length === 0) {
  console.error(
    'need --email, --password and at least one --token <projectSlug>=<pp_…>\n' +
      '  every value is printed by `pnpm bootstrap <org> <project>`',
  );
  process.exit(2);
}

const LOGS = {
  reference: 'fixtures/gatling-3.15.1.2/reference-report/simulation.log',
  groups: 'fixtures/gatling-3.15.1.2/group-assertions/simulation.log',
};

/* ── tiny http helpers ──────────────────────────────────────────────────── */

let cookie = '';

async function signIn() {
  const res = await fetch(`${URL_BASE}/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: URL_BASE },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const setCookie = res.headers.getSetCookie?.() ?? [];
  if (!res.ok || setCookie.length === 0) {
    /* THE ORIGIN CHECK RUNS BEFORE CREDENTIALS, so a 403 INVALID_ORIGIN here
       means --url does not match the API's BETTER_AUTH_URL — a different fault
       from a wrong password, and worth saying so rather than "sign-in
       failed". */
    throw new Error(
      `sign-in failed (${res.status}): ${await res.text()}\n` +
        `  if that says INVALID_ORIGIN, --url (${URL_BASE}) is not the origin the API trusts.`,
    );
  }
  cookie = setCookie.map((c) => c.split(';')[0]).join('; ');
}

const session = (path, init = {}) =>
  fetch(`${URL_BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', origin: URL_BASE, cookie, ...(init.headers ?? {}) },
  });

/* ── ingest ─────────────────────────────────────────────────────────────── */

const work = mkdtempSync(join(tmpdir(), 'pp-seed-'));

/** A one-run .tgz around a real simulation.log, the shape ingest expects. */
function bundleFor(logPath) {
  const dir = join(work, `b${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(join(dir, 'run-1'), { recursive: true });
  copyFileSync(logPath, join(dir, 'run-1', 'simulation.log'));
  const tgz = join(dir, 'bundle.tgz');
  execFileSync('tar', ['-czf', tgz, '-C', dir, 'run-1']);
  return tgz;
}

/**
 * Posts one run. `waitMs: 0` is not a detail — the handler otherwise blocks
 * for INGEST_WAIT_MS (25s default) waiting for a terminal verdict, and nothing
 * here needs the verdict in the response.
 */
async function ingest(project, log, metadata) {
  const token = TOKENS[project];
  if (token === undefined) throw new Error(`no --token given for project "${project}"`);
  const body = new FormData();
  body.set('metadata', JSON.stringify({ tool: 'gatling', waitMs: 0, ...metadata }));
  body.set('bundle', new Blob([readFileSync(bundleFor(log))]), 'bundle.tgz');
  const res = await fetch(`${URL_BASE}/v1/runs`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body,
  });
  const text = await res.text();
  if (res.status !== 202 && res.status !== 200) {
    throw new Error(`ingest failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return JSON.parse(text).id;
}

/** A deliberately corrupt bundle, so the run list has a `failed` row in it. */
async function ingestBroken(project, metadata) {
  const dir = join(work, 'broken');
  mkdirSync(join(dir, 'run-1'), { recursive: true });
  // Valid gzip, valid tar, and NOT a Gatling log — so it fails in the decoder
  // rather than at the transport, which is the failure a reader actually sees.
  execFileSync('bash', ['-c', `printf 'not a simulation log' > ${join(dir, 'run-1', 'simulation.log')}`]);
  const tgz = join(dir, 'bundle.tgz');
  execFileSync('tar', ['-czf', tgz, '-C', dir, 'run-1']);
  const body = new FormData();
  body.set('metadata', JSON.stringify({ tool: 'gatling', waitMs: 0, ...metadata }));
  body.set('bundle', new Blob([readFileSync(tgz)]), 'bundle.tgz');
  const res = await fetch(`${URL_BASE}/v1/runs`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKENS[project]}` },
    body,
  });
  return res.ok || res.status === 202 ? JSON.parse(await res.text()).id : null;
}

/* ── rules ──────────────────────────────────────────────────────────────── */

/**
 * `threshold` IS IN THE STORED UNIT, not the authoring one. The browser form
 * takes a percentage for `error_rate` and converts; the API does not, so 1%
 * is 0.01 here. That asymmetry is deliberate (the wire never changed) and is
 * the single easiest thing to get wrong when scripting rules.
 */
async function addRule(slug, rule, label) {
  const res = await session(`/v1/projects/${slug}/rules`, {
    method: 'POST',
    body: JSON.stringify(rule),
  });
  if (res.status === 201) return `  rule  ${slug}: ${label}`;
  const text = await res.text();
  if (res.status === 409 || /already exists|duplicate/i.test(text)) {
    return `  rule  ${slug}: ${label} (already there)`;
  }
  return `  rule  ${slug}: ${label} — REFUSED ${res.status} ${text.slice(0, 160)}`;
}

/* ── the seed ───────────────────────────────────────────────────────────── */

const notes = [];

async function seed() {
  await signIn();
  notes.push(`signed in as ${EMAIL}`);

  /* ═══ RULES FIRST. THIS ORDER IS THE WHOLE POINT ═══
   *
   * A rule judges runs that FINISH AFTER it is added — deliberately, so that
   * adding a gate cannot retroactively fail history somebody has already
   * signed off. Seeding runs first therefore produces a project full of
   * `not evaluated` rows and a rules table that looks configured, which is
   * exactly what the first version of this script did.
   *
   * The reference run is 2.68% errors, p95 659ms, and its `Search` request
   * p95 is ~1939ms — so the thresholds below are chosen to give one of every
   * outcome on the same run.
   */
  const rules = [
    [{ name: 'p95 under 800ms', testSlug: null, scope: 'run', targetName: null,
       family: 'response_time', metric: 'p95', comparator: 'lte', threshold: 800 },
     'run p95 ≤ 800ms — PASSES'],
    [{ name: 'error rate under 1%', testSlug: null, scope: 'run', targetName: null,
       family: 'response_time', metric: 'error_rate', comparator: 'lte', threshold: 0.01 },
     'error_rate ≤ 1% — FAILS (run is 2.68%)'],
    [{ name: 'Search stays under 100ms', testSlug: null, scope: 'request', targetName: 'Search',
       family: 'response_time', metric: 'p95', comparator: 'lte', threshold: 100 },
     'request Search p95 ≤ 100ms — FAILS'],
    [{ name: 'Cart group cumulated', testSlug: null, scope: 'group', targetName: 'Cart',
       family: 'group_cumulated', metric: 'p95', comparator: 'lte', threshold: 400 },
     'group Cart p95 ≤ 400ms — group-scoped'],
    [{ name: 'a target no run reports', testSlug: null, scope: 'request', targetName: 'GET /nowhere',
       family: 'response_time', metric: 'p95', comparator: 'lte', threshold: 100 },
     'unknown target — NOT APPLICABLE'],
  ];
  for (const [rule, label] of rules) notes.push(await addRule('checkout', rule, label));

  /* CHECKOUT — two tests, two environments, two branches, so the Trends
     cohort is a cohort and the comparability strip has a real disagreement to
     report rather than a row of "unknown". */
  for (let i = 0; i < REPEATS; i++) {
    await ingest('checkout', LOGS.reference, { environment: 'staging', branch: 'main', test: 'checkout-smoke' });
    await ingest('checkout', LOGS.groups, { environment: 'production', branch: 'main', test: 'checkout-smoke' });
    await ingest('checkout', LOGS.reference, { environment: 'staging', branch: 'feature/cart-rewrite', test: 'checkout-smoke' });
    await ingest('checkout', LOGS.groups, { environment: 'staging', branch: 'main', test: 'checkout-soak' });
  }
  notes.push(`checkout: ${4 * REPEATS} judged runs across 2 tests, 2 environments, 2 branches`);

  const broken = await ingestBroken('checkout', { environment: 'staging', branch: 'main' });
  notes.push(`checkout: 1 deliberately corrupt bundle${broken ? ` (${broken.slice(0, 8)})` : ''}`);

  /* ═══ A TEST-SCOPED RULE CANNOT PRECEDE ITS TEST ═══
   *
   * `testSlug` is resolved against the project's tests and an unknown slug is
   * a 404, never a silently project-wide rule — which is the right call, and
   * it means this one has to wait for a run of `checkout-soak` to create the
   * test. Hence: rules, runs, THEN this, then one more run for it to judge. */
  notes.push(await addRule('checkout', {
    name: 'soak p99 under 2s', testSlug: 'checkout-soak', scope: 'run', targetName: null,
    family: 'response_time', metric: 'p99', comparator: 'lte', threshold: 2000,
  }, 'test-scoped to checkout-soak'));
  await ingest('checkout', LOGS.groups, { environment: 'staging', branch: 'main', test: 'checkout-soak' });
  notes.push('checkout: 1 more soak run, judged by the test-scoped rule too');

  /* SEARCH — deliberately NO rules, so its runs stay `not evaluated`. That is
     a different fact from "nothing failed", and this UI has been wrong about
     the difference before; having both projects side by side is the cheapest
     way to check it is still right. */
  if (TOKENS.search !== undefined) {
    for (let i = 0; i < REPEATS; i++) {
      await ingest('search', LOGS.reference, { environment: 'production', branch: 'main', test: 'search-latency' });
      await ingest('search', LOGS.groups, { environment: 'production', branch: 'main', test: 'search-latency' });
    }
    notes.push(`search: ${2 * REPEATS} runs, NO rules — verdict stays "not evaluated"`);
  }

  /* PAYMENTS — the ONLY project whose runs pass.
   *
   * Without it the whole instance is red and "passed" goes untested: every
   * checkout run breaches the 1% error-rate gate on purpose. One generous
   * rule here completes the verdict matrix — passed, failed, not evaluated,
   * and a bundle that never parsed — so all four can be compared on one run
   * list. */
  if (TOKENS.payments !== undefined) {
    notes.push(await addRule('payments', {
      name: 'p95 under 2s', testSlug: null, scope: 'run', targetName: null,
      family: 'response_time', metric: 'p95', comparator: 'lte', threshold: 2000,
    }, 'run p95 ≤ 2000ms — PASSES, the only green verdict here'));
    await ingest('payments', LOGS.reference, { environment: 'staging', branch: 'main', test: 'payments-sweep' });
    notes.push('payments: 1 judged run — verdict "passed"');
  }
}

seed()
  .then(() => {
    console.log('\n─── seeded ───────────────────────────────────────────────');
    for (const n of notes) console.log(n);
    console.log(`\nopen ${URL_BASE} and sign in as ${EMAIL}`);
    console.log('runs finish asynchronously — give the worker a few seconds.\n');
  })
  .catch((err) => {
    console.error('\nseed failed:', err.message);
    process.exitCode = 1;
  })
  .finally(() => rmSync(work, { recursive: true, force: true }));
