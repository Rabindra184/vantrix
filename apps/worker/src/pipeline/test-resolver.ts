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
  run: {
    readonly id: string;
    readonly orgId: string;
    readonly projectId: string;
    /**
     * What the CALLER said this run was a test of — `metadata.test` at ingest,
     * or `test` on a live open, frozen onto the run row. Null is the ordinary
     * case and means "nobody said", which resolves by simulation class below.
     *
     * A DECLARED SLUG WINS OVER THE CLASS, and that is the whole point of the
     * field: it is what lets one simulation be run as two tests with different
     * injection profiles, the way Gatling Enterprise models it. The class is
     * still recorded on whichever test gets created, as captured metadata.
     */
    readonly declaredTestSlug?: string | null;
  },
  simulation: string | null,
): Promise<string | null> {
  const declared = run.declaredTestSlug?.trim();
  if (declared !== undefined && declared !== '') {
    return resolveDeclared(pool, run, declared, simulation);
  }

  // No class in the header AND no declared test is not a failure — it is a run
  // that cannot say what it was. A test named `null` would be worse than no
  // test.
  if (simulation === null || simulation.trim() === '') return null;

  const base = slugifySimulation(simulation);
  try {
    // ═══ THE OLDEST TEST WITH THIS CLASS, NOT "THE" TEST WITH THIS CLASS ═══
    //
    // `(project_id, simulation_class)` stopped being unique in
    // `20260823170000_test_per_configuration`, so this can now match several
    // rows and needs a deterministic answer. The OLDEST wins: it is the test
    // that existed before anybody split the class in two, so a CI job nobody
    // updated keeps landing exactly where it always did.
    //
    // The alternative — leave an ambiguous run ungrouped — is more literal and
    // worse in practice: it would break every un-updated pipeline the day
    // someone creates a second test for a simulation, and the breakage would
    // show up as trends quietly going flat rather than as an error.
    //
    // `id ASC` after `created_at ASC` because two tests created in the same
    // millisecond must still order the same way on every call.
    const existing = await pool.query<{ id: string }>(
      `SELECT id FROM test
        WHERE project_id = $1 AND simulation_class = $2
        ORDER BY created_at ASC, id ASC
        LIMIT 1`,
      [run.projectId, simulation],
    );
    if (existing.rows[0] !== undefined) return existing.rows[0].id;

    // The slug is chosen and the row inserted in ONE statement, so the window
    // between "this slug is free" and "this slug is mine" is as small as
    // Postgres can make it. `DO UPDATE` rather than DO NOTHING because only DO
    // UPDATE returns a row — which is how a caller that lost the race still
    // gets the id.
    //
    // ═══ THE CONFLICT TARGET IS THE SLUG NOW, AND THE GUARANTEE IS THE SAME ═══
    //
    // It was `(project_id, simulation_class)`, which needs a unique index on
    // exactly those columns — and that index is gone, so the clause could not
    // survive `20260823170000_test_per_configuration`. `(project_id, slug)` is
    // the table's only unique key now, and it protects the identical race:
    // two concurrent first-runs of one class derive the SAME base slug from it
    // above, collide here, and the loser is handed the winner's row.
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
         ON CONFLICT (project_id, slug) DO UPDATE SET updated_at = test.updated_at
         RETURNING id`,
      [run.orgId, run.projectId, base, simulation],
    );
    if (inserted.rows[0] !== undefined) return inserted.rows[0].id;

    // Nothing returned means either a lost race or fifty taken slugs. One more
    // read settles which, and costs nothing on the path that never gets here.
    const after = await pool.query<{ id: string }>(
      `SELECT id FROM test
        WHERE project_id = $1 AND simulation_class = $2
        ORDER BY created_at ASC, id ASC
        LIMIT 1`,
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
 * The test the CALLER named, resolved or created under exactly that slug.
 *
 * ═══ THE SLUG IS TAKEN AT ITS WORD ═══
 *
 * No collision loop, unlike the class path: a caller that said
 * `test: "checkout-soak"` means that test and not `checkout-soak-2`. If the
 * slug already exists it is used, whatever simulation class it was created
 * under — because the declaration is a human's statement about what this run
 * IS, and a run of a second simulation filed under a test somebody named is a
 * choice they are entitled to make. `simulation_class` on the existing row is
 * left alone: it records what the test was FIRST seen running, and rewriting
 * it on every run would make it a log of the most recent one instead.
 *
 * A DECLARED TEST CAN BE CREATED WITH NO SIMULATION AT ALL. `$4` falls back to
 * the slug when the header declared no class — a live run whose producer named
 * its test but died before writing a header, say. The test exists, correctly
 * named, and the next run of it fills nothing in: `simulation_class` stays the
 * slug, which is honest about what is known rather than pretending to a class
 * nobody reported.
 */
async function resolveDeclared(
  pool: pg.Pool,
  run: { readonly id: string; readonly orgId: string; readonly projectId: string },
  slug: string,
  simulation: string | null,
): Promise<string | null> {
  const declaredClass = simulation !== null && simulation.trim() !== '' ? simulation : slug;
  try {
    const existing = await pool.query<{ id: string }>(
      `SELECT id FROM test WHERE project_id = $1 AND slug = $2`,
      [run.projectId, slug],
    );
    if (existing.rows[0] !== undefined) return existing.rows[0].id;

    // Same race protection as the class path, on the same unique key: a
    // concurrent first run declaring the same slug collides here and is handed
    // the winner's row rather than failing.
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO test (id, org_id, project_id, slug, name, simulation_class, created_at, updated_at)
       VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3, $3, $4, now(), now())
       ON CONFLICT (project_id, slug) DO UPDATE SET updated_at = test.updated_at
       RETURNING id`,
      [run.orgId, run.projectId, slug, declaredClass],
    );
    return inserted.rows[0]?.id ?? null;
  } catch (err) {
    // Degrades exactly as the class path does, and for the same reason: a run
    // is worth more than its grouping.
    console.warn(
      `run ${run.id}: could not resolve the declared test "${slug}"; ` +
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
