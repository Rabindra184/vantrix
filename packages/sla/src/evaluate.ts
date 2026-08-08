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
    const stat = stats.find(
      (s) =>
        s.scope === rule.scope &&
        s.name === (rule.targetName ?? '') &&
        s.family === rule.family,
    );

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
    assertions.push({
      ruleId: rule.id,
      outcome: passed ? 'passed' : 'failed',
      actualValue: actual,
      message: `${describe(rule)} — actual ${actual}`,
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
