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

  it('suffixes a stem the project already used, ignoring case, and keeps kinds apart', async () => {
    await withLegacySchema(async (client) => {
      await legacy(client, { filename: 'Load.jar', createdAt: '2026-08-01T10:00:00Z' });
      await legacy(client, { filename: 'load.jar', createdAt: '2026-08-02T10:00:00Z' });
      await legacy(client, { filename: 'load.tar.gz', kind: 'gatling_bundle', createdAt: '2026-08-03T10:00:00Z' });

      for (const statement of backfillStatements()) await client.query(statement);

      const names = await client.query<{ name: string; kind: string }>(
        `SELECT name, kind FROM package WHERE project_id = $1 ORDER BY created_at`,
        [projectId],
      );
      expect(names.rows).toEqual([
        { name: 'Load', kind: 'gatling_jar' },
        { name: 'load-2', kind: 'gatling_jar' },
        { name: 'load-3', kind: 'gatling_bundle' },
      ]);
    });
  });
});
