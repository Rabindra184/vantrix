// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AdminProject, AdminUser } from '@perfportal/contracts';
import AdminUsers from '../src/routes/AdminUsers';
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
    return Promise.resolve(json(404, {}));
  });
  return sent;
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[ADMIN_USERS_ROUTE]}>
        <AdminUsers />
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
  it('lists each account with its email, project count and status, under the four columns', async () => {
    stubApi();
    renderPage();
    const users = await table();

    expect(within(users).getAllByRole('columnheader').map((th) => th.textContent)).toEqual([
      'Name',
      'Email',
      'Projects',
      'Status',
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
    // Each membership its own item, so they are read apart rather than run together.
    expect(tip).toHaveAccessibleDescription('Checkout · Manager Search · Viewer');
  });

  it('draws no info for an account in no project', async () => {
    stubApi();
    renderPage();
    await table();

    expect(within(await rowOf('cy@example.test')).queryByRole('button')).toBeNull();
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

    const names = within(users)
      .getAllByRole('button')
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
