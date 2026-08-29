import { open, type FileHandle } from 'node:fs/promises';
import { GatlingJarReadError, parseGatlingJar, type GatlingJarFacts } from '@perfportal/core';

/**
 * What an uploaded `.jar` on local disk says about itself.
 *
 * ═══ WHY THE SPLIT ═══
 *
 * The zip decoding lives in `@perfportal/core`, which `eslint.config.js`
 * forbids the filesystem — so the parser takes a random-read callback and this
 * is the file-backed one. The division is the honest one anyway: nothing about
 * reading a central directory depends on where the bytes came from.
 *
 * The handle is closed on every path, including a malformed archive, because
 * this runs once per runner upload on the API's request path and a leaked
 * descriptor there accumulates for the life of the process.
 */
export async function readGatlingJar(path: string): Promise<GatlingJarFacts> {
  let handle: FileHandle;
  try {
    handle = await open(path, 'r');
  } catch (err) {
    throw new GatlingJarReadError(`Could not open ${path}.`, { cause: err });
  }
  try {
    const { size } = await handle.stat();
    return await parseGatlingJar(size, async (position, length) => {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      // A short read is the parser's to judge — it knows whether the bytes it
      // asked for were required — so this reports what it got rather than
      // throwing on its behalf.
      return bytesRead === length ? buffer : buffer.subarray(0, bytesRead);
    });
  } finally {
    await handle.close().catch(() => undefined);
  }
}
