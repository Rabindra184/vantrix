import { z } from 'zod';
import type { RunStatus, RunVerdict } from './run.js';

/**
 * ═══ ONE DEFINITION OF "NEEDS ATTENTION" ═══
 * (docs/superpowers/specs/2026-10-05-portfolio-home-and-command-palette-design.md)
 *
 * A run needs attention when ANY of four clauses holds:
 *
 * ```
 *   failed            its status is `failed`   — it could not be ingested
 *   incomplete        its status is `incomplete` — the stream stopped early
 *   gate_failed       its SLA verdict is `failed`
 *   assertion_failed  a check its simulation declared for itself failed
 * ```
 *
 * The last clause is the one that is easy to lose: a platform gate can pass
 * while the simulation's own assertion fails, and neither status nor verdict
 * says so. `checks` is null for a run that recorded none, which is not a
 * failure.
 *
 * This used to live inside the run tally, where it counted rows on one page.
 * The home page and `GET /v1/activity` need the same answer, so it moved here
 * and the tally imports it: three surfaces, one rule. The API's day counts are
 * SQL and cannot call this, so an integration case runs the SQL predicate over
 * every combination and requires it to agree.
 *
 * `ATTENTION_REASONS` is in the order a reader sees them named, and
 * `attentionReasons` returns them in that order, so a caller rendering the list
 * never sorts.
 */
export const ATTENTION_REASONS = ['failed', 'incomplete', 'gate_failed', 'assertion_failed'] as const;
export const AttentionReasonSchema = z.enum(ATTENTION_REASONS);
export type AttentionReason = z.infer<typeof AttentionReasonSchema>;

/**
 * The three facts the rule reads. `verdict` and `checks` are optional as well
 * as nullable, because the run list sends both and an API pod that predates
 * `checks` omits it; absent and null mean the same here, and neither is a
 * failure.
 */
export interface AttentionInput {
  readonly status: RunStatus;
  readonly verdict?: RunVerdict | null;
  readonly checks?: { readonly failed: number; readonly total: number } | null;
}

/** Which of the four clauses hold for this run, in `ATTENTION_REASONS` order.
 *  Empty for a run that needs no attention. A fresh array each call. */
export function attentionReasons(run: AttentionInput): AttentionReason[] {
  const reasons: AttentionReason[] = [];
  if (run.status === 'failed') reasons.push('failed');
  if (run.status === 'incomplete') reasons.push('incomplete');
  if (run.verdict === 'failed') reasons.push('gate_failed');
  if (run.checks != null && run.checks.failed > 0) reasons.push('assertion_failed');
  return reasons;
}

export function needsAttention(run: AttentionInput): boolean {
  return attentionReasons(run).length > 0;
}
