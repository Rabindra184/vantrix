// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Package } from '@perfportal/contracts';
import { ProblemError } from '../src/api/fetch.js';
import { formatBytes } from '../src/api/uploadBundle.js';
import { formatInstant } from '../src/routes/format.js';
import { projectNewRunnerRunPath } from '../src/routes/paths.js';

// `vitest.config.ts` sets no `globals`, so Testing Library's automatic cleanup
// never registers and every `render` here would otherwise stack in the same
// `document.body` — see CLAUDE.md on the flake that caused.
afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());
// jsdom ships no `navigator.clipboard`; the case that needs one installs it and
// this takes it away again, so no later case inherits a clipboard it did not ask for.
afterEach(() => {
  Reflect.deleteProperty(navigator, 'clipboard');
});

/**
 * ═══ BACKLOG #8 — A PACKAGE IS A FIRST-CLASS THING, AND THIS IS ITS PAGE ═══
 *
 * Gatling Enterprise's Packages page is a table — Name, Format, Used by, File,
 * Last upload, Actions — and this is the same table without the Team column,
 * because this product has no teams. What the cases pin is the part a reader
 * would be misled by if it drifted: the reverse counts ("Used by", which is
 * the whole reason to look at a package rather than at a jar), the honest
 * empty state ("No file yet" is not a file, and "0 runs" is not nothing), and
 * the one refusal worth saying out loud — a package that runs are queued or
 * running on cannot be deleted, and the menu says so in TEXT.
 *
 * `../src/api/packages.js` is mocked with `importOriginal`, so the query key
 * and every other export stay real; only the five functions that touch the
 * network are replaced.
 */

const fetchPackages = vi.fn();
const createPackage = vi.fn();
const uploadPackageContent = vi.fn();
const renamePackage = vi.fn();
const deletePackage = vi.fn();

vi.mock('../src/api/packages.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api/packages.js')>();
  return {
    ...actual,
    fetchPackages: (slug: string) => fetchPackages(slug),
    createPackage: (...args: unknown[]) => createPackage(...args),
    uploadPackageContent: (...args: unknown[]) => uploadPackageContent(...args),
    renamePackage: (...args: unknown[]) => renamePackage(...args),
    deletePackage: (...args: unknown[]) => deletePackage(...args),
  };
});

const fetchProjects = vi.fn();
vi.mock('../src/api/projects.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api/projects.js')>();
  return { ...actual, fetchProjects: () => fetchProjects() };
});

// REQUIRED by `ProjectSummarySchema`; omitting `latestRun` makes the whole
// `GET /v1/projects` parse throw, so every case would test the error branch.
const PROJECT = {
  id: '11111111-1111-4111-8111-111111111111',
  slug: 'checkout',
  name: 'Checkout Flow',
  latestRun: null,
};

const FILENAME = 'gatling-gradle-plugin-demo-kotlin-main-tests.jar';

/** Newest first, which is how the API orders them. Built to satisfy the REAL
 *  `PackageSchema`: a fixture missing a required field would not exercise this
 *  page at all, only its error fallback. */
const CHECKOUT: Package = {
  id: '22222222-2222-4222-8222-222222222222',
  name: 'Checkout',
  kind: 'gatling_jar',
  createdAt: '2026-09-20T08:00:00.000Z',
  updatedAt: '2026-10-01T09:30:00.000Z',
  current: {
    artifactId: '33333333-3333-4333-8333-333333333333',
    filename: FILENAME,
    bytes: 1_887_437,
    sha256: 'a'.repeat(64),
    gatlingVersion: '3.15.1',
    simulations: ['example.BasicSimulation'],
    uploadedAt: '2026-10-01T09:30:00.000Z',
  },
  usage: { tests: 2, runs: 9, activeJobs: 0 },
};

const EMPTY: Package = {
  id: '44444444-4444-4444-8444-444444444444',
  name: 'Empty',
  kind: 'gatling_bundle',
  createdAt: '2026-09-25T08:00:00.000Z',
  updatedAt: '2026-09-25T08:00:00.000Z',
  current: null,
  usage: { tests: 0, runs: 0, activeJobs: 0 },
};

const { default: ProjectPackages } = await import('../src/routes/ProjectPackages');

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/projects/checkout/packages']}>
        <Routes>
          <Route path="/projects/:slug/packages" element={<ProjectPackages />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const rows = () => screen.getAllByTestId('package-row');
const rowOf = (id: string): HTMLElement => {
  const row = rows().find((r) => r.getAttribute('data-package-id') === id);
  if (row === undefined) throw new Error(`no row for package ${id}`);
  return row;
};
/** The `<details>` the New package summary opens. */
const newPackage = (): HTMLDetailsElement => {
  const details = screen.getByText('New package').closest('details');
  if (details === null) throw new Error('New package is not inside a <details>');
  return details;
};

/**
 * Waits for a menu to be gone, and one macrotask more.
 *
 * Radix hands focus back to the trigger — or does not — on the macrotask AFTER
 * the menu unmounts, which is LATER than the `autoFocus` of whatever the
 * selected item swapped in. An assertion about focus made the moment that
 * control appears is satisfied by a page that is about to lose it.
 */
async function menuSettled() {
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

async function openMenu(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(screen.getByRole('button', { name: `${name}: package actions` }));
  return screen.findByRole('menu');
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchProjects.mockResolvedValue({ items: [PROJECT] });
  fetchPackages.mockResolvedValue({ items: [CHECKOUT, EMPTY] });
  createPackage.mockResolvedValue(CHECKOUT);
  uploadPackageContent.mockResolvedValue(CHECKOUT);
  renamePackage.mockResolvedValue({ ...CHECKOUT, name: 'Checkout v2' });
  deletePackage.mockResolvedValue(undefined);
});

describe('Packages — what the table says', () => {
  it("draws Gatling Enterprise's columns, without Team", async () => {
    renderPage();
    await screen.findAllByTestId('package-row');

    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual([
      'Name',
      'Format',
      'Used by',
      'File',
      'Last upload',
      'Actions',
    ]);

    const row = within(rowOf(CHECKOUT.id));
    expect(row.getByText('Checkout')).toBeInTheDocument();
    expect(row.getByText('2 tests · 9 runs')).toBeInTheDocument();
    expect(row.getByText('Jar')).toBeInTheDocument();
    expect(row.getByText(FILENAME)).toBeInTheDocument();
    // 1,887,437 bytes is 1.8 MiB; the SAME helper the bundle upload names its
    // file with, so the two never disagree about how big a file is.
    expect(row.getByText('1.8 MB')).toBeInTheDocument();
    expect(row.getByText('3.15.1')).toBeInTheDocument();
  });

  it('says No file yet for an empty package, and 0 runs rather than nothing', async () => {
    renderPage();
    await screen.findAllByTestId('package-row');

    const row = within(rowOf(EMPTY.id));
    expect(row.getByText('No file yet')).toBeInTheDocument();
    expect(row.getByText('Bundle')).toBeInTheDocument();
    expect(row.getByText('0 tests · 0 runs')).toBeInTheDocument();
  });

  /**
   * "Last upload" IS ABOUT AN UPLOAD. `updatedAt` is the package's creation
   * time until a file arrives, so printing it under that heading for a package
   * with no file would claim an upload that never happened — one cell from
   * "No file yet".
   */
  it('dates the last upload, and says nothing of one for a package with no file', async () => {
    renderPage();
    await screen.findAllByTestId('package-row');

    expect(within(rowOf(CHECKOUT.id)).getByText(formatInstant(CHECKOUT.updatedAt))).toBeInTheDocument();
    expect(within(rowOf(EMPTY.id)).queryByText(formatInstant(EMPTY.updatedAt))).toBeNull();
    expect(within(rowOf(EMPTY.id)).getByText('—')).toBeInTheDocument();
  });

  it('pluralises the reverse counts the way a sentence would', async () => {
    fetchPackages.mockResolvedValue({
      items: [{ ...CHECKOUT, usage: { tests: 1, runs: 1, activeJobs: 0 } }],
    });
    renderPage();
    await screen.findAllByTestId('package-row');

    expect(within(rowOf(CHECKOUT.id)).getByText('1 test · 1 run')).toBeInTheDocument();
  });

  /**
   * THE LABEL AND THE VALUE ARE TWO PROPS. A button named "Copy package id
   * <id>" that copied the package's NAME would satisfy a check on the name
   * alone, so what lands on the clipboard is read as well. The whole id, which
   * is what every `/v1/projects/{slug}/packages/{id}` endpoint takes.
   */
  it('copies the package id, named after its row', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
      writable: true,
    });
    renderPage();
    await screen.findAllByTestId('package-row');

    for (const pkg of [CHECKOUT, EMPTY]) {
      const button = within(rowOf(pkg.id)).getByRole('button', { name: `Copy package id ${pkg.id}` });
      await act(async () => {
        fireEvent.click(button);
      });
      expect(writeText).toHaveBeenLastCalledWith(pkg.id);
    }
    expect(writeText).toHaveBeenCalledTimes(2);
  });

  it('filters by name', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findAllByTestId('package-row');
    expect(rows()).toHaveLength(2);

    await user.type(screen.getByLabelText('Search packages'), 'chec');

    expect(rows()).toHaveLength(1);
    expect(within(rows()[0]!).getByText('Checkout')).toBeInTheDocument();
  });

  it('says so when a search matches nothing, rather than showing an empty table', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findAllByTestId('package-row');

    await user.type(screen.getByLabelText('Search packages'), 'zzz');

    expect(screen.queryAllByTestId('package-row')).toHaveLength(0);
    expect(screen.getByText(/no package matches/i)).toBeInTheDocument();
  });

  it('titles the document after the section and the project', async () => {
    renderPage();
    await screen.findAllByTestId('package-row');
    await waitFor(() => expect(document.title).toContain('Packages · Checkout Flow'));
  });

  /**
   * A COMPONENT RENDERED N TIMES MUST NOT ADD N ALWAYS-PRESENT LIVE REGIONS.
   * Upload progress gets a status only while there is one, so a page of a
   * dozen packages at rest carries none — the rule `ChartActions` and
   * `CopyIdButton` record for the same reason.
   */
  it('contributes no live region while nothing is uploading', async () => {
    renderPage();
    await screen.findAllByTestId('package-row');
    expect(screen.queryAllByRole('status')).toHaveLength(0);
  });
});

describe('Packages — the empty and the in-between states', () => {
  /**
   * `open` IS A DEFAULT, NOT A CONTROLLER (ProjectRules' rule). Closed with
   * packages to list; open when there are none — and the second needs a
   * SETTLED query, which the next case pins.
   */
  it('opens New package by default only when there are none', async () => {
    renderPage();
    await screen.findAllByTestId('package-row');
    expect(newPackage()).not.toHaveAttribute('open');
    cleanup();

    fetchPackages.mockResolvedValue({ items: [] });
    renderPage();
    expect(await screen.findByText('No packages yet')).toBeInTheDocument();
    expect(newPackage()).toHaveAttribute('open');
    expect(
      screen.getByText(
        'Create one above, or start a run with a jar upload — the jar becomes a package either way.',
      ),
    ).toBeInTheDocument();
  });

  it('stays closed while the list is still loading, instead of flashing open', async () => {
    fetchPackages.mockReturnValue(new Promise(() => {}));
    renderPage();
    await screen.findByText('New package');
    expect(newPackage()).not.toHaveAttribute('open');
  });

  /**
   * THE OTHER HALF OF "A DEFAULT, NOT A CONTROLLER". `open={settled && empty}`
   * recomputes on every render, so the form would shut under the reader the
   * instant their first package arrived. What saves it is the `toggle` event:
   * React's own write of `open` fires one, so the choice latches true while the
   * list is still empty and the fallback never applies again.
   */
  it('stays open after the first package appears', async () => {
    const user = userEvent.setup();
    fetchPackages.mockResolvedValue({ items: [] });
    renderPage();
    await screen.findByText('No packages yet');
    const details = newPackage();
    await waitFor(() => expect(details).toHaveAttribute('open'));

    fetchPackages.mockResolvedValue({ items: [CHECKOUT] });
    await user.type(within(details).getByLabelText('Name'), 'Checkout');
    await user.click(within(details).getByRole('button', { name: 'Create package' }));

    await screen.findAllByTestId('package-row');
    expect(details).toHaveAttribute('open');
  });

  it('shows what the server said when the list cannot be loaded, and offers no form-shaped lie', async () => {
    fetchPackages.mockRejectedValue(new Error('boom'));
    renderPage();
    expect(await screen.findByRole('alert')).toHaveTextContent(/packages could not be loaded/i);
    expect(screen.queryByText('No packages yet')).toBeNull();
  });
});

describe('Packages — creating one', () => {
  it('creates a package with its name and format, and an optional file, then refreshes the list', async () => {
    const user = userEvent.setup();
    fetchPackages.mockResolvedValue({ items: [] });
    renderPage();
    await screen.findByText('No packages yet');
    const details = newPackage();

    await user.type(within(details).getByLabelText('Name'), '  Soak  ');
    await user.selectOptions(within(details).getByLabelText('Format'), 'gatling_bundle');
    const file = new File(['zip'], 'soak.zip');
    await user.upload(within(details).getByTestId('new-package-file'), file);
    fetchPackages.mockResolvedValue({ items: [CHECKOUT] });
    await user.click(within(details).getByRole('button', { name: 'Create package' }));

    await waitFor(() => expect(createPackage).toHaveBeenCalledTimes(1));
    expect(createPackage).toHaveBeenCalledWith(
      'checkout',
      { name: 'Soak', kind: 'gatling_bundle' },
      file,
    );
    await screen.findAllByTestId('package-row');
    expect(fetchPackages).toHaveBeenCalledTimes(2);
  });

  it('creates an empty package when no file was chosen, and says the server’s own words when it refuses', async () => {
    const user = userEvent.setup();
    fetchPackages.mockResolvedValue({ items: [] });
    createPackage.mockRejectedValue(
      new ProblemError(409, {
        code: 'PACKAGE_NAME_TAKEN',
        detail: 'This project already has a package called "Soak".',
        remediation: 'Choose another name.',
      }),
    );
    renderPage();
    await screen.findByText('No packages yet');
    const details = newPackage();

    await user.type(within(details).getByLabelText('Name'), 'Soak');
    await user.click(within(details).getByRole('button', { name: 'Create package' }));

    expect(createPackage).toHaveBeenCalledWith('checkout', { name: 'Soak', kind: 'gatling_jar' }, null);
    expect(await within(details).findByRole('alert')).toHaveTextContent('Soak');
  });

  it('offers the file input only the extensions the chosen format accepts', async () => {
    const user = userEvent.setup();
    fetchPackages.mockResolvedValue({ items: [] });
    renderPage();
    await screen.findByText('No packages yet');
    const details = newPackage();

    expect(within(details).getByTestId('new-package-file')).toHaveAttribute('accept', '.jar');
    await user.selectOptions(within(details).getByLabelText('Format'), 'gatling_bundle');
    expect(within(details).getByTestId('new-package-file')).toHaveAttribute(
      'accept',
      '.zip,.tgz,.tar.gz',
    );
  });

  /**
   * A NAME IDENTIFIES, A DESCRIPTION EXPLAINS (review 09-13 M21). The help
   * sentence inside the `<label>` would make the input's accessible name the
   * whole of it, read out before the reader knows what the control is.
   */
  it('names the file input by its label and describes it by the help sentence', async () => {
    fetchPackages.mockResolvedValue({ items: [] });
    renderPage();
    await screen.findByText('No packages yet');
    const input = within(newPackage()).getByTestId('new-package-file');

    expect(input).toHaveAccessibleName('File (optional)');
    expect(input).toHaveAccessibleDescription(
      'A package can be made empty and given its first file from its row later.',
    );
    // Behind the field's ⓘ, not a line under it (clean UI PR 4).
    expect(within(newPackage()).getByRole('button', { name: 'About File' })).toBeInTheDocument();
    expect(
      within(newPackage()).getByText(/given its first file from its row later/).closest('[hidden]'),
    ).not.toBeNull();
  });
});

describe('Packages — changing the format of a package being created', () => {
  /**
   * A jar left in the input under "Runnable bundle" would be uploaded in full
   * and then refused by the server for a mistake the page could have undone the
   * moment the format changed.
   */
  it('drops a chosen file when the format changes, because it belonged to the other format', async () => {
    const user = userEvent.setup({ applyAccept: false });
    fetchPackages.mockResolvedValue({ items: [] });
    renderPage();
    await screen.findByText('No packages yet');
    const details = newPackage();

    await user.upload(within(details).getByTestId('new-package-file'), new File(['jar'], 'soak.jar'));
    await user.selectOptions(within(details).getByLabelText('Format'), 'gatling_bundle');
    await user.type(within(details).getByLabelText('Name'), 'Soak');
    await user.click(within(details).getByRole('button', { name: 'Create package' }));

    await waitFor(() => expect(createPackage).toHaveBeenCalledTimes(1));
    expect(createPackage).toHaveBeenCalledWith('checkout', { name: 'Soak', kind: 'gatling_bundle' }, null);
  });
});

describe('Packages — the row menu', () => {
  /**
   * THE REASON IS TEXT, NOT A TOOLTIP — `ChartActions`' rule, for a disabled
   * item. A `title` is invisible on touch and unreachable by keyboard, and a
   * menu hides the item until it is opened; a refusal that cannot be read is
   * not an explanation.
   */
  it('says WHY delete is refused, in text, when runs are active', async () => {
    const user = userEvent.setup();
    fetchPackages.mockResolvedValue({
      items: [{ ...CHECKOUT, usage: { tests: 2, runs: 9, activeJobs: 2 } }],
    });
    renderPage();
    await screen.findAllByTestId('package-row');

    const menu = await openMenu(user, 'Checkout');

    const deleteItem = within(menu).getByRole('menuitem', { name: /^delete/i });
    expect(deleteItem).toHaveAttribute('aria-disabled', 'true');
    expect(menu).toHaveTextContent('2 runs of it are queued or running');
    // The line is tied to the item it is about. A paragraph beside a disabled
    // item explains it only to someone who reads the whole menu; a screen
    // reader landing on the item hears the reason from its description.
    expect(deleteItem).toHaveAccessibleDescription(/2 runs of it are queued or running/);
  });

  it('says it in the singular for one active run, and leaves delete enabled with none', async () => {
    const user = userEvent.setup();
    fetchPackages.mockResolvedValue({
      items: [{ ...CHECKOUT, usage: { tests: 1, runs: 1, activeJobs: 1 } }],
    });
    renderPage();
    await screen.findAllByTestId('package-row');
    expect(await openMenu(user, 'Checkout')).toHaveTextContent('1 run of it is queued or running');
    cleanup();

    fetchPackages.mockResolvedValue({ items: [CHECKOUT] });
    renderPage();
    await screen.findAllByTestId('package-row');
    const menu = await openMenu(user, 'Checkout');
    expect(within(menu).getByRole('menuitem', { name: /^delete/i })).not.toHaveAttribute(
      'aria-disabled',
    );
    expect(menu).not.toHaveTextContent(/queued or running/);
  });

  it('links New run from this package with the package chosen', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findAllByTestId('package-row');

    const menu = await openMenu(user, 'Checkout');

    expect(within(menu).getByRole('menuitem', { name: 'New run from this package' })).toHaveAttribute(
      'href',
      projectNewRunnerRunPath('checkout', CHECKOUT.id),
    );
  });

  /**
   * ═══ A PACKAGE WITH NO FILE HAS NOTHING TO RUN ═══
   *
   * The New run form offers only packages that have a file, and falls back to
   * the first that does when a link names one without — so this item, on an
   * empty package, opened a form ready to queue a load test of a package the
   * reader never chose. It is disabled there, with the reason in TEXT and as
   * the item's description: the Delete item's rule, in the same menu. And the
   * pair: on a package WITH a file it is the ordinary, enabled link.
   */
  it('disables New run from this package on a package with no file, and says why', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findAllByTestId('package-row');

    const menu = await openMenu(user, 'Empty');
    const item = within(menu).getByRole('menuitem', { name: 'New run from this package' });
    expect(item).toHaveAttribute('aria-disabled', 'true');
    expect(item).toHaveAccessibleDescription('Upload a file to it first.');
    // Not a link while disabled: an href would still go somewhere.
    expect(item).not.toHaveAttribute('href');
    await user.keyboard('{Escape}');
    await menuSettled();

    const withFile = await openMenu(user, 'Checkout');
    const enabled = within(withFile).getByRole('menuitem', { name: 'New run from this package' });
    expect(enabled).not.toHaveAttribute('aria-disabled');
    expect(enabled).toHaveAttribute('href', projectNewRunnerRunPath('checkout', CHECKOUT.id));
    expect(withFile).not.toHaveTextContent('Upload a file to it first.');
  });

  it('names its trigger after its row, so a page of them is not a page of "More"', async () => {
    renderPage();
    await screen.findAllByTestId('package-row');
    expect(screen.getByRole('button', { name: 'Checkout: package actions' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Empty: package actions' })).toBeInTheDocument();
  });
});

describe('Packages — deleting', () => {
  it('asks first, in words, with a secondary confirm and a Cancel — never a second primary', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findAllByTestId('package-row');

    const menu = await openMenu(user, 'Checkout');
    await user.click(within(menu).getByRole('menuitem', { name: /^delete/i }));

    const row = within(rowOf(CHECKOUT.id));
    expect(row.getByText('Delete package "Checkout"? Its runs keep their history.')).toBeInTheDocument();
    expect(deletePackage).not.toHaveBeenCalled();
    // `Button.tsx`: exactly ONE primary per screen, and this page's is Create
    // package. An armed confirmation that was `primary` would be a second.
    const confirm = row.getByRole('button', { name: 'Delete package' });
    expect(confirm.className).not.toContain('bg-accent');
    // Focus lands on Cancel, the safe answer to a question about something
    // that cannot be undone — and stays there once the menu has finished closing.
    await menuSettled();
    expect(row.getByRole('button', { name: 'Cancel' })).toHaveFocus();

    await user.click(row.getByRole('button', { name: 'Cancel' }));
    expect(row.queryByText(/Its runs keep their history/)).toBeNull();
    expect(deletePackage).not.toHaveBeenCalled();
    // The block the reader was in is gone, so focus goes to the one control
    // that is still there rather than to the top of the document.
    expect(screen.getByRole('button', { name: 'Checkout: package actions' })).toHaveFocus();
  });

  it('deletes only on the confirm, then refreshes the list', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findAllByTestId('package-row');

    const menu = await openMenu(user, 'Checkout');
    await user.click(within(menu).getByRole('menuitem', { name: /^delete/i }));
    fetchPackages.mockResolvedValue({ items: [EMPTY] });
    await user.click(within(rowOf(CHECKOUT.id)).getByRole('button', { name: 'Delete package' }));

    await waitFor(() => expect(deletePackage).toHaveBeenCalledWith('checkout', CHECKOUT.id));
    await waitFor(() => expect(rows()).toHaveLength(1));
  });

  it('relays the server’s own sentence when the delete is refused after all', async () => {
    const user = userEvent.setup();
    deletePackage.mockRejectedValue(
      new ProblemError(409, {
        code: 'PACKAGE_IN_USE',
        detail: '1 run of this package is queued or running.',
        remediation: 'Wait for it to finish.',
      }),
    );
    renderPage();
    await screen.findAllByTestId('package-row');

    const menu = await openMenu(user, 'Checkout');
    await user.click(within(menu).getByRole('menuitem', { name: /^delete/i }));
    await user.click(within(rowOf(CHECKOUT.id)).getByRole('button', { name: 'Delete package' }));

    expect(await within(rowOf(CHECKOUT.id)).findByRole('alert')).toHaveTextContent(
      '1 run of this package is queued or running.',
    );
  });

  it('starts a re-armed delete from nothing: an old refusal is not waiting there', async () => {
    const user = userEvent.setup();
    deletePackage.mockRejectedValue(
      new ProblemError(409, {
        code: 'PACKAGE_IN_USE',
        detail: '1 run of this package is queued or running.',
        remediation: 'Wait for it to finish.',
      }),
    );
    renderPage();
    await screen.findAllByTestId('package-row');
    const row = within(rowOf(CHECKOUT.id));

    await user.click(within(await openMenu(user, 'Checkout')).getByRole('menuitem', { name: /^delete/i }));
    await user.click(row.getByRole('button', { name: 'Delete package' }));
    expect(await row.findByRole('alert')).toHaveTextContent('queued or running');

    await user.click(row.getByRole('button', { name: 'Cancel' }));
    await user.click(within(await openMenu(user, 'Checkout')).getByRole('menuitem', { name: /^delete/i }));

    expect(row.getByText(/Delete package "Checkout"\?/)).toBeInTheDocument();
    expect(row.queryByRole('alert')).toBeNull();
  });

  /**
   * A REFUSED DELETE IS NEWS ABOUT THE LIST. The 409 says a run of the package
   * is queued or running, which the menu did not know — it offered Delete. Left
   * alone, it goes on offering it after the server has said no.
   */
  it('re-fetches the list when a delete is refused, so the menu stops offering it', async () => {
    const user = userEvent.setup();
    deletePackage.mockRejectedValue(
      new ProblemError(409, {
        code: 'PACKAGE_IN_USE',
        detail: '1 run of this package is queued or running.',
        remediation: 'Wait for it to finish.',
      }),
    );
    renderPage();
    await screen.findAllByTestId('package-row');
    const row = within(rowOf(CHECKOUT.id));
    await user.click(within(await openMenu(user, 'Checkout')).getByRole('menuitem', { name: /^delete/i }));

    // By the time the server answers, a run has started.
    fetchPackages.mockResolvedValue({
      items: [{ ...CHECKOUT, usage: { tests: 2, runs: 10, activeJobs: 1 } }, EMPTY],
    });
    await user.click(row.getByRole('button', { name: 'Delete package' }));
    await row.findByRole('alert');
    await user.click(row.getByRole('button', { name: 'Cancel' }));

    expect(fetchPackages).toHaveBeenCalledTimes(2);
    const menu = await openMenu(user, 'Checkout');
    expect(within(menu).getByRole('menuitem', { name: /^delete/i })).toHaveAttribute('aria-disabled', 'true');
    expect(menu).toHaveTextContent('1 run of it is queued or running');
  });

  /** One armed row at a time, as `ProjectRules` does it: arming a second
   *  disarms the first, so two destructive confirmations are never on screen. */
  it('arms one row at a time', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findAllByTestId('package-row');

    await user.click(
      within(await openMenu(user, 'Checkout')).getByRole('menuitem', { name: /^delete/i }),
    );
    await user.click(
      within(await openMenu(user, 'Empty')).getByRole('menuitem', { name: /^delete/i }),
    );

    expect(screen.getAllByText(/Its runs keep their history/)).toHaveLength(1);
    expect(within(rowOf(EMPTY.id)).getByText(/Delete package "Empty"\?/)).toBeInTheDocument();
  });
});

describe('Packages — renaming', () => {
  it('renames inline with Save and Cancel, then refreshes the list', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findAllByTestId('package-row');

    const menu = await openMenu(user, 'Checkout');
    await user.click(within(menu).getByRole('menuitem', { name: 'Rename' }));

    const row = within(rowOf(CHECKOUT.id));
    const input = row.getByLabelText('New name for Checkout');
    expect(input).toHaveValue('Checkout');
    // FOCUS HAS TO SURVIVE THE MENU CLOSING — see `menuSettled`.
    await menuSettled();
    expect(input).toHaveFocus();
    await user.clear(input);
    await user.type(input, '  Checkout v2 ');
    fetchPackages.mockResolvedValue({ items: [{ ...CHECKOUT, name: 'Checkout v2' }, EMPTY] });
    await user.click(row.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(renamePackage).toHaveBeenCalledWith('checkout', CHECKOUT.id, 'Checkout v2'),
    );
    expect(await screen.findByText('Checkout v2')).toBeInTheDocument();
    expect(row.queryByLabelText('New name for Checkout')).toBeNull();
    // Saved: the editor is gone and focus is on the row's own menu trigger,
    // named for the NEW name.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Checkout v2: package actions' })).toHaveFocus(),
    );
  });

  /**
   * AN ANSWER TO A QUESTION THE READER HAS MOVED ON FROM. Pressing Save and
   * then arming a delete on another row leaves the save in flight; when it
   * finally answers, closing "its" editor would disarm the OTHER row and drag
   * focus back to this one — taking the confirmation, and the keyboard, out
   * from under a reader who is mid-decision about something else.
   */
  it('does not disarm, or take focus from, another row when a rename it started finally answers', async () => {
    const user = userEvent.setup();
    let answer: (pkg: Package) => void = () => {};
    renamePackage.mockImplementation(
      () =>
        new Promise<Package>((resolve) => {
          answer = resolve;
        }),
    );
    renderPage();
    await screen.findAllByTestId('package-row');

    await user.click(
      within(await openMenu(user, 'Checkout')).getByRole('menuitem', { name: 'Rename' }),
    );
    const input = within(rowOf(CHECKOUT.id)).getByLabelText('New name for Checkout');
    await user.clear(input);
    await user.type(input, 'Checkout v2');
    await user.click(within(rowOf(CHECKOUT.id)).getByRole('button', { name: 'Save' }));

    // The save is in flight. The reader arms a delete on the OTHER row.
    await user.click(
      within(await openMenu(user, 'Empty')).getByRole('menuitem', { name: /^delete/i }),
    );
    const cancel = within(rowOf(EMPTY.id)).getByRole('button', { name: 'Cancel' });
    await waitFor(() => expect(cancel).toHaveFocus());

    await act(async () => answer({ ...CHECKOUT, name: 'Checkout v2' }));

    expect(within(rowOf(EMPTY.id)).getByText(/Delete package "Empty"\?/)).toBeInTheDocument();
    expect(cancel).toHaveFocus();
  });

  /**
   * `rename` lives in a component that never unmounts, so a refused save's
   * error is still there when the reader comes back to the block. Re-opened, it
   * would show "that name is taken" over an input they have not touched.
   */
  it('starts a re-opened rename from nothing: an old refusal is not waiting there', async () => {
    const user = userEvent.setup();
    renamePackage.mockRejectedValue(
      new ProblemError(409, {
        code: 'PACKAGE_NAME_TAKEN',
        detail: 'This project already has a package called "Empty".',
        remediation: 'Choose another name.',
      }),
    );
    renderPage();
    await screen.findAllByTestId('package-row');
    const row = within(rowOf(CHECKOUT.id));

    await user.click(within(await openMenu(user, 'Checkout')).getByRole('menuitem', { name: 'Rename' }));
    const input = row.getByLabelText('New name for Checkout');
    await user.clear(input);
    await user.type(input, 'Empty');
    await user.click(row.getByRole('button', { name: 'Save' }));
    expect(await row.findByRole('alert')).toHaveTextContent('already has a package called "Empty"');

    await user.click(row.getByRole('button', { name: 'Cancel' }));
    await user.click(within(await openMenu(user, 'Checkout')).getByRole('menuitem', { name: 'Rename' }));

    expect(row.getByLabelText('New name for Checkout')).toHaveValue('Checkout');
    expect(row.queryByRole('alert')).toBeNull();
  });

  it('Cancel leaves the name alone and calls nothing', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findAllByTestId('package-row');

    const menu = await openMenu(user, 'Checkout');
    await user.click(within(menu).getByRole('menuitem', { name: 'Rename' }));
    const row = within(rowOf(CHECKOUT.id));
    await user.type(row.getByLabelText('New name for Checkout'), 'zzz');
    await user.click(row.getByRole('button', { name: 'Cancel' }));

    expect(renamePackage).not.toHaveBeenCalled();
    expect(row.queryByLabelText('New name for Checkout')).toBeNull();
    expect(row.getByText('Checkout')).toBeInTheDocument();
  });
});

describe('Packages — uploading a file', () => {
  it('shows Uploading… with a percentage, then Processing…, then the refreshed row — a status only while there is one', async () => {
    const user = userEvent.setup();
    let report: (fraction: number) => void = () => {};
    let finish: (pkg: Package) => void = () => {};
    uploadPackageContent.mockImplementation(
      (_slug: string, _id: string, _file: File, onProgress?: (fraction: number) => void) => {
        report = onProgress ?? (() => {});
        return new Promise<Package>((resolve) => {
          finish = resolve;
        });
      },
    );
    renderPage();
    await screen.findAllByTestId('package-row');
    expect(screen.queryAllByRole('status')).toHaveLength(0);

    const file = new File(['jar'], 'checkout-v2.jar');
    await user.upload(screen.getByTestId(`package-file-${CHECKOUT.id}`), file);

    expect(uploadPackageContent).toHaveBeenCalledWith('checkout', CHECKOUT.id, file, expect.any(Function));
    act(() => report(0.42));
    const status = await within(rowOf(CHECKOUT.id)).findByRole('status');
    expect(status).toHaveTextContent('Uploading… 42%');
    // One row is uploading and the other has nothing to say.
    expect(screen.getAllByRole('status')).toHaveLength(1);

    // The bytes are all sent; the server is reading the jar's manifest.
    act(() => report(1));
    await waitFor(() => expect(status).toHaveTextContent('Processing…'));

    const refreshed: Package = {
      ...CHECKOUT,
      current: { ...CHECKOUT.current!, filename: 'checkout-v2.jar', bytes: 3_145_728 },
    };
    fetchPackages.mockResolvedValue({ items: [refreshed, EMPTY] });
    await act(async () => finish(refreshed));

    await waitFor(() => expect(screen.queryAllByRole('status')).toHaveLength(0));
    expect(await within(rowOf(CHECKOUT.id)).findByText('checkout-v2.jar')).toBeInTheDocument();
    expect(within(rowOf(CHECKOUT.id)).getByText(formatBytes(3_145_728))).toBeInTheDocument();
  });

  it('keeps the server’s own sentence when an upload is refused, and clears it on the next attempt', async () => {
    // `applyAccept: false`: the input's `accept` hint is a filter the reader can
    // override with "All files", and the server is the authority — so a wrong
    // file must be able to REACH it. userEvent otherwise drops it silently.
    const user = userEvent.setup({ applyAccept: false });
    uploadPackageContent.mockRejectedValueOnce(
      new ProblemError(400, {
        code: 'PACKAGE_KIND_MISMATCH',
        detail: '"notes.txt" is not a Gatling jar, which is what this package holds.',
        remediation: 'Upload a .jar to this package.',
      }),
    );
    renderPage();
    await screen.findAllByTestId('package-row');

    await user.upload(screen.getByTestId(`package-file-${CHECKOUT.id}`), new File(['x'], 'notes.txt'));
    expect(await within(rowOf(CHECKOUT.id)).findByRole('alert')).toHaveTextContent('notes.txt');

    await user.upload(screen.getByTestId(`package-file-${CHECKOUT.id}`), new File(['x'], 'ok.jar'));
    await waitFor(() => expect(within(rowOf(CHECKOUT.id)).queryByRole('alert')).toBeNull());
  });

  it('offers each package’s own kind of file, and names its Upload button after the row', async () => {
    renderPage();
    await screen.findAllByTestId('package-row');

    expect(screen.getByTestId(`package-file-${CHECKOUT.id}`)).toHaveAttribute('accept', '.jar');
    expect(screen.getByTestId(`package-file-${EMPTY.id}`)).toHaveAttribute('accept', '.zip,.tgz,.tar.gz');
    // Label-in-name (WCAG 2.5.3): the visible word is "Upload", and the name
    // contains it, and names the package so two rows are not two "Upload"s.
    expect(screen.getByRole('button', { name: 'Upload a file to Checkout' })).toHaveTextContent('Upload');
    expect(screen.getByRole('button', { name: 'Upload a file to Empty' })).toBeInTheDocument();
  });
});

describe('Packages — below 768px', () => {
  /**
   * Cards, not a table: six columns do not fit a phone. The same rows, the
   * same testids and the same actions — a compact layout is not a reason for a
   * spec to have to know which one it is looking at.
   */
  it('draws the same packages as cards, with the same actions', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('matchMedia', () => ({
      matches: true,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    renderPage();
    await screen.findAllByTestId('package-row');

    expect(screen.queryByRole('table')).toBeNull();
    expect(rows()).toHaveLength(2);
    const row = within(rowOf(CHECKOUT.id));
    expect(row.getByText('2 tests · 9 runs')).toBeInTheDocument();
    expect(row.getByText(FILENAME)).toBeInTheDocument();
    expect(row.getByRole('button', { name: `Copy package id ${CHECKOUT.id}` })).toBeInTheDocument();
    expect(within(await openMenu(user, 'Checkout')).getByRole('menuitem', { name: 'Rename' })).toBeInTheDocument();
  });
});
