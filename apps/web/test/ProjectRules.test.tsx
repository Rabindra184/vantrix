// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SlaRule } from '@perfportal/contracts';

const createProjectRule = vi.fn();
const updateProjectRule = vi.fn();
const deleteProjectRule = vi.fn();
const fetchProjectRules = vi.fn();

vi.mock('../src/api/rules.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api/rules.js')>();
  return {
    ...actual,
    fetchProjectRules: (slug: string) => fetchProjectRules(slug),
    createProjectRule: (slug: string, body: unknown) => createProjectRule(slug, body),
    updateProjectRule: (slug: string, id: string, body: unknown) =>
      updateProjectRule(slug, id, body),
    deleteProjectRule: (slug: string, id: string) => deleteProjectRule(slug, id),
  };
});

const { default: ProjectRules } = await import('../src/routes/ProjectRules');

const rule = (over: Partial<SlaRule> = {}): SlaRule => ({
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Checkout p95 gate',
  scope: 'run',
  targetName: null,
  family: 'response_time',
  metric: 'p95',
  comparator: 'lte',
  threshold: 800,
  enabled: true,
  createdAt: '2026-08-22T10:00:00.000Z',
  updatedAt: '2026-08-22T10:00:00.000Z',
  ...over,
});

function renderRules() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ProjectRules slug="checkout" />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchProjectRules.mockResolvedValue({ rules: [] });
  createProjectRule.mockResolvedValue(rule());
  updateProjectRule.mockResolvedValue(rule({ enabled: false }));
  deleteProjectRule.mockResolvedValue(rule());
});

afterEach(cleanup);

describe('ProjectRules — authoring', () => {
  /**
   * ═══ THE CASE THE WHOLE FEATURE EXISTS FOR ═══
   *
   * `resolveMetric` returns null for a name it cannot resolve, and
   * `evaluateRules` records `not_applicable` rather than failing. So a rule
   * saved as `p95th` would look configured and never check anything. The form
   * must refuse it BEFORE the request, so the message can appear beside the
   * field rather than as a server error at the bottom.
   */
  it('refuses a metric the evaluator could never resolve, without calling the API', async () => {
    const user = userEvent.setup();
    renderRules();

    const metric = await screen.findByLabelText(/metric/i);
    await user.clear(metric);
    await user.type(metric, 'p95th');
    await user.click(screen.getByRole('button', { name: 'Add rule' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/p95/);
    expect(createProjectRule).not.toHaveBeenCalled();
  });

  it('submits a valid run-scoped rule with no target name', async () => {
    const user = userEvent.setup();
    renderRules();

    await user.type(await screen.findByLabelText(/name \(optional\)/i), 'Checkout p95 gate');
    await user.click(screen.getByRole('button', { name: 'Add rule' }));

    await waitFor(() => expect(createProjectRule).toHaveBeenCalledTimes(1));
    expect(createProjectRule).toHaveBeenCalledWith('checkout', {
      name: 'Checkout p95 gate',
      scope: 'run',
      targetName: null,
      family: 'response_time',
      metric: 'p95',
      comparator: 'lte',
      threshold: 800,
    });
  });

  /**
   * A run rule reads the run's own aggregate row and has nothing to target, so
   * the field is not merely optional — it must not be there to fill in. Every
   * other scope matches BY name, and a null one matches nothing at all.
   */
  it('shows the target field only for the scopes that match by name', async () => {
    const user = userEvent.setup();
    renderRules();

    expect(screen.queryByLabelText(/target name/i)).toBeNull();
    await user.selectOptions(await screen.findByLabelText(/scope/i), 'request');
    expect(screen.getByLabelText(/target name/i)).toBeInTheDocument();
  });

  it('refuses a request-scoped rule with no target, which would match nothing', async () => {
    const user = userEvent.setup();
    renderRules();

    await user.selectOptions(await screen.findByLabelText(/scope/i), 'request');
    await user.click(screen.getByRole('button', { name: 'Add rule' }));

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(createProjectRule).not.toHaveBeenCalled();
  });

  /**
   * `error_rate` needs no new rule FAMILY — `family` picks the stat row and
   * `metric` picks the value out of it. Pinned because the opposite was
   * believed and nearly acted on as a schema change.
   */
  it('accepts error_rate, which needs no new rule family', async () => {
    const user = userEvent.setup();
    renderRules();

    const metric = await screen.findByLabelText(/metric/i);
    await user.clear(metric);
    await user.type(metric, 'error_rate');
    const threshold = screen.getByLabelText(/threshold/i);
    await user.clear(threshold);
    await user.type(threshold, '0.01');
    await user.click(screen.getByRole('button', { name: 'Add rule' }));

    await waitFor(() => expect(createProjectRule).toHaveBeenCalledTimes(1));
    expect(createProjectRule.mock.calls[0]?.[1]).toMatchObject({
      metric: 'error_rate',
      family: 'response_time',
      threshold: 0.01,
    });
  });
});

describe('ProjectRules — the table', () => {
  it('describes a rule the way the run page and the evaluator do', async () => {
    fetchProjectRules.mockResolvedValue({ rules: [rule()] });
    renderRules();
    // `describeAssertionRule`'s own typeset comparator, so a rule reads
    // identically here and on the run it judged.
    expect(await screen.findByText('p95 of the run (response_time) ≤ 800')).toBeInTheDocument();
  });

  it('falls back to a dash for a rule nobody named', async () => {
    fetchProjectRules.mockResolvedValue({ rules: [rule({ name: null })] });
    renderRules();
    expect(await screen.findByText('—')).toBeInTheDocument();
  });

  /**
   * A disabled rule must still be listed: "disabled" is a state a reader put
   * it in and has to be able to undo. `listEnabled`, which evaluation uses,
   * stays as narrow as it always was.
   */
  it('lists a disabled rule and offers to re-enable it', async () => {
    const user = userEvent.setup();
    fetchProjectRules.mockResolvedValue({ rules: [rule({ enabled: false })] });
    renderRules();

    expect(await screen.findByText('Disabled')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Enable' }));
    await waitFor(() => expect(updateProjectRule).toHaveBeenCalledTimes(1));
    expect(updateProjectRule).toHaveBeenCalledWith(
      'checkout',
      '11111111-1111-4111-8111-111111111111',
      { enabled: true },
    );
  });

  /**
   * TWO STEPS, and the consequence is visible TEXT rather than a modal or a
   * `window.confirm` — the same discipline `TokenTable`'s revoke records. A
   * single-click delete on a release gate is exactly the control that should
   * not be single-click.
   */
  it('arms a delete before performing it', async () => {
    const user = userEvent.setup();
    fetchProjectRules.mockResolvedValue({ rules: [rule()] });
    renderRules();

    await user.click(await screen.findByRole('button', { name: 'Delete' }));
    expect(deleteProjectRule).not.toHaveBeenCalled();
    expect(screen.getByText(/permanent/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Confirm delete' }));
    await waitFor(() => expect(deleteProjectRule).toHaveBeenCalledTimes(1));
  });

  it('lets the reader back out of an armed delete', async () => {
    const user = userEvent.setup();
    fetchProjectRules.mockResolvedValue({ rules: [rule()] });
    renderRules();

    await user.click(await screen.findByRole('button', { name: 'Delete' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('button', { name: 'Confirm delete' })).toBeNull();
    expect(deleteProjectRule).not.toHaveBeenCalled();
  });

  /**
   * A destructive mutation that failed MUST say so, and must not claim a state
   * it cannot know — "may still be active", never "was not deleted".
   */
  it('announces a failed delete without claiming what happened', async () => {
    const user = userEvent.setup();
    fetchProjectRules.mockResolvedValue({ rules: [rule()] });
    deleteProjectRule.mockRejectedValue(new Error('network'));
    renderRules();

    await user.click(await screen.findByRole('button', { name: 'Delete' }));
    await user.click(screen.getByRole('button', { name: 'Confirm delete' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/may still be active/i);
  });

  it('says what an empty project needs rather than showing a bare table', async () => {
    renderRules();
    expect(await screen.findByText('No SLA rules yet')).toBeInTheDocument();
    expect(screen.getByText(/no release verdict/i)).toBeInTheDocument();
  });
});
