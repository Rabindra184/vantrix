import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SimulationLogTailer } from '../src/log-tailer.js';

/**
 * ═══ THE TAILER'S CURSOR HAS ONE WRITER AT A TIME ═══
 *
 * A real file and a real read stream; only the sink is replaced, by one that
 * records what it was handed and can be held open. What the sink requires of
 * the tailer is that the chunks TILE the file: each starts where the last
 * ended, and together they are the file's bytes, once.
 */
let dir: string;
let log: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'runner-tailer-'));
  await mkdir(path.join(dir, 'sim-1'));
  log = path.join(dir, 'sim-1', 'simulation.log');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** A sink that records each chunk and holds the FIRST one until released. */
function heldSink() {
  const chunks: { offset: number; bytes: Buffer }[] = [];
  const hold = deferred();
  const arrived = deferred();
  const onBytes = async (offset: number, bytes: Buffer) => {
    chunks.push({ offset, bytes });
    if (chunks.length === 1) {
      arrived.resolve();
      await hold.promise;
    }
  };
  return { chunks, onBytes, release: hold.resolve, firstChunk: arrived.promise };
}

function expectTiles(chunks: readonly { offset: number; bytes: Buffer }[], file: Buffer): void {
  let next = 0;
  for (const chunk of chunks) {
    expect(chunk.offset, 'each chunk starts where the last one ended').toBe(next);
    next += chunk.bytes.length;
  }
  expect(Buffer.concat(chunks.map((c) => c.bytes)).equals(file), 'the chunks are the file, once').toBe(true);
}

describe('SimulationLogTailer', () => {
  it('hands the sink each byte once when two callers wait on the same read', async () => {
    await writeFile(log, Buffer.alloc(100, 'a'));
    const sink = heldSink();
    const tailer = new SimulationLogTailer({ resultsDir: dir, pollMs: 60_000, onBytes: sink.onBytes });

    const first = tailer.flush();
    await sink.firstChunk;                      // the first read is in flight, held by the sink
    await appendFile(log, Buffer.alloc(100, 'b'));
    const second = tailer.flush();              // two callers now wait on that one read:
    const third = tailer.flush();               // a poll that fell behind, and another
    sink.release();
    await Promise.all([first, second, third]);

    expectTiles(sink.chunks, await readFile(log));
    expect(sink.chunks.map((c) => c.offset)).toEqual([0, 100]);
  });

  // The ordinary end of a run with a backlog: a poll is already waiting on a
  // slow read when stop() asks for the final flush.
  it('hands the sink each byte once when stop() arrives behind a waiting poll', async () => {
    await writeFile(log, Buffer.alloc(100, 'a'));
    const sink = heldSink();
    const tailer = new SimulationLogTailer({ resultsDir: dir, pollMs: 60_000, onBytes: sink.onBytes });

    const first = tailer.flush();
    await sink.firstChunk;
    await appendFile(log, Buffer.alloc(50, 'b'));
    const poll = tailer.flush();
    const stopped = tailer.stop();
    sink.release();
    await Promise.all([first, poll, stopped]);

    expectTiles(sink.chunks, await readFile(log));
  });

  it('picks up what was written after the last read', async () => {
    await writeFile(log, 'one');
    const chunks: { offset: number; bytes: Buffer }[] = [];
    const tailer = new SimulationLogTailer({
      resultsDir: dir, pollMs: 60_000,
      onBytes: async (offset, bytes) => { chunks.push({ offset, bytes }); },
    });
    await tailer.flush();
    await appendFile(log, 'two');
    await tailer.flush();
    await tailer.flush();                       // nothing new: no chunk

    expect(chunks.map((c) => [c.offset, c.bytes.toString()])).toEqual([[0, 'one'], [3, 'two']]);
  });

  it('reads nothing more once a read has failed, and every caller is told why', async () => {
    await writeFile(log, Buffer.alloc(100, 'a'));
    const refused = new Error('LIVE_STREAM_REJECTED');
    const hold = deferred();
    const arrived = deferred();
    let calls = 0;
    const tailer = new SimulationLogTailer({
      resultsDir: dir, pollMs: 60_000,
      onBytes: async () => {
        calls += 1;
        arrived.resolve();
        await hold.promise;
        throw refused;
      },
    });

    const first = tailer.flush().catch((err: unknown) => err);
    await arrived.promise;
    // Queued behind the read that is about to fail, as start()'s poll is.
    const queued = tailer.flush().catch((err: unknown) => err);
    hold.resolve();

    expect(await first).toBe(refused);
    await expect(tailer.flush()).rejects.toBe(refused);
    expect(await queued).toBe(refused);
    expect(calls, 'the queued read did not go ahead').toBe(1);
  });
});
