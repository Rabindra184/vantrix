#!/usr/bin/env node
/**
 * Asserts that the API and the on-prem runner agree about where artifacts live.
 *
 * ═══ THE FAILURE THIS EXISTS TO PREVENT ═══
 *
 * `RUNNER_ARTIFACT_DIR`, `RUNNER_WORK_DIR` and `RUNNER_LOG_DIR` all default to
 * a RELATIVE path under `.perfportal/` (apps/api/src/config.ts,
 * apps/runner/src/config.ts), so each process resolves them against its own
 * working directory. Run the two apps the way this repo's docs run them —
 * `pnpm --filter …`, which starts each from its own package directory — and
 * the API writes an uploaded jar to `apps/api/.perfportal/runner-artifacts/`
 * while the runner reads `apps/runner/.perfportal/runner-artifacts/`.
 *
 * The job is then claimed, opens a live run, and dies with
 *
 *     ARTIFACT_NOT_FOUND: Artifact file is not readable at …
 *
 * which reads like a failed upload rather than two processes looking in
 * different directories. Observed exactly that way on a developer machine.
 *
 * ═══ WHY A CHECK AND NOT JUST THE COMPOSE FILE ═══
 *
 * The compose file already gets this right: one absolute path in the shared
 * `*app_env` anchor, one named volume mounted at that same path in both
 * services. Nothing enforces it. `docker compose config --quiet` — the whole
 * of the existing compose gate — passes just as happily when a mount target is
 * edited, a volume is renamed, or `RUNNER_ARTIFACT_DIR` is made relative,
 * because all three are syntactically fine. The regression would surface as a
 * runtime error on somebody's first on-prem run, naming the wrong cause.
 *
 * So this reads the RESOLVED config (`docker compose config --format json`,
 * which is what the daemon would actually run, interpolation and anchors
 * already applied) and asserts the agreement directly.
 *
 * ═══ USAGE ═══
 *
 *   node infra/test/runner-paths.mjs                 # the real compose file
 *   node infra/test/runner-paths.mjs -f a.yml -f b.yml
 *
 * Extra `-f` arguments are passed through to `docker compose`, which is how
 * `runner-paths-broken.yml` is layered on to prove this check can fail. An
 * assertion nobody has watched fail is a guess.
 */
import { execFileSync } from 'node:child_process';

const passthrough = process.argv.slice(2);
const files = passthrough.length > 0 ? passthrough : ['-f', 'infra/docker-compose.yml'];

/* The onprem profile interpolates three variables that are deliberately
   `${VAR:?}`-free but still have no default — the same three the compose CI job
   exports. Values are irrelevant here; only the shape is under test. */
const env = {
  ...process.env,
  PERFPORTAL_DB_PASSWORD: process.env.PERFPORTAL_DB_PASSWORD ?? 'check',
  PERFPORTAL_S3_ACCESS_KEY: process.env.PERFPORTAL_S3_ACCESS_KEY ?? 'check',
  PERFPORTAL_S3_SECRET_KEY: process.env.PERFPORTAL_S3_SECRET_KEY ?? 'check',
};

let config;
try {
  config = JSON.parse(
    execFileSync('docker', ['compose', ...files, '--profile', 'onprem', 'config', '--format', 'json'], {
      env,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    }),
  );
} catch (err) {
  console.error('could not resolve the compose config:\n' + String(err.stderr ?? err.message));
  process.exit(2);
}

const failures = [];
const fail = (msg) => failures.push(msg);

const service = (name) => {
  const s = config.services?.[name];
  if (!s) fail(`service "${name}" is missing from the onprem profile`);
  return s ?? { environment: {}, volumes: [] };
};

/** The mount whose target is exactly `path`, or null. */
const mountAt = (svc, path) =>
  (svc.volumes ?? []).find((v) => v.target === path) ?? null;

const api = service('api');
const runner = service('runner');

/**
 * A directory both services must resolve to the same place.
 *
 * `writable` names which service does the writing — the API receives uploads,
 * the runner only reads them. That asymmetry is worth pinning too: a runner
 * that could write into the artifact store would be able to replace the jar it
 * is about to execute, and the compose file deliberately mounts it `:ro`.
 */
function sharedDir(key, writers) {
  const a = api.environment?.[key];
  const r = runner.environment?.[key];

  if (typeof a !== 'string' || a.length === 0) return fail(`api does not set ${key}`);
  if (typeof r !== 'string' || r.length === 0) return fail(`runner does not set ${key}`);

  // THE ORIGINAL BUG. A relative path is resolved per-process, so two services
  // sharing one volume can still disagree about where it is.
  if (!a.startsWith('/')) fail(`api's ${key} is relative ("${a}") — it must be absolute`);
  if (!r.startsWith('/')) fail(`runner's ${key} is relative ("${r}") — it must be absolute`);
  if (a !== r) fail(`${key} differs: api has "${a}", runner has "${r}"`);

  const am = mountAt(api, a);
  const rm = mountAt(runner, r);
  if (am === null) fail(`api sets ${key}=${a} but mounts nothing there`);
  if (rm === null) fail(`runner sets ${key}=${r} but mounts nothing there`);
  if (am === null || rm === null) return;

  if (am.source !== rm.source) {
    fail(
      `${key} is mounted from different volumes: api uses "${am.source}", ` +
        `runner uses "${rm.source}" — they would not see each other's files`,
    );
  }

  const writable = (m) => m.read_only !== true;
  if (writers.includes('api') !== writable(am)) {
    fail(`api's ${key} mount should be ${writers.includes('api') ? 'writable' : 'read-only'}`);
  }
  if (writers.includes('runner') !== writable(rm)) {
    fail(`runner's ${key} mount should be ${writers.includes('runner') ? 'writable' : 'read-only'}`);
  }
}

// The API receives uploads and the runner only reads them.
sharedDir('RUNNER_ARTIFACT_DIR', ['api']);
// Both write job logs; the API serves them back.
sharedDir('RUNNER_LOG_DIR', ['api', 'runner']);

/* The work directory is the runner's alone — it is where a bundle is
   extracted — so it needs no agreement, only somewhere real to live. */
const work = runner.environment?.RUNNER_WORK_DIR;
if (typeof work !== 'string' || !work.startsWith('/')) {
  fail(`runner's RUNNER_WORK_DIR must be an absolute path (got "${work}")`);
} else if (mountAt(runner, work) === null) {
  fail(`runner sets RUNNER_WORK_DIR=${work} but mounts nothing there`);
}

if (failures.length > 0) {
  console.error('runner path agreement FAILED:');
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}

console.log('runner path agreement OK');
console.log(`  artifacts  ${api.environment.RUNNER_ARTIFACT_DIR}  (api rw, runner ro)`);
console.log(`  logs       ${api.environment.RUNNER_LOG_DIR}  (both rw)`);
console.log(`  work       ${runner.environment.RUNNER_WORK_DIR}  (runner only)`);
