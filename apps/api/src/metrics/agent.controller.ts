import { Controller, Get, Param, Query, Req } from '@nestjs/common';
import {
  TCP_STATE_NAMES,
  type AgentConnectionsResponse,
  type AgentDnsResponse,
  type AgentInjectorsResponse,
  type AgentStatusResponse,
  type AgentSummaryResponse,
  type AgentUnavailableReason,
  type Window,
} from '@perfportal/contracts';
import { AgentReader, MetricReader, RunRepository, type AgentSummaryRow, type RunRecord } from '@perfportal/persistence';
import { AGENT_ALL, AGENT_METRICS, durationSection, type AgentMetricBucket } from '@perfportal/statistics';
import type { Request } from 'express';
import { Requires } from '../auth/access.decorator.js';
import { Scopes } from '../auth/scopes.decorator.js';
import { badRequest, runNotFound, singleValue, uuidParam } from '../common/validation.js';
import { inRange, resolveRange, snapWindow } from '../common/window.js';
import { RunsService } from '../runs/runs.service.js';

type Range = { fromMs: number; toMs: number } | null;

/** offset → metric → label → value: one bucket's stored rows, addressable. */
type Grid = Map<number, Map<string, Map<string, number>>>;

const REMEDIATION = "List the run's remotes and hostnames with GET /v1/runs/{id}/agent.";

/**
 * ═══ THE AGENT FIGURES — WHAT THE REPORT'S AGENT SECTIONS READ ═══
 * (GE report parity PR 2, Task 6)
 *
 * Under `/v1/runs/:id` like every other run-scoped read, so it is in both
 * guards derived from that prefix: session-auth's cross-org list and the
 * OpenAPI route/document join. Every read resolves the run through the tenant
 * first (another org's run is 404, never 403) and supplies its partition day.
 *
 * ═══ AVAILABILITY COMES FROM `run_agent`, BEFORE THE WINDOW ═══
 *
 * No row means the run carried no agent file (`not_collected`); an
 * `unreadable` row says why it could not be read. A window over a quiet stretch
 * of a run that WAS collected is `available: true` with no buckets — the
 * telemetry endpoint's rule, for the same reason: "nothing here" and "never
 * recorded" are different claims and only the first is true of a quiet slice.
 *
 * ═══ THE WINDOW IS `/telemetry`'S ═══
 *
 * `resolveRange` (one `WINDOW_UNAVAILABLE` rule for every windowed read),
 * `inRange` (half-open, like every bucket filter here) and `snapWindow` with
 * the width the figures were bucketed on — passed explicitly, because an
 * agent's offsets are not a faithful proxy for it (a sparse remote's buckets
 * are as far apart as its connects).
 */
@Controller('/v1/runs/:id')
export class AgentController {
  constructor(
    private readonly runs: RunRepository,
    private readonly reader: MetricReader,
    private readonly agents: AgentReader,
    private readonly runsService: RunsService,
  ) {}

  async #run(req: Request, id: string): Promise<RunRecord> {
    const tenant = req.tenant!;
    const run = await this.runs.findById({ orgId: tenant.orgId, projectId: tenant.projectId }, id);
    if (!run) throw runNotFound(id);
    return run;
  }

  /** The run, its window and its `run_agent` row — what every figure read starts from. */
  async #figures(req: Request, id: string, from: unknown, to: unknown) {
    const run = await this.#run(req, id);
    const range = await resolveRange(this.reader, run, singleValue('from', from), singleValue('to', to));
    const scope = { orgId: run.orgId, projectId: run.projectId };
    const summary = await this.agents.summary(scope, run.id);
    return { run, range, scope, summary };
  }

  /**
   * The run's agent: whether one was collected, its header, the remotes and
   * hostnames the figure reads accept, and which machine it ran on.
   */
  @Get('agent')
  @Requires('project:read')
  @Scopes('read')
  async summary(
    @Param('id', uuidParam('id')) id: string,
    @Req() req: Request,
  ): Promise<AgentSummaryResponse> {
    const run = await this.#run(req, id);
    const [row, lifecycle] = await Promise.all([
      this.agents.summary({ orgId: run.orgId, projectId: run.projectId }, run.id),
      // One definition of "this run came from the on-prem runner": the
      // runner-job link the run's own identity already exposes.
      this.runsService.lifecycleOf(run),
    ]);
    const missing = unavailable(row, false);
    const header = row?.header ?? null;
    return {
      runId: run.id,
      available: missing === null,
      reason: missing?.reason ?? null,
      detail: missing?.detail ?? null,
      header: header === null
        ? null
        : {
            agentVersion: header.agentVersion,
            gatlingHttpClient: header.gatlingHttpClient ?? null,
            gatlingHttp: header.gatlingHttp ?? null,
            java: header.java,
            os: header.os,
            host: header.host ?? null,
            collects: { http: header.collects.http, machine: header.collects.machine },
            reasons: reasonsOf(header.reasons),
          },
      capped: row?.capped ?? false,
      agentError: row?.agentError ?? null,
      malformedLines: row?.malformedLines ?? 0,
      bucketWidthMs: row?.bucketWidthMs ?? null,
      remotes: row?.remotes ?? [],
      hostnames: row?.hostnames ?? [],
      injector: { host: header?.host ?? null, sharedWithPerfPortal: lifecycle.runnerJobId !== null },
    };
  }

  /** Connections opened and closed, bandwidth, TCP states, and the connect and TLS durations, per remote. */
  @Get('agent/connections')
  @Requires('project:read')
  @Scopes('read')
  async connections(
    @Param('id', uuidParam('id')) id: string,
    @Req() req: Request,
    @Query('remote') remoteParam?: unknown,
    @Query('from') from?: unknown,
    @Query('to') to?: unknown,
  ): Promise<AgentConnectionsResponse> {
    const remote = singleValue('remote', remoteParam) || AGENT_ALL;
    const { run, range, scope, summary } = await this.#figures(req, id, from, to);
    const missing = unavailable(summary, true);
    if (missing !== null || summary === null) {
      return {
        ...unavailableBase(run.id, missing, summary),
        remote,
        buckets: [],
        tcpConnect: durationSection([]),
        tlsHandshake: durationSection([]),
        sums: { opened: 0, closed: 0, bitsOut: 0, bitsIn: 0 },
      };
    }
    if (remote !== AGENT_ALL && !summary.remotes.includes(remote)) {
      throw badRequest('UNKNOWN_REMOTE', `Run ${run.id} has no connections to remote "${remote}".`, REMEDIATION);
    }

    const [metrics, durations] = await Promise.all([
      this.agents.metrics(scope, run.id, run.startedOn, {
        metrics: [AGENT_METRICS.connOpened, AGENT_METRICS.connClosed, AGENT_METRICS.bwBits, AGENT_METRICS.tcpState],
        dim: remote,
      }),
      this.agents.durations(scope, run.id, run.startedOn, { families: ['tcp_connect', 'tls_handshake'], dim: remote }),
    ]);
    const grid = gridOf(metrics);
    const buckets = [...grid.entries()]
      .filter(([offset]) => inRange(offset, range))
      .map(([startOffsetMs, m]) => {
        const states = m.get(AGENT_METRICS.tcpState);
        return {
          startOffsetMs,
          opened: value(m, AGENT_METRICS.connOpened, ''),
          closed: value(m, AGENT_METRICS.connClosed, ''),
          bitsOut: value(m, AGENT_METRICS.bwBits, 'out'),
          bitsIn: value(m, AGENT_METRICS.bwBits, 'in'),
          // Null when no sample in the bucket carried a reading for this remote:
          // nine zeros would draw an idle remote the agent never looked at.
          states: states === undefined
            ? null
            : Object.fromEntries(TCP_STATE_NAMES.map((s) => [s, states.get(s) ?? 0])) as Record<(typeof TCP_STATE_NAMES)[number], number>,
        };
      });
    const inWindow = durations.filter((b) => inRange(b.startOffsetMs, range));
    return {
      ...availableBase(run.id, summary, range, [...grid.keys(), ...durations.map((b) => b.startOffsetMs)]),
      remote,
      buckets,
      tcpConnect: durationSection(inWindow.filter((b) => b.family === 'tcp_connect')),
      tlsHandshake: durationSection(inWindow.filter((b) => b.family === 'tls_handshake')),
      sums: {
        opened: sum(buckets, (b) => b.opened),
        closed: sum(buckets, (b) => b.closed),
        bitsOut: sum(buckets, (b) => b.bitsOut),
        bitsIn: sum(buckets, (b) => b.bitsIn),
      },
    };
  }

  /** DNS lookups (requests, OK, KO) and resolution durations, per hostname. */
  @Get('agent/dns')
  @Requires('project:read')
  @Scopes('read')
  async dns(
    @Param('id', uuidParam('id')) id: string,
    @Req() req: Request,
    @Query('hostname') hostnameParam?: unknown,
    @Query('from') from?: unknown,
    @Query('to') to?: unknown,
  ): Promise<AgentDnsResponse> {
    const hostname = singleValue('hostname', hostnameParam) || AGENT_ALL;
    const { run, range, scope, summary } = await this.#figures(req, id, from, to);
    const missing = unavailable(summary, true);
    if (missing !== null || summary === null) {
      return {
        ...unavailableBase(run.id, missing, summary),
        hostname,
        buckets: [],
        resolution: durationSection([]),
        sums: { requests: 0, ok: 0, ko: 0 },
      };
    }
    if (hostname !== AGENT_ALL && !summary.hostnames.includes(hostname)) {
      throw badRequest('UNKNOWN_HOSTNAME', `Run ${run.id} resolved no hostname "${hostname}".`, REMEDIATION);
    }

    const [metrics, durations] = await Promise.all([
      this.agents.metrics(scope, run.id, run.startedOn, { metrics: [AGENT_METRICS.dnsCount], dim: hostname }),
      this.agents.durations(scope, run.id, run.startedOn, { families: ['dns_resolution'], dim: hostname }),
    ]);
    const grid = gridOf(metrics);
    const buckets = [...grid.entries()]
      .filter(([offset]) => inRange(offset, range))
      .map(([startOffsetMs, m]) => ({
        startOffsetMs,
        requests: value(m, AGENT_METRICS.dnsCount, 'req'),
        ok: value(m, AGENT_METRICS.dnsCount, 'ok'),
        ko: value(m, AGENT_METRICS.dnsCount, 'ko'),
      }));
    return {
      ...availableBase(run.id, summary, range, [...grid.keys(), ...durations.map((b) => b.startOffsetMs)]),
      hostname,
      buckets,
      resolution: durationSection(durations.filter((b) => inRange(b.startOffsetMs, range))),
      sums: {
        requests: sum(buckets, (b) => b.requests),
        ok: sum(buckets, (b) => b.ok),
        ko: sum(buckets, (b) => b.ko),
      },
    };
  }

  /**
   * The load generator: GC, heap and Netty (any JVM), and CPU, RAM and kernel
   * TCP (the machine collector, Linux only). Needs no HTTP collector, so a run
   * whose HTTP collector was off still answers here.
   */
  @Get('agent/injectors')
  @Requires('project:read')
  @Scopes('read')
  async injectors(
    @Param('id', uuidParam('id')) id: string,
    @Req() req: Request,
    @Query('from') from?: unknown,
    @Query('to') to?: unknown,
  ): Promise<AgentInjectorsResponse> {
    const { run, range, scope, summary } = await this.#figures(req, id, from, to);
    const missing = unavailable(summary, false);
    const header = summary?.header ?? null;
    const machine = {
      available: header?.collects.machine ?? false,
      reason: header?.reasons.machine ?? null,
    };
    if (missing !== null || summary === null) {
      return { ...unavailableBase(run.id, missing, summary), machine, buckets: [] };
    }

    const metrics = await this.agents.metrics(scope, run.id, run.startedOn, {
      metrics: [
        AGENT_METRICS.gcCount, AGENT_METRICS.gcTimeMs, AGENT_METRICS.cpuJiffies, AGENT_METRICS.ram,
        AGENT_METRICS.heap, AGENT_METRICS.netty, AGENT_METRICS.tcpEvt, AGENT_METRICS.tcpEstablished,
        AGENT_METRICS.tcpSeg,
      ],
      dim: AGENT_ALL,
    });
    const grid = gridOf(metrics);
    const buckets = [...grid.entries()]
      .filter(([offset]) => inRange(offset, range))
      .map(([startOffsetMs, m]) => {
        const evt = m.get(AGENT_METRICS.tcpEvt);
        const established = m.get(AGENT_METRICS.tcpEstablished)?.get('');
        const seg = m.get(AGENT_METRICS.tcpSeg);
        return {
          startOffsetMs,
          gcCount: Object.fromEntries(m.get(AGENT_METRICS.gcCount) ?? []),
          gcTimeMs: Object.fromEntries(m.get(AGENT_METRICS.gcTimeMs) ?? []),
          cpuUserPct: cpuPct(m, 'user'),
          cpuSysPct: cpuPct(m, 'sys'),
          ramTotalBytes: gauge(m, AGENT_METRICS.ram, 'total'),
          ramUsedBytes: gauge(m, AGENT_METRICS.ram, 'used'),
          heapMaxBytes: gauge(m, AGENT_METRICS.heap, 'max'),
          heapCommittedBytes: gauge(m, AGENT_METRICS.heap, 'committed'),
          heapUsedBytes: gauge(m, AGENT_METRICS.heap, 'used'),
          nettyDirectBytes: gauge(m, AGENT_METRICS.netty, 'direct'),
          nettyHeapBytes: gauge(m, AGENT_METRICS.netty, 'heap'),
          // Null when the bucket holds no kernel TCP reading at all: an unkeyed
          // machine counter files nothing without an earlier sample to take a
          // delta from, and off Linux nothing is read — zeros would claim a
          // measurement of an idle network stack.
          tcpEvents: evt === undefined && established === undefined
            ? null
            : {
                activeOpenings: evt?.get('activeOpenings') ?? 0,
                failedAttempts: evt?.get('failedAttempts') ?? 0,
                established: established ?? 0,
                receivedResets: evt?.get('receivedResets') ?? 0,
                sentResets: evt?.get('sentResets') ?? 0,
              },
          tcpSegments: seg === undefined
            ? null
            : {
                received: seg.get('received') ?? 0,
                sent: seg.get('sent') ?? 0,
                retransmitted: seg.get('retransmitted') ?? 0,
                receivedBad: seg.get('receivedBad') ?? 0,
              },
        };
      });
    return { ...availableBase(run.id, summary, range, [...grid.keys()]), machine, buckets };
  }

  /** HTTP status codes over time — one per response the agent saw. */
  @Get('agent/status')
  @Requires('project:read')
  @Scopes('read')
  async status(
    @Param('id', uuidParam('id')) id: string,
    @Req() req: Request,
    @Query('from') from?: unknown,
    @Query('to') to?: unknown,
  ): Promise<AgentStatusResponse> {
    const { run, range, scope, summary } = await this.#figures(req, id, from, to);
    const missing = unavailable(summary, true);
    if (missing !== null || summary === null) {
      return { ...unavailableBase(run.id, missing, summary), codes: [], buckets: [] };
    }
    const metrics = await this.agents.metrics(scope, run.id, run.startedOn, {
      metrics: [AGENT_METRICS.status],
      dim: AGENT_ALL,
    });
    const grid = gridOf(metrics);
    // From the WHOLE run, not the window: a chart's series stay the same as a
    // reader brushes, so a code with no responses in the slice is a flat line
    // rather than a series that vanishes.
    const codes = [...new Set(metrics.map((r) => r.label))].sort((a, b) =>
      a.localeCompare(b, 'en', { numeric: true }));
    const buckets = [...grid.entries()]
      .filter(([offset]) => inRange(offset, range))
      .map(([startOffsetMs, m]) => ({
        startOffsetMs,
        counts: Object.fromEntries(m.get(AGENT_METRICS.status) ?? []),
      }));
    return { ...availableBase(run.id, summary, range, [...grid.keys()]), codes, buckets };
  }
}

/**
 * Why a figure cannot be shown, or null when it can. `needsHttp` is true for
 * Connections, DNS and status, which only the HTTP collector produces.
 */
function unavailable(
  summary: AgentSummaryRow | null,
  needsHttp: boolean,
): { reason: AgentUnavailableReason; detail: string | null } | null {
  if (summary === null) return { reason: 'not_collected', detail: null };
  if (summary.status === 'unreadable') return { reason: 'unreadable', detail: summary.reason };
  if (needsHttp && summary.header !== null && !summary.header.collects.http) {
    return { reason: 'http_not_collected', detail: summary.header.reasons.http ?? null };
  }
  return null;
}

function unavailableBase(
  runId: string,
  missing: { reason: AgentUnavailableReason; detail: string | null } | null,
  summary: AgentSummaryRow | null,
) {
  return {
    runId,
    available: false,
    reason: missing?.reason ?? 'not_collected',
    detail: missing?.detail ?? null,
    bucketWidthMs: summary?.bucketWidthMs ?? null,
    window: null,
  };
}

function availableBase(runId: string, summary: AgentSummaryRow, range: Range, offsets: number[]) {
  // A collected row always carries its width; 1000 is the run default the
  // figures fall back to when a run has no series of its own.
  const bucketWidthMs = summary.bucketWidthMs ?? 1000;
  const window: Window | null = range === null ? null : snapWindow(offsets, range, bucketWidthMs);
  return { runId, available: true, reason: null, detail: null, bucketWidthMs, window };
}

/** Only the collectors that are off, each with the agent's own reason — a key per reason, never an undefined one. */
function reasonsOf(stored: { http?: string; machine?: string }): { http?: string; machine?: string } {
  const out: { http?: string; machine?: string } = {};
  if (typeof stored.http === 'string') out.http = stored.http;
  if (typeof stored.machine === 'string') out.machine = stored.machine;
  return out;
}

/** Rows by bucket, in bucket order. */
function gridOf(rows: readonly AgentMetricBucket[]): Grid {
  const grid: Grid = new Map();
  for (const r of [...rows].sort((a, b) => a.startOffsetMs - b.startOffsetMs)) {
    let metrics = grid.get(r.startOffsetMs);
    if (metrics === undefined) grid.set(r.startOffsetMs, (metrics = new Map()));
    let labels = metrics.get(r.metric);
    if (labels === undefined) metrics.set(r.metric, (labels = new Map()));
    labels.set(r.label, r.value);
  }
  return grid;
}

/** A counter: a bucket with no row for it saw no event, which IS a measured zero. */
function value(m: Map<string, Map<string, number>>, metric: string, label: string): number {
  return m.get(metric)?.get(label) ?? 0;
}

/** A gauge: a bucket with no row for it holds no reading, which is not a zero. */
function gauge(m: Map<string, Map<string, number>>, metric: string, label: string): number | null {
  return m.get(metric)?.get(label) ?? null;
}

/** `100 × Δpart / Δtotal`, rounded to 2 dp; null when Δtotal is 0 or absent. */
function cpuPct(m: Map<string, Map<string, number>>, part: 'user' | 'sys'): number | null {
  const jiffies = m.get(AGENT_METRICS.cpuJiffies);
  const total = jiffies?.get('total');
  const share = jiffies?.get(part);
  if (total === undefined || total <= 0 || share === undefined) return null;
  return Math.round((10_000 * share) / total) / 100;
}

function sum<T>(items: readonly T[], of: (item: T) => number): number {
  return items.reduce((acc, item) => acc + of(item), 0);
}
