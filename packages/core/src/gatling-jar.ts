import { inflateRaw } from 'node:zlib';
import { promisify } from 'node:util';

const inflateRawAsync = promisify(inflateRaw);

/**
 * Reads exactly `length` bytes at `position`, or throws.
 *
 * ═══ WHY A CALLBACK AND NOT A PATH ═══
 *
 * This package is pure — `eslint.config.js` forbids it the filesystem — and
 * that constraint improves the design rather than merely constraining it: what
 * follows is zip decoding, which has nothing to do with where the bytes live.
 * `@perfportal/storage` supplies the file-backed reader; a test can supply a
 * Buffer.
 *
 * RANDOM ACCESS, not a whole Buffer, because a runner artifact may be hundreds
 * of megabytes and answering these two questions touches a few hundred KB of
 * it — the central directory and one manifest entry.
 */
export type ReadAt = (position: number, length: number) => Promise<Buffer>;

/**
 * What a `.jar` says about itself, read straight out of the archive.
 *
 * ═══ WHY THIS EXISTS AT ALL ═══
 *
 * `./gradlew gatlingEnterprisePackage` — the command Gatling's own docs give
 * you — produces a THIN jar: your simulations and your dependencies, and NOT
 * one byte of the Gatling framework. Gatling Enterprise supplies the runtime
 * at execution time, so the package never needs to carry it.
 *
 * The on-prem runner used to run `java -cp <uploaded.jar> io.gatling.app.Gatling`,
 * which can only work if the jar carries the whole framework. Upload the
 * artifact Gatling's own tooling builds and the JVM cannot even find its main
 * class:
 *
 *     Error: Could not find or load main class io.gatling.app.Gatling
 *
 * So the runner has to know which kind of jar it was handed before it can
 * build a classpath — see `carriesRuntime`.
 *
 * ═══ AND WHY IT PARSES ZIP BY HAND ═══
 *
 * A jar is a zip. The bundle path already shells out to `unzip`/`zipinfo`, and
 * that would have worked here too — but this module is consumed by the API as
 * well as the runner, on the request path of an upload, and spawning a process
 * per upload to read one 400-byte file is the wrong shape. Reading the central
 * directory directly is about ninety lines, needs no dependency, and touches
 * only the handful of bytes it actually wants rather than inflating a 50 MB
 * archive to answer two questions.
 */
export interface GatlingJarFacts {
  /**
   * Does this jar carry the Gatling framework itself?
   *
   * True for a shadow/fat jar (which runs standalone, as it always has), false
   * for the thin package `gatlingEnterprisePackage` produces (which needs a
   * runtime lent to it). Decided by the presence of `io.gatling.app.Gatling` —
   * the very class the launcher command names, so this asks exactly the
   * question the JVM is about to ask.
   */
  readonly carriesRuntime: boolean;
  /**
   * `Gatling-Version` from the manifest — the framework version the jar was
   * PACKAGED against, which is what a lent runtime has to match. Null when the
   * jar was not built by a Gatling packager (a hand-rolled shadow jar, say),
   * in which case nothing can be checked and nothing should be.
   *
   * Distinct from `Gatling-Packager-Version`, which is the plugin's own
   * version (`3.15.1.2` for framework `3.15.1`) and would never match a
   * runtime.
   */
  readonly gatlingVersion: string | null;
  /**
   * `Gatling-Simulations`, split — every simulation class the packager found.
   * Empty when the manifest declares none, which is not the same as "this jar
   * has no simulations": only a Gatling packager writes this header.
   */
  readonly simulations: readonly string[];
}

/** A jar that could not be read as a zip at all. */
export class GatlingJarReadError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'GatlingJarReadError';
  }
}

const GATLING_MAIN_CLASS_ENTRY = 'io/gatling/app/Gatling.class';
const MANIFEST_ENTRY = 'META-INF/MANIFEST.MF';

/** End of Central Directory, and the Zip64 records that supersede it. */
const EOCD_SIGNATURE = 0x06054b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;
const CENTRAL_ENTRY_SIGNATURE = 0x02014b50;
const EOCD_MIN_BYTES = 22;
/** The EOCD's comment field is a 16-bit length, so it can start no earlier. */
const EOCD_MAX_BYTES = EOCD_MIN_BYTES + 0xffff;
/** A Gatling manifest is a few hundred bytes; this is a sanity ceiling. */
const MAX_MANIFEST_BYTES = 1024 * 1024;

export async function parseGatlingJar(size: number, read: ReadAt): Promise<GatlingJarFacts> {
  const directory = await readCentralDirectory(read, size);

  const manifestEntry = directory.get(MANIFEST_ENTRY);
  const manifest = manifestEntry === undefined ? null : await readEntryText(read, manifestEntry);
  const headers = manifest === null ? new Map<string, string>() : parseManifest(manifest);

  const simulations = (headers.get('gatling-simulations') ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '');

  return {
    carriesRuntime: directory.has(GATLING_MAIN_CLASS_ENTRY),
    gatlingVersion: headers.get('gatling-version') ?? null,
    simulations,
  };
}

interface CentralEntry {
  readonly compressionMethod: number;
  readonly compressedSize: number;
  readonly localHeaderOffset: number;
}

/**
 * Every entry name in the archive, mapped to what is needed to read its bytes.
 *
 * Names only — no data is inflated here, so a 50 MB fat jar costs one read of
 * its central directory (a few hundred KB) rather than a full decompression.
 */
async function readCentralDirectory(
  read: ReadAt,
  size: number,
): Promise<Map<string, CentralEntry>> {
  const tailBytes = Math.min(size, EOCD_MAX_BYTES);
  const tail = await readExactly(read, size - tailBytes, tailBytes);

  let eocd = -1;
  for (let i = tail.length - EOCD_MIN_BYTES; i >= 0; i -= 1) {
    if (tail.readUInt32LE(i) === EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) {
    throw new GatlingJarReadError('No zip end-of-central-directory record; this is not a jar.');
  }

  let entryCount = tail.readUInt16LE(eocd + 10);
  let directoryOffset = tail.readUInt32LE(eocd + 16);
  let directorySize = tail.readUInt32LE(eocd + 12);

  // Zip64. A fat jar can hold well over 65,535 entries, at which point the
  // 16-bit count saturates and the real numbers live in a separate record —
  // so this is not a theoretical branch, it is the normal shape of a large
  // shadow jar.
  if (entryCount === 0xffff || directoryOffset === 0xffffffff || directorySize === 0xffffffff) {
    const locator = eocd - 20;
    if (locator < 0 || tail.readUInt32LE(locator) !== ZIP64_LOCATOR_SIGNATURE) {
      throw new GatlingJarReadError('Zip64 sizes reported with no Zip64 locator record.');
    }
    const zip64Offset = Number(tail.readBigUInt64LE(locator + 8));
    const zip64 = await readExactly(read, zip64Offset, 56);
    if (zip64.readUInt32LE(0) !== ZIP64_EOCD_SIGNATURE) {
      throw new GatlingJarReadError('Zip64 locator does not point at a Zip64 record.');
    }
    entryCount = Number(zip64.readBigUInt64LE(32));
    directorySize = Number(zip64.readBigUInt64LE(40));
    directoryOffset = Number(zip64.readBigUInt64LE(48));
  }

  const directory = await readExactly(read, directoryOffset, directorySize);
  const entries = new Map<string, CentralEntry>();
  let cursor = 0;
  for (let i = 0; i < entryCount; i += 1) {
    if (cursor + 46 > directory.length || directory.readUInt32LE(cursor) !== CENTRAL_ENTRY_SIGNATURE) {
      throw new GatlingJarReadError(`Central directory entry ${i} is malformed.`);
    }
    const nameLength = directory.readUInt16LE(cursor + 28);
    const extraLength = directory.readUInt16LE(cursor + 30);
    const commentLength = directory.readUInt16LE(cursor + 32);
    const name = directory.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    entries.set(name, {
      compressionMethod: directory.readUInt16LE(cursor + 10),
      compressedSize: directory.readUInt32LE(cursor + 20),
      localHeaderOffset: directory.readUInt32LE(cursor + 42),
    });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/**
 * One entry's bytes, as text.
 *
 * The LOCAL header is re-read rather than trusted from the central directory
 * because only it carries this entry's own name/extra lengths, which is what
 * locates the data — the two headers are allowed to differ in their extra
 * fields, and using the central one's lengths here would read from the wrong
 * offset on any archive where they do.
 */
async function readEntryText(read: ReadAt, entry: CentralEntry): Promise<string> {
  if (entry.compressedSize > MAX_MANIFEST_BYTES) {
    throw new GatlingJarReadError('Manifest is implausibly large; refusing to read it.');
  }
  const local = await readExactly(read, entry.localHeaderOffset, 30);
  const nameLength = local.readUInt16LE(26);
  const extraLength = local.readUInt16LE(28);
  const dataOffset = entry.localHeaderOffset + 30 + nameLength + extraLength;
  const raw = await readExactly(read, dataOffset, entry.compressedSize);

  if (entry.compressionMethod === 0) return raw.toString('utf8');
  if (entry.compressionMethod === 8) return (await inflateRawAsync(raw)).toString('utf8');
  throw new GatlingJarReadError(`Unsupported zip compression method ${entry.compressionMethod}.`);
}

async function readExactly(read: ReadAt, position: number, length: number): Promise<Buffer> {
  if (length === 0) return Buffer.alloc(0);
  const buffer = await read(position, length);
  if (buffer.length !== length) {
    throw new GatlingJarReadError(
      `Truncated jar: wanted ${length} bytes at ${position} but read ${buffer.length}.`,
    );
  }
  return buffer;
}

/**
 * A `MANIFEST.MF` as lower-cased header names to values.
 *
 * CONTINUATION LINES ARE THE WHOLE REASON THIS IS NOT `split(': ')`. The jar
 * manifest format wraps at 72 bytes and marks the continuation with a single
 * leading SPACE, so a project with several simulations — exactly the case this
 * is read for — has its `Gatling-Simulations` value split across lines, and a
 * naive parser silently truncates the list at the wrap. The joined value has
 * no separator: the space is the marker, not part of the text.
 */
function parseManifest(text: string): Map<string, string> {
  const headers = new Map<string, string>();
  let name: string | null = null;
  let value = '';

  const commit = () => {
    if (name !== null) headers.set(name, value);
    name = null;
    value = '';
  };

  for (const line of text.split(/\r\n|\r|\n/)) {
    if (line === '') {
      // A blank line ends the main section; per-entry sections follow and
      // must not overwrite it.
      commit();
      break;
    }
    if (line.startsWith(' ')) {
      if (name !== null) value += line.slice(1);
      continue;
    }
    commit();
    const separator = line.indexOf(':');
    if (separator === -1) continue;
    name = line.slice(0, separator).trim().toLowerCase();
    value = line.slice(separator + 1).trim();
  }
  commit();
  return headers;
}
