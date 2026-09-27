import type { Assertion, RunVerdict } from '@perfportal/contracts';
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
 * The word for a run, from what the band itself reads. `unconfigured` is keyed
 * on the ARRAY, not on "judged": an absent list is a run whose assertions have
 * not been reported, and "Not configured" would be a claim about a project we
 * have not heard from (the band's own reasoning, moved with it).
 */
export function releaseWord(
  verdict: RunVerdict | null | undefined,
  assertions: readonly Assertion[] | undefined,
): string {
  const unconfigured = assertions !== undefined && assertions.length === 0;
  return decisionWord(decisionOf(verdict), countAssertions(assertions ?? []), unconfigured);
}
