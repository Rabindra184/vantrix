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
const fetchProjectTests = vi.fn();

vi.mock('../src/api/tests.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api/tests.js')>();
  return { ...actual, fetchProjectTests: (slug: string) => fetchProjectTests(slug) };
});

vi.mock('../src/api/rules.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api/rules.js')>();
  return {
    ...actual,
    // BOTH ARGUMENTS forwarded. The second is what `?test=` is built from, and
    // a mock that dropped it would make every assertion about the test-scoped
    // list pass against a component that never asked for one.
    fetchProjectRules: (slug: string, testSlug: string | null = null) =>
      fetchProjectRules(slug, testSlug),
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

const TEST = {
  id: '33333333-3333-4333-8333-333333333333',
  slug: 'payments-sweep',
  name: 'Payments sweep',
  simulationClass: 'shop.PaymentsSimulation',
  description: null,
  createdAt: '2026-08-22T10:00:00.000Z',
  updatedAt: '2026-08-22T10:00:00.000Z',
  runCount: 3,
  latestRun: null,
};

/** `props` is empty for project mode and carries the test for test mode — the
 *  two surfaces this one component serves. */
function renderRules(props: { testSlug?: string; testName?: string } = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ProjectRules slug="checkout" {...props} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchProjectRules.mockResolvedValue({ rules: [] });
  fetchProjectTests.mockResolvedValue({ tests: [TEST] });
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
      // PROJECT-WIDE unless a test is chosen, which is what every rule was
      // before rules could be scoped to a test at all. Asserted explicitly,
      // and as `null` rather than by omission: `undefined` and `null` both
      // reach the server as project-wide, so an assertion that merely allowed
      // the field to be absent would pass against a form that had silently
      // stopped sending it.
      testSlug: null,
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

/**
 * ═══ WHAT A RULE APPLIES TO, WHICH IS NOT WHAT IT MEASURES ═══
 *
 * `scope` (run/scenario/group/request) is the metric target and has its own
 * select. This is a different axis — which TEST the rule judges — and the two
 * are never both called a scope, in the UI or in the code, because a reader
 * who conflates them gates the wrong thing while reading their own
 * configuration as correct.
 */
describe('ProjectRules — what a rule applies to', () => {
  it('offers every test in the project, defaulting to all of them', async () => {
    renderRules();
    const select = await screen.findByLabelText(/applies to/i);
    // The default is the empty-valued option, which the submit case above
    // pins as `testSlug: null` on the wire.
    expect(select).toHaveValue('');
    expect(await screen.findByRole('option', { name: 'Every test in this project' })).toBeTruthy();
    expect(await screen.findByRole('option', { name: 'Payments sweep' })).toBeTruthy();
  });

  it('sends the chosen test’s slug, not its name or its id', async () => {
    const user = userEvent.setup();
    renderRules();

    // The option list arrives with `GET /v1/projects/:slug/tests`, so waiting
    // for the SELECT alone is not enough — it renders immediately with only
    // the project-wide option in it, and `selectOptions` would fail with
    // "value not found" for a reason that is about timing rather than the
    // component.
    await screen.findByRole('option', { name: 'Payments sweep' });
    await user.selectOptions(screen.getByLabelText(/applies to/i), 'payments-sweep');
    await user.click(screen.getByRole('button', { name: 'Add rule' }));

    await waitFor(() => expect(createProjectRule).toHaveBeenCalledTimes(1));
    expect(createProjectRule.mock.calls[0]?.[1]).toMatchObject({ testSlug: 'payments-sweep' });
  });

  it('names the test each rule judges, and says so plainly for a project-wide one', async () => {
    fetchProjectRules.mockResolvedValue({
      rules: [
        rule({ id: '11111111-1111-4111-8111-111111111111', test: null }),
        rule({
          id: '22222222-2222-4222-8222-222222222222',
          test: { id: TEST.id, slug: TEST.slug, name: TEST.name },
        }),
      ],
    });
    renderRules();

    const cells = await screen.findAllByTestId('rule-applies-to');
    expect(cells.map((c) => c.textContent)).toEqual(['Every test', 'Payments sweep']);
  });

  /**
   * `test` is nullable AND optional on the wire — null is a genuine
   * project-wide rule, undefined is a body from an API pod that predates the
   * field. A reader can act on neither difference, so both must render as
   * "every test" rather than one of them rendering blank.
   */
  it('reads a rule from an older API pod as project-wide, not as blank', async () => {
    // `delete` rather than a rest destructure — this repo's lint forbids an
    // unused binding even when its only purpose is to be discarded.
    const withoutTest: Record<string, unknown> = { ...rule() };
    delete withoutTest.test;
    fetchProjectRules.mockResolvedValue({ rules: [withoutTest] });
    renderRules();
    expect(await screen.findByTestId('rule-applies-to')).toHaveTextContent('Every test');
  });
});

describe('ProjectRules — on a test’s page', () => {
  it('asks for the rules that judge THIS test, not for the project’s whole list', async () => {
    renderRules({ testSlug: 'payments-sweep', testName: 'Payments sweep' });
    await waitFor(() => expect(fetchProjectRules).toHaveBeenCalled());
    expect(fetchProjectRules).toHaveBeenCalledWith('checkout', 'payments-sweep');
  });

  /**
   * ═══ NO SELECT HERE, AND THAT IS THE DESIGN ═══
   *
   * The page is titled after one test. A select whose one non-default option
   * silently widens the rule to every OTHER test is a mistake nothing on the
   * page would show afterwards, because a project-wide rule looks identical in
   * this list. Project-wide gates are authored on the project's setup page,
   * and the prose here says so.
   */
  it('fixes new rules to this test rather than offering to widen them', async () => {
    const user = userEvent.setup();
    renderRules({ testSlug: 'payments-sweep', testName: 'Payments sweep' });

    await screen.findByRole('button', { name: 'Add rule' });
    expect(screen.queryByLabelText(/applies to/i)).toBeNull();
    expect(screen.getByText(/setup page/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Add rule' }));
    await waitFor(() => expect(createProjectRule).toHaveBeenCalledTimes(1));
    expect(createProjectRule.mock.calls[0]?.[1]).toMatchObject({ testSlug: 'payments-sweep' });
  });

  /**
   * ═══ THE LIVE CAVEAT, WHERE THE RULE IS AUTHORED ═══
   *
   * `run.test_id` is resolved from the parsed log header, so it is null for a
   * whole live stream — a test-scoped rule cannot be evaluated in the live SLA
   * banner and judges the finished report instead. A reader who watched a live
   * run and saw their new gate missing would reasonably conclude it was
   * broken, so the form says it before they find out.
   */
  it('warns that a test rule is not evaluated live', async () => {
    renderRules({ testSlug: 'payments-sweep', testName: 'Payments sweep' });
    expect(await screen.findByText(/do not appear in a run’s live banner/i)).toBeInTheDocument();
  });

  /**
   * On this page every row already judges this test, so naming it on each one
   * would be a column of the same word. What a reader needs is which rows the
   * PROJECT applies to everything and which are this test's own.
   */
  it('distinguishes an inherited project-wide rule from this test’s own', async () => {
    fetchProjectRules.mockResolvedValue({
      rules: [
        rule({ id: '11111111-1111-4111-8111-111111111111', test: null }),
        rule({
          id: '22222222-2222-4222-8222-222222222222',
          test: { id: TEST.id, slug: TEST.slug, name: TEST.name },
        }),
      ],
    });
    renderRules({ testSlug: 'payments-sweep', testName: 'Payments sweep' });

    const cells = await screen.findAllByTestId('rule-applies-to');
    expect(cells.map((c) => c.textContent)).toEqual(['Every test (project-wide)', 'This test']);
  });
});
