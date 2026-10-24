import { describe, expect, it } from 'vitest';
import type { ZodTypeAny } from 'zod';
import {
  AGENT_PERCENTILE_ROWS,
  AgentConnectionsResponseSchema,
  AgentDnsResponseSchema,
  AgentInjectorsResponseSchema,
  AgentStatusResponseSchema,
  AgentSummaryResponseSchema,
  DurationSectionSchema,
  TCP_STATE_NAMES,
} from '../src/index.js';

/**
 * ═══ THE AGENT FIGURES ON THE WIRE ═══
 * (GE report parity PR 2, Task 6)
 *
 * What the Report's agent sections are built on. Each schema parses a body
 * shaped as the API sends it, and each refuses a body missing `bucketWidthMs`
 * — the field every chart needs to turn a bucket's counter sum into a rate.
 */
const RUN = '0f9b1d4e-1111-4222-8333-444455556666';
const ROW = AGENT_PERCENTILE_ROWS.map((_, i) => i + 1);

const SECTION = {
  overTime: [{ startOffsetMs: 0, ok: ROW, ko: null, all: ROW }],
  distribution: { offsetMs: 1, stepMs: 1, ok: [1, 0, 2], ko: [0, 0, 0], meanMs: 2.5 },
  percentiles: { ok: [[0, 1], [100, 3]], ko: [], all: [[0, 1], [100, 3]], meanMs: { ok: 2.5, ko: null, all: 2.5 } },
  totals: { ok: 3, ko: 0 },
};
const STATES = Object.fromEntries(TCP_STATE_NAMES.map((s) => [s, 0]));

const BODIES: Record<string, { schema: ZodTypeAny; body: Record<string, unknown> }> = {
  summary: {
    schema: AgentSummaryResponseSchema,
    body: {
      runId: RUN,
      available: true,
      reason: null,
      detail: null,
      header: {
        agentVersion: '0.1.0',
        gatlingHttpClient: '3.15.1',
        gatlingHttp: '3.15.1',
        java: '21.0.12.1',
        os: 'Linux',
        host: 'loadgen-1',
        collects: { http: true, machine: true },
        reasons: {},
      },
      capped: false,
      agentError: null,
      malformedLines: 0,
      bucketWidthMs: 1000,
      remotes: ['localhost/127.0.0.1:33357'],
      hostnames: ['localhost'],
      injector: { host: 'loadgen-1', sharedWithPerfPortal: false },
    },
  },
  connections: {
    schema: AgentConnectionsResponseSchema,
    body: {
      runId: RUN, available: true, reason: null, detail: null, bucketWidthMs: 1000, window: null, remote: '*',
      buckets: [
        { startOffsetMs: 0, opened: 2, closed: 0, bitsOut: 800, bitsIn: 1600, states: STATES },
        { startOffsetMs: 1000, opened: 0, closed: 1, bitsOut: 0, bitsIn: 0, states: null },
      ],
      tcpConnect: SECTION,
      tlsHandshake: SECTION,
      sums: { opened: 2, closed: 1, bitsOut: 800, bitsIn: 1600 },
    },
  },
  dns: {
    schema: AgentDnsResponseSchema,
    body: {
      runId: RUN, available: true, reason: null, detail: null, bucketWidthMs: 1000, window: null, hostname: '*',
      buckets: [{ startOffsetMs: 0, requests: 3, ok: 3, ko: 0 }],
      resolution: SECTION,
      sums: { requests: 3, ok: 3, ko: 0 },
    },
  },
  injectors: {
    schema: AgentInjectorsResponseSchema,
    body: {
      runId: RUN, available: true, reason: null, detail: null, bucketWidthMs: 1000, window: null,
      machine: { available: true, reason: null },
      buckets: [{
        startOffsetMs: 0,
        gcCount: { G1: 1 },
        gcTimeMs: { G1: 3 },
        cpuUserPct: 12.5,
        cpuSysPct: 2.25,
        ramTotalBytes: 8e9,
        ramUsedBytes: 2e9,
        heapMaxBytes: 1e9,
        heapCommittedBytes: 5e8,
        heapUsedBytes: 2e8,
        nettyDirectBytes: null,
        nettyHeapBytes: null,
        tcpEvents: { activeOpenings: 2, failedAttempts: 0, established: 2, receivedResets: 0, sentResets: 0 },
        tcpSegments: { received: 10, sent: 12, retransmitted: 0, receivedBad: 0 },
      }],
    },
  },
  status: {
    schema: AgentStatusResponseSchema,
    body: {
      runId: RUN, available: true, reason: null, detail: null, bucketWidthMs: 1000, window: null,
      codes: ['200', '404'],
      buckets: [{ startOffsetMs: 0, counts: { '200': 2, '404': 1 } }],
    },
  },
};

describe('the agent response schemas', () => {
  it('lists GE\'s 13 percentile rows in GE\'s order', () => {
    expect(AGENT_PERCENTILE_ROWS).toEqual([
      'min', 'p25', 'p50', 'p75', 'p80', 'p85', 'p90', 'p95', 'p99', 'p99_9', 'p99_99', 'max', 'mean',
    ]);
  });

  for (const [name, { schema, body }] of Object.entries(BODIES)) {
    it(`${name}: parses a valid body`, () => {
      expect(schema.safeParse(body).success).toBe(true);
    });

    it(`${name}: refuses a body missing bucketWidthMs`, () => {
      const rest: Record<string, unknown> = { ...body };
      delete rest['bucketWidthMs'];
      expect(schema.safeParse(rest).success).toBe(false);
    });
  }

  it('parses an unavailable summary, with every figure empty', () => {
    const body = {
      runId: RUN, available: false, reason: 'not_collected', detail: null, header: null, capped: false,
      agentError: null, malformedLines: 0, bucketWidthMs: null, remotes: [], hostnames: [],
      injector: { host: null, sharedWithPerfPortal: true },
    };
    expect(AgentSummaryResponseSchema.safeParse(body).success).toBe(true);
    expect(AgentSummaryResponseSchema.safeParse({ ...body, reason: 'gone' }).success).toBe(false);
  });

  it('refuses a percentile row that is not 13 long', () => {
    const bad = { ...SECTION, overTime: [{ startOffsetMs: 0, ok: [1, 2], ko: null, all: null }] };
    expect(DurationSectionSchema.safeParse(bad).success).toBe(false);
  });

  it('refuses a connections bucket whose states lack a GE state', () => {
    const eight: Record<string, number> = { ...STATES };
    delete eight['close'];
    const body = BODIES.connections!.body;
    const bad = { ...body, buckets: [{ startOffsetMs: 0, opened: 0, closed: 0, bitsOut: 0, bitsIn: 0, states: eight }] };
    expect(AgentConnectionsResponseSchema.safeParse(bad).success).toBe(false);
  });
});
