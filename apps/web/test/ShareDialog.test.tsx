import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { PublicLink } from '@perfportal/contracts';
import { formatInstant } from '../src/routes/format';
import { EXPIRY_PRESETS, customDateBounds, expiryFor } from '../src/routes/share/expiry';
import ShareRunButton from '../src/routes/share/ShareRunButton';

/**
 * ═══ SHARING A RUN BY LINK, FROM ITS OWN PAGE (spec 6.4) ═══
 *
 * The Share button opens a dialog over the run's links: a form that creates
 * one (an expiry, the consent sentence, Create), the secret URL shown ONCE when
 * one is created, and the run's links with Revoke.
 *
 * `fireEvent`, not `userEvent`, throughout: `userEvent.setup()` installs a
 * clipboard of its own on `navigator`, and two cases here are about what the
 * dialog does when there is none — the token page's tests made the same call.
 *
 * THE CLOCK IS FROZEN (`Date` only — timers stay real, so Radix and Testing
 * Library still wait), because an expiry preset is "a week from now" and the
 * cases assert the instant the dialog says and sends.
 */

const RUN_ID = 'a66548b7-2962-43ff-8b93-7149a6f2a1b8';
const SECRET = 'ppl_Q7x_Kd-9mVb2LpN4rTzW8yHc6uJf3sEa1oGiX5nBkY0';
const NOW = new Date(2026, 10, 6, 15, 30, 0, 0);

const CONSENT =
  "Anyone with this link can read this run's Summary, Report and Logs — its project and test names included — without signing in, until it expires or is revoked.";
const SHOWN_ONCE = 'This is the only time the full link is shown.';

const ACTIVE: PublicLink = {
  id: '11111111-1111-4111-8111-111111111111',
  state: 'active',
  createdAt: '2026-11-01T09:00:00.000Z',
  createdBy: { name: 'Asha Rao' },
  expiresAt: '2026-12-01T09:00:00.000Z',
  revokedAt: null,
  revokedBy: null,
  lastUsedAt: '2026-11-05T10:15:00.000Z',
};
const EXPIRED: PublicLink = {
  id: '22222222-2222-4222-8222-222222222222',
  state: 'expired',
  createdAt: '2026-09-01T09:00:00.000Z',
  createdBy: null,
  expiresAt: '2026-09-08T09:00:00.000Z',
  revokedAt: null,
  revokedBy: null,
  lastUsedAt: null,
};

/**
 * Two active links made thirty seconds apart, each for a week — one per
 * recipient, the ordinary way to share a run with two people. Their creation
 * minute, and so every minute-precision instant on their rows, is the same.
 */
const FIRST: PublicLink = {
  id: '55555555-5555-4555-8555-555555555555',
  state: 'active',
  createdAt: '2026-11-06T10:00:10.000Z',
  createdBy: { name: 'Asha Rao' },
  expiresAt: '2026-11-13T10:00:10.000Z',
  revokedAt: null,
  revokedBy: null,
  lastUsedAt: null,
};
const SECOND: PublicLink = {
  ...FIRST,
  id: '66666666-6666-4666-8666-666666666666',
  createdAt: '2026-11-06T10:00:40.000Z',
  expiresAt: '2026-11-13T10:00:40.000Z',
};
const REVOKED: PublicLink = {
  id: '33333333-3333-4333-8333-333333333333',
  state: 'revoked',
  createdAt: '2026-10-01T09:00:00.000Z',
  createdBy: { name: 'Ravi Menon' },
  expiresAt: '2027-10-01T09:00:00.000Z',
  revokedAt: '2026-10-02T09:00:00.000Z',
  revokedBy: { name: 'Ravi Menon' },
  lastUsedAt: '2026-10-01T12:00:00.000Z',
};

interface Sent {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function problem(status: number, code: string, detail: string, remediation: string): Response {
  return new Response(JSON.stringify({ status, title: 'Refused', code, detail, remediation }), {
    status,
    headers: { 'content-type': 'application/problem+json' },
  });
}

/**
 * The three management routes, over a list this stub owns: a create adds a
 * link (newest first) and a revoke marks one revoked, so a refetch reads back
 * what the dialog did.
 */
function stubLinks({
  enabled = true,
  items = [] as PublicLink[],
  create,
}: {
  enabled?: boolean;
  items?: PublicLink[];
  create?: () => Response;
} = {}): Sent[] {
  const sent: Sent[] = [];
  let links = [...items];
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), 'http://x').pathname;
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    sent.push({ method, path, body });
    const base = `/v1/runs/${RUN_ID}/public-links`;
    if (method === 'GET' && path === base) return Promise.resolve(json({ enabled, items: links }));
    if (method === 'POST' && path === base) {
      if (create !== undefined) return Promise.resolve(create());
      const link: PublicLink = {
        id: '44444444-4444-4444-8444-444444444444',
        state: 'active',
        createdAt: NOW.toISOString(),
        createdBy: { name: 'Asha Rao' },
        expiresAt: (body as { expiresAt: string }).expiresAt,
        revokedAt: null,
        revokedBy: null,
        lastUsedAt: null,
      };
      links = [link, ...links];
      return Promise.resolve(json({ link, secret: SECRET }, 201));
    }
    if (method === 'DELETE' && path.startsWith(`${base}/`)) {
      const id = path.slice(base.length + 1);
      links = links.map((link) =>
        link.id === id
          ? { ...link, state: 'revoked' as const, revokedAt: NOW.toISOString(), revokedBy: { name: 'Asha Rao' } }
          : link,
      );
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    return Promise.resolve(problem(404, 'NOT_FOUND', `stub: ${method} ${path}`, 'stub'));
  });
  return sent;
}

function mount(): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ShareRunButton runId={RUN_ID} />
    </QueryClientProvider>,
  );
  return client;
}

/** Everything the client's caches hold, as one string to search for a secret. */
function cached(client: QueryClient): string {
  return JSON.stringify([
    client.getMutationCache().getAll().map((mutation) => mutation.state),
    client.getQueryCache().getAll().map((query) => query.state),
  ]);
}

/** Opens the dialog and waits for its list to answer. */
async function open() {
  fireEvent.click(screen.getByRole('button', { name: 'Share' }));
  const dialog = await screen.findByRole('dialog', { name: 'Share this run' });
  await waitFor(() => expect(within(dialog).queryByText('Loading links…')).toBeNull());
  return dialog;
}

function close() {
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
}

const willExpire = (at: Date) => `This link will expire on ${formatInstant(at.toISOString())}.`;

/**
 * A ref Radix puts on an `asChild` child that cannot hold one is how focus
 * stopped coming back to Share (see the last describe). React says so once PER
 * COMPONENT, not per render — so a check inside one case is answered by
 * whichever earlier case first rendered the trigger. Watched for every case,
 * and passed through, so any other error still prints.
 */
let consoleErrors: MockInstance<typeof console.error>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  Object.assign(navigator, { clipboard: { writeText: vi.fn(async () => undefined) } });
  consoleErrors = vi.spyOn(console, 'error');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  const refWarnings = consoleErrors.mock.calls.flat().map(String).filter((text) => text.includes('cannot be given refs'));
  consoleErrors.mockRestore();
  expect(refWarnings).toEqual([]);
});

describe('ShareDialog — the org’s switch', () => {
  /** A Member cannot read Administration's settings, so the list says
   *  whether sharing is on, and the dialog says who can change it. */
  it('says an admin turned links off, names where, and draws no form', async () => {
    stubLinks({ enabled: false, items: [ACTIVE] });
    mount();
    const dialog = await open();

    expect(dialog).toHaveTextContent(/an admin has turned public links off/i);
    expect(dialog).toHaveTextContent('Administration › Settings');
    expect(within(dialog).queryByRole('button', { name: 'Create link' })).toBeNull();
    expect(within(dialog).queryByLabelText('Expires')).toBeNull();
    expect(within(dialog).queryByText(CONSENT)).toBeNull();
    // The links are still listed: deciding what to revoke matters most while
    // sharing is off, because turning it back on restores them.
    expect(within(dialog).getAllByTestId('public-link-row')).toHaveLength(1);
  });
});

describe('ShareDialog — creating a link', () => {
  it('offers every preset, says when the link will expire, and asks for consent', async () => {
    stubLinks();
    mount();
    const dialog = await open();

    const expires = within(dialog).getByLabelText('Expires');
    expect([...(expires as HTMLSelectElement).options].map((option) => option.textContent)).toEqual(
      EXPIRY_PRESETS.map((preset) => preset.label),
    );
    expect(dialog).toHaveTextContent(willExpire(expiryFor('1w', NOW)));

    fireEvent.change(expires, { target: { value: '6m' } });
    expect(dialog).toHaveTextContent(willExpire(expiryFor('6m', NOW)));
    expect(within(dialog).getByText(CONSENT)).toBeVisible();
  });

  it('bounds a custom date and ends it at the end of that day', async () => {
    stubLinks();
    mount();
    const dialog = await open();

    fireEvent.change(within(dialog).getByLabelText('Expires'), { target: { value: 'custom' } });
    const date = within(dialog).getByLabelText('Expiry date');
    const { min, max } = customDateBounds(NOW);
    expect(date).toHaveAttribute('min', min);
    expect(date).toHaveAttribute('max', max);
    // No date yet: nothing to say, nothing to create.
    expect(dialog).not.toHaveTextContent(/will expire on/);
    expect(within(dialog).getByRole('button', { name: 'Create link' })).toBeDisabled();

    fireEvent.change(date, { target: { value: '2026-12-25' } });
    expect(dialog).toHaveTextContent(willExpire(expiryFor('custom', NOW, '2026-12-25')));
    expect(within(dialog).getByRole('button', { name: 'Create link' })).toBeEnabled();

    // A date typed past the bound the browser would have kept out.
    fireEvent.change(date, { target: { value: '2030-01-01' } });
    expect(dialog).not.toHaveTextContent(/will expire on/);
    expect(within(dialog).getByRole('button', { name: 'Create link' })).toBeDisabled();
    // ...and says why, on the field: a disabled Create with no reason is a
    // form that stopped working. The field is marked invalid and names the
    // sentence that explains it.
    const reason = within(dialog).getByText('Choose a date within the next two years.');
    expect(reason).toBeVisible();
    expect(date).toHaveAttribute('aria-invalid', 'true');
    expect(reason.id).not.toBe('');
    expect(date).toHaveAttribute('aria-describedby', reason.id);

    // Back inside the bounds, the reason goes and the field is valid again.
    fireEvent.change(date, { target: { value: '2026-12-25' } });
    expect(within(dialog).queryByText('Choose a date within the next two years.')).toBeNull();
    expect(date).not.toHaveAttribute('aria-invalid');
  });

  it('sends the expiry the dialog said', async () => {
    const sent = stubLinks();
    mount();
    const dialog = await open();

    fireEvent.change(within(dialog).getByLabelText('Expires'), { target: { value: '1m' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create link' }));

    await within(dialog).findByTestId('public-link-url');
    const posts = sent.filter((request) => request.method === 'POST');
    expect(posts).toEqual([
      { method: 'POST', path: `/v1/runs/${RUN_ID}/public-links`, body: { expiresAt: expiryFor('1m', NOW).toISOString() } },
    ]);
  });

  /**
   * ONCE, AND THE DIALOG IS WHY. Only the secret's hash is stored, so the URL
   * exists in this dialog's memory and nowhere else; closing it is the end of
   * it. Reopening shows the link in the list — never its URL.
   */
  it('shows the full URL once, with Copy, and never again after closing', async () => {
    stubLinks();
    mount();
    const dialog = await open();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create link' }));

    const url = await within(dialog).findByTestId('public-link-url');
    expect(url).toHaveValue(`${window.location.origin}/share/${SECRET}`);
    expect(url).toHaveAttribute('readonly');
    expect(within(dialog).getByText(SHOWN_ONCE)).toBeVisible();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Copy link' }));
    expect(await within(dialog).findByRole('button', { name: 'Copied' })).toBeInTheDocument();
    expect(navigator.clipboard.writeText).toHaveBeenCalledExactlyOnceWith(`${window.location.origin}/share/${SECRET}`);

    // The list refetched and carries the new link.
    await waitFor(() => expect(within(dialog).getAllByTestId('public-link-row')).toHaveLength(1));

    close();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const reopened = await open();
    expect(within(reopened).getAllByTestId('public-link-row')).toHaveLength(1);
    expect(within(reopened).queryByTestId('public-link-url')).toBeNull();
    expect(within(reopened).queryByText(SHOWN_ONCE)).toBeNull();
    expect(reopened).not.toHaveTextContent(SECRET);
  });

  /**
   * THE SECRET LEAVES WITH THE DIALOG, from the app's caches as well as the
   * screen. The create's answer is the only place the client ever holds it, and
   * a mutation's answer is kept in the client's mutation cache after its
   * observer goes — five minutes by default — where anything with the client
   * can read it. The paired positive says the read is looking in the right
   * place: while the dialog is open, the cache does hold it.
   */
  it('keeps no copy of the secret in the client’s caches once the dialog closes', async () => {
    stubLinks();
    const client = mount();
    const dialog = await open();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create link' }));
    await within(dialog).findByTestId('public-link-url');
    expect(cached(client)).toContain(SECRET);

    close();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(cached(client)).not.toContain(SECRET));
  });

  /** Plain http on anything but localhost has no Clipboard API at all. The URL
   *  is on screen, selectable, whatever the clipboard does: only the Copy
   *  button's feedback changes. */
  it('keeps the URL in a read-only field when there is no clipboard, and says it did not copy', async () => {
    Object.assign(navigator, { clipboard: undefined });
    stubLinks();
    mount();
    const dialog = await open();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create link' }));

    const url = await within(dialog).findByTestId('public-link-url');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Copy link' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/could not be copied/i);
    expect(within(dialog).queryByRole('button', { name: 'Copied' })).toBeNull();
    expect(url).toHaveValue(`${window.location.origin}/share/${SECRET}`);
    expect(url).toHaveAttribute('readonly');
  });

  it('shows the API’s own words when a create is refused', async () => {
    stubLinks({
      create: () =>
        problem(409, 'RUN_NOT_SHAREABLE', `Run ${RUN_ID} is running: only a finished run can be shared.`, 'Share it once it finishes.'),
    });
    mount();
    const dialog = await open();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create link' }));

    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent(`Run ${RUN_ID} is running: only a finished run can be shared.`);
    expect(alert).toHaveTextContent('Share it once it finishes.');
    expect(within(dialog).queryByTestId('public-link-url')).toBeNull();
  });
});

describe('ShareDialog — the run’s links', () => {
  it('shows each link’s state, who created it, when it expires and when it was last opened', async () => {
    stubLinks({ items: [ACTIVE, REVOKED, EXPIRED] });
    mount();
    const dialog = await open();

    const [active, revoked, expired] = within(dialog).getAllByTestId('public-link-row');
    expect(within(active!).getByTestId('public-link-state')).toHaveTextContent('Active');
    expect(active).toHaveTextContent('Asha Rao');
    expect(active).toHaveTextContent(formatInstant(ACTIVE.createdAt));
    expect(active).toHaveTextContent(formatInstant(ACTIVE.expiresAt));
    expect(active).toHaveTextContent(formatInstant(ACTIVE.lastUsedAt!));
    expect(within(active!).getByRole('button', { name: /^Revoke/ })).toBeInTheDocument();

    expect(within(revoked!).getByTestId('public-link-state')).toHaveTextContent('Revoked');
    expect(revoked).toHaveTextContent('Ravi Menon');
    expect(revoked).toHaveTextContent(formatInstant(REVOKED.revokedAt!));
    // A stopped link is not offered to stop again.
    expect(within(revoked!).queryByRole('button', { name: /^Revoke/ })).toBeNull();

    expect(within(expired!).getByTestId('public-link-state')).toHaveTextContent('Expired');
    expect(expired).toHaveTextContent(formatInstant(EXPIRED.expiresAt));
    expect(expired).toHaveTextContent('Never');
    expect(within(expired!).queryByRole('button', { name: /^Revoke/ })).toBeNull();
  });

  /** Revoking stops every reader of the link at once, so it takes two clicks,
   *  and neither button is the dialog's primary: Create is. */
  it('revokes only after an inline confirmation, then reads the list again', async () => {
    const sent = stubLinks({ items: [ACTIVE] });
    mount();
    const dialog = await open();
    const reads = () => sent.filter((request) => request.method === 'GET').length;
    expect(reads()).toBe(1);

    const row = within(dialog).getByTestId('public-link-row');
    fireEvent.click(within(row).getByRole('button', { name: /^Revoke/ }));
    // A request is sent a tick after the click that asks for it, so give one
    // the time to be sent before saying none was.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sent.some((request) => request.method === 'DELETE')).toBe(false);

    // Armed: the consequence in words, and a way back — with focus on the way
    // back, never on the destructive button, and returned to Revoke after it.
    expect(row).toHaveTextContent(/stops working for everyone/i);
    expect(within(row).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    fireEvent.click(within(row).getByRole('button', { name: 'Cancel' }));
    expect(within(row).getByRole('button', { name: /^Revoke/ })).toHaveFocus();

    fireEvent.click(within(row).getByRole('button', { name: /^Revoke/ }));
    const confirm = within(row).getByRole('button', { name: 'Confirm revoke' });
    expect(confirm.className).not.toContain('bg-accent');
    fireEvent.click(confirm);

    await waitFor(() => expect(reads()).toBe(2));
    expect(sent.filter((request) => request.method === 'DELETE')).toEqual([
      { method: 'DELETE', path: `/v1/runs/${RUN_ID}/public-links/${ACTIVE.id}`, body: undefined },
    ]);
    await waitFor(() =>
      expect(within(dialog).getByTestId('public-link-state')).toHaveTextContent('Revoked'),
    );
  });

  /** One primary per screen (Button.tsx), and on this one it is Create. */
  it('has exactly one primary button, Create, even with a revoke armed', async () => {
    stubLinks({ items: [ACTIVE] });
    mount();
    const dialog = await open();
    const primaries = () =>
      [...dialog.querySelectorAll('button')]
        .filter((button) => button.className.includes('bg-accent'))
        .map((button) => button.textContent?.trim());
    expect(primaries()).toEqual(['Create link']);
    fireEvent.click(within(within(dialog).getByTestId('public-link-row')).getByRole('button', { name: /^Revoke/ }));
    expect(primaries()).toEqual(['Create link']);
  });

  /**
   * NAMED APART, though they look alike. Every instant on a row is to the
   * minute, so two links made in one minute read the same — and a list of
   * Revoke buttons sharing one name is the duplicate-name defect this repo has
   * paid for before. The name carries the creation instant to the second.
   */
  it('gives each Revoke its own name when two links were created in the same minute', async () => {
    // The fixture really does collide at the minute: otherwise this proves nothing.
    expect(formatInstant(FIRST.createdAt)).toBe(formatInstant(SECOND.createdAt));
    expect(formatInstant(FIRST.expiresAt)).toBe(formatInstant(SECOND.expiresAt));
    stubLinks({ items: [SECOND, FIRST] });
    mount();
    const dialog = await open();

    const names = within(dialog)
      .getAllByRole('button', { name: /^Revoke/ })
      .map((button) => button.getAttribute('aria-label'));
    expect(names).toHaveLength(2);
    expect(new Set(names).size).toBe(2);
  });

  /**
   * FOCUS GOES WHERE THE READER JUST ACTED. Arming a second link disarms the
   * first, and the first's way back is not where the reader is: they asked to
   * revoke the second, so its Cancel takes the caret — whichever row is above.
   */
  it('focuses the Cancel of the row just armed, even when another row was armed before it', async () => {
    stubLinks({ items: [SECOND, FIRST] });
    mount();
    const dialog = await open();
    const [upper, lower] = within(dialog).getAllByTestId('public-link-row');

    fireEvent.click(within(lower!).getByRole('button', { name: /^Revoke/ }));
    expect(within(lower!).getByRole('button', { name: 'Cancel' })).toHaveFocus();

    fireEvent.click(within(upper!).getByRole('button', { name: /^Revoke/ }));
    expect(within(upper!).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    // One armed at a time: the lower row is back to its Revoke.
    expect(within(lower!).queryByRole('button', { name: 'Cancel' })).toBeNull();
  });

  /** A confirmed revoke removes the button the reader pressed and, once the
   *  list reads again, the Revoke beside it — so the caret is kept on the row
   *  itself, which survives both, rather than falling out of the dialog. */
  it('keeps focus on the row after a revoke is confirmed, through the list’s re-read', async () => {
    stubLinks({ items: [ACTIVE] });
    mount();
    const dialog = await open();
    const row = within(dialog).getByTestId('public-link-row');

    fireEvent.click(within(row).getByRole('button', { name: /^Revoke/ }));
    fireEvent.click(within(row).getByRole('button', { name: 'Confirm revoke' }));
    expect(row).toHaveFocus();

    await waitFor(() => expect(within(row).getByTestId('public-link-state')).toHaveTextContent('Revoked'));
    expect(within(row).queryByRole('button', { name: /^Revoke/ })).toBeNull();
    expect(row).toHaveFocus();
  });

  it('says so when the run has no links yet', async () => {
    stubLinks();
    mount();
    const dialog = await open();
    expect(within(dialog).queryAllByTestId('public-link-row')).toHaveLength(0);
    expect(dialog).toHaveTextContent('No links yet.');
  });
});

/**
 * ═══ CLOSING HANDS THE CARET BACK TO SHARE ═══
 *
 * A modal that closes and leaves focus on `<body>` drops a keyboard or
 * screen-reader reader at the top of the document (WCAG 2.4.3). Radix returns
 * focus to the dialog's trigger — through a ref on it, which a component that
 * does not forward refs silently drops (React warns, once per component:
 * "Function components cannot be given refs" — the file-level hook above
 * watches for it). Both ways out are asserted.
 */
describe('ShareDialog — focus returns to Share when the dialog closes', () => {
  it.each([
    ['Escape', () => fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })],
    ['the Close button', close],
  ])('returns focus to Share when %s closes the dialog', async (_how, dismiss) => {
    stubLinks();
    mount();
    const share = screen.getByRole('button', { name: 'Share' });
    share.focus();
    const dialog = await open();
    expect(dialog).toContainElement(document.activeElement as HTMLElement);

    dismiss();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(share).toHaveFocus());
  });
});
