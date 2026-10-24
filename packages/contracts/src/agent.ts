import { z } from 'zod';
import { WindowSchema } from './metrics.js';

/**
 * ═══ THE AGENT FIGURES' RESPONSES ═══
 * (GE report parity PR 2, Task 6 — `docs/superpowers/specs/2026-10-22-ge-report-parity-design.md`)
 *
 * Five reads under `/v1/runs/{id}/agent*`, one per GE Report section the agent
 * feeds: the summary, Connections, DNS, Load generators and HTTP status. The
 * Report UI (PR 3) is built on these and nothing else.
 *
 * ═══ NEVER A ZERO WHERE NOTHING WAS MEASURED ═══
 *
 * Every figure the agent could have missed is nullable rather than zero: a
 * population a bucket did not reach, a TCP-state reading the agent could not
 * take that second, a byte gauge before Netty allocated, machine counters on a
 * load generator that does not expose them. A zero on a chart is a claim that
 * something was measured and was zero. Counters, by contrast, are zero when a
 * bucket simply saw no event, because "no connect happened" IS what was
 * measured.
 *
 * ═══ RATES ARE THE READER'S ═══
 *
 * A counter is the bucket's SUM, and every response carries `bucketWidthMs`
 * (as `/series` does), so per-second figures are `value / (bucketWidthMs /
 * 1000)` on the page. The one figure derived here is CPU %, because its
 * denominator (Δ total jiffies) is not something a reader holds.
 */

/** GE's 13 percentile rows (spec §6), in GE's order. Every `overTime` array follows it. */
export const AGENT_PERCENTILE_ROWS = [
  'min', 'p25', 'p50', 'p75', 'p80', 'p85', 'p90', 'p95', 'p99', 'p99_9', 'p99_99', 'max', 'mean',
] as const;
export type AgentPercentileRow = (typeof AGENT_PERCENTILE_ROWS)[number];

/**
 * GE's nine kernel-backed TCP states, in GE's order — the labels
 * `@perfportal/statistics`' `AGENT_TCP_STATES` stores. GE's `bound` and `idle`
 * have no kernel state and are never measured, so they are not here.
 */
export const TCP_STATE_NAMES = [
  'synSent', 'established', 'finWait1', 'finWait2', 'closeWait', 'closing', 'lastAck', 'timeWait', 'close',
] as const;
export type TcpStateName = (typeof TCP_STATE_NAMES)[number];

/**
 * Why a section has nothing to show.
 *
 *   not_collected          the run carries no agent file (no row was ever written)
 *   unreadable             there was a file and it could not be read; `detail` says why
 *   http_not_collected     the agent ran but its HTTP collector was off (Connections,
 *                          DNS and status); `detail` is the agent's own reason
 *   machine_not_collected  the machine collector was off — reported on the injectors
 *                          response's `machine` object, since the JVM figures still exist
 */
export const AgentUnavailableReasonSchema = z.enum([
  'not_collected', 'unreadable', 'http_not_collected', 'machine_not_collected',
]);
export type AgentUnavailableReason = z.infer<typeof AgentUnavailableReasonSchema>;

/** A record with exactly these keys, each a number. */
function counts<const K extends string>(keys: readonly K[]) {
  return z.object(Object.fromEntries(keys.map((k) => [k, z.number()])) as Record<K, z.ZodNumber>).strict();
}

/** A record with exactly these keys, each a number or null (no reading for that one). */
function nullableCounts<const K extends string>(keys: readonly K[]) {
  return z
    .object(Object.fromEntries(keys.map((k) => [k, z.number().nullable()])) as Record<K, z.ZodNullable<z.ZodNumber>>)
    .strict();
}

const PercentileRowSchema = z.array(z.number()).length(AGENT_PERCENTILE_ROWS.length);
const CurvePointSchema = z.tuple([z.number(), z.number()]);

/**
 * One duration section — TCP connect, TLS handshake or DNS resolution — over
 * the buckets inside the window.
 *
 *   overTime      GE's 13 rows per bucket for OK, KO and both; null where that
 *                 population is empty in the bucket
 *   distribution  Gatling's distribution on a uniform grid: bin `i` is at
 *                 `offsetMs + i * stepMs`
 *   percentiles   the curve at p = 0, 2.5 … 97.5, 99, 99.9, 99.99, 100 as
 *                 [p, ms] pairs (0 and 100 are Min and Max); empty for an empty
 *                 population
 *   totals        the OK and KO counts the figures cover
 */
export const DurationSectionSchema = z.object({
  overTime: z.array(z.object({
    startOffsetMs: z.number().int().nonnegative(),
    ok: PercentileRowSchema.nullable(),
    ko: PercentileRowSchema.nullable(),
    all: PercentileRowSchema.nullable(),
  })),
  distribution: z.object({
    offsetMs: z.number(),
    stepMs: z.number().positive(),
    ok: z.array(z.number().int().nonnegative()),
    ko: z.array(z.number().int().nonnegative()),
    meanMs: z.number().nullable(),
  }),
  percentiles: z.object({
    ok: z.array(CurvePointSchema),
    ko: z.array(CurvePointSchema),
    all: z.array(CurvePointSchema),
    meanMs: z.object({ ok: z.number().nullable(), ko: z.number().nullable(), all: z.number().nullable() }),
  }),
  totals: z.object({ ok: z.number().int().nonnegative(), ko: z.number().int().nonnegative() }),
});
export type DurationSection = z.infer<typeof DurationSectionSchema>;

/**
 * What every figure read shares. `available` is decided BEFORE the window: a
 * window over a quiet stretch of a run that WAS collected answers
 * `available: true` with no buckets, never "not collected".
 */
const figureBase = {
  runId: z.string().uuid(),
  available: z.boolean(),
  reason: AgentUnavailableReasonSchema.nullable(),
  /** The stored reason a file was unreadable, or the agent's reason a collector was off. */
  detail: z.string().nullable(),
  /** The run's own series width the figures were bucketed on; null when nothing was collected. */
  bucketWidthMs: z.number().int().positive().nullable(),
  /** Null when the whole run was asked for; otherwise SNAPPED — see WindowSchema. */
  window: WindowSchema.nullable(),
};

export const AgentHeaderSchema = z.object({
  agentVersion: z.string(),
  gatlingHttpClient: z.string().nullable(),
  gatlingHttp: z.string().nullable(),
  java: z.string(),
  os: z.string(),
  /** The load generator's own hostname; null when its JVM could not tell. */
  host: z.string().nullable(),
  collects: z.object({ http: z.boolean(), machine: z.boolean() }),
  /** Why each collector that is OFF is off; a collector that is on has no entry. */
  reasons: z.object({ http: z.string().optional(), machine: z.string().optional() }),
});
export type AgentHeader = z.infer<typeof AgentHeaderSchema>;

/** `GET /v1/runs/{id}/agent`. */
export const AgentSummaryResponseSchema = z.object({
  runId: z.string().uuid(),
  available: z.boolean(),
  reason: AgentUnavailableReasonSchema.nullable(),
  detail: z.string().nullable(),
  header: AgentHeaderSchema.nullable(),
  /** The file reached the agent's size cap, so later events are missing. */
  capped: z.boolean(),
  /** The agent's one `error` line: it stopped collecting there. */
  agentError: z.object({ at: z.number(), where: z.string(), message: z.string() }).nullable(),
  malformedLines: z.number().int().nonnegative(),
  bucketWidthMs: z.number().int().positive().nullable(),
  /** Every remote with a non-warm-up connection, sorted — the values `?remote=` takes. */
  remotes: z.array(z.string()),
  /** Every hostname resolved outside the warm-up, sorted — the values `?hostname=` takes. */
  hostnames: z.array(z.string()),
  injector: z.object({
    host: z.string().nullable(),
    /** True when the run came from PerfPortal's own on-prem runner, so the machine ran nothing else. */
    sharedWithPerfPortal: z.boolean(),
  }),
});
export type AgentSummaryResponse = z.infer<typeof AgentSummaryResponseSchema>;

/** `GET /v1/runs/{id}/agent/connections`. `remote` is `*` for every remote together. */
export const AgentConnectionsResponseSchema = z.object({
  ...figureBase,
  remote: z.string(),
  buckets: z.array(z.object({
    startOffsetMs: z.number().int().nonnegative(),
    opened: z.number(),
    closed: z.number(),
    bitsOut: z.number(),
    bitsIn: z.number(),
    /** Each GE state's highest count in the bucket; null when the agent took no reading in it. */
    states: counts(TCP_STATE_NAMES).nullable(),
  })),
  tcpConnect: DurationSectionSchema,
  tlsHandshake: DurationSectionSchema,
  sums: z.object({ opened: z.number(), closed: z.number(), bitsOut: z.number(), bitsIn: z.number() }),
});
export type AgentConnectionsResponse = z.infer<typeof AgentConnectionsResponseSchema>;

/** `GET /v1/runs/{id}/agent/dns`. `hostname` is `*` for every hostname together. */
export const AgentDnsResponseSchema = z.object({
  ...figureBase,
  hostname: z.string(),
  buckets: z.array(z.object({
    startOffsetMs: z.number().int().nonnegative(),
    requests: z.number(),
    ok: z.number(),
    ko: z.number(),
  })),
  resolution: DurationSectionSchema,
  sums: z.object({ requests: z.number(), ok: z.number(), ko: z.number() }),
});
export type AgentDnsResponse = z.infer<typeof AgentDnsResponseSchema>;

export const TCP_EVENT_NAMES = [
  'activeOpenings', 'failedAttempts', 'established', 'receivedResets', 'sentResets',
] as const;
export const TCP_SEGMENT_NAMES = ['received', 'sent', 'retransmitted', 'receivedBad'] as const;

/** `GET /v1/runs/{id}/agent/injectors` — the load generator's JVM and machine. */
export const AgentInjectorsResponseSchema = z.object({
  ...figureBase,
  /** Whether the machine collector (CPU, RAM, kernel TCP) ran, and if not, the agent's reason. */
  machine: z.object({ available: z.boolean(), reason: z.string().nullable() }),
  buckets: z.array(z.object({
    startOffsetMs: z.number().int().nonnegative(),
    /** Collections per collector name in the bucket. */
    gcCount: z.record(z.number()),
    /** Collection time (ms) per collector name in the bucket. */
    gcTimeMs: z.record(z.number()),
    /** `100 × Δuser / Δtotal`, rounded to 2 dp; null when Δtotal is 0 or absent. */
    cpuUserPct: z.number().nullable(),
    cpuSysPct: z.number().nullable(),
    ramTotalBytes: z.number().nullable(),
    ramUsedBytes: z.number().nullable(),
    heapMaxBytes: z.number().nullable(),
    heapCommittedBytes: z.number().nullable(),
    heapUsedBytes: z.number().nullable(),
    nettyDirectBytes: z.number().nullable(),
    nettyHeapBytes: z.number().nullable(),
    /**
     * Kernel TCP events: four counters (`tcp.evt`) and `established`, a GAUGE
     * (`tcp.established`). The two are filed differently — the gauge on every
     * sample carrying kernel TCP, the counters only once an earlier sample gives
     * them a delta — so a bucket can hold one without the other. Each field is
     * therefore null on its own: the four counters when the bucket has no
     * `tcp.evt` reading, `established` when it has no gauge reading. The whole
     * object is null only when it has neither.
     */
    tcpEvents: nullableCounts(TCP_EVENT_NAMES).nullable(),
    /**
     * Kernel TCP segments. All four are one counter group (`tcp.seg`), filed
     * together from one sample pair, so they cannot be split: the object is
     * null when the bucket has no `tcp.seg` reading, and whole otherwise.
     */
    tcpSegments: counts(TCP_SEGMENT_NAMES).nullable(),
  })),
});
export type AgentInjectorsResponse = z.infer<typeof AgentInjectorsResponseSchema>;

/** `GET /v1/runs/{id}/agent/status` — HTTP status codes over time. */
export const AgentStatusResponseSchema = z.object({
  ...figureBase,
  /** Every code the run's responses carried, sorted — the same series in any window. */
  codes: z.array(z.string()),
  buckets: z.array(z.object({
    startOffsetMs: z.number().int().nonnegative(),
    /** Responses per code in the bucket; a code absent here had none. */
    counts: z.record(z.number()),
  })),
});
export type AgentStatusResponse = z.infer<typeof AgentStatusResponseSchema>;
