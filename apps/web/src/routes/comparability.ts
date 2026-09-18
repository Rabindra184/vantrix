import type { TrendRun } from '@perfportal/contracts';

/**
 * Whether the selected runs are actually comparable, and where they are not.
 *
 * ═══ A COHORT IS NOT A CONTROLLED EXPERIMENT ═══
 *
 * `TRENDS_SQL` groups completed runs by (project, test). That establishes they
 * exercised the same simulation and NOTHING about the conditions: the same
 * test runs against staging and production, off different branches, at very
 * different offered loads. The picker labels them by start time, and the
 * summary calls one "Best selected" — so a p95 that fell because the load
 * halved is presented as an improvement.
 *
 * This does not decide whether a comparison is valid. It surfaces the
 * differences and lets the reader decide, because comparing across
 * configurations ON PURPOSE is a legitimate thing to do — the failure is doing
 * it without knowing.
 *
 * ═══ UNKNOWN IS NOT COMPATIBLE ═══
 *
 * `environment`, `branch` and `commitSha` are `nullable().optional()`: absent
 * means an API pod that predates the fields, null means a run that recorded
 * nothing. Neither is evidence of sameness, so both read "unknown" and neither
 * is ever reported as matching.
 */
export interface ComparabilityFinding {
  /** The dimension, as the reader sees it. */
  readonly label: string;
  /** `differs` is a real difference; `unknown` is missing evidence. */
  readonly kind: 'same' | 'differs' | 'unknown';
  /** What each run reported, in the order given. */
  readonly values: readonly string[];
}

/**
 * How far apart two loads have to be before the comparison is misleading.
 *
 * 20% is a judgement, not a measurement, and it is deliberately generous:
 * below it the note would fire on ordinary run-to-run variance and be ignored
 * within a week, which is worse than not having it.
 */
export const LOAD_TOLERANCE = 0.2;

const fmt = (value: string | null | undefined): string =>
  value === null || value === undefined || value === '' ? 'unknown' : value;

function categorical(label: string, values: readonly (string | null | undefined)[]): ComparabilityFinding {
  const shown = values.map(fmt);
  const anyUnknown = shown.some((v) => v === 'unknown');
  const distinct = new Set(shown);
  // Unknown first: a run that reported nothing cannot be said to MATCH one
  // that did, even when every value that IS present agrees.
  const kind = anyUnknown ? 'unknown' : distinct.size === 1 ? 'same' : 'differs';
  return { label, kind, values: shown };
}

/** Relative spread, guarding a zero baseline rather than dividing by it. */
function spread(values: readonly number[]): number | null {
  const usable = values.filter((v) => Number.isFinite(v) && v > 0);
  if (usable.length < 2) return null;
  const min = Math.min(...usable);
  const max = Math.max(...usable);
  return (max - min) / min;
}

function quantitative(
  label: string,
  values: readonly (number | null)[],
  format: (value: number) => string,
): ComparabilityFinding {
  const shown = values.map((v) => (v === null || !Number.isFinite(v) ? 'unknown' : format(v)));
  if (shown.some((v) => v === 'unknown')) return { label, kind: 'unknown', values: shown };
  const delta = spread(values.filter((v): v is number => v !== null));
  return {
    label,
    kind: delta !== null && delta > LOAD_TOLERANCE ? 'differs' : 'same',
    values: shown,
  };
}

export function comparability(runs: readonly TrendRun[]): readonly ComparabilityFinding[] {
  if (runs.length < 2) return [];
  return [
    categorical('Environment', runs.map((r) => r.environment)),
    categorical('Branch', runs.map((r) => r.branch)),
    categorical(
      'Build',
      runs.map((r) => (r.commitSha == null ? r.commitSha : r.commitSha.slice(0, 8))),
    ),
    // OFFERED LOAD, which is the one that silently rewrites a latency
    // comparison. Throughput is the closest proxy the cohort query carries.
    quantitative('Throughput', runs.map((r) => r.throughputRps), (v) => `${v.toFixed(2)}/s`),
    quantitative('Requests', runs.map((r) => r.count), (v) => String(v)),
    quantitative('Duration', runs.map((r) => r.durationMs), (v) => `${Math.round(v / 1000)}s`),
  ];
}

/**
 * The one line a reader sees without opening anything.
 *
 * It has to carry WHICH dimensions are involved rather than merely that
 * something is: "these runs differ in ways that change what a comparison
 * means" is true of every non-matching selection and actionable for none of
 * them, which is the verbosity review.md 19 objects to.
 *
 * A REAL DIFFERENCE AND MISSING EVIDENCE ARE STATED SEPARATELY. "Different
 * branch" is a fact about two runs; "build not recorded" is a fact about what
 * CI captured. A reader can act on the first, and only the second tells them to
 * go fix their pipeline — so collapsing the two into one word would lose the
 * only part that says what to do next.
 *
 * LIVES HERE, BESIDE THE FINDINGS IT SUMMARISES, and is read by both surfaces
 * that carry them: this page's comparability panel and the run overview's
 * baseline note. Two copies would drift into describing the same six findings
 * two different ways on two pages a reader moves between.
 */
export function summariseConditions(notable: readonly ComparabilityFinding[]): string {
  const named = (kind: ComparabilityFinding['kind']): string[] =>
    notable.filter((finding) => finding.kind === kind).map((finding) => finding.label.toLowerCase());

  const parts: string[] = [];
  const differs = named('differs');
  const unknown = named('unknown');
  if (differs.length > 0) parts.push(`Different ${joinWords(differs)}`);
  if (unknown.length > 0) parts.push(`${joinWords(unknown)} not recorded`);
  const sentence = parts.join('; ');
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

/** `a`, `a and b`, `a, b and c` — an Oxford-comma-free list for prose. */
function joinWords(words: readonly string[]): string {
  if (words.length < 2) return words.join('');
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1] ?? ''}`;
}

/** True when anything differs or is unknown — i.e. the reader must look. */
export const needsComparabilityCheck = (findings: readonly ComparabilityFinding[]): boolean =>
  findings.some((f) => f.kind !== 'same');
