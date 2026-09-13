// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
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

/**
 * ═══ THE TARGET PICKER READS TWO ENDPOINTS, AND LEAVING THEM UNMOCKED TESTS
 * THE FALLBACK ═══
 *
 * Review M17 turned the free-text target into a picker over the names a run
 * actually recorded: the newest COMPLETE run in scope, then its statistics
 * rows. When either read fails the field degrades to the typed input it
 * replaced — which is correct, and is also exactly what an unmocked suite
 * would exercise while the picker went untested. Same trap the launch form's
 * test picker hit one branch earlier, so both are mocked here and the degraded
 * path gets a case of its own that asks for it.
 */
const fetchRuns = vi.fn(async () => ({
  items: [{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }],
  nextCursor: null,
}));
vi.mock('../src/api/runs.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api/runs.js')>();
  return { ...actual, fetchRuns: () => fetchRuns() };
});

const fetchStats = vi.fn(async () => ({
  runId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  stats: [
    { scope: 'run', name: '', family: 'response_time' },
    { scope: 'request', name: 'Search', family: 'response_time' },
    { scope: 'request', name: 'Add to cart', family: 'response_time' },
    { scope: 'group', name: 'Checkout', family: 'group_cumulated' },
  ],
}));
vi.mock('../src/api/metrics.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api/metrics.js')>();
  return {
    ...actual,
    statsQuery: (id: string) => ({ queryKey: ['run', id, 'stats'], queryFn: () => fetchStats() }),
  };
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

    // "Target", not "Target name" — review M17 turned the free-text box into a
    // picker over the names a run actually recorded, and the label lost the
    // word that implied typing was the only option.
    expect(screen.queryByLabelText(/^target/i)).toBeNull();
    await user.selectOptions(await screen.findByLabelText(/scope/i), 'request');
    expect(screen.getByLabelText(/^target/i)).toBeInTheDocument();
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
    // ONE PERCENT, typed as a percentage (review M17) — and stored as the
    // fraction the evaluator compares against. The author no longer converts.
    await user.type(threshold, '1');
    await user.click(screen.getByRole('button', { name: 'Add rule' }));

    await waitFor(() => expect(createProjectRule).toHaveBeenCalledTimes(1));
    expect(createProjectRule.mock.calls[0]?.[1]).toMatchObject({
      metric: 'error_rate',
      family: 'response_time',
      threshold: 0.01,
    });
  });

  /**
   * REVIEW C09 — AN EMPTY THRESHOLD IS NOT ZERO.
   *
   * `Number('')` and `Number('   ')` are both `0`, and `0` is a legal
   * threshold, so a blank field submitted a real gate of `<= 0` rather than
   * failing validation. The schema could never catch it: by the time it sees
   * the value, absence and a deliberate zero are the same number.
   *
   * That gate is not inert. `p95 <= 0` breaches on every run that records a
   * single request, so a blank field silently fails every future run of
   * whatever it judges.
   */
  it('refuses a blank threshold rather than reading it as zero', async () => {
    const user = userEvent.setup();
    renderRules();

    const threshold = await screen.findByLabelText(/threshold/i);
    await user.clear(threshold);
    await user.click(screen.getByRole('button', { name: 'Add rule' }));

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(createProjectRule).not.toHaveBeenCalled();
  });

  it('refuses a whitespace-only threshold too', async () => {
    const user = userEvent.setup();
    renderRules();

    const threshold = await screen.findByLabelText(/threshold/i);
    await user.clear(threshold);
    await user.type(threshold, '   ');
    await user.click(screen.getByRole('button', { name: 'Add rule' }));

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(createProjectRule).not.toHaveBeenCalled();
  });

  /** A zero somebody deliberately typed is still a valid gate, and the fix
   *  for the two cases above must not take it away. */
  it('keeps an explicitly typed zero, which is a legal gate', async () => {
    const user = userEvent.setup();
    renderRules();

    const metric = await screen.findByLabelText(/metric/i);
    await user.clear(metric);
    await user.type(metric, 'error_rate');
    const threshold = screen.getByLabelText(/threshold/i);
    await user.clear(threshold);
    await user.type(threshold, '0');
    await user.click(screen.getByRole('button', { name: 'Add rule' }));

    await waitFor(() => expect(createProjectRule).toHaveBeenCalledTimes(1));
    expect(createProjectRule.mock.calls[0]?.[1]).toMatchObject({ threshold: 0 });
  });

  /**
   * THE UNIT TRAP, AND WHY A LABEL RATHER THAN A PLACEHOLDER.
   *
   * `error_rate` is a fraction — `koCount / count` — while the stat tiles, the
   * statistics table and the errors tab all render that same number as a
   * percentage. An author who types `1` for "one percent" gets `≤ 100%`: a
   * rule that is valid, resolves, evaluates, and reports PASSED on every run
   * forever. Nothing fails, so nothing tells them.
   *
   * Caught by doing exactly that while demonstrating the feature, which is the
   * only way it surfaces — no test could have failed on it, because the gate
   * behaved correctly for the value it was given.
   */
  it('names the unit in the threshold label, and follows the metric', async () => {
    const user = userEvent.setup();
    renderRules();

    // The default metric is a percentile, which is milliseconds.
    expect(await screen.findByLabelText(/threshold \(ms\)/i)).toBeInTheDocument();

    const metric = await screen.findByLabelText(/metric/i);
    await user.clear(metric);
    await user.type(metric, 'error_rate');

    // Asserting the label CHANGED is the point: a static "(ms)" would be
    // worse than no unit, since it would state the wrong one with authority.
    //
    // `%` RATHER THAN `fraction` SINCE M17: the field takes the unit every
    // other surface renders, and `percentToFraction` stores what the evaluator
    // compares. The author is no longer the one place that converts.
    expect(await screen.findByLabelText(/threshold \(%\)/i)).toBeInTheDocument();
  });

  /**
   * THE WARNING MOVED WITH THE UNIT (review M17).
   *
   * It used to catch a FRACTION above 1 — the "typed 1, meant 1%" case, which
   * the field's own unit now prevents outright. What is still worth catching
   * is a PERCENTAGE above 100: an error rate cannot exceed 1, so ≤ 150% is a
   * gate no run can breach, exactly as ≤ 100% was.
   */
  it('warns when a percentage is a gate no run could breach', async () => {
    const user = userEvent.setup();
    renderRules();

    const metric = await screen.findByLabelText(/metric/i);
    await user.clear(metric);
    await user.type(metric, 'error_rate');
    const threshold = screen.getByLabelText(/threshold/i);
    await user.clear(threshold);
    await user.type(threshold, '150');

    const warning = await screen.findByRole('status');
    expect(warning).toHaveTextContent('cannot exceed 100%');
  });

  /** One percent is now an ordinary value, not a trap — the case the old
   *  warning fired on is the case this field is designed for. */
  it('stays quiet for a perfectly ordinary one percent', async () => {
    const user = userEvent.setup();
    renderRules();

    const metric = await screen.findByLabelText(/metric/i);
    await user.clear(metric);
    await user.type(metric, 'error_rate');
    const threshold = screen.getByLabelText(/threshold/i);
    await user.clear(threshold);
    await user.type(threshold, '1');

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('stays quiet for an ordinary millisecond threshold', async () => {
    const user = userEvent.setup();
    renderRules();

    const threshold = await screen.findByLabelText(/threshold/i);
    await user.clear(threshold);
    await user.type(threshold, '30000');

    // 30s is a perfectly reasonable p95 bound. A warning here would train the
    // reader to ignore the one that matters.
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});

describe('ProjectRules — the table', () => {
  it('describes a rule the way the run page and the evaluator do', async () => {
    fetchProjectRules.mockResolvedValue({ rules: [rule()] });
    renderRules();
    // `describeAssertionRule`'s own typeset comparator, so a rule reads
    // identically here and on the run it judged.
    //
    // WITH ITS UNIT SINCE M17. A bare "≤ 800" left the reader to know that a
    // percentile is milliseconds while `error_rate` is a fraction — and the
    // fraction is the one that produced a permanently-passing gate.
    // `formatSlaThreshold` is the single place that decision lives, so this
    // string and the run page's evidence panel cannot drift.
    expect(
      await screen.findByText('p95 of the run (response_time) ≤ 800 ms'),
    ).toBeInTheDocument();
  });

  /** The metric that motivated the whole change: stored as a fraction,
   *  rendered as the percentage every other surface shows. */
  it('renders an error-rate gate as the percentage the tiles show', async () => {
    fetchProjectRules.mockResolvedValue({
      rules: [rule({ metric: 'error_rate', threshold: 0.01 })],
    });
    renderRules();
    expect(
      await screen.findByText('error_rate of the run (response_time) ≤ 1%'),
    ).toBeInTheDocument();
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
   * ═══ NO LIVE CAVEAT, BECAUSE THERE IS NO LONGER A GAP ═══
   *
   * This case is the inverse of the one it replaces. A test-scoped rule USED
   * TO be invisible in a run's live banner: `run.test_id` was resolved only by
   * the pipeline at finalize, so a streaming run belonged to no test and
   * matched no test rule, and this panel warned the author about it.
   *
   * `LiveFoldOwner` now resolves the test from the log header the decoder
   * reads within the first few hundred bytes, so the warning became false. A
   * false caveat is worse than none — it tells a reader their working gate
   * does not work — and stale prose is exactly the kind of thing that survives
   * a behaviour change unnoticed, so the absence is asserted rather than left
   * to review.
   *
   * The paired positive comes first: the panel really did render, so the
   * absence below is about this sentence and not about an empty card.
   */
  it('no longer warns about a live gap that has since been closed', async () => {
    renderRules({ testSlug: 'payments-sweep', testName: 'Payments sweep' });
    expect(await screen.findByText(/applies to/i)).toBeInTheDocument();
    expect(screen.queryByText(/live banner/i)).toBeNull();
    expect(screen.queryByText(/finished report/i)).toBeNull();
  });

  /**
   * On this page every row already judges this test, so naming it on each one
   * would be a column of the same word. What a reader needs is which rows the
   * PROJECT applies to everything and which are this test's own.
   */
  /**
   * ═══ TWO TABLES, NOT ONE COLUMN (review M17) ═══
   *
   * This used to assert an "Applies to" cell reading "Every test
   * (project-wide)" beside one reading "This test" — the whole distinction
   * carried by words in a column, on rows that looked identical otherwise.
   *
   * They are separate tables now, and the reason is that the rows are not
   * equally safe to act on: deleting an inherited rule changes every OTHER
   * test in the project, and a row indistinguishable from the one above it
   * does not carry that warning. Inside each table the column would be the
   * same word on every row, so it goes — the same argument `RunList` makes for
   * dropping the Project column on a project's own list.
   */
  it('separates inherited project rules from this test’s own, and warns about the difference', async () => {
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

    const own = await screen.findByRole('region', { name: 'Test SLA rules' });
    const inherited = screen.getByRole('region', { name: 'Inherited SLA rules' });
    expect(within(own).getAllByRole('row')).toHaveLength(2); // header + one rule
    expect(within(inherited).getAllByRole('row')).toHaveLength(2);

    // The column is gone from both, because within a group it says nothing.
    expect(screen.queryByTestId('rule-applies-to')).toBeNull();

    // And the consequence of deleting an inherited rule is stated where the
    // inherited rules are, not left to the reader to infer.
    expect(inherited.textContent ?? '').toMatch(/every other test in the project/i);
  });

  /** On the PROJECT's own page there is one table and the column is back,
   *  because there it genuinely varies from row to row. */
  it('keeps the applies-to column on the project’s own list', async () => {
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
    expect(cells.map((c) => c.textContent)).toEqual(['Every test', TEST.name]);
  });
});

/* ======================================================================== *
 * REVIEW M17 — THE FORM STOPS REQUIRING INTERNAL VOCABULARY
 * ======================================================================== */

describe('ProjectRules — the target is picked, not remembered', () => {
  /**
   * A typo cannot be refused here and never could: a target no run has
   * reported YET is legal and useful, because a rule may be written before the
   * endpoint it guards exists. So validation is not available and only the
   * control can help — the same shape as the launch form's test picker.
   */
  it('offers the names the newest completed run recorded, for the chosen scope', async () => {
    const user = userEvent.setup();
    renderRules();

    await user.selectOptions(await screen.findByLabelText(/scope/i), 'request');
    const target = await screen.findByRole('combobox', { name: /^target/i });

    // REQUEST names only. A group name in a request rule matches nothing, and
    // offering one would be the picker recreating the typo it exists to stop.
    const options = within(target).getAllByRole('option').map((o) => o.textContent);
    expect(options).toContain('Search');
    expect(options).toContain('Add to cart');
    expect(options).not.toContain('Checkout');
  });

  it('follows the scope — a group rule is offered group names', async () => {
    const user = userEvent.setup();
    renderRules();

    await user.selectOptions(await screen.findByLabelText(/scope/i), 'group');
    const target = await screen.findByRole('combobox', { name: /^target/i });
    const options = within(target).getAllByRole('option').map((o) => o.textContent);
    expect(options).toContain('Checkout');
    expect(options).not.toContain('Search');
  });

  /** THE ESCAPE HATCH IS THE HALF THAT KEEPS THE FEATURE HONEST. A closed list
   *  would refuse a rule written ahead of the endpoint it guards. */
  it('keeps a typed target available behind an explicit choice', async () => {
    const user = userEvent.setup();
    renderRules();

    await user.selectOptions(await screen.findByLabelText(/scope/i), 'request');
    await user.selectOptions(screen.getByRole('combobox', { name: /^target/i }), '__custom__');

    const typed = await screen.findByRole('textbox', { name: /^target/i });
    await user.type(typed, 'GET /not-built-yet');
    expect((typed as HTMLInputElement).value).toBe('GET /not-built-yet');
  });

  it('degrades to a typed field, saying why, when the names cannot be read', async () => {
    fetchRuns.mockRejectedValueOnce(new Error('runs unavailable'));
    const user = userEvent.setup();
    renderRules();

    await user.selectOptions(await screen.findByLabelText(/scope/i), 'request');
    const typed = await screen.findByRole('textbox', { name: /^target/i });
    expect(typed).toBeInTheDocument();
    // `getByLabelText` returns the CONTROL, whose textContent is empty — the
    // sentence lives in the label's hint beside it.
    expect(screen.getByText(/could not be loaded/i)).toBeInTheDocument();
  });
});

describe('ProjectRules — the rule reads back as a sentence', () => {
  /**
   * Seven controls, none of which states what was built. The two that go wrong
   * in silence are a misjudged unit and a comparator pointing the wrong way —
   * `throughput at most 50/s` is a legal gate that fails a run for being fast.
   * A sentence is the only rendering in which both are obvious.
   */
  it('says what the rule gates, in the unit the rest of the product shows', async () => {
    const user = userEvent.setup();
    renderRules();

    await user.selectOptions(await screen.findByLabelText(/scope/i), 'request');
    await user.selectOptions(screen.getByRole('combobox', { name: /^target/i }), 'Search');
    await user.clear(screen.getByLabelText(/metric/i));
    await user.type(screen.getByLabelText(/metric/i), 'p95');
    // CLEARED first: the form opens with a default threshold, and typing
    // appends — "800" over "800" is "800800", which is how this case failed
    // the first time it ran.
    await user.clear(screen.getByLabelText(/threshold/i));
    await user.type(screen.getByLabelText(/threshold/i), '800');

    expect(screen.getByTestId('rule-preview').textContent ?? '').toContain(
      'Request “Search”: 95th percentile response time must be at most 800 ms.',
    );
  });

  /**
   * THE PREVIEW SHOWS WHAT WILL BE SENT, NOT WHAT WAS TYPED. The form takes a
   * PERCENTAGE for a fraction metric and stores a fraction; a preview built
   * off the raw input would agree with the box above it and disagree with the
   * row it is about to create, which is the one way a preview is worse than
   * none.
   */
  it('converts a percentage the way the submit does', async () => {
    const user = userEvent.setup();
    renderRules();

    await user.clear(await screen.findByLabelText(/metric/i));
    await user.type(screen.getByLabelText(/metric/i), 'error_rate');
    await user.clear(screen.getByLabelText(/threshold/i));
    await user.type(screen.getByLabelText(/threshold/i), '1');

    expect(screen.getByTestId('rule-preview').textContent ?? '').toContain(
      'The whole run: error rate must be at most 1%.',
    );
  });

  /** Nothing true to say yet, so it says nothing — and in particular it does
   *  NOT render a sentence for a metric the engine would refuse. */
  it('withholds the sentence for a metric that does not resolve, and says which field', async () => {
    const user = userEvent.setup();
    renderRules();

    await user.clear(await screen.findByLabelText(/metric/i));
    await user.type(screen.getByLabelText(/metric/i), 'p95th');
    await user.clear(screen.getByLabelText(/threshold/i));
    await user.type(screen.getByLabelText(/threshold/i), '800');

    // NAMES THE FIELD. "Fill in the metric and the threshold" was wrong for
    // the reader whose threshold was already fine — it listed everything and
    // so pointed at nothing.
    expect(screen.getByTestId('rule-preview').textContent ?? '').toMatch(/name a metric/i);
  });

  /**
   * ═══ THE PREVIEW PROMISED A RULE THE BUTTON WOULD NOT CREATE
   * (review 09-13 M07) ═══
   *
   * `describeSlaRule` renders "Every request: …" for a scoped rule with no
   * target. That is a fair reading of a STORED rule — and a false description
   * of this form, whose submit refuses that draft outright because the schema
   * requires a target for every scope but `run`.
   *
   * So the describer keeps the branch (the run page's evidence panel uses the
   * same function) and the FORM stops asking for it while the draft is
   * incomplete. Asserted as an absence AND a presence: the invented semantic
   * must be gone, and what is missing must be named.
   */
  it('does not preview a scoped rule that has no target yet', async () => {
    const user = userEvent.setup();
    renderRules();

    await user.selectOptions(await screen.findByLabelText(/scope/i), 'request');
    const preview = screen.getByTestId('rule-preview');

    expect(preview.textContent ?? '').not.toMatch(/every request/i);
    expect(preview.textContent ?? '').toMatch(/choose a request to preview/i);
  });

  /** And it appears the moment the draft is complete — without which the case
   *  above would pass against a preview that never renders at all. */
  it('previews it as soon as a target is chosen', async () => {
    const user = userEvent.setup();
    renderRules();

    await user.selectOptions(await screen.findByLabelText(/scope/i), 'request');
    await user.selectOptions(
      await screen.findByRole('combobox', { name: /^target/i }),
      'Search',
    );

    expect(screen.getByTestId('rule-preview').textContent ?? '').toMatch(/Request “Search”/);
  });

  /**
   * ═══ ONE STATEMENT ABOUT WHEN A RULE STARTS JUDGING (review 09-13 M06) ═══
   *
   * The form carried two, ~190 lines apart: "Every rule here applies to a live
   * run as soon as its log header names the simulation" and "a run streaming
   * right now keeps the rules it started under". Both describe real mechanisms
   * — `#identify` widening the set, and `FoldState.rules` loading once — and
   * read together they contradict each other about the one question an author
   * asks after saving.
   *
   * The Applies-to hint now says only what is true of it alone: which runs a
   * test's rules judge. The lifecycle is stated once, beside the button.
   */
  it('makes exactly one claim about when a new rule takes effect', async () => {
    renderRules();
    await screen.findByLabelText(/applies to/i);

    const lifecycle = screen.getAllByText(/judges runs finished after it is added/i);
    expect(lifecycle).toHaveLength(1);

    // And the contradicting half is gone: nothing else promises a live run
    // picks up a rule created while it streams.
    expect(document.body.textContent ?? '').not.toMatch(
      /every rule here applies to a live run/i,
    );
  });

  /** And it says when the rule starts judging, which is the question an author
   *  asks straight after "did that save". */
  it('states when a new rule takes effect', async () => {
    renderRules();
    expect((await screen.findByTestId('rule-preview')).textContent ?? '').toMatch(
      /judges runs finished after it is added/i,
    );
  });
});

describe('ProjectRules — validation names the field, not the schema', () => {
  /**
   * The message was `${issue.path.join('.')}: ${issue.message}`, so a reader
   * met `targetName: Required` — a Zod property name, which is the data model
   * leaking into the one place somebody is being asked to fix something.
   */
  it('refuses a targetless request rule by its label and says what to do', async () => {
    const user = userEvent.setup();
    renderRules();

    await user.selectOptions(await screen.findByLabelText(/scope/i), 'request');
    await user.click(screen.getByRole('button', { name: 'Add rule' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent ?? '').toMatch(/^Target:/);
    expect(alert.textContent ?? '').toMatch(/set the scope to Whole run/i);
    // The schema path itself never appears.
    expect(alert.textContent ?? '').not.toContain('targetName');
  });

  it('names the threshold field, and still refuses an empty box as not-zero', async () => {
    const user = userEvent.setup();
    renderRules();

    // The form opens with a default threshold; emptying it is the state this
    // case is about, and `Number('')` being 0 is why the check cannot live in
    // the schema.
    await user.clear(await screen.findByLabelText(/threshold/i));
    await user.click(screen.getByRole('button', { name: 'Add rule' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent ?? '').toMatch(/^Threshold:/);
    expect(alert.textContent ?? '').toMatch(/not zero/i);
    expect(createProjectRule).not.toHaveBeenCalled();
  });
});
