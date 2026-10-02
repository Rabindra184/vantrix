import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createPool,
  createPrisma,
  PackageNameTakenError,
  PackageRepository,
  type NewPackageVersion,
} from '../src/index.js';
import { requireDatabaseUrl, resetDatabase } from './support/db.js';

const url = requireDatabaseUrl();
const pool = createPool(url);
const prisma = createPrisma(url);
const packages = new PackageRepository(prisma);

afterAll(async () => {
  await pool.end();
  await prisma.$disconnect();
});

let orgA = '';
let orgB = '';
let checkout = '';
let search = '';
let billing = '';
beforeEach(async () => {
  await resetDatabase(pool);
  const a = await prisma.org.create({ data: { slug: 'acme', name: 'Acme' } });
  const b = await prisma.org.create({ data: { slug: 'globex', name: 'Globex' } });
  orgA = a.id;
  orgB = b.id;
  checkout = (await prisma.project.create({ data: { orgId: orgA, slug: 'checkout', name: 'Checkout', settings: {} } })).id;
  search = (await prisma.project.create({ data: { orgId: orgA, slug: 'search', name: 'Search', settings: {} } })).id;
  billing = (await prisma.project.create({ data: { orgId: orgB, slug: 'billing', name: 'Billing', settings: {} } })).id;
});

const version = (over: Partial<NewPackageVersion> = {}): NewPackageVersion => ({
  artifactId: randomUUID(),
  filename: 'demo.jar',
  gatlingVersion: '3.15.1',
  sha256: 'a'.repeat(64),
  bytes: 1_887_437,
  simulations: ['example.BasicSimulation'],
  storagePath: `x/${randomUUID()}.jar`,
  ...over,
});

const make = (projectId: string, name: string, orgId = orgA) =>
  packages.create({ id: randomUUID(), orgId, projectId, name, kind: 'gatling_jar' });

/**
 * A job on a version, in a status, optionally with a run. Stamping the run's
 * `package_id` here stands in for what the runner's `markRunOpened` does when a
 * job opens its run: usage is counted on that column, not on the job.
 */
async function job(projectId: string, artifactId: string, status: string, runTestId?: string | null) {
  let runId: string | null = null;
  if (runTestId !== undefined) {
    const run = await prisma.run.create({
      data: {
        orgId: orgA,
        projectId,
        testId: runTestId,
        status: 'complete',
        verdict: 'passed',
        tool: 'gatling',
        bundleKey: `runs/${projectId}/${randomUUID()}.tgz`,
        bundleSha256: 'a'.repeat(64),
        bundleBytes: 1n,
        startedAt: new Date(),
        startedOn: new Date(),
        engineOptions: {},
      },
    });
    runId = run.id;
    await prisma.run.update({
      where: { id: run.id },
      data: {
        packageId: (await prisma.runnerArtifact.findUniqueOrThrow({ where: { id: artifactId } })).packageId,
      },
    });
  }
  await prisma.runnerJob.create({
    data: {
      orgId: orgA,
      projectId,
      artifactId,
      runId,
      status,
      requestedBy: 'ci',
      name: 'nightly',
      simulationClass: 'example.BasicSimulation',
    },
  });
}

async function testIn(projectId: string, slug: string): Promise<string> {
  return (
    await prisma.test.create({
      data: { orgId: orgA, projectId, slug, name: slug, simulationClass: `example.${slug}` },
    })
  ).id;
}

async function countArtifacts(packageId: string): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    'SELECT count(*)::text AS n FROM runner_artifact WHERE package_id = $1',
    [packageId],
  );
  return Number(rows[0]!.n);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * How long an arrangement may take to reach the state a lock-wait case needs
 * (everyone queued, a commit visible). It is deliberately BELOW the 30 s that
 * the repository gives the transactions that queue (`LOCK_WAITING_TX`), so a
 * stuck arrangement fails here naming what it was waiting for, never as a
 * Prisma P2028 from a transaction that outlived its budget.
 */
const ARRANGEMENT_DEADLINE_MS = 10_000;

async function waitUntil(
  what: string,
  probe: () => Promise<boolean>,
  ms = ARRANGEMENT_DEADLINE_MS,
): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await probe())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

/**
 * Watches a promise the test does not await yet, and hands back a check a probe
 * calls on every turn: if the promise has REJECTED, the check throws that
 * rejection, so a call that failed on its own surfaces as itself rather than as
 * its probe's timeout ten seconds later.
 */
function watchRejection(promise: Promise<unknown>): () => void {
  const seen: { failed: boolean; error?: unknown } = { failed: false };
  promise.catch((error: unknown) => {
    seen.failed = true;
    seen.error = error;
  });
  return () => {
    if (seen.failed) throw seen.error;
  };
}

/**
 * A client whose every query OUTSIDE a transaction waits for `gate`. A
 * transaction's own queries run on the client Prisma hands the callback, so
 * they are never held. This is how a test parks a repository call in the gap
 * between its commit and whatever it reads afterwards, deterministically,
 * instead of hoping two calls interleave.
 */
function gated(client: typeof prisma, gate: Promise<void>): typeof prisma {
  return new Proxy(client, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop, target);
      if (typeof value !== 'function') return value;
      const fn = value as (...args: unknown[]) => unknown;
      if (prop === '$transaction') return fn.bind(target);
      return async (...args: unknown[]) => {
        await gate;
        return fn.apply(target, args);
      };
    },
  });
}

/**
 * Runs `addVersion` for `mine` with its post-commit queries parked, waits for
 * the version row to be committed, runs `inTheGap`, then lets the call finish.
 * A correct addVersion issues no query after its commit, so it never waits; one
 * that re-reads afterwards is held here while `inTheGap` changes the world.
 */
async function addVersionWithGap(packageId: string, mine: NewPackageVersion, inTheGap: () => Promise<unknown>) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = new PackageRepository(gated(prisma, gate)).addVersion(orgA, checkout, packageId, mine);
  const rethrowIfFailed = watchRejection(first);
  try {
    await waitUntil('the upload to commit', async () => {
      // An upload that fails before it commits is the cause, not the timeout.
      rethrowIfFailed();
      const found = await pool.query('SELECT 1 FROM runner_artifact WHERE id = $1', [mine.artifactId]);
      return found.rowCount === 1;
    });
    await inTheGap();
  } finally {
    release();
    // Never leave the upload running into the next test's reset.
    await Promise.allSettled([first]);
  }
  return first;
}

describe('PackageRepository', () => {
  it('creates a package with no file, and lists it with current null and zero usage', async () => {
    const created = await make(checkout, 'Checkout');
    expect(created.current).toBeNull();

    const listed = await packages.list(orgA, checkout);
    expect(listed).toHaveLength(1);
    expect(listed[0]!.id).toBe(created.id);
    expect(listed[0]!.current).toBeNull();
    expect(listed[0]!.usage).toEqual({ tests: 0, runs: 0, activeJobs: 0 });
  });

  it('refuses a name the project already has, ignoring case', async () => {
    await make(checkout, 'Checkout');
    await expect(make(checkout, 'checkout')).rejects.toBeInstanceOf(PackageNameTakenError);
    // The index is lower(name), not lower(trim(name)): the API trims before
    // calling, so only the case half of the rule is pinned here. The rule is per
    // project, so the same name elsewhere is fine.
    await expect(make(search, 'checkout')).resolves.toMatchObject({ name: 'checkout' });
  });

  it('surfaces any other unique violation as itself, never as a taken name', async () => {
    const first = await make(checkout, 'Checkout');
    // The same id under a different name collides on the primary key, which
    // shares SQLSTATE 23505 with the name index and must not be mistaken for it.
    const err = await packages
      .create({ id: first.id, orgId: orgA, projectId: checkout, name: 'Distinct', kind: 'gatling_jar' })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).not.toBeNull();
    expect(err).not.toBeInstanceOf(PackageNameTakenError);
    // It is the unique violation it should be, not some unrelated failure.
    expect(String(err)).toContain('23505');
  });

  it('finds a package by name ignoring case', async () => {
    const created = await make(checkout, 'Checkout');
    const found = await packages.findByName(orgA, checkout, 'CHECKOUT');
    expect(found?.id).toBe(created.id);
    expect(found?.name).toBe('Checkout');
    expect(await packages.findByName(orgA, search, 'CHECKOUT')).toBeNull();
  });

  it('makes an uploaded version current and stamps the last upload', async () => {
    const created = await make(checkout, 'Checkout');
    // updated_at is timestamptz(3): without a pause the two stamps can tie.
    await sleep(20);
    const v = version();
    const added = await packages.addVersion(orgA, checkout, created.id, v);
    expect(added).not.toBeNull();
    expect(added!.reused).toBe(false);
    expect(added!.package.current?.artifactId).toBe(v.artifactId);
    expect(added!.version.artifactId).toBe(v.artifactId);
    expect(added!.version.simulations).toEqual(['example.BasicSimulation']);
    expect(added!.package.updatedAt.getTime()).toBeGreaterThan(created.updatedAt.getTime());
  });

  it('lists the most recently touched package first, an upload counting as a touch', async () => {
    const older = await make(checkout, 'Older');
    await sleep(20);
    const newer = await make(checkout, 'Newer');
    expect((await packages.list(orgA, checkout)).map((p) => p.id)).toEqual([newer.id, older.id]);

    await sleep(20);
    await packages.addVersion(orgA, checkout, older.id, version());
    expect((await packages.list(orgA, checkout)).map((p) => p.id)).toEqual([older.id, newer.id]);
  });

  it("lists only its own project's packages", async () => {
    const mine = await make(checkout, 'Mine');
    const other = await make(search, 'In another project');
    await make(billing, 'In another org', orgB);

    expect((await packages.list(orgA, checkout)).map((p) => p.id)).toEqual([mine.id]);
    expect((await packages.list(orgA, search)).map((p) => p.id)).toEqual([other.id]);
    // A project of another org is nothing to this one, and the other way round.
    expect(await packages.list(orgA, billing)).toEqual([]);
    expect(await packages.list(orgB, checkout)).toEqual([]);
  });

  it('round-trips an unknown simulations list and Gatling version as null, never as empty', async () => {
    const created = await make(checkout, 'Checkout');
    const unknown = version({ sha256: 'b'.repeat(64), simulations: null, gatlingVersion: null });
    const added = await packages.addVersion(orgA, checkout, created.id, unknown);
    expect(added!.version.simulations).toBeNull();
    expect(added!.version.gatlingVersion).toBeNull();

    const found = await packages.find(orgA, checkout, created.id);
    expect(found!.current?.simulations).toBeNull();
    expect(found!.current?.gatlingVersion).toBeNull();
    // SQL NULL in the column, not a JSON null or an empty list.
    const { rows } = await pool.query<{ unknown: boolean }>(
      'SELECT simulations IS NULL AS unknown FROM runner_artifact WHERE id = $1',
      [unknown.artifactId],
    );
    expect(rows[0]!.unknown).toBe(true);

    // A jar that DECLARES no simulations is a different fact from not knowing.
    const empty = await packages.addVersion(
      orgA,
      checkout,
      created.id,
      version({ sha256: 'c'.repeat(64), simulations: [] }),
    );
    expect(empty!.version.simulations).toEqual([]);
  });

  it('answers with the version this call made current, even when another upload lands right after', async () => {
    const created = await make(checkout, 'Checkout');
    const mine = version({ sha256: 'b'.repeat(64) });
    const theirs = version({ sha256: 'c'.repeat(64) });

    const result = await addVersionWithGap(created.id, mine, () =>
      packages.addVersion(orgA, checkout, created.id, theirs),
    );

    expect(result!.reused).toBe(false);
    expect(result!.version.artifactId).toBe(mine.artifactId);
    expect(result!.package.current?.artifactId).toBe(mine.artifactId);
    // The arrangement did its job: the package has moved on to the other upload.
    expect((await packages.find(orgA, checkout, created.id))!.current?.artifactId).toBe(theirs.artifactId);
  });

  it('still answers when the package is deleted right after the upload committed', async () => {
    const created = await make(checkout, 'Checkout');
    const mine = version();

    const result = await addVersionWithGap(created.id, mine, () => packages.delete(orgA, checkout, created.id));

    expect(result!.version.artifactId).toBe(mine.artifactId);
    expect(result!.package.id).toBe(created.id);
    expect(await packages.find(orgA, checkout, created.id)).toBeNull();
  });

  it('reuses a version with identical bytes instead of storing a second one', async () => {
    const created = await make(checkout, 'Checkout');
    const first = version({ sha256: 'b'.repeat(64) });
    const second = version({ sha256: 'c'.repeat(64) });
    const third = version({ sha256: 'b'.repeat(64) });
    await packages.addVersion(orgA, checkout, created.id, first);
    const afterSecond = await packages.addVersion(orgA, checkout, created.id, second);
    expect(afterSecond!.package.current?.artifactId).toBe(second.artifactId);

    const reused = await packages.addVersion(orgA, checkout, created.id, third);
    expect(reused!.reused).toBe(true);
    expect(reused!.version.artifactId).toBe(first.artifactId);
    expect(reused!.package.current?.artifactId).toBe(first.artifactId);
    expect(await countArtifacts(created.id)).toBe(2);
  });

  it('stores one version when the same bytes are uploaded concurrently', async () => {
    const created = await make(checkout, 'Checkout');
    const uploads = Array.from({ length: 4 }, () => version({ sha256: 'd'.repeat(64) }));

    // Plain Promise.all did not make this go red without the package lock: the
    // calls run one after another fast enough that each sees the previous one's
    // row. So the overlap is FORCED: a connection holds the package row FOR
    // UPDATE, all four uploads are started and observed blocked, and only then
    // is it released. With the lock in addVersion every upload queues at its
    // first statement and then finds the winner's row; without it every upload
    // has already looked for an existing version (finding none) and inserts.
    //
    // Prisma's interactive transactions expire after 5 s, and the clock starts
    // when each begins, so the connections they need are opened first: under
    // load, opening four in the middle of the arrangement once cost the whole
    // budget.
    await Promise.all(uploads.map(() => prisma.$queryRaw`SELECT 1`));
    const holder = await pool.connect();
    let pending: Promise<unknown>[] = [];
    try {
      const { rows } = await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      const holderPid = rows[0]!.pid;
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM package WHERE id = $1 FOR UPDATE', [created.id]);

      const started = uploads.map((upload) => packages.addVersion(orgA, checkout, created.id, upload));
      pending = started;
      const calls = Promise.all(started);
      const rethrowIfFailed = watchRejection(calls);
      // Transitively: only the first waiter on a row is blocked by the holder,
      // the rest queue behind that waiter's tuple lock.
      await waitUntil('all four uploads to be in flight', async () => {
        rethrowIfFailed();
        const waiting = await pool.query<{ n: number }>(
          `WITH RECURSIVE queued(pid) AS (
             SELECT pid FROM pg_stat_activity WHERE $1 = ANY (pg_blocking_pids(pid))
             UNION
             SELECT a.pid FROM pg_stat_activity a JOIN queued q ON q.pid = ANY (pg_blocking_pids(a.pid))
           )
           SELECT count(*)::int AS n FROM queued`,
          [holderPid],
        );
        return waiting.rows[0]!.n >= uploads.length;
      });
      await holder.query('COMMIT');

      const results = await calls;
      const stored = results.filter((r) => r!.reused === false);
      expect(stored).toHaveLength(1);
      expect(await countArtifacts(created.id)).toBe(1);
      // Every caller was answered with the one row that exists.
      expect(new Set(results.map((r) => r!.version.artifactId))).toEqual(
        new Set([stored[0]!.version.artifactId]),
      );
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
      // If the arrangement fell over before the COMMIT, the ROLLBACK above is
      // what frees the lock: wait for the uploads it releases to finish, so none
      // of them runs on into the next test's reset.
      await Promise.allSettled(pending);
    }
  });

  it('never reaches across tenants', async () => {
    const created = await make(checkout, 'Checkout');
    expect(await packages.find(orgA, search, created.id)).toBeNull();
    expect(await packages.find(orgB, billing, created.id)).toBeNull();
    expect(await packages.rename(orgA, search, created.id, 'Stolen')).toBeNull();
    expect(await packages.addVersion(orgA, search, created.id, version())).toBeNull();
    expect(await packages.delete(orgA, search, created.id)).toEqual({ kind: 'not_found' });

    // The package is untouched by every one of those.
    const still = await packages.find(orgA, checkout, created.id);
    expect(still?.name).toBe('Checkout');
    expect(still?.current).toBeNull();
  });

  it('counts usage over runs, durably, and active jobs over every version', async () => {
    const created = await make(checkout, 'Checkout');
    const v1 = version({ sha256: 'b'.repeat(64) });
    const v2 = version({ sha256: 'c'.repeat(64) });
    await packages.addVersion(orgA, checkout, created.id, v1);
    await packages.addVersion(orgA, checkout, created.id, v2);
    const t1 = await testIn(checkout, 'one');
    const t2 = await testIn(checkout, 'two');

    await job(checkout, v1.artifactId, 'complete', t1);
    await job(checkout, v2.artifactId, 'complete', t2);
    // A second run of T1 (tests are DISTINCT, runs are not) and a run with no
    // test yet (a run, never a test).
    await job(checkout, v1.artifactId, 'complete', t1);
    await job(checkout, v2.artifactId, 'complete', null);
    await job(checkout, v1.artifactId, 'queued');

    const before = await packages.find(orgA, checkout, created.id);
    expect(before!.usage).toEqual({ tests: 2, runs: 4, activeJobs: 1 });

    // Retention removes old jobs; the runs and their tests were counted on the
    // run's own package_id, so they survive it.
    await pool.query('DELETE FROM runner_job');
    const after = await packages.find(orgA, checkout, created.id);
    expect(after!.usage).toEqual({ tests: 2, runs: 4, activeJobs: 0 });
  });

  it('refuses to delete while a job of any version is active, naming the count', async () => {
    const created = await make(checkout, 'Checkout');
    const v1 = version({ sha256: 'b'.repeat(64) });
    const v2 = version({ sha256: 'c'.repeat(64) });
    await packages.addVersion(orgA, checkout, created.id, v1);
    await packages.addVersion(orgA, checkout, created.id, v2);
    await job(checkout, v1.artifactId, 'running');
    await job(checkout, v2.artifactId, 'queued');

    expect(await packages.delete(orgA, checkout, created.id)).toEqual({ kind: 'in_use', activeJobs: 2 });
    expect(await packages.find(orgA, checkout, created.id)).not.toBeNull();
  });

  it.each(['queued', 'starting', 'running', 'closing'])(
    'counts a %s job as active, for usage and for delete',
    async (status) => {
      const created = await make(checkout, 'Checkout');
      const v = version();
      await packages.addVersion(orgA, checkout, created.id, v);
      await job(checkout, v.artifactId, status);

      expect((await packages.find(orgA, checkout, created.id))!.usage.activeJobs).toBe(1);
      expect(await packages.delete(orgA, checkout, created.id)).toEqual({ kind: 'in_use', activeJobs: 1 });
    },
  );

  it.each(['complete', 'failed', 'cancelled'])('does not count a %s job as active', async (status) => {
    const created = await make(checkout, 'Checkout');
    const v = version();
    await packages.addVersion(orgA, checkout, created.id, v);
    await job(checkout, v.artifactId, status);

    expect((await packages.find(orgA, checkout, created.id))!.usage.activeJobs).toBe(0);
    expect((await packages.delete(orgA, checkout, created.id)).kind).toBe('deleted');
  });

  it('waits for a start in flight, then refuses on the job that start queued', async () => {
    const created = await make(checkout, 'Checkout');
    const v = version();
    await packages.addVersion(orgA, checkout, created.id, v);

    // A start holds the package row FOR SHARE while it queues its job. The
    // delete has to wait for it and then count on a snapshot that sees the job;
    // a delete that counted first would see nothing and remove a package a run
    // is about to start from.
    const starter = await pool.connect();
    let outcome: Promise<unknown> = Promise.resolve();
    try {
      const { rows } = await starter.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      const starterPid = rows[0]!.pid;
      await starter.query('BEGIN');
      await starter.query('SELECT id FROM package WHERE id = $1 FOR SHARE', [created.id]);

      outcome = packages.delete(orgA, checkout, created.id).then(
        (result) => result,
        (err: unknown) => err,
      );

      // Poll from a connection that is neither the starter's nor the delete's,
      // in autocommit: a snapshot taken inside a transaction would freeze.
      await waitUntil('the delete to queue behind the start', async () => {
        const waiting = await pool.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1 = ANY (pg_blocking_pids(pid))',
          [starterPid],
        );
        return waiting.rows[0]!.n > 0;
      });

      await starter.query(
        `INSERT INTO runner_job (org_id, project_id, artifact_id, status, requested_by, name, simulation_class)
         VALUES ($1, $2, $3, 'queued', 'ci', 'nightly', 'example.BasicSimulation')`,
        [orgA, checkout, v.artifactId],
      );
      await starter.query('COMMIT');

      expect(await outcome).toEqual({ kind: 'in_use', activeJobs: 1 });
      expect(await packages.find(orgA, checkout, created.id)).not.toBeNull();
    } finally {
      await starter.query('ROLLBACK').catch(() => undefined);
      starter.release();
      // A delete still queued when the arrangement fell over is released by the
      // ROLLBACK: let it finish rather than run on into the next test's reset.
      await outcome;
    }
  });

  it('deletes when nothing is active, keeps the version rows, and hands back every file', async () => {
    const created = await make(checkout, 'Checkout');
    const v1 = version({ sha256: 'b'.repeat(64) });
    const v2 = version({ sha256: 'c'.repeat(64) });
    await packages.addVersion(orgA, checkout, created.id, v1);
    await packages.addVersion(orgA, checkout, created.id, v2);
    const t1 = await testIn(checkout, 'one');
    await job(checkout, v1.artifactId, 'complete', t1);

    const result = await packages.delete(orgA, checkout, created.id);
    expect(result.kind).toBe('deleted');
    if (result.kind !== 'deleted') throw new Error('unreachable');
    expect([...result.storagePaths].sort()).toEqual([v1.storagePath, v2.storagePath].sort());

    expect(await packages.find(orgA, checkout, created.id)).toBeNull();
    const artifacts = await prisma.runnerArtifact.findMany({
      where: { id: { in: [v1.artifactId, v2.artifactId] } },
    });
    expect(artifacts).toHaveLength(2);
    expect(artifacts.every((a) => a.packageId === null)).toBe(true);
    const runs = await prisma.run.findMany({ where: { projectId: checkout } });
    expect(runs).toHaveLength(1);
    expect(runs[0]!.packageId).toBeNull();
  });

  it('renames, and refuses a taken name on rename', async () => {
    const first = await make(checkout, 'Checkout');
    const second = await make(checkout, 'Other');

    const renamed = await packages.rename(orgA, checkout, first.id, 'New name');
    expect(renamed?.name).toBe('New name');

    await expect(packages.rename(orgA, checkout, second.id, 'new NAME')).rejects.toBeInstanceOf(
      PackageNameTakenError,
    );
    // The refused rename changed nothing.
    expect((await packages.find(orgA, checkout, second.id))?.name).toBe('Other');
  });
});
