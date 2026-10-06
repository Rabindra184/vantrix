import { describe, expect, it } from 'vitest';
import {
  ATTENTION_REASONS,
  AttentionReasonSchema,
  RunStatusSchema,
  RunVerdictSchema,
  attentionReasons,
  needsAttention,
  type AttentionInput,
  type AttentionReason,
  type RunStatus,
} from '../src/index.js';

/**
 * ═══ ONE DEFINITION OF "NEEDS ATTENTION", AND THE ORACLE IS NOT THE CODE ═══
 *
 * A run needs attention when its status is `failed` or `incomplete`, when its
 * SLA verdict is `failed`, or when a simulation check failed. `attentionReasons`
 * names which of those clauses held, in `ATTENTION_REASONS` order.
 *
 * The expected reasons below are built from a table of what each INPUT VALUE
 * contributes, one dimension at a time — status, verdict, checks — and joined
 * by concatenation. That is a separate statement of the rule from the one the
 * function makes: a case that computed its expectation by calling
 * `attentionReasons` (or `needsAttention`) would assert nothing, and a
 * mistake in one clause would be copied into the oracle.
 *
 * The three dimensions are deliberately crossed in full, including the
 * "absent" spelling of verdict and checks (the key omitted) beside `null`:
 * the run list sends both, an API pod that predates `checks` omits it, and
 * neither is a failure.
 */

const STATUS_CONTRIBUTES: Record<RunStatus, readonly AttentionReason[]> = {
  pending: [],
  parsing: [],
  running: [],
  complete: [],
  failed: ['failed'],
  incomplete: ['incomplete'],
};

type VerdictCase = 'passed' | 'failed' | 'not_evaluated' | 'null' | 'absent';
const VERDICT_CONTRIBUTES: Record<VerdictCase, readonly AttentionReason[]> = {
  passed: [],
  failed: ['gate_failed'],
  not_evaluated: [],
  null: [],
  absent: [],
};

type ChecksCase = 'null' | 'absent' | 'none-failed' | 'one-failed';
const CHECKS_VALUE: Record<ChecksCase, { failed: number; total: number } | null | undefined> = {
  null: null,
  absent: undefined,
  'none-failed': { failed: 0, total: 2 },
  'one-failed': { failed: 1, total: 2 },
};
const CHECKS_CONTRIBUTES: Record<ChecksCase, readonly AttentionReason[]> = {
  null: [],
  absent: [],
  'none-failed': [],
  'one-failed': ['assertion_failed'],
};

/** Build the input the way a caller would: an absent field is OMITTED, not
 *  set to undefined, so the "absent" cases exercise the optional property. */
function input(status: RunStatus, verdict: VerdictCase, checks: ChecksCase): AttentionInput {
  return {
    status,
    ...(verdict === 'absent' ? {} : { verdict: verdict === 'null' ? null : verdict }),
    ...(checks === 'absent' ? {} : { checks: CHECKS_VALUE[checks] }),
  };
}

const MATRIX = RunStatusSchema.options.flatMap((status) =>
  (Object.keys(VERDICT_CONTRIBUTES) as VerdictCase[]).flatMap((verdict) =>
    (Object.keys(CHECKS_CONTRIBUTES) as ChecksCase[]).map(
      (checks) =>
        [
          `${status} / verdict ${verdict} / checks ${checks}`,
          input(status, verdict, checks),
          [
            ...STATUS_CONTRIBUTES[status],
            ...VERDICT_CONTRIBUTES[verdict],
            ...CHECKS_CONTRIBUTES[checks],
          ],
        ] as const,
    ),
  ),
);

describe('attentionReasons and needsAttention', () => {
  /** The crossing is the whole claim: if a status or a verdict spelling is
   *  added, the table above has to be told, and this fails until it is. */
  it('crosses every status, every verdict spelling and every checks spelling', () => {
    expect(RunStatusSchema.options).toHaveLength(6);
    expect(Object.keys(STATUS_CONTRIBUTES).sort()).toEqual([...RunStatusSchema.options].sort());
    expect(Object.keys(VERDICT_CONTRIBUTES).sort()).toEqual(
      [...RunVerdictSchema.options, 'null', 'absent'].sort(),
    );
    expect(MATRIX).toHaveLength(6 * 5 * 4);
  });

  it.each(MATRIX)('%s names exactly the clauses that held', (_name, run, expected) => {
    expect(attentionReasons(run)).toEqual(expected);
  });

  it.each(MATRIX)('%s needs attention exactly when a clause held', (_name, run, expected) => {
    expect(needsAttention(run)).toBe(expected.length > 0);
  });

  it('names every clause, in the order the type lists them', () => {
    expect(
      attentionReasons({
        status: 'failed',
        verdict: 'failed',
        checks: { failed: 1, total: 2 },
      }),
    ).toEqual(['failed', 'gate_failed', 'assertion_failed']);
    expect(
      attentionReasons({
        status: 'incomplete',
        verdict: 'failed',
        checks: { failed: 3, total: 3 },
      }),
    ).toEqual(['incomplete', 'gate_failed', 'assertion_failed']);
  });

  it('names nothing for a clean run', () => {
    expect(
      attentionReasons({ status: 'complete', verdict: 'passed', checks: { failed: 0, total: 3 } }),
    ).toEqual([]);
    expect(needsAttention({ status: 'complete', verdict: 'passed', checks: { failed: 0, total: 3 } })).toBe(
      false,
    );
  });

  /**
   * The case the run tally's comment records: the platform gate passed while
   * the simulation's own check failed. Neither status nor verdict says so.
   */
  it('names a failed simulation check on a run whose gate passed', () => {
    expect(
      attentionReasons({ status: 'complete', verdict: 'passed', checks: { failed: 1, total: 4 } }),
    ).toEqual(['assertion_failed']);
  });

  /** Reasons come back in `ATTENTION_REASONS` order whatever clause holds, so
   *  a caller that renders them in sequence never has to sort. */
  it('returns reasons as a subsequence of ATTENTION_REASONS', () => {
    for (const [, run] of MATRIX) {
      const reasons = attentionReasons(run);
      const indices = reasons.map((r) => ATTENTION_REASONS.indexOf(r));
      expect(indices).toEqual([...indices].sort((a, b) => a - b));
      expect(new Set(reasons).size).toBe(reasons.length);
    }
  });

  it('hands out a fresh array each call, so a caller may sort or mutate it', () => {
    const run: AttentionInput = { status: 'failed' };
    const first = attentionReasons(run);
    first.push('incomplete');
    expect(attentionReasons(run)).toEqual(['failed']);
  });
});

describe('AttentionReasonSchema', () => {
  it('lists the four reasons, in render order', () => {
    expect([...ATTENTION_REASONS]).toEqual([
      'failed',
      'incomplete',
      'gate_failed',
      'assertion_failed',
    ]);
    expect(AttentionReasonSchema.options).toEqual([...ATTENTION_REASONS]);
  });

  it('refuses a word that is not a reason', () => {
    expect(AttentionReasonSchema.safeParse('slow').success).toBe(false);
  });
});
