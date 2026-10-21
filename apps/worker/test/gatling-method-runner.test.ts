import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  createGatlingMethodRunner,
  gatlingMethodUnavailable,
  parseOutput,
  type GatlingMethodConfig,
  type SpawnImpl,
} from '../src/verify/gatling-method-runner.js';

/**
 * The tool is stood in for by a node script, run through an injected spawn:
 * these cases are about the PROCESS plumbing (streaming, exit codes, the
 * timeout, the contract check), and must not depend on a Java 21 being first
 * on this machine's PATH. The real tool is measured by
 * infra/test/gatling-method-fixtures.mjs.
 */
let dir: string;
let config: GatlingMethodConfig;

const STUBS = {
  // Counts each key's values in first-seen order and answers [n, n] for every
  // percentile it was asked for — so the answer proves every line arrived.
  echo: `
    const percentiles = process.argv[process.argv.indexOf('--percentiles') + 1].split(',');
    const counts = new Map();
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => { buf += d; });
    process.stdin.on('end', () => {
      for (const line of buf.split('\\n')) {
        if (line === '') continue;
        const key = line.slice(0, line.lastIndexOf('\\t'));
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      for (const [key, n] of counts) {
        const p = {};
        for (const label of percentiles) p[label] = [n, n];
        process.stdout.write(JSON.stringify({ key, n, p }) + '\\n');
      }
    });`,
  fail: `
    process.stdin.resume();
    process.stderr.write('bad input on line 1\\n');
    process.exit(2);`,
  sleep: `setTimeout(() => {}, 60_000);`,
  notJson: `
    process.stdin.resume();
    process.stdin.on('end', () => process.stdout.write('{"key":"k0","n":1,"p":{"50":[1,1],"75":[1,1],"95":[1,1],"99":[1,1]}}\\nnot json\\n'));`,
  // Valid JSON, wrong shape: one value where [low, high] belongs.
  shortRange: `
    process.stdin.resume();
    process.stdin.on('end', () => process.stdout.write('{"key":"k0","n":1,"p":{"50":[551],"75":[1,1],"95":[1,1],"99":[1,1]}}\\n'));`,
} as const;

type Stub = keyof typeof STUBS;

/** Stands `node <stub>` in for `java`, and remembers what it was asked to run and the child it started. */
function stubbed(stub: Stub): { spawnImpl: SpawnImpl; calls: { command: string; args: readonly string[] }[]; children: ChildProcessWithoutNullStreams[] } {
  const calls: { command: string; args: readonly string[] }[] = [];
  const children: ChildProcessWithoutNullStreams[] = [];
  const spawnImpl: SpawnImpl = (command, args, options) => {
    calls.push({ command, args });
    const child = spawn(process.execPath, [join(dir, `${stub}.cjs`), ...args], options);
    children.push(child);
    return child;
  };
  return { spawnImpl, calls, children };
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'gatling-method-'));
  for (const [name, source] of Object.entries(STUBS)) writeFileSync(join(dir, `${name}.cjs`), source);
  writeFileSync(join(dir, 'gatling-method.jar'), '');
  writeFileSync(join(dir, 't-digest-3.3.jar'), '');
  config = {
    gatlingMethodJar: join(dir, 'gatling-method.jar'),
    gatlingMethodTdigestJar: join(dir, 't-digest-3.3.jar'),
    gatlingMethodTimeoutMs: 30_000,
  };
});

describe('createGatlingMethodRunner', () => {
  /**
   * The chunks arrive as an ITERABLE that renders each one only when asked
   * (gatlingMethodLines is a generator): every chunk must reach the tool, not
   * just the first, and nothing may assume an array.
   */
  it('streams every chunk of an iterable to the tool and parses its JSON lines', async () => {
    // 5,000 keys of 20 values: 100,000 lines, far past a pipe's buffer, so the
    // writes have to wait on 'drain' rather than land in one go.
    let rendered = 0;
    function* chunks(): Generator<string> {
      for (let k = 0; k < 5000; k += 1) {
        rendered += 1;
        yield Array.from({ length: 20 }, (_, v) => `k${String(k)}\t${String(v)}\n`).join('');
      }
    }
    const { spawnImpl, calls } = stubbed('echo');

    const rows = await createGatlingMethodRunner(config, spawnImpl)!(chunks(), 16);

    expect(rendered).toBe(5000);

    expect(rows).toHaveLength(5000);
    expect(rows[0]).toEqual({ key: 'k0', n: 20, p: { 50: [20, 20], 75: [20, 20], 95: [20, 20], 99: [20, 20] } });
    expect(rows.every((r) => r.n === 20)).toBe(true);
    expect(rows[4999]!.key).toBe('k4999');
    // java, the two jars on the classpath, and both required flags.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe('java');
    expect(calls[0]!.args).toEqual([
      '-cp', expect.stringContaining('gatling-method.jar'), 'io.perfportal.gatlingmethod.GatlingMethod',
      '--seeds', '16', '--percentiles', '50,75,95,99',
    ]);
    expect(calls[0]!.args[1]).toContain('t-digest-3.3.jar');
  });

  it('rejects on a non-zero exit, quoting what the tool said', async () => {
    const { spawnImpl } = stubbed('fail');
    await expect(createGatlingMethodRunner(config, spawnImpl)!(['k0\t1\n'], 16)).rejects.toThrow(
      /exited with code 2: bad input on line 1/,
    );
  });

  it('kills and rejects on timeout', async () => {
    const { spawnImpl, children } = stubbed('sleep');
    const runner = createGatlingMethodRunner({ ...config, gatlingMethodTimeoutMs: 1000 }, spawnImpl)!;
    const started = Date.now();

    await expect(runner(['k0\t1\n'], 16)).rejects.toThrow(/did not finish within 1000 ms and was killed/);
    expect(Date.now() - started).toBeLessThan(10_000);

    const child = children[0]!;
    if (child.exitCode === null && child.signalCode === null) await new Promise((r) => child.once('close', r));
    expect(child.signalCode).toBe('SIGKILL');
  });

  it('rejects on a malformed line', async () => {
    const { spawnImpl } = stubbed('notJson');
    await expect(createGatlingMethodRunner(config, spawnImpl)!(['k0\t1\n'], 16)).rejects.toThrow(/not JSON: not json/);
  });

  /** A [551] where [low, high] belongs would read later as a range from 551 to undefined. */
  it('rejects a row whose percentile is not a [low, high] pair', async () => {
    const { spawnImpl } = stubbed('shortRange');
    await expect(createGatlingMethodRunner(config, spawnImpl)!(['k0\t1\n'], 16)).rejects.toThrow(
      /not the contract's \(no \[low, high\] for 50\)/,
    );
  });

  it('rejects when java cannot be started', async () => {
    const spawnImpl: SpawnImpl = (_command, args, options) =>
      spawn(join(dir, 'no-such-java'), [...args], options);
    await expect(createGatlingMethodRunner(config, spawnImpl)!(['k0\t1\n'], 16)).rejects.toThrow(/could not be started/);
  });

  it('null when the jar is missing', () => {
    const { spawnImpl, calls } = stubbed('echo');
    const noTool = { ...config, gatlingMethodJar: join(dir, 'absent.jar') };
    const noDigest = { ...config, gatlingMethodTdigestJar: join(dir, 'absent-t-digest.jar') };

    expect(createGatlingMethodRunner(noTool, spawnImpl)).toBeNull();
    expect(createGatlingMethodRunner(noDigest, spawnImpl)).toBeNull();
    expect(gatlingMethodUnavailable(noTool)).toBe(`no tool jar at ${join(dir, 'absent.jar')}`);
    expect(gatlingMethodUnavailable(noDigest)).toBe(`no t-digest jar at ${join(dir, 'absent-t-digest.jar')}`);
    // The positive beside the absence: both present, a runner.
    expect(createGatlingMethodRunner(config, spawnImpl)).not.toBeNull();
    expect(gatlingMethodUnavailable(config)).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

/**
 * A tool's last line may end without a newline (a stdout closed mid-flush, a
 * tool that never prints one): it is still a row, and it is still checked.
 */
describe('parseOutput', () => {
  it('reads a final line with no trailing newline', () => {
    const row = { key: 'k1', n: 2, p: { 50: [1, 1], 75: [1, 2], 95: [2, 2], 99: [2, 2] } };
    const first = { ...row, key: 'k0' };
    expect(parseOutput(`${JSON.stringify(first)}\n${JSON.stringify(row)}`)).toEqual([first, row]);
    expect(parseOutput(JSON.stringify(row))).toEqual([row]);
  });

  it('refuses a final line with no trailing newline that is not a contract row', () => {
    expect(() => parseOutput('{"key":"k0","n":1,"p":{"50":[1]}}')).toThrow(/not the contract's/);
  });
});

/** The contract check on its own, row by row. */
describe('the tool row contract', () => {
  const ROW = { key: 'k0', n: 3, p: { 50: [1, 1], 75: [1, 2], 95: [2, 3], 99: [3, 3] } };

  async function answerWith(row: unknown): Promise<unknown> {
    const source = `process.stdin.resume(); process.stdin.on('end', () => process.stdout.write(${JSON.stringify(
      JSON.stringify(row),
    )} + '\\n'));`;
    const file = join(dir, `row-${String(Math.random()).slice(2)}.cjs`);
    writeFileSync(file, source);
    const spawnImpl: SpawnImpl = (_c, args, options) => spawn(process.execPath, [file, ...args], options);
    return createGatlingMethodRunner(config, spawnImpl)!(['k0\t1\n'], 16);
  }

  it('accepts a contract row', async () => {
    expect(await answerWith(ROW)).toEqual([ROW]);
  });

  it.each([
    ['a missing percentile', { ...ROW, p: { 50: [1, 1], 75: [1, 1], 95: [1, 1] } }],
    ['a fractional bound', { ...ROW, p: { ...ROW.p, 95: [1.5, 2] } }],
    ['a negative bound', { ...ROW, p: { ...ROW.p, 50: [-1, 1] } }],
    ['a reversed range', { ...ROW, p: { ...ROW.p, 99: [4, 3] } }],
    ['a string bound', { ...ROW, p: { ...ROW.p, 75: ['1', 1] } }],
    ['three values', { ...ROW, p: { ...ROW.p, 75: [1, 1, 1] } }],
    ['no key', { n: 3, p: ROW.p }],
    ['a fractional count', { ...ROW, n: 2.5 }],
    ['an array', [ROW]],
  ])('refuses %s', async (_why, row) => {
    await expect(answerWith(row)).rejects.toThrow(/not the contract's/);
  });
});
