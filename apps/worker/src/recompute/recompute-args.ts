/**
 * The arguments `pnpm recompute` takes. Its own module, not the script's, so a
 * test can import it without running the script.
 */
export interface RecomputeArgs {
  projectSlug?: string;
  runId?: string;
}

export const RECOMPUTE_USAGE = [
  'Usage: pnpm recompute [--project <slug>] [--run <run id>]',
  '',
  'Recomputes, exactly, every finished run that still carries estimated statistics.',
  'It does not go through the queue. Running it beside the worker is safe: each run',
  'is recomputed under its own lock, and a run the worker holds is left to it (locked).',
  '',
  '  --project <slug>  only runs of projects with this slug -- in EVERY org on this',
  '                    install, since slugs are unique per org only',
  '  --run <run id>    only this run',
  '',
  'With neither, every run that needs it, across the whole install.',
].join('\n');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `bootstrap.ts`'s `parseArgs` shape: a flag at the end of the line, or one
 * followed by another flag, is refused rather than read as "not given" -- a
 * filter that silently vanished would widen the recompute to the whole
 * install, which is the one mistake this command cannot take back quickly.
 */
export function parseRecomputeArgs(argv: string[]): RecomputeArgs {
  const out: RecomputeArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg !== '--project' && arg !== '--run') {
      throw new Error(`Unknown argument "${arg}".`);
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(
        `${arg} requires a value` +
          (value === undefined
            ? ' (none was given -- it was the last argument).'
            : ` (got "${value}", which looks like another flag).`),
      );
    }
    i++;
    if (arg === '--project') {
      out.projectSlug = value;
    } else {
      // Checked here because the candidate query casts it to uuid, and a
      // Postgres cast error is a worse way to learn about a typo.
      if (!UUID.test(value)) throw new Error(`--run expects a run id (a uuid), got "${value}".`);
      out.runId = value;
    }
  }
  return out;
}

/**
 * One line per run the CLI touched: "<run id>: <outcome>". Not "Recomputed
 * <id> (checksum_mismatch)" -- a run that could not be recomputed was not
 * recomputed, and a line that says so first misreads in a scrolled terminal.
 */
export function recomputeLine(runId: string, outcome: string): string {
  return `${runId}: ${outcome}`;
}
