/**
 * `pnpm recompute`: recomputes, exactly, the runs that still carry estimated
 * statistics -- in this process, one at a time, printing each.
 *
 * It does NOT go through the `recompute` queue. It is what an operator runs
 * with the worker stopped (or with `RECOMPUTE_ENABLED=false`), to finish the
 * backlog now rather than behind ingest. Running it beside a worker is safe --
 * every recompute takes the run's ingest lock, and a run somebody else holds
 * is reported `locked` and left for the worker -- just not faster.
 *
 * Usage: see `RECOMPUTE_USAGE`, printed on any bad argument.
 */
import 'reflect-metadata';
import { createPool, createPrisma, RecomputeRepository } from '@perfportal/persistence';
import { BlobStore } from '@perfportal/storage';
import { loadWorkerConfig } from '../config.js';
import { parseRecomputeArgs, RECOMPUTE_USAGE, type RecomputeArgs } from '../recompute/recompute-args.js';
import { RecomputeService, type RecomputeOutcome } from '../recompute/recompute.service.js';

const BATCH = 50;

async function main(): Promise<void> {
  let args: RecomputeArgs;
  try {
    args = parseRecomputeArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`${err instanceof Error ? err.message : String(err)}\n\n${RECOMPUTE_USAGE}`);
    process.exitCode = 1;
    return;
  }

  const config = loadWorkerConfig();
  // A recompute holds two pool clients at once (the run lock and the write
  // transaction) plus one brief query between them; Prisma, one at a time.
  const pool = createPool(config.databaseUrl, { max: 4, connectionTimeoutMillis: 10_000 });
  const prisma = createPrisma(config.databaseUrl, { connectionLimit: 2 });
  try {
    if (args.projectSlug !== undefined) {
      // Slugs are unique per ORG, so a slug alone can name a project in
      // every org on the install -- say how many before touching any.
      const { rows } = await pool.query<{ projects: string; orgs: string }>(
        `SELECT count(*) AS projects, count(DISTINCT org_id) AS orgs FROM project WHERE slug = $1`,
        [args.projectSlug],
      );
      const projects = Number(rows[0]!.projects);
      const orgs = Number(rows[0]!.orgs);
      if (projects === 0) {
        console.error(`No project has the slug "${args.projectSlug}" in any org.`);
        process.exitCode = 1;
        return;
      }
      console.log(
        `--project ${args.projectSlug} matches ${projects} project${projects === 1 ? '' : 's'} ` +
          `across ${orgs} org${orgs === 1 ? '' : 's'}.`,
      );
    }

    const repo = new RecomputeRepository(pool);
    const service = new RecomputeService(config, prisma, pool, new BlobStore(config.blob));
    const counts = new Map<RecomputeOutcome, number>();
    // Every run this process has already handled. A recomputed or failed run
    // leaves the candidate set by itself; a LOCKED one does not, so without
    // this the loop would ask for it again for ever. The limit grows with it
    // so a page full of locked runs cannot hide the ones behind them.
    const seen = new Set<string>();
    for (;;) {
      const batch = (await repo.candidates(
        { projectSlug: args.projectSlug, runId: args.runId },
        BATCH + seen.size,
      )).filter((id) => !seen.has(id));
      if (batch.length === 0) break;
      for (const runId of batch) {
        seen.add(runId);
        const outcome = await service.recompute(runId);
        counts.set(outcome, (counts.get(outcome) ?? 0) + 1);
        console.log(`Recomputed ${runId} (${outcome})`);
      }
    }

    const n = (o: RecomputeOutcome) => counts.get(o) ?? 0;
    const failed = n('raw_log_missing') + n('checksum_mismatch') + n('parse_failed');
    console.log(
      `Recomputed ${n('recomputed')} runs; ${failed} could not be ` +
        `(raw_log_missing: ${n('raw_log_missing')}, checksum_mismatch: ${n('checksum_mismatch')}, ` +
        `parse_failed: ${n('parse_failed')}); ${n('locked')} were locked and are left for the worker.`,
    );
  } finally {
    await pool.end();
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error('Recompute failed:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
