// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AdminProject, AdminUser } from '@perfportal/contracts';
import AdminUsers from '../src/routes/AdminUsers';
import { adminProjectsQueryKey, adminUsersQueryKey } from '../src/api/admin';
import { fetchProjects, projectsQueryKey } from '../src/api/projects';
import { ADMIN_PROJECTS_ROUTE, ADMIN_USERS_ROUTE } from '../src/routes/paths';
import { PASSWORD_LENGTH_MESSAGE } from '../src/formIssues';

// No vitest globals here, so Testing Library's automatic cleanup never
// registers; without this every render stacks in one `document.body`.
afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());

/**
 * Driven through `fetch`, never by mocking `api/admin`: the claims are about
 * what reaches the wire (the parsed body, the refetches after a create) and
 * what the page does with the API's own answers (a 409, a 403). Every fixture
 * is built to satisfy the real response schemas — a malformed one would make
 * the list query throw and every case here test the error branch instead.
 */

const SESSION = {
  session: {
    id: 'session-1',
    userId: 'user-admin',
    expiresAt: '2026-11-01T00:00:00.000Z',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ipAddress: null,
    userAgent: null,
  },
  user: {
    id: 'user-admin',
    email: 'admin@example.test',
    emailVerified: true,
    name: 'Ada Admin',
    image: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    role: 'admin',
    mustChangePassword: false,
  },
};

const user = (overrides: Partial<AdminUser> & Pick<AdminUser, 'id' | 'name' | 'email'>): AdminUser => ({
  isAdmin: false,
  disabled: false,
  mustChangePassword: false,
  memberships: [],
  createdAt: '2026-10-01T09:30:00.000Z',
  ...overrides,
});

const ADMIN = user({
  id: 'user-admin',
  name: 'Ada Admin',
  email: 'admin@example.test',
  isAdmin: true,
  memberships: [
    { projectSlug: 'checkout', projectName: 'Checkout', role: 'manager' },
    { projectSlug: 'search', projectName: 'Search', role: 'viewer' },
  ],
});
const FLAGGED = user({
  id: 'user-flagged',
  name: 'Bo Flagged',
  email: 'bo@example.test',
  mustChangePassword: true,
  memberships: [{ projectSlug: 'checkout', projectName: 'Checkout', role: 'member' }],
});
/* DISABLED AND FLAGGED AT ONCE: the precedence case. A person who cannot sign
   in is not usefully described as owing a password change. */
const DISABLED = user({
  id: 'user-disabled',
  name: 'Cy Disabled',
  email: 'cy@example.test',
  disabled: true,
  mustChangePassword: true,
});

const USERS: AdminUser[] = [ADMIN, FLAGGED, DISABLED];

const project = (slug: string, name: string, memberCount = 0): AdminProject => ({
  slug,
  name,
  memberCount,
  createdAt: '2026-09-20T08:00:00.000Z',
});
const PROJECTS: AdminProject[] = [project('checkout', 'Checkout', 2), project('search', 'Search', 1), project('payments', 'Payments')];

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const problem = (status: number, code: string, detail: string, remediation: string) =>
  json(status, { type: 'about:blank', title: 'Error', status, code, detail, remediation });

interface Sent {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
}

interface Answers {
  users?: () => Promise<Response>;
  projects?: () => Promise<Response>;
  create?: (body: unknown) => Promise<Response>;
  /** Any other GET — a read another part of the app makes beside this page.
   *  `undefined` falls through to the 404 every unknown read gets. */
  read?: (url: string) => Promise<Response> | undefined;
  /** Any other write — the row menu's PATCH, PUT and DELETE, and the members
   *  routes. `undefined` falls through to `answerWrite`'s ordinary success. */
  write?: (sent: Sent) => Promise<Response> | undefined;
}

const noContent = (): Response => new Response(null, { status: 204 });

/** A member as `ProjectMemberSchema` reads one; the page uses none of it. */
const member = (userId: string, role: string) => ({
  userId,
  name: 'Someone',
  email: 'someone@example.test',
  role,
  addedAt: '2026-10-07T10:00:00.000Z',
});

/**
 * The ordinary success for each write the row menu can make, shaped as the
 * real schemas expect. The page reads none of these bodies — every change is
 * followed by a refetch of both lists — so they only have to parse.
 */
function answerWrite({ url, method, body }: Sent): Response {
  const userRoute = /^\/v1\/admin\/users\/([^/]+)(\/password)?$/.exec(url);
  const memberRoute = /^\/v1\/projects\/[^/]+\/members(?:\/([^/]+))?$/.exec(url);
  if (userRoute !== null && userRoute[2] === '/password' && method === 'PUT') return noContent();
  if (userRoute !== null && method === 'PATCH') {
    return json(200, user({ id: decodeURIComponent(userRoute[1]!), name: 'Anyone', email: 'anyone@example.test' }));
  }
  if (userRoute !== null && method === 'DELETE') return noContent();
  const role = (body as { role?: string } | undefined)?.role ?? 'viewer';
  if (memberRoute !== null && method === 'POST') return json(201, member((body as { userId: string }).userId, role));
  if (memberRoute?.[1] !== undefined && method === 'PATCH') return json(200, member(memberRoute[1], role));
  if (memberRoute?.[1] !== undefined && method === 'DELETE') return noContent();
  return json(404, {});
}

/** Answers the three routes this page reads, plus the session it reads from cache. */
function stubApi(answers: Answers = {}): Sent[] {
  const sent: Sent[] = [];
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    sent.push({ url, method, body });
    if (url === '/auth/get-session') return Promise.resolve(json(200, SESSION));
    if (url === '/v1/admin/users' && method === 'GET') {
      return answers.users?.() ?? Promise.resolve(json(200, { users: USERS }));
    }
    if (url === '/v1/admin/projects' && method === 'GET') {
      return answers.projects?.() ?? Promise.resolve(json(200, { projects: PROJECTS }));
    }
    if (url === '/v1/admin/users' && method === 'POST') {
      return answers.create?.(body) ?? Promise.resolve(json(500, {}));
    }
    if (method === 'GET') return answers.read?.(url) ?? Promise.resolve(json(404, {}));
    return answers.write?.({ url, method, body }) ?? Promise.resolve(answerWrite({ url, method, body }));
  });
  return sent;
}

function renderPage(beside?: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[ADMIN_USERS_ROUTE]}>
        <AdminUsers />
        {beside}
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...view, client };
}

const table = () => screen.findByRole('table', { name: 'Users' });
const rowOf = async (email: string) => {
  const cell = within(await table()).getByText(email);
  return cell.closest('tr')!;
};
const disclosure = () => screen.getByText('Add user', { selector: 'summary' }).closest('details')!;
const form = () => disclosure().querySelector('form')!;

async function openForm() {
  const user = userEvent.setup();
  await user.click(screen.getByText('Add user', { selector: 'summary' }));
  await waitFor(() => expect(disclosure().open).toBe(true));
  return user;
}

describe('AdminUsers — the shell', () => {
  it('is the Users section of Administration, with Projects one tab over', async () => {
    stubApi();
    renderPage();
    await table();

    expect(screen.getByRole('heading', { level: 1, name: 'Administration' })).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Administration sections' });
    expect(within(nav).getAllByRole('link').map((link) => link.textContent)).toEqual(['Users', 'Projects']);
    expect(within(nav).getAllByRole('link', { current: 'page' }).map((link) => link.textContent)).toEqual(['Users']);
    expect(within(nav).getByRole('link', { name: 'Projects' })).toHaveAttribute('href', ADMIN_PROJECTS_ROUTE);
    expect(document.title).toBe('Users · Administration · PerfPortal');
  });
});

describe('AdminUsers — the table', () => {
  it('lists each account with its email, project count and status, under the five columns', async () => {
    stubApi();
    renderPage();
    const users = await table();

    expect(within(users).getAllByRole('columnheader').map((th) => th.textContent)).toEqual([
      'Name',
      'Email',
      'Projects',
      'Status',
      // The row menu's column, headed as every other table here heads it.
      'Actions',
    ]);
    const rows = within(users).getAllByRole('row').slice(1);
    expect(rows.map((row) => within(row).getAllByRole('cell')[1]?.textContent)).toEqual([
      'admin@example.test',
      'bo@example.test',
      'cy@example.test',
    ]);
    expect(within(await rowOf('admin@example.test')).getAllByRole('cell')[2]).toHaveTextContent(/^2/);
    expect(within(await rowOf('bo@example.test')).getAllByRole('cell')[2]).toHaveTextContent(/^1/);
    expect(within(await rowOf('cy@example.test')).getAllByRole('cell')[2]).toHaveTextContent(/^0$/);
  });

  it('badges an admin after the name, and nobody else', async () => {
    stubApi();
    renderPage();
    await table();

    const adminName = within(await rowOf('admin@example.test')).getAllByRole('cell')[0]!;
    expect(adminName).toHaveTextContent('Ada Admin');
    expect(within(adminName).getByText('Admin')).toBeInTheDocument();
    for (const email of ['bo@example.test', 'cy@example.test']) {
      expect(within(within(await rowOf(email)).getAllByRole('cell')[0]!).queryByText('Admin')).toBeNull();
    }
  });

  /* W4: one word per account, Disabled first, then the password flag. */
  it('states one status per account, a disabled account reading Disabled even while flagged', async () => {
    stubApi();
    renderPage();
    await table();

    const status = async (email: string) => within(await rowOf(email)).getAllByRole('cell')[3]!.textContent;
    expect(await status('admin@example.test')).toBe('Active');
    expect(await status('bo@example.test')).toBe('Must change password');
    expect(await status('cy@example.test')).toBe('Disabled');
  });

  /* W10: the count is the cell; the projects and roles are one click away. */
  it('names each project and its role behind the count’s info', async () => {
    stubApi();
    renderPage();
    await table();

    const tip = within(await rowOf('admin@example.test')).getByRole('button', { name: 'Ada Admin: projects' });
    // Each membership is its own list item in the popover the ⓘ opens. The
    // trigger's accessible description is computed from InfoTip's hidden copy,
    // and that flattens the list into one string, so it reads as one run.
    expect(tip).toHaveAccessibleDescription('Checkout · Manager Search · Viewer');
  });

  it('draws no info for an account in no project', async () => {
    stubApi();
    renderPage();
    await table();

    // Scoped to the ⓘ: the row's menu button is there whatever the count.
    expect(within(await rowOf('cy@example.test')).queryByRole('button', { name: /: projects$/ })).toBeNull();
  });

  /* W6: ten "Sam Lee: projects" buttons in one table is the duplicate-name
     defect, so a shared display name brings its email along — on those rows
     only. */
  it('gives each info a name of its own, adding the email only where a display name repeats', async () => {
    const twins = [
      user({ id: 'u1', name: 'Sam Lee', email: 'sam.one@example.test', memberships: [ADMIN.memberships[0]!] }),
      user({ id: 'u2', name: 'Sam Lee', email: 'sam.two@example.test', memberships: [ADMIN.memberships[1]!] }),
      FLAGGED,
    ];
    stubApi({ users: () => Promise.resolve(json(200, { users: twins })) });
    renderPage();
    const users = await table();

    // The ⓘs alone: each row also carries its menu button, named in its own case.
    const names = within(users)
      .getAllByRole('button', { name: /: projects$/ })
      .map((button) => button.getAttribute('aria-label'));
    expect(names).toEqual([
      'Sam Lee (sam.one@example.test): projects',
      'Sam Lee (sam.two@example.test): projects',
      'Bo Flagged: projects',
    ]);
  });

  it('shows the API’s own refusal, inside the shell, when the session is not an admin', async () => {
    stubApi({
      users: () =>
        Promise.resolve(
          problem(403, 'ADMIN_REQUIRED', 'Administration needs an admin account.', 'Ask an admin to make you one.'),
        ),
      projects: () =>
        Promise.resolve(
          problem(403, 'ADMIN_REQUIRED', 'Administration needs an admin account.', 'Ask an admin to make you one.'),
        ),
    });
    renderPage();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Administration needs an admin account.');
    expect(alert).toHaveTextContent('Ask an admin to make you one.');
    expect(screen.getByRole('heading', { level: 1, name: 'Administration' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Administration sections' })).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByText('Add user', { selector: 'summary' })).toBeNull();
  });
});

describe('AdminUsers — Add user', () => {
  it('starts closed, above the table', async () => {
    stubApi();
    renderPage();
    const users = await table();

    expect(disclosure().open).toBe(false);
    // Above: the disclosure precedes the table in document order.
    expect(disclosure().compareDocumentPosition(users) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('has one primary button, and it is Create user', async () => {
    stubApi();
    const { container } = renderPage();
    await table();

    const primaries = [...container.querySelectorAll('button.bg-accent')];
    expect(primaries).toHaveLength(1);
    expect(primaries[0]).toBe(within(form()).getByRole('button', { name: 'Create user' }));
  });

  /* W11: a temporary password is typed to be read back to its owner, so the
     field shows it, and nothing offers to fill or save it. */
  it('asks for the temporary password in a field that shows it and saves nothing', async () => {
    stubApi();
    renderPage();
    await table();

    const field = within(form()).getByLabelText('Temporary password');
    expect(field).toHaveAttribute('type', 'text');
    expect(field).toHaveAttribute('autocomplete', 'off');
    expect(field).toHaveAttribute('spellcheck', 'false');
  });

  it('posts the parsed body — the email lowercased, the Admin flag and each project with its role', async () => {
    const created = user({ id: 'user-new', name: 'Dee New', email: 'dee@example.test', mustChangePassword: true });
    const sent = stubApi({ create: () => Promise.resolve(json(201, created)) });
    renderPage();
    await table();
    const user1 = await openForm();

    await user1.type(within(form()).getByLabelText('Email'), 'Dee@Example.TEST');
    await user1.type(within(form()).getByLabelText('Name'), '  Dee New  ');
    await user1.type(within(form()).getByLabelText('Temporary password'), 'temporary-1');
    await user1.click(within(form()).getByRole('checkbox', { name: 'Admin' }));
    await user1.click(within(form()).getByRole('button', { name: 'Add project' }));
    await user1.click(within(form()).getByRole('button', { name: 'Add project' }));
    await user1.selectOptions(within(form()).getByRole('combobox', { name: 'Role 2' }), 'Manager');
    await user1.click(within(form()).getByRole('button', { name: 'Create user' }));

    await waitFor(() => expect(sent.some((s) => s.method === 'POST')).toBe(true));
    expect(sent.filter((s) => s.method === 'POST')).toEqual([
      {
        url: '/v1/admin/users',
        method: 'POST',
        body: {
          email: 'dee@example.test',
          name: 'Dee New',
          password: 'temporary-1',
          isAdmin: true,
          projects: [
            { projectSlug: 'checkout', role: 'viewer' },
            { projectSlug: 'search', role: 'manager' },
          ],
        },
      },
    ]);
  });

  /* W5 and W12: a new row is the next project nobody has chosen, as a Viewer. */
  it('starts each project row on the first project not yet chosen, as a Viewer', async () => {
    stubApi();
    renderPage();
    await table();
    const user1 = await openForm();
    const add = within(form()).getByRole('button', { name: 'Add project' });

    await user1.click(add);
    expect(within(form()).getByRole('combobox', { name: 'Project 1' })).toHaveValue('checkout');
    expect(within(form()).getByRole('combobox', { name: 'Role 1' })).toHaveValue('viewer');

    // Not simply the first project: Checkout is taken, so row 2 starts on Search.
    await user1.click(add);
    expect(within(form()).getByRole('combobox', { name: 'Project 2' })).toHaveValue('search');
    expect(within(form()).getByRole('combobox', { name: 'Role 2' })).toHaveValue('viewer');

    // And not simply the one after the last row: moving row 1 to Payments frees
    // Checkout, which is the first unchosen project again.
    await user1.selectOptions(within(form()).getByRole('combobox', { name: 'Project 1' }), 'Payments');
    await user1.click(add);
    expect(within(form()).getByRole('combobox', { name: 'Project 3' })).toHaveValue('checkout');

    // The project options carry the name and send the slug.
    const options = within(within(form()).getByRole('combobox', { name: 'Project 2' })).getAllByRole('option');
    expect(options.map((o) => [o.textContent, (o as HTMLOptionElement).value])).toEqual([
      ['Checkout', 'checkout'],
      ['Search', 'search'],
      ['Payments', 'payments'],
    ]);
    expect(
      within(within(form()).getByRole('combobox', { name: 'Role 2' }))
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Viewer', 'Member', 'Manager']);
  });

  it('cannot add a project row once every project is chosen', async () => {
    stubApi();
    renderPage();
    await table();
    const user1 = await openForm();
    const add = within(form()).getByRole('button', { name: 'Add project' });

    await user1.click(add);
    await user1.click(add);
    expect(add).toBeEnabled();
    await user1.click(add);
    expect(within(form()).getByRole('combobox', { name: 'Project 3' })).toHaveValue('payments');
    expect(add).toBeDisabled();

    // Removing a row frees its project again.
    await user1.click(within(form()).getByRole('button', { name: 'Remove project 2' }));
    expect(add).toBeEnabled();
    expect(within(form()).queryByRole('combobox', { name: 'Project 3' })).toBeNull();
  });

  it('cannot add a project row before the projects list has loaded', async () => {
    stubApi({ projects: () => new Promise<Response>(() => {}) });
    renderPage();
    await table();

    expect(within(form()).getByRole('button', { name: 'Add project' })).toBeDisabled();
  });

  /* W14's rule for the projects list as well as the users list: a refetch that
     fails keeps the projects it had (TanStack v5 sets `status: 'error'` and
     keeps `data`), so a blip on a background refetch must not take Add project
     away. The gate is "is there a list", never "did the last fetch succeed". */
  it('still adds the next project after a background refetch of the projects list fails', async () => {
    let refuse = false;
    stubApi({
      projects: () =>
        Promise.resolve(
          refuse
            ? problem(500, 'INTERNAL', 'The request could not be completed.', 'Retry the request.')
            : json(200, { projects: PROJECTS }),
        ),
    });
    const { client } = renderPage();
    await table();
    const user1 = await openForm();
    const add = within(form()).getByRole('button', { name: 'Add project' });
    await waitFor(() => expect(add).toBeEnabled());
    await user1.click(add);
    expect(within(form()).getByRole('combobox', { name: 'Project 1' })).toHaveValue('checkout');

    refuse = true;
    await act(() => client.invalidateQueries({ queryKey: adminProjectsQueryKey }));
    // The precondition, or the case proves nothing: the refetch really failed,
    // and the list it had is still there.
    expect(client.getQueryState(adminProjectsQueryKey)?.status).toBe('error');
    expect(client.getQueryData(adminProjectsQueryKey)).toEqual({ projects: PROJECTS });
    // TanStack tells its observers on a `setTimeout(0)` of its own, after the
    // refetch has settled; one more macrotask lets the page draw the error state
    // before the button is read, or the read would see the render before it.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(add).toBeEnabled();
    await user1.click(add);
    // Checkout is taken by row 1, so row 2 starts on the first one left.
    expect(within(form()).getByRole('combobox', { name: 'Project 2' })).toHaveValue('search');
  });

  /* Two rows mean two Project selects, two Role selects and two Removes; one
     name each would leave a screen reader with no way to tell the rows apart. */
  it('names every control in the form differently, however many project rows there are', async () => {
    stubApi();
    renderPage();
    await table();
    const user1 = await openForm();
    await user1.click(within(form()).getByRole('button', { name: 'Add project' }));
    await user1.click(within(form()).getByRole('button', { name: 'Add project' }));

    /* Every control, by the name it should have. `getByRole` throws on a second
       match, so each line proves its name is unique; the count below proves no
       control is left over with a name outside this list. */
    const expected: [string, string][] = [
      ['textbox', 'Email'],
      ['textbox', 'Name'],
      ['textbox', 'Temporary password'],
      ['checkbox', 'Admin'],
      ['combobox', 'Project 1'],
      ['combobox', 'Role 1'],
      ['button', 'Remove project 1'],
      ['combobox', 'Project 2'],
      ['combobox', 'Role 2'],
      ['button', 'Remove project 2'],
      ['button', 'Add project'],
      ['button', 'Create user'],
    ];
    for (const [role, name] of expected) {
      expect(within(form()).getByRole(role, { name })).toBeInTheDocument();
    }
    const controls = ['textbox', 'combobox', 'checkbox', 'button'].flatMap((role) => within(form()).queryAllByRole(role));
    expect(controls).toHaveLength(expected.length);
  });

  it('refuses a seven-character password before sending, under the field', async () => {
    const sent = stubApi();
    renderPage();
    await table();
    const user1 = await openForm();

    await user1.type(within(form()).getByLabelText('Email'), 'dee@example.test');
    await user1.type(within(form()).getByLabelText('Name'), 'Dee New');
    await user1.type(within(form()).getByLabelText('Temporary password'), 'short12');
    await user1.click(within(form()).getByRole('button', { name: 'Create user' }));

    const field = within(form()).getByLabelText('Temporary password');
    expect(field).toHaveAccessibleDescription(PASSWORD_LENGTH_MESSAGE);
    expect(field).toHaveAttribute('aria-invalid', 'true');
    await waitFor(() => expect(field).toHaveFocus());
    expect(document.body).not.toHaveTextContent(/String must contain/);
    expect(sent.filter((s) => s.method === 'POST')).toEqual([]);
  });

  it('refuses a project listed twice, under the repeated row', async () => {
    const sent = stubApi();
    renderPage();
    await table();
    const user1 = await openForm();

    await user1.type(within(form()).getByLabelText('Email'), 'dee@example.test');
    await user1.type(within(form()).getByLabelText('Name'), 'Dee New');
    await user1.type(within(form()).getByLabelText('Temporary password'), 'temporary-1');
    await user1.click(within(form()).getByRole('button', { name: 'Add project' }));
    await user1.click(within(form()).getByRole('button', { name: 'Add project' }));
    await user1.selectOptions(within(form()).getByRole('combobox', { name: 'Project 2' }), 'Checkout');
    await user1.click(within(form()).getByRole('button', { name: 'Create user' }));

    const repeated = within(form()).getByRole('combobox', { name: 'Project 2' });
    expect(repeated).toHaveAccessibleDescription('"checkout" is listed more than once. Give each project one role.');
    expect(repeated).toHaveAttribute('aria-invalid', 'true');
    expect(within(form()).getByRole('combobox', { name: 'Project 1' })).not.toHaveAttribute('aria-invalid');
    await waitFor(() => expect(repeated).toHaveFocus());
    expect(sent.filter((s) => s.method === 'POST')).toEqual([]);
  });

  /* The schema names a row by its POSITION; removing an earlier row moves
     every later one up, and the message has to move with its own row rather
     than stay at the position and land on a neighbour. */
  it('keeps a refused row’s message on that row when an earlier row is removed', async () => {
    stubApi();
    renderPage();
    await table();
    const user1 = await openForm();

    await user1.type(within(form()).getByLabelText('Email'), 'dee@example.test');
    await user1.type(within(form()).getByLabelText('Name'), 'Dee New');
    await user1.type(within(form()).getByLabelText('Temporary password'), 'temporary-1');
    const add = within(form()).getByRole('button', { name: 'Add project' });
    await user1.click(add); // Checkout
    await user1.click(add); // Search
    await user1.click(add); // Payments
    await user1.selectOptions(within(form()).getByRole('combobox', { name: 'Project 2' }), 'Checkout');
    await user1.click(within(form()).getByRole('button', { name: 'Create user' }));
    expect(within(form()).getByRole('combobox', { name: 'Project 2' })).toHaveAttribute('aria-invalid', 'true');

    await user1.click(within(form()).getByRole('button', { name: 'Remove project 1' }));

    // The refused row is now the first; Payments, now second, was never refused.
    const refused = within(form()).getByRole('combobox', { name: 'Project 1' });
    expect(refused).toHaveValue('checkout');
    expect(refused).toHaveAttribute('aria-invalid', 'true');
    expect(within(form()).getByRole('combobox', { name: 'Project 2' })).toHaveValue('payments');
    expect(within(form()).getByRole('combobox', { name: 'Project 2' })).not.toHaveAttribute('aria-invalid');
  });

  it('shows a 409 EMAIL_TAKEN in the form’s alert, and keeps what was typed', async () => {
    stubApi({
      create: () =>
        Promise.resolve(
          problem(409, 'EMAIL_TAKEN', 'An account already uses bo@example.test.', 'Use another email, or find that account in the list.'),
        ),
    });
    renderPage();
    await table();
    const user1 = await openForm();

    await user1.type(within(form()).getByLabelText('Email'), 'bo@example.test');
    await user1.type(within(form()).getByLabelText('Name'), 'Bo Again');
    await user1.type(within(form()).getByLabelText('Temporary password'), 'temporary-1');
    expect(within(form()).queryByRole('alert')).toBeNull();
    await user1.click(within(form()).getByRole('button', { name: 'Create user' }));

    const alert = await within(form()).findByRole('alert');
    expect(alert).toHaveTextContent('An account already uses bo@example.test.');
    expect(alert).toHaveTextContent('Use another email, or find that account in the list.');
    expect(disclosure().open).toBe(true);
    expect(within(form()).getByLabelText('Email')).toHaveValue('bo@example.test');
  });

  it('on success refreshes both lists, empties and closes the form, and shows the new row', async () => {
    const created = user({ id: 'user-new', name: 'Dee New', email: 'dee@example.test', mustChangePassword: true });
    let usersAfter: AdminUser[] = USERS;
    const sent = stubApi({
      users: () => Promise.resolve(json(200, { users: usersAfter })),
      create: () => {
        usersAfter = [...USERS, created];
        return Promise.resolve(json(201, created));
      },
    });
    renderPage();
    await table();
    const user1 = await openForm();
    const reads = (url: string) => sent.filter((s) => s.url === url && s.method === 'GET').length;
    const usersBefore = reads('/v1/admin/users');
    const projectsBefore = reads('/v1/admin/projects');

    await user1.type(within(form()).getByLabelText('Email'), 'dee@example.test');
    await user1.type(within(form()).getByLabelText('Name'), 'Dee New');
    await user1.type(within(form()).getByLabelText('Temporary password'), 'temporary-1');
    await user1.click(within(form()).getByRole('button', { name: 'Add project' }));
    await user1.click(within(form()).getByRole('button', { name: 'Create user' }));

    expect(within(await rowOf('dee@example.test')).getAllByRole('cell')[3]).toHaveTextContent('Must change password');
    await waitFor(() => expect(disclosure().open).toBe(false));
    // W7: member counts move too, so the projects list is asked again.
    expect(reads('/v1/admin/users')).toBe(usersBefore + 1);
    expect(reads('/v1/admin/projects')).toBe(projectsBefore + 1);
    expect(within(form()).getByLabelText('Email')).toHaveValue('');
    expect(within(form()).getByLabelText('Name')).toHaveValue('');
    expect(within(form()).getByLabelText('Temporary password')).toHaveValue('');
    expect(within(form()).getByRole('checkbox', { name: 'Admin' })).not.toBeChecked();
    expect(within(form()).queryByRole('combobox', { name: 'Project 1' })).toBeNull();
    // The submit is now inside a closed disclosure; the caret goes to what opens it.
    await waitFor(() => expect(screen.getByText('Add user', { selector: 'summary' })).toHaveFocus());
  });
});

/* ======================================================================== *
 * THE ROW MENU
 * ======================================================================== */

/* A second admin, so "Remove admin" has a row that is not the signed-in one
   (the session is Ada's). Every case below has at least two rows that could
   take the same action, so a request sent with the wrong row's id fails. */
const BEA = user({ id: 'user-bea', name: 'Bea Admin', email: 'bea@example.test', isAdmin: true });
const ROWS: AdminUser[] = [ADMIN, BEA, FLAGGED, DISABLED];

const writes = (sent: readonly Sent[]) =>
  sent.filter((s) => s.method !== 'GET').map(({ url, method, body }) => ({ url, method, body }));
const readsOf = (sent: readonly Sent[], url: string) => sent.filter((s) => s.url === url && s.method === 'GET').length;

const triggerOf = async (who: string) =>
  within(await table()).findByRole('button', { name: `${who}: more actions` });

async function openMenu(clicker: ReturnType<typeof userEvent.setup>, who: string) {
  await clicker.click(await triggerOf(who));
  return screen.findByRole('menu');
}

async function choose(clicker: ReturnType<typeof userEvent.setup>, who: string, item: string) {
  const menu = await openMenu(clicker, who);
  await clicker.click(within(menu).getByRole('menuitem', { name: item }));
}

/**
 * The line under a person's row that carries whatever their menu opened (a
 * confirm, the Reset password block, the edit panel) or refused. `null` when
 * there is none.
 */
async function detailsOf(email: string): Promise<HTMLElement | null> {
  const next = (await rowOf(email)).nextElementSibling;
  return next instanceof HTMLElement && next.dataset.testid === 'user-details' ? next : null;
}

async function mustDetails(email: string): Promise<HTMLElement> {
  const details = await detailsOf(email);
  if (details === null) throw new Error(`no details line under ${email}`);
  return details;
}

/**
 * Radix hands focus back to the trigger — or does not — on the macrotask AFTER
 * the menu unmounts, which is later than the focus a chosen item's block takes.
 * A focus assertion made the moment the block appears is satisfied by a page
 * about to lose it (`ProjectPackages.test.tsx` records the same).
 */
async function menuSettled() {
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

/**
 * Drops the caret to the page, as a browser may when the control holding it is
 * disabled mid-request. jsdom never does that itself, and its `blur()` does
 * nothing on a disabled control, so the caret passes through a focusable
 * element and is blurred from there.
 */
function dropCaret() {
  const region = screen.getByRole('region', { name: 'Users table' });
  act(() => {
    region.focus();
    region.blur();
  });
  expect(document.activeElement).toBe(document.body);
}

/** The users list, re-read after each change: `set` is what it says from then on. */
function liveUsers(initial: AdminUser[]) {
  let current = initial;
  return {
    answer: () => Promise.resolve(json(200, { users: current })),
    set: (next: AdminUser[]) => {
      current = next;
    },
  };
}

describe('AdminUsers — the row menu', () => {
  /* W6, again: one trigger per row, named after its person, and the email
     joins the name only where another row shares it. */
  it('names each row’s menu after its person, adding the email only where a display name repeats', async () => {
    const twins = [
      user({ id: 'u1', name: 'Sam Lee', email: 'sam.one@example.test' }),
      user({ id: 'u2', name: 'Sam Lee', email: 'sam.two@example.test' }),
      FLAGGED,
    ];
    stubApi({ users: () => Promise.resolve(json(200, { users: twins })) });
    renderPage();
    const users = await table();

    expect(
      within(users)
        .getAllByRole('button', { name: /: more actions$/ })
        .map((button) => button.getAttribute('aria-label')),
    ).toEqual([
      'Sam Lee (sam.one@example.test): more actions',
      'Sam Lee (sam.two@example.test): more actions',
      'Bo Flagged: more actions',
    ]);
  });

  it('offers each account the actions its state allows', async () => {
    stubApi({ users: () => Promise.resolve(json(200, { users: ROWS })) });
    renderPage();
    await table();
    const clicker = userEvent.setup();
    const items = async (who: string) => {
      const menu = await openMenu(clicker, who);
      const labels = within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent);
      await clicker.keyboard('{Escape}');
      await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
      return labels;
    };

    expect(await items('Bo Flagged')).toEqual(['Edit projects and roles', 'Reset password', 'Disable', 'Make admin', 'Remove']);
    expect(await items('Cy Disabled')).toEqual(['Edit projects and roles', 'Reset password', 'Enable', 'Make admin', 'Remove']);
    expect(await items('Bea Admin')).toEqual(['Edit projects and roles', 'Reset password', 'Disable', 'Remove admin', 'Remove']);
  });

  /* The API refuses these three on your own account; offering them would be
     offering a refusal. */
  it('leaves Disable, Reset password and Remove off the signed-in admin’s own row', async () => {
    stubApi({ users: () => Promise.resolve(json(200, { users: ROWS })) });
    renderPage();
    await table();
    const clicker = userEvent.setup();

    const menu = await openMenu(clicker, 'Ada Admin');
    expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'Edit projects and roles',
      'Remove admin',
    ]);
  });

  it('applies Enable, Make admin and Remove admin at once, each to its own row’s account', async () => {
    const sent = stubApi({ users: () => Promise.resolve(json(200, { users: ROWS })) });
    renderPage();
    await table();
    const clicker = userEvent.setup();

    await choose(clicker, 'Bo Flagged', 'Make admin');
    await choose(clicker, 'Cy Disabled', 'Enable');
    await choose(clicker, 'Bea Admin', 'Remove admin');

    await waitFor(() => expect(writes(sent)).toHaveLength(3));
    expect(writes(sent)).toEqual([
      { url: '/v1/admin/users/user-flagged', method: 'PATCH', body: { isAdmin: true } },
      { url: '/v1/admin/users/user-disabled', method: 'PATCH', body: { disabled: false } },
      { url: '/v1/admin/users/user-bea', method: 'PATCH', body: { isAdmin: false } },
    ]);
    // Nothing asked first: no row grew a confirm.
    expect(screen.queryAllByTestId('user-details')).toEqual([]);
  });

  /* W7: a role or an account change moves both tables. */
  it('re-reads both lists after a change', async () => {
    const sent = stubApi({ users: () => Promise.resolve(json(200, { users: ROWS })) });
    renderPage();
    await table();
    await waitFor(() => expect(readsOf(sent, '/v1/admin/projects')).toBe(1));
    const clicker = userEvent.setup();
    const usersBefore = readsOf(sent, '/v1/admin/users');

    await choose(clicker, 'Bo Flagged', 'Make admin');

    await waitFor(() => expect(readsOf(sent, '/v1/admin/users')).toBe(usersBefore + 1));
    await waitFor(() => expect(readsOf(sent, '/v1/admin/projects')).toBe(2));
  });

  it('asks before disabling, in that row, and disables only that account on the confirm', async () => {
    const sent = stubApi({ users: () => Promise.resolve(json(200, { users: ROWS })) });
    const { container } = renderPage();
    await table();
    const clicker = userEvent.setup();

    await choose(clicker, 'Bo Flagged', 'Disable');
    await menuSettled();

    const details = await mustDetails('bo@example.test');
    expect(within(details).getByRole('group', { name: 'Disable Bo Flagged? They are signed out everywhere.' })).toBeInTheDocument();
    expect(writes(sent)).toEqual([]);
    // Focus lands on Cancel, the safe answer, and stays once the menu has gone.
    expect(within(details).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    // Still one primary on the page: the confirm is not a second.
    expect([...container.querySelectorAll('button.bg-accent')]).toHaveLength(1);
    expect(within(details).getByRole('button', { name: 'Disable' }).className).not.toContain('bg-accent');

    await clicker.click(within(details).getByRole('button', { name: 'Disable' }));

    await waitFor(() =>
      expect(writes(sent)).toEqual([{ url: '/v1/admin/users/user-flagged', method: 'PATCH', body: { disabled: true } }]),
    );
    await waitFor(async () => expect(await detailsOf('bo@example.test')).toBeNull());
    // The block is gone; the caret goes back to the menu it came from.
    await waitFor(async () => expect(await triggerOf('Bo Flagged')).toHaveFocus());
  });

  it('asks before removing, and removes only that account on the confirm', async () => {
    const list = liveUsers(ROWS);
    const sent = stubApi({
      users: list.answer,
      write: (s) => {
        if (s.method === 'DELETE') list.set(ROWS.filter((u) => u.id !== DISABLED.id));
        return undefined;
      },
    });
    renderPage();
    await table();
    const clicker = userEvent.setup();

    await choose(clicker, 'Cy Disabled', 'Remove');
    await menuSettled();
    const details = await mustDetails('cy@example.test');
    expect(within(details).getByRole('group', { name: 'Remove Cy Disabled? Their run notes keep their text.' })).toBeInTheDocument();
    expect(writes(sent)).toEqual([]);
    expect(within(details).getByRole('button', { name: 'Cancel' })).toHaveFocus();

    await clicker.click(within(details).getByRole('button', { name: 'Remove' }));

    await waitFor(() => expect(writes(sent)).toEqual([{ url: '/v1/admin/users/user-disabled', method: 'DELETE', body: undefined }]));
    await waitFor(() => expect(within(screen.getByRole('table', { name: 'Users' })).queryByText('cy@example.test')).toBeNull());
    // The row is gone with its menu; the caret goes to the table it was in, not to the page.
    await waitFor(() => expect(screen.getByRole('region', { name: 'Users table' })).toHaveFocus());
  });

  it('closes a confirm on Cancel without a request, and returns focus to the row’s menu', async () => {
    const sent = stubApi({ users: () => Promise.resolve(json(200, { users: ROWS })) });
    renderPage();
    await table();
    const clicker = userEvent.setup();

    await choose(clicker, 'Bea Admin', 'Remove');
    await menuSettled();
    await clicker.click(within(await mustDetails('bea@example.test')).getByRole('button', { name: 'Cancel' }));

    expect(await detailsOf('bea@example.test')).toBeNull();
    expect(writes(sent)).toEqual([]);
    expect(await triggerOf('Bea Admin')).toHaveFocus();
  });

  /* W6 for the confirms too: the question names its group, so two people
     called Sam Lee would otherwise be asked about in identical words, and a
     screen reader arriving on Cancel could not tell whose account it was about
     to disable or remove. The email joins the name on those rows only — Bo's
     questions above stay as they were. */
  it('asks about each of two same-named people in words of their own', async () => {
    const twins = [
      user({ id: 'u1', name: 'Sam Lee', email: 'sam.one@example.test' }),
      user({ id: 'u2', name: 'Sam Lee', email: 'sam.two@example.test' }),
      FLAGGED,
    ];
    stubApi({ users: () => Promise.resolve(json(200, { users: twins })) });
    renderPage();
    await table();
    const clicker = userEvent.setup();

    const questionOf = async (who: string, email: string, item: 'Disable' | 'Remove') => {
      await choose(clicker, who, item);
      await menuSettled();
      return within(within(await mustDetails(email)).getByRole('group')).getByText(/\?/).textContent;
    };

    const one = 'Sam Lee (sam.one@example.test)';
    const two = 'Sam Lee (sam.two@example.test)';
    // Arming the second row closes the first (W15), so each is read on its own.
    expect(await questionOf(one, 'sam.one@example.test', 'Disable')).toBe(
      'Disable Sam Lee (sam.one@example.test)? They are signed out everywhere.',
    );
    expect(await questionOf(two, 'sam.two@example.test', 'Disable')).toBe(
      'Disable Sam Lee (sam.two@example.test)? They are signed out everywhere.',
    );
    expect(await questionOf(one, 'sam.one@example.test', 'Remove')).toBe(
      'Remove Sam Lee (sam.one@example.test)? Their run notes keep their text.',
    );
    expect(await questionOf(two, 'sam.two@example.test', 'Remove')).toBe(
      'Remove Sam Lee (sam.two@example.test)? Their run notes keep their text.',
    );
    // And the group is named by that question, so the two differ to a screen reader too.
    expect(
      within(await mustDetails('sam.two@example.test')).getByRole('group', {
        name: 'Remove Sam Lee (sam.two@example.test)? Their run notes keep their text.',
      }),
    ).toBeInTheDocument();
  });

  /* W11 and W3: a field that shows what is typed, and a short password refused
     in one sentence before anything is sent. */
  it('resets a password to a typed temporary one, refusing a short one before sending', async () => {
    const sent = stubApi({ users: () => Promise.resolve(json(200, { users: ROWS })) });
    renderPage();
    await table();
    const clicker = userEvent.setup();

    await choose(clicker, 'Bo Flagged', 'Reset password');
    await menuSettled();
    const details = await mustDetails('bo@example.test');
    const field = within(details).getByLabelText('Temporary password for Bo Flagged');
    expect(field).toHaveFocus();
    expect(field).toHaveAttribute('type', 'text');
    expect(field).toHaveAttribute('autocomplete', 'off');
    expect(field).toHaveAttribute('spellcheck', 'false');
    expect(details).toHaveTextContent('They must choose a new password at next sign-in, and are signed out everywhere.');
    const submit = within(details).getByRole('button', { name: 'Reset password' });
    expect(submit.className).not.toContain('bg-accent');

    await clicker.type(field, 'short12');
    await clicker.click(submit);
    expect(field).toHaveAccessibleDescription(PASSWORD_LENGTH_MESSAGE);
    expect(field).toHaveAttribute('aria-invalid', 'true');
    await waitFor(() => expect(field).toHaveFocus());
    expect(document.body).not.toHaveTextContent(/String must contain/);
    expect(writes(sent)).toEqual([]);

    await clicker.clear(field);
    await clicker.type(field, 'temporary-2');
    await clicker.click(submit);

    await waitFor(() =>
      expect(writes(sent)).toEqual([
        { url: '/v1/admin/users/user-flagged/password', method: 'PUT', body: { password: 'temporary-2' } },
      ]),
    );
    await waitFor(async () => expect(await detailsOf('bo@example.test')).toBeNull());
    await waitFor(async () => expect(await triggerOf('Bo Flagged')).toHaveFocus());
  });

  /* W7: LAST_ADMIN's own words, under the row it is about, and only there. */
  it('shows a 409 LAST_ADMIN’s detail and remediation under that row and no other', async () => {
    stubApi({
      users: () => Promise.resolve(json(200, { users: ROWS })),
      write: (s) =>
        s.url === '/v1/admin/users/user-bea'
          ? Promise.resolve(problem(409, 'LAST_ADMIN', 'Bea Admin is the last admin.', 'Make someone else an admin first.'))
          : undefined,
    });
    renderPage();
    await table();
    const clicker = userEvent.setup();

    await choose(clicker, 'Bea Admin', 'Remove admin');

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Bea Admin is the last admin.');
    expect(alert).toHaveTextContent('Make someone else an admin first.');
    expect(await mustDetails('bea@example.test')).toContainElement(alert);
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    for (const email of ['admin@example.test', 'bo@example.test', 'cy@example.test']) {
      expect(await detailsOf(email)).toBeNull();
    }
  });

  it('keeps a refused Remove’s confirm open, with the refusal in it', async () => {
    stubApi({
      users: () => Promise.resolve(json(200, { users: ROWS })),
      write: (s) =>
        s.method === 'DELETE'
          ? Promise.resolve(problem(409, 'LAST_ADMIN', 'Bea Admin is the last admin.', 'Make someone else an admin first.'))
          : undefined,
    });
    renderPage();
    await table();
    const clicker = userEvent.setup();

    await choose(clicker, 'Bea Admin', 'Remove');
    await menuSettled();
    const details = await mustDetails('bea@example.test');
    await clicker.click(within(details).getByRole('button', { name: 'Remove' }));

    expect(await within(details).findByRole('alert')).toHaveTextContent('Bea Admin is the last admin.');
    expect(within(details).getByRole('group', { name: 'Remove Bea Admin? Their run notes keep their text.' })).toBeInTheDocument();
  });

  it('locks a row’s controls while its request is in flight', async () => {
    stubApi({
      users: () => Promise.resolve(json(200, { users: ROWS })),
      write: () => new Promise<Response>(() => {}),
    });
    renderPage();
    await table();
    const clicker = userEvent.setup();

    await choose(clicker, 'Bo Flagged', 'Disable');
    await menuSettled();
    const details = await mustDetails('bo@example.test');
    await clicker.click(within(details).getByRole('button', { name: 'Disable' }));

    // A request already sent cannot be taken back, so Cancel goes quiet too.
    await waitFor(() => expect(within(details).getByRole('button', { name: 'Disable' })).toBeDisabled());
    expect(within(details).getByRole('button', { name: 'Cancel' })).toBeDisabled();
    const menu = await openMenu(clicker, 'Bo Flagged');
    for (const item of within(menu).getAllByRole('menuitem')) {
      expect(item).toHaveAttribute('aria-disabled', 'true');
    }
  });

  /* A control is disabled while its request is in flight, and jsdom keeps the
     caret on a disabled control where a browser may drop it to the page. So
     these drop it by hand while the request is held, as such a browser would,
     and then require it back once the answer arrives. */
  it('hands the caret back to the confirm a refusal came from, once it has been lost to the page', async () => {
    let answer: (response: Response) => void = () => {};
    stubApi({
      users: () => Promise.resolve(json(200, { users: ROWS })),
      write: (s) =>
        s.method === 'DELETE'
          ? new Promise<Response>((resolve) => {
              answer = resolve;
            })
          : undefined,
    });
    renderPage();
    await table();
    const clicker = userEvent.setup();

    await choose(clicker, 'Bea Admin', 'Remove');
    await menuSettled();
    const details = await mustDetails('bea@example.test');
    const confirm = within(details).getByRole('button', { name: 'Remove' });
    await clicker.click(confirm);
    await waitFor(() => expect(confirm).toBeDisabled());
    dropCaret();

    await act(async () => {
      answer(problem(409, 'LAST_ADMIN', 'Bea Admin is the last admin.', 'Make someone else an admin first.'));
    });

    expect(await within(details).findByRole('alert')).toHaveTextContent('Bea Admin is the last admin.');
    await waitFor(() => expect(confirm).toHaveFocus());
  });

  /* W7, for a refusal with nowhere left to land: the menus of other rows stay
     live while one row's request is in flight, so the reader can arm another
     row's block — which closes the one the request came from — before the
     answer arrives. The refusal still belongs to its own row. */
  it('shows a refusal on its own row’s line when its block was closed while the request was in flight', async () => {
    let answer: (response: Response) => void = () => {};
    stubApi({
      users: () => Promise.resolve(json(200, { users: ROWS })),
      write: (s) =>
        s.method === 'DELETE'
          ? new Promise<Response>((resolve) => {
              answer = resolve;
            })
          : undefined,
    });
    renderPage();
    await table();
    const clicker = userEvent.setup();

    await choose(clicker, 'Bea Admin', 'Remove');
    await menuSettled();
    const confirm = within(await mustDetails('bea@example.test')).getByRole('button', { name: 'Remove' });
    await clicker.click(confirm);
    await waitFor(() => expect(confirm).toBeDisabled());

    // Cy's Remove, armed while Bea's request is held: Bea's confirm closes.
    await choose(clicker, 'Cy Disabled', 'Remove');
    await menuSettled();
    expect(await detailsOf('bea@example.test')).toBeNull();
    const cy = await mustDetails('cy@example.test');
    const cyCancel = within(cy).getByRole('button', { name: 'Cancel' });
    expect(cyCancel).toHaveFocus();

    await act(async () => {
      answer(problem(409, 'LAST_ADMIN', 'Bea Admin is the last admin.', 'Make someone else an admin first.'));
    });

    await waitFor(async () => expect(await detailsOf('bea@example.test')).not.toBeNull());
    const bea = await mustDetails('bea@example.test');
    const alert = within(bea).getByRole('alert');
    expect(alert).toHaveTextContent('Bea Admin is the last admin.');
    expect(alert).toHaveTextContent('Make someone else an admin first.');
    // The refusal alone: Bea's confirm does not come back with it.
    expect(within(bea).queryByRole('group')).toBeNull();
    // Cy's block is untouched — no refusal in it, and the caret still where the reader put it.
    expect(within(cy).queryByRole('alert')).toBeNull();
    expect(within(cy).getByRole('group', { name: 'Remove Cy Disabled? Their run notes keep their text.' })).toBeInTheDocument();
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(cyCancel).toHaveFocus();
  });

  /* W17: your own admin flag is also your session's — the account menu offers
     Administration from it — so changing it re-reads the session. And the
     list's own refetch is then refused, which is shown as a refusal rather
     than as a table that may be out of date. */
  it('re-reads the session after the signed-in admin removes their own admin, and shows the list’s refusal', async () => {
    let demoted = false;
    const sent = stubApi({
      users: () =>
        Promise.resolve(
          demoted
            ? problem(403, 'ADMIN_REQUIRED', 'Administration needs an admin account.', 'Ask an admin to make you one.')
            : json(200, { users: ROWS }),
        ),
      write: (s) => {
        if (s.url === '/v1/admin/users/user-admin' && s.method === 'PATCH') demoted = true;
        return undefined;
      },
    });
    renderPage();
    await table();
    const clicker = userEvent.setup();
    const sessionReads = readsOf(sent, '/auth/get-session');

    await choose(clicker, 'Ada Admin', 'Remove admin');

    await waitFor(() => expect(readsOf(sent, '/auth/get-session')).toBe(sessionReads + 1));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Administration needs an admin account.');
    expect(alert).toHaveTextContent('Ask an admin to make you one.');
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByText('This list could not be refreshed, so it may be out of date.')).toBeNull();
  });

  /* W17's second half, and what the rail and Home read: an admin's org-wide
     reads span the whole org, a member's only their own projects. A
     self-demoting admin whose projects query is not re-read keeps a rail
     listing projects they can no longer open. The observer stands in for the
     rail, which asks the same key from the shell beside this page. */
  it('re-reads the org-wide project list after the signed-in admin removes their own admin', async () => {
    function ProjectsObserver() {
      useQuery({ queryKey: projectsQueryKey, queryFn: fetchProjects });
      return null;
    }
    const sent = stubApi({
      users: () => Promise.resolve(json(200, { users: ROWS })),
      read: (url) => (url === '/v1/projects' ? Promise.resolve(json(200, { items: [] })) : undefined),
    });
    renderPage(<ProjectsObserver />);
    await table();
    await waitFor(() => expect(readsOf(sent, '/v1/projects')).toBe(1));
    const clicker = userEvent.setup();

    await choose(clicker, 'Ada Admin', 'Remove admin');

    await waitFor(() => expect(readsOf(sent, '/v1/projects')).toBe(2));
  });

  it('leaves the session alone when the admin flag changed is someone else’s', async () => {
    const sent = stubApi({ users: () => Promise.resolve(json(200, { users: ROWS })) });
    renderPage();
    await table();
    await waitFor(() => expect(readsOf(sent, '/v1/admin/projects')).toBe(1));
    const clicker = userEvent.setup();
    const sessionReads = readsOf(sent, '/auth/get-session');
    const usersBefore = readsOf(sent, '/v1/admin/users');

    await choose(clicker, 'Bea Admin', 'Remove admin');

    await waitFor(() => expect(readsOf(sent, '/v1/admin/users')).toBe(usersBefore + 1));
    await waitFor(() => expect(readsOf(sent, '/v1/admin/projects')).toBe(2));
    // Both lists are re-read, so the change has been answered; give a third
    // refetch, issued beside them, the same moment to have been sent.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(readsOf(sent, '/auth/get-session')).toBe(sessionReads);
  });

  /* W15: one inline block at a time across the whole table. */
  it('opens one block at a time: arming another row closes the first', async () => {
    stubApi({ users: () => Promise.resolve(json(200, { users: ROWS })) });
    renderPage();
    await table();
    const clicker = userEvent.setup();

    await choose(clicker, 'Bo Flagged', 'Disable');
    expect(await detailsOf('bo@example.test')).not.toBeNull();

    await choose(clicker, 'Cy Disabled', 'Reset password');
    expect(await detailsOf('bo@example.test')).toBeNull();
    expect(within(await mustDetails('cy@example.test')).getByLabelText('Temporary password for Cy Disabled')).toBeInTheDocument();

    await choose(clicker, 'Ada Admin', 'Edit projects and roles');
    expect(await detailsOf('cy@example.test')).toBeNull();
    expect(
      within(await mustDetails('admin@example.test')).getByRole('group', { name: 'Ada Admin: projects and roles' }),
    ).toBeInTheDocument();
    expect(screen.getAllByTestId('user-details')).toHaveLength(1);
  });
});

describe('AdminUsers — Edit projects and roles', () => {
  const panelOf = async (who: string, email: string) =>
    within(await mustDetails(email)).getByRole('group', { name: `${who}: projects and roles` });

  it('names every control in the panel differently, one membership per line', async () => {
    stubApi({ users: () => Promise.resolve(json(200, { users: ROWS })) });
    renderPage();
    await table();
    const clicker = userEvent.setup();

    await choose(clicker, 'Ada Admin', 'Edit projects and roles');
    await menuSettled();
    const panel = await panelOf('Ada Admin', 'admin@example.test');

    const expected: [string, string][] = [
      ['combobox', 'Role in Checkout'],
      ['button', 'Remove from project Checkout'],
      ['combobox', 'Role in Search'],
      ['button', 'Remove from project Search'],
      ['combobox', 'Project'],
      ['combobox', 'Role'],
      ['button', 'Add'],
      ['button', 'Close'],
    ];
    for (const [role, name] of expected) {
      expect(within(panel).getByRole(role, { name })).toBeInTheDocument();
    }
    expect(within(panel).queryAllByRole('combobox').length + within(panel).queryAllByRole('button').length).toBe(
      expected.length,
    );
    expect(within(panel).getByRole('combobox', { name: 'Role in Checkout' })).toHaveValue('manager');
    expect(within(panel).getByRole('combobox', { name: 'Role in Search' })).toHaveValue('viewer');
    // Opening it puts the caret on its first control, and the menu closing does not take it back.
    expect(within(panel).getByRole('combobox', { name: 'Role in Checkout' })).toHaveFocus();
  });

  it('saves a role as it is chosen, for that person in that project, and re-reads both lists', async () => {
    const sent = stubApi({ users: () => Promise.resolve(json(200, { users: ROWS })) });
    renderPage();
    await table();
    await waitFor(() => expect(readsOf(sent, '/v1/admin/projects')).toBe(1));
    const clicker = userEvent.setup();
    const usersBefore = readsOf(sent, '/v1/admin/users');

    await choose(clicker, 'Bo Flagged', 'Edit projects and roles');
    const panel = await panelOf('Bo Flagged', 'bo@example.test');
    await clicker.selectOptions(within(panel).getByRole('combobox', { name: 'Role in Checkout' }), 'Manager');

    await waitFor(() =>
      expect(writes(sent)).toEqual([
        { url: '/v1/projects/checkout/members/user-flagged', method: 'PATCH', body: { role: 'manager' } },
      ]),
    );
    await waitFor(() => expect(readsOf(sent, '/v1/admin/users')).toBe(usersBefore + 1));
    await waitFor(() => expect(readsOf(sent, '/v1/admin/projects')).toBe(2));
    // An editor, not a confirm: it stays open for the next change.
    expect(await panelOf('Bo Flagged', 'bo@example.test')).toBeInTheDocument();
  });

  it('hands the caret back to a role select once its save is done, if it was lost to the page meanwhile', async () => {
    let answer: (response: Response) => void = () => {};
    stubApi({
      users: () => Promise.resolve(json(200, { users: ROWS })),
      write: (s) =>
        s.method === 'PATCH'
          ? new Promise<Response>((resolve) => {
              answer = resolve;
            })
          : undefined,
    });
    renderPage();
    await table();
    const clicker = userEvent.setup();

    await choose(clicker, 'Bo Flagged', 'Edit projects and roles');
    const panel = await panelOf('Bo Flagged', 'bo@example.test');
    const role = within(panel).getByRole('combobox', { name: 'Role in Checkout' });
    await clicker.selectOptions(role, 'Manager');
    await waitFor(() => expect(role).toBeDisabled());
    // The choice in flight is what the select shows, not the stored role.
    expect(role).toHaveValue('manager');
    dropCaret();

    await act(async () => {
      answer(json(200, member(FLAGGED.id, 'manager')));
    });

    await waitFor(() => expect(role).toBeEnabled());
    await waitFor(() => expect(role).toHaveFocus());
  });

  /* The converse: the caret is only handed back when nobody has taken it. */
  it('leaves the caret where the reader took it while a save was in flight', async () => {
    let answer: (response: Response) => void = () => {};
    stubApi({
      users: () => Promise.resolve(json(200, { users: ROWS })),
      write: (s) =>
        s.method === 'PATCH'
          ? new Promise<Response>((resolve) => {
              answer = resolve;
            })
          : undefined,
    });
    renderPage();
    await table();
    const clicker = userEvent.setup();

    await choose(clicker, 'Bo Flagged', 'Edit projects and roles');
    const panel = await panelOf('Bo Flagged', 'bo@example.test');
    const role = within(panel).getByRole('combobox', { name: 'Role in Checkout' });
    await clicker.selectOptions(role, 'Manager');
    await waitFor(() => expect(role).toBeDisabled());
    const elsewhere = screen.getByText('Add user', { selector: 'summary' });
    act(() => elsewhere.focus());

    await act(async () => {
      answer(json(200, member(FLAGGED.id, 'manager')));
    });

    await waitFor(() => expect(role).toBeEnabled());
    // A macrotask more, for anything that would move it after the enabling render.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(elsewhere).toHaveFocus();
  });

  it('removes a person from one project, then offers it back and keeps the caret in the panel', async () => {
    const list = liveUsers(ROWS);
    const sent = stubApi({
      users: list.answer,
      write: (s) => {
        if (s.method === 'DELETE') list.set(ROWS.map((u) => (u.id === FLAGGED.id ? { ...u, memberships: [] } : u)));
        return undefined;
      },
    });
    renderPage();
    await table();
    const clicker = userEvent.setup();

    await choose(clicker, 'Bo Flagged', 'Edit projects and roles');
    await menuSettled();
    const panel = await panelOf('Bo Flagged', 'bo@example.test');
    await clicker.click(within(panel).getByRole('button', { name: 'Remove from project Checkout' }));

    await waitFor(() =>
      expect(writes(sent)).toEqual([{ url: '/v1/projects/checkout/members/user-flagged', method: 'DELETE', body: undefined }]),
    );
    await waitFor(() => expect(within(panel).queryByRole('combobox', { name: 'Role in Checkout' })).toBeNull());
    const project = within(panel).getByRole('combobox', { name: 'Project' });
    expect(within(project).getAllByRole('option').map((o) => o.textContent)).toEqual(['Checkout', 'Search', 'Payments']);
    // The button pressed has gone with its line; the caret goes to what can add it back.
    await waitFor(() => expect(project).toHaveFocus());
  });

  /* W5 and W12: the first project they do not hold, as a Viewer. */
  it('adds a person to a project they do not hold, starting on the first one as a Viewer', async () => {
    const list = liveUsers(ROWS);
    const sent = stubApi({
      users: list.answer,
      write: (s) => {
        if (s.method === 'POST') {
          list.set(
            ROWS.map((u) =>
              u.id === FLAGGED.id
                ? {
                    ...u,
                    memberships: [...u.memberships, { projectSlug: 'payments', projectName: 'Payments', role: 'member' as const }],
                  }
                : u,
            ),
          );
        }
        return undefined;
      },
    });
    renderPage();
    await table();
    const clicker = userEvent.setup();

    await choose(clicker, 'Bo Flagged', 'Edit projects and roles');
    await menuSettled();
    const panel = await panelOf('Bo Flagged', 'bo@example.test');
    const add = within(panel).getByRole('group', { name: 'Add to project' });
    const project = within(add).getByRole('combobox', { name: 'Project' });
    // Checkout is theirs already, so it is not offered, and Search comes first.
    expect(project).toHaveValue('search');
    expect(within(project).getAllByRole('option').map((o) => [o.textContent, (o as HTMLOptionElement).value])).toEqual([
      ['Search', 'search'],
      ['Payments', 'payments'],
    ]);
    expect(within(add).getByRole('combobox', { name: 'Role' })).toHaveValue('viewer');

    await clicker.selectOptions(project, 'Payments');
    await clicker.selectOptions(within(add).getByRole('combobox', { name: 'Role' }), 'Member');
    await clicker.click(within(add).getByRole('button', { name: 'Add' }));

    await waitFor(() =>
      expect(writes(sent)).toEqual([
        { url: '/v1/projects/payments/members', method: 'POST', body: { userId: 'user-flagged', role: 'member' } },
      ]),
    );
    // The new line arrives, and the caret goes to its role.
    await waitFor(() => expect(within(panel).getByRole('combobox', { name: 'Role in Payments' })).toHaveFocus());
    expect(within(add).getByRole('combobox', { name: 'Role' })).toHaveValue('viewer');
  });

  it('cannot add once the person holds every project', async () => {
    const everywhere = user({
      id: 'user-everywhere',
      name: 'Eve Everywhere',
      email: 'eve@example.test',
      memberships: PROJECTS.map((p) => ({ projectSlug: p.slug, projectName: p.name, role: 'viewer' as const })),
    });
    stubApi({ users: () => Promise.resolve(json(200, { users: [ADMIN, everywhere] })) });
    renderPage();
    await table();
    const clicker = userEvent.setup();

    await choose(clicker, 'Eve Everywhere', 'Edit projects and roles');
    const add = within(await panelOf('Eve Everywhere', 'eve@example.test')).getByRole('group', { name: 'Add to project' });
    expect(within(add).getByRole('combobox', { name: 'Project' })).toBeDisabled();
    expect(within(add).getByRole('button', { name: 'Add' })).toBeDisabled();
  });

  it('cannot add before the projects list has loaded', async () => {
    stubApi({
      users: () => Promise.resolve(json(200, { users: ROWS })),
      projects: () => new Promise<Response>(() => {}),
    });
    renderPage();
    await table();
    const clicker = userEvent.setup();

    await choose(clicker, 'Bo Flagged', 'Edit projects and roles');
    const add = within(await panelOf('Bo Flagged', 'bo@example.test')).getByRole('group', { name: 'Add to project' });
    expect(within(add).getByRole('button', { name: 'Add' })).toBeDisabled();
  });

  it('shows a refused add’s own words in the panel, and keeps it open', async () => {
    stubApi({
      users: () => Promise.resolve(json(200, { users: ROWS })),
      write: (s) =>
        s.method === 'POST'
          ? Promise.resolve(problem(409, 'MEMBER_EXISTS', 'Bo Flagged already holds a role in Search.', 'Change that role instead.'))
          : undefined,
    });
    renderPage();
    await table();
    const clicker = userEvent.setup();

    await choose(clicker, 'Bo Flagged', 'Edit projects and roles');
    const panel = await panelOf('Bo Flagged', 'bo@example.test');
    await clicker.click(within(panel).getByRole('button', { name: 'Add' }));

    const alert = await within(panel).findByRole('alert');
    expect(alert).toHaveTextContent('Bo Flagged already holds a role in Search.');
    expect(alert).toHaveTextContent('Change that role instead.');
    expect(screen.getAllByRole('alert')).toHaveLength(1);
  });

  it('closes on Close, and returns focus to the row’s menu', async () => {
    stubApi({ users: () => Promise.resolve(json(200, { users: ROWS })) });
    renderPage();
    await table();
    const clicker = userEvent.setup();

    await choose(clicker, 'Bo Flagged', 'Edit projects and roles');
    await clicker.click(within(await panelOf('Bo Flagged', 'bo@example.test')).getByRole('button', { name: 'Close' }));

    expect(await detailsOf('bo@example.test')).toBeNull();
    expect(await triggerOf('Bo Flagged')).toHaveFocus();
  });
});

/* W14: every change triggers a refetch of the list, and a refetch that fails
   must not take a table that is still true off the screen. */
describe('AdminUsers — a failed refresh', () => {
  it('keeps the table it has, and says quietly that it could not be refreshed', async () => {
    let failing = false;
    stubApi({
      users: () =>
        Promise.resolve(
          failing
            ? problem(500, 'INTERNAL', 'The request could not be completed.', 'Retry the request.')
            : json(200, { users: USERS }),
        ),
    });
    const { client } = renderPage();
    await table();

    failing = true;
    await act(() => client.invalidateQueries({ queryKey: adminUsersQueryKey }));

    expect(await screen.findByText('This list could not be refreshed, so it may be out of date.')).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Users' })).toBeInTheDocument();
    expect(screen.queryByText('Users could not be loaded')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  /* W17: a 401 or a 403 is the API refusing this session the list, not a list
     gone stale. A table left on screen would go on offering what is refused. */
  it.each([
    [403, 'ADMIN_REQUIRED', 'Administration needs an admin account.', 'Ask an admin to make you one.'],
    [401, 'UNAUTHENTICATED', 'Session expired.', 'Sign in again.'],
  ])('shows a %i refusing the refetch instead of the table it had', async (status, code, detail, remediation) => {
    let refusing = false;
    stubApi({
      users: () =>
        Promise.resolve(refusing ? problem(status, code, detail, remediation) : json(200, { users: USERS })),
    });
    const { client } = renderPage();
    await table();

    refusing = true;
    await act(() => client.invalidateQueries({ queryKey: adminUsersQueryKey }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(detail);
    expect(alert).toHaveTextContent(remediation);
    expect(screen.getByText('Users could not be loaded')).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByText('Add user', { selector: 'summary' })).toBeNull();
    expect(screen.queryByText('This list could not be refreshed, so it may be out of date.')).toBeNull();
  });
});
