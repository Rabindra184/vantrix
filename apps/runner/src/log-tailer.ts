import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

export class SimulationLogTailer {
  readonly #resultsDir: string;
  readonly #onBytes: (bytes: Buffer) => Promise<void>;
  readonly #pollMs: number;
  #timer: NodeJS.Timeout | null = null;
  #file: string | null = null;
  #offset = 0;
  #reading: Promise<void> | null = null;

  constructor(opts: {
    resultsDir: string;
    pollMs: number;
    onBytes: (bytes: Buffer) => Promise<void>;
  }) {
    this.#resultsDir = opts.resultsDir;
    this.#pollMs = opts.pollMs;
    this.#onBytes = opts.onBytes;
  }

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => {
      void this.flush().catch((err) => console.error('simulation.log tail failed', err));
    }, this.#pollMs);
    void this.flush().catch((err) => console.error('simulation.log initial tail failed', err));
  }

  async stop(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    await this.flush();
  }

  async flush(): Promise<void> {
    if (this.#reading) {
      await this.#reading;
      return;
    }

    this.#reading = this.#readAvailable();
    try {
      await this.#reading;
    } finally {
      this.#reading = null;
    }
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

    const stream = createReadStream(this.#file, {
      start: this.#offset,
      end: info.size - 1,
      highWaterMark: 64 * 1024,
    });
    for await (const chunk of stream) {
      const bytes = Buffer.from(chunk as Buffer);
      await this.#onBytes(bytes);
      this.#offset += bytes.length;
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
