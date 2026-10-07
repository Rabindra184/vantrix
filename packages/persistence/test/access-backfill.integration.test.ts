import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createPool, createPrisma } from '../src/index.js';
import { requireDatabaseUrl, resetDatabase } from './support/db.js';

/**
 * The upgrade's one data change, read out of the migration file between its
 * markers and executed verbatim — the same shape as
 * package-backfill.integration.test.ts, so what is tested is the SQL that
 * ships and not a copy of it.
 *
 * Every `org_member` row is an admin's today (bootstrap and the fixtures both
 * wrote `'admin'`), so promoting every member is what keeps everyone's access
 * through the upgrade. The second user is what makes that claim falsifiable:
 * a block that promoted EVERY account would satisfy the first assertion alone.
 */
const url = requireDatabaseUrl();
const pool = createPool(url);
const prisma = createPrisma(url);

afterAll(async () => {
  await pool.end();
  await prisma.$disconnect();
});

beforeEach(async () => {
  await resetDatabase(pool);
});

function adminStatements(): string[] {
  const sql = readFileSync(
    fileURLToPath(new URL('../prisma/migrations/20261007120000_project_access/migration.sql', import.meta.url)),
    'utf8',
  );
  const block = sql.split('-- ADMINS: begin')[1]?.split('-- ADMINS: end')[0] ?? '';
  const statements = block.split(';').map((s) => s.trim()).filter((s) => s !== '');
  // Vacuity guard: a moved marker would leave nothing to run, and the
  // assertions below would then describe the column's own default.
  expect(statements).toHaveLength(1);
  return statements;
}

describe('the upgrade that made every existing member an admin', () => {
  it('promotes a user with an org membership and leaves one without as a user', async () => {
    const org = await prisma.org.create({ data: { slug: 'acme', name: 'Acme' } });
    await pool.query(
      `INSERT INTO "user" ("id", "name", "email", "updatedAt", "role")
       VALUES ('member', 'Member', 'member@example.test', now(), 'user'),
              ('loner', 'Loner', 'loner@example.test', now(), 'user')`,
    );
    await pool.query(`INSERT INTO org_member (user_id, org_id) VALUES ('member', $1)`, [org.id]);

    for (const statement of adminStatements()) await pool.query(statement);

    const { rows } = await pool.query<{ id: string; role: string }>(
      `SELECT "id", "role" FROM "user" ORDER BY "id"`,
    );
    expect(rows).toEqual([
      { id: 'loner', role: 'user' },
      { id: 'member', role: 'admin' },
    ]);
  });
});
