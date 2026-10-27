import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A SYMBOL A COMMENT NAMES IN BACKTICKS HAS TO EXIST.
 *
 * This repo keeps shipping cross-references to things it does not have. The
 * record, before this guard: a docstring citing a rollup builder class that
 * has never existed; a statistics hint naming a run-totals label the tiles had
 * just deleted; a setup page saying "Mint one under Access" for a page renamed
 * three branches earlier; five pointers at a theme-toggle component deleted in
 * the commit that wrote them. Every one was a `grep` away and nothing grepped.
 *
 * What it caught on the branch that added it, all live at the time:
 *
 *   ChartControls   a table mapping three shapes to three component names,
 *                   none of which the module exported
 *   ProjectShell    the 120-character project-name cap credited to a schema
 *                   that does not exist, and again in an e2e docstring
 *                   justifying a test
 *   rules.ts        a deferral saying the live SLA banner could not use
 *                   `describeSlaOutcome`, naming a schema that has never
 *                   existed as the reason -- in the docstring OF that
 *                   function, whose caller list includes that very banner
 *
 * ═══ THIS GUARD READS COMMENTS, WHICH INVERTS THE USUAL TRAP ═══
 *
 * Every other source-scanning guard here strips comments first, because prose
 * about a rule is not a violation of it. This one has the opposite subject, so
 * it extracts comments and ignores code entirely. The consequence is that a
 * dead name written in backticks ANYWHERE, including in this file, is a
 * finding -- which is why the names above are deliberately unbacktick'd.
 * Do not "tidy" them into backticks; that turns an explanation into a failure.
 *
 * ═══ THE SUFFIX FILTER IS SCOPE, NOT COVERAGE, AND IS AN HONEST LIMIT ═══
 *
 * Checking every capitalised backticked word reports built-ins (AbortSignal,
 * Promise), vendor SDK types (GetObjectCommand), SQL and Redis keywords, and
 * UI labels -- 102 of them, measured, which is a rule that ships as
 * decoration. So it checks only identifiers ending in one of this repo's own
 * naming suffixes, which is the set a reader would expect to find in this
 * tree. A suffix absent from the list buys less coverage; it never makes a
 * checked symbol pass. Add to it freely.
 */

const SUFFIXES = [
  'Schema', 'Builder', 'Repository', 'Service', 'Controller', 'Client', 'Store',
  'Engine', 'Owner', 'Page', 'Panel', 'Group', 'Control', 'Tailer', 'Sink',
  'Decoder', 'Notifier', 'Gateway', 'Sweeper', 'Guard', 'Middleware', 'Filter',
  'Shell', 'Band', 'Strip', 'Uploader', 'Plugin', 'Extension',
];

const NAMED = new RegExp('`([A-Z][A-Za-z0-9]*(?:' + SUFFIXES.join('|') + '))`', 'g');

/**
 * A name that is deliberately dead. Each one is a PAST-TENSE record of
 * something the product used to have -- the distinction this repo draws
 * between a record (keep) and a pointer (fix). The second case below asserts
 * every entry is still named somewhere, so this list cannot rot into names
 * that match nothing while the guard reports green.
 */
const EXEMPT = new Map<string, string>([
  [
    'ProjectConfigPage',
    'The three-tab page ProjectShell replaced. Both mentions are past tense, ' +
      'explaining what the shell does differently and why it no longer blocks ' +
      'the whole page on GET /v1/projects. Deleting the name would delete the ' +
      'comparison that makes the paragraph mean anything.',
  ],
]);

const ROOTS = ['apps', 'packages', 'clients'];
const SKIP = new Set(['node_modules', 'dist', 'build', 'coverage', '.gradle', '.git', 'bin']);
const EXTS = ['.ts', '.tsx', '.kt'];

function sources(dir: string, out: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (SKIP.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) sources(p, out);
    else if (EXTS.some((x) => e.name.endsWith(x)) && !e.name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

/** Block and line comments only -- see the docstring on why this inverts. */
function comments(src: string): string {
  const parts: string[] = [];
  for (const m of src.matchAll(/\/\*[\s\S]*?\*\//g)) parts.push(m[0]);
  for (const m of src.matchAll(/(^|[^:"'`\\])\/\/[^\n]*/g)) parts.push(m[0]);
  return parts.join('\n');
}

const FILES = ROOTS.flatMap((r) => sources(r));

/** Anything the tree really declares: TS, Kotlin, Prisma models, file names. */
function declared(): Set<string> {
  const out = new Set<string>();
  for (const f of FILES) {
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(
      /\b(?:class|interface|type|enum|const|function|object|val)\s+([A-Za-z_][A-Za-z0-9_]*)/g,
    )) {
      out.add(m[1]!);
    }
    out.add(f.split('/').pop()!.replace(/\.(tsx?|kt)$/, ''));
  }
  try {
    const prisma = readFileSync('packages/persistence/prisma/schema.prisma', 'utf8');
    for (const m of prisma.matchAll(/^model\s+([A-Za-z0-9_]+)/gm)) out.add(m[1]!);
  } catch {
    /* the assertion below reports a collector that found nothing */
  }
  return out;
}

describe('a symbol named in a comment resolves to one the tree declares', () => {
  it('names no repo-shaped symbol that does not exist', () => {
    const known = declared();

    // VACUITY, COUNTING THE CONSTRUCT RATHER THAN THE VERDICT. A collector
    // that matched nothing passes this guard perfectly, and a counter that
    // counted only RESOLVED names would read zero exactly when every name was
    // broken -- the inversion this repo has already shipped once.
    expect(FILES.length, 'collected no sources -- the walk has rotted').toBeGreaterThan(200);
    expect(known.size, 'collected no declarations -- the parse has rotted').toBeGreaterThan(500);

    const found: { symbol: string; file: string }[] = [];
    for (const f of FILES) {
      for (const m of comments(readFileSync(f, 'utf8')).matchAll(NAMED)) {
        found.push({ symbol: m[1]!, file: f });
      }
    }
    expect(
      found.length,
      'matched no backticked repo-shaped symbol at all -- the pattern has rotted',
    ).toBeGreaterThan(20);

    const dangling = [
      ...new Set(
        found
          .filter(({ symbol }) => !known.has(symbol) && !EXEMPT.has(symbol))
          .map(({ symbol, file }) => `${symbol} (${file})`),
      ),
    ].sort();

    expect(
      dangling,
      'a comment names these, and nothing in the tree declares them. Rename to ' +
        'the real symbol, or add to EXEMPT with the reason it is deliberately dead.',
    ).toEqual([]);
  });

  it('exempts nothing that no comment names any more', () => {
    const named = new Set<string>();
    for (const f of FILES) {
      for (const m of comments(readFileSync(f, 'utf8')).matchAll(NAMED)) named.add(m[1]!);
    }
    // An exemption for a name nobody writes is a line arguing with nothing.
    const stale = [...EXEMPT.keys()].filter((s) => !named.has(s)).sort();
    expect(stale, 'exempted but named nowhere -- delete these entries').toEqual([]);
  });
});
