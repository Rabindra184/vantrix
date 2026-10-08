import { useEffect, useId, useRef, useState, type FormEvent, type RefObject } from 'react';
import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
  type QueryKey,
  type UseQueryResult,
} from '@tanstack/react-query';
import {
  PROJECT_ROLES,
  type AddMemberRequest,
  type AdminUser,
  type AdminUserListResponse,
  type ProjectMember,
  type ProjectRole,
} from '@perfportal/contracts';
import type { ProjectAccess } from '../access/useAccess';
import Button from '../components/Button';
import Card from '../components/Card';
import FormField from '../components/FormField';
import { SkeletonTable } from '../components/Skeleton';
import { EmptyState, ErrorState, LoadingState } from '../components/States';
import TableFrame from '../components/TableFrame';
import { INPUT, ROW, TABLE, TD, TH, THEAD } from '../components/tableStyles';
import { ProblemError } from '../api/fetch';
import { adminProjectsQueryKey, adminUsersQueryKey, fetchAdminUsers } from '../api/admin';
import { addMember, fetchProjectMembers, projectMembersQueryKey, removeMember, updateMember } from '../api/members';
import { projectsQueryKey } from '../api/projects';
import { sessionQueryKey, type Session } from '../api/session';
import { RefreshFailed, isRefusal } from './AdminShell';
import { PersonMarker, Problem, ROLE_LABEL, RoleChange, caretIsFree, nameWithEmailIfShared } from './AdminFields';
import ProjectShell from './ProjectShell';

/**
 * A project's Members: who holds which role in it.
 *
 * ═══ EVERYONE IN THE PROJECT READS IT; AN ADMIN CHANGES IT ═══
 *
 * Listing is `members:read`, which every role in the project has, so the table
 * is drawn for every reader the shell lets in. Adding, changing and removing
 * are `members:manage`, which only an install-wide admin holds — so the
 * controls for them (the Add member form, a Role select with its Save, a
 * Remove from project button, and the Actions column they sit in) are drawn
 * only when the shell's `access` allows it, and the list of every account they
 * need (`GET /v1/admin/users`, which refuses anyone else) is only then asked
 * for. The API refuses a write either way; hiding is for clarity. Until access
 * is known the table is drawn read-only — never a spinner waiting on it.
 *
 * ═══ ADDING IS A CHOICE, SO IT WAITS CLOSED ABOVE THE LIST ═══
 *
 * `ProjectRules`' "New rule": the list leads, and the form sits in a
 * disclosure over it — open when there is nobody to list.
 *
 * ═══ A REFUSAL SHOWS WHERE THE ACTION WAS TAKEN ═══
 *
 * In the API's own words — detail, then remediation — in the form for an add,
 * and on its own line under the row for a role change or a removal.
 *
 * ═══ EVERY CHANGE RE-READS WHAT IT MOVED ═══
 *
 * See `refreshAfter`. And, as on Administration's pages (ruling W14), a list
 * that has loaded stays on screen when a later read of it fails, with one
 * quiet line saying it may be out of date — the change that set off the read
 * had worked.
 */
export default function ProjectMembers() {
  return (
    <ProjectShell current="members">
      {({ slug, access }) => <MembersLoaded key={slug} slug={slug} access={access} />}
    </ProjectShell>
  );
}

/**
 * Re-reads what a change to `userId`'s membership has moved, and resolves once
 * it has: this project's members; Administration's two lists, which count each
 * account's projects and each project's members (ruling W7); and, when the
 * person changed is the reader, the project list, which carries the reader's
 * own role in each project.
 *
 * Awaited by every change before it settles, so a row, a Save or a form is
 * done only once the list on screen says what was done.
 */
async function refreshAfter(queryClient: QueryClient, slug: string, userId: string): Promise<void> {
  const keys: QueryKey[] = [projectMembersQueryKey(slug), adminUsersQueryKey, adminProjectsQueryKey];
  /* A cache read: this page sits under `AuthGate`, which has already fetched
     the session. Optional at every hop, as `AppShell` reads it. */
  const reader = queryClient.getQueryData<Session | null>(sessionQueryKey)?.user?.id;
  if (userId === reader) keys.push(projectsQueryKey);
  await Promise.all(keys.map((queryKey) => queryClient.invalidateQueries({ queryKey })));
}

function MembersLoaded({ slug, access }: { readonly slug: string; readonly access: ProjectAccess }) {
  const members = useQuery({ queryKey: projectMembersQueryKey(slug), queryFn: () => fetchProjectMembers(slug) });
  const manage = access.can('members:manage');
  const people = useQuery({ queryKey: adminUsersQueryKey, queryFn: fetchAdminUsers, enabled: manage });

  const table = useRef<HTMLTableElement>(null);
  const summary = useRef<HTMLElement>(null);

  /* ═══ A REMOVED MEMBER TAKES THE BUTTON THAT REMOVED THEM ═══
     Their row, and the Remove from project the caret was on, go once the
     re-read list leaves them out — so the caret goes to the table's own scroll
     region, the nearest thing left; or, the table gone with its last row, to
     Add member. Applied once the list on screen no longer holds them (or its
     re-read failed and it never will), and only while the caret is still on
     that button or lost to the page. */
  const [gone, setGone] = useState<{ readonly userId: string; readonly from: HTMLElement | null } | null>(null);
  const listed = members.data?.members;
  useEffect(() => {
    if (gone === null) return;
    if (listed?.some((member) => member.userId === gone.userId) === true && !members.isError) return;
    setGone(null);
    if (!caretIsFree(gone.from)) return;
    (table.current?.closest<HTMLElement>('[role="region"]') ?? summary.current)?.focus();
  }, [gone, listed, members.isError]);

  if (members.isPending) {
    return (
      <LoadingState label="Loading members…">
        <SkeletonTable columns={manage ? 4 : 3} rows={3} />
      </LoadingState>
    );
  }

  /* A list that never loaded — or a re-read the API refused, which says this
     session may not read it at all now (ruling W17). */
  if (members.data === undefined || isRefusal(members.error)) {
    const problem = members.error instanceof ProblemError ? members.error : null;
    return (
      <ErrorState
        title="The members could not be loaded"
        detail={problem?.detail ?? members.error?.message}
        remediation={problem?.remediation}
      />
    );
  }

  const everyone = members.data.members;
  return (
    <div className="flex flex-col gap-4">
      {manage && <AddMember slug={slug} members={everyone} people={people} summary={summary} />}
      {members.isError && <RefreshFailed />}
      {everyone.length === 0 ? (
        <EmptyState title="No members yet" />
      ) : (
        <MembersTable
          slug={slug}
          members={everyone}
          // The last list that loaded: a re-read that failed still names real accounts.
          accounts={manage ? people.data?.users : undefined}
          manage={manage}
          table={table}
          onGone={(userId, from) => setGone({ userId, from })}
        />
      )}
    </div>
  );
}

/**
 * The members, one row each, by name as the API orders them: name, email and
 * role for every reader; for an admin, the name's `Admin` and `Disabled` tags
 * (from the account behind the row), the role as a `RoleChange`, and an
 * Actions column.
 *
 * Every per-row control is named after its person (`nameWithEmailIfShared`):
 * "Role for Bo Member", "Save role for Bo Member", "Remove from project Bo
 * Member" — with the email after the name where another member shares it.
 */
function MembersTable({
  slug,
  members,
  accounts,
  manage,
  table,
  onGone,
}: {
  readonly slug: string;
  readonly members: readonly ProjectMember[];
  /** Every account in the install, for an admin once that list has loaded; otherwise `undefined`. */
  readonly accounts: readonly AdminUser[] | undefined;
  readonly manage: boolean;
  readonly table: RefObject<HTMLTableElement>;
  readonly onGone: (userId: string, from: HTMLElement | null) => void;
}) {
  const byId = new Map((accounts ?? []).map((account) => [account.id, account]));

  return (
    <TableFrame name="Members" label="Members table">
      <table ref={table} className={TABLE}>
        <caption className="sr-only">Members</caption>
        <thead className={THEAD}>
          <tr>
            <th scope="col" className={TH}>
              Name
            </th>
            <th scope="col" className={TH}>
              Email
            </th>
            <th scope="col" className={TH}>
              Role
            </th>
            {manage && (
              <th scope="col" className={TH}>
                Actions
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {members.map((member) =>
            manage ? (
              <ManagedRow
                key={member.userId}
                slug={slug}
                member={member}
                who={nameWithEmailIfShared(member, members)}
                account={byId.get(member.userId)}
                onGone={onGone}
              />
            ) : (
              <tr key={member.userId} className={ROW}>
                <td className={TD}>{member.name}</td>
                <td className={`${TD} break-all`}>{member.email}</td>
                <td className={TD}>{ROLE_LABEL[member.role]}</td>
              </tr>
            ),
          )}
        </tbody>
      </table>
    </TableFrame>
  );
}

type RowAction = { readonly kind: 'role'; readonly role: ProjectRole } | { readonly kind: 'remove' };

interface RowRequest {
  readonly action: RowAction;
  /** The control that sent it, which a refusal hands the caret back to. */
  readonly from: HTMLElement | null;
}

/**
 * One member's row, for an admin: a role picked, then saved, and Remove from
 * project, sent as it is pressed — the Administration panel's way with the
 * same two changes. One request at a time for the row: both lock while either
 * is in flight. A refusal is shown on a line of its own under the row.
 */
function ManagedRow({
  slug,
  member,
  who,
  account,
  onGone,
}: {
  readonly slug: string;
  readonly member: ProjectMember;
  /** The person as the table names them (ruling W6). */
  readonly who: string;
  /** The account behind the row, once Administration's list has it. */
  readonly account: AdminUser | undefined;
  readonly onGone: (userId: string, from: HTMLElement | null) => void;
}) {
  const queryClient = useQueryClient();
  const roleId = useId();
  /* The control a refused request came from, until the caret is handed back. */
  const [resume, setResume] = useState<HTMLElement | null>(null);

  const mutation = useMutation({
    mutationFn: ({ action }: RowRequest): Promise<unknown> =>
      action.kind === 'role'
        ? updateMember(slug, member.userId, { role: action.role })
        : removeMember(slug, member.userId),
    /* An option of the mutation, not of the call: a removal's row has unmounted
       by the time it settles, and a call's own callbacks would not run then. */
    onSuccess: async (_answer, { action, from }) => {
      await refreshAfter(queryClient, slug, member.userId);
      // A saved role needs nothing here: `RoleChange` hands the caret to its select.
      if (action.kind === 'remove') onGone(member.userId, from);
    },
    onError: (_error, { from }) => setResume(from),
  });
  const busy = mutation.isPending;

  /* ═══ A REFUSAL HANDS THE CARET BACK ═══
     The refused control stays — the Save with its choice still staged, or
     Remove from project — and is enabled again once the answer is in; a
     browser may have dropped the caret to the page as it was disabled. Only
     then, and only while nobody has taken the caret elsewhere. */
  useEffect(() => {
    if (resume === null || busy) return;
    setResume(null);
    if (resume.isConnected && caretIsFree(resume)) resume.focus();
  }, [resume, busy]);

  const run = (action: RowAction) => {
    if (busy) return;
    const active = document.activeElement;
    setResume(null);
    mutation.mutate({ action, from: active instanceof HTMLElement ? active : null });
  };

  return (
    <>
      <tr className={ROW}>
        <td className={TD}>
          {member.name}
          {account?.isAdmin === true && <PersonMarker>Admin</PersonMarker>}
          {account?.disabled === true && <PersonMarker>Disabled</PersonMarker>}
        </td>
        <td className={`${TD} break-all`}>{member.email}</td>
        <td className={TD}>
          {/* The column header says "Role", so the cell does not say it again. */}
          <RoleChange
            id={roleId}
            qualifier={`for ${who}`}
            current={member.role}
            pending={busy}
            onSave={(role) => run({ kind: 'role', role })}
            labelHidden
          />
        </td>
        <td className={TD}>
          {/* One click, as in the Administration panel: a membership removed by
              mistake is given back with Add member, and the person keeps their
              account and every other project. */}
          <Button
            size="sm"
            variant="ghost"
            loading={busy && mutation.variables?.action.kind === 'remove'}
            disabled={busy}
            onClick={() => run({ kind: 'remove' })}
          >
            Remove from project{' '}
            <span className="sr-only">{who}</span>
          </Button>
        </td>
      </tr>
      {mutation.isError && (
        <tr data-testid="member-problem" className="border-b border-divider last:border-0">
          <td colSpan={4} className="px-3 pt-1 pb-3">
            <Problem error={mutation.error} />
          </td>
        </tr>
      )}
    </>
  );
}

/**
 * Add member: a person from the install who holds no role in this project
 * yet, and the role they get — a Viewer unless the admin says otherwise
 * (ruling W5: least privilege, and anything more is a choice).
 *
 * ═══ THE FIRST PERSON NOT ALREADY HERE ═══
 * Ruling W12's rule for Add user's project rows, turned round: the Person
 * select offers only accounts that are not members, starting on the first. A
 * disabled account is offered too, and says so — a membership
 * waiting for an account to be enabled again is a real thing to set up. With
 * nobody left the form says so, and Add is disabled. Before the accounts have
 * loaded there is nothing to choose and nothing is claimed about anyone.
 *
 * The form stays open after an add, for the next person.
 */
function AddMember({
  slug,
  members,
  people,
  summary,
}: {
  readonly slug: string;
  readonly members: readonly ProjectMember[];
  readonly people: UseQueryResult<AdminUserListResponse, Error>;
  readonly summary: RefObject<HTMLElement>;
}) {
  const queryClient = useQueryClient();
  const base = useId();
  const personId = `${base}-person`;
  const roleId = `${base}-role`;
  const addId = `${base}-add`;
  const nobodyId = `${base}-nobody`;

  /* Closed or open once the reader has said so; until then, open only while
     there is nobody to list — `ProjectRules`' rule, so the first add does not
     shut the form under the reader. */
  const [open, setOpen] = useState<boolean | null>(null);
  /* The reader's own choice of person, if they have made one. Not the select's
     value: that is derived below, so somebody just added cannot stay chosen. */
  const [personChoice, setPersonChoice] = useState<string | null>(null);
  const [role, setRole] = useState<ProjectRole>('viewer');

  const memberIds = new Set(members.map((member) => member.userId));
  /* `undefined` while there is no list of accounts — never `!isSuccess`: a
     re-read that failed keeps the list it had, and those are still real
     people to add (ruling W14). */
  const candidates = people.data?.users.filter((person) => !memberIds.has(person.id));
  const chosen = candidates?.find((person) => person.id === personChoice) ?? candidates?.[0];
  const nobodyLeft = candidates !== undefined && candidates.length === 0;

  const mutation = useMutation({
    mutationFn: (body: AddMemberRequest) => addMember(slug, body),
    onSuccess: async (_member, body) => {
      await refreshAfter(queryClient, slug, body.userId);
      setPersonChoice(null);
      setRole('viewer');
    },
  });

  /* ═══ WHERE THE CARET GOES ONCE AN ADD IS ANSWERED ═══
     Added: the Person select, on the next person — or, with nobody left, the
     summary. Refused: back to the control it was sent from. The pressed Add is
     disabled while the request is in flight, which a browser may answer by
     dropping the caret to the page; it is moved only while it is still there,
     or on the control that sent it. */
  const [next, setNext] = useState<{
    readonly targets: readonly (() => HTMLElement | null)[];
    readonly from: HTMLElement | null;
  } | null>(null);
  useEffect(() => {
    if (next === null || mutation.isPending) return;
    setNext(null);
    if (!caretIsFree(next.from)) return;
    for (const target of next.targets) {
      const element = target();
      if (element !== null && element.isConnected && !element.matches(':disabled')) {
        element.focus();
        return;
      }
    }
  }, [next, mutation.isPending]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (mutation.isPending || chosen === undefined) return;
    const active = document.activeElement;
    const from = active instanceof HTMLElement ? active : null;
    setNext(null);
    mutation.mutate(
      { userId: chosen.id, role },
      {
        onSuccess: () =>
          setNext({ targets: [() => document.getElementById(personId), () => summary.current], from }),
        onError: () => setNext({ targets: [() => from, () => document.getElementById(addId)], from }),
      },
    );
  };

  return (
    <Card as="div">
      <details open={open ?? members.length === 0} onToggle={(event) => setOpen(event.currentTarget.open)}>
        <summary
          ref={summary}
          className="cursor-pointer list-none text-[0.8125rem] font-medium text-primary marker:hidden"
        >
          {/* "Add member", NOT "Add": the submit button inside carries that
              name, and two controls sharing one is the duplicate-name defect. */}
          Add member
        </summary>
        <form className="mt-3 flex flex-col gap-3" onSubmit={submit}>
          <div className="flex flex-wrap items-end gap-3">
            <FormField label="Person" id={personId}>
              <select
                id={personId}
                className={INPUT}
                value={chosen?.id ?? ''}
                disabled={chosen === undefined || mutation.isPending}
                aria-describedby={nobodyLeft ? nobodyId : undefined}
                onChange={(event) => setPersonChoice(event.target.value)}
              >
                {(candidates ?? []).map((person) => (
                  <option key={person.id} value={person.id}>
                    {`${person.name} (${person.email})${person.disabled ? ' — disabled' : ''}`}
                  </option>
                ))}
              </select>
            </FormField>
            <FormField label="Role" id={roleId}>
              <select
                id={roleId}
                className={INPUT}
                value={role}
                disabled={mutation.isPending}
                onChange={(event) => setRole(event.target.value as ProjectRole)}
              >
                {PROJECT_ROLES.map((option) => (
                  <option key={option} value={option}>
                    {ROLE_LABEL[option]}
                  </option>
                ))}
              </select>
            </FormField>
            {/* The page's one primary button. */}
            <Button
              id={addId}
              type="submit"
              variant="primary"
              loading={mutation.isPending}
              disabled={chosen === undefined}
              aria-describedby={nobodyLeft ? nobodyId : undefined}
            >
              Add
            </Button>
          </div>
          {/* Why Add is disabled, in words — the one thing to act on is
              elsewhere (a new account, under Administration). */}
          {nobodyLeft && (
            <p id={nobodyId} className="text-[0.8125rem] text-muted">
              Everyone is already a member.
            </p>
          )}
          {/* The accounts could not be listed, so nobody can be chosen: the
              API's own words for why. */}
          {people.data === undefined && people.isError && <Problem error={people.error} />}
          {mutation.isError && <Problem error={mutation.error} />}
        </form>
      </details>
    </Card>
  );
}
