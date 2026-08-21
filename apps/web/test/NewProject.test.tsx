// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProject } from '../src/api/projects.js';
import NewProject from '../src/routes/NewProject.js';

vi.mock('../src/api/projects.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/api/projects.js')>()),
  createProject: vi.fn(async (body) => ({
    id: '00000000-0000-4000-8000-000000000123',
    slug: body.slug,
    name: body.name,
    latestRun: null,
  })),
}));

const createProjectMock = vi.mocked(createProject);

afterEach(() => {
  cleanup();
  createProjectMock.mockClear();
});

describe('NewProject', () => {
  it('creates a project and sends the reader to setup', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const router = createMemoryRouter(
      [
        { path: '/projects/new', element: <NewProject /> },
        { path: '/projects/:slug/setup', element: <p>Setup screen</p> },
      ],
      { initialEntries: ['/projects/new'] },
    );

    render(
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    fireEvent.change(screen.getByLabelText(/project name/i), { target: { value: 'Checkout API' } });
    expect(screen.getByLabelText(/url slug/i)).toHaveValue('checkout-api');
    fireEvent.click(screen.getByRole('button', { name: /create project/i }));

    await screen.findByText('Setup screen');
    expect(router.state.location.pathname).toBe('/projects/checkout-api/setup');
    expect(createProjectMock.mock.calls[0]?.[0]).toEqual({ name: 'Checkout API', slug: 'checkout-api' });
  });

  it('keeps invalid project details in the form', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const router = createMemoryRouter([{ path: '/projects/new', element: <NewProject /> }], {
      initialEntries: ['/projects/new'],
    });

    render(
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    fireEvent.change(screen.getByLabelText(/project name/i), { target: { value: 'A' } });
    fireEvent.click(screen.getByRole('button', { name: /create project/i }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/at least 2 character/i));
    expect(createProjectMock).not.toHaveBeenCalled();
  });
});
