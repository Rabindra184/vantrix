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
  /**
   * The same router the first test builds inline, factored out for the cases
   * below that only care about the form's own behaviour. Kept local rather
   * than rewriting the existing tests around it: those assert navigation,
   * which needs the `/projects/:slug/setup` route they already declare.
   */
  function renderNewProject() {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const router = createMemoryRouter(
      [
        { path: '/projects/new', element: <NewProject /> },
        { path: '/projects/:slug/setup', element: <p>Setup screen</p> },
      ],
      { initialEntries: ['/projects/new'] },
    );
    return render(
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
  }

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

  /**
   * A HYPHEN MUST SURVIVE BEING TYPED, which it did not.
   *
   * The field ran the full `slugify` on every keystroke, and that function
   * ends by trimming a trailing hyphen — so the instant the reader pressed
   * `-`, the controlled input was re-rendered without it. Typing
   * `checkout-api` produced `checkoutapi`, while the placeholder advertised
   * `checkout-api` and the validation message asked for "single hyphens".
   * Only the name-derived path looked correct (asserted above), because that
   * slugifies a whole string at once, where no hyphen is ever trailing.
   *
   * Typed CHARACTER BY CHARACTER on purpose: a single `fireEvent.change`
   * with the finished string passes against the broken code, because the
   * hyphen is interior by then. The bug lives in the intermediate state, so
   * the test has to visit it.
   */
  it('lets a hyphen be typed into the slug, one keystroke at a time', async () => {
    renderNewProject();

    const slugField = await screen.findByLabelText(/url slug/i);
    let typed = '';
    for (const character of 'checkout-api') {
      typed += character;
      fireEvent.change(slugField, { target: { value: typed } });
      // The field is controlled, so what it echoes back becomes the base for
      // the next keystroke — exactly as a real reader experiences it.
      typed = (slugField as HTMLInputElement).value;
    }

    expect(slugField).toHaveValue('checkout-api');
  });

  /**
   * The other half: leaving the field still normalises, so a dangling
   * hyphen never reaches the schema (which rejects it).
   */
  it('trims a dangling hyphen when the reader leaves the slug field', async () => {
    renderNewProject();

    const slugField = await screen.findByLabelText(/url slug/i);
    fireEvent.change(slugField, { target: { value: 'checkout-' } });
    expect(slugField).toHaveValue('checkout-');

    // `focusOut`, not `blur`: React 18 maps `onBlur` onto the native
    // `focusout`, which bubbles to its delegated root listener. A `blur`
    // event does not bubble, so `fireEvent.blur` never reaches the handler
    // and this assertion would fail against perfectly correct code.
    fireEvent.focusOut(slugField);
    expect(slugField).toHaveValue('checkout');
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
