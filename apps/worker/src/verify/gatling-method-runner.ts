import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { delimiter } from 'node:path';
import type { Writable } from 'node:stream';
import { GATLING_PERCENTILES, type GatlingMethodOutput } from '@perfportal/verify';
import type { WorkerConfig } from '../config.js';

/**
 * ═══ GATLING'S OWN METHOD, AS A PROCESS ═══
 *
 * Runs tools/gatling-method (see its README for the contract) over the stdin
 * chunks `gatlingMethodLines` renders from `gatlingMethodInput`, and hands
 * back its rows. The process lives here and not in packages/verify, which
 * stays pure. The chunks are an ITERABLE, written one at a time with
 * backpressure, so the input's text is never held whole.
 *
 * Every way the tool can let a caller down REJECTS — a non-zero exit, a spawn
 * that fails (no `java` on PATH), the timeout (the child is killed first), a
 * line that is not JSON, or a row whose shape is not the contract's. The verify
 * job treats any rejection as "the method did not run": it records no
 * differences and no replay count, and the verification's outcome is
 * untouched. A row that half-matched the contract must not be the one thing
 * that gets through: a `[551]` where `[low, high]` belongs would read later as
 * a Gatling range of 551 to undefined.
 */
export type GatlingMethodRunner = (chunks: Iterable<string>, seeds: number) => Promise<GatlingMethodOutput[]>;

/** `spawn`, narrowed to the one overload used here, so a test can stand a script in for java. */
export type SpawnImpl = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams;

export type GatlingMethodConfig = Pick<
  WorkerConfig,
  'gatlingMethodJar' | 'gatlingMethodTdigestJar' | 'gatlingMethodTimeoutMs'
>;

/** The tool's entry point (tools/gatling-method/src). */
const MAIN_CLASS = 'io.perfportal.gatlingmethod.GatlingMethod';

/** `java` from PATH: the image's JRE 21, as the runner's (apps/runner's JAVA_BIN default). */
const JAVA = 'java';

/** How much of the tool's stderr a rejection quotes. Its errors are one line; a JVM's are not. */
const STDERR_KEPT = 2000;

/**
 * Why the method cannot run here, or null when it can: the tool jar or
 * t-digest is not where the configuration says. Only files are checked; a
 * missing or too-old `java` shows up as a failed run, logged per verification.
 */
export function gatlingMethodUnavailable(config: GatlingMethodConfig): string | null {
  if (!existsSync(config.gatlingMethodJar)) return `no tool jar at ${config.gatlingMethodJar}`;
  if (!existsSync(config.gatlingMethodTdigestJar)) return `no t-digest jar at ${config.gatlingMethodTdigestJar}`;
  return null;
}

/** A runner, or null when either jar is missing (`gatlingMethodUnavailable` says which). */
export function createGatlingMethodRunner(
  config: GatlingMethodConfig,
  spawnImpl: SpawnImpl = spawn,
): GatlingMethodRunner | null {
  if (gatlingMethodUnavailable(config) !== null) return null;
  const classpath = [config.gatlingMethodJar, config.gatlingMethodTdigestJar].join(delimiter);
  return (chunks, seeds) =>
    runTool(
      spawnImpl,
      ['-cp', classpath, MAIN_CLASS, '--seeds', String(seeds), '--percentiles', GATLING_PERCENTILES.join(',')],
      chunks,
      config.gatlingMethodTimeoutMs,
    );
}

function runTool(
  spawnImpl: SpawnImpl,
  args: string[],
  chunks: Iterable<string>,
  timeoutMs: number,
): Promise<GatlingMethodOutput[]> {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(JAVA, args, {});
    const feeding = new AbortController();
    let settled = false;
    let stdout = '';
    let stderr = '';

    const settle = (err: Error | null, rows?: GatlingMethodOutput[]): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      feeding.abort();
      if (err !== null) reject(err);
      else resolve(rows ?? []);
    };

    // ARMED BEFORE ANYTHING IS WRITTEN: a tool that never reads its stdin must
    // still be killed, and a write waiting on 'drain' must not outlive it.
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      settle(new Error(`Gatling-method did not finish within ${String(timeoutMs)} ms and was killed.`));
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d: string) => {
      stdout += d;
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d: string) => {
      if (stderr.length < STDERR_KEPT) stderr += d;
    });
    // A tool that exits early closes the pipe under a write (EPIPE). Its exit
    // code says why; the write error says nothing more.
    child.stdin.on('error', () => undefined);
    // No `java` on PATH, or not executable.
    child.on('error', (err) => settle(new Error(`Gatling-method could not be started: ${err.message}`)));
    child.on('close', (code, signal) => {
      if (code !== 0) {
        const how = code === null ? `signal ${String(signal)}` : `code ${String(code)}`;
        const said = stderr.trim().slice(0, STDERR_KEPT);
        settle(new Error(`Gatling-method exited with ${how}${said ? `: ${said}` : ''}`));
        return;
      }
      try {
        settle(null, parseOutput(stdout));
      } catch (err) {
        settle(err instanceof Error ? err : new Error(String(err)));
      }
    });

    feed(child.stdin, chunks, feeding.signal).catch(() => undefined);
  });
}

/**
 * Writes each chunk with backpressure — the next is asked for only once the
 * last is written — then closes stdin so the tool answers. Each chunk is whole
 * lines ending in a newline (`gatlingMethodLines`' contract).
 */
async function feed(stdin: Writable, chunks: Iterable<string>, signal: AbortSignal): Promise<void> {
  for (const chunk of chunks) {
    if (signal.aborted) return;
    if (!stdin.write(chunk)) await once(stdin, 'drain', { signal });
  }
  stdin.end();
}

/** One row per non-blank line; any line that is not a contract row refuses the whole answer. */
export function parseOutput(stdout: string): GatlingMethodOutput[] {
  const rows: GatlingMethodOutput[] = [];
  for (const raw of stdout.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.trim() === '') continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error(`Gatling-method printed a line that is not JSON: ${line.slice(0, 200)}`);
    }
    rows.push(toRow(value, line));
  }
  return rows;
}

/**
 * The contract, checked: a string key, a whole non-negative count, and for
 * EVERY percentile the tool was asked for, `[low, high]` — two whole
 * non-negative milliseconds, low not above high. Only those labels are kept.
 */
function toRow(value: unknown, line: string): GatlingMethodOutput {
  const refuse = (why: string): Error =>
    new Error(`Gatling-method printed a row that is not the contract's (${why}): ${line.slice(0, 200)}`);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw refuse('not an object');
  const { key, n, p } = value as Record<string, unknown>;
  if (typeof key !== 'string') throw refuse('no key');
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) throw refuse('no whole count');
  if (typeof p !== 'object' || p === null || Array.isArray(p)) throw refuse('no percentiles');
  const ranges: Record<string, [number, number]> = {};
  for (const percentile of GATLING_PERCENTILES) {
    const label = String(percentile);
    const range = (p as Record<string, unknown>)[label];
    if (!Array.isArray(range) || range.length !== 2) throw refuse(`no [low, high] for ${label}`);
    const [low, high] = range as unknown[];
    if (!isWholeMs(low) || !isWholeMs(high)) throw refuse(`${label} is not two whole milliseconds`);
    if (low > high) throw refuse(`${label} runs from ${String(low)} down to ${String(high)}`);
    ranges[label] = [low, high];
  }
  return { key, n, p: ranges };
}

function isWholeMs(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}
