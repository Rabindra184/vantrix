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

/* ═════════════════════════════════════════════════════════════════════════ *
 * THE TREND BREAK — a different question from the findings above
 * ═════════════════════════════════════════════════════════════════════════ */

/** Where a trend line stops being one line, and what changed there. */
export interface ComparabilityBreak {
  /** Index into the run list AS GIVEN: the first run on the new footing. */
  readonly index: number;
  /** The axes that changed, lower-case, in reading order. */
  readonly changed: readonly string[];
  /** `staging → production`, joined when more than one axis moved. */
  readonly detail: string;
}

/**
 * The axes a trend line breaks across, and the ones it deliberately does not.
 *
 * ═══ THIS IS NOT `comparability()` WITH A FILTER ═══
 *
 * That function answers "are these selected runs comparable, and where not",
 * over a SET, for a reader who chose them. This answers "did the footing
 * change between consecutive runs", over a SEQUENCE, for a line that would
 * otherwise assert continuity nobody checked. Same subject, different question
 * — which is why the axis lists differ rather than one being a subset by
 * accident.
 *
 * ═══ BRANCH AND COMMIT ARE EXCLUDED, DELIBERATELY ═══
 *
 * The PRD's comparability fingerprint (§24.1) is over tool, simulation,
 * environment and the injection profile, and says of branch and commit that
 * they are "what varies between comparable runs". A trend that broke on every
 * commit would be nothing but breaks, and the thing a reader watches a trend
 * FOR is the effect of commits. `comparability()` still reports them, because
 * a reader comparing two runs by hand wants them named.
 *
 * ═══ THE INJECTION PROFILE IS MISSING, AND NOT SUBSTITUTED FOR ═══
 *
 * Gatling's `simulation.log` carries no declaration of the injection profile —
 * the reference run's "60 ramp + 4/s over 60s" was read out of the simulation
 * SOURCE, not the log — so three of the fingerprint's four components are
 * available and the fourth is not.
 *
 * The tempting substitute is a measured proxy: peak users, or request count.
 * That would be actively worse than omitting it. A fingerprint has to be
 * derived from DECLARED intent; two runs of the SAME profile differ in peak
 * concurrency by a user or two, so a measured proxy fragments the line on
 * noise — breaking it where nothing changed, which is the failure this exists
 * to prevent, inverted. Carrying the profile needs the client to declare it,
 * the way `declaredTestSlug` is declared. Recorded as the gap it is.
 *
 * ═══ KNOWN-TO-KNOWN ONLY ═══
 *
 * A break is a positive claim that two runs sit on different footing, and
 * `undefined`/`null` is not evidence for it any more than it is evidence of
 * sameness — the rule this module already applies to its findings. Breaking on
 * unknown would also shatter the line for every run predating these fields,
 * which is the outcome `nullable().optional()` exists to avoid.
 */
export function comparabilityBreaks(runs: readonly TrendRun[]): readonly ComparabilityBreak[] {
  const axes = [
    { label: 'tool', of: (r: TrendRun) => r.tool },
    { label: 'simulation', of: (r: TrendRun) => r.simulation },
    { label: 'environment', of: (r: TrendRun) => r.environment },
  ] as const;

  const breaks: ComparabilityBreak[] = [];
  for (let i = 1; i < runs.length; i += 1) {
    const before = runs[i - 1]!;
    const after = runs[i]!;
    const changed: string[] = [];
    const moves: string[] = [];
    for (const axis of axes) {
      const a = axis.of(before);
      const b = axis.of(after);
      // Both KNOWN and different. `fmt`'s 'unknown' is not a value to compare.
      if (a === null || a === undefined || a === '') continue;
      if (b === null || b === undefined || b === '') continue;
      if (a === b) continue;
      changed.push(axis.label);
      moves.push(`${a} → ${b}`);
    }
    if (changed.length > 0) breaks.push({ index: i, changed, detail: moves.join(', ') });
  }
  return breaks;
}

/**
 * The sentence a broken trend carries, naming every axis that moved.
 *
 * One sentence for the whole chart rather than one per break: a cohort that
 * alternates between two environments would otherwise print the same fact
 * twenty times, and the reader needs to know the line is not continuous, not
 * to be told once per gap.
 */
export function summariseBreaks(breaks: readonly ComparabilityBreak[]): string | undefined {
  if (breaks.length === 0) return undefined;
  const axes = [...new Set(breaks.flatMap((b) => b.changed))];
  const gaps = breaks.length === 1 ? 'a gap' : `${breaks.length} gaps`;
  return `The line is broken at ${gaps}: ${joinWords(axes)} changed between runs, so the points either side were not measured under the same conditions.`;
}
