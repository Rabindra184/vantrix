import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

/**
 * ═══ AN ID IS `z.guid()`, BECAUSE POSTGRES DECIDES WHAT A UUID IS HERE ═══
 *
 * zod 4's `z.uuid()` — and `z.string().uuid()`, which became an alias for it —
 * checks the RFC 9562 version and variant nibbles, so `11111111-1111-1111-
 * 1111-111111111111` is refused. zod 3 accepted any 8-4-4-4-12 hex string,
 * and so does Postgres's `uuid` type, which is what every id in this product
 * is stored in. A strict check would refuse ids the database holds and the
 * API hands out; `z.guid()` is exactly the shape zod 3 checked.
 *
 * Comments are stripped first: this file and the schemas quote the strict
 * spelling while explaining why it is not used.
 */
const strip = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

const sources = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && /\.tsx?$/.test(e.name))
    .map((e) => `${e.parentPath}/${e.name}`);

describe('ids are checked with the shape Postgres accepts', () => {
  it('accepts an id the database would store and the strict form refuses', () => {
    const id = '11111111-1111-1111-1111-111111111111';
    expect(z.uuid().safeParse(id).success, 'zod has stopped being strict — this case proves nothing').toBe(false);
    expect(z.guid().safeParse(id).success).toBe(true);
  });

  it('uses no strict uuid check in the contracts or the API', () => {
    const files = [...sources(`${process.cwd()}/packages/contracts/src`), ...sources(`${process.cwd()}/apps/api/src`)];
    expect(files.length, 'collected no sources — the paths have rotted').toBeGreaterThan(20);

    let guids = 0;
    const offenders: string[] = [];
    for (const file of files) {
      const code = strip(readFileSync(file, 'utf8'));
      guids += (code.match(/z\.guid\(\)/g) ?? []).length;
      if (/\.uuid\(/.test(code)) offenders.push(file);
    }
    // Vacuity on the construct: there are dozens of ids; finding none means
    // the scan stopped reading code, not that the rule holds.
    expect(guids).toBeGreaterThan(20);
    expect(offenders).toEqual([]);
  });
});
