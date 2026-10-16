import { describeSlaRule, formatSlaMeasured, type VerdictChange } from '@perfportal/contracts';
import InfoTip from '../components/InfoTip';

/**
 * One line under the release gate when recomputing a run's statistics exactly
 * changed one of its SLA outcomes — and nothing when it changed none. It says
 * "Verdict changed" only when the run's verdict moved too; a changed outcome
 * under an unchanged verdict says so instead.
 *
 * A reader deciding ship/no-ship from this band may have read the OTHER verdict
 * last week. The line says what moved; the ⓘ says which rule moved and
 * by how much, in the rules page's words (`describeSlaRule`) and with the
 * values written the way the gates table writes them (`formatSlaMeasured`),
 * so the two surfaces print one number one way. Not a heading: this sits in
 * shell chrome, which contributes none.
 *
 * Null for an empty list rather than a line saying "unchanged": every run that
 * was never recomputed, and every one whose outcomes held, would otherwise
 * carry a sentence about nothing.
 */
export function VerdictChanged({ changes }: { readonly changes: readonly VerdictChange[] }) {
  if (changes.length === 0) return null;
  // ═══ A ROW IS A CHANGED OUTCOME; THE VERDICT MAY NOT HAVE MOVED ═══
  //
  // One rule can flip while another already failed the run, so the run reads
  // failed before and after. "Verdict changed" is said only when some change
  // really moved the run's verdict; otherwise the line names what did move.
  const verdictMoved = changes.some((c) => c.oldVerdict !== c.newVerdict);
  return (
    <p data-testid="verdict-changed" className="flex items-center gap-1 text-[0.75rem] font-medium text-primary">
      <span>
        {verdictMoved ? 'Verdict changed by exact statistics' : "An SLA rule's outcome changed with exact statistics"}
      </span>
      <InfoTip label="About the verdict change">
        {changes.map((change, index) => (
          <span key={index} className="block">
            {index > 0 && ' '}
            {describeSlaRule(change.rule)} Was {side(change, 'old')}, now {side(change, 'new')}.
          </span>
        ))}
      </InfoTip>
    </p>
  );
}

/** "812.4 ms (failed)", or "not applicable" alone where nothing was measured. */
function side(change: VerdictChange, which: 'old' | 'new'): string {
  const outcome = which === 'old' ? change.oldOutcome : change.newOutcome;
  const value = which === 'old' ? change.oldValue : change.newValue;
  const word = outcome.replaceAll('_', ' ');
  if (value === null) return word;
  return `${formatSlaMeasured(change.rule.metric, value, change.rule.threshold)} (${word})`;
}
