// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AdminUser, ProjectMember, ProjectRole } from '@perfportal/contracts';
import ProjectMembers from '../src/routes/ProjectMembers';
import { sessionQueryKey } from '../src/api/session';
import { projectListBody, seedAccess, sessionBody } from './support/access';

// No vitest globals here, so Testing Library's automatic cleanup never
// registers; without this every render stacks in one `document.body`.
afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());

/**
 * The Members page: who holds which role in a project. Everyone in the
 * project reads the table; an admin adds people, changes a role (pick, then
 * Save) and removes a member.
 *
 * Driven through `fetch`, never by mocking `api/members`: the claims are about
 * what reaches the wire and what the page does with the API's own answers.
 * Every fixture satisfies the real response schemas — a malformed one would
 * make a query throw and a case test the error branch instead.
 */

const ADMIN_ID = sessionBody(true).user.id;

const member = (userId: string, name: string, email: string, role: ProjectRole): ProjectMember => ({
  userId,
  name,
  email,
  role,
  addedAt: '2026-10-07T10:00:00.000Z',
});

/* The seeded admin holds a row of their own, as a Manager. */
const ADA = member(ADMIN_ID, 'Ada Admin', 'ada.admin@example.test', 'manager');
const BO = member('user-bo', 'Bo Member', 'bo@example.test', 'member');
/* A member whose ACCOUNT is disabled: the membership stays, and an admin is told. */
const DEE = member('user-dee', 'Dee Disabled', 'dee@example.test', 'viewer');
const MEMBERS: ProjectMember[] = [ADA, BO, DEE];

const person = (overrides: Partial<AdminUser> & Pick<AdminUser, 'id' | 'name' | 'email'>): AdminUser => ({
  isAdmin: false,
  disabled: false,
  mustChangePassword: false,
  memberships: [],
  createdAt: '2026-10-01T09:30:00.000Z',
  ...overrides,
});

/* Everyone in the install, as `GET /v1/admin/users` answers an admin. Eve and
   Fin hold no role in the project, so they are who can be added. */
const PEOPLE: AdminUser[] = [
  person({ id: ADA.userId, name: ADA.name, email: ADA.email, isAdmin: true }),
  person({ id: BO.userId, name: BO.name, email: BO.email }),
  person({ id: DEE.userId, name: DEE.name, email: DEE.email, disabled: true }),
  person({ id: 'user-eve', name: 'Eve Newcomer', email: 'eve@example.test' }),
  person({ id: 'user-fin', name: 'Fin Gone', email: 'fin@example.test', disabled: true }),
];

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const problem = (status: number, code: string, detail: string, remediation: string) =>
  json(status, { type: 'about:blank', title: 'Error', status, code, detail, remediation });

interface Sent {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
}

const MEMBERS_URL = '/v1/projects/checkout/members';

/** The members list, re-read after each change: `set` is what it says from then on. */
function liveMembers(initial: ProjectMember[]) {
  let current = initial;
  return {
    answer: () => Promise.resolve(json(200, { members: current })),
    set: (next: ProjectMember[]) => {
      current = next;
    },
  };
}

interface Answers {
  /** `GET /v1/projects`, when the case does not seed it. */
  projects?: () => Promise<Response>;
  members?: () => Promise<Response>;
  people?: () => Promise<Response>;
  /** A write's answer; `undefined` falls through to the ordinary success. */
  write?: (sent: Sent) => Promise<Response> | undefined;
}

/** The ordinary success for each members write, shaped as `ProjectMemberSchema` reads it. */
function answerWrite({ url, method, body }: Sent): Response {
  const one = /^\/v1\/projects\/checkout\/members\/([^/]+)$/.exec(url);
  const role = ((body as { role?: ProjectRole } | undefined)?.role ?? 'viewer') as ProjectRole;
  if (url === MEMBERS_URL && method === 'POST') {
    return json(201, member((body as { userId: string }).userId, 'Someone', 'someone@example.test', role));
  }
  if (one !== null && method === 'PATCH') return json(200, member(decodeURIComponent(one[1]!), 'Someone', 'someone@example.test', role));
  if (one !== null && method === 'DELETE') return new Response(null, { status: 204 });
  return json(404, {});
}

function stubApi(answers: Answers = {}): Sent[] {
  const sent: Sent[] = [];
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    sent.push({ url, method, body });
    if (method === 'GET') {
      if (url === '/auth/get-session') return Promise.resolve(json(200, sessionBody(true)));
      if (url === '/v1/projects') {
        return answers.projects?.() ?? Promise.resolve(json(200, projectListBody({ checkout: 'viewer' })));
      }
      if (url === MEMBERS_URL) return answers.members?.() ?? Promise.resolve(json(200, { members: MEMBERS }));
      if (url === '/v1/admin/users') return answers.people?.() ?? Promise.resolve(json(200, { users: PEOPLE }));
      return Promise.resolve(json(404, {}));
    }
    return answers.write?.({ url, method, body }) ?? Promise.resolve(answerWrite({ url, method, body }));
  });
  return sent;
}

/** Who is looking, as `seedAccess` writes it into the cache. */
type Reader = { isAdmin: boolean; roles?: Readonly<Record<string, ProjectRole>> };
/* A Viewer of the project: they may read who is in it, and change nothing. */
const VIEWER: Reader = { isAdmin: false, roles: { checkout: 'viewer' } };
/* An admin holding only a Viewer row (Review Focus 1): admin first, so every
   control is theirs whatever the row says. */
const ADMIN: Reader = { isAdmin: true, roles: { checkout: 'viewer' } };

/** `who: null` seeds a NON-admin's session alone, leaving the project list to the stub. */
function renderPage(who: Reader | null) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  if (who === null) {
    client.setQueryDefaults(sessionQueryKey, { staleTime: Infinity });
    client.setQueryData(sessionQueryKey, sessionBody(false));
  } else {
    seedAccess(client, who);
  }
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/projects/checkout/members']}>
        <Routes>
          <Route path="/projects/:slug/members" element={<ProjectMembers />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return client;
}

const table = () => screen.findByRole('table', { name: 'Members' });
const rowOf = async (email: string) => within(await table()).getByText(email).closest('tr')!;
const nameCellOf = async (email: string) => within(await rowOf(email)).getAllByRole('cell')[0]!;
const writes = (sent: readonly Sent[]) =>
  sent.filter((s) => s.method !== 'GET').map(({ url, method, body }) => ({ url, method, body }));
const readsOf = (sent: readonly Sent[], url: string) => sent.filter((s) => s.url === url && s.method === 'GET').length;

const summary = () => screen.getByText('Add member', { selector: 'summary' });
const addForm = () => summary().closest('details')!.querySelector('form')!;
const personSelect = () => within(addForm()).getByRole('combobox', { name: 'Person' });
const optionsOf = (select: HTMLElement) => [...(select as HTMLSelectElement).options].map((o) => o.textContent);

/**
 * Drops the caret to the page, as a browser may when the control holding it is
 * disabled mid-request. jsdom never does that itself, and its `blur()` does
 * nothing on a disabled control, so the caret passes through a focusable
 * element and is blurred from there.
 */
function dropCaret() {
  const region = screen.getByRole('region', { name: 'Members table' });
  act(() => {
    region.focus();
    region.blur();
  });
  expect(document.activeElement).toBe(document.body);
}

/** Opens Add member and waits for the people it can offer. */
async function openAdd(clicker: ReturnType<typeof userEvent.setup>) {
  await clicker.click(summary());
  await waitFor(() => expect(personSelect()).toBeEnabled());
}

describe('ProjectMembers — reading', () => {
  it('shows a Viewer the table read-only: no role select, no Remove, no Add member', async () => {
    const sent = stubApi();
    renderPage(VIEWER);
    const members = await table();

    expect(within(members).getAllByRole('columnheader').map((th) => th.textContent)).toEqual(['Name', 'Email', 'Role']);
    const rows = within(members).getAllByRole('row').slice(1);
    expect(rows.map((row) => within(row).getAllByRole('cell').map((cell) => cell.textContent))).toEqual([
      ['Ada Admin', 'ada.admin@example.test', 'Manager'],
      ['Bo Member', 'bo@example.test', 'Member'],
      ['Dee Disabled', 'dee@example.test', 'Viewer'],
    ]);
    expect(screen.queryAllByRole('combobox')).toEqual([]);
    expect(screen.queryByRole('button', { name: /remove from project/i })).toBeNull();
    expect(screen.queryByText('Add member')).toBeNull();
    // An admin's list of every account: a Viewer would be refused it, so it is never asked for.
    expect(readsOf(sent, '/v1/admin/users')).toBe(0);
  });

  /* Ruling P8: not knowing who is looking is not a reason to wait. Until the
     project list answers, a non-admin's access is unknown — so nothing gated
     is drawn, the table is, and nothing claims they were refused. */
  it('draws the table read-only while access is not known yet, rather than waiting on it', async () => {
    const sent = stubApi({ projects: () => new Promise<Response>(() => {}) });
    renderPage(null);
    const members = await table();

    expect(within(members).getAllByRole('columnheader').map((th) => th.textContent)).toEqual(['Name', 'Email', 'Role']);
    expect(screen.queryAllByRole('combobox')).toEqual([]);
    expect(screen.queryByText('Add member')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
    expect(readsOf(sent, '/v1/admin/users')).toBe(0);
  });

  it('says there are no members yet, and a Viewer sees only that', async () => {
    stubApi({ members: () => Promise.resolve(json(200, { members: [] })) });
    renderPage(VIEWER);

    expect(await screen.findByText('No members yet')).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByText('Add member')).toBeNull();
  });

  it('shows the list’s own refusal when it could not be loaded', async () => {
    stubApi({
      members: () =>
        Promise.resolve(problem(404, 'NOT_FOUND', 'No project "checkout" in this organization.', 'Check the slug.')),
    });
    renderPage(VIEWER);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('No project "checkout" in this organization.');
    expect(alert).toHaveTextContent('Check the slug.');
    expect(screen.queryByRole('table')).toBeNull();
  });

  /* PR 2's ruling W14: the error page is for a list that never loaded. One that
     loaded stays on screen when a later read of it fails. */
  it('keeps a loaded table when a later refresh of it fails, saying it may be out of date', async () => {
    let fail = false;
    stubApi({
      members: () =>
        Promise.resolve(fail ? json(500, { message: 'down' }) : json(200, { members: MEMBERS })),
    });
    const client = renderPage(VIEWER);
    await table();

    fail = true;
    await act(async () => {
      await client.refetchQueries({ queryKey: ['project-members', 'checkout'] });
    });

    expect(await screen.findByText('This list could not be refreshed, so it may be out of date.')).toBeInTheDocument();
    expect(await rowOf('bo@example.test')).toBeInTheDocument();
  });
});

describe('ProjectMembers — an admin', () => {
  /* Review Focus 1: admin first. The project list gives an admin with no row
     here `role: null`, which says nothing about what they may do. */
  it('gives an admin with no row in the project every control', async () => {
    stubApi({ projects: () => Promise.resolve(json(200, projectListBody({ checkout: null }))) });
    renderPage({ isAdmin: true });

    expect(await screen.findByRole('combobox', { name: 'Role for Bo Member' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove from project Bo Member' })).toBeInTheDocument();
    expect(summary()).toBeInTheDocument();
  });

  it('marks an admin and a disabled account in the table', async () => {
    stubApi();
    renderPage(ADMIN);
    await table();

    await waitFor(async () => expect(await nameCellOf('ada.admin@example.test')).toHaveTextContent('Ada Admin Admin'));
    expect(await nameCellOf('dee@example.test')).toHaveTextContent('Dee Disabled Disabled');
    expect(await nameCellOf('bo@example.test')).toHaveTextContent(/^Bo Member$/);
    expect(within(await table()).getAllByRole('columnheader').map((th) => th.textContent)).toEqual([
      'Name',
      'Email',
      'Role',
      'Actions',
    ]);
  });

  it('offers only people who are not members yet, and marks a disabled account there too', async () => {
    stubApi();
    renderPage(ADMIN);
    await table();
    await openAdd(userEvent.setup());

    expect(optionsOf(personSelect())).toEqual(['Eve Newcomer (eve@example.test)', 'Fin Gone (fin@example.test) — disabled']);
    // The first is chosen, and a new member starts as a Viewer.
    expect(personSelect()).toHaveValue('user-eve');
    expect(within(addForm()).getByRole('combobox', { name: 'Role' })).toHaveValue('viewer');
  });

  it('adds the chosen person as a Viewer to this project, and re-reads the list', async () => {
    const list = liveMembers(MEMBERS);
    const sent = stubApi({
      members: list.answer,
      write: (s) => {
        if (s.method === 'POST') list.set([...MEMBERS, member('user-eve', 'Eve Newcomer', 'eve@example.test', 'viewer')]);
        return undefined;
      },
    });
    renderPage(ADMIN);
    await table();
    const clicker = userEvent.setup();
    await openAdd(clicker);
    const readsBefore = readsOf(sent, MEMBERS_URL);
    const peopleBefore = readsOf(sent, '/v1/admin/users');

    await clicker.click(within(addForm()).getByRole('button', { name: 'Add' }));

    await waitFor(() =>
      expect(writes(sent)).toEqual([{ url: MEMBERS_URL, method: 'POST', body: { userId: 'user-eve', role: 'viewer' } }]),
    );
    expect(await rowOf('eve@example.test')).toBeInTheDocument();
    expect(readsOf(sent, MEMBERS_URL)).toBe(readsBefore + 1);
    // Administration's list of every account counts memberships: re-read too.
    expect(readsOf(sent, '/v1/admin/users')).toBe(peopleBefore + 1);
    // The one primary button on the page.
    expect(within(addForm()).getByRole('button', { name: 'Add' }).className).toContain('bg-accent');
    // The form stays open for the next person, who is now the one chosen — and has the caret.
    await waitFor(() => expect(optionsOf(personSelect())).toEqual(['Fin Gone (fin@example.test) — disabled']));
    expect(personSelect()).toHaveValue('user-fin');
    await waitFor(() => expect(personSelect()).toHaveFocus());
  });

  it('says in the API’s own words why nobody can be offered, when the accounts could not be listed', async () => {
    stubApi({
      people: () =>
        Promise.resolve(problem(503, 'UNAVAILABLE', 'The account list is unavailable.', 'Try again in a minute.')),
    });
    renderPage(ADMIN);
    await table();
    await userEvent.setup().click(summary());

    const alert = await within(addForm()).findByRole('alert');
    expect(alert).toHaveTextContent('The account list is unavailable.');
    expect(alert).toHaveTextContent('Try again in a minute.');
    expect(within(addForm()).getByRole('button', { name: 'Add' })).toBeDisabled();
    // Unknown is not "everyone": nothing is claimed about who is a member.
    expect(within(addForm()).queryByText('Everyone is already a member.')).toBeNull();
  });

  it('shows a refused add in the API’s own words, in the form', async () => {
    stubApi({
      write: (s) =>
        s.method === 'POST'
          ? Promise.resolve(
              problem(409, 'MEMBER_EXISTS', 'Eve Newcomer already holds a role in Checkout.', 'Change their role in the table instead.'),
            )
          : undefined,
    });
    renderPage(ADMIN);
    await table();
    const clicker = userEvent.setup();
    await openAdd(clicker);

    await clicker.click(within(addForm()).getByRole('button', { name: 'Add' }));

    const alert = await within(addForm()).findByRole('alert');
    expect(alert).toHaveTextContent('Eve Newcomer already holds a role in Checkout.');
    expect(alert).toHaveTextContent('Change their role in the table instead.');
    expect(screen.getAllByRole('alert')).toHaveLength(1);
  });

  it('says everyone is a member, and cannot add, when nobody is left to add', async () => {
    stubApi({ people: () => Promise.resolve(json(200, { users: PEOPLE.slice(0, 3) })) });
    renderPage(ADMIN);
    await table();
    await userEvent.setup().click(summary());

    expect(await within(addForm()).findByText('Everyone is already a member.')).toBeInTheDocument();
    expect(within(addForm()).getByRole('button', { name: 'Add' })).toBeDisabled();
  });

  it('opens Add member when the project has nobody in it yet', async () => {
    stubApi({ members: () => Promise.resolve(json(200, { members: [] })) });
    renderPage(ADMIN);

    expect(await screen.findByText('No members yet')).toBeInTheDocument();
    expect(summary().closest('details')).toHaveAttribute('open');
  });

  it('changes a role through Save, as one PATCH for that person, and hands the caret to the role it set', async () => {
    const list = liveMembers(MEMBERS);
    const sent = stubApi({
      members: list.answer,
      write: (s) => {
        if (s.method === 'PATCH') list.set(MEMBERS.map((m) => (m.userId === BO.userId ? { ...m, role: 'manager' } : m)));
        return undefined;
      },
    });
    renderPage(ADMIN);
    await table();
    const clicker = userEvent.setup();
    const role = await screen.findByRole('combobox', { name: 'Role for Bo Member' });
    expect(role).toHaveValue('member');

    await clicker.selectOptions(role, 'Viewer');
    await clicker.selectOptions(role, 'Manager');
    expect(writes(sent)).toEqual([]);
    await clicker.click(screen.getByRole('button', { name: 'Save role for Bo Member' }));

    await waitFor(() =>
      expect(writes(sent)).toEqual([{ url: `${MEMBERS_URL}/user-bo`, method: 'PATCH', body: { role: 'manager' } }]),
    );
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Save role for Bo Member' })).toBeNull());
    expect(role).toHaveValue('manager');
    await waitFor(() => expect(role).toHaveFocus());
  });

  it('shows a refused role change on the row it was made on, keeping the choice, its Save and the caret', async () => {
    let answer: (response: Response) => void = () => {};
    stubApi({
      write: (s) =>
        s.method === 'PATCH'
          ? new Promise<Response>((resolve) => {
              answer = resolve;
            })
          : undefined,
    });
    renderPage(ADMIN);
    await table();
    const clicker = userEvent.setup();
    const role = await screen.findByRole('combobox', { name: 'Role for Bo Member' });
    await clicker.selectOptions(role, 'Manager');
    const save = screen.getByRole('button', { name: 'Save role for Bo Member' });
    await clicker.click(save);
    await waitFor(() => expect(save).toBeDisabled());
    dropCaret();

    await act(async () => {
      answer(problem(403, 'ADMIN_REQUIRED', 'Managing members needs an admin.', 'Ask an admin to do this.'));
    });

    const line = (await rowOf('bo@example.test')).nextElementSibling as HTMLElement;
    const alert = await within(line).findByRole('alert');
    expect(alert).toHaveTextContent('Managing members needs an admin.');
    expect(alert).toHaveTextContent('Ask an admin to do this.');
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(role).toHaveValue('manager');
    await waitFor(() => expect(save).toBeEnabled());
    expect(save).toHaveFocus();
  });

  it('removes a member from the project with one click, as one DELETE for that row', async () => {
    const list = liveMembers(MEMBERS);
    const sent = stubApi({
      members: list.answer,
      write: (s) => {
        if (s.method === 'DELETE') list.set(MEMBERS.filter((m) => m.userId !== BO.userId));
        return undefined;
      },
    });
    renderPage(ADMIN);
    await table();
    const clicker = userEvent.setup();

    await clicker.click(await screen.findByRole('button', { name: 'Remove from project Bo Member' }));

    await waitFor(() => expect(writes(sent)).toEqual([{ url: `${MEMBERS_URL}/user-bo`, method: 'DELETE', body: undefined }]));
    await waitFor(() => expect(within(screen.getByRole('table', { name: 'Members' })).queryByText('bo@example.test')).toBeNull());
    // The row went with the button that removed it; the caret stays in the table.
    await waitFor(() => expect(screen.getByRole('region', { name: 'Members table' })).toHaveFocus());
  });

  /* Review Focus 5: two members called Sam Lee give the table two of every row
     control, so the email joins the name — on those rows only. */
  it('names every row control after its person, adding the email only where a display name repeats', async () => {
    const twins = [
      member('u1', 'Sam Lee', 'sam.one@example.test', 'viewer'),
      member('u2', 'Sam Lee', 'sam.two@example.test', 'member'),
      BO,
    ];
    stubApi({ members: () => Promise.resolve(json(200, { members: twins })) });
    renderPage(ADMIN);
    const members = await table();
    const clicker = userEvent.setup();

    const names = ['Sam Lee (sam.one@example.test)', 'Sam Lee (sam.two@example.test)', 'Bo Member'];
    const roles = await within(members).findAllByRole('combobox');
    expect(roles).toHaveLength(3);
    // Each select by its own accessible name: three names, three different selects.
    expect(new Set(names.map((who) => within(members).getByRole('combobox', { name: `Role for ${who}` })))).toEqual(
      new Set(roles),
    );
    for (const select of roles) await clicker.selectOptions(select, 'Manager');
    expect(within(members).getAllByRole('button', { name: /^Save role/ }).map((b) => b.textContent)).toEqual([
      'Save role for Sam Lee (sam.one@example.test)',
      'Save role for Sam Lee (sam.two@example.test)',
      'Save role for Bo Member',
    ]);
    expect(within(members).getAllByRole('button', { name: /^Remove from project/ }).map((b) => b.textContent)).toEqual([
      'Remove from project Sam Lee (sam.one@example.test)',
      'Remove from project Sam Lee (sam.two@example.test)',
      'Remove from project Bo Member',
    ]);
    // And each reaches assistive technology by that name, one control per name.
    for (const who of names) {
      expect(within(members).getAllByRole('button', { name: `Save role for ${who}` })).toHaveLength(1);
      expect(within(members).getAllByRole('button', { name: `Remove from project ${who}` })).toHaveLength(1);
    }
  });

  it('re-reads the project list when the person changed is the reader, and only then', async () => {
    const sent = stubApi();
    renderPage(ADMIN);
    await table();
    const clicker = userEvent.setup();

    await clicker.click(await screen.findByRole('button', { name: 'Remove from project Bo Member' }));
    await waitFor(() => expect(writes(sent)).toHaveLength(1));
    await waitFor(() => expect(readsOf(sent, MEMBERS_URL)).toBe(2));
    expect(readsOf(sent, '/v1/projects')).toBe(0);

    // Their own row: what `GET /v1/projects` says of them in this project has moved.
    await clicker.selectOptions(await screen.findByRole('combobox', { name: 'Role for Ada Admin' }), 'Member');
    await clicker.click(screen.getByRole('button', { name: 'Save role for Ada Admin' }));
    await waitFor(() => expect(readsOf(sent, '/v1/projects')).toBe(1));
  });
});
