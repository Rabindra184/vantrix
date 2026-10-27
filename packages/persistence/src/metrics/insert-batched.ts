import type pg from 'pg';

/**
 * The one batched INSERT the metric writers share (MetricWriter,
 * AgentMetricWriter). Internal to this package: not re-exported from index.
 */

/** Rows per INSERT statement. Postgres caps a statement at 65535 parameters. */
const BATCH = 500;

export async function insertBatched(
  client: pg.PoolClient,
  table: string,
  columns: string[],
  rows: unknown[][],
): Promise<void> {
  if (rows.length === 0) return;
  const cols = columns.map((c) => `"${c}"`).join(', ');
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const params: unknown[] = [];
    const tuples = chunk.map((row) => {
      const placeholders = row.map((v) => {
        params.push(v);
        return `$${params.length}`;
      });
      return `(${placeholders.join(', ')})`;
    });
    await client.query(`INSERT INTO "${table}" (${cols}) VALUES ${tuples.join(', ')}`, params);
  }
}
