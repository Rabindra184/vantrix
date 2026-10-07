import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PasswordChangeForm from '../src/components/PasswordChangeForm';
import { PASSWORD_LENGTH_MESSAGE } from '../src/formIssues';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/**
 * Driven through `fetch`, not by mocking `changeOwnPassword`: the claim is
 * what reaches the wire — `PUT /v1/me/password` with the two passwords and
 * nothing else (the repeat is the form's own check, and the server's schema is
 * strict) — and a mocked client would only prove the form called a function.
 */
interface Sent {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
}
let sent: Sent[] = [];

const noContent = () => Promise.resolve(new Response(null, { status: 204 }));

function renderForm(answer: () => Promise<Response> = noContent) {
  sent = [];
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    sent.push({
      url: String(input),
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    return answer();
  });
  const onDone = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <PasswordChangeForm onDone={onDone} />
    </QueryClientProvider>,
  );
  return { ...view, onDone };
}

const current = () => screen.getByLabelText('Current password');
const fresh = () => screen.getByLabelText('New password');
const repeat = () => screen.getByLabelText('Repeat new password');
const submit = () => screen.getByRole('button', { name: 'Change password' });

async function fill(values: { current: string; fresh: string; repeat: string }) {
  const user = userEvent.setup();
  await user.type(current(), values.current);
  await user.type(fresh(), values.fresh);
  await user.type(repeat(), values.repeat);
  await user.click(submit());
  return user;
}

describe('PasswordChangeForm — the fields', () => {
  /** What a password manager reads: it offers the saved password for the
   *  first field and a generated one for the other two. */
  it('asks the browser for the current password once and a new one twice', () => {
    renderForm();
    expect(current()).toHaveAttribute('type', 'password');
    expect(current()).toHaveAttribute('autocomplete', 'current-password');
    for (const field of [fresh(), repeat()]) {
      expect(field).toHaveAttribute('type', 'password');
      expect(field).toHaveAttribute('autocomplete', 'new-password');
    }
  });

  /** `.bg-accent` is the primary variant's own definition, so this counts
   *  what the reader sees as the page's one main action. */
  it('has one primary button, and it is Change password', () => {
    const { container } = renderForm();
    const primaries = [...container.querySelectorAll('button.bg-accent')];
    expect(primaries).toHaveLength(1);
    expect(primaries[0]).toBe(submit());
  });

  it('says nothing assertive until there is something to say', () => {
    renderForm();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('PasswordChangeForm — refused before it is sent', () => {
  it('refuses two new passwords that differ, under the repeat field', async () => {
    const { onDone } = renderForm();
    await fill({ current: 'old-password', fresh: 'new-password-1', repeat: 'new-password-2' });

    expect(repeat()).toHaveAccessibleDescription('The new passwords do not match.');
    expect(repeat()).toHaveAttribute('aria-invalid', 'true');
    // Under the field the reader has to change, and nowhere else.
    expect(fresh()).not.toHaveAttribute('aria-invalid');
    await waitFor(() => expect(repeat()).toHaveFocus());
    expect(sent).toEqual([]);
    expect(onDone).not.toHaveBeenCalled();
  });

  /** One sentence from the contract's two bounds, never the schema's own
   *  "String must contain at least 8 character(s)". */
  it('states the password bounds, not zod’s wording, for a short new password', async () => {
    renderForm();
    await fill({ current: 'old-password', fresh: 'short12', repeat: 'short12' });

    expect(fresh()).toHaveAccessibleDescription(PASSWORD_LENGTH_MESSAGE);
    expect(document.body).not.toHaveTextContent(/String must contain/);
    expect(sent).toEqual([]);
  });

  it('refuses a new password equal to the current one, under the new password', async () => {
    renderForm();
    await fill({ current: 'same-password', fresh: 'same-password', repeat: 'same-password' });

    expect(fresh()).toHaveAccessibleDescription('The new password is the same as the current one.');
    expect(sent).toEqual([]);
  });
});

describe('PasswordChangeForm — sent', () => {
  it('puts the two passwords to /v1/me/password and reports done', async () => {
    const { onDone } = renderForm();
    await fill({ current: 'old-password', fresh: 'new-password-1', repeat: 'new-password-1' });

    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(sent).toEqual([
      {
        url: '/v1/me/password',
        method: 'PUT',
        body: { currentPassword: 'old-password', newPassword: 'new-password-1' },
      },
    ]);
  });

  /** The server is the authority on the current password, so its refusal is
   *  shown as it sent it — detail and remediation — and the form stays. */
  it('shows the server’s refusal of the current password as an alert', async () => {
    const { onDone } = renderForm(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            code: 'INVALID_CURRENT_PASSWORD',
            detail: 'The current password is not correct.',
            remediation: 'Type the password you signed in with.',
          }),
          { status: 400, headers: { 'Content-Type': 'application/problem+json' } },
        ),
      ),
    );
    await fill({ current: 'wrong-password', fresh: 'new-password-1', repeat: 'new-password-1' });

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('The current password is not correct.')).toBeInTheDocument();
    expect(within(alert).getByText('Type the password you signed in with.')).toBeInTheDocument();
    expect(onDone).not.toHaveBeenCalled();
    expect(submit()).toBeEnabled();
  });

  /** A second press while the first is in flight would send the old password
   *  again after it had stopped being the current one. */
  it('cannot be pressed again while the change is in flight', async () => {
    renderForm(() => new Promise<Response>(() => {}));
    await fill({ current: 'old-password', fresh: 'new-password-1', repeat: 'new-password-1' });

    await waitFor(() => expect(submit()).toBeDisabled());
    expect(sent).toHaveLength(1);
  });
});
