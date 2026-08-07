import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGzip } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { pack } from 'tar-stream';
import { openTarGzBundle } from '../src/index.js';

function makeArchive(files: Record<string, Buffer | string>): Buffer {
  const dir = mkdtempSync(join(tmpdir(), 'bundle-'));
  const root = join(dir, 'results');
  mkdirSync(root, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const target = join(root, name);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, content);
  }
  const out = join(dir, 'bundle.tgz');
  // COPYFILE_DISABLE suppresses AppleDouble ._name sidecar entries that
  // bsdtar (macOS) emits for files carrying extended attributes — macOS
  // tags freshly-written files with com.apple.provenance immediately (it is
  // present as soon as writeFileSync returns, not added asynchronously), so
  // this reproduces deterministically, not as a race. bsdtar hides those
  // sidecar entries again on read, but a plain tar-stream reader does not,
  // so they would otherwise leak into the file listing.
  // The env var is a no-op under GNU tar, so it is safe on Linux CI too.
  execFileSync('tar', ['-czf', out, '-C', dir, 'results'], {
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  });
  return readFileSync(out);
}

/**
 * Builds a single-entry .tar.gz in-process, naming the entry directly rather
 * than relying on a CLI to rewrite the path. `tar --transform` (GNU) and
 * `tar -s` (bsdtar) are mutually incompatible flags for the same trick, so a
 * shell-built traversal archive passes on one platform's tar and fails on
 * the other. Building the tar stream with `tar-stream` sidesteps both.
 */
async function evilArchive(entryName: string): Promise<Buffer> {
  const p = pack();
  p.entry({ name: entryName }, 'x');
  p.finalize();
  const gz = createGzip();
  const chunks: Buffer[] = [];
  p.pipe(gz);
  for await (const c of gz) chunks.push(Buffer.from(c as Buffer));
  return Buffer.concat(chunks);
}

describe('openTarGzBundle', () => {
  it('lists entries with POSIX-relative paths', async () => {
    const src = await openTarGzBundle(makeArchive({ 'simulation.log': 'x', 'index.html': 'y' }));
    expect([...src.index.files].sort()).toEqual(['results/index.html', 'results/simulation.log']);
  });

  it('reads a whole file back byte-for-byte', async () => {
    const payload = Buffer.from([0, 1, 2, 250, 251, 252]);
    const src = await openTarGzBundle(makeArchive({ 'simulation.log': payload }));
    expect(Buffer.from(await src.read('results/simulation.log'))).toEqual(payload);
  });

  it('head returns only the requested prefix, never the whole file', async () => {
    const payload = Buffer.alloc(4096, 7);
    const src = await openTarGzBundle(makeArchive({ 'simulation.log': payload }));
    const head = await src.index.head('results/simulation.log', 16);
    expect(head).toHaveLength(16);
  });

  it('rejects a bundle that is not a gzip archive, with remediation', async () => {
    await expect(openTarGzBundle(Buffer.from('this is not a tarball'))).rejects.toMatchObject({
      code: 'BUNDLE_NOT_ARCHIVE',
      remediation: expect.stringMatching(/.+/),
    });
  });

  it('rejects an archive containing no files', async () => {
    await expect(openTarGzBundle(makeArchive({}))).rejects.toMatchObject({ code: 'BUNDLE_EMPTY' });
  });

  it('refuses a path traversal entry rather than writing outside the bundle', async () => {
    // tar entries named ../x must never be honoured; the reader is in-memory,
    // but a consumer resolving these against a temp dir would escape it.
    const archive = await evilArchive('../escape');
    await expect(openTarGzBundle(archive)).rejects.toMatchObject({
      code: 'BUNDLE_NOT_ARCHIVE',
    });
  });

  it('rejects a highly-compressible archive whose decompressed size exceeds the budget, without expanding it fully', async () => {
    // A run of zeros compresses to almost nothing (a decompression-bomb
    // shape), so the compressed size on the wire tells you nothing about the
    // memory cost of decompressing it. 5 MiB of zeros compresses to a few
    // hundred bytes but must still be rejected once a small decompressed
    // budget is configured, rather than being fully buffered in memory.
    const zeros = Buffer.alloc(5 * 1024 * 1024, 0);
    const archive = makeArchive({ 'simulation.log': zeros });
    expect(archive.length).toBeLessThan(64 * 1024);

    await expect(
      openTarGzBundle(archive, { maxTotalBytes: 1024 * 1024 }),
    ).rejects.toMatchObject({
      code: 'BUNDLE_TOO_LARGE',
      remediation: expect.stringMatching(/.+/),
    });
  });

  it('rejects a single entry that exceeds a per-entry cap even when the total budget is larger', async () => {
    const zeros = Buffer.alloc(2 * 1024 * 1024, 0);
    const archive = makeArchive({ 'simulation.log': zeros });

    await expect(
      openTarGzBundle(archive, { maxTotalBytes: 8 * 1024 * 1024, maxEntryBytes: 1024 * 1024 }),
    ).rejects.toMatchObject({
      code: 'BUNDLE_TOO_LARGE',
      remediation: expect.stringMatching(/.+/),
    });
  });
});
