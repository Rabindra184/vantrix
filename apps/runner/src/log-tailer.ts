import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { JobLogger } from './job-logger.js';

export class SimulationLogTailer {
  readonly #resultsDir: string;
  readonly #onBytes: (fileOffset: number, bytes: Buffer) => Promise<void>;
  readonly #pollMs: number;
  readonly #logger?: JobLogger;
  #timer: NodeJS.Timeout | null = null;
  #file: string | null = null;
  #offset = 0;
  /**
   * Every read, in the order it was asked for. See `flush`.
   */
  #queue: Promise<void> = Promise.resolve();
  #failure: unknown = null;

  constructor(opts: {
    resultsDir: string;
    pollMs: number;
    onBytes: (fileOffset: number, bytes: Buffer) => Promise<void>;
    logger?: JobLogger;
  }) {
    this.#resultsDir = opts.resultsDir;
    this.#pollMs = opts.pollMs;
    this.#onBytes = opts.onBytes;
    this.#logger = opts.logger;
  }

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => {
      void this.flush().catch((err) => this.#rememberFailure(err));
    }, this.#pollMs);
    void this.flush().catch((err) => this.#rememberFailure(err));
  }

  async stop(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    await this.flush();
    if (this.#failure) throw this.#failure;
  }

  /**
   * ═══ ONE READ AT A TIME, IN ORDER ═══
   *
   * This held a single "the read in flight" slot: a caller that found one
   * waited for it and then started its own. TWO callers waiting on the same
   * read both woke when it finished and both started one, concurrently, from
   * the one shared cursor. Each read the same bytes and each advanced the
   * cursor, so the sink was handed a chunk twice (LIVE_STREAM_REJECTED), and
   * the cursor then sat past the bytes actually sent (SIMULATION_LOG_GAP).
   *
   * It needs only a read slower than two poll intervals, or `stop()` arriving
   * behind a poll that is already waiting, which is how every run with a
   * backlog ends.
   *
   * A chain instead: each call's read starts when the one before it has
   * settled, whatever number of callers are waiting. A later read usually
   * finds nothing new and returns at once. The failure is checked again when
   * a queued call's turn comes, so nothing is read after a read has failed.
   */
  async flush(): Promise<void> {
    if (this.#failure) throw this.#failure;
    const turn = this.#queue.then(async () => {
      if (this.#failure) throw this.#failure;
      try {
        await this.#readAvailable();
      } catch (err) {
        // Remembered HERE, not only by start()'s catch: the turn queued behind
        // this one runs before any caller's handler does.
        this.#rememberFailure(err);
        throw err;
      }
    });
    // The chain itself never rejects: a failed read must not poison the turn
    // behind it with an unhandled rejection. Each caller gets its own result.
    this.#queue = turn.catch(() => undefined);
    await turn;
  }

  #rememberFailure(err: unknown): void {
    if (this.#failure) return;
    this.#failure = err;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    this.#logger?.error(`simulation.log tail failed: ${String(err)}`);
  }

  async #readAvailable(): Promise<void> {
    this.#file ??= await findSimulationLog(this.#resultsDir);
    if (!this.#file) return;

    const info = await stat(this.#file).catch(() => null);
    if (!info?.isFile()) {
      this.#file = null;
      this.#offset = 0;
      return;
    }
    if (info.size < this.#offset) this.#offset = 0;
    if (info.size === this.#offset) return;
    let fileOffset = this.#offset;

    const stream = createReadStream(this.#file, {
      start: this.#offset,
      end: info.size - 1,
      highWaterMark: 64 * 1024,
    });
    for await (const chunk of stream) {
      const bytes = Buffer.from(chunk as Buffer);
      await this.#onBytes(fileOffset, bytes);
      this.#offset += bytes.length;
      fileOffset += bytes.length;
    }
  }
}

async function findSimulationLog(root: string): Promise<string | null> {
  const candidates = await findFiles(root, 'simulation.log', 4);
  if (candidates.length === 0) return null;
  let newest = candidates[0]!;
  let newestMtime = 0;
  for (const candidate of candidates) {
    const info = await stat(candidate).catch(() => null);
    const mtime = info?.mtimeMs ?? 0;
    if (mtime >= newestMtime) {
      newest = candidate;
      newestMtime = mtime;
    }
  }
  return newest;
}

async function findFiles(dir: string, basename: string, depth: number): Promise<string[]> {
  if (depth < 0) return [];
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const out: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && entry.name === basename) out.push(full);
    if (entry.isDirectory()) out.push(...(await findFiles(full, basename, depth - 1)));
  }
  return out;
}
