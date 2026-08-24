import { writeFile } from 'node:fs/promises';
import { crc32, deflateRawSync } from 'node:zlib';

export interface JarEntry {
  readonly name: string;
  readonly content?: string;
  /**
   * Store the entry uncompressed instead of deflating it. Real jars contain
   * both — `unzip -l` on any Gatling package shows stored directory entries
   * beside deflated classes — and the reader has to handle each.
   */
  readonly stored?: boolean;
}

/**
 * Writes a real, valid zip so tests exercise the reader against bytes rather
 * than a mock.
 *
 * ═══ WHY BUILD ONE INSTEAD OF COMMITTING A FIXTURE ═══
 *
 * The interesting inputs are things a committed jar cannot vary cheaply: a
 * manifest whose `Gatling-Simulations` value WRAPS across continuation lines
 * (the jar format wraps at 72 bytes, so any project with a few simulations
 * hits it), an entry that is stored rather than deflated, a jar with no
 * manifest at all. Generating them keeps each case's input visible in the case
 * itself.
 *
 * The reader was also checked by hand against four artifacts real tooling
 * produced — a `gatlingEnterprisePackage` output, `gatling-app-3.15.1.jar`,
 * and two plain jars — which is the half this cannot cover: agreement with
 * bytes nobody in this repo wrote.
 */
export async function writeJar(path: string, entries: readonly JarEntry[]): Promise<void> {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const raw = Buffer.from(entry.content ?? '', 'utf8');
    const stored = entry.stored === true || raw.length === 0;
    const body = stored ? raw : deflateRawSync(raw);
    const method = stored ? 0 : 8;
    const checksum = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + body.length;
  }

  const directory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(offset, 16);

  await writeFile(path, Buffer.concat([...locals, directory, eocd]));
}

/** The entry whose presence means "this jar carries the Gatling framework". */
export const GATLING_MAIN_CLASS = 'io/gatling/app/Gatling.class';

/**
 * A manifest in the shape a Gatling packager writes, with the 72-byte
 * continuation wrapping applied — which is what makes a multi-simulation
 * header a real parsing problem rather than a `split(':')`.
 */
export function gatlingManifest(fields: Record<string, string>): string {
  const lines = ['Manifest-Version: 1.0'];
  for (const [name, value] of Object.entries(fields)) {
    const full = `${name}: ${value}`;
    lines.push(full.slice(0, 72));
    for (let i = 72; i < full.length; i += 71) lines.push(` ${full.slice(i, i + 71)}`);
  }
  return `${lines.join('\r\n')}\r\n\r\n`;
}
