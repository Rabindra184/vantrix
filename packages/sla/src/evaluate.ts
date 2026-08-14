import { resolveMetric, type EvaluableStat } from './metrics.js';

export interface EvaluableRule {
  id: string;
  scope: string;
  /** null for run scope; the request or group name otherwise. */
  targetName: string | null;
  family: string;
  metric: string;
  comparator: 'lte' | 'gte';
  threshold: number;
}

export type AssertionOutcome = 'passed' | 'failed' | 'not_applicable';
export type Verdict = 'passed' | 'failed' | 'not_evaluated';

export interface EvaluatedAssertion {
  ruleId: string;
  outcome: AssertionOutcome;
  /** null when not_applicable — there was nothing to measure. */
  actualValue: number | null;
  message: string;
  /** The rule as it read at evaluation time. Editing a threshold later must
   *  never rewrite the history of what passed. */
  ruleSnapshot: EvaluableRule;
}

function describe(rule: EvaluableRule): string {
  const target = rule.targetName ?? 'the run';
  return `${rule.metric} of ${target} (${rule.family}) ${rule.comparator === 'lte' ? '≤' : '≥'} ${rule.threshold}`;
}

export function evaluateRules(
  rules: readonly EvaluableRule[],
  stats: readonly EvaluableStat[],
): { assertions: EvaluatedAssertion[]; verdict: Verdict } {
  const assertions: EvaluatedAssertion[] = [];

  for (const rule of rules) {
    const snapshot: EvaluableRule = { ...rule };
    const target = rule.targetName ?? '';
    const candidates = stats.filter((s) => s.scope === rule.scope && s.family === rule.family);

    /**
     * D-13. EXACT MATCH FIRST, then the leaf.
     *
     * D-10 made a request's identity its full group path, so a rule authored
     * before that names the leaf (`List Products`, not
     * `Catalog/List Products`). Matching only exactly would drop such a rule
     * into the `!stat` branch below and report it "not checked" — an SLA gate
     * that stops enforcing while looking healthy. A data migration cannot fix
     * it either way round: runs ingested before D-10 keep their bare names, so
     * a rewritten target would break against exactly the runs it still matches.
     *
     * The same rule applies at group scope, where names have ALWAYS been paths
     * and a bare target has therefore never matched. One matching behaviour for
     * every scope: a reader debugging a rule should not have to know which
     * scope changed identity when.
     *
     * Never for run scope: `targetName` is null there, so `target` is `''`.
     * The guard is NOT because `endsWith('/')` would match everything — it
     * matches nothing (`'Catalog/View'.endsWith('/')` is false). It is because
     * it matches a name ending in the separator: a group whose request leaf is
     * empty joins to `Cart/`, and `'Cart/'.endsWith('/')` IS true. Without the
     * guard a run-scope rule could bind to that degenerate row instead of to
     * the run. The exact match at `:70` finds the run stat first in practice,
     * so this is belt and braces — but it is cheap and the degenerate row is
     * reachable from a malformed simulation log.
     */
    let stat = candidates.find((s) => s.name === target);
    let ambiguous: readonly EvaluableStat[] = [];
    if (stat === undefined && target !== '') {
      const byLeaf = candidates.filter((s) => s.name.endsWith(`/${target}`));
      // AMBIGUITY IS NOT RESOLVED BY PICKING. Two requests can share a leaf
      // under different groups; choosing one silently would be a worse bug
      // than the one this fallback fixes.
      if (byLeaf.length === 1) stat = byLeaf[0];
      else ambiguous = byLeaf;
    }

    if (ambiguous.length > 1) {
      assertions.push({
        ruleId: rule.id,
        outcome: 'not_applicable',
        actualValue: null,
        message:
          `"${target}" is ambiguous in this run — it matches ${ambiguous.map((s) => s.name).join(', ')} — ` +
          `so ${describe(rule)} was not checked. Target one of those names exactly.`,
        ruleSnapshot: snapshot,
      });
      continue;
    }

    if (!stat) {
      assertions.push({
        ruleId: rule.id,
        outcome: 'not_applicable',
        actualValue: null,
        message: `No ${rule.family} statistics for ${rule.targetName ?? 'the run'} in this run, so ${describe(rule)} was not checked.`,
        ruleSnapshot: snapshot,
      });
      continue;
    }

    const actual = resolveMetric(stat, rule.metric);
    if (actual === null || Number.isNaN(actual)) {
      assertions.push({
        ruleId: rule.id,
        outcome: 'not_applicable',
        actualValue: null,
        message: `Metric "${rule.metric}" could not be resolved for ${rule.targetName ?? 'the run'}, so ${describe(rule)} was not checked.`,
        ruleSnapshot: snapshot,
      });
      continue;
    }

    const passed = rule.comparator === 'lte' ? actual <= rule.threshold : actual >= rule.threshold;
    // The fallback above can bind this rule to a stat whose name is not the
    // one it names — a leaf match, never an exact one from here on. Say so:
    // the ambiguity branch is loud about not choosing, so the single-match
    // branch should not go quiet about the same class of non-literal match.
    const matchNote = stat.name !== target ? ` (matched "${stat.name}")` : '';
    assertions.push({
      ruleId: rule.id,
      outcome: passed ? 'passed' : 'failed',
      actualValue: actual,
      message: `${describe(rule)} — actual ${actual}${matchNote}`,
      ruleSnapshot: snapshot,
    });
  }

  // A rule that could not be checked is never a pass. "We checked and it was
  // fine" and "we did not check" are different facts, and collapsing them is
  // the difference between a gate and a decoration.
  if (assertions.some((a) => a.outcome === 'failed')) return { assertions, verdict: 'failed' };
  if (assertions.some((a) => a.outcome === 'passed')) return { assertions, verdict: 'passed' };
  return { assertions, verdict: 'not_evaluated' };
}
