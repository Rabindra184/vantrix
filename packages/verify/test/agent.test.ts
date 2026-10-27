import { decodeAgentFile, type AgentFile } from '@perfportal/plugin-gatling';
import { describe, expect, it } from 'vitest';
import { expectedAgent, type ExpectedAgent } from '../src/agent.js';
import { compare } from '../src/compare.js';
import { runSeriesWidth } from '../src/series.js';
import type { Expected, Stored } from '../src/figures.js';

/**
 * Each case writes agent-file LINES and decodes them with the shared decoder,
 * so what is checked is what a real file would produce — the decoder's own
 * reading of an absent `states`, of a `null` netty, of a missing `tcp` field.
 */

const R = 5_000_000;
const OPTS = { runStartMs: R, durationMs: 10_000, bucketWidthMs: 1000 };
const A = 'a.test/10.0.0.1:443';
const B = 'b.test/10.0.0.2:443';
const W = '127.0.0.1/127.0.0.1:9999';

const HEADER = {
  t: 'header', format: 'perfportal-agent/1', agentVersion: '0.1.0', gatlingHttpClient: '3.15.1',
  gatlingHttp: '3.15.1', java: '21', os: 'Linux', host: 'loadgen-1', startedAt: R - 1000,
  collects: { http: true, machine: true }, reasons: {},
};

function agentFile(lines: object[]): AgentFile {
  const text = [HEADER, ...lines].map((l) => JSON.stringify(l)).join('\n');
  return decodeAgentFile(new TextEncoder().encode(text));
}

/** A sample line at `offset` ms; heap, gc and bytes default empty, every optional field absent. */
const sample = (offset: number, extra: Record<string, unknown> = {}) => ({
  t: 's', at: R + offset, gc: {}, heap: [0, 0, 0], netty: null, bytes: {}, ...extra,
});
const connect = (offset: number, remote: string, ch: number, extra: Record<string, unknown> = {}) => ({
  t: 'connect', at: R + offset, us: 2000, remote, ok: true, ch, ...extra,
});

/** `bucket → value` of one (metric, dim, label). */
function values(e: ExpectedAgent, metric: string, dim: string, label: string): Record<number, number> {
  const out: Record<number, number> = {};
  for (const m of e.metrics) if (m.metric === metric && m.dim === dim && m.label === label) out[m.startOffsetMs] = m.value;
  return out;
}

const dims = (e: ExpectedAgent, metric: string): string[] =>
  [...new Set(e.metrics.filter((m) => m.metric === metric).map((m) => m.dim))].sort();

describe('expectedAgent', () => {
  it('drops warm-up channels, warm-up-only remotes and warm-up lookups from every figure', () => {
    const e = expectedAgent(
      agentFile([
        connect(100, W, 1, { warmup: true }),
        // A tls on no channel, and a close on a channel nobody connected, to the warm-up-only remote.
        { t: 'tls', at: R + 150, us: 9000, remote: W, ok: true, ch: null },
        { t: 'close', at: R + 200, ch: 77, remote: W },
        // A remote reached once warm, once for real: only the real channel counts.
        connect(300, A, 2, { warmup: true }),
        connect(400, A, 3),
        { t: 'tls', at: R + 310, us: 4000, remote: A, ok: true, ch: 2 },
        { t: 'tls', at: R + 410, us: 5000, remote: A, ok: true, ch: 3 },
        { t: 'close', at: R + 350, ch: 2, remote: A },
        { t: 'close', at: R + 900, ch: 3, remote: A },
        { t: 'dns', at: R + 50, us: 800, host: 'warm.test', ok: true, warmup: true },
        { t: 'dns', at: R + 60, us: 800, host: 'real.test', ok: true },
        sample(500, { bytes: { [W]: [10, 10], [A]: [5, 7] }, states: { [W]: { '1': 3 }, [A]: { '1': 1 } } }),
      ]),
      OPTS,
    );

    expect(values(e, 'conn.opened', A, '')).toEqual({ 0: 1 });
    expect(values(e, 'conn.closed', A, '')).toEqual({ 0: 1 });
    expect(values(e, 'conn.closed', '*', '')).toEqual({ 0: 1 });
    expect(dims(e, 'conn.closed')).toEqual(['*', A]);
    expect(dims(e, 'bw.bits')).toEqual(['*', A]);
    expect(values(e, 'bw.bits', '*', 'in')).toEqual({ 0: 56 });
    expect(values(e, 'tcp.state', '*', 'established')).toEqual({ 0: 1 });
    expect(dims(e, 'dns.count')).toEqual(['*', 'real.test']);
    const tls = e.durations.filter((d) => d.family === 'tls_handshake');
    expect(tls.map((d) => [d.dim, d.okCount, d.ok?.max])).toEqual([[A, 1, 5], ['*', 1, 5]]);
    expect(e.durations.some((d) => d.dim === W)).toBe(false);
  });

  it('places records by offset: before the run not counted, past the end in the last bucket', () => {
    const e = expectedAgent(
      agentFile([
        { t: 'status', at: R - 1, req: 'x', code: 200 },
        { t: 'status', at: R + 2_999, req: 'x', code: 200 },
        { t: 'status', at: R + 10_000, req: 'x', code: 200 },
        { t: 'status', at: R + 10_001, req: 'x', code: 404 },
        // The predecessor sample before the run files nothing but sets the delta base.
        sample(-500, { gc: { G1: [4, 40] } }),
        sample(12_000, { gc: { G1: [6, 45] } }),
      ]),
      OPTS,
    );

    expect(values(e, 'status', '*', '200')).toEqual({ 2000: 1, 10000: 1 });
    expect(values(e, 'status', '*', '404')).toEqual({ 10000: 1 });
    expect(values(e, 'gc.count', '*', 'G1')).toEqual({ 10000: 2 });
    expect(values(e, 'gc.timeMs', '*', 'G1')).toEqual({ 10000: 5 });
  });

  it('takes counter deltas: a keyed counter from 0, an unkeyed one only after a reading, never negative', () => {
    const e = expectedAgent(
      agentFile([
        sample(0, {
          gc: { G1: [3, 30] },
          cpu: [10, 1, 20, 100, 5, 2, 3, 0],
          tcp: { ActiveOpens: 5, InSegs: 50, CurrEstab: 2 },
          bytes: {},
        }),
        sample(1000, {
          gc: { G1: [2, 31] }, // went DOWN: a delta of 0, not -1
          cpu: [14, 2, 22, 110, 5, 3, 3, 1],
          tcp: { ActiveOpens: 9, InSegs: 40, CurrEstab: 3 },
        }),
        connect(1100, A, 1),
        sample(2000, { bytes: { [A]: [100, 300] } }),
        sample(3000, { bytes: { [A]: [150, 250] } }),
      ]),
      OPTS,
    );

    expect(values(e, 'gc.count', '*', 'G1')).toEqual({ 0: 3, 1000: 0 });
    expect(values(e, 'gc.timeMs', '*', 'G1')).toEqual({ 0: 30, 1000: 1 });
    // cpu and the snmp fields count since boot: their first reading files nothing.
    expect(values(e, 'cpu.jiffies', '*', 'user')).toEqual({ 1000: 5 });
    expect(values(e, 'cpu.jiffies', '*', 'sys')).toEqual({ 1000: 3 });
    expect(values(e, 'cpu.jiffies', '*', 'total')).toEqual({ 1000: 19 });
    expect(values(e, 'tcp.evt', '*', 'activeOpenings')).toEqual({ 1000: 4 });
    expect(values(e, 'tcp.seg', '*', 'received')).toEqual({ 1000: 0 });
    expect(values(e, 'tcp.established', '*', '')).toEqual({ 0: 2, 1000: 3 });
    // bytes: first seen from 0, then a delta, an in-counter that went down reads 0; bits.
    expect(values(e, 'bw.bits', A, 'out')).toEqual({ 2000: 800, 3000: 400 });
    expect(values(e, 'bw.bits', A, 'in')).toEqual({ 2000: 2400, 3000: 0 });
    // Every counted sample files the bandwidth total, zeros included.
    expect(values(e, 'bw.bits', '*', 'out')).toEqual({ 0: 0, 1000: 0, 2000: 800, 3000: 400 });
  });

  it('sums counters and maxes gauges within a coalesced bucket, the * gauge summed per sample first', () => {
    const e = expectedAgent(
      agentFile([
        connect(10, A, 1),
        connect(20, B, 2),
        sample(100, { heap: [5, 50, 500], mem: [100, 40], states: { [A]: { '1': 3 }, [B]: { '1': 1 } } }),
        sample(1100, { heap: [9, 40, 500], mem: [100, 70], states: { [A]: { '1': 1 }, [B]: { '1': 2 } } }),
        { t: 'status', at: R + 500, req: 'x', code: 200 },
        { t: 'status', at: R + 1500, req: 'x', code: 200 },
      ]),
      { ...OPTS, bucketWidthMs: 2000 },
    );

    expect(values(e, 'status', '*', '200')).toEqual({ 0: 2 });
    expect(values(e, 'conn.opened', '*', '')).toEqual({ 0: 2 });
    expect(values(e, 'heap', '*', 'used')).toEqual({ 0: 9 });
    expect(values(e, 'heap', '*', 'committed')).toEqual({ 0: 50 });
    expect(values(e, 'ram', '*', 'used')).toEqual({ 0: 60 * 1024 });
    expect(values(e, 'ram', '*', 'total')).toEqual({ 0: 100 * 1024 });
    expect(values(e, 'tcp.state', A, 'established')).toEqual({ 0: 3 });
    expect(values(e, 'tcp.state', B, 'established')).toEqual({ 0: 2 });
    // 3+1 = 4 then 1+2 = 3: the max of the sums, not 3 + 2.
    expect(values(e, 'tcp.state', '*', 'established')).toEqual({ 0: 4 });
  });

  it('maps kernel state codes to GE labels, and keeps no reading apart from a measured zero', () => {
    const e = expectedAgent(
      agentFile([
        connect(10, A, 1),
        sample(100, { states: { [A]: { '1': 1, '2': 2, '3': 9, '4': 3, '5': 4, '6': 5, '7': 6, '8': 7, '9': 8, '10': 9, '11': 10, '12': 9 } } }),
        sample(1100), // no `states` key: no reading
        sample(2100, { states: {} }), // a measured zero
      ]),
      OPTS,
    );

    const labels = [...new Set(e.metrics.filter((m) => m.metric === 'tcp.state').map((m) => m.label))].sort();
    expect(labels).toEqual(['close', 'closeWait', 'closing', 'established', 'finWait1', 'finWait2', 'lastAck', 'synSent', 'timeWait']);
    expect(values(e, 'tcp.state', A, 'synSent')).toEqual({ 0: 2 });
    expect(values(e, 'tcp.state', A, 'established')).toEqual({ 0: 1 });
    expect(values(e, 'tcp.state', A, 'finWait1')).toEqual({ 0: 3 });
    expect(values(e, 'tcp.state', A, 'finWait2')).toEqual({ 0: 4 });
    expect(values(e, 'tcp.state', A, 'timeWait')).toEqual({ 0: 5 });
    expect(values(e, 'tcp.state', A, 'close')).toEqual({ 0: 6 });
    expect(values(e, 'tcp.state', A, 'closeWait')).toEqual({ 0: 7 });
    expect(values(e, 'tcp.state', A, 'lastAck')).toEqual({ 0: 8 });
    expect(values(e, 'tcp.state', A, 'closing')).toEqual({ 0: 10 });
    // Bucket 1000 had no reading: no row at all. Bucket 2000's {} is a zero for every * state.
    expect(values(e, 'tcp.state', '*', 'established')).toEqual({ 0: 1, 2000: 0 });
    expect(values(e, 'tcp.state', '*', 'closing')).toEqual({ 0: 10, 2000: 0 });
  });

  it('rounds microseconds to whole ms at the half (1499 to 1, 1500 to 2) and floors at 0', () => {
    const e = expectedAgent(
      agentFile([
        { t: 'dns', at: R + 1, us: 1499, host: 'h.test', ok: true },
        { t: 'dns', at: R + 2, us: 1500, host: 'h.test', ok: true },
        { t: 'dns', at: R + 3, us: -800, host: 'h.test', ok: false },
      ]),
      OPTS,
    );
    const h = e.durations.find((d) => d.family === 'dns_resolution' && d.dim === 'h.test')!;
    expect(h.okCount).toBe(2);
    expect(h.ok).toMatchObject({ count: 2, min: 1, max: 2, sum: 3 });
    expect(h.ko).toMatchObject({ count: 1, min: 0, max: 0, sum: 0 });
    expect(values(e, 'dns.count', 'h.test', 'req')).toEqual({ 0: 3 });
    expect(values(e, 'dns.count', 'h.test', 'ok')).toEqual({ 0: 2 });
    expect(values(e, 'dns.count', 'h.test', 'ko')).toEqual({ 0: 1 });
  });

  it('answers the 10 GE percentiles by nearest rank, and null for an empty population', () => {
    const lines = [100, 200, 300, 400].map((ms, i) => connect(10 + i, A, i + 1, { us: ms * 1000 }));
    const e = expectedAgent(agentFile(lines), OPTS);
    const d = e.durations.find((x) => x.family === 'tcp_connect' && x.dim === A)!;
    // ranks 25 50 75 80 85 90 95 99 99.9 99.99 over 4 values
    expect(d.ok?.percentiles).toEqual([100, 200, 300, 400, 400, 400, 400, 400, 400, 400]);
    expect(d.ko).toBeNull();
  });
});

describe('compare, on the agent tables', () => {
  const base: Omit<Expected, 'agent'> = {
    stats: [], series: [], errors: [], errorBuckets: [], users: [], run: { durationMs: 1, activityMs: 1 },
  };
  const agent = expectedAgent(
    agentFile([connect(10, A, 1), { t: 'status', at: R + 20, req: 'x', code: 200 }]),
    OPTS,
  );

  it('agrees with itself, and checks nothing when no agent figures are given', () => {
    const clean = compare({ ...base, agent }, { ...base, agent } as Stored);
    expect(clean.mismatches).toEqual([]);
    const without = compare(base, base as Stored);
    expect(clean.figuresChecked).toBeGreaterThan(without.figuresChecked);
  });

  it('names the metric row and its bucket when a stored value differs', () => {
    const stored = structuredClone(agent);
    stored.metrics.find((m) => m.metric === 'status')!.value = 7;
    expect(compare({ ...base, agent }, { ...base, agent: stored }).mismatches).toEqual([
      { scope: 'status', name: '*', family: '200', population: null, bucket: 0, table: 'run_agent_metric_bucket', figure: 'value', stored: 7, recomputed: 1 },
    ]);
  });

  it('names the duration bucket and population when a stored histogram differs', () => {
    const stored = structuredClone(agent);
    const row = stored.durations.find((d) => d.dim === A)!;
    row.ok!.percentiles[1] = 99;
    expect(compare({ ...base, agent }, { ...base, agent: stored }).mismatches).toEqual([
      { scope: 'tcp_connect', name: A, family: '', population: 'ok', bucket: 0, table: 'run_agent_duration_bucket', figure: 'p50', stored: 99, recomputed: 2 },
    ]);
  });

  it('reports a rank the stored histogram refused (null) against the recomputed value, never skips it', () => {
    const stored = structuredClone(agent);
    stored.durations.find((d) => d.dim === A)!.ok!.percentiles[1] = null;
    expect(compare({ ...base, agent }, { ...base, agent: stored }).mismatches).toEqual([
      { scope: 'tcp_connect', name: A, family: '', population: 'ok', bucket: 0, table: 'run_agent_duration_bucket', figure: 'p50', stored: null, recomputed: 2 },
    ]);
  });

  it('names the stored bucket width when it is not the width the verifier derived', () => {
    const stored = { ...structuredClone(agent), bucketWidthMs: 2000 };
    expect(compare({ ...base, agent }, { ...base, agent: stored }).mismatches).toEqual([
      { scope: 'run', name: '', family: '', population: null, bucket: null, table: 'run_agent', figure: 'bucket_width_ms', stored: 2000, recomputed: 1000 },
    ]);
    // A null stored width is compared, never skipped.
    const unset = { ...structuredClone(agent), bucketWidthMs: null };
    expect(compare({ ...base, agent }, { ...base, agent: unset }).mismatches.map((m) => [m.figure, m.stored])).toEqual([['bucket_width_ms', null]]);
  });

  it('derives no run series width for a run with no request', () => {
    expect(runSeriesWidth([], { runStartMs: R, maxBucketsRun: 1200 })).toBeNull();
  });

  it('reports a row the store lacks, and one it has extra, as one row mismatch each', () => {
    const stored = structuredClone(agent);
    stored.metrics = stored.metrics.filter((m) => m.metric !== 'status');
    stored.metrics.push({ metric: 'status', dim: '*', label: '500', startOffsetMs: 0, value: 1 });
    expect(compare({ ...base, agent }, { ...base, agent: stored }).mismatches.map((m) => [m.family, m.figure, m.stored, m.recomputed])).toEqual([
      ['200', 'row', null, 1],
      ['500', 'row', 1, null],
    ]);
  });
});
