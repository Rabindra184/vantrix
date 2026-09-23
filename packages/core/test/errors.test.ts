import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ingestError } from '../src/errors.js';

describe('ingestError', () => {
  it('carries code, message, remediation and detail', () => {
    const e = ingestError('ENDPOINT_CARDINALITY_EXCEEDED', {
      message: 'Run contains 4812 distinct request names, exceeding the limit of 2000.',
      remediation: 'Request names appear to contain dynamic values. Parameterize them.',
      detail: { found: 4812, limit: 2000 },
    });
    expect(e.code).toBe('ENDPOINT_CARDINALITY_EXCEEDED');
    expect(e.remediation.length).toBeGreaterThan(0);
    expect(e.detail).toEqual({ found: 4812, limit: 2000 });
    expect(e).toBeInstanceOf(Error);
  });

  it('does not compile when remediation is omitted', () => {
    // @ts-expect-error - remediation is required; omitting it must be a type error.
    const e = ingestError('NO_REQUESTS', { message: 'no requests parsed' });
    expect(e.code).toBe('NO_REQUESTS');
  });
});

/**
 * NO REMEDIATION MAY SEND A READER TO A SURFACE THAT DOES NOT EXIST.
 *
 * Four of them said "…or raise the limit in project settings". There is no
 * project-settings surface anywhere: every `settings` reference in the API is
 * a READ, `ProjectRepository` has no update/set/write method for them, and
 * `ProjectShell` offers Tests, Runs, Add results, SLA rules and API tokens
 * and nothing else. The only way to change one is direct SQL against the
 * `project.settings` JSONB column — so an operator who hit a cap was told to
 * do something the product gives them no way to do.
 *
 * That is the "remediation that can never work" class this repo already
 * records twice: a 500 whose advice was "retry" when the stored buckets
 * overflow on every retry, and a windowed refusal whose remediation named the
 * wrong limit. The fix each time is the same — name the lever that exists.
 *
 * AND THE PRODUCT ALREADY KNEW THE FORM. The per-chunk 413 reads "Split the
 * run into smaller chunks, or raise MAX_STREAM_CHUNK_BYTES", naming a real
 * environment variable. Two of the four now do the same; the other two are
 * project-only keys with no env var (`maxEndpoints`, `indicators.higherMs`)
 * and say so rather than implying a page.
 *
 * DELETE THIS GUARD THE DAY A SETTINGS SURFACE SHIPS — the phrase is only
 * misleading while there is nowhere to go. It is banned because it names a
 * DESTINATION, not because settings are unmentionable.
 */
describe('remediations name a lever that exists', () => {
  const ROOT = fileURLToPath(new URL('../../..', import.meta.url));

  const sources = (): string[] => {
    const out: string[] = [];
    const walk = (dir: string): void => {
      // `readdirSync`'s overloads make an explicit annotation resolve to the
      // Buffer form, which typechecks as `NonSharedBuffer` names and compares
      // against nothing — green under vitest, red under `tsc`. Inferred.
      const entries = (() => {
        try {
          return readdirSync(dir, { withFileTypes: true });
        } catch {
          return [];
        }
      })();
      for (const e of entries) {
        if (e.name === 'node_modules' || e.name === 'dist' || e.name === 'test') continue;
        const full = join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name.endsWith('.ts')) out.push(full);
      }
    };
    for (const area of ['apps', 'packages']) walk(join(ROOT, area));
    return out;
  };

  it('never sends the reader to "project settings", which has no editing surface', () => {
    const files = sources();
    // A collector that found nothing would make the assertion below vacuous —
    // the failure `tokens.test.ts` records for a guard whose collector took
    // the wrong extension.
    expect(files.length, 'no production sources collected').toBeGreaterThan(50);

    const offenders: string[] = [];
    let remediations = 0;
    for (const f of files) {
      // Comments STRIPPED: this very guard's own docstring quotes the banned
      // phrase, and so does the note left at each corrected call site.
      const src = readFileSync(f, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '');
      for (const m of src.matchAll(/remediation:\s*((?:'[^']*'|"[^"]*"|`[^`]*`)(?:\s*\+\s*(?:'[^']*'|"[^"]*"|`[^`]*`))*)/g)) {
        remediations += 1;
        if (/in project settings/i.test(m[1]!)) offenders.push(f.slice(ROOT.length));
      }
    }

    // Vacuity the other way: a regex that matched no remediation at all would
    // also report zero offenders.
    expect(remediations, 'no remediation strings found — has the shape changed?').toBeGreaterThan(5);
    expect(
      [...new Set(offenders)].sort(),
      'remediations pointing at a project-settings surface that does not exist',
    ).toEqual([]);
  });
});
