import type { ReactNode } from 'react';
import type { ProjectRole } from '@perfportal/contracts';
import { errorId } from '../components/FormField';

/**
 * The pieces Administration › Users' two forms share — Add user's project
 * rows, and the row menu's Reset password block and Edit projects and roles
 * panel — kept apart from both so neither module imports the other.
 */

/** A role as the reader sees it: the enum's own word, capitalised. */
export const ROLE_LABEL: Record<ProjectRole, string> = {
  viewer: 'Viewer',
  member: 'Member',
  manager: 'Manager',
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
