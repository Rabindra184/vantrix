import type { Assertion, RunResponse, RunVerdict } from '@perfportal/contracts';
import { countAssertions, type AssertionCounts } from './assertions';

/**
 * ═══ THE RELEASE VERDICT'S WORD, IN ONE PLACE ═══
 *
 * Moved out of `RunDecisionBand` when the run lifecycle strip gained a Verdict
 * step (docs/superpowers/specs/2026-09-26-run-lifecycle-strip-design.md): the
 * strip and the band now say one verdict with one function, so they cannot
 * describe it in two vocabularies — the "one page, two vocabularies" defect
 * this repo has fixed repeatedly.
 *
 * `unevaluated` is `undefined`: the verdict has not been reported yet. `none`
 * is `null`: the run finished with no verdict at all. Different facts.
 */
export type Decision = RunVerdict | 'none' | 'unevaluated';

export function decisionOf(verdict: RunVerdict | null | undefined): Decision {
  return verdict === undefined ? 'unevaluated' : (verdict ?? 'none');
}

/**
 * The big word, and the sentence it replaced. "Release gate failed" carried
 * subject and verdict in one string; the redesign splits them — the verdict
 * as the word, the subject as the constant overline beneath it — so the
 * mapping here is the old `decisionTitle` minus the words the overline now
 * owns. Same branches, same order, same honesty rules.
 */
export function decisionWord(
  decision: Decision,
  counts: AssertionCounts,
  /** The run was judged by NOTHING — an empty assertion list, not an absent
      one. See the call site for why the two cannot share a word. */
  unconfigured: boolean,
): string {
  if (decision === 'failed') return 'Failed';
  if (decision === 'passed') return 'Passed';
  if (decision === 'not_evaluated') return unconfigured ? 'Not configured' : 'Not evaluated';
  if (counts.failed > 0) return 'Needs attention';
  return 'Pending';
}

/**
 * ═══ WHETHER THE RUN'S SLA RULES EVER RAN AGAINST IT ═══
 *
 * An empty assertion list means "no rule applies" only if the rules ran. An
 * `incomplete` run the pipeline never processed — swept in place, a failed
 * assembly, a close carrying no bytes — comes back with `assertions: []`
 * because nothing was ever judged, and calling that "Not configured" is a
 * false statement about a project that may well have rules. Only the
 * pipeline's terminal write sets `durationMs`, so it is the signal; an
 * incomplete run whose partial log WAS processed (the sweeper's assembly
 * path) had its rules evaluated, so "incomplete" alone would be the wrong
 * test. A complete run always went through the pipeline.
 */
export function rulesRan(
  status: RunResponse['status'],
  durationMs: number | null | undefined,
): boolean {
  return status !== 'incomplete' || durationMs != null;
}

/**
 * The word for a run, from what the band itself reads. `unconfigured` is keyed
 * on the ARRAY, not on "judged": an absent list is a run whose assertions have
 * not been reported, and "Not configured" would be a claim about a project we
 * have not heard from (the band's own reasoning, moved with it) — and, since
 * `ran` is required, never about a run no rule ran against.
 */
export function releaseWord(
  verdict: RunVerdict | null | undefined,
  assertions: readonly Assertion[] | undefined,
  /** `rulesRan(status, durationMs)`. Required: an omitted one would read
      "Not configured" off every unprocessed incomplete run, silently. */
  ran: boolean,
): string {
  const unconfigured = ran && assertions !== undefined && assertions.length === 0;
  return decisionWord(decisionOf(verdict), countAssertions(assertions ?? []), unconfigured);
}
