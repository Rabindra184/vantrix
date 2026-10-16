import { describeSlaRule, formatSlaMeasured, type VerdictChange } from '@perfportal/contracts';
import InfoTip from '../components/InfoTip';

/**
 * One line under the release gate when recomputing a run's statistics exactly
 * changed one of its SLA outcomes — and nothing when it changed none.
 *
 * A reader deciding ship/no-ship from this band may have read the OTHER verdict
 * last week. The line says the verdict moved; the ⓘ says which rule moved it
 * and by how much, in the rules page's words (`describeSlaRule`) and with the
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
  return (
    <p data-testid="verdict-changed" className="flex items-center gap-1 text-[0.75rem] font-medium text-primary">
      <span>Verdict changed by exact statistics</span>
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
  const word = outcome.replace('_', ' ');
  if (value === null) return word;
  return `${formatSlaMeasured(change.rule.metric, value, change.rule.threshold)} (${word})`;
}
