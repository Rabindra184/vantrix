import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import type { Writable } from 'node:stream';

export interface ProcessCommand {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

export interface ProcessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stopped: boolean;
}

export function pipeWithPrefix(stream: NodeJS.ReadableStream, output: Writable, prefix: string): void {
  let pending = '';
  stream.on('data', (chunk: Buffer) => {
    pending += chunk.toString('utf8');
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? '';
    for (const line of lines) output.write(`${prefix}${line}\n`);
  });
  stream.on('end', () => {
    if (pending) output.write(`${prefix}${pending}\n`);
  });
}

function writeAll(outputs: readonly Writable[], line: string): void {
  for (const output of outputs) output.write(line);
}

export function spawnAndWait(
  command: ProcessCommand,
  opts: {
    stdoutPrefix?: string;
    stderrPrefix?: string;
    logOutput?: Writable;
    stopPollMs?: number;
    shouldStop?: () => Promise<boolean>;
  } = {},
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    let child: ChildProcessByStdio<null, Readable, Readable>;
    let stopTimer: NodeJS.Timeout | null = null;
    let stopCheckRunning = false;
    let stopped = false;
    try {
      child = spawn(command.command, command.args, {
        cwd: command.cwd,
        env: command.env ?? process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      reject(err);
      return;
    }

    const stdoutOutputs = opts.logOutput ? [process.stdout, opts.logOutput] : [process.stdout];
    const stderrOutputs = opts.logOutput ? [process.stderr, opts.logOutput] : [process.stderr];
    pipeWithPrefixToMany(child.stdout, stdoutOutputs, opts.stdoutPrefix ?? '');
    pipeWithPrefixToMany(child.stderr, stderrOutputs, opts.stderrPrefix ?? '');

    child.on('error', reject);
    if (opts.shouldStop) {
      stopTimer = setInterval(() => {
        if (stopCheckRunning) return;
        stopCheckRunning = true;
        void opts.shouldStop!()
          .then((shouldStop) => {
            if (!shouldStop || child.killed) return;
            stopped = true;
            child.kill('SIGTERM');
            setTimeout(() => {
              if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
            }, 5000).unref();
          })
          .catch((err) => console.error('process stop check failed', err))
          .finally(() => {
            stopCheckRunning = false;
          });
      }, opts.stopPollMs ?? 1000);
    }

    child.on('close', (code, signal) => {
      if (stopTimer) clearInterval(stopTimer);
      resolve({ code, signal, stopped });
    });
  });
}

function pipeWithPrefixToMany(stream: NodeJS.ReadableStream, outputs: readonly Writable[], prefix: string): void {
  let pending = '';
  stream.on('data', (chunk: Buffer) => {
    pending += chunk.toString('utf8');
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? '';
    for (const line of lines) writeAll(outputs, `${prefix}${line}\n`);
  });
  stream.on('end', () => {
    if (pending) writeAll(outputs, `${prefix}${pending}\n`);
  });
}
