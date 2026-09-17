import { describe, expect, it } from 'vitest';
import { MAX_BUNDLE_BYTES, bundleProblem, formatBytes } from '../src/api/uploadBundle';

/**
 * `bundleProblem` is the VALIDATION half of review 09-13 M05 — "a real file
 * picker with accepted formats, validation, progress, and processing state".
 *
 * It is a pure function over `{name, size}` for exactly this reason: the rule it
 * encodes is worth asserting per branch, and a component test would have to
 * build a `File`, mount a picker and read a rendered string to ask the same
 * question once. The browser half is `project-tests.spec.ts`, which drives the
 * real control against the real route — what THAT cannot cheaply do is
 * enumerate the ways a file can be wrong.
 */
describe('bundleProblem', () => {
  const ok = { name: 'results.tgz', size: 1024 };

  it('accepts both spellings of a gzipped tar', () => {
    expect(bundleProblem({ name: 'results.tgz', size: 1024 })).toBeNull();
    expect(bundleProblem({ name: 'results.tar.gz', size: 1024 })).toBeNull();
  });

  it('accepts them in any case', () => {
    // A file that came off a Windows share, or out of an archiver that shouts.
    // Refusing `RESULTS.TGZ` would be a rule about the keyboard rather than
    // about the format.
    expect(bundleProblem({ name: 'RESULTS.TGZ', size: 1024 })).toBeNull();
    expect(bundleProblem({ name: 'Results.Tar.Gz', size: 1024 })).toBeNull();
  });

  it('refuses another archive format, and says how to make the right one', () => {
    // The remediation is the point. "Unsupported file type" leaves a reader
    // holding a zip of the same directory with nothing to do about it.
    const problem = bundleProblem({ name: 'results.zip', size: 1024 });
    expect(problem).toContain('not a .tgz or .tar.gz');
    expect(problem).toContain('tar -czf');
  });

  it('refuses a bare .gz, which is not a tar at all', () => {
    // `simulation.log.gz` is a plausible mistake: it IS gzipped, and it is one
    // file rather than the results DIRECTORY the bundle reader unpacks.
    expect(bundleProblem({ name: 'simulation.log.gz', size: 1024 })).toContain('not a .tgz');
  });

  it('names an empty file as its own mistake', () => {
    // Usually a `tar` that failed and still produced a file. Reporting "not a
    // gzipped tar" about zero bytes sends the reader to check the format, which
    // is the one thing that is not wrong.
    expect(bundleProblem({ name: 'results.tgz', size: 0 })).toBe('results.tgz is empty.');
  });

  it('reports the FORMAT of an empty file with the wrong extension', () => {
    // Order, asserted deliberately: both rules match, and the format is the one
    // worth saying, because re-running `tar` correctly fixes both. The reverse
    // order would tell somebody to check their zip is non-empty.
    expect(bundleProblem({ name: 'results.zip', size: 0 })).toContain('not a .tgz');
  });

  it('refuses a file over the ceiling, naming both sizes', () => {
    // Both numbers, because "too large" without the limit leaves the reader
    // guessing how much to split.
    const problem = bundleProblem({ name: 'huge.tgz', size: MAX_BUNDLE_BYTES + 1 });
    expect(problem).toContain('512 MB');
    expect(problem).toContain(formatBytes(MAX_BUNDLE_BYTES + 1));
  });

  it('allows a file exactly at the ceiling', () => {
    // The server's own check is `> MAX_BUNDLE_BYTES`, and a local rule that
    // refused what the server accepts would be a limit nobody configured.
    expect(bundleProblem({ name: 'exact.tgz', size: MAX_BUNDLE_BYTES })).toBeNull();
  });

  it('is a pure read of name and size', () => {
    // No DOM, no `File`, no server. This is what lets every branch above be one
    // cheap assertion instead of a mounted component.
    expect(bundleProblem(ok)).toBeNull();
  });
});

describe('formatBytes', () => {
  it('keeps bytes as bytes below a kilobyte', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1023)).toBe('1023 B');
  });

  it('climbs one unit at a time', () => {
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB');
    expect(formatBytes(1024 * 1024 * 1024)).toBe('1.0 GB');
  });

  it('drops the decimal once the number is big enough not to need it', () => {
    // A tenth of a megabyte matters at 1.5 MB and is noise at 512 MB, where the
    // digit it adds is the one nobody reads.
    expect(formatBytes(MAX_BUNDLE_BYTES)).toBe('512 MB');
    expect(formatBytes(1536)).toBe('1.5 KB');
  });

  it('stops at GB rather than inventing a unit', () => {
    // The ceiling is 512 MB, so anything past GB can only come from a number
    // this product never stores — and a unit table that ran out would render
    // `undefined`.
    expect(formatBytes(5 * 1024 * 1024 * 1024)).toBe('5.0 GB');
  });
});
