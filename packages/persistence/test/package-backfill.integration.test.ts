import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createPool, createPrisma, SCHEMA_TABLES } from '../src/index.js';

/**
 * The migration's own backfill, read out of the file between its markers and
 * executed verbatim on ONE client — it creates a temporary table that later
 * statements read, and a pool hands each query a connection of its own.
 */
const pool = createPool(process.env.DATABASE_URL ?? '');
const prisma = createPrisma(process.env.DATABASE_URL ?? '');

afterAll(async () => {
  await pool.end();
  await prisma.$disconnect();
});

let orgId = '';
let projectId = '';

beforeEach(async () => {
  await pool.query(`TRUNCATE TABLE ${SCHEMA_TABLES.map((t) => `"${t}"`).join(', ')} CASCADE`);
  const org = await prisma.org.create({ data: { slug: 'acme', name: 'Acme' } });
  const project = await prisma.project.create({
    data: { orgId: org.id, slug: 'checkout', name: 'Checkout', settings: {} },
  });
  orgId = org.id;
  projectId = project.id;
});

function backfillStatements(): string[] {
  const sql = readFileSync(
    fileURLToPath(new URL('../prisma/migrations/20261002120000_packages/migration.sql', import.meta.url)),
    'utf8',
  );
  const block = sql.split('-- BACKFILL: begin')[1]!.split('-- BACKFILL: end')[0]!;
  const statements = block.split(';').map((s) => s.trim()).filter((s) => s !== '');
  // Vacuity guard: a moved marker would leave nothing to run, and every
  // assertion below would then describe the fixture's own nulls.
  expect(statements).toHaveLength(7);
  return statements;
}

/** A pre-migration artifact and its job: no package, the job's name and
 *  class still only on the artifact. Inserted with the job columns' NOT NULL
 *  dropped inside the case's own transaction, then rolled back. */
async function legacy(
  client: import('pg').PoolClient,
  opts: { filename: string; kind?: string; createdAt: string; runId?: string | null },
): Promise<{ artifactId: string; jobId: string }> {
  const artifactId = randomUUID();
  const jobId = randomUUID();
  await client.query(
    `INSERT INTO runner_artifact (id, org_id, project_id, name, filename, kind, simulation_class,
       gatling_version, sha256, bytes, storage_path, created_at)
     VALUES ($1, $2, $3, 'nightly load', $4, $5, 'example.BasicSimulation', '3.15.1',
       $6, 10, $7, $8)`,
    [artifactId, orgId, projectId, opts.filename, opts.kind ?? 'gatling_jar', 'a'.repeat(64),
      `${orgId}/${projectId}/${artifactId}.jar`, opts.createdAt],
  );
  await client.query(
    `INSERT INTO runner_job (id, org_id, project_id, artifact_id, run_id, status, requested_by,
       system_properties, name, simulation_class)
     VALUES ($1, $2, $3, $4, $5, 'complete', 'ci', '{}'::jsonb, NULL, NULL)`,
    [jobId, orgId, projectId, artifactId, opts.runId ?? null],
  );
  return { artifactId, jobId };
}

async function seedRun(): Promise<string> {
  const run = await prisma.run.create({
    data: {
      orgId, projectId, status: 'complete', verdict: 'passed', tool: 'gatling',
      bundleKey: `runs/${projectId}/${randomUUID()}.tgz`, bundleSha256: 'a'.repeat(64),
      bundleBytes: 1n, startedAt: new Date('2026-09-01T10:00:00Z'),
      startedOn: new Date('2026-09-01'), engineOptions: {},
    },
  });
  return run.id;
}

async function withLegacySchema<T>(body: (client: import('pg').PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('ALTER TABLE runner_job ALTER COLUMN name DROP NOT NULL');
    await client.query('ALTER TABLE runner_job ALTER COLUMN simulation_class DROP NOT NULL');
    return await body(client);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

describe('the backfill that made packages of existing artifacts', () => {
  it('groups by filename stem and kind, makes the newest current, and copies job fields', async () => {
    const runId = await seedRun();
    await withLegacySchema(async (client) => {
      const old = await legacy(client, { filename: 'gatling-demo-tests.jar', createdAt: '2026-08-01T10:00:00Z' });
      const mid = await legacy(client, { filename: 'gatling-demo-tests.jar', createdAt: '2026-08-02T10:00:00Z', runId });
      const newest = await legacy(client, { filename: 'gatling-demo-tests.jar', createdAt: '2026-08-03T10:00:00Z' });
      const other = await legacy(client, { filename: 'search.jar', createdAt: '2026-08-04T10:00:00Z' });

      for (const statement of backfillStatements()) await client.query(statement);

      const packages = await client.query<{ id: string; name: string; kind: string; current: string }>(
        `SELECT id, name, kind, current_artifact_id AS current FROM package WHERE project_id = $1 ORDER BY name`,
        [projectId],
      );
      expect(packages.rows.map((p) => p.name)).toEqual(['gatling-demo-tests', 'search']);
      const demo = packages.rows[0]!;
      expect(demo.kind).toBe('gatling_jar');
      expect(demo.current).toBe(newest.artifactId);
      expect(packages.rows[1]!.current).toBe(other.artifactId);

      const versions = await client.query<{ id: string; package_id: string }>(
        `SELECT id, package_id FROM runner_artifact WHERE id = ANY($1::uuid[])`,
        [[old.artifactId, mid.artifactId, newest.artifactId]],
      );
      expect(new Set(versions.rows.map((v) => v.package_id))).toEqual(new Set([demo.id]));

      const job = await client.query<{ name: string; simulation_class: string }>(
        `SELECT name, simulation_class FROM runner_job WHERE id = $1`,
        [mid.jobId],
      );
      expect(job.rows[0]).toEqual({ name: 'nightly load', simulation_class: 'example.BasicSimulation' });

      const run = await client.query<{ package_id: string }>(`SELECT package_id FROM run WHERE id = $1`, [runId]);
      expect(run.rows[0]!.package_id).toBe(demo.id);
    });
  });

  it('makes one package of filenames that differ only in case, and keeps kinds apart', async () => {
    await withLegacySchema(async (client) => {
      const first = await legacy(client, { filename: 'Load.jar', createdAt: '2026-08-01T10:00:00Z' });
      const second = await legacy(client, { filename: 'load.jar', createdAt: '2026-08-02T10:00:00Z' });
      const bundle = await legacy(client, { filename: 'load.tar.gz', kind: 'gatling_bundle', createdAt: '2026-08-03T10:00:00Z' });

      for (const statement of backfillStatements()) await client.query(statement);

      const packages = await client.query<{ id: string; name: string; kind: string; current: string }>(
        `SELECT id, name, kind, current_artifact_id AS current FROM package WHERE project_id = $1 ORDER BY created_at`,
        [projectId],
      );
      // The jar package is named after its EARLIEST upload's stem; the bundle
      // shares the stem ignoring case, so its name is taken and it is suffixed.
      expect(packages.rows.map((p) => ({ name: p.name, kind: p.kind }))).toEqual([
        { name: 'Load', kind: 'gatling_jar' },
        { name: 'load (2)', kind: 'gatling_bundle' },
      ]);
      expect(packages.rows[0]!.current).toBe(second.artifactId);
      expect(packages.rows[1]!.current).toBe(bundle.artifactId);

      const versions = await client.query<{ id: string; package_id: string }>(
        `SELECT id, package_id FROM runner_artifact WHERE id = ANY($1::uuid[])`,
        [[first.artifactId, second.artifactId]],
      );
      expect(versions.rows).toHaveLength(2);
      expect(new Set(versions.rows.map((v) => v.package_id))).toEqual(new Set([packages.rows[0]!.id]));
    });
  });

  it('puts demo.jar and DEMO.jar in one package', async () => {
    await withLegacySchema(async (client) => {
      const lower = await legacy(client, { filename: 'demo.jar', createdAt: '2026-08-01T10:00:00Z' });
      const upper = await legacy(client, { filename: 'DEMO.jar', createdAt: '2026-08-02T10:00:00Z' });

      for (const statement of backfillStatements()) await client.query(statement);

      const packages = await client.query<{ id: string; name: string; current: string }>(
        `SELECT id, name, current_artifact_id AS current FROM package WHERE project_id = $1`,
        [projectId],
      );
      expect(packages.rows.map((p) => p.name)).toEqual(['demo']);
      expect(packages.rows[0]!.current).toBe(upper.artifactId);
      const versions = await client.query<{ package_id: string }>(
        `SELECT package_id FROM runner_artifact WHERE id = ANY($1::uuid[])`,
        [[lower.artifactId, upper.artifactId]],
      );
      expect(versions.rows.map((v) => v.package_id)).toEqual([packages.rows[0]!.id, packages.rows[0]!.id]);
    });
  });

  /**
   * ═══ THE BACKFILL'S STEM IS THE API'S STEM ═══
   *
   * A package made here is found again by the next upload of the same filename
   * only if both name it alike — and they did not: `left(…, 112)` kept the
   * space before the extension that the API's `.trim()` drops, so "my file
   * .jar" became "my file " here and "my file" there, and a later upload of
   * that very file missed the package and started a second one.
   *
   * THE EXPECTED NAMES ARE `packageNameFromFilename`'S, RESTATED rather than
   * imported (apps/api/src/runner/package-files.ts): this package cannot import
   * from apps/api — it is outside this package's rootDir, and apps/api depends
   * on this package. Each filename is also a row of
   * apps/api/test/package-files.test.ts's own table, which pins it against that
   * function, so the two halves of the pair are asserted on the same inputs.
   *
   * The name is read THROUGH THE VERSION'S package_id, because the join is half
   * the claim: the second stem expression has to find the package the first one
   * named, and a version left with no package would make this read nothing.
   */
  it.each([
    ['a stem with a space before its extension', 'my file .jar', 'my file'],
    ['a filename that is only an extension', '.jar', 'package'],
    ['a filename with no extension', 'nightly-load', 'nightly-load'],
    ['a stem longer than 112 characters', `${'x'.repeat(130)}.jar`, 'x'.repeat(112)],
    ['a stem cut at 112 characters just after a space', `${'y'.repeat(111)} tail.jar`, 'y'.repeat(111)],
  ])('names the package for %s exactly as the API would', async (_what, filename, expected) => {
    await withLegacySchema(async (client) => {
      const { artifactId } = await legacy(client, { filename, createdAt: '2026-08-01T10:00:00Z' });

      for (const statement of backfillStatements()) await client.query(statement);

      const named = await client.query<{ name: string }>(
        `SELECT p.name FROM runner_artifact a JOIN package p ON p.id = a.package_id WHERE a.id = $1`,
        [artifactId],
      );
      expect(named.rows.map((row) => row.name)).toEqual([expected]);
    });
  });

  it('never proposes two names that differ only in case, even when a stem looks like a suffix', async () => {
    await withLegacySchema(async (client) => {
      // The collision that aborted the first backfill: load.jar and Load.jar
      // were two packages, the second suffixed to load-2, and load-2.jar was a
      // third by that very name. The bundle is what makes the suffix rule
      // bite: a jar and a bundle called load need a disambiguator, and a
      // "-2" one would meet load-2.jar.
      await legacy(client, { filename: 'load.jar', createdAt: '2026-08-01T10:00:00Z' });
      await legacy(client, { filename: 'Load.jar', createdAt: '2026-08-02T10:00:00Z' });
      await legacy(client, { filename: 'load-2.jar', createdAt: '2026-08-03T10:00:00Z' });
      await legacy(client, { filename: 'load.tar.gz', kind: 'gatling_bundle', createdAt: '2026-08-04T10:00:00Z' });

      for (const statement of backfillStatements()) await client.query(statement);

      const names = await client.query<{ name: string; kind: string }>(
        `SELECT name, kind FROM package WHERE project_id = $1 ORDER BY created_at`,
        [projectId],
      );
      expect(names.rows).toEqual([
        { name: 'load', kind: 'gatling_jar' },
        { name: 'load-2', kind: 'gatling_jar' },
        { name: 'load (2)', kind: 'gatling_bundle' },
      ]);
      const distinct = new Set(names.rows.map((r) => r.name.toLowerCase()));
      expect(distinct.size).toBe(names.rows.length);
    });
  });
});
