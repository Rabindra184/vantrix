import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createPool, createPrisma, SCHEMA_TABLES } from '@perfportal/persistence';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { loadWorkerConfig } from '../src/config.js';
import { slugifySimulation } from '../src/pipeline/test-resolver.js';

/**
 * The `test` row a run belongs to, and the two rules that have to agree about
 * it: the migration's, which ran once over history, and the worker's, which
 * runs on every parse from now on.
 *
 * ═══ WHY THIS FILE EXISTS AT ALL ═══
 *
 * `20260822220000_test_entity` grouped every parsed run by
 * `(project_id, simulation)` and derived a slug in SQL. `#resolveTestId` does
 * the same thing in TypeScript, on the same key, for every run after it. If
 * those two ever disagree the symptom is not an error — it is a SECOND test
 * appearing for a simulation class that already had one, with the history
 * split across both and trends quietly showing half of it.
 *
 * A real `gatlingRun` proved the happy path when this shipped (two runs, one
 * test, both assigned). What that cannot exercise is the cases below: a
 * collision, a race, and the exact strings where two spellings of one rule
 * come apart.
 */

const config = loadWorkerConfig({ ...process.env, DATABASE_URL: process.env.DATABASE_URL ?? '' });
const pool = createPool(config.databaseUrl);
const prisma = createPrisma(config.databaseUrl);

afterAll(async () => {
  await pool.end();
  await prisma.$disconnect();
});

let projectId = '';
let orgId = '';

beforeEach(async () => {
  await pool.query(`TRUNCATE TABLE ${SCHEMA_TABLES.map((t) => `"${t}"`).join(', ')} CASCADE`);
  const org = await prisma.org.create({ data: { slug: 'acme', name: 'Acme' } });
  const project = await prisma.project.create({
    data: { orgId: org.id, slug: 'checkout', name: 'Checkout', settings: {} },
  });
  orgId = org.id;
  projectId = project.id;
});

/**
 * The worker's own statement, verbatim. Copied rather than reached for through
 * `resolveTestId`, because driving a whole pipeline run per case would test
 * the parser, the engine and the object store to answer a question about one
 * INSERT.
 *
 * IT MOVED OUT OF `PipelineService` and into `test-resolver.ts`, which is
 * exactly what this drift guard exists for at one remove: there are TWO
 * callers now — the pipeline at finalize and `LiveFoldOwner` the moment the
 * streaming decoder reads the log header — and a second COPY of this
 * resolve-or-create would surface as a second test appearing for a class that
 * already had one, with the history split across both.
 *
 * The copy is the risk this file is about, so it is asserted against the real
 * one: `the worker's statement is the one this file tests` below reads
 * `test-resolver.ts` and fails if the SQL there stops matching.
 */
const UPSERT = `WITH candidate AS (
   SELECT CASE WHEN n = 1 THEN $3::text ELSE $3::text || '-' || n END AS slug
     FROM generate_series(1, 50) AS n
    WHERE NOT EXISTS (
          SELECT 1 FROM test t
           WHERE t.project_id = $2::uuid
             AND t.slug = CASE WHEN n = 1 THEN $3::text ELSE $3::text || '-' || n END)
    ORDER BY n
    LIMIT 1)
 INSERT INTO test (id, org_id, project_id, slug, name, simulation_class, created_at, updated_at)
 SELECT gen_random_uuid(), $1::uuid, $2::uuid, c.slug, $4, $4, now(), now()
   FROM candidate c
 ON CONFLICT (project_id, simulation_class) DO UPDATE SET updated_at = test.updated_at
 RETURNING id`;

const resolve = async (simulation: string): Promise<string> => {
  const { rows } = await pool.query<{ id: string }>(UPSERT, [
    orgId,
    projectId,
    slugifySimulation(simulation),
    simulation,
  ]);
  return rows[0]!.id;
};

describe('resolving the test a run belongs to', () => {
  it('creates one on first sight and reuses it after', async () => {
    const first = await resolve('example.ParitySimulation');
    const second = await resolve('example.ParitySimulation');

    expect(second).toBe(first);
    const { rows } = await pool.query<{ count: string }>('SELECT count(*) FROM test');
    expect(rows[0]!.count).toBe('1');
  });

  /**
   * ═══ THE RACE THAT WOULD SPLIT A TEST'S HISTORY ═══
   *
   * Two runs of a brand-new simulation class finishing at once. A
   * read-then-write would have both read "no test", both insert, and one fail
   * — or worse, on a schema without the unique index, both succeed and the
   * class ends up with two tests holding half its runs each.
   *
   * `ON CONFLICT … DO UPDATE` rather than `DO NOTHING` is what makes the loser
   * of the race get the winner's id back: only DO UPDATE returns a row.
   */
  it('produces ONE test when two runs of a new class resolve concurrently', async () => {
    const ids = await Promise.all(
      Array.from({ length: 8 }, () => resolve('example.ParitySimulation')),
    );

    expect(new Set(ids).size).toBe(1);
    const { rows } = await pool.query<{ count: string }>('SELECT count(*) FROM test');
    expect(rows[0]!.count).toBe('1');
  });

  /**
   * Two DIFFERENT classes whose slugs collide. `checkout.Basic` and
   * `checkout-Basic` are different simulations — the unique index on
   * `simulation_class` says so — but both slugify to `checkout-basic`, and the
   * slug has a unique index of its own.
   */
  it('gives a colliding slug a suffix rather than failing the second run', async () => {
    const a = await resolve('checkout.Basic');
    const b = await resolve('checkout-Basic');
    const c = await resolve('Checkout__basic');

    expect(new Set([a, b, c]).size).toBe(3);
    const { rows } = await pool.query<{ simulation_class: string; slug: string }>(
      'SELECT simulation_class, slug FROM test ORDER BY created_at, simulation_class',
    );
    expect(rows.map((r) => r.slug).sort()).toEqual([
      'checkout-basic',
      'checkout-basic-2',
      'checkout-basic-3',
    ]);
  });

  /**
   * A class that is entirely punctuation slugifies to nothing, and a row with
   * an empty slug is a URL that cannot be addressed.
   */
  it('falls back to a usable slug for a class that slugifies to nothing', async () => {
    await resolve('...');
    const { rows } = await pool.query<{ slug: string }>('SELECT slug FROM test');
    expect(rows[0]!.slug).toBe('test');
  });

  it('keeps two projects independent, so the same class is two tests', async () => {
    const other = await prisma.project.create({
      data: { orgId, slug: 'payments', name: 'Payments', settings: {} },
    });
    const a = await resolve('example.ParitySimulation');
    const { rows } = await pool.query<{ id: string }>(UPSERT, [
      orgId,
      other.id,
      slugifySimulation('example.ParitySimulation'),
      'example.ParitySimulation',
    ]);

    expect(rows[0]!.id).not.toBe(a);
    const { rows: counted } = await pool.query<{ count: string }>('SELECT count(*) FROM test');
    expect(counted[0]!.count).toBe('2');
  });
});

/**
 * ═══ ONE RULE, TWO SPELLINGS ═══
 *
 * The migration derives its slug in SQL and the worker derives it in
 * TypeScript. Neither can be deleted — a migration cannot call application
 * code, and the worker cannot run a migration per parse — so the mitigation is
 * to assert they agree rather than to trust that they do.
 */
describe('the TypeScript and SQL slug rules agree', () => {
  const CASES = [
    'example.ParitySimulation',
    'checkout.Basic',
    'checkout-Basic',
    'Checkout__basic',
    'com.acme.load.Search_Flow',
    '  Leading And Trailing  ',
    'UPPER.CASE.ONLY',
    'digits123.Mixed456',
    'consecutive---hyphens',
  ];

  it('produces the same slug for every shape a class name takes', async () => {
    for (const value of CASES) {
      const { rows } = await pool.query<{ slug: string | null }>(
        `SELECT NULLIF(trim(BOTH '-' FROM regexp_replace(lower($1::text), '[^a-z0-9]+', '-', 'g')), '') AS slug`,
        [value],
      );
      // The SQL yields NULL for a class that slugifies to nothing; the
      // migration COALESCEs that to 'test', which is what the TS returns.
      expect(rows[0]!.slug ?? 'test', `slug for ${JSON.stringify(value)}`).toBe(
        slugifySimulation(value),
      );
    }
  });

  it('agrees on the empty case both sides have to special-case', async () => {
    const { rows } = await pool.query<{ slug: string | null }>(
      `SELECT NULLIF(trim(BOTH '-' FROM regexp_replace(lower($1::text), '[^a-z0-9]+', '-', 'g')), '') AS slug`,
      ['...'],
    );
    expect(rows[0]!.slug).toBeNull();
    expect(slugifySimulation('...')).toBe('test');
  });
});

/**
 * ═══ THE COPY ABOVE IS ONLY SAFE IF IT IS STILL A COPY ═══
 *
 * `UPSERT` is `#resolveTestId`'s statement, duplicated into this file because
 * the method is private and driving a whole pipeline run per case would test
 * the parser, the engine and the object store to answer a question about one
 * INSERT.
 *
 * Duplication like that rots silently: someone fixes the real statement, this
 * file keeps passing against the old one, and the tests above go on proving
 * things about SQL that no longer runs. So it is read from source and compared
 * — the same file-reading mirror `palette.test.ts` uses to keep its copy of
 * the theme honest.
 *
 * Compared on the SHAPE, not byte-for-byte: whitespace and indentation move
 * when the surrounding code does, and a test that fails on a re-indent is a
 * test people learn to ignore.
 */
describe("the worker's statement is the one this file tests", () => {
  const normalise = (sql: string): string => sql.replace(/\s+/g, ' ').trim();

  it('matches the SQL in test-resolver.ts', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../src/pipeline/test-resolver.ts', import.meta.url)),
      'utf8',
    );
    const match = /`(WITH candidate AS[\s\S]*?RETURNING id)`/.exec(source);
    expect(match, 'no `WITH candidate AS … RETURNING id` statement found in test-resolver.ts')
      .not.toBeNull();
    expect(normalise(match![1]!)).toBe(normalise(UPSERT));
  });
});
