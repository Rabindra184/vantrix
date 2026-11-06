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
  publicLinksEnabled: false,
  aiProviderConfigured: true,
  aiProvider: 'anthropic',
  aiModel: 'claude-sonnet-4',
};

const NOT_CONFIGURED: OrgSettings = {
  aiEnabled: false,
  publicLinksEnabled: false,
  aiProviderConfigured: false,
  aiProvider: null,
  aiModel: null,
};

/** An org switched on while a provider was configured, whose deployment has
 *  since lost it: the switch must stay reachable, so it can be turned off. */
const ENABLED_NOT_CONFIGURED: OrgSettings = { ...NOT_CONFIGURED, aiEnabled: true };

/** The public-links switch's sentence: spec section 6.5, verbatim. */
const PUBLIC_LINKS_SENTENCE =
  "Anyone with a public link can read that run's Summary, Report and Logs without signing in, until the link expires or is revoked. Turning this off stops every link at once; turning it back on restores the links that have not expired or been revoked.";

const CONSENT =
  "When on, a member can send a run's figures and the names it records — its simulation, requests, groups and assertions — with its error messages to anthropic/claude-sonnet-4 to write an analysis. Off also hides analyses already written.";

/** A self-hosted endpoint: the API names its host, and nothing else of its URL. */
const OPENAI_COMPATIBLE: OrgSettings = {
  aiEnabled: false,
  publicLinksEnabled: false,
  aiProviderConfigured: true,
  aiProvider: 'openai-compatible',
  aiModel: 'llama-3.3-70b',
  aiBaseUrlHost: 'llm.internal.example:8443',
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
    // True whether the org's switch is off or was left on: it says what the
    // deployment lacks, not what an admin may do next.
    expect(line.textContent).not.toMatch(/turned on/i);
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
    expect(toggle).toHaveAccessibleDescription(CONSENT);
    // VISIBLE, not behind an ⓘ: it is the admin's consent to sending data to
    // a third party, so it is read before the switch is pressed.
    const sentence = screen.getByText(CONSENT);
    expect(sentence).toBeVisible();
    expect(sentence.closest('[hidden]')).toBeNull();
    expect(screen.queryByRole('button', { name: 'About AI features' })).toBeNull();
    expect(screen.queryByTestId('ai-provider-not-configured')).toBeNull();
  });

  it('names every kind of thing that leaves the deployment, and says off hides what was written', async () => {
    stub(() => json(200, CONFIGURED_OFF));
    renderPage();
    const toggle = await screen.findByRole('button', { name: 'AI features' });
    const sentence = document.getElementById(toggle.getAttribute('aria-describedby') ?? '')!;
    // Each category DEPLOYMENT.md lists as sent, not a sample of them: the
    // consent is to all of it.
    for (const sent of ['figures', 'simulation', 'requests', 'groups', 'assertions', 'error messages']) {
      expect(sentence.textContent).toContain(sent);
    }
    expect(sentence.textContent).toMatch(/off also hides analyses already written/i);
  });

  it("names an openai-compatible endpoint's host as well as its provider and model", async () => {
    stub(() => json(200, OPENAI_COMPATIBLE));
    renderPage();
    const toggle = await screen.findByRole('button', { name: 'AI features' });
    expect(toggle).toHaveAccessibleDescription(
      /to llm\.internal\.example:8443 \(openai-compatible\/llama-3\.3-70b\) to write an analysis\./,
    );
  });

  it('names an openai-compatible provider without a host when an older API sends none', async () => {
    const older: Record<string, unknown> = { ...OPENAI_COMPATIBLE };
    delete older.aiBaseUrlHost;
    stub(() => json(200, older));
    renderPage();
    const toggle = await screen.findByRole('button', { name: 'AI features' });
    expect(toggle).toHaveAccessibleDescription(/ with its error messages to openai-compatible\/llama-3\.3-70b to write/);
  });

  it('keeps the switch, on, for an org left enabled with no provider configured, and turns it off', async () => {
    let held: OrgSettings = ENABLED_NOT_CONFIGURED;
    const calls = stub((call) => {
      if (call.method === 'PUT') {
        held = { ...held, ...(JSON.parse(call.body ?? '{}') as Pick<OrgSettings, 'aiEnabled'>) };
      }
      return json(200, held);
    });
    renderPage();
    const toggle = await screen.findByRole('button', { name: 'AI features' });
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    const line = screen.getByTestId('ai-provider-not-configured');
    expect(line).toBeVisible();
    expect(line.textContent).toContain('AI_PROVIDER');
    expect(line.textContent).not.toMatch(/turned on/i);
    // No destination to name, so no consent sentence naming one.
    expect(screen.queryByText(/^When on,/)).toBeNull();

    await userEvent.click(toggle);

    await waitFor(() => expect(screen.queryByRole('button', { name: 'AI features' })).toBeNull());
    const puts = calls.filter((c) => c.url === SETTINGS && c.method === 'PUT');
    expect(puts).toHaveLength(1);
    expect(JSON.parse(puts[0]!.body ?? 'null')).toEqual({ aiEnabled: false });
    // Off, with no provider: today's page — the one operator sentence.
    expect(screen.getByTestId('ai-provider-not-configured')).toBeVisible();
  });

  it('moves focus to the operator sentence when turning the switch off removes it', async () => {
    let held: OrgSettings = ENABLED_NOT_CONFIGURED;
    stub((call) => {
      if (call.method === 'PUT') held = { ...held, aiEnabled: false };
      return json(200, held);
    });
    renderPage();
    const toggle = await screen.findByRole('button', { name: 'AI features' });
    await userEvent.click(toggle);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'AI features' })).toBeNull());
    // Not dropped to <body> with the switch that held it.
    const line = screen.getByTestId('ai-provider-not-configured');
    await waitFor(() => expect(document.activeElement).toBe(line));
    // Reachable by script, not added to the Tab order.
    expect(line).toHaveAttribute('tabindex', '-1');
  });

  it('does not take focus to the operator sentence on a page that merely arrives without a switch', async () => {
    stub(() => json(200, NOT_CONFIGURED));
    renderPage();
    await screen.findByTestId('ai-provider-not-configured');
    expect(document.activeElement).toBe(document.body);
  });

  it("keeps the PUT's answer when the re-read after it fails, rather than showing the old state", async () => {
    let gets = 0;
    stub((call) => {
      if (call.method === 'PUT') return json(200, { ...CONFIGURED_OFF, aiEnabled: true });
      gets += 1;
      return gets === 1
        ? json(200, CONFIGURED_OFF)
        : problem(500, 'INTERNAL', 'The request could not be completed.', 'Retry the request.');
    });
    renderPage();
    const toggle = await screen.findByRole('button', { name: 'AI features' });
    await userEvent.click(toggle);
    // The re-read was asked for and failed...
    await waitFor(() => expect(gets).toBe(2));
    await screen.findByText(/could not be refreshed/i);
    // ...and the switch still says ON, which is what the server holds.
    expect(screen.getByRole('button', { name: 'AI features' })).toHaveAttribute('aria-pressed', 'true');
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

  it('draws a second switch, Public links, beside AI features', async () => {
    stub(() => json(200, CONFIGURED_OFF));
    renderPage();
    const toggle = await screen.findByRole('button', { name: 'Public links' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'AI features' })).toBeInTheDocument();
  });

  it('draws the Public links switch when no AI provider is configured', async () => {
    stub(() => json(200, NOT_CONFIGURED));
    renderPage();
    await screen.findByTestId('ai-provider-not-configured');
    // The two switches are independent: no AI provider is no reason to hide
    // the one that publishes runs.
    expect(screen.getByRole('button', { name: 'Public links' })).toBeInTheDocument();
  });

  it("states what turning public links on publishes, visibly and as the switch's description", async () => {
    stub(() => json(200, CONFIGURED_OFF));
    renderPage();
    const toggle = await screen.findByRole('button', { name: 'Public links' });
    expect(toggle).toHaveAccessibleDescription(PUBLIC_LINKS_SENTENCE);
    // VISIBLE, not behind an ⓘ: turning it on is a decision about publishing,
    // read before the switch is pressed (the AI consent rule).
    const sentence = screen.getByText(PUBLIC_LINKS_SENTENCE);
    expect(sentence).toBeVisible();
    expect(sentence.closest('[hidden]')).toBeNull();
    expect(screen.queryByRole('button', { name: 'About Public links' })).toBeNull();
  });

  it('turns public links on, sending that switch alone, and re-reads the settings', async () => {
    // AI features ON, so a body that carried both switches would show it.
    let held: OrgSettings = { ...CONFIGURED_OFF, aiEnabled: true };
    const calls = stub((call) => {
      if (call.method === 'PUT') held = { ...held, ...(JSON.parse(call.body ?? '{}') as Partial<OrgSettings>) };
      return json(200, held);
    });
    renderPage();
    const toggle = await screen.findByRole('button', { name: 'Public links' });

    await userEvent.click(toggle);

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Public links' })).toHaveAttribute('aria-pressed', 'true'),
    );
    const puts = calls.filter((c) => c.url === SETTINGS && c.method === 'PUT');
    expect(puts).toHaveLength(1);
    // Its own field and nothing else: the AI switch is not re-sent.
    expect(puts[0]!.body).toBe('{"publicLinksEnabled":true}');
    expect(screen.getByRole('button', { name: 'AI features' })).toHaveAttribute('aria-pressed', 'true');
    await waitFor(() => expect(settingsGets(calls)).toHaveLength(2));
  });

  it('still sends the AI switch alone with public links on', async () => {
    let held: OrgSettings = { ...CONFIGURED_OFF, publicLinksEnabled: true };
    const calls = stub((call) => {
      if (call.method === 'PUT') held = { ...held, ...(JSON.parse(call.body ?? '{}') as Partial<OrgSettings>) };
      return json(200, held);
    });
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'AI features' }));

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'AI features' })).toHaveAttribute('aria-pressed', 'true'),
    );
    const puts = calls.filter((c) => c.url === SETTINGS && c.method === 'PUT');
    expect(puts.map((c) => c.body)).toEqual(['{"aiEnabled":true}']);
    expect(screen.getByRole('button', { name: 'Public links' })).toHaveAttribute('aria-pressed', 'true');
  });

  it("shows the API's refusal of a public-links change beside that switch, and keeps it as it was", async () => {
    stub((call) =>
      call.method === 'PUT'
        ? problem(403, 'ADMIN_REQUIRED', 'Managing users needs an admin.', 'Ask an admin to do this.')
        : json(200, CONFIGURED_OFF),
    );
    renderPage();
    const toggle = await screen.findByRole('button', { name: 'Public links' });
    await userEvent.click(toggle);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Managing users needs an admin.');
    expect(alert).toHaveTextContent('Ask an admin to do this.');
    expect(toggle.parentElement).toContainElement(alert);
    expect(screen.getByRole('button', { name: 'Public links' })).toHaveAttribute('aria-pressed', 'false');
  });

  /** An API pod that predates the switch sends no key, and refuses the field
   *  in a PUT (its body is strict) — so there is nothing to draw, rather than
   *  a switch reading OFF that would answer 400 when pressed. */
  it('draws no Public links switch for an API that predates it, and keeps AI features', async () => {
    const older: Record<string, unknown> = { ...CONFIGURED_OFF };
    delete older.publicLinksEnabled;
    stub(() => json(200, older));
    renderPage();
    await screen.findByRole('button', { name: 'AI features' });
    expect(screen.queryByRole('button', { name: 'Public links' })).toBeNull();
    expect(screen.queryByText(PUBLIC_LINKS_SENTENCE)).toBeNull();
  });
});
