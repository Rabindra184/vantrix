import { useEffect, useRef, useState, type ReactNode } from 'react';
import { PROJECT_ROLES, roleName, type ProjectRole } from '@perfportal/contracts';
import Button from '../components/Button';
import { errorId } from '../components/FormField';
import { INPUT } from '../components/tableStyles';
import { ProblemError } from '../api/fetch';

/**
 * The pieces the screens that manage people share — Administration › Users'
 * two forms (Add user's project rows; the row menu's blocks and Edit projects
 * and roles panel) and a project's Members page — kept in a module of their
 * own, so none of those screens owns them.
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

/** Two display names a screen reader would read alike: case and spacing aside. */
const spoken = (name: string): string => name.trim().replace(/\s+/g, ' ').toLocaleLowerCase();

/* How many in a list share each spoken name, counted once per list: a table
   asks for every row, and counting the whole list again per row would make a
   table of people quadratic in its length. Keyed by the array itself, which a
   query hands back unchanged until its data changes. */
const sharedNames = new WeakMap<readonly { readonly name: string }[], ReadonlyMap<string, number>>();
function namesIn(everyone: readonly { readonly name: string }[]): ReadonlyMap<string, number> {
  let counts = sharedNames.get(everyone);
  if (counts === undefined) {
    const tally = new Map<string, number>();
    for (const other of everyone) tally.set(spoken(other.name), (tally.get(spoken(other.name)) ?? 0) + 1);
    counts = tally;
    sharedNames.set(everyone, counts);
  }
  return counts;
}

/**
 * ═══ ONE NAME PER ROW CONTROL (ruling W6) ═══
 *
 * A person as a list of people names them: their display name, with their
 * email after it when somebody else in `everyone` has the same name.
 *
 * Display names are not unique and emails are. Every per-row control in the
 * Users table and on the Members page is named after its person, so two
 * people called Sam Lee would give the page two controls with one name — the
 * duplicate-name defect this repo has paid for three times. The email joins
 * the name on those rows only; everywhere else the name is the plain one.
 * "Shared" is judged as a screen reader would hear it, so `Sam Lee` and
 * `sam  lee` share.
 */
export function nameWithEmailIfShared(
  person: { readonly name: string; readonly email: string },
  everyone: readonly { readonly name: string }[],
): string {
  const sharing = namesIn(everyone).get(spoken(person.name)) ?? 0;
  return sharing > 1 ? `${person.name} (${person.email})` : person.name;
}

/**
 * A word after a person's name — `Admin`, `Disabled` — drawn as a small tag.
 *
 * A TEXT NODE before it, not only the margin: a margin moves pixels, and a
 * copy or a screen reader would read "Ada AdminAdmin".
 */
export function PersonMarker({ children }: { readonly children: string }) {
  return (
    <>
      {' '}
      <span className="ml-1 rounded-md border border-default bg-sunken px-1.5 py-0.5 text-[0.75rem] text-muted">
        {children}
      </span>
    </>
  );
}

/**
 * A refusal in the API's own words: its detail, then what to do about it —
 * the block each of these screens shows where the refused action was taken.
 * Mounted by its caller only while there is a refusal to show, so its
 * `role="alert"` is never an empty, always-present region.
 */
export function Problem({ error }: { readonly error: Error }) {
  const problem = error instanceof ProblemError ? error : null;
  return (
    <div role="alert" className="rounded-lg border border-default bg-sunken p-3 text-[0.8125rem] text-primary">
      {problem?.detail ?? error.message}
      {problem !== null && problem.remediation !== '' && <p className="mt-1 text-muted">{problem.remediation}</p>}
    </div>
  );
}

/**
 * Whether the caret is where a settled request may move it from: on the
 * control that sent it, or nowhere (the page itself). A reader who has taken
 * it anywhere else since keeps it there.
 */
export function caretIsFree(from: HTMLElement | null): boolean {
  const active = document.activeElement;
  return active === null || active === document.body || active === from;
}

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
 *
 * `labelHidden` puts the WHOLE label out of sight — for a field in a table
 * cell, whose column header already says the visible word — leaving the
 * accessible name exactly as it was.
 */
export function RowField({
  label,
  qualifier,
  id,
  error,
  labelHidden = false,
  children,
}: {
  readonly label: string;
  readonly qualifier: string | number;
  readonly id: string;
  readonly error?: string;
  readonly labelHidden?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={id} className={labelHidden ? 'sr-only' : 'text-[0.8125rem] font-medium text-primary'}>
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
 * apart. `labelHidden` (a table cell under a `Role` header) hides the visible
 * "Role" and keeps both names.
 *
 * ═══ THE CARET AFTER A SAVE ═══
 * The Save a reader pressed goes once the role it sent comes back as
 * `current` — the reset above takes it — which would leave the caret on
 * nothing. So once the role held has moved after a Save (normally that save's
 * own answer) and the line is unlocked, the caret goes to this line's select,
 * where the role now held is shown. Here, for every owner, rather than aimed
 * by each: neither the Administration panel nor the Members table names the
 * select. Only while the caret is still on that Save, or lost to the page (a
 * browser may drop it as the Save is disabled mid-request): a reader who has
 * taken it elsewhere keeps it there. A refused save leaves the role, and so
 * the Save, the choice and the caret, where they were; the owner decides where
 * a refusal sends the caret.
 *
 * `pending` is the owner's: a request in flight for whatever owns this line —
 * this role, or another change on the same person or row — and it locks both
 * controls, because the owner sends one request at a time. When the request is
 * this line's own save, a choice moved meanwhile would in any case be reset by
 * its answer.
 */
export function RoleChange({
  id,
  qualifier,
  current,
  pending,
  onSave,
  labelHidden = false,
}: {
  readonly id: string;
  readonly qualifier: string;
  readonly current: ProjectRole;
  readonly pending: boolean;
  readonly onSave: (role: ProjectRole) => void;
  readonly labelHidden?: boolean;
}) {
  const [staged, setStaged] = useState<ProjectRole>(current);
  const [held, setHeld] = useState<ProjectRole>(current);
  if (held !== current) {
    setHeld(current);
    setStaged(current);
  }

  const select = useRef<HTMLSelectElement>(null);
  /* Set as Save is pressed: the role held then, and the button the caret was
     on. Kept until the role held moves, or the reader stages another choice. A
     refused save leaves it set, and that is harmless: should the role then move
     some other way, the Save the caret may still be on goes with the reset,
     and this line's select is still the right place for the caret. */
  const sent = useRef<{ readonly over: ProjectRole; readonly from: HTMLElement | null } | null>(null);

  /* ═══ KEYED ON THE ROLE MOVING, NOT ON `pending` ENDING ═══
     React can run an earlier render's effect AFTER the click has set `sent` —
     it flushes pending passive effects before the click's own render — and
     that render saw `pending` false: "not pending" cannot tell a save not yet
     sent from one answered. An earlier render also saw the old role, though,
     so waiting for `current` to differ from the role held at the click is
     safe against it. Then, once the line is unlocked, the select can take the
     caret. Every render rather than a dependency list, because the role and
     the end of `pending` can arrive in one render or in several. */
  useEffect(() => {
    const save = sent.current;
    if (save === null || current === save.over || pending) return;
    sent.current = null;
    if (caretIsFree(save.from)) select.current?.focus();
  });

  return (
    <div className="flex flex-wrap items-end gap-2">
      <RowField label="Role" qualifier={qualifier} id={id} labelHidden={labelHidden}>
        <select
          ref={select}
          id={id}
          className={INPUT}
          value={staged}
          disabled={pending}
          onChange={(event) => {
            // A new choice is a new question: the last Save's answer no longer moves the caret.
            sent.current = null;
            setStaged(event.target.value as ProjectRole);
          }}
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
        <Button
          size="sm"
          variant="secondary"
          disabled={pending}
          onClick={(event) => {
            sent.current = { over: current, from: event.currentTarget };
            onSave(staged);
          }}
        >
          Save{' '}
          <span className="sr-only">role {qualifier}</span>
        </Button>
      )}
    </div>
  );
}
