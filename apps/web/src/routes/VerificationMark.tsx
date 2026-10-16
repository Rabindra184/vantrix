import * as Popover from '@radix-ui/react-popover';
import type { RunStatus, UnverifiableReason, VerificationSummary } from '@perfportal/contracts';
import Badge from '../components/Badge';
import InfoTip from '../components/InfoTip';
import { VERIFICATION } from './marks';
import VerificationPanel from './VerificationPanel';

/**
 * Why a run could not be verified, in one sentence — the mark's ⓘ and the
 * Data integrity page's table both say it, so it is said one way.
 *
 * `raw_log_deleted` names no day count: the retention setting is a deployment
 * fact this run's own record does not carry, and a number guessed here could
 * contradict the one Administration states.
 */
export function unverifiableReasonText(reason: UnverifiableReason | null): string {
  switch (reason) {
    case 'raw_log_deleted':
      return 'The raw log was deleted before this run was checked.';
    case 'raw_log_missing':
      return 'The raw log could not be found.';
    case 'raw_log_unreadable':
      return 'The raw log could not be read.';
    case 'not_exact':
      return 'Its statistics are estimates; see ≈.';
    default:
      return 'This run could not be checked.';
  }
}

/**
 * A run's verification, beside its status in the header: whether its stored
 * figures were re-derived from its raw log and agreed.
 *
 * ═══ ONLY A RUN WITH STATISTICS GETS A MARK ═══
 *
 * A pending, parsing or running run is still being measured, and a failed one
 * produced no statistics at all — "Verifying…" over either is a claim about
 * figures that do not exist. `complete` and `incomplete` both keep theirs (an
 * incomplete run's are what arrived), so both are marked.
 *
 * ═══ NO SUMMARY, NO MARK ═══
 *
 * The API answers `pending` for a run with statistics the verifier has not
 * reached yet, and null for a run with none — an incomplete run nothing
 * processed is the common one, and the verifier never checks it. Drawing
 * "Verifying…" there would say it for ever, while Administration › Data
 * integrity rightly leaves the run out. So null (or an absent field, from an
 * API older than this one) draws nothing.
 *
 * ═══ THE MARK IS A BUTTON, AND THE PANEL LOADS ON OPEN ═══
 *
 * `VerificationPanel` is inside `Popover.Content`, which Radix mounts only
 * while open — so `GET /v1/runs/{id}/verification` is not asked for on page
 * load, by construction rather than by an `enabled` flag that could drift.
 *
 * FOCUS MOVES INTO THE PANEL, unlike `InfoTip`. An ⓘ is a description the
 * trigger already carries; this panel holds a table a keyboard reader has to
 * be able to reach (its scroll region is a tab stop). Radix's defaults do that
 * and Escape closes and returns focus to the mark.
 *
 * Unverifiable runs carry an ⓘ BESIDE the button, never inside it: a
 * trigger inside a button would be a button in a button.
 */
export default function VerificationMark({
  runId,
  status,
  summary,
}: {
  readonly runId: string;
  readonly status: RunStatus;
  /** The identity's summary; `null`/`undefined` (not verifiable) draws no mark. */
  readonly summary: VerificationSummary | null | undefined;
}) {
  if (status !== 'complete' && status !== 'incomplete') return null;
  if (summary == null) return null;
  const state = summary.status;
  const mark = VERIFICATION[state];
  return (
    <span className="inline-flex items-center gap-1">
      <Popover.Root>
        <Popover.Trigger asChild>
          <button
            type="button"
            data-testid="run-verification"
            className="transition-ui rounded-md hover:opacity-80"
          >
            <Badge mark={mark} />
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            aria-label="Verification"
            side="bottom"
            align="end"
            sideOffset={6}
            collisionPadding={8}
            className="z-50 max-h-[70vh] w-[min(40rem,calc(100vw-2rem))] overflow-y-auto rounded-lg border border-default bg-surface p-4 text-[0.8125rem] text-primary shadow-panel outline-none"
          >
            <VerificationPanel runId={runId} />
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
      {state === 'unverifiable' && (
        <InfoTip label="Why this run is not verified">{unverifiableReasonText(summary.reason)}</InfoTip>
      )}
    </span>
  );
}
