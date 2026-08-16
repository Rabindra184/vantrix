import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createPool, createPrisma, TELEMETRY_WINDOW_SQL, TelemetryStore,
  type InboundTelemetrySample, type ProjectScope,
} from '../src/index.js';
import { requireDatabaseUrl, resetDatabase } from './support/db.js';

const url = requireDatabaseUrl();
const pool = createPool(url);
const prisma = createPrisma(url);

// A sample builder, so every test states only what it is about. Counters climb
// with `n` so a delta is always positive unless a test deliberately resets one.
//
// Every numeric field carries its OWN prime multiplier (or offset, for the
// two gauges), all pairwise distinct — not a coincidence that happens to
// hold for the two `n` values the tests below use, but true for any `n`.
// A transposed column in forRun()'s row mapping (say, cpuIdleMs and
// cpuIowaitMs swapped) therefore always changes a value, so the whole-object
// round-trip comparison in "round-trips every counter and the state map"
// below is guaranteed to catch it rather than depending on which fields that
// test happens to spot-check.
const sampleAt = (n: number, over: Partial<InboundTelemetrySample> = {}): InboundTelemetrySample => ({
  sampledAtMs: Date.UTC(2026, 7, 17, 10, 0, n),
  cpuUserMs: 101 * n, cpuSystemMs: 103 * n, cpuIdleMs: 107 * n, cpuIowaitMs: 109 * n,
  memUsedBytes: 1_000_000 + 113 * n, memTotalBytes: 8_000_000 + 127 * n,
  netRxBytes: 131 * n, netTxBytes: 137 * n,
  tcpInSegs: 139 * n, tcpOutSegs: 149 * n, tcpRetransSegs: 151 * n, tcpInErrs: 157 * n,
  tcpActiveOpens: 163 * n, tcpPassiveOpens: 167 * n,
  tcpStates: { ESTABLISHED: 10 + n, TIME_WAIT: n },
  ...over,
});

// Two tenants: `scope` is the one under test, `otherScope` proves isolation.
// Both get their own org and project, the same pattern
// repositories.integration.test.ts uses for cross-tenant checks.
let scope: ProjectScope;
let otherScope: ProjectScope;

beforeEach(async () => {
  await resetDatabase(pool);
  const org = await prisma.org.create({ data: { slug: 'acme', name: 'Acme' } });
  const project = await prisma.project.create({
    data: { orgId: org.id, slug: 'checkout', name: 'Checkout', settings: {} },
  });
  const otherOrg = await prisma.org.create({ data: { slug: 'other', name: 'Other Org' } });
  const otherProject = await prisma.project.create({
    data: { orgId: otherOrg.id, slug: 'other-checkout', name: 'Other Checkout', settings: {} },
  });
  scope = { orgId: org.id, projectId: project.id };
  otherScope = { orgId: otherOrg.id, projectId: otherProject.id };
});

afterAll(async () => {
  await pool.end();
  await prisma.$disconnect();
});

describe('TelemetryStore', () => {
  it('round-trips every counter and the state map', async () => {
    const store = new TelemetryStore(pool);
    const written = [sampleAt(1), sampleAt(2)];
    const inserted = await store.insert(scope, 'gen-1', written);
    expect(inserted).toBe(written.length);

    const read = await store.forRun(scope, written[0]!.sampledAtMs, written[1]!.sampledAtMs + 1);

    // EVERY field, DERIVED FROM WHAT WAS WRITTEN, never a literal — the
    // builder above is free to change. StoredTelemetrySample is exactly
    // InboundTelemetrySample plus the two server-owned fields (host,
    // receivedAtMs); stripping those and comparing what remains against
    // `written` whole checks all fourteen counters/gauges and tcpStates in
    // one assertion, rather than the handful a spot check would name — a
    // transposed column in forRun()'s mapping fails this even if the field
    // it landed in was never separately asserted.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    expect(read.map(({ host: _host, receivedAtMs: _receivedAtMs, ...rest }) => rest)).toEqual(written);
    expect(read.every((r) => r.host === 'gen-1')).toBe(true);
  });

  it('stamps received_at from the SERVER clock, not the payload', async () => {
    const store = new TelemetryStore(pool);
    // An agent thirty seconds fast. Spec §2: this is not solvable without a
    // handshake, but it IS detectable without one — which is the whole reason
    // both clocks are stored.
    const skewed = sampleAt(1, { sampledAtMs: Date.now() + 30_000 });
    await store.insert(scope, 'skewed', [skewed]);

    const [row] = await store.forRun(scope, skewed.sampledAtMs - 1000, skewed.sampledAtMs + 1000);
    expect(row!.sampledAtMs).toBe(skewed.sampledAtMs);
    // The server clock is BEHIND the agent's here, by construction.
    expect(row!.receivedAtMs).toBeLessThan(row!.sampledAtMs);
  });

  it('is scoped to the tenant', async () => {
    const store = new TelemetryStore(pool);
    await store.insert(otherScope, 'gen-1', [sampleAt(1)]);
    const mine = await store.forRun(scope, 0, Number.MAX_SAFE_INTEGER);
    expect(mine).toEqual([]);
  });

  it('prunes partitions', async () => {
    // SHARED VERBATIM with the reader, exactly as the series/user/error
    // pruning tests are: `sampled_on BETWEEN $1 AND $2` is the partition-key
    // predicate, and a query filtering on sampled_at alone cannot prune and
    // silently scans every partition instead.
    const { rows } = await pool.query(
      `EXPLAIN (FORMAT JSON) ${TELEMETRY_WINDOW_SQL}`,
      ['2026-08-17', '2026-08-17', scope.orgId, scope.projectId,
       new Date(Date.UTC(2026, 7, 17, 10, 0, 0)), new Date(Date.UTC(2026, 7, 17, 11, 0, 0))],
    );
    const plan = JSON.stringify(rows[0]);
    expect(plan).toContain('telemetry_sample_2026_08');
    expect(plan).not.toContain('telemetry_sample_2026_01');
  });
});
