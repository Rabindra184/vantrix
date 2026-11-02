// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OrgSettings } from '@perfportal/contracts';
import AdminSettings from '../src/routes/AdminSettings';
import { ADMIN_SETTINGS_ROUTE } from '../src/routes/paths';

// No vitest globals here, so Testing Library's automatic cleanup never
// registers; without this every render stacks in one `document.body`.
afterEach(cleanup);
afterEach(() => {
  vi.unstubAllGlobals();
});

const SETTINGS = '/v1/admin/settings';
const RECOMPUTE = '/v1/admin/recompute';

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const problem = (status: number, code: string, detail: string, remediation: string): Response =>
  json(status, { type: 'about:blank', title: 'Error', status, code, detail, remediation });

const CONFIGURED_OFF: OrgSettings = {
  aiEnabled: false,
  aiProviderConfigured: true,
  aiProvider: 'anthropic',
  aiModel: 'claude-sonnet-4',
};

const NOT_CONFIGURED: OrgSettings = {
  aiEnabled: false,
  aiProviderConfigured: false,
  aiProvider: null,
  aiModel: null,
};

interface Call {
  readonly method: string;
  readonly url: string;
  readonly body: string | null;
}

/**
 * Answers the page's two endpoints — its own settings, and the backfill line
 * the shell draws on every Administration page but Data integrity — and
 * records every call. `answer` decides the settings response at call time,
 * so a test can change what the server holds between a PUT and the re-read.
 */
function stub(answer: (call: Call) => Response): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const call: Call = {
      method: init?.method ?? 'GET',
      url,
      body: typeof init?.body === 'string' ? init.body : null,
    };
    calls.push(call);
    if (url === RECOMPUTE) return Promise.resolve(json(200, { total: 0, remaining: 0, failed: 0 }));
    if (url === SETTINGS) return Promise.resolve(answer(call));
    return Promise.resolve(json(404, {}));
  });
  return calls;
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[ADMIN_SETTINGS_ROUTE]}>
        <AdminSettings />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const settingsGets = (calls: readonly Call[]) => calls.filter((c) => c.url === SETTINGS && c.method === 'GET');

describe('AdminSettings', () => {
  it('is the Settings section of Administration', async () => {
    stub(() => json(200, CONFIGURED_OFF));
    renderPage();
    await screen.findByRole('button', { name: 'AI features' });
    expect(screen.getByRole('heading', { level: 1, name: 'Administration' })).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Administration sections' });
    expect(within(nav).getAllByRole('link', { current: 'page' }).map((l) => l.textContent)).toEqual(['Settings']);
    expect(document.title).toBe('Settings · Administration · PerfPortal');
  });

  it('hides the switch when no provider is configured', async () => {
    stub(() => json(200, NOT_CONFIGURED));
    renderPage();
    const line = await screen.findByTestId('ai-provider-not-configured');
    // Names the variable an operator sets, in one sentence.
    expect(line.textContent).toContain('AI_PROVIDER');
    expect(line.textContent?.trim().split(/(?<=[.!?])\s+/)).toHaveLength(1);
    // NOT drawn, rather than drawn disabled: there is nothing to switch on.
    expect(screen.queryByRole('button', { name: 'AI features' })).toBeNull();
    expect(screen.queryByTestId('ai-features-switch')).toBeNull();
  });

  it('describes what leaves the deployment, naming the provider and model', async () => {
    stub(() => json(200, CONFIGURED_OFF));
    renderPage();
    const toggle = await screen.findByRole('button', { name: 'AI features' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    // The description is the CONTROL's, announced on focus — not a paragraph
    // under the title.
    expect(toggle).toHaveAccessibleDescription(
      "When on, a member can send a run's figures, request names and error messages to anthropic/claude-sonnet-4 to write an analysis.",
    );
    expect(screen.queryByTestId('ai-provider-not-configured')).toBeNull();
  });

  it('turns AI features on and re-reads the settings', async () => {
    let held: OrgSettings = CONFIGURED_OFF;
    const calls = stub((call) => {
      if (call.method === 'PUT') {
        held = { ...held, ...(JSON.parse(call.body ?? '{}') as Pick<OrgSettings, 'aiEnabled'>) };
      }
      return json(200, held);
    });
    renderPage();
    const toggle = await screen.findByRole('button', { name: 'AI features' });
    expect(settingsGets(calls)).toHaveLength(1);

    await userEvent.click(toggle);

    await waitFor(() => expect(screen.getByRole('button', { name: 'AI features' })).toHaveAttribute('aria-pressed', 'true'));
    const puts = calls.filter((c) => c.url === SETTINGS && c.method === 'PUT');
    expect(puts).toHaveLength(1);
    // Exactly the strict request body: the switch and nothing else.
    expect(JSON.parse(puts[0]!.body ?? 'null')).toEqual({ aiEnabled: true });
    // The page shows what the server holds afterwards, read again.
    await waitFor(() => expect(settingsGets(calls)).toHaveLength(2));
  });

  it("shows the API's refusal for a non-admin", async () => {
    stub(() =>
      problem(
        403,
        'ADMIN_REQUIRED',
        'Managing users needs an admin.',
        'Ask an admin to do this.',
      ),
    );
    renderPage();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Managing users needs an admin.');
    expect(alert).toHaveTextContent('Ask an admin to do this.');
    expect(screen.queryByRole('button', { name: 'AI features' })).toBeNull();
    // The shell still draws, so the reader sees where they are.
    expect(screen.getByRole('navigation', { name: 'Administration sections' })).toBeInTheDocument();
  });

  it("shows the API's refusal of the change beside the switch, and keeps the switch as it was", async () => {
    stub((call) =>
      call.method === 'PUT'
        ? problem(403, 'ADMIN_REQUIRED', 'Managing users needs an admin.', 'Ask an admin to do this.')
        : json(200, CONFIGURED_OFF),
    );
    renderPage();
    const toggle = await screen.findByRole('button', { name: 'AI features' });
    await userEvent.click(toggle);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Managing users needs an admin.');
    expect(alert).toHaveTextContent('Ask an admin to do this.');
    expect(screen.getByRole('button', { name: 'AI features' })).toHaveAttribute('aria-pressed', 'false');
  });
});
