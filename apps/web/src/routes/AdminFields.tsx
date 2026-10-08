import { useState, type ReactNode } from 'react';
import { PROJECT_ROLES, roleName, type ProjectRole } from '@perfportal/contracts';
import Button from '../components/Button';
import { errorId } from '../components/FormField';
import { INPUT } from '../components/tableStyles';

/**
 * The pieces Administration › Users' two forms share — Add user's project
 * rows, and the row menu's Reset password block and Edit projects and roles
 * panel — kept apart from both so neither module imports the other.
 */

/**
 * A role as the reader sees it. The words are `roleName`'s — the one the API's
 * refusals ("…needs the Member role in this project.") spell a role with — so
 * a select's option and the refusal it can earn cannot name a role two ways.
 */
export const ROLE_LABEL: Readonly<Record<ProjectRole, string>> = {
  viewer: roleName('viewer'),
  member: roleName('member'),
  manager: roleName('manager'),
};

/**
 * One field whose visible word repeats on the page: `FormField`'s label and
 * error line, with a qualifier in the label for a screen reader only.
 *
 * ═══ "Project", READ AS "Project 2" ═══
 * Two rows on Add user give the form two Project selects and two Role
 * selects, and a label each of "Project" would leave a screen-reader user
 * unable to tell them apart; the edit panel has a Role select per project. The
 * qualifier — a row's position, `in Checkout`, `for Bo Flagged` — is in the
 * accessible name, after the visible word, so what is seen is still what is
 * said first.
 */
export function RowField({
  label,
  qualifier,
  id,
  error,
  children,
}: {
  readonly label: string;
  readonly qualifier: string | number;
  readonly id: string;
  readonly error?: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={id} className="text-[0.8125rem] font-medium text-primary">
        {label}
        {/* The space is a TEXT NODE outside the span: one inside it is
            trimmed by the name computation, which read "Project1". */}
        {' '}
        <span className="sr-only">{qualifier}</span>
      </label>
      {children}
      {/* The same line `FormField` draws: words in the primary colour, the
          failed tone as a left rule (see that component for why). */}
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

/**
 * A role held, changed by picking another and pressing Save.
 *
 * ═══ THE SELECT ONLY STAGES ═══
 * A native select fires `change` on every ArrowDown, so a select that saved on
 * change saved the first option a keyboard reader arrowed onto — a role they
 * were only passing on the way to another — and locked while it did. Here the
 * select holds a choice, and Save, offered only while that choice differs
 * from the role held, sends it once.
 *
 * ═══ THE CHOICE STARTS AGAIN WHENEVER THE ROLE HELD CHANGES ═══
 * A saved change comes back as `current`, leaving nothing to save; a role
 * changed by someone else replaces whatever was staged over the old one. Reset
 * while rendering, not in an effect, so no frame shows a Save for a choice
 * that is already the role held. A re-render that leaves `current` alone —
 * another line's change re-reading the list — keeps the choice.
 *
 * ═══ NAMED AFTER ITS LINE ═══
 * Both controls carry the qualifier after their visible word, as `RowField`
 * does: "Role in Checkout", and "Save role in Checkout" — a list of people or
 * projects is a list of these, and two Saves called "Save" cannot be told
 * apart.
 *
 * `pending` is a request in flight for whatever owns this line — this role or
 * another change on the same person — and locks both controls: a choice moved
 * while one is being sent would be reset by its answer.
 */
export function RoleChange({
  id,
  qualifier,
  current,
  pending,
  onSave,
}: {
  readonly id: string;
  readonly qualifier: string;
  readonly current: ProjectRole;
  readonly pending: boolean;
  readonly onSave: (role: ProjectRole) => void;
}) {
  const [staged, setStaged] = useState<ProjectRole>(current);
  const [held, setHeld] = useState<ProjectRole>(current);
  if (held !== current) {
    setHeld(current);
    setStaged(current);
  }

  return (
    <div className="flex flex-wrap items-end gap-2">
      <RowField label="Role" qualifier={qualifier} id={id}>
        <select
          id={id}
          className={INPUT}
          value={staged}
          disabled={pending}
          onChange={(event) => setStaged(event.target.value as ProjectRole)}
        >
          {PROJECT_ROLES.map((role) => (
            <option key={role} value={role}>
              {ROLE_LABEL[role]}
            </option>
          ))}
        </select>
      </RowField>
      {/* Not `primary`: a page has one, and a per-line Save is never it. */}
      {staged !== current && (
        <Button size="sm" variant="secondary" disabled={pending} onClick={() => onSave(staged)}>
          Save{' '}
          <span className="sr-only">role {qualifier}</span>
        </Button>
      )}
    </div>
  );
}
