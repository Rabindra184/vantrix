import { AGENT_FILE_FORMAT } from '@perfportal/core';

/**
 * Decodes the PerfPortal Gatling agent's NDJSON file (`clients/gatling-agent`). The line shapes
 * are the agent's own — `Collector`'s, `Sampler`'s and `AgentMain.header`'s Javadoc are the
 * authoritative text; `at` is epoch milliseconds and `us` microseconds throughout.
 *
 * ═══ THIS PARSES AND TYPE-CHECKS, AND DECIDES NOTHING ═══
 *
 * Warm-up exclusion, the run's time window, counter deltas and every other figure rule belong to
 * whoever builds a figure from this (the figure builder and the independent verifier both read
 * through here). A `warmup` flag is carried as a boolean, never acted on.
 *
 * ═══ WHAT IS REFUSED AND WHAT IS SKIPPED ═══
 *
 *   - Line 1 must be a `header` naming {@link AGENT_FILE_FORMAT}, with every field its type
 *     requires; otherwise {@link AgentFileError}. Nothing below can be trusted without it.
 *   - A later line that is not a JSON object, or a KNOWN record type missing a field its type
 *     requires (or carrying it in the wrong JSON type), is skipped and counted in
 *     `malformedLines`. A JVM killed mid-write leaves exactly one such line, its last.
 *   - An UNKNOWN record type is skipped and NOT counted: a later agent may add one, and this
 *     reader must keep working on its files.
 *   - Blank lines are ignored, and a trailing `\r` is tolerated.
 *
 * Records keep file order within each list.
 */

export interface AgentHeader {
  format: string;
  agentVersion: string;
  /** Null when the agent found no Gatling HTTP client jar. */
  gatlingHttpClient: string | null;
  gatlingHttp: string | null;
  java: string;
  os: string;
  /** The load generator's own hostname; null when the JVM could not tell, or the file predates the field. */
  host: string | null;
  startedAt: number;
  collects: { http: boolean; machine: boolean };
  /** Why each collector that is OFF is off; a collector that is on has no entry. */
  reasons: { http?: string; machine?: string };
}

export interface AgentDns {
  at: number;
  us: number;
  host: string;
  ok: boolean;
  warmup: boolean;
}

export interface AgentConnect {
  at: number;
  us: number;
  remote: string;
  ok: boolean;
  /** The agent's own channel id, pairing a connect with its close and its tls. */
  ch: number;
  warmup: boolean;
}

export interface AgentTls {
  at: number;
  us: number;
  remote: string;
  ok: boolean;
  /** Null when the channel was not metered (not opened by Gatling's client). */
  ch: number | null;
  warmup: boolean;
}

export interface AgentClose {
  at: number;
  ch: number;
  remote: string;
}

export interface AgentStatus {
  at: number;
  req: string;
  code: number;
}

/**
 * One `s` line. Counters (gc, cpu, the tcp counters, bytes) are CUMULATIVE as written; gauges
 * (heap, netty, mem, states, `CurrEstab`) are as read. `cpu`, `mem` and `tcp` are null when the
 * line carries none (not Linux, or unreadable that second); `states` is `{}` likewise.
 */
export interface AgentSample {
  at: number;
  /** True only on the shutdown's closing sample, always the file's last. */
  final: boolean;
  gc: Record<string, [number, number]>;
  heap: [number, number, number];
  netty: [number, number] | null;
  /** The eight `/proc/stat` jiffy counters. */
  cpu: number[] | null;
  /** `[totalKb, availableKb]`. */
  mem: [number, number] | null;
  tcp: Record<string, number> | null;
  /** `remote → [out, in]`. */
  bytes: Record<string, [number, number]>;
  /** `remote → { kernel state code (a string, e.g. "6") → count }`. */
  states: Record<string, Record<string, number>>;
}

export interface AgentFile {
  header: AgentHeader;
  dns: AgentDns[];
  connects: AgentConnect[];
  tls: AgentTls[];
  closes: AgentClose[];
  statuses: AgentStatus[];
  samples: AgentSample[];
  /** The agent's one `error` line: it stopped collecting there. */
  error: { at: number; where: string; message: string } | null;
  /** The file reached the agent's size cap; later events were dropped. */
  capped: boolean;
  malformedLines: number;
}

/** The file is not an agent file this reader understands: no header, or another format. */
export class AgentFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentFileError';
  }
}

/** Thrown inside a line's decode to mark it malformed; never escapes this module. */
class Malformed extends Error {}

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function num(o: Obj, key: string): number {
  const v = o[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Malformed(key);
  return v;
}

function str(o: Obj, key: string): string {
  const v = o[key];
  if (typeof v !== 'string') throw new Malformed(key);
  return v;
}

function bool(o: Obj, key: string): boolean {
  const v = o[key];
  if (typeof v !== 'boolean') throw new Malformed(key);
  return v;
}

/** Absent reads as false (the agent writes the flag only when it is true). */
function flag(o: Obj, key: string): boolean {
  return o[key] === undefined ? false : bool(o, key);
}

/** A string or null; absent reads as null only where `absentIsNull`. */
function nullableStr(o: Obj, key: string, absentIsNull = false): string | null {
  const v = o[key];
  if (v === null || (absentIsNull && v === undefined)) return null;
  if (typeof v !== 'string') throw new Malformed(key);
  return v;
}

function tuple(v: unknown, length: number, key: string): number[] {
  if (!Array.isArray(v) || v.length !== length) throw new Malformed(key);
  for (const n of v) {
    if (typeof n !== 'number' || !Number.isFinite(n)) throw new Malformed(key);
  }
  return v as number[];
}

function pair(v: unknown, key: string): [number, number] {
  return tuple(v, 2, key) as [number, number];
}

function record<T>(v: unknown, key: string, each: (value: unknown) => T): Record<string, T> {
  if (!isObj(v)) throw new Malformed(key);
  // `fromEntries` defines own properties, so a key spelled "__proto__" stays a key rather than
  // replacing the object's prototype, as an assignment would.
  return Object.fromEntries(Object.entries(v).map(([k, value]) => [k, each(value)]));
}

function numberValue(key: string): (v: unknown) => number {
  return (v) => {
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new Malformed(key);
    return v;
  };
}

function decodeHeader(o: Obj): AgentHeader {
  const collects = o.collects;
  if (!isObj(collects)) throw new Malformed('collects');
  const reasonsIn = o.reasons;
  if (!isObj(reasonsIn)) throw new Malformed('reasons');
  const reasons: AgentHeader['reasons'] = {};
  if (reasonsIn.http !== undefined) reasons.http = str(reasonsIn, 'http');
  if (reasonsIn.machine !== undefined) reasons.machine = str(reasonsIn, 'machine');
  return {
    format: str(o, 'format'),
    agentVersion: str(o, 'agentVersion'),
    gatlingHttpClient: nullableStr(o, 'gatlingHttpClient'),
    gatlingHttp: nullableStr(o, 'gatlingHttp'),
    java: str(o, 'java'),
    os: str(o, 'os'),
    // `host` arrived after the format's first files shipped; one without it names no host.
    host: nullableStr(o, 'host', true),
    startedAt: num(o, 'startedAt'),
    collects: { http: bool(collects, 'http'), machine: bool(collects, 'machine') },
    reasons,
  };
}

function decodeSample(o: Obj): AgentSample {
  return {
    at: num(o, 'at'),
    final: flag(o, 'final'),
    gc: record(o.gc, 'gc', (v) => pair(v, 'gc')),
    heap: tuple(o.heap, 3, 'heap') as [number, number, number],
    // Always written — null until the instrumentation has seen a connect — so absent is malformed.
    netty: o.netty === null ? null : pair(o.netty, 'netty'),
    cpu: o.cpu === undefined ? null : tuple(o.cpu, 8, 'cpu'),
    mem: o.mem === undefined ? null : pair(o.mem, 'mem'),
    tcp: o.tcp === undefined ? null : record(o.tcp, 'tcp', numberValue('tcp')),
    bytes: record(o.bytes, 'bytes', (v) => pair(v, 'bytes')),
    states:
      o.states === undefined
        ? {}
        : record(o.states, 'states', (v) => record(v, 'states', numberValue('states'))),
  };
}

export function decodeAgentFile(bytes: Uint8Array): AgentFile {
  const lines = new TextDecoder('utf-8', { fatal: false }).decode(bytes).split('\n');

  let index = 0;
  let headerLine: string | undefined;
  while (index < lines.length) {
    const line = trimCr(lines[index++] ?? '');
    if (line !== '') {
      headerLine = line;
      break;
    }
  }
  if (headerLine === undefined) throw new AgentFileError('The agent file is empty: it has no header line.');
  const header = parseHeader(headerLine);

  const file: AgentFile = {
    header,
    dns: [],
    connects: [],
    tls: [],
    closes: [],
    statuses: [],
    samples: [],
    error: null,
    capped: false,
    malformedLines: 0,
  };

  for (; index < lines.length; index++) {
    const line = trimCr(lines[index] ?? '');
    if (line === '') continue;
    let o: unknown;
    try {
      o = JSON.parse(line);
    } catch {
      file.malformedLines++;
      continue;
    }
    if (!isObj(o) || typeof o.t !== 'string') {
      file.malformedLines++;
      continue;
    }
    try {
      decodeLine(o, o.t, file);
    } catch (e) {
      if (!(e instanceof Malformed)) throw e;
      file.malformedLines++;
    }
  }
  return file;
}

function trimCr(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

function parseHeader(line: string): AgentHeader {
  let o: unknown;
  try {
    o = JSON.parse(line);
  } catch {
    throw new AgentFileError('The agent file does not start with a header line: its first line is not JSON.');
  }
  if (!isObj(o) || o.t !== 'header') {
    throw new AgentFileError('The agent file does not start with a header line.');
  }
  if (o.format !== AGENT_FILE_FORMAT) {
    throw new AgentFileError(
      `The agent file is format ${JSON.stringify(o.format)}; this reader understands ${AGENT_FILE_FORMAT}.`,
    );
  }
  try {
    return decodeHeader(o);
  } catch (e) {
    if (!(e instanceof Malformed)) throw e;
    throw new AgentFileError(`The agent file's header has no valid "${e.message}".`);
  }
}

function decodeLine(o: Obj, t: string, file: AgentFile): void {
  switch (t) {
    case 'dns':
      file.dns.push({
        at: num(o, 'at'),
        us: num(o, 'us'),
        host: str(o, 'host'),
        ok: bool(o, 'ok'),
        warmup: flag(o, 'warmup'),
      });
      return;
    case 'connect':
      file.connects.push({
        at: num(o, 'at'),
        us: num(o, 'us'),
        remote: str(o, 'remote'),
        ok: bool(o, 'ok'),
        ch: num(o, 'ch'),
        warmup: flag(o, 'warmup'),
      });
      return;
    case 'tls':
      file.tls.push({
        at: num(o, 'at'),
        us: num(o, 'us'),
        remote: str(o, 'remote'),
        ok: bool(o, 'ok'),
        ch: o.ch === undefined ? null : num(o, 'ch'),
        warmup: flag(o, 'warmup'),
      });
      return;
    case 'close':
      file.closes.push({ at: num(o, 'at'), ch: num(o, 'ch'), remote: str(o, 'remote') });
      return;
    case 'status':
      file.statuses.push({ at: num(o, 'at'), req: str(o, 'req'), code: num(o, 'code') });
      return;
    case 's':
      file.samples.push(decodeSample(o));
      return;
    case 'error':
      file.error = { at: num(o, 'at'), where: str(o, 'where'), message: str(o, 'message') };
      return;
    case 'capped':
      num(o, 'at');
      file.capped = true;
      return;
    default:
      // An unknown record type: a later agent's, skipped and not counted.
      return;
  }
}
