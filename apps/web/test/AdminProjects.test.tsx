// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AdminProject } from '@perfportal/contracts';
import AdminProjects from '../src/routes/AdminProjects';
import { ADMIN_PROJECTS_ROUTE, ADMIN_USERS_ROUTE, NEW_PROJECT_ROUTE } from '../src/routes/paths';

// No vitest globals here, so Testing Library's automatic cleanup never
// registers; without this every render stacks in one `document.body`.
afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());

const project = (slug: string, name: string, memberCount: number): AdminProject => ({
  slug,
  name,
  memberCount,
  createdAt: '2026-09-20T08:00:00.000Z',
});

const PROJECTS: AdminProject[] = [project('checkout', 'Checkout', 3), project('search', 'Search', 0)];

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function stubProjects(answer: () => Response): void {
  vi.stubGlobal('fetch', (input: RequestInfo | URL) =>
    Promise.resolve(String(input) === '/v1/admin/projects' ? answer() : json(404, {})),
  );
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[ADMIN_PROJECTS_ROUTE]}>
        <AdminProjects />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('AdminProjects', () => {
  it('is the Projects section of Administration, with Users one tab over', async () => {
    stubProjects(() => json(200, { projects: PROJECTS }));
    renderPage();
    await screen.findByRole('table', { name: 'Projects' });

    expect(screen.getByRole('heading', { level: 1, name: 'Administration' })).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Administration sections' });
    expect(within(nav).getAllByRole('link', { current: 'page' }).map((link) => link.textContent)).toEqual(['Projects']);
    expect(within(nav).getByRole('link', { name: 'Users' })).toHaveAttribute('href', ADMIN_USERS_ROUTE);
    expect(document.title).toBe('Projects · Administration · PerfPortal');
  });

  it('lists every project with its member count', async () => {
    stubProjects(() => json(200, { projects: PROJECTS }));
    renderPage();
    const projects = await screen.findByRole('table', { name: 'Projects' });

    expect(within(projects).getAllByRole('columnheader').map((th) => th.textContent)).toEqual(['Name', 'Members']);
    const rows = within(projects)
      .getAllByRole('row')
      .slice(1)
      .map((row) => within(row).getAllByRole('cell').map((cell) => cell.textContent));
    expect(rows).toEqual([
      ['Checkout', '3'],
      ['Search', '0'],
    ]);
  });

  /* W8: a project's name here is text. The rail already links every project
     the session can see, and a second link per row under the same name would
     put two links with one accessible name in the document. */
  it('names each project as plain text, not a link', async () => {
    stubProjects(() => json(200, { projects: PROJECTS }));
    renderPage();
    const projects = await screen.findByRole('table', { name: 'Projects' });

    expect(within(projects).queryAllByRole('link')).toEqual([]);
  });

  it('offers New project, which opens the existing form', async () => {
    stubProjects(() => json(200, { projects: PROJECTS }));
    renderPage();
    await screen.findByRole('table', { name: 'Projects' });

    expect(screen.getByRole('link', { name: 'New project' })).toHaveAttribute('href', NEW_PROJECT_ROUTE);
  });

  it('says there are no projects rather than drawing an empty table', async () => {
    stubProjects(() => json(200, { projects: [] }));
    renderPage();

    expect(await screen.findByText('No projects yet')).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getByRole('link', { name: 'New project' })).toHaveAttribute('href', NEW_PROJECT_ROUTE);
  });

  it('shows the API’s own refusal, inside the shell, when the session is not an admin', async () => {
    stubProjects(() =>
      json(403, {
        type: 'about:blank',
        title: 'Forbidden',
        status: 403,
        code: 'ADMIN_REQUIRED',
        detail: 'Administration needs an admin account.',
        remediation: 'Ask an admin to make you one.',
      }),
    );
    renderPage();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Administration needs an admin account.');
    expect(alert).toHaveTextContent('Ask an admin to make you one.');
    expect(screen.getByRole('heading', { level: 1, name: 'Administration' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Administration sections' })).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByRole('link', { name: 'New project' })).toBeNull();
  });
});
