import type pg from 'pg';

/**
 * Which `test` row a run of `simulation` belongs to — resolving or creating
 * one, on a connection of its own.
 *
 * ═══ WHY THIS IS A MODULE AND NOT A PRIVATE METHOD ═══
 *
 * It was `PipelineService.#resolveTestId`, called once, at finalize. There are
 * TWO callers now: the pipeline still resolves from the parsed log header, and
 * `LiveFoldOwner` resolves the moment the streaming decoder reads that same
 * header — which is what lets a test-scoped SLA rule judge a run WHILE it is
 * streaming rather than only once it is finished.
 *
 * Both must agree. Two copies of a resolve-or-create keyed on
 * `(project_id, simulation_class)` would diverge as a SECOND test appearing
 * for a class that already had one, with the history split across both and
 * trends quietly showing half of it — the same failure mode the migration and
 * the worker's rule already have a test pinning them against, and the same
 * reason `record-decoder.ts` is deliberately the only record decoder.
 *
 * ═══ AND WHY IT TAKES A `pg.Pool` RATHER THAN A PRISMA CLIENT ═══
 *
 * This must never run inside a caller's transaction. The pipeline's finalize
 * transaction writes statistics, assertions and the terminal status together;
 * a duplicate-slug violation raised inside it would abort all of that to
 * decide a grouping. Its own connection, its own failure mode: a run whose
 * test could not be resolved is a run with `test_id IS NULL`, which the schema
 * already allows for pending and unparsed runs. The next run of the same class
 * creates the test and adopts it.
 *
 * An orphan test with no runs is possible if this succeeds and the caller then
 * fails. Benign — the next run of that class finds and reuses it.
 */
export async function resolveTestId(
  pool: pg.Pool,
  run: { readonly id: string; readonly orgId: string; readonly projectId: string },
  simulation: string | null,
): Promise<string | null> {
  // No class in the header is not a failure — it is a run that cannot say what
  // it was. A test named `null` would be worse than no test.
  if (simulation === null || simulation.trim() === '') return null;

  const base = slugifySimulation(simulation);
  try {
    const existing = await pool.query<{ id: string }>(
      `SELECT id FROM test WHERE project_id = $1 AND simulation_class = $2`,
      [run.projectId, simulation],
    );
    if (existing.rows[0] !== undefined) return existing.rows[0].id;

    // The slug is chosen and the row inserted in ONE statement, so the window
    // between "this slug is free" and "this slug is mine" is as small as
    // Postgres can make it. `ON CONFLICT (project_id, simulation_class) DO
    // UPDATE` rather than DO NOTHING because only DO UPDATE returns a row —
    // which is how a caller that lost the race still gets the id.
    const inserted = await pool.query<{ id: string }>(
      `WITH candidate AS (
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
         RETURNING id`,
      [run.orgId, run.projectId, base, simulation],
    );
    if (inserted.rows[0] !== undefined) return inserted.rows[0].id;

    // Nothing returned means either a lost race or fifty taken slugs. One more
    // read settles which, and costs nothing on the path that never gets here.
    const after = await pool.query<{ id: string }>(
      `SELECT id FROM test WHERE project_id = $1 AND simulation_class = $2`,
      [run.projectId, simulation],
    );
    return after.rows[0]?.id ?? null;
  } catch (err) {
    // A run is worth more than its grouping. Failing the caller here would
    // turn a naming problem into a lost result — a failed parse for the
    // pipeline, or a dropped fold for the live owner.
    console.warn(
      `run ${run.id}: could not resolve a test for simulation ${simulation}; ` +
        `leaving it ungrouped: ${String(err)}`,
    );
    return null;
  }
}

/**
 * A simulation class as a URL slug — the TypeScript half of a rule the
 * migration also spells in SQL (`regexp_replace(lower(x), '[^a-z0-9]+', '-')`
 * then trim). Two spellings of one rule is a real risk, and the mitigation is
 * that `test-entity.integration.test.ts` asserts they agree on the same inputs
 * rather than each agreeing with itself.
 *
 * A class that is entirely punctuation slugifies to nothing; `test` is the
 * fallback, and the collision suffix then applies to it like any other base.
 */
export function slugifySimulation(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '');
  return slug === '' ? 'test' : slug;
}
