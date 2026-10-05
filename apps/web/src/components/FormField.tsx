import type { ReactNode } from 'react';
import InfoTip from './InfoTip';

/** Where a field's hint lives — the ⓘ's hidden copy, which the control points
 *  its `aria-describedby` at. */
export const hintId = (id: string): string => `${id}-hint`;
/** Where a field's notice line lives. */
export const noticeId = (id: string): string => `${id}-notice`;
/** Where a field's error line lives. */
export const errorId = (id: string): string => `${id}-error`;

/**
 * ═══ A FIELD IS A LABEL; ITS HINT IS ONE CLICK AWAY (clean UI, PR 4) ═══
 *
 * Forms printed a help line under fields whose label already said what they
 * were. Here the label stands alone and the hint rides behind an ⓘ BESIDE it —
 * never inside the `<label>`, where the trigger's own name would join the
 * control's. The hint is still the control's description: the ⓘ's hidden copy
 * sits at `hintId(id)`, and a control that points `aria-describedby` there is
 * announced with it on focus, without anything being opened.
 *
 * Two lines may still sit under a control, because the reader has to act on
 * them: a `notice` (a degraded state — "Tests couldn't be loaded — type the
 * slug.") marked in the pending colour, and an `error` (a validation the
 * submit will refuse) marked in the failed colour — the mark is a left rule
 * and the words stay the primary colour (see the note at the lines). Status
 * colours are inline: `text-status-*` utilities emit nothing.
 *
 * `FormField` never sets attributes on its children. The control lives in
 * `children` and only the caller can reach it, so the caller wires
 * `aria-describedby` to whichever of `hintId`, `noticeId` and `errorId` apply.
 *
 * "(optional)" stays INSIDE the label, with a space before it: it qualifies
 * WHICH field this is, so it belongs in the name ("Branch (optional)") rather
 * than in a description announced after a pause.
 */
export default function FormField({
  label,
  id,
  optional = false,
  hint,
  notice,
  error,
  children,
}: {
  readonly label: string;
  readonly id: string;
  readonly optional?: boolean;
  readonly hint?: string;
  readonly notice?: string;
  readonly error?: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex items-center gap-1">
        <label htmlFor={id} className="text-[0.8125rem] font-medium text-primary">
          {label}
          {/* The space is a TEXT NODE, not `ml-1`: a margin separates the
              pixels and leaves the accessible name "Branch(optional)". */}
          {optional && (
            <>
              {' '}
              <span className="font-normal text-muted">(optional)</span>
            </>
          )}
        </label>
        {hint !== undefined && (
          <InfoTip label={`About ${label}`} descriptionId={hintId(id)}>
            {hint}
          </InfoTip>
        )}
      </div>
      {children}
      {/* THE WORDS ARE THE PRIMARY COLOUR; THE STATUS COLOUR IS A RULE. As
          text, the failed and pending tones fall under AA on the sunken ground
          in the light theme (4.27:1 and 4.44:1 — `palette.test.ts` gates them
          against the card only), and a field can sit on either ground: New
          on-prem run's Advanced body is sunken. A left rule is a non-text mark
          and needs 3:1, which both tones clear on both grounds. */}
      {notice !== undefined && (
        <p
          id={noticeId(id)}
          className="border-l-2 pl-2 text-[0.75rem] leading-snug text-primary"
          style={{ borderLeftColor: 'var(--color-status-pending)' }}
        >
          {notice}
        </p>
      )}
      {error !== undefined && (
        <p
          id={errorId(id)}
          className="border-l-2 pl-2 text-[0.75rem] leading-snug text-primary"
          style={{ borderLeftColor: 'var(--color-status-failed)' }}
        >
          {error}
        </p>
      )}
    </div>
  );
}
