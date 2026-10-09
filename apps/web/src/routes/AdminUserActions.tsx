import { useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  PROJECT_ROLES,
  SetPasswordRequestSchema,
  type AdminProject,
  type AdminUser,
  type ProjectRole,
  type UpdateUserRequest,
} from '@perfportal/contracts';
import Button from '../components/Button';
import FormField, { errorId } from '../components/FormField';
import { MoreIcon } from '../components/icons';
import { INPUT } from '../components/tableStyles';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../components/ui/dropdown-menu';
import { adminProjectsQueryKey, adminUsersQueryKey, removeUser, resetUserPassword, updateUser } from '../api/admin';
import { addMember, removeMember, updateMember } from '../api/members';
import { fieldMessages } from '../formIssues';
import { Problem, ROLE_LABEL, RoleChange, RowField, caretIsFree } from './AdminFields';

/**
 * Administration › Users: what each row can do — its menu, and the one inline
 * block that menu can open under the row.
 *
 * ═══ ONE BLOCK AT A TIME, ACROSS THE WHOLE TABLE (ruling W15) ═══
 *
 * A Disable or Remove confirm, the confirm before removing your own admin
 * rights, the Reset password block, or the Edit projects and roles panel.
 * `UsersTable` owns the single `Armed` value — `ProjectRules`'
 * `confirming`, and `ProjectPackages`' `armed` — so arming a block on one row
 * closes whatever was open on any other, and two destructive confirmations, or
 * two sets of the same controls, are never on screen together.
 *
 * ═══ EVERY CHANGE RE-READS BOTH LISTS (ruling W7) ═══
 *
 * A role or an account change moves the Users table's project counts and the
 * Projects table's member counts alike, so each success invalidates both keys,
 * and a confirm or the Reset password block closes only once they have been
 * re-read — the row the reader returns to already says what they did. The
 * edit panel stays open for the next change.
 *
 * ═══ A REFUSAL ALWAYS REACHES ITS ROW (ruling W7) ═══
 *
 * Only the row with a request in flight locks; every other row's menu stays
 * live, so a reader can arm another row's block — closing the one the request
 * came from — before the answer arrives. A refusal shows in its block while
 * that block is open, and otherwise on the row's own line under it.
 */

/** `demote` is the signed-in admin removing their own admin rights. */
export type ArmedMode = 'disable' | 'remove' | 'demote' | 'reset' | 'edit';

/** The one row with a block open, and which block. */
export interface Armed {
  readonly userId: string;
  readonly mode: ArmedMode;
}

type RowAction =
  | { readonly kind: 'update'; readonly body: UpdateUserRequest }
  | { readonly kind: 'reset'; readonly password: string }
  | { readonly kind: 'remove' }
  | { readonly kind: 'role'; readonly slug: string; readonly role: ProjectRole }
  | { readonly kind: 'leave'; readonly slug: string }
  | { readonly kind: 'join'; readonly slug: string; readonly role: ProjectRole };

interface RowRequest {
  readonly action: RowAction;
  /** The block it was sent from — `null` for the menu itself. A refusal is
   *  shown in that block while it is open, and on the row's own line when the
   *  block had already closed by the time the refusal arrived. */
  readonly from: ArmedMode | null;
  /** The control that sent it, which a refusal hands the caret back to. */
  readonly resume: HTMLElement | null;
}

/**
 * Where the caret goes once a request settles: the first of `targets` (an
 * element id, or the element itself) that is drawn and enabled by then.
 */
interface NextFocus {
  readonly targets: readonly (string | HTMLElement)[];
  /** The control that sent the request. The move is made only while the caret
   *  is still on it, or has been lost to the page — a reader who has taken it
   *  somewhere else since keeps it there. */
  readonly from: HTMLElement | null;
}

function send(userId: string, action: RowAction): Promise<unknown> {
  switch (action.kind) {
    case 'update':
      return updateUser(userId, action.body);
    case 'reset':
      return resetUserPassword(userId, { password: action.password });
    case 'remove':
      return removeUser(userId);
    case 'role':
      return updateMember(action.slug, userId, { role: action.role });
    case 'leave':
      return removeMember(action.slug, userId);
    case 'join':
      return addMember(action.slug, { userId, role: action.role });
  }
}

/**
 * One row's actions, handed back to the table as two pieces: the menu, for the
 * row's own Actions cell, and the details (an open block, or the menu's
 * refusal), for a full-width line under the row — or `null` when there is
 * nothing to show. The table draws both, so the cells stay where they are.
 */
export function UserActions({
  user,
  who,
  own,
  armed,
  onArm,
  onGone,
  projects,
  children,
}: {
  readonly user: AdminUser;
  /** The person as the table names them: their name, or name and email where
   *  another row shares the name (ruling W6). */
  readonly who: string;
  /** The signed-in admin's own row, where the API refuses Disable, Reset
   *  password and Remove — so they are not offered — and where a change to
   *  the admin flag is also a change to the session (ruling W17). */
  readonly own: boolean;
  readonly armed: Armed | null;
  readonly onArm: (next: Armed | null) => void;
  /** Called once this account is removed: its row, and the menu the caret
   *  would return to, are gone. */
  readonly onGone: () => void;
  /** Every project in the install, or `undefined` before the list has loaded. */
  readonly projects: readonly AdminProject[] | undefined;
  readonly children: (menu: ReactNode, details: ReactNode | null) => ReactNode;
}) {
  const queryClient = useQueryClient();
  const base = useId();
  const idOf = (part: string): string => `${base}-${part}`;
  const triggerId = idOf('menu');
  const roleId = (slug: string): string => idOf(`role-${encodeURIComponent(slug)}`);
  const trigger = useRef<HTMLButtonElement>(null);

  const mode = armed?.userId === user.id ? armed.mode : null;
  /** The latest `mode`, for a callback that outlives the render it was made in.
   *  Written in an effect, never during render. */
  const latestMode = useRef(mode);
  useEffect(() => {
    latestMode.current = mode;
  }, [mode]);

  /* ═══ THE CARET'S NEXT STOP, APPLIED ONCE THE ROW IS DRAWN AGAIN ═══
     A control is disabled while its request is in flight, and a browser that
     drops focus from a control as it is disabled leaves the caret on the page.
     The control a request came from can also go with the answer (a block that
     closes, a project's line that is removed). So a settled request names
     where the caret should go — back to the control that sent it, or to what
     replaced it — and this applies it after the render that re-enables it, or
     after the one that draws it at all (a new membership's line arrives with
     the refetch, not with the answer). */
  const [nextFocus, setNextFocus] = useState<NextFocus | null>(null);

  /* The request whose refusal arrived after the block it came from had closed
     (another row's block was armed meanwhile). Its refusal is drawn on the
     row's own line rather than nowhere. Held as the request itself: TanStack
     hands `onError` the same object `mutation.variables` then holds, so a
     later request on this row, or a reset, stops it matching on its own. */
  const [strayed, setStrayed] = useState<RowRequest | null>(null);

  const mutation = useMutation({
    mutationFn: ({ action }: RowRequest) => send(user.id, action),
    onSuccess: async (_data, { action, from, resume }) => {
      /* Your own admin flag is also your session's, and it decides what every
         org-wide read shows you: the account menu offers Administration from
         it (ruling W17), and an admin's rail, Home and run lists span the
         whole org where a member's span their own projects. So changing it
         re-reads EVERYTHING cached, not a list of keys — a key left off that
         list is a rail still offering projects the reader can no longer
         open. Anyone else's change moves the two lists alone. */
      const ownAdminFlag = own && action.kind === 'update' && action.body.isAdmin !== undefined;
      await (ownAdminFlag
        ? queryClient.invalidateQueries()
        : Promise.all([
            queryClient.invalidateQueries({ queryKey: adminUsersQueryKey }),
            queryClient.invalidateQueries({ queryKey: adminProjectsQueryKey }),
          ]));
      // Only if the block it came from is still the open one. A reader who has
      // opened another since must not have it closed, or their caret taken, by
      // the answer to a question they have moved on from.
      if (latestMode.current !== from) return;
      switch (action.kind) {
        case 'remove':
          onArm(null);
          // The row goes with the account, and the menu the caret would have
          // gone back to with it.
          if (caretIsFree(resume)) onGone();
          return;
        case 'update':
        case 'reset':
          // From the menu there is no block, and Radix has already handed the
          // caret back to the trigger.
          if (from === null) return;
          onArm(null);
          setNextFocus({ targets: [triggerId], from: resume });
          return;
        case 'role':
          // Nothing to aim: the Save it was sent from goes once the re-read
          // list holds the role it set, and `RoleChange` hands the caret to
          // its own select then (ruling P12).
          return;
        case 'leave':
          // The pressed button left with its line; what can add it back is next.
          setNextFocus({ targets: [idOf('add-project'), idOf('close')], from: resume });
          return;
        case 'join':
          setNextFocus({ targets: [roleId(action.slug)], from: resume });
          return;
      }
    },
    onError: (_error, request) => {
      const { from, resume } = request;
      // The block it came from has closed: the refusal goes on the row's line,
      // and the caret stays wherever the reader has taken it since.
      if (latestMode.current !== from) {
        setStrayed(request);
        return;
      }
      setNextFocus({ targets: resume === null ? [triggerId] : [resume, triggerId], from: resume });
    },
  });

  useEffect(() => {
    if (nextFocus === null || mutation.isPending) return;
    if (!caretIsFree(nextFocus.from)) {
      setNextFocus(null);
      return;
    }
    for (const target of nextFocus.targets) {
      const element = typeof target === 'string' ? document.getElementById(target) : target.isConnected ? target : null;
      if (element !== null && !element.matches(':disabled')) {
        element.focus();
        setNextFocus(null);
        return;
      }
    }
  }, [nextFocus, mutation.isPending, user]);

  const busy = mutation.isPending;
  const pending = busy ? mutation.variables : undefined;

  const run = (action: RowAction, from: ArmedMode | null, onDone?: () => void) => {
    const active = document.activeElement;
    setNextFocus(null);
    mutation.mutate(
      { action, from, resume: active instanceof HTMLElement ? active : null },
      onDone === undefined ? undefined : { onSuccess: onDone },
    );
  };

  /** Opens a block on this row, from nothing: an old refusal is not waiting
   *  in it. Never reached mid-request — the menu is disabled while busy. */
  const arm = (next: ArmedMode) => {
    mutation.reset();
    setNextFocus(null);
    onArm({ userId: user.id, mode: next });
  };

  /** Leaves the block, and puts the caret on the one control still there:
   *  the block it was in is about to unmount under it. */
  const close = () => {
    mutation.reset();
    setNextFocus(null);
    onArm(null);
    trigger.current?.focus();
  };

  const menu = (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        {/* NAMED AFTER ITS ROW (ruling W6). A table of people is a table of
            these, and a dozen controls called "More" is the duplicate-name
            defect this repo has paid for three times. Never disabled: it holds
            the caret, and a disabled control can lose it. Its items are what
            lock while a request is in flight. */}
        <button
          ref={trigger}
          id={triggerId}
          type="button"
          aria-label={`${who}: more actions`}
          className="transition-ui inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted hover:bg-sunken hover:text-primary data-[state=open]:bg-sunken data-[state=open]:text-primary [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11"
        >
          <MoreIcon className="h-4 w-4" aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      {/* No `onCloseAutoFocus` opt-out: a chosen item's block takes the caret
          as it mounts, and a non-modal Radix menu then skips handing it back
          to the trigger (`ProjectPackages` records the measurement). */}
      <DropdownMenuContent align="end" className="w-[14rem]">
        <DropdownMenuItem disabled={busy} onSelect={() => arm('edit')}>
          Edit projects and roles
        </DropdownMenuItem>
        {!own && (
          <DropdownMenuItem disabled={busy} onSelect={() => arm('reset')}>
            Reset password
          </DropdownMenuItem>
        )}
        {/* Enable undoes something and asks nothing; Disable signs a person out
            everywhere, so it asks first. */}
        {user.disabled ? (
          <DropdownMenuItem disabled={busy} onSelect={() => run({ kind: 'update', body: { disabled: false } }, null)}>
            Enable
          </DropdownMenuItem>
        ) : (
          !own && (
            <DropdownMenuItem disabled={busy} onSelect={() => arm('disable')}>
              Disable
            </DropdownMenuItem>
          )
        )}
        {/* Applied at once — the last-admin rule is the API's, and its 409
            comes back to this row in its own words — except your own Remove
            admin, which asks first: it takes Administration away from the
            reader at once, and nothing on this page can give it back. */}
        <DropdownMenuItem
          disabled={busy}
          onSelect={() =>
            own && user.isAdmin ? arm('demote') : run({ kind: 'update', body: { isAdmin: !user.isAdmin } }, null)
          }
        >
          {user.isAdmin ? 'Remove admin' : 'Make admin'}
        </DropdownMenuItem>
        {!own && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled={busy} onSelect={() => arm('remove')}>
              Remove
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );

  /* A refusal is shown where its request was made: in the block, while that
     block is open; on the row's own line for an action taken straight from the
     menu, or one whose block had closed before the refusal arrived. A block
     that closes after its refusal has been shown in it takes the refusal with
     it. */
  const failed = mutation.isError ? mutation.variables : undefined;
  const blockError = mode !== null && failed?.from === mode ? mutation.error : null;
  const lineError = failed !== undefined && (failed.from === null || failed === strayed) ? mutation.error : null;
  const loading = pending !== undefined && pending.from === mode;

  /* The questions name the person as every other per-row name does, by `who`
     (ruling W6): the question names the confirm's group, so two people sharing
     a display name would otherwise be asked about in identical words. */
  let block: ReactNode = null;
  if (mode === 'disable') {
    block = (
      <Confirm
        question={`Disable ${who}? They are signed out everywhere.`}
        confirm="Disable"
        busy={busy}
        loading={loading}
        error={blockError}
        onConfirm={() => run({ kind: 'update', body: { disabled: true } }, 'disable')}
        onCancel={close}
      />
    );
  } else if (mode === 'remove') {
    block = (
      <Confirm
        question={`Remove ${who}? Their run notes keep their text.`}
        confirm="Remove"
        busy={busy}
        loading={loading}
        error={blockError}
        onConfirm={() => run({ kind: 'remove' }, 'remove')}
        onCancel={close}
      />
    );
  } else if (mode === 'demote') {
    block = (
      <Confirm
        question="Remove your admin rights? You lose Administration at once."
        confirm="Remove admin"
        busy={busy}
        loading={loading}
        error={blockError}
        onConfirm={() => run({ kind: 'update', body: { isAdmin: false } }, 'demote')}
        onCancel={close}
      />
    );
  } else if (mode === 'reset') {
    block = (
      <ResetPassword
        who={who}
        busy={busy}
        loading={loading}
        error={blockError}
        onReset={(password) => run({ kind: 'reset', password }, 'reset')}
        onCancel={close}
      />
    );
  } else if (mode === 'edit') {
    block = (
      <ProjectsPanel
        user={user}
        who={who}
        projects={projects}
        busy={busy}
        pending={pending?.from === 'edit' ? pending.action : undefined}
        error={blockError}
        idOf={idOf}
        roleId={roleId}
        run={(action, onDone) => run(action, 'edit', onDone)}
        onClose={close}
      />
    );
  }

  const details =
    block === null && lineError === null ? null : (
      <div className="flex flex-col gap-3">
        {block}
        {lineError !== null && <Problem error={lineError} />}
      </div>
    );

  return children(menu, details);
}

/**
 * A destructive action, asked in words before it is done: the question, the
 * action named again, and Cancel.
 *
 * THE CARET LANDS ON CANCEL — the safe answer to a question about something
 * that signs a person out or cannot be undone, as `ProjectPackages`' delete
 * does. The question names the group, so a screen reader arriving on Cancel
 * hears what it would be cancelling.
 *
 * NOT `primary`: `Button`'s rule is one per screen, and this page's is Create
 * user. A confirm that reached for it would make the destructive control the
 * most prominent one on screen.
 */
function Confirm({
  question,
  confirm,
  busy,
  loading,
  error,
  onConfirm,
  onCancel,
}: {
  readonly question: string;
  readonly confirm: string;
  readonly busy: boolean;
  readonly loading: boolean;
  readonly error: Error | null;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}) {
  const questionId = useId();
  return (
    <div role="group" aria-labelledby={questionId} className="flex flex-col gap-2">
      <p id={questionId} className="text-[0.8125rem] text-primary">
        {question}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" loading={loading} disabled={busy} onClick={onConfirm}>
          {confirm}
        </Button>
        {/* Disabled while the request is in flight: one already sent cannot be
            taken back, and Cancel would only hide it. */}
        <Button size="sm" variant="ghost" autoFocus disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
      {error !== null && <Problem error={error} />}
    </div>
  );
}

/**
 * Reset password: a temporary password typed by the admin, which its owner
 * must replace at their next sign-in.
 *
 * ═══ SHOWN, NOT MASKED (ruling W11) ═══
 * The admin reads it back to its owner, so the field is plain text, and
 * nothing offers to fill it, save it, spell-check it or capitalise it.
 *
 * ═══ CHECKED HERE, IN ONE SENTENCE (ruling W3) ═══
 * `SetPasswordRequestSchema` refuses a password outside its bounds before
 * anything is sent, and the refusal is `formIssues`' sentence, never zod's
 * English. No `required`: an empty field is the same refusal in the same words,
 * rather than the browser's own.
 */
function ResetPassword({
  who,
  busy,
  loading,
  error,
  onReset,
  onCancel,
}: {
  readonly who: string;
  readonly busy: boolean;
  readonly loading: boolean;
  readonly error: Error | null;
  readonly onReset: (password: string) => void;
  readonly onCancel: () => void;
}) {
  const id = useId();
  const sentenceId = useId();
  const field = useRef<HTMLInputElement>(null);
  const [password, setPassword] = useState('');
  /* A FRESH OBJECT on every refusal, so pressing again over the same mistake
     re-runs the effect and pulls the caret back. */
  const [refused, setRefused] = useState<{ readonly message: string } | null>(null);

  useEffect(() => {
    if (refused !== null) field.current?.focus();
  }, [refused]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const parsed = SetPasswordRequestSchema.safeParse({ password });
    if (!parsed.success) {
      const [message] = Object.values(fieldMessages(parsed.error.issues));
      setRefused({ message: message ?? parsed.error.message });
      return;
    }
    setRefused(null);
    onReset(parsed.data.password);
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-2">
      {/* "for Bo Flagged" is for a screen reader: with Add user open there is a
          second Temporary password field on the page, for someone else. */}
      <RowField label="Temporary password" qualifier={`for ${who}`} id={id} error={refused?.message}>
        <input
          ref={field}
          id={id}
          type="text"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          autoFocus
          // Read-only, not disabled, while the request is in flight: a disabled
          // field can drop the caret.
          readOnly={busy}
          className={`${INPUT} sm:max-w-[20rem]`}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          aria-invalid={refused !== null || undefined}
          aria-describedby={refused === null ? undefined : errorId(id)}
        />
      </RowField>
      <p id={sentenceId} className="text-[0.8125rem] text-primary">
        They must choose a new password at next sign-in, and are signed out everywhere.
      </p>
      <div className="flex flex-wrap gap-2">
        {/* What pressing it does is described on the button itself, so a
            reader who tabs straight to it hears the consequence. */}
        <Button type="submit" size="sm" variant="secondary" loading={loading} disabled={busy} aria-describedby={sentenceId}>
          Reset password
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
      {error !== null && <Problem error={error} />}
    </form>
  );
}

/**
 * Edit projects and roles: the projects a person holds a role in, and a way to
 * add one more.
 *
 * AN EDITOR, NOT A CONFIRM. A role is picked and then saved (`RoleChange`);
 * Remove from project and Add are sent as they are pressed. A change made by
 * mistake is undone the same way, the panel stays open for the next one, and
 * Close leaves it.
 *
 * ═══ A NAME EACH, HOWEVER MANY PROJECTS ═══
 * Every line has a Role select, its Save while a choice is staged, and a
 * Remove from project button, so the project's name joins each one's
 * accessible name ("Role in Checkout", "Save role in Checkout") for a screen
 * reader, after the visible word — the qualifier Add user's rows use.
 */
function ProjectsPanel({
  user,
  who,
  projects,
  busy,
  pending,
  error,
  idOf,
  roleId,
  run,
  onClose,
}: {
  readonly user: AdminUser;
  readonly who: string;
  readonly projects: readonly AdminProject[] | undefined;
  readonly busy: boolean;
  /** The panel's request in flight, if any. */
  readonly pending: RowAction | undefined;
  readonly error: Error | null;
  readonly idOf: (part: string) => string;
  readonly roleId: (slug: string) => string;
  readonly run: (action: RowAction, onDone?: () => void) => void;
  readonly onClose: () => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  /* The reader's own choice of project to add, if they have made one. Not the
     select's value: that is derived below, so a project that has just been
     added cannot stay chosen. */
  const [addSlug, setAddSlug] = useState<string | null>(null);
  /* A new grant starts as a Viewer (ruling W5): least privilege, and anything
     more is a choice the admin makes. */
  const [addRole, setAddRole] = useState<ProjectRole>('viewer');

  /* ═══ THE FIRST PROJECT THEY DO NOT HOLD (ruling W12) ═══
     The select offers only projects this person is not already in, starting on
     the first. With none left — or no list yet — there is nothing to add, and
     the select and Add say so by being disabled. */
  const held = new Set(user.memberships.map((membership) => membership.projectSlug));
  const available = (projects ?? []).filter((project) => !held.has(project.slug));
  const chosen = available.find((project) => project.slug === addSlug) ?? available[0];

  /* ═══ THE CARET GOES IN AS THE PANEL MOUNTS ═══
     Radix runs a chosen item's `onSelect` inside `flushSync`, before it closes
     the menu, so this panel mounts — and this runs — while the menu is still
     open. The caret leaving the menu then counts as an interaction outside it,
     and the menu does not hand it back to the trigger as it closes. A passive
     effect runs in that same window too (a sync render flushes its effects
     before returning — measured: swapping it changes nothing); a layout
     effect is used so the caret is in place before the panel is first painted. */
  useLayoutEffect(() => {
    panel.current?.querySelector<HTMLElement>('select:not(:disabled), button:not(:disabled)')?.focus();
  }, []);

  return (
    <div ref={panel} role="group" aria-label={`${who}: projects and roles`} className="flex flex-col gap-4">
      {user.memberships.length === 0 ? (
        <p className="text-[0.8125rem] text-muted">In no project yet.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {user.memberships.map((membership) => (
            <li key={membership.projectSlug} className="flex flex-wrap items-end gap-3">
              <span className="min-w-[8rem] pb-2 text-[0.8125rem] font-medium text-primary">
                {membership.projectName}
              </span>
              <RoleChange
                id={roleId(membership.projectSlug)}
                qualifier={`in ${membership.projectName}`}
                current={membership.role}
                pending={busy}
                onSave={(role) => run({ kind: 'role', slug: membership.projectSlug, role })}
              />
              <Button
                size="sm"
                variant="ghost"
                loading={pending?.kind === 'leave' && pending.slug === membership.projectSlug}
                disabled={busy}
                onClick={() => run({ kind: 'leave', slug: membership.projectSlug })}
              >
                Remove from project{' '}
                <span className="sr-only">{membership.projectName}</span>
              </Button>
            </li>
          ))}
        </ul>
      )}

      {/* A legend, not a heading: it groups the three controls below, and a
          screen reader names the group as the caret enters it. */}
      <fieldset className="flex flex-col gap-3">
        <legend className="mb-1.5 text-[0.75rem] font-semibold uppercase tracking-[0.08em] text-muted">
          Add to project
        </legend>
        <div className="flex flex-wrap items-end gap-3">
          <FormField label="Project" id={idOf('add-project')}>
            <select
              id={idOf('add-project')}
              className={INPUT}
              value={chosen?.slug ?? ''}
              disabled={busy || chosen === undefined}
              onChange={(event) => setAddSlug(event.target.value)}
            >
              {available.map((project) => (
                <option key={project.slug} value={project.slug}>
                  {project.name}
                </option>
              ))}
            </select>
          </FormField>
          <FormField label="Role" id={idOf('add-role')}>
            <select
              id={idOf('add-role')}
              className={INPUT}
              value={addRole}
              disabled={busy}
              onChange={(event) => setAddRole(event.target.value as ProjectRole)}
            >
              {PROJECT_ROLES.map((role) => (
                <option key={role} value={role}>
                  {ROLE_LABEL[role]}
                </option>
              ))}
            </select>
          </FormField>
          <Button
            size="sm"
            variant="secondary"
            loading={pending?.kind === 'join'}
            disabled={busy || chosen === undefined}
            onClick={() => {
              if (chosen === undefined) return;
              run({ kind: 'join', slug: chosen.slug, role: addRole }, () => {
                setAddSlug(null);
                setAddRole('viewer');
              });
            }}
          >
            Add
          </Button>
        </div>
      </fieldset>

      <div>
        <Button id={idOf('close')} size="sm" variant="ghost" disabled={busy} onClick={onClose}>
          Close
        </Button>
      </div>
      {error !== null && <Problem error={error} />}
    </div>
  );
}
