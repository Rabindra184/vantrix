import { createPool, createPrisma, SCHEMA_TABLES } from '@perfportal/persistence';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { loadWorkerConfig } from '../src/config.js';
import { randomUUID } from 'node:crypto';
import { resolveTestId, slugifySimulation } from '../src/pipeline/test-resolver.js';

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
 * ═══ THE REAL FUNCTION, NOT A MIRROR OF ITS SQL ═══
 *
 * This file used to hold a verbatim copy of the worker's upsert and drive it
 * directly, with a separate case reading `test-resolver.ts` to prove the copy
 * had not drifted. That worked while the SQL WAS the whole rule: the upsert
 * conflicted on `(project_id, simulation_class)`, so running it twice for one
 * class was idempotent all by itself.
 *
 * `20260823170000_test_per_configuration` dropped that unique index, and the
 * conflict target moved to `(project_id, slug)`. The upsert alone is no longer
 * idempotent per class — run it twice and the candidate CTE picks
 * `example-paritysimulation-2` the second time, because the base slug is taken
 * and nothing has looked for an existing test of that CLASS. The SELECT that
 * precedes it in `resolveTestId` is what makes the whole thing idempotent now.
 *
 * So the mirror is gone, along with the drift guard it needed. Correctness
 * moved out of the database and into the function, and the function is what
 * this file calls.
 */
const resolve = (simulation: string | null, declaredTestSlug?: string): Promise<string | null> =>
  resolveTestId(
    pool,
    { id: randomUUID(), orgId, projectId, ...(declaredTestSlug ? { declaredTestSlug } : {}) },
    simulation,
  );

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
    const b = await resolveTestId(
      pool,
      { id: randomUUID(), orgId, projectId: other.id },
      'example.ParitySimulation',
    );

    expect(b).not.toBe(a);
    const { rows: counted } = await pool.query<{ count: string }>('SELECT count(*) FROM test');
    expect(counted[0]!.count).toBe('2');
  });
});

/**
 * ═══ A TEST IS A CONFIGURATION, NOT A SIMULATION CLASS ═══
 *
 * `20260823170000_test_per_configuration` dropped
 * `test_project_id_simulation_class_key` so a project can run ONE simulation
 * as TWO tests — "checkout smoke" and "checkout soak" with different injection
 * profiles, which is how Gatling Enterprise models it. A caller says which by
 * declaring `metadata.test`; saying nothing keeps the old behaviour exactly.
 */
describe('a caller that names its test', () => {
  it('creates a test under exactly the slug it asked for', async () => {
    const id = await resolve('example.ParitySimulation', 'checkout-soak');

    const { rows } = await pool.query<{ slug: string; name: string; simulation_class: string }>(
      'SELECT slug, name, simulation_class FROM test',
    );
    expect(rows).toHaveLength(1);
    // NAMED after the slug and CLASSED after the header — the two are separate
    // facts, and this is the one moment both are known at once.
    expect(rows[0]).toMatchObject({
      slug: 'checkout-soak',
      name: 'checkout-soak',
      simulation_class: 'example.ParitySimulation',
    });
    expect(id).not.toBeNull();
  });

  /**
   * ═══ THE CASE THE WHOLE MIGRATION EXISTS FOR ═══
   *
   * Two tests, one simulation class. This was a unique-constraint violation
   * before, and the second `resolve` would have returned the first test's id.
   */
  it('lets one simulation be two tests with different names', async () => {
    const smoke = await resolve('example.ParitySimulation', 'checkout-smoke');
    const soak = await resolve('example.ParitySimulation', 'checkout-soak');

    expect(soak).not.toBe(smoke);
    const { rows } = await pool.query<{ count: string }>('SELECT count(*) FROM test');
    expect(rows[0]!.count).toBe('2');
  });

  it('reuses the test on the next run that names it', async () => {
    const first = await resolve('example.ParitySimulation', 'checkout-soak');
    const second = await resolve('example.ParitySimulation', 'checkout-soak');

    expect(second).toBe(first);
    const { rows } = await pool.query<{ count: string }>('SELECT count(*) FROM test');
    expect(rows[0]!.count).toBe('1');
  });

  /**
   * The declaration is a HUMAN's statement about what this run is, so it wins
   * over the class — and the test's own `simulation_class` is left as what it
   * was FIRST seen running rather than being rewritten to the newest. It
   * records an origin, not a running log of the most recent run.
   */
  it('honours the slug even when the class differs, without rewriting the class', async () => {
    const first = await resolve('example.ParitySimulation', 'checkout-soak');
    const second = await resolve('other.SearchSimulation', 'checkout-soak');

    expect(second).toBe(first);
    const { rows } = await pool.query<{ simulation_class: string }>(
      'SELECT simulation_class FROM test',
    );
    expect(rows[0]!.simulation_class).toBe('example.ParitySimulation');
  });

  /**
   * A declared test needs no class at all — a producer that named its test and
   * died before writing a header. The test exists, correctly named, and its
   * class records the only thing anybody knows.
   */
  it('creates a declared test for a run whose header said nothing', async () => {
    const id = await resolve(null, 'checkout-soak');

    expect(id).not.toBeNull();
    const { rows } = await pool.query<{ slug: string; simulation_class: string }>(
      'SELECT slug, simulation_class FROM test',
    );
    expect(rows[0]).toMatchObject({ slug: 'checkout-soak', simulation_class: 'checkout-soak' });
  });

  it('produces ONE test when two runs declaring the same slug resolve concurrently', async () => {
    const [a, b] = await Promise.all([
      resolve('example.ParitySimulation', 'checkout-soak'),
      resolve('example.ParitySimulation', 'checkout-soak'),
    ]);

    expect(a).toBe(b);
    const { rows } = await pool.query<{ count: string }>('SELECT count(*) FROM test');
    expect(rows[0]!.count).toBe('1');
  });

  /**
   * ═══ AND WHAT HAPPENS TO A RUN THAT DECLARES NOTHING, AFTER A SPLIT ═══
   *
   * It joins the OLDEST test with its class — the one that existed before
   * anybody split it. That is a decision, not a fallout: a CI job nobody
   * updated keeps landing exactly where it always did, which is the difference
   * between this migration being invisible to existing users and it breaking
   * every un-updated pipeline the day one project splits a test.
   *
   * The alternative (leave it ungrouped) is more literal and fails silently —
   * trends going flat rather than anything erroring.
   */
  it('sends an undeclared run to the oldest test of its class, not an arbitrary one', async () => {
    const first = await resolve('example.ParitySimulation', 'checkout-smoke');
    await resolve('example.ParitySimulation', 'checkout-soak');

    expect(await resolve('example.ParitySimulation')).toBe(first);
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
