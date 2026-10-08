// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccessAction, Package } from '@perfportal/contracts';
import ProjectPackages from '../src/routes/ProjectPackages';

/**
 * ═══ EACH PACKAGE CONTROL ASKS ITS OWN ACTION ═══
 *
 * `ProjectPackages.test.tsx` drives the real access hook with real roles, and
 * there every action this page gates — `packages:manage`, `packages:delete`,
 * `runner:run` — asks for Member. So under real roles the three flags always
 * agree: a Viewer has none and a Member all three, and a control gated on the
 * WRONG one of them, or a menu that misjudges which items it has, passes every
 * case there. Two guards that agree on every reachable state mask each other.
 *
 * This file is the state only the per-control gates can answer: the shell's
 * `useProjectAccess` is replaced by a stand-in that allows exactly the actions
 * a case names, so each control is seen to follow its own action and nothing
 * else — and the row menu's separator, which sits between two groups only
 * when both are there. Everything else on the page is real.
 */

/** The actions the stand-in allows, and a way to change them under a mounted page (as a role change does). */
const allowed = vi.hoisted(() => {
  let current: ReadonlySet<string> = new Set();
  const listeners = new Set<() => void>();
  return {
    get: (): ReadonlySet<string> => current,
    set(next: readonly string[]): void {
      current = new Set(next);
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
});

vi.mock('../src/access/useAccess', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/access/useAccess')>();
  const { useMemo, useSyncExternalStore } = await import('react');
  return {
    ...actual,
    // Known, and allowing exactly what the case set — read through a store,
    // so a case can change it under the mounted page.
    useProjectAccess: () => {
      const current = useSyncExternalStore(allowed.subscribe, allowed.get);
      return useMemo(
        () => ({ known: true, can: (action: AccessAction) => current.has(action) }),
        [current],
      );
    },
  };
});

const fetchPackages = vi.fn();
vi.mock('../src/api/packages.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api/packages.js')>();
  return { ...actual, fetchPackages: (slug: string) => fetchPackages(slug) };
});

const fetchProjects = vi.fn();
vi.mock('../src/api/projects.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api/projects.js')>();
  return { ...actual, fetchProjects: () => fetchProjects() };
});

afterEach(cleanup);

/** Satisfies the real `PackageSchema`, as `ProjectPackages.test.tsx`'s own fixture does. */
const CHECKOUT: Package = {
  id: '22222222-2222-4222-8222-222222222222',
  name: 'Checkout',
  kind: 'gatling_jar',
  createdAt: '2026-09-20T08:00:00.000Z',
  updatedAt: '2026-10-01T09:30:00.000Z',
  current: {
    artifactId: '33333333-3333-4333-8333-333333333333',
    filename: 'checkout.jar',
    bytes: 1_887_437,
    sha256: 'a'.repeat(64),
    gatlingVersion: '3.15.1',
    simulations: ['example.BasicSimulation'],
    uploadedAt: '2026-10-01T09:30:00.000Z',
  },
  usage: { tests: 2, runs: 9, activeJobs: 0 },
};

beforeEach(() => {
  vi.clearAllMocks();
  allowed.set([]);
  fetchProjects.mockResolvedValue({
    items: [{ id: '11111111-1111-4111-8111-111111111111', slug: 'checkout', name: 'Checkout Flow', latestRun: null }],
  });
  fetchPackages.mockResolvedValue({ items: [CHECKOUT] });
});

function renderAllowing(actions: readonly AccessAction[]) {
  allowed.set(actions);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/projects/checkout/packages']}>
        <Routes>
          <Route path="/projects/:slug/packages" element={<ProjectPackages />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Opens Checkout's row menu and reads its items and whether a separator divides them. */
async function menuOf(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Checkout: package actions' }));
  const menu = await screen.findByRole('menu');
  return {
    items: within(menu).getAllByRole('menuitem').map((item) => item.textContent),
    separated: within(menu).queryAllByRole('separator').length > 0,
  };
}

const newPackage = () => screen.queryByText('New package');
const upload = () => screen.queryByRole('button', { name: 'Upload a file to Checkout' });

describe('Packages — each control asks its own action', () => {
  it('offers New package, Upload and Rename for packages:manage alone, and no separator', async () => {
    const user = userEvent.setup();
    renderAllowing(['packages:manage']);
    await screen.findByTestId('package-row');

    expect(newPackage()).not.toBeNull();
    expect(upload()).not.toBeNull();
    expect(await menuOf(user)).toEqual({ items: ['Rename'], separated: false });
  });

  it('offers Delete alone for packages:delete alone: no New package, no Upload', async () => {
    const user = userEvent.setup();
    renderAllowing(['packages:delete']);
    await screen.findByTestId('package-row');

    expect(newPackage()).toBeNull();
    expect(upload()).toBeNull();
    expect(await menuOf(user)).toEqual({ items: ['Delete'], separated: false });
  });

  it('offers New run from this package alone for runner:run alone', async () => {
    const user = userEvent.setup();
    renderAllowing(['runner:run']);
    await screen.findByTestId('package-row');

    expect(newPackage()).toBeNull();
    expect(upload()).toBeNull();
    expect(await menuOf(user)).toEqual({ items: ['New run from this package'], separated: false });
  });

  it('separates Delete from the items above it only when both groups are there', async () => {
    const user = userEvent.setup();
    renderAllowing(['packages:manage', 'packages:delete']);
    await screen.findByTestId('package-row');

    expect(await menuOf(user)).toEqual({ items: ['Rename', 'Delete'], separated: true });
  });

  it('draws no menu, no Upload and no Actions column when the reader may take none of them', async () => {
    // Allowed something the page does not gate on, so access is known and
    // the absences are about these three actions.
    renderAllowing(['rules:edit']);
    await screen.findByTestId('package-row');

    expect(screen.queryByRole('button', { name: 'Checkout: package actions' })).toBeNull();
    expect(upload()).toBeNull();
    expect(newPackage()).toBeNull();
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).not.toContain('Actions');
  });

  /**
   * An armed rename goes with Rename, not with the row: the reader keeps the
   * menu (Delete is still theirs) and loses the block whose Save the API would
   * refuse.
   */
  it('takes an armed rename away when packages:manage goes, leaving the row its Delete', async () => {
    const user = userEvent.setup();
    renderAllowing(['packages:manage', 'packages:delete']);
    await screen.findByTestId('package-row');

    await user.click(screen.getByRole('button', { name: 'Checkout: package actions' }));
    await user.click(within(await screen.findByRole('menu')).getByRole('menuitem', { name: 'Rename' }));
    expect(await screen.findByRole('textbox', { name: 'New name for Checkout' })).toBeInTheDocument();

    act(() => {
      allowed.set(['packages:delete']);
    });

    expect(screen.queryByRole('textbox', { name: 'New name for Checkout' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Checkout: package actions' })).toBeInTheDocument();
  });
});
