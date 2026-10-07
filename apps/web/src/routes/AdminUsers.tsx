import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import {
  CreateUserRequestSchema,
  PROJECT_ROLES,
  type AdminProjectListResponse,
  type AdminUser,
  type ProjectRole,
} from '@perfportal/contracts';
import Button from '../components/Button';
import Card from '../components/Card';
import FormField, { errorId } from '../components/FormField';
import InfoTip from '../components/InfoTip';
import { SkeletonTable } from '../components/Skeleton';
import { ErrorState, LoadingState } from '../components/States';
import TableFrame from '../components/TableFrame';
import { PlusIcon } from '../components/icons';
import { INPUT, ROW, TABLE, TD, TH, THEAD } from '../components/tableStyles';
import { ProblemError } from '../api/fetch';
import {
  adminProjectsQueryKey,
  adminUsersQueryKey,
  createUser,
  fetchAdminProjects,
  fetchAdminUsers,
} from '../api/admin';
import { getSession, sessionQueryKey } from '../api/session';
import { fieldMessages } from '../formIssues';
import AdminShell from './AdminShell';

/**
 * Administration › Users: every account in the install, and the form that
 * adds one.
 *
 * The list is the page; adding is a choice, so the form sits closed above the
 * table (`ProjectRules`' "New rule"). A session refused the list
 * (`403 ADMIN_REQUIRED`) sees the API's own refusal under the heading and
 * nothing else — the form would only be refused too.
 */
export default function AdminUsers() {
  const users = useQuery({ queryKey: adminUsersQueryKey, queryFn: fetchAdminUsers });
  const projects = useQuery({ queryKey: adminProjectsQueryKey, queryFn: fetchAdminProjects });
  /* A cache read: this page sits under `AuthGate`, which has already fetched
     the session. Optional at every hop, as `AppShell` reads it. */
  const session = useQuery({ queryKey: sessionQueryKey, queryFn: getSession });
  const currentUserId = session.data?.user?.id ?? null;

  return (
    <AdminShell current="users">
      {users.isPending ? (
        <LoadingState label="Loading users…">
          <SkeletonTable columns={4} />
        </LoadingState>
      ) : users.isError ? (
        <ErrorState
          title="Users could not be loaded"
          detail={users.error instanceof ProblemError ? users.error.detail : users.error.message}
          remediation={users.error instanceof ProblemError ? users.error.remediation : undefined}
        />
      ) : (
        <div className="flex flex-col gap-4">
          <AddUserForm projects={projects} />
          <UsersTable users={users.data.users} currentUserId={currentUserId} />
        </div>
      )}
    </AdminShell>
  );
}

/** A role as the reader sees it: the enum's own word, capitalised. */
const ROLE_LABEL: Record<ProjectRole, string> = {
  viewer: 'Viewer',
  member: 'Member',
  manager: 'Manager',
};

/**
 * One word per account (ruling W4), in this order: an account that cannot
 * sign in is Disabled whatever else is true of it, and only then does a
 * password nobody chose make it Must change password.
 */
function statusOf(user: AdminUser): string {
  if (user.disabled) return 'Disabled';
  if (user.mustChangePassword) return 'Must change password';
  return 'Active';
}

/** Two display names a screen reader would read alike: case and spacing aside. */
const spoken = (name: string): string => name.trim().replace(/\s+/g, ' ').toLocaleLowerCase();

/**
 * The accounts, one row each: name (with an Admin badge), email, how many
 * projects they hold a role in, and their status.
 *
 * `currentUserId` is the signed-in admin's own id, from the session. Nothing
 * in this table reads it yet; it is part of the props for the row actions,
 * several of which the API refuses on your own account.
 */
export function UsersTable({
  users,
}: {
  readonly users: readonly AdminUser[];
  readonly currentUserId: string | null;
}) {
  /* ═══ ONE NAME PER INFO BUTTON (ruling W6) ═══
     Display names are not unique and emails are. Every row's ⓘ is named after
     its person, so two people called Sam Lee would give the table two buttons
     with one name — the duplicate-name defect this repo has paid for three
     times. The email joins the name on those rows only; everywhere else the
     name is the plain one. */
  const seen = new Map<string, number>();
  for (const user of users) seen.set(spoken(user.name), (seen.get(spoken(user.name)) ?? 0) + 1);
  const labelOf = (user: AdminUser): string =>
    (seen.get(spoken(user.name)) ?? 0) > 1 ? `${user.name} (${user.email}): projects` : `${user.name}: projects`;

  return (
    <TableFrame name="Users" label="Users table">
      <table className={TABLE}>
        <caption className="sr-only">Users</caption>
        <thead className={THEAD}>
          <tr>
            <th scope="col" className={TH}>
              Name
            </th>
            <th scope="col" className={TH}>
              Email
            </th>
            <th scope="col" className={TH}>
              Projects
            </th>
            <th scope="col" className={TH}>
              Status
            </th>
          </tr>
        </thead>
        <tbody>
          {users.map((user) => (
            <tr key={user.id} className={ROW}>
              <td className={TD}>
                {user.name}
                {/* A TEXT NODE between the two, not only the margin: a margin
                    moves pixels, and a copy or a screen reader would read
                    "Ada AdminAdmin". */}
                {user.isAdmin && (
                  <>
                    {' '}
                    <span className="ml-1 rounded-md border border-default bg-sunken px-1.5 py-0.5 text-[0.75rem] text-muted">
                      Admin
                    </span>
                  </>
                )}
              </td>
              <td className={`${TD} break-all`}>{user.email}</td>
              <td className={TD}>
                <span className="inline-flex items-center gap-1">
                  {user.memberships.length}
                  {/* Drawn only when there is something to list (ruling W10):
                      an ⓘ behind a 0 would open onto nothing. */}
                  {user.memberships.length > 0 && (
                    <InfoTip label={labelOf(user)}>
                      <ul>
                        {user.memberships.map((membership) => (
                          <li key={membership.projectSlug}>
                            {membership.projectName} · {ROLE_LABEL[membership.role]}
                          </li>
                        ))}
                      </ul>
                    </InfoTip>
                  )}
                </span>
              </td>
              <td className={TD}>{statusOf(user)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableFrame>
  );
}

/* ======================================================================== *
 * ADD USER
 * ======================================================================== */

/** One project row on the form; `key` is the row's own, stable across removals. */
interface ProjectRow {
  readonly key: number;
  readonly projectSlug: string;
  readonly role: ProjectRole;
}

/** The fields the schema can refuse outside the project rows, top to bottom. */
const TOP_FIELDS = ['email', 'name', 'password'] as const;

/** The form's own name for a row's field, keyed by the row rather than its position. */
const rowField = (key: number, part: 'projectSlug' | 'role'): string => `row-${key}-${part}`;

interface Refusal {
  /** The message for each refused field, by the form's own field names. */
  readonly fields: Readonly<Record<string, string>>;
  /** A message no field of this form owns. */
  readonly form: string | null;
  /** The first refused field, top to bottom — where the caret goes. */
  readonly first: string | null;
}

const EMPTY = { email: '', name: '', password: '' };

/**
 * Add a user: an email, a name, a temporary password they must replace at
 * first sign-in, whether they are an admin, and the projects they hold a role
 * in.
 *
 * ═══ VALIDATED HERE, AND WHAT IS SENT IS WHAT THE SCHEMA PARSED ═══
 *
 * `CreateUserRequestSchema` checks the draft before anything is sent, and each
 * issue is shown under the field its path names, in the words `formIssues`
 * chooses (a password bound is one sentence, never zod's own English). On
 * success the PARSED body is posted — the email trimmed and lowercased, the
 * defaults applied — so the request is what the contract produced rather than
 * what was typed.
 *
 * A row's issue arrives keyed by its POSITION (`projects.1.projectSlug`) and is
 * filed under the row's own key, so removing a row after a refusal does not
 * move another row's message onto it.
 */
function AddUserForm({ projects }: { readonly projects: UseQueryResult<AdminProjectListResponse, Error> }) {
  const queryClient = useQueryClient();
  const base = useId();
  const idOf = (field: string): string => `${base}-${field}`;

  const [values, setValues] = useState(EMPTY);
  const [isAdmin, setIsAdmin] = useState(false);
  const [rows, setRows] = useState<readonly ProjectRow[]>([]);
  const nextKey = useRef(0);
  /* A FRESH OBJECT on every refusal, so pressing again over the same mistake
     re-runs the focus effect and pulls the caret back. */
  const [refused, setRefused] = useState<Refusal | null>(null);
  /* Closed until the reader opens it. Controlled, so a successful create can
     close it — and the toggle the browser fires when React writes `open`
     keeps this in step either way. */
  const [open, setOpen] = useState(false);
  const summary = useRef<HTMLElement>(null);

  const projectList = projects.data?.projects ?? [];
  const chosen = new Set(rows.map((row) => row.projectSlug));
  /* ═══ A NEW ROW IS THE NEXT PROJECT NOBODY HAS CHOSEN (ruling W12) ═══
     An empty select would be refused in zod's default English, so a row never
     starts empty: it takes the first project not already on the form, as a
     Viewer (ruling W5). With none left — or no list yet — there is nothing to
     add, and the button says so by being disabled. */
  const nextProject = projects.isSuccess ? projectList.find((p) => !chosen.has(p.slug)) : undefined;

  const mutation = useMutation({
    mutationFn: createUser,
    /* BOTH LISTS, because a new account's project rows move the Projects
       table's member counts too (ruling W7). Awaited, so the form closes as
       the new row arrives rather than before it. */
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: adminUsersQueryKey }),
        queryClient.invalidateQueries({ queryKey: adminProjectsQueryKey }),
      ]);
      setValues(EMPTY);
      setIsAdmin(false);
      setRows([]);
      setRefused(null);
      setOpen(false);
      /* The submit just went inside a closed disclosure, which would leave
         the caret nowhere; the summary is what opens the form again. */
      summary.current?.focus();
    },
  });

  useEffect(() => {
    if (refused?.first == null) return;
    document.getElementById(`${base}-${refused.first}`)?.focus();
  }, [refused, base]);

  /* Chosen again from the rows as they ARE, not from this render's
     `nextProject`: two presses before a re-render would otherwise both take
     the same project. */
  const addRow = () =>
    setRows((current) => {
      const taken = new Set(current.map((row) => row.projectSlug));
      const next = projectList.find((p) => !taken.has(p.slug));
      return next === undefined ? current : [...current, { key: nextKey.current++, projectSlug: next.slug, role: 'viewer' }];
    });

  const updateRow = (key: number, change: Partial<Omit<ProjectRow, 'key'>>) =>
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...change } : row)));

  const removeRow = (key: number) => setRows((current) => current.filter((row) => row.key !== key));

  /** The form's field name for an issue's path, or null for one it does not draw. */
  const fieldFor = (path: string): string | null => {
    if ((TOP_FIELDS as readonly string[]).includes(path)) return path;
    const match = /^projects\.(\d+)\.(projectSlug|role)$/.exec(path);
    const row = match === null ? undefined : rows[Number(match[1])];
    if (match === null || row === undefined) return null;
    return rowField(row.key, match[2] as 'projectSlug' | 'role');
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (mutation.isPending) return;
    // A refusal from the last press describes a request this one replaces.
    mutation.reset();

    const parsed = CreateUserRequestSchema.safeParse({
      email: values.email,
      name: values.name,
      password: values.password,
      isAdmin,
      projects: rows.map(({ projectSlug, role }) => ({ projectSlug, role })),
    });
    if (!parsed.success) {
      const fields: Record<string, string> = {};
      let form: string | null = null;
      for (const [path, message] of Object.entries(fieldMessages(parsed.error.issues))) {
        const field = fieldFor(path);
        if (field === null) form ??= message;
        else fields[field] ??= message;
      }
      const order = [...TOP_FIELDS, ...rows.flatMap((row) => [rowField(row.key, 'projectSlug'), rowField(row.key, 'role')])];
      setRefused({ fields, form, first: order.find((field) => fields[field] !== undefined) ?? null });
      return;
    }
    setRefused(null);
    mutation.mutate(parsed.data);
  };

  const errorOf = (field: string): string | undefined => refused?.fields[field];
  /** What every refusable control carries, so the message is announced with it. */
  const marked = (field: string) => {
    const error = errorOf(field);
    return {
      id: idOf(field),
      'aria-invalid': error !== undefined || undefined,
      'aria-describedby': error === undefined ? undefined : errorId(idOf(field)),
    };
  };

  const problem = mutation.error instanceof ProblemError ? mutation.error : null;
  const formMessage = refused?.form ?? null;

  return (
    <Card as="div">
      <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
        <summary
          ref={summary}
          className="cursor-pointer list-none text-[0.8125rem] font-medium text-primary marker:hidden"
        >
          Add user
        </summary>
        <form className="mt-3 flex flex-col gap-4" onSubmit={submit}>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            {/* `autoComplete="off"` on all three: these describe SOMEONE ELSE,
                and a browser offering the admin's own address, name or saved
                password here would fill in the wrong account. */}
            <FormField label="Email" id={idOf('email')} error={errorOf('email')}>
              <input
                {...marked('email')}
                type="email"
                autoComplete="off"
                className={INPUT}
                value={values.email}
                onChange={(event) => {
                  const next = event.target.value;
                  setValues((current) => ({ ...current, email: next }));
                }}
                required
              />
            </FormField>
            <FormField label="Name" id={idOf('name')} error={errorOf('name')}>
              <input
                {...marked('name')}
                autoComplete="off"
                className={INPUT}
                value={values.name}
                onChange={(event) => {
                  const next = event.target.value;
                  setValues((current) => ({ ...current, name: next }));
                }}
                required
              />
            </FormField>
            {/* ═══ SHOWN, NOT MASKED (ruling W11) ═══
                The admin types this to read it back to its owner, who replaces
                it at first sign-in — so it is plain text, and nothing offers to
                fill it, save it, spell-check it or capitalise its first letter. */}
            <FormField label="Temporary password" id={idOf('password')} error={errorOf('password')}>
              <input
                {...marked('password')}
                type="text"
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                className={INPUT}
                value={values.password}
                onChange={(event) => {
                  const next = event.target.value;
                  setValues((current) => ({ ...current, password: next }));
                }}
                required
              />
            </FormField>
          </div>

          <label className="inline-flex items-center gap-2 text-[0.8125rem] font-medium text-primary">
            <input type="checkbox" checked={isAdmin} onChange={(event) => setIsAdmin(event.target.checked)} />
            Admin
          </label>

          {rows.map((row, index) => (
            <div key={row.key} className="flex flex-wrap items-start gap-3">
              <RowField
                label="Project"
                position={index + 1}
                id={idOf(rowField(row.key, 'projectSlug'))}
                error={errorOf(rowField(row.key, 'projectSlug'))}
              >
                <select
                  {...marked(rowField(row.key, 'projectSlug'))}
                  className={INPUT}
                  value={row.projectSlug}
                  onChange={(event) => updateRow(row.key, { projectSlug: event.target.value })}
                >
                  {projectList.map((project) => (
                    <option key={project.slug} value={project.slug}>
                      {project.name}
                    </option>
                  ))}
                </select>
              </RowField>
              <RowField
                label="Role"
                position={index + 1}
                id={idOf(rowField(row.key, 'role'))}
                error={errorOf(rowField(row.key, 'role'))}
              >
                <select
                  {...marked(rowField(row.key, 'role'))}
                  className={INPUT}
                  value={row.role}
                  onChange={(event) => updateRow(row.key, { role: event.target.value as ProjectRole })}
                >
                  {PROJECT_ROLES.map((role) => (
                    <option key={role} value={role}>
                      {ROLE_LABEL[role]}
                    </option>
                  ))}
                </select>
              </RowField>
              {/* `mt-6` drops it past the labels, beside the selects. Named
                  after the row's position, so two rows give two different names —
                  a project's NAME could repeat (two rows on one project, or
                  two projects sharing a name), a position cannot. */}
              <Button size="sm" variant="ghost" className="mt-6" onClick={() => removeRow(row.key)}>
                Remove{' '}
                <span className="sr-only">project {index + 1}</span>
              </Button>
            </div>
          ))}

          <div>
            <Button size="sm" onClick={addRow} disabled={nextProject === undefined}>
              <PlusIcon className="h-3.5 w-3.5" />
              Add project
            </Button>
          </div>

          {(formMessage !== null || mutation.isError) && (
            <div role="alert" className="rounded-lg border border-default bg-sunken p-3 text-[0.8125rem] text-primary">
              {formMessage ?? problem?.detail ?? mutation.error?.message}
              {formMessage === null && problem?.remediation && <p className="mt-1 text-muted">{problem.remediation}</p>}
            </div>
          )}

          <div>
            <Button type="submit" variant="primary" loading={mutation.isPending}>
              Create user
            </Button>
          </div>
        </form>
      </details>
    </Card>
  );
}

/**
 * One field of a project row: `FormField`'s label and error line, with the
 * row's position in the label for a screen reader only.
 *
 * ═══ "Project", READ AS "Project 2" ═══
 * Two rows give the form two Project selects and two Role selects, and a
 * label each of "Project" would leave a screen-reader user unable to tell them
 * apart. The position is in the accessible name, after the visible word, so
 * what is seen is still what is said first.
 */
function RowField({
  label,
  position,
  id,
  error,
  children,
}: {
  readonly label: string;
  readonly position: number;
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
        <span className="sr-only">{position}</span>
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
