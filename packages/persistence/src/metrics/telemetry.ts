import type pg from 'pg';
import type { ProjectScope } from '../repositories/tenant.js';

/**
 * How far BEFORE a run's start the reader reaches for samples.
 *
 * Every rate this system draws is a difference between two consecutive
 * samples, so the FIRST sample inside a run's window has nothing to difference
 * against and can produce no rate at all. Without a lookback, every host's
 * first bucket would be blank on six charts, forever, for a reason no reader
 * could deduce.
 *
 * Sixty seconds is generous against the agent's 1s default and costs nothing:
 * the query is partition-pruned either way. Samples that resolve to a negative
 * offset are dropped by `toTelemetrySeries` — the lookback exists to seed the
 * first delta, not to show pre-run history.
 */
export const TELEMETRY_LOOKBACK_MS = 60_000;

/** What an agent sends, after the token has supplied the tenant. */
export interface InboundTelemetrySample {
  sampledAtMs: number;
  cpuUserMs: number;
  cpuSystemMs: number;
  cpuIdleMs: number;
  cpuIowaitMs: number;
  memUsedBytes: number;
  memTotalBytes: number;
  netRxBytes: number;
  netTxBytes: number;
  tcpInSegs: number;
  tcpOutSegs: number;
  tcpRetransSegs: number;
  tcpInErrs: number;
  tcpActiveOpens: number;
  tcpPassiveOpens: number;
  tcpStates: Record<string, number>;
}

/** One stored row: an inbound sample plus the two things the server owns. */
export interface StoredTelemetrySample extends InboundTelemetrySample {
  host: string;
  /** The SERVER's clock. Compared against sampledAtMs to detect drift. */
  receivedAtMs: number;
}

/**
 * Shared verbatim with the "prunes partitions" integration test, for the same
 * load-bearing reason as SERIES_SQL: `sampled_on BETWEEN $1 AND $2` is the
 * partition-key predicate that lets Postgres prune telemetry_sample's range
 * partitions. A query filtering on sampled_at alone cannot prune and silently
 * scans every partition instead — and this table grows on wall-clock time, so
 * "every partition" gets worse every day whether or not anyone runs a test.
 *
 * TWO DATE BOUNDS, NOT ONE. Unlike the run tables, whose rows all share one
 * run_started_on, a window here can straddle midnight — and so can a skewed
 * agent clock, which is precisely the case §2 says must stay diagnosable.
 */
export const TELEMETRY_WINDOW_SQL = `SELECT host, sampled_at, received_at,
              cpu_user_ms, cpu_system_ms, cpu_idle_ms, cpu_iowait_ms,
              mem_used_bytes, mem_total_bytes,
              net_rx_bytes, net_tx_bytes,
              tcp_in_segs, tcp_out_segs, tcp_retrans_segs, tcp_in_errs,
              tcp_active_opens, tcp_passive_opens, tcp_states
         FROM telemetry_sample
        WHERE sampled_on BETWEEN $1 AND $2
          AND org_id = $3 AND project_id = $4
          AND sampled_at >= $5 AND sampled_at < $6
        ORDER BY host, sampled_at`;

/** `YYYY-MM-DD` in UTC — the partition key, derived from the AGENT's clock. */
const sampledOn = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/**
 * A stand-in for "no meaningful upper bound" — the same "everything from here
 * on" idiom `MAX_OFFSET_MS` guards in read.ts, one layer earlier and for two
 * stacked reasons rather than one.
 *
 * First, `Number.MAX_SAFE_INTEGER` (2^53 − 1, ~9.007e15 ms) is not a valid
 * `Date` value at all — the platform's own ceiling is 8.64e15 (ECMA-262
 * §21.4.1.1) — so an unclamped `forRun(scope, 0, Number.MAX_SAFE_INTEGER)`
 * throws `RangeError: Invalid time value` out of `sampledOn`'s
 * `toISOString()` before any query is even sent.
 *
 * Second, and less obviously: clamping to that JS ceiling merely trades one
 * failure for another. `new Date(8_640_000_000_000_000).toISOString()` is
 * `'+275760-09-13T00:00:00.000Z'` — a SIX-digit extended year — and
 * `sampledOn`'s `slice(0, 10)` assumes the ordinary four-digit
 * `'YYYY-MM-DD'` width. Sliced at ten characters, that string becomes
 * `'+275760-09'`, a truncated, malformed DATE literal that Postgres
 * rejects with `time zone displacement out of range` — a database-shaped
 * error for what is actually a string-formatting bug two layers up.
 *
 * Year 9999 sidesteps both: comfortably inside `Date`'s range, comfortably
 * past any run this system will ever ingest, and its ISO year is ordinary
 * four-digit width, so `sampledOn`'s fixed-width slice stays correct.
 */
const MAX_SAFE_DATE_MS = Date.UTC(9999, 11, 31, 23, 59, 59, 999);

export class TelemetryStore {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * Writes a batch.
   *
   * `scope` comes from the TOKEN and `host` from the payload — the one split
   * that matters. An agent may say which machine it is; it may not say which
   * tenant it belongs to.
   *
   * ON CONFLICT DO NOTHING because a retried batch after a timeout that
   * actually succeeded must be idempotent, and the primary key
   * (sampled_on, org, project, host, sampled_at) already identifies a sample
   * uniquely. Returns rows actually inserted, so a caller can see a duplicate
   * batch as a smaller number rather than as an error.
   */
  async insert(
    scope: ProjectScope,
    host: string,
    samples: readonly InboundTelemetrySample[],
  ): Promise<number> {
    if (samples.length === 0) return 0;

    // One row is 21 columns: the 6 identity/timestamp columns, 12 BIGINT
    // counters, 2 BIGINT gauges, and tcp_states. Every value for every row
    // goes into ONE flat array and the placeholder for row i, column k is
    // `$(i * COLUMNS + k + 1)` — Postgres parameters are 1-indexed, and this
    // is the only arithmetic that stays correct if a column is ever added.
    const COLUMNS = 21;
    const values: unknown[] = [];
    const tuples = samples.map((s, i) => {
      values.push(
        sampledOn(s.sampledAtMs), scope.orgId, scope.projectId, host,
        new Date(s.sampledAtMs), new Date(),
        s.cpuUserMs, s.cpuSystemMs, s.cpuIdleMs, s.cpuIowaitMs,
        s.memUsedBytes, s.memTotalBytes, s.netRxBytes, s.netTxBytes,
        s.tcpInSegs, s.tcpOutSegs, s.tcpRetransSegs, s.tcpInErrs,
        s.tcpActiveOpens, s.tcpPassiveOpens,
        JSON.stringify(s.tcpStates),
      );
      const placeholders = Array.from({ length: COLUMNS }, (_, k) => `$${i * COLUMNS + k + 1}`);
      return `(${placeholders.join(', ')})`;
    });

    const { rowCount } = await this.pool.query(
      `INSERT INTO telemetry_sample (
         sampled_on, org_id, project_id, host, sampled_at, received_at,
         cpu_user_ms, cpu_system_ms, cpu_idle_ms, cpu_iowait_ms,
         mem_used_bytes, mem_total_bytes, net_rx_bytes, net_tx_bytes,
         tcp_in_segs, tcp_out_segs, tcp_retrans_segs, tcp_in_errs,
         tcp_active_opens, tcp_passive_opens, tcp_states
       ) VALUES ${tuples.join(', ')}
       ON CONFLICT DO NOTHING`,
      values,
    );
    return rowCount ?? 0;
  }

  /**
   * Every sample for this tenant in `[fromMs, toMs)`, ordered by host then
   * time — the order `toTelemetrySeries` needs to difference consecutive
   * samples without re-sorting.
   *
   * The DATE bounds are derived here from the millisecond bounds rather than
   * taken from the caller, so no caller can pass a pair that disagrees and
   * silently prune away the partition holding half the answer.
   */
  async forRun(scope: ProjectScope, fromMs: number, toMs: number): Promise<StoredTelemetrySample[]> {
    // Clamped to what Date can hold, not what the caller passed — see
    // MAX_SAFE_DATE_MS. fromMs never approaches the floor in practice, but
    // it is clamped for the same reason toMs is: symmetry costs nothing and
    // an asymmetric guard is the kind of thing that looks intentional until
    // someone hits the other edge.
    const from = Math.max(fromMs, -MAX_SAFE_DATE_MS);
    const to = Math.min(toMs, MAX_SAFE_DATE_MS);
    const { rows } = await this.pool.query(TELEMETRY_WINDOW_SQL, [
      sampledOn(from), sampledOn(to),
      scope.orgId, scope.projectId,
      new Date(from), new Date(to),
    ]);
    return rows.map((r) => ({
      host: r.host,
      sampledAtMs: r.sampled_at.getTime(),
      receivedAtMs: r.received_at.getTime(),
      // BIGINT arrives from node-postgres as a STRING, not a number — the
      // driver refuses to silently lose precision above 2^53. Every one of
      // these needs Number(), and forgetting one yields string concatenation
      // in the delta arithmetic rather than a type error.
      cpuUserMs: Number(r.cpu_user_ms),
      cpuSystemMs: Number(r.cpu_system_ms),
      cpuIdleMs: Number(r.cpu_idle_ms),
      cpuIowaitMs: Number(r.cpu_iowait_ms),
      memUsedBytes: Number(r.mem_used_bytes),
      memTotalBytes: Number(r.mem_total_bytes),
      netRxBytes: Number(r.net_rx_bytes),
      netTxBytes: Number(r.net_tx_bytes),
      tcpInSegs: Number(r.tcp_in_segs),
      tcpOutSegs: Number(r.tcp_out_segs),
      tcpRetransSegs: Number(r.tcp_retrans_segs),
      tcpInErrs: Number(r.tcp_in_errs),
      tcpActiveOpens: Number(r.tcp_active_opens),
      tcpPassiveOpens: Number(r.tcp_passive_opens),
      tcpStates: r.tcp_states as Record<string, number>,
    }));
  }
}
