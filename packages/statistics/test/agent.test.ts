import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CanonicalEvent } from '@perfportal/core';
import {
  decodeAgentFile,
  parseSimulationLog,
  type AgentFile,
  type AgentSample,
} from '@perfportal/plugin-gatling';
import { describe, expect, it } from 'vitest';
import {
  AGENT_GAUGE_METRICS,
  AGENT_METRICS,
  buildAgentFigures,
  runSeriesWidthMs,
  type AgentFigures,
} from '../src/agent.js';
import { runEngine } from '../src/engine.js';
import { runEngineAsync } from '../src/engine-async.js';

const R = 1_000_000;
const OPTS = { runStartMs: R, durationMs: 10_000, bucketWidthMs: 1000 };
const A = 'a.test/10.0.0.1:443';
const B = 'b.test/10.0.0.2:443';

function file(parts: Partial<AgentFile>): AgentFile {
  return {
    header: {
      format: 'perfportal-agent/1',
      agentVersion: '0.1.0',
      gatlingHttpClient: '3.15.1',
      gatlingHttp: '3.15.1',
      java: '21',
      os: 'Linux',
      host: 'loadgen-1',
      startedAt: R - 5000,
      collects: { http: true, machine: true },
      reasons: {},
    },
    dns: [],
    connects: [],
    tls: [],
    closes: [],
    statuses: [],
    samples: [],
    error: null,
    capped: false,
    malformedLines: 0,
    ...parts,
  };
}

/** A sample at `offset` ms from the run start, every machine figure absent unless given. */
function s(offset: number, parts: Partial<AgentSample> = {}): AgentSample {
  return {
    at: R + offset,
    final: false,
    gc: {},
    heap: [0, 0, 0],
    netty: null,
    cpu: null,
    mem: null,
    tcp: null,
    bytes: {},
    states: null,
    ...parts,
  };
}

const connect = (offset: number, remote: string, ch: number, us = 1000, ok = true, warmup = false) => ({
  at: R + offset,
  us,
  remote,
  ok,
  ch,
  warmup,
});

/** `startOffsetMs → value` for one metric row series. */
function series(f: AgentFigures, metric: string, dim: string, label: string): Record<number, number> {
  const out: Record<number, number> = {};
  for (const m of f.metrics) {
    if (m.metric === metric && m.dim === dim && m.label === label) out[m.startOffsetMs] = m.value;
  }
  return out;
}

const M = AGENT_METRICS;

describe('buildAgentFigures', () => {
  it("files a connect's duration under its remote and under *", () => {
    const f = buildAgentFigures(
      file({ connects: [connect(2300, A, 1, 1499), connect(2400, A, 2, 1500)] }),
      OPTS,
    );
    const tcp = f.durations.filter((d) => d.family === 'tcp_connect');
    expect(tcp.map((d) => [d.dim, d.startOffsetMs]).sort()).toEqual([
      ['*', 2000],
      [A, 2000],
    ]);
    for (const d of tcp) {
      expect(d.okCount).toBe(2);
      expect(d.koCount).toBe(0);
      expect(d.histogramOk.total).toBe(2);
      // 1499 µs is 1 ms and 1500 µs is 2 ms: the rule Histogram.accept applies to us / 1000.
      expect(d.histogramOk.min).toBe(1);
      expect(d.histogramOk.max).toBe(2);
      expect(d.histogramKo.total).toBe(0);
    }
  });

  it('files a failed connect in the KO histogram and opens no connection', () => {
    const f = buildAgentFigures(file({ connects: [connect(100, A, 1, 3000, false)] }), OPTS);
    const d = f.durations.find((x) => x.family === 'tcp_connect' && x.dim === A)!;
    expect([d.okCount, d.koCount, d.histogramKo.total, d.histogramKo.max]).toEqual([0, 1, 1, 3]);
    expect(series(f, M.connOpened, A, '')).toEqual({});
  });

  it('drops warm-up channels everywhere', () => {
    const W = 'gatling.io/1.2.3.4:443';
    const f = buildAgentFigures(
      file({
        connects: [connect(100, W, 1, 5000, true, true), connect(200, A, 2)],
        tls: [
          { at: R + 150, us: 9000, remote: W, ok: true, ch: 1, warmup: false },
          { at: R + 160, us: 9000, remote: W, ok: true, ch: null, warmup: true },
        ],
        closes: [{ at: R + 300, ch: 1, remote: W }],
        dns: [{ at: R + 50, us: 800, host: 'gatling.io', ok: true, warmup: true }],
        samples: [
          s(400, { bytes: { [W]: [100, 200], [A]: [10, 20] }, states: { [W]: { '6': 1 }, [A]: { '1': 1 } } }),
        ],
      }),
      OPTS,
    );
    const mentions = [...f.durations.map((d) => d.dim), ...f.metrics.map((m) => m.dim)];
    expect(mentions).not.toContain(W);
    expect(f.durations.some((d) => d.family === 'tls_handshake' || d.family === 'dns_resolution')).toBe(false);
    expect(f.hostnames).toEqual([]);
    expect(f.remotes).toEqual([A]);
    expect(series(f, M.connClosed, '*', '')).toEqual({});
    // The * totals carry only the real remote.
    expect(series(f, M.bwBits, '*', 'out')).toEqual({ 0: 80 });
    expect(series(f, M.tcpState, '*', 'timeWait')).toEqual({ 0: 0 });
    expect(series(f, M.tcpState, '*', 'established')).toEqual({ 0: 1 });
  });

  it('drops records before the run and places those after its duration in the last bucket', () => {
    const d = OPTS.durationMs;
    const f = buildAgentFigures(
      file({
        connects: [connect(-1, A, 1), connect(d + 1, A, 2), connect(0, A, 3), connect(d, A, 4)],
        dns: [
          { at: R - 1, us: 100, host: 'h', ok: true, warmup: false },
          { at: R + d + 1, us: 100, host: 'h', ok: true, warmup: false },
        ],
        statuses: [
          { at: R - 1, req: 'x', code: 200 },
          { at: R + d + 1, req: 'x', code: 200 },
        ],
        closes: [{ at: R + d + 1, ch: 4, remote: A }],
        samples: [s(d + 1, { heap: [5, 5, 5] })],
      }),
      OPTS,
    );
    // Offset -1 is not counted; d and d + 1 both land in the bucket that starts at d.
    expect(series(f, M.connOpened, '*', '')).toEqual({ 0: 1, [d]: 2 });
    expect(series(f, M.dnsCount, 'h', 'req')).toEqual({ [d]: 1 });
    expect(f.durations.find((x) => x.family === 'dns_resolution' && x.dim === 'h')!.startOffsetMs).toBe(d);
    expect(series(f, M.status, '*', '200')).toEqual({ [d]: 1 });
    expect(series(f, M.connClosed, '*', '')).toEqual({ [d]: 1 });
    expect(series(f, M.heap, '*', 'used')).toEqual({ [d]: 5 });
  });

  it('places a final sample past the duration in the last bucket', () => {
    const d = 3625;
    const f = buildAgentFigures(
      file({
        samples: [
          s(-500, { gc: { G1: [1, 1] } }),
          s(2716, { gc: { G1: [2, 2] }, heap: [7, 8, 9] }),
          s(3656, { gc: { G1: [5, 5] }, heap: [3, 8, 9], final: true }),
        ],
      }),
      { ...OPTS, durationMs: d },
    );
    expect(series(f, M.gcCount, '*', 'G1')).toEqual({ 2000: 1, 3000: 3 });
    expect(series(f, M.heap, '*', 'used')).toEqual({ 2000: 7, 3000: 3 });
  });

  it('places an event and a non-final sample past the duration in the last bucket, not only the final sample', () => {
    const f = buildAgentFigures(
      file({
        connects: [connect(100, A, 7)],
        closes: [{ at: R + 3500, ch: 7, remote: A }],
        samples: [
          s(-100, { gc: { G1: [0, 0] } }),
          s(3500, { gc: { G1: [4, 4] }, heap: [9, 9, 9] }),
          s(3600, { gc: { G1: [5, 5] }, heap: [1, 1, 1], final: true }),
        ],
      }),
      { ...OPTS, durationMs: 3000 },
    );
    // Both late samples file into the 3000 bucket: 4 then 1 more collection, heap maxed.
    expect(series(f, M.gcCount, '*', 'G1')).toEqual({ 3000: 5 });
    expect(series(f, M.heap, '*', 'used')).toEqual({ 3000: 9 });
    expect(series(f, M.connClosed, A, '')).toEqual({ 3000: 1 });
  });

  it('differences cumulative counters against the previous sample, the first in-run sample against a pre-run one', () => {
    const f = buildAgentFigures(
      file({
        samples: [
          s(-500, { gc: { G1: [1, 5] } }),
          s(400, { gc: { G1: [3, 9] } }),
          s(1400, { gc: { G1: [4, 10] } }),
        ],
      }),
      OPTS,
    );
    expect(series(f, M.gcCount, '*', 'G1')).toEqual({ 0: 2, 1000: 1 });
    expect(series(f, M.gcTimeMs, '*', 'G1')).toEqual({ 0: 4, 1000: 1 });
  });

  it('counts a collector or a remote first seen mid-run from zero', () => {
    const f = buildAgentFigures(
      file({
        connects: [connect(100, A, 1)],
        samples: [s(-500, { gc: { G1: [1, 1] } }), s(400, { gc: { G1: [1, 1], ZGC: [2, 7] }, bytes: { [A]: [10, 3] } })],
      }),
      OPTS,
    );
    expect(series(f, M.gcCount, '*', 'ZGC')).toEqual({ 0: 2 });
    expect(series(f, M.gcTimeMs, '*', 'ZGC')).toEqual({ 0: 7 });
    expect(series(f, M.bwBits, A, 'out')).toEqual({ 0: 80 });
    expect(series(f, M.bwBits, A, 'in')).toEqual({ 0: 24 });
  });

  it('sums counters and maxes gauges in a coalesced bucket', () => {
    const f = buildAgentFigures(
      file({
        connects: [connect(100, A, 1)],
        samples: [
          s(500, { heap: [10, 20, 30], bytes: { [A]: [100, 0] } }),
          s(1500, { heap: [7, 20, 30], bytes: { [A]: [150, 0] } }),
        ],
      }),
      { ...OPTS, bucketWidthMs: 2000 },
    );
    expect(series(f, M.heap, '*', 'used')).toEqual({ 0: 10 });
    expect(series(f, M.bwBits, '*', 'out')).toEqual({ 0: 1200 });
    expect(series(f, M.bwBits, A, 'out')).toEqual({ 0: 1200 });
    expect(f.bucketWidthMs).toBe(2000);
  });

  it('sums a * gauge across remotes before taking the max', () => {
    const f = buildAgentFigures(
      file({
        connects: [connect(100, A, 1), connect(100, B, 2)],
        samples: [s(200, { states: { [A]: { '6': 2 }, [B]: { '6': 3 } } }), s(700, { states: { [A]: { '6': 4 } } })],
      }),
      OPTS,
    );
    // max(2 + 3, 4) — never max(2, 4) + max(3).
    expect(series(f, M.tcpState, '*', 'timeWait')).toEqual({ 0: 5 });
    expect(series(f, M.tcpState, A, 'timeWait')).toEqual({ 0: 4 });
    expect(series(f, M.tcpState, B, 'timeWait')).toEqual({ 0: 3 });
  });

  it('maps kernel state codes to GE names and drops the rest', () => {
    const f = buildAgentFigures(
      file({ connects: [connect(100, A, 1)], samples: [s(200, { states: { [A]: { '1': 4, '6': 9, '10': 7 } } })] }),
      OPTS,
    );
    const rows = f.metrics.filter((m) => m.metric === M.tcpState && m.dim === A);
    expect(Object.fromEntries(rows.map((m) => [m.label, m.value]))).toEqual({
      synSent: 0,
      established: 4,
      finWait1: 0,
      finWait2: 0,
      closeWait: 0,
      closing: 0,
      lastAck: 0,
      timeWait: 9,
      close: 0,
    });
  });

  it('files nothing for a sample with no states reading and zeros for an empty one', () => {
    const none = buildAgentFigures(file({ connects: [connect(100, A, 1)], samples: [s(200)] }), OPTS);
    expect(none.metrics.filter((m) => m.metric === M.tcpState)).toEqual([]);
    const empty = buildAgentFigures(file({ connects: [connect(100, A, 1)], samples: [s(200, { states: {} })] }), OPTS);
    const rows = empty.metrics.filter((m) => m.metric === M.tcpState);
    expect(rows).toHaveLength(9);
    expect(rows.every((m) => m.dim === '*' && m.value === 0)).toBe(true);
  });

  it('treats a negative delta as 0', () => {
    const f = buildAgentFigures(
      file({ samples: [s(-100, { gc: { G1: [5, 10] } }), s(200, { gc: { G1: [3, 4] } })] }),
      OPTS,
    );
    expect(series(f, M.gcCount, '*', 'G1')).toEqual({ 0: 0 });
    expect(series(f, M.gcTimeMs, '*', 'G1')).toEqual({ 0: 0 });
  });

  it('computes cpu jiffies, ram bytes and the snmp counters', () => {
    const tcp1 = { ActiveOpens: 2, AttemptFails: 0, EstabResets: 1, OutRsts: 0, InSegs: 100, OutSegs: 90, RetransSegs: 1, InErrs: 0, CurrEstab: 4 };
    const tcp2 = { ActiveOpens: 5, AttemptFails: 1, EstabResets: 1, OutRsts: 2, InSegs: 160, OutSegs: 130, RetransSegs: 4, InErrs: 1, CurrEstab: 7 };
    const f = buildAgentFigures(
      file({
        samples: [
          s(-100, { cpu: [10, 1, 20, 100, 5, 2, 3, 0], mem: [1000, 400], tcp: tcp1 }),
          s(600, { cpu: [15, 3, 26, 150, 6, 4, 5, 1], mem: [1000, 300], tcp: tcp2 }),
        ],
      }),
      OPTS,
    );
    expect(series(f, M.cpuJiffies, '*', 'user')).toEqual({ 0: 7 });
    expect(series(f, M.cpuJiffies, '*', 'sys')).toEqual({ 0: 10 });
    expect(series(f, M.cpuJiffies, '*', 'total')).toEqual({ 0: 69 });
    expect(series(f, M.ram, '*', 'total')).toEqual({ 0: 1000 * 1024 });
    expect(series(f, M.ram, '*', 'used')).toEqual({ 0: 700 * 1024 });
    expect(series(f, M.tcpEvt, '*', 'activeOpenings')).toEqual({ 0: 3 });
    expect(series(f, M.tcpEvt, '*', 'failedAttempts')).toEqual({ 0: 1 });
    expect(series(f, M.tcpEvt, '*', 'receivedResets')).toEqual({ 0: 0 });
    expect(series(f, M.tcpEvt, '*', 'sentResets')).toEqual({ 0: 2 });
    expect(series(f, M.tcpSeg, '*', 'received')).toEqual({ 0: 60 });
    expect(series(f, M.tcpSeg, '*', 'sent')).toEqual({ 0: 40 });
    expect(series(f, M.tcpSeg, '*', 'retransmitted')).toEqual({ 0: 3 });
    expect(series(f, M.tcpSeg, '*', 'receivedBad')).toEqual({ 0: 1 });
    expect(series(f, M.tcpEstablished, '*', '')).toEqual({ 0: 7 });
  });

  it('takes no delta for a machine counter with no earlier reading', () => {
    const f = buildAgentFigures(
      file({ samples: [s(600, { cpu: [15, 3, 26, 150, 6, 4, 5, 1], tcp: { InSegs: 160, CurrEstab: 2 } })] }),
      OPTS,
    );
    expect(series(f, M.cpuJiffies, '*', 'total')).toEqual({});
    expect(series(f, M.tcpSeg, '*', 'received')).toEqual({});
    // A gauge is as read, so the same sample still files it.
    expect(series(f, M.tcpEstablished, '*', '')).toEqual({ 0: 2 });
  });

  it('files netty only when the sample reads it', () => {
    const f = buildAgentFigures(file({ samples: [s(100), s(1100, { netty: [64, 8] })] }), OPTS);
    expect(series(f, M.netty, '*', 'direct')).toEqual({ 1000: 64 });
    expect(series(f, M.netty, '*', 'heap')).toEqual({ 1000: 8 });
  });

  it('counts statuses by code', () => {
    const f = buildAgentFigures(
      file({
        statuses: [
          { at: R + 100, req: 'a', code: 200 },
          { at: R + 200, req: 'b', code: 200 },
          { at: R + 1100, req: 'c', code: 404 },
        ],
      }),
      OPTS,
    );
    expect(series(f, M.status, '*', '200')).toEqual({ 0: 2 });
    expect(series(f, M.status, '*', '404')).toEqual({ 1000: 1 });
  });

  it('counts dns req/ok/ko by hostname and *', () => {
    const f = buildAgentFigures(
      file({
        dns: [
          { at: R + 100, us: 1000, host: 'b.test', ok: true, warmup: false },
          { at: R + 200, us: 2000, host: 'a.test', ok: false, warmup: false },
          { at: R + 300, us: 3000, host: 'a.test', ok: true, warmup: false },
        ],
      }),
      OPTS,
    );
    expect(f.hostnames).toEqual(['a.test', 'b.test']);
    const counts = (dim: string) =>
      ['req', 'ok', 'ko'].map((label) => series(f, M.dnsCount, dim, label)[0]);
    expect(counts('a.test')).toEqual([2, 1, 1]);
    expect(counts('b.test')).toEqual([1, 1, 0]);
    expect(counts('*')).toEqual([3, 2, 1]);
    const a = f.durations.find((d) => d.family === 'dns_resolution' && d.dim === 'a.test')!;
    expect([a.okCount, a.koCount, a.histogramOk.max, a.histogramKo.max]).toEqual([1, 1, 3, 2]);
  });

  it('lists the remotes and hostnames its stored rows name, and only those', () => {
    const C = 'c.test/10.0.0.3:443';
    const f = buildAgentFigures(
      file({
        // B's only connect is before the run, so no stored row names B.
        connects: [connect(100, A, 1), connect(-10, B, 2)],
        // C has no connect at all, but an unmetered TLS handshake files a row under it.
        tls: [{ at: R + 200, us: 5000, remote: C, ok: true, ch: null, warmup: false }],
        dns: [{ at: R - 5, us: 1, host: 'early.test', ok: true, warmup: false }, { at: R + 5, us: 1, host: 'z.test', ok: true, warmup: false }],
      }),
      OPTS,
    );
    expect(f.remotes).toEqual([A, C]);
    expect(f.hostnames).toEqual(['z.test']);
  });

  it('names its metrics from one table and marks the gauges', () => {
    const f = buildAgentFigures(
      file({
        connects: [connect(100, A, 1)],
        closes: [{ at: R + 900, ch: 1, remote: A }],
        dns: [{ at: R + 50, us: 1, host: 'h', ok: true, warmup: false }],
        statuses: [{ at: R + 100, req: 'a', code: 200 }],
        samples: [
          s(-100, { gc: { G1: [0, 0] }, cpu: [0, 0, 0, 0, 0, 0, 0, 0], tcp: { ActiveOpens: 0, InSegs: 0 } }),
          s(500, {
            gc: { G1: [1, 1] },
            netty: [1, 1],
            cpu: [1, 1, 1, 1, 1, 1, 1, 1],
            mem: [2, 1],
            tcp: { ActiveOpens: 1, InSegs: 1, CurrEstab: 1 },
            bytes: { [A]: [1, 1] },
            states: { [A]: { '1': 1 } },
          }),
        ],
      }),
      OPTS,
    );
    expect(new Set(f.metrics.map((m) => m.metric))).toEqual(new Set(Object.values(AGENT_METRICS)));
    expect([...AGENT_GAUGE_METRICS].sort()).toEqual(['heap', 'netty', 'ram', 'tcp.established', 'tcp.state']);
  });

  it('matches the paired real fixture', async () => {
    const dir = join(import.meta.dirname, '../../../fixtures/gatling-3.15.1.2/agent-run');
    const agent = decodeAgentFile(readFileSync(join(dir, 'agent.ndjson')));
    async function* events(): AsyncGenerator<CanonicalEvent> {
      yield* parseSimulationLog(readFileSync(join(dir, 'simulation.log')));
    }
    const result = await runEngineAsync(events());
    const run = result.stats.find((x) => x.scope === 'run' && x.family === 'response_time')!;
    const f = buildAgentFigures(agent, {
      runStartMs: result.runStartedAtMs!,
      durationMs: result.durationMs,
      bucketWidthMs: runSeriesWidthMs(result),
    });
    const total = (metric: string, dim: string, label: string) =>
      Object.values(series(f, metric, dim, label)).reduce((a, b) => a + b, 0);

    const statusSum = f.metrics.filter((m) => m.metric === M.status).reduce((a, m) => a + m.value, 0);
    expect(statusSum).toBe(run.count);
    expect(run.count).toBe(90);

    const opened = agent.connects.filter((c) => !c.warmup && c.ok).length;
    const warm = new Set(agent.connects.filter((c) => c.warmup).map((c) => c.ch));
    // Two closes land 1 ms past the run's last request end (offset 3626 against durationMs
    // 3625): the run's own teardown, placed in the last bucket rather than dropped.
    const closed = agent.closes.filter((c) => !warm.has(c.ch)).length;
    expect(agent.closes.some((c) => c.at - result.runStartedAtMs! > result.durationMs)).toBe(true);
    expect([opened, closed]).toEqual([60, 60]);
    expect(total(M.connOpened, '*', '')).toBe(opened);
    expect(total(M.connClosed, '*', '')).toBe(closed);
    expect(total(M.connClosed, '*', '')).toBe(total(M.connOpened, '*', ''));
    const connectOk = f.durations
      .filter((d) => d.family === 'tcp_connect' && d.dim === '*')
      .reduce((a, d) => a + d.histogramOk.total, 0);
    expect(connectOk).toBe(opened);

    expect(f.remotes).toEqual(['localhost/127.0.0.1:33357', 'localhost/127.0.0.1:36137']);
    expect(f.hostnames).toEqual(['localhost']);
    // The final sample lands past durationMs and is kept: every byte the real remotes moved is filed.
    expect(total(M.bwBits, '*', 'out')).toBe((3930 + 49350) * 8);
    expect(total(M.bwBits, '*', 'in')).toBe((6540 + 45562) * 8);
  });
});

describe('runSeriesWidthMs', () => {
  it("is the run-scope response_time series' own width, 1000 when there is none", () => {
    expect(runSeriesWidthMs(runEngine([]))).toBe(1000);
    const events = [...parseSimulationLog(readFileSync('fixtures/gatling-3.15.1.2/reference-report/simulation.log'))];
    const result = runEngine(events, { maxBucketsRun: 4 });
    const run = [...result.series.values()].find((x) => x.scope === 'run' && x.family === 'response_time')!;
    expect(run.bucketWidthMs).toBeGreaterThan(1000);
    expect(runSeriesWidthMs(result)).toBe(run.bucketWidthMs);
  });
});
