// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SlaRule } from '@perfportal/contracts';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Where the families a rule can resolve against are actually produced.
 *
 * RESOLVED FROM `process.cwd()`, NOT `import.meta.url`, AND THAT IS A
 * PROPERTY OF THIS FILE'S EXTENSION. `paths.test.ts` and `tokens.test.ts`
 * both read source with `fileURLToPath(new URL(…, import.meta.url))` and both
 * are `.ts`, so they run in the vitest `node` project. This file is a `.tsx`
 * and runs in the `jsdom` one, where `import.meta.url` is NOT a `file:` URL —
 * the same call throws `TypeError: The URL must be of scheme file`, and
 * vitest reports it as `Tests no tests` rather than as a failing assertion.
 * `process.cwd()` is the workspace root under both projects.
 */
const ENGINE_DIR = join(process.cwd(), 'packages/statistics/src');

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

    const metric = await screen.findByLabelText(/statistic/i);
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

    const metric = await screen.findByLabelText(/statistic/i);
    await user.clear(metric);
    await user.type(metric, 'error_rate');
    const threshold = screen.getByLabelText(/limit/i);
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

    const threshold = await screen.findByLabelText(/limit/i);
    await user.clear(threshold);
    await user.click(screen.getByRole('button', { name: 'Add rule' }));

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(createProjectRule).not.toHaveBeenCalled();
  });

  it('refuses a whitespace-only threshold too', async () => {
    const user = userEvent.setup();
    renderRules();

    const threshold = await screen.findByLabelText(/limit/i);
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

    const metric = await screen.findByLabelText(/statistic/i);
    await user.clear(metric);
    await user.type(metric, 'error_rate');
    const threshold = screen.getByLabelText(/limit/i);
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
    expect(await screen.findByLabelText(/limit \(ms\)/i)).toBeInTheDocument();

    const metric = await screen.findByLabelText(/statistic/i);
    await user.clear(metric);
    await user.type(metric, 'error_rate');

    // Asserting the label CHANGED is the point: a static "(ms)" would be
    // worse than no unit, since it would state the wrong one with authority.
    //
    // `%` RATHER THAN `fraction` SINCE M17: the field takes the unit every
    // other surface renders, and `percentToFraction` stores what the evaluator
    // compares. The author is no longer the one place that converts.
    expect(await screen.findByLabelText(/limit \(%\)/i)).toBeInTheDocument();
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

    const metric = await screen.findByLabelText(/statistic/i);
    await user.clear(metric);
    await user.type(metric, 'error_rate');
    const threshold = screen.getByLabelText(/limit/i);
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

    const metric = await screen.findByLabelText(/statistic/i);
    await user.clear(metric);
    await user.type(metric, 'error_rate');
    const threshold = screen.getByLabelText(/limit/i);
    await user.clear(threshold);
    await user.type(threshold, '1');

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('stays quiet for an ordinary millisecond threshold', async () => {
    const user = userEvent.setup();
    renderRules();

    const threshold = await screen.findByLabelText(/limit/i);
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
    // `describeAssertionRuleForReader`'s typeset comparator, so a rule reads
    // identically here and on the run it judged.
    //
    // WITH ITS UNIT SINCE M17. A bare "≤ 800" left the reader to know that a
    // percentile is milliseconds while `error_rate` is a fraction — and the
    // fraction is the one that produced a permanently-passing gate.
    // `formatSlaValue` is the single place that decision lives, so this string
    // and the run page's evidence panel cannot drift.
    //
    // AND THE MEASUREMENT IS IN WORDS SINCE the second review's finding 3.
    // This asserted `p95 of the run (response_time) ≤ 800 ms` — the stored
    // schema read aloud, with a parenthesis that says nothing to the reader of
    // a percentile rule and something FALSE beside an error rate. The precise
    // form still exists and still writes the CSV.
    // AND IT IS TWO CELLS SINCE finding 15, not one sentence: the table is
    // scanned against other rules rather than read once, so WHAT is measured
    // and the BOUND are separate columns. The claim is unchanged — both still
    // come from the contract's own describers, so this row and the run page's
    // evidence panel cannot drift.
    expect(await screen.findByText('Whole-run p95 response time')).toBeInTheDocument();
    expect(screen.getByText('≤ 800 ms')).toBeInTheDocument();
  });

  /** The metric that motivated the whole change: stored as a fraction,
   *  rendered as the percentage every other surface shows. */
  it('renders an error-rate gate as the percentage the tiles show', async () => {
    fetchProjectRules.mockResolvedValue({
      rules: [rule({ metric: 'error_rate', threshold: 0.01 })],
    });
    renderRules();
    // `(response_time)` is gone rather than merely reworded: an error rate is
    // not a response-time statistic, which is the half of finding 3 that is a
    // correctness point rather than a readability one.
    expect(await screen.findByText('Whole-run error rate')).toBeInTheDocument();
    // The percentage, in its own column since finding 15.
    expect(screen.getByText('≤ 1%')).toBeInTheDocument();
  });

  /**
   * ═══ COLUMNS ARE SCANNED, SENTENCES ARE READ (review.md 15) ═══
   *
   * The bound was "written as a long technical sentence" in one monospace
   * cell, so comparing six rules meant reading six sentences and diffing them
   * by eye.
   *
   * ASSERTED ON THE CELLS, not on both strings being present — a single cell
   * still containing `Whole-run p95 response time ≤ 800 ms` satisfies any
   * assertion that merely finds both substrings, which is the before-state
   * exactly.
   */
  it('splits what a rule measures from the bound it sets, into separate columns', async () => {
    fetchProjectRules.mockResolvedValue({ rules: [rule()] });
    renderRules();

    const measurement = (await screen.findByText('Whole-run p95 response time')).closest('td');
    const limit = screen.getByText('≤ 800 ms').closest('td');
    expect(measurement).not.toBeNull();
    expect(measurement).not.toBe(limit);
    expect(measurement).not.toHaveTextContent('≤');
    // Named columns, so this is navigable structure rather than two adjacent
    // strings that happen to sit apart.
    expect(screen.getByRole('columnheader', { name: 'Measurement' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Limit' })).toBeInTheDocument();
  });

  /**
   * ═══ THE FREQUENT CONTROL STAYS, THE DESTRUCTIVE ONE MOVES ═══
   *
   * "Every populated rule row ends with Disable and Delete. The primary
   * surface emphasizes management actions." Enabling is the ordinary
   * maintenance a reader comes here to do; deleting is rare and cannot be
   * undone, and giving them equal weight in every row is what made this read
   * as a list of management actions rather than a list of rules.
   *
   * Both halves, because either alone passes against the wrong table: a row
   * with no visible controls at all satisfies the absence, and one that kept
   * both buttons satisfies the presence.
   */
  it('keeps the enable control in the row and files delete behind a menu', async () => {
    const user = userEvent.setup();
    fetchProjectRules.mockResolvedValue({ rules: [rule()] });
    renderRules();

    expect(await screen.findByRole('button', { name: 'Disable' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^delete/i })).toBeNull();

    await user.click(screen.getByRole('button', { name: /more actions/ }));
    expect(await screen.findByRole('menuitem', { name: 'Delete this rule' })).toBeInTheDocument();
  });

  /**
   * ═══ THE FORM ASKS IN THE ORDER THE READER DECIDES (review.md 13) ═══
   *
   * The finding sets out four steps — Applies to, Measure, Limit, then one
   * readable preview with the optional name and Save — and the fields were in
   * none of them: `Name` sat SECOND, between the test scoping and the
   * measurement, so an author met an optional field before either decision
   * that actually makes a rule.
   *
   * `<fieldset>`/`<legend>` is what carries the grouping to a screen reader —
   * an implicit `group` role named by its legend — which is the device
   * `NewRunnerRun` already uses. NOT NUMBERED: M11 stripped the ordinals there
   * because "1 ·" promises a flow that gates step 2 behind step 1, and this
   * form submits in one go exactly as that one does.
   *
   * The name's POSITION is asserted rather than its presence, because the
   * field never went anywhere — moving it is the whole change, and a test for
   * its existence would have passed before and after.
   */
  it('groups the form into the named steps the finding sets out', async () => {
    fetchProjectRules.mockResolvedValue({ rules: [] });
    renderRules();

    expect(await screen.findByRole('group', { name: 'Measure' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Limit' })).toBeInTheDocument();
  });

  /**
   * ITS OWN CASE, not folded into the one above. Both claims were asserted
   * together at first, and both mutations — stripping a legend, and moving the
   * name back to the top — then failed that one case, which proves one thing
   * twice. The same correction #172 needed, one file over.
   */
  it('leaves the optional name until the preview has stated the rule', async () => {
    fetchProjectRules.mockResolvedValue({ rules: [] });
    renderRules();

    // After the preview — which is the moment an author knows what they would
    // call this rule, because the sentence stating it is on screen.
    const preview = await screen.findByTestId('rule-preview');
    const named = screen.getByLabelText(/name \(optional\)/i);
    expect(preview.compareDocumentPosition(named) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('falls back to a dash for a rule nobody named', async () => {
    fetchProjectRules.mockResolvedValue({ rules: [rule({ name: null })] });
    renderRules();
    expect(await screen.findByText('—')).toBeInTheDocument();
  });

  /**
   * ═══ `Status` IS RESERVED, AND THIS COLUMN HAD BORROWED IT ═══
   *
   * Review N01's rule: `Status` is this product's word for a RUN's execution
   * state — the run list gives it a column (Project, Simulation, Status,
   * Verdict) and the status filter its vocabulary. That branch renamed the
   * simulation assertions table's `Status` to `Outcome` on exactly that
   * ground, and this table was the caller the rename did not reach.
   *
   * ASSERTED AS AN EXCLUSIVE PAIR. "Has an Enabled column" alone passes
   * against a table that grew one and kept `Status` beside it, which is the
   * drift rather than the fix; "has no Status column" alone passes against a
   * table whose header row failed to render at all. Neither half is worth
   * having without the other — the shape the token-mint-copy branch used for
   * its own retired jargon.
   */
  it('heads the enabled column Enabled, never Status', async () => {
    fetchProjectRules.mockResolvedValue({ rules: [rule()] });
    renderRules();
    await screen.findByText('Every test');

    const headers = screen
      .getAllByRole('columnheader')
      .map((th) => (th.textContent ?? '').trim());
    expect(headers).toContain('Enabled');
    expect(headers).not.toContain('Status');
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

    // THROUGH THE ROW MENU since finding 15 — "move less frequent destructive
    // actions into a row menu". The CONFIRMATION below is unchanged, which is
    // the point: this moved the trigger, not the safeguard.
    await user.click(await screen.findByRole('button', { name: /more actions/ }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete this rule' }));
    expect(deleteProjectRule).not.toHaveBeenCalled();
    expect(screen.getByText(/permanent/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Confirm delete' }));
    await waitFor(() => expect(deleteProjectRule).toHaveBeenCalledTimes(1));
  });

  /**
   * ═══ ONE PRIMARY ACTION PER TASK, INCLUDING WHILE ARMED (review.md 20) ═══
   *
   * `Button`'s own docstring states the rule — "exactly ONE `primary` per
   * screen" — and it was enforced by nothing, which is how THREE destructive
   * confirms came to wear it: revoke a token, delete a rule, delete a test.
   * Each sat beside its page's own primary, so the moment a reader armed a
   * confirmation the most prominent control on screen became the destructive
   * one.
   *
   * ASSERTED IN THE ARMED STATE, because that is the only state where the
   * second one exists — a count taken before the confirmation opens is one
   * either way and proves nothing.
   *
   * `.bg-accent` is the primary variant's own definition (`buttonVariants`),
   * which is the same kind of class-level assertion `tokens.test.ts` already
   * makes. A `variant` prop cannot be read off the DOM.
   */
  it('keeps one primary action on screen while a delete is armed', async () => {
    const user = userEvent.setup();
    fetchProjectRules.mockResolvedValue({ rules: [rule()] });
    const { container } = renderRules();

    await user.click(await screen.findByRole('button', { name: /more actions/ }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete this rule' }));
    // The confirmation really is open — otherwise the count below is the
    // unarmed one and the case asserts nothing.
    expect(screen.getByRole('button', { name: 'Confirm delete' })).toBeInTheDocument();

    const primaries = [...container.querySelectorAll('button.bg-accent')];
    expect(primaries).toHaveLength(1);
    // And it is the page's own action, not the destructive one.
    expect(primaries[0]).toHaveTextContent('Add rule');
  });

  it('lets the reader back out of an armed delete', async () => {
    const user = userEvent.setup();
    fetchProjectRules.mockResolvedValue({ rules: [rule()] });
    renderRules();

    // THROUGH THE ROW MENU since finding 15 — "move less frequent destructive
    // actions into a row menu". The CONFIRMATION below is unchanged, which is
    // the point: this moved the trigger, not the safeguard.
    await user.click(await screen.findByRole('button', { name: /more actions/ }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete this rule' }));
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

    // THROUGH THE ROW MENU since finding 15 — "move less frequent destructive
    // actions into a row menu". The CONFIRMATION below is unchanged, which is
    // the point: this moved the trigger, not the safeguard.
    await user.click(await screen.findByRole('button', { name: /more actions/ }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete this rule' }));
    await user.click(screen.getByRole('button', { name: 'Confirm delete' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/may still be active/i);
  });

  /**
   * ═══ THE CONSEQUENCE SURVIVES; THE CARD DOES NOT (review 09-13 M03) ═══
   *
   * This asserted a full `EmptyState` — heading and body — telling the reader
   * to "add one above", directly beneath the form for adding one. An empty
   * state earns its size when it explains an absence the reader cannot
   * otherwise account for; this one sat under the explanation AND the remedy,
   * both already on screen.
   *
   * What must not be lost is the CONSEQUENCE: a project with no rules gets no
   * verdict. That is the half a reader cannot infer from an empty table, so it
   * is the half the assertion keeps.
   */
  it('says what an empty project costs, without a card repeating the form above it', async () => {
    renderRules();
    expect(await screen.findByText(/no release verdict/i)).toBeInTheDocument();
    // Not a heading-and-body empty state any more.
    expect(screen.queryByRole('heading', { name: /no sla rules yet/i })).toBeNull();
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

  /**
   * NO SCOPE, AND NO MEASUREMENT, THE ENGINE NEVER PRODUCES.
   *
   * ═══ THE SECOND HALF WAS ADDED AFTER THIS GUARD MISSED ONE ═══
   *
   * The version below iterated `['run', 'scenario', 'request', 'group']` — it
   * checked which FAMILIES each scope offered and took the SCOPES themselves
   * on trust. `scenario` is a stat scope the contract declares and the engine
   * has never filed a row under: 52 `request` rows, 48 `group`, 9 `run` and
   * ZERO `scenario` across nine real runs, and through the real pipeline a
   * scenario-scoped p95 rule comes back `not_applicable` with "No
   * response_time statistics for Browse in this run".
   *
   * THAT IS THIS GUARD'S OWN ARGUMENT, ONE AXIS OVER. Its note already said
   * M09 "narrowed these lists by SCOPE and left `latency` on three of the
   * four ... one family further on" — and then hard-coded the four scopes.
   * Both axes are read off the rendered control now, so neither can be
   * trusted into the check.
   *
   * WORSE THAN `latency`, BECAUSE A NAME EXISTS TO TYPE. The users chart is
   * drawn per scenario, so the product shows a reader `Browse` and `Checkout`
   * and then accepts a rule naming one that can never fire.
   *
   * M09 narrowed these lists by SCOPE and left `latency` on three of the four,
   * so "Latency" authored a gate the evaluator reports `not_applicable` for on
   * every run, for ever — the silent-gate class M09's own comment describes,
   * one family further on. Measured through the product's real pipeline over
   * the reference `simulation.log`: the run produces `response_time`,
   * `group_cumulated` and `group_duration`, and a p95-latency rule came back
   * `not_applicable` with verdict `not_evaluated`.
   *
   * ASSERTED AS A JOIN, NOT AS A LIST. Pinning the four arrays verbatim would
   * pass the day somebody adds a fifth family the engine also never emits —
   * which is exactly how `latency` survived. This reads the OFFERED values off
   * the rendered control and requires each to appear as a family literal in
   * `packages/statistics/src`, so a new family joins the check by being
   * PRODUCED rather than by anybody remembering to extend a fixture.
   *
   * COMMENTS ARE STRIPPED before scanning, the trap this repo records four
   * times: the engine's own prose mentions latency repeatedly, and
   * `ProjectRules.tsx`'s new comment quotes the word while explaining why it
   * is gone. Either would exonerate a family that is only TALKED about.
   */
  it('offers no scope or measurement the statistics engine never files a row under', async () => {
    const engineSrc = readdirSync(ENGINE_DIR)
      .filter((f) => f.endsWith('.ts'))
      .map((f) => readFileSync(join(ENGINE_DIR, f), 'utf8'))
      .join('\n')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    // A collector that found nothing would make every assertion below vacuous.
    expect(engineSrc.length, 'no engine source collected').toBeGreaterThan(1000);

    const user = userEvent.setup();
    renderRules();

    /**
     * THE SCOPES ARE READ OFF THE CONTROL, not listed here — which is the
     * whole repair. A hard-coded list is a second opinion about what the form
     * offers, and it was wrong.
     */
    const scopeSelect = await screen.findByLabelText(/scope/i);
    const offeredScopes = within(scopeSelect)
      .getAllByRole('option')
      .map((o) => (o as HTMLOptionElement).value);
    expect(offeredScopes.length, 'no scopes offered').toBeGreaterThan(1);
    expect(offeredScopes, 'the whole-run scope is still offered').toContain('run');

    const offeredFamilies = new Set<string>();
    for (const scope of offeredScopes) {
      await user.selectOptions(scopeSelect, scope);
      const measurement = await screen.findByLabelText(/measurement/i);
      for (const o of within(measurement).getAllByRole('option')) {
        offeredFamilies.add((o as HTMLOptionElement).value);
      }
    }

    // Vacuity: a form that rendered no options at all would satisfy the
    // subset check perfectly.
    expect(offeredFamilies.size, 'no measurements offered').toBeGreaterThan(1);
    expect(offeredFamilies.has('response_time'), 'response_time is still offered').toBe(true);

    /**
     * THE QUOTED LITERAL IS LOAD-BEARING ON BOTH AXES, and this entry already
     * records measuring that for families: relaxed to a bare substring the
     * check passes against the before-state, because `export * from
     * './bucket-latency.js'` contains the word. `scenario` is the same trap
     * and worse — the engine groups the USERS series by scenario, so
     * `#userEvents`, `users.scenarios()` and a dozen field names contain it
     * while no `#rollupFor('scenario', ...)` call exists.
     */
    const produced = (v: string): boolean => engineSrc.includes(`'${v}'`);

    expect(
      offeredScopes.filter((v) => !produced(v)).sort(),
      'scopes the form offers that the engine never files a row under — ' +
        'a rule using one is not_applicable on every run, for ever',
    ).toEqual([]);

    expect(
      [...offeredFamilies].filter((v) => !produced(v)).sort(),
      'measurements the form offers that the engine never files a row under — ' +
        'a rule using one is not_applicable on every run, for ever',
    ).toEqual([]);
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
    await user.clear(screen.getByLabelText(/statistic/i));
    await user.type(screen.getByLabelText(/statistic/i), 'p95');
    // CLEARED first: the form opens with a default threshold, and typing
    // appends — "800" over "800" is "800800", which is how this case failed
    // the first time it ran.
    await user.clear(screen.getByLabelText(/limit/i));
    await user.type(screen.getByLabelText(/limit/i), '800');

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

    await user.clear(await screen.findByLabelText(/statistic/i));
    await user.type(screen.getByLabelText(/statistic/i), 'error_rate');
    await user.clear(screen.getByLabelText(/limit/i));
    await user.type(screen.getByLabelText(/limit/i), '1');

    expect(screen.getByTestId('rule-preview').textContent ?? '').toContain(
      'The whole run: error rate must be at most 1%.',
    );
  });

  /** Nothing true to say yet, so it says nothing — and in particular it does
   *  NOT render a sentence for a metric the engine would refuse. */
  it('withholds the sentence for a metric that does not resolve, and says which field', async () => {
    const user = userEvent.setup();
    renderRules();

    await user.clear(await screen.findByLabelText(/statistic/i));
    await user.type(screen.getByLabelText(/statistic/i), 'p95th');
    await user.clear(screen.getByLabelText(/limit/i));
    await user.type(screen.getByLabelText(/limit/i), '800');

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
    // The schema path itself never appears.
    expect(alert.textContent ?? '').not.toContain('targetName');
  });

  /**
   * ═══ REVIEW 09-13 M08 — THE SCHEMA'S SENTENCE DESCRIBES BOTH MISTAKES ═══
   *
   * `targetMatchesScope` refuses two opposite combinations with one message:
   * "a run-scoped rule takes no target name; a scenario, group or request rule
   * needs one". Correct for an API consumer, who can send either. Half of it
   * is unreachable from this FORM — a run rule renders no target field, so an
   * author cannot produce the first mistake — and being told the rule of
   * grammar rather than the missing word is the finding.
   *
   * The previous case asserted `set the scope to Whole run` was PRESENT; that
   * clause is what this one requires to be gone, which is why that assertion
   * moved here as a negative rather than simply being deleted.
   */
  it('names the missing request rather than restating both halves of the schema', async () => {
    const user = userEvent.setup();
    renderRules();

    await user.selectOptions(await screen.findByLabelText(/scope/i), 'request');
    await user.click(screen.getByRole('button', { name: 'Add rule' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent ?? '').toMatch(/name the request this rule judges/i);
    // The half about the OTHER mistake, which this form cannot make.
    expect(alert.textContent ?? '').not.toMatch(/set the scope to Whole run/i);
    expect(alert.textContent ?? '').not.toMatch(/run-scoped rule takes no target/i);
  });

  /** And it is the scope's own noun, not "request" hard-coded — a group rule
   *  asking for a request would send the author to the wrong list. */
  it('asks for the noun the chosen scope actually names', async () => {
    const user = userEvent.setup();
    renderRules();

    await user.selectOptions(await screen.findByLabelText(/scope/i), 'group');
    await user.click(screen.getByRole('button', { name: 'Add rule' }));

    expect((await screen.findByRole('alert')).textContent ?? '').toMatch(
      /name the group this rule judges/i,
    );
  });

  it('names the threshold field, and still refuses an empty box as not-zero', async () => {
    const user = userEvent.setup();
    renderRules();

    // The form opens with a default threshold; emptying it is the state this
    // case is about, and `Number('')` being 0 is why the check cannot live in
    // the schema.
    await user.clear(await screen.findByLabelText(/limit/i));
    await user.click(screen.getByRole('button', { name: 'Add rule' }));
    const alert = await screen.findByRole('alert');
    /* `Limit:`, not `Threshold:` — review M09 renamed the field's LABEL (the
       question) while leaving its VALUES alone. The message is generated from
       `FIELD_GUIDANCE`, so it follows the label automatically; this assertion
       exists to prove the error still NAMES THE FIELD rather than describing
       it in the abstract, which is the property M08 added it for. */
    expect(alert.textContent ?? '').toMatch(/^Limit:/);
    expect(alert.textContent ?? '').toMatch(/not zero/i);
    expect(createProjectRule).not.toHaveBeenCalled();
  });

  /**
   * THE CLAIM THAT WAS TOO STRONG (review 09-13 M08). The message used to end
   * "a gate of ≤ 0, which every run breaches" — true for `lte` on a response
   * time and false for the comparator sitting right beside it, since `p95 ≥ 0`
   * passes on every run there will ever be. The unit is asserted from the
   * field's own label instead, which is a fact the form computes.
   */
  it('does not claim every run breaches a zero threshold, and names the unit instead', async () => {
    const user = userEvent.setup();
    renderRules();

    await user.clear(await screen.findByLabelText(/limit/i));
    await user.click(screen.getByRole('button', { name: 'Add rule' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent ?? '').not.toMatch(/every run breaches/i);
    // p95 is the default metric, so the field is in milliseconds and says so.
    expect(alert.textContent ?? '').toMatch(/enter a number in ms/i);
  });

  /** The unit follows the METRIC, so a rule authored on the one metric whose
   *  authoring unit differs from its stored one asks for a percentage. */
  it('asks for the error-rate threshold in the unit the field is labelled with', async () => {
    const user = userEvent.setup();
    renderRules();

    await user.clear(await screen.findByLabelText(/^statistic$/i));
    await user.type(screen.getByLabelText(/^statistic$/i), 'error_rate');
    await user.clear(screen.getByLabelText(/limit/i));
    await user.click(screen.getByRole('button', { name: 'Add rule' }));

    expect((await screen.findByRole('alert')).textContent ?? '').toMatch(
      /enter a number in %/i,
    );
  });
});

/* ======================================================================== *
 * REVIEW 09-13 M08 — THE ERROR HAS TO POINT AT A CONTROL
 * ======================================================================== */

/**
 * Naming a field in a sentence and pointing at it are different things, and
 * this form did only the first: the caret stayed on Add rule, nothing carried
 * `aria-invalid`, and the message was associated with no control at all. A
 * screen-reader user heard the refusal and then had to go and find the box.
 *
 * Every case below asserts the THREE facts together — invalid, described,
 * focused — because each alone is satisfiable by an implementation that has
 * not actually connected the message to the control.
 */
describe('ProjectRules — the refusal points at the field', () => {
  /** The message block, and the control that claims to be described by it. */
  function association(control: HTMLElement) {
    const describedBy = control.getAttribute('aria-describedby') ?? '';
    const ids = describedBy.split(/\s+/).filter((id) => id !== '');
    return ids.map((id) => document.getElementById(id));
  }

  it('marks the target invalid, describes it by the message, and takes the caret there', async () => {
    const user = userEvent.setup();
    renderRules();

    await user.selectOptions(await screen.findByLabelText(/scope/i), 'request');
    await user.click(screen.getByRole('button', { name: 'Add rule' }));

    const alert = await screen.findByRole('alert');
    const target = await screen.findByRole('combobox', { name: /^target/i });

    expect(target).toHaveAttribute('aria-invalid', 'true');
    expect(association(target)).toContain(alert);
    await waitFor(() => expect(target).toHaveFocus());
  });

  it('marks the threshold invalid and takes the caret there', async () => {
    const user = userEvent.setup();
    renderRules();

    const threshold = await screen.findByLabelText(/limit/i);
    await user.clear(threshold);
    await user.click(screen.getByRole('button', { name: 'Add rule' }));

    const alert = await screen.findByRole('alert');
    expect(threshold).toHaveAttribute('aria-invalid', 'true');
    expect(association(threshold)).toContain(alert);
    await waitFor(() => expect(threshold).toHaveFocus());
  });

  /**
   * ONE FIELD AT A TIME. `aria-invalid` on a field the message is not about
   * tells a reader to fix something that is fine, and it is the failure an
   * implementation that simply marks everything on submit would produce.
   */
  it('leaves every other control valid and undescribed', async () => {
    const user = userEvent.setup();
    renderRules();

    await user.clear(await screen.findByLabelText(/limit/i));
    await user.click(screen.getByRole('button', { name: 'Add rule' }));
    await screen.findByRole('alert');

    for (const label of [/^statistic$/i, /name \(optional\)/i]) {
      const control = screen.getByLabelText(label);
      expect(control).not.toHaveAttribute('aria-invalid');
      expect(association(control)).toEqual([]);
    }
  });

  /**
   * THE SECOND ATTEMPT HAS TO MOVE THE CARET TOO. An effect keyed on a
   * memoised error would fire once and then sit still while the reader
   * re-submits the same broken draft — the button would look dead. A fresh
   * object on every refusal is what keeps it live, so this drives exactly that
   * sequence: fail, move away, fail again.
   */
  it('pulls the caret back when the same draft is submitted again', async () => {
    const user = userEvent.setup();
    renderRules();

    const threshold = await screen.findByLabelText(/limit/i);
    await user.clear(threshold);
    const submit = screen.getByRole('button', { name: 'Add rule' });

    await user.click(submit);
    await waitFor(() => expect(threshold).toHaveFocus());

    // The reader goes back to the button — which is where the caret used to
    // be stranded — and asks again.
    submit.focus();
    expect(submit).toHaveFocus();
    await user.click(submit);
    await waitFor(() => expect(threshold).toHaveFocus());
  });

  /**
   * THE THRESHOLD IS THE ONE FIELD TWO MESSAGES CAN DESCRIBE, and each has to
   * reach it on its own.
   *
   * They cannot both be live TODAY, and that is worth stating rather than
   * assuming: the percentage warning needs a finite number above 100, and a
   * refusal needs the box empty or unparseable, so the two conditions exclude
   * each other. `aria-describedby` is composed as a list anyway — the cost is
   * one line, and the alternative is an attribute that silently drops one of
   * them the day a third refusal makes the overlap reachable.
   */
  it('describes the threshold by whichever message is live', async () => {
    const user = userEvent.setup();
    renderRules();

    await user.clear(await screen.findByLabelText(/^statistic$/i));
    await user.type(screen.getByLabelText(/^statistic$/i), 'error_rate');

    const threshold = screen.getByLabelText(/limit/i);
    await user.clear(threshold);
    await user.type(threshold, '150');

    // ONE: the warning, with no refusal anywhere.
    const warning = await screen.findByText(/cannot exceed 100%/i);
    expect(association(threshold)).toEqual([warning]);
    expect(threshold).not.toHaveAttribute('aria-invalid');

    // TWO: the refusal, once the box is empty — which is also what takes the
    // warning away, since there is no longer a number to warn about.
    await user.clear(threshold);
    await user.click(screen.getByRole('button', { name: 'Add rule' }));
    const alert = await screen.findByRole('alert');
    expect(association(threshold)).toEqual([alert]);
  });

  /* ====================================================================== *
   * REVIEW M09 — THE DATA MODEL STOPS BEING THE INTERFACE
   * ====================================================================== */

  /**
   * ═══ THE COMBINATION THAT COULD NEVER FIRE ═══
   *
   * `family` and `scope` are independent enums, so the schema accepts
   * `group_cumulated` on a whole-run gate — and the evaluator can never
   * resolve it. `engine.ts` files a group's timings only under
   * `group_cumulated`/`group_duration`, and only with `scope === 'group'`,
   * which is why `tool-assertions.ts` selects them as
   * `family === 'group_cumulated' && scope === 'group'`.
   *
   * That rule reports `not_applicable` on every run, for ever, while reading
   * as configured protection — the same silent-gate class as the fraction
   * trap CLAUDE.md records, where a legal, resolvable-looking value simply
   * never fires. A schema cannot refuse it; the FORM is the only place it can
   * be prevented, which is why this is a case and not a validator.
   */
  it('offers only measurements the chosen scope can resolve', async () => {
    const user = userEvent.setup();
    renderRules();

    const measurement = await screen.findByLabelText(/measurement/i);
    const optionsNow = () =>
      [...measurement.querySelectorAll('option')].map((o) => o.textContent?.trim());

    // Whole run: the group measurements have no rows at this scope — and
    // NEITHER DOES LATENCY, which this case used to enshrine. The list read
    // `['Response time', 'Latency']`, so a case written to prevent silent
    // gates was pinning one: `engine.ts` never files a `latency` row at ANY
    // scope, so that option authored exactly the rule the docstring above
    // describes. Re-pointed at the claim rather than the strings, which is
    // what the name always said.
    expect(optionsNow()).toEqual(['Response time']);

    await user.selectOptions(screen.getByLabelText(/^scope$/i), 'group');
    expect(optionsNow()).toEqual(['Group cumulated', 'Group duration']);
  });

  /**
   * A `<select>` whose value is not among its options renders BLANK and keeps
   * the stale value — so moving the scope has to move the measurement with it,
   * or the form submits one thing while showing nothing. Asserted on the
   * SUBMITTED body rather than on the control, because that is where the
   * damage would land.
   */
  it('moves the measurement when the scope moves under it', async () => {
    const user = userEvent.setup();
    renderRules();

    await user.selectOptions(await screen.findByLabelText(/^scope$/i), 'group');
    const measurement = screen.getByLabelText(/measurement/i) as HTMLSelectElement;
    expect(measurement.value).toBe('group_cumulated');

    // And back again — the reverse strands it just as easily.
    await user.selectOptions(screen.getByLabelText(/^scope$/i), 'run');
    expect((screen.getByLabelText(/measurement/i) as HTMLSelectElement).value).toBe('response_time');
  });

  /**
   * M09 asks for "a short example for uncommon group measurements". Neither
   * group name says what it measures, and the difference is the one thing a
   * reader cannot guess: cumulated time is the requests' own, duration also
   * counts the waiting between them.
   */
  it('says what a group measurement measures, since its name does not', async () => {
    const user = userEvent.setup();
    renderRules();

    await user.selectOptions(await screen.findByLabelText(/^scope$/i), 'group');
    expect(screen.getByText(/what Gatling’s group page reports/i)).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText(/measurement/i), 'group_duration');
    expect(screen.getByText(/waiting between those requests/i)).toBeInTheDocument();
  });

  /**
   * ═══ THE LABELS MOVED AND THE VALUES DID NOT ═══
   *
   * M09 lists "raw `p95`" among the things requiring implementation
   * knowledge. That half is declined, on the evidence of review N01: `p95` is
   * the statistics table's column, the run-totals tile, and what
   * `formatSlaThreshold` and the preview sentence render. Four branches went
   * into making that one word mean one thing everywhere, and a reader who
   * gated `p95` has to be able to find `p95` on the run page afterwards.
   */
  it('keeps the metric vocabulary the rest of the product uses', async () => {
    renderRules();
    const statistic = (await screen.findByLabelText(/^statistic$/i)) as HTMLInputElement;
    expect(statistic.value).toBe('p95');
  });
});

describe('ProjectRules — the page leads with what exists (review.md 12, 14, 21)', () => {
  /**
   * ═══ THE LIST FIRST, THE FORM BEHIND A CHOICE ═══
   *
   * A fully expanded creation form sat above the existing rules, so a project
   * with six of them opened on the one task its reader had probably not come
   * to do. Asserted by DOCUMENT ORDER rather than by presence — both elements
   * were on the page before this change too, which is exactly why a presence
   * assertion would have passed against the defect.
   */
  it('puts the existing rules before the creation form', async () => {
    fetchProjectRules.mockResolvedValue({ rules: [rule()] });
    renderRules();

    const listed = await screen.findByText('Whole-run p95 response time');
    const form = screen.getByRole('button', { name: /add rule/i });
    // Node.DOCUMENT_POSITION_FOLLOWING: the form comes after the list.
    expect(listed.compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  /** Collapsed once there is something to read instead. */
  it('keeps the creation form closed when rules already exist', async () => {
    fetchProjectRules.mockResolvedValue({ rules: [rule()] });
    renderRules();
    await screen.findByText('Whole-run p95 response time');

    const form = screen.getByRole('button', { name: /add rule/i }).closest('details');
    expect(form).not.toBeNull();
    expect(form!.open).toBe(false);
  });

  /**
   * AND OPEN WHEN THERE IS NOTHING TO LIST — which the finding asks for in as
   * many words. A reader with no rules has no list to lead with, and making
   * them click past an empty table to reach the only useful control would be
   * ceremony. The pair is what makes either assertion mean anything.
   */
  it('opens the creation form for a project with no rules', async () => {
    fetchProjectRules.mockResolvedValue({ rules: [] });
    renderRules();

    // WAITED FOR, not read once. The button is in the DOM from first paint —
    // jsdom renders a closed disclosure's children — so reading `open`
    // immediately asks the question while the query is still in flight, when
    // the answer is deliberately `false`: the form stays shut until an EMPTY
    // result is a settled fact, rather than flashing open and collapsing.
    const button = await screen.findByRole('button', { name: /add rule/i });
    await waitFor(() => {
      expect(button.closest('details')!.open).toBe(true);
    });
  });

  /**
   * ═══ THE CONTROL IS NAMED, NOT LECTURED (finding 21) ═══
   *
   * The helper sentence lived inside the `<label>` wrapping this select, so a
   * screen-reader user heard the whole log-header policy before reaching the
   * first option. A name identifies; a description explains.
   *
   * `getByRole(name)` is EXACT in Testing Library — this file's own convention
   * — so the query passing at all is the assertion: it would not match the
   * concatenated name this used to have.
   */
  it('names the Applies to control without reading its help aloud', async () => {
    fetchProjectRules.mockResolvedValue({ rules: [] });
    renderRules();

    const select = await screen.findByRole('combobox', { name: 'Applies to' });
    expect(select).toHaveAccessibleDescription(/judges only that test’s runs/);
    // The half that moved: the lifecycle clause is no longer part of either.
    expect(select).not.toHaveAccessibleDescription(/log header/);
  });

  /**
   * ═══ POLICY IS AVAILABLE, NOT UNAVOIDABLE (finding 14) ═══
   *
   * Both lifecycle paragraphs are behind one disclosure beside Save. Asserted
   * on the disclosure's CONTAINMENT rather than on the text being absent: a
   * closed `<details>` keeps its children in the DOM under jsdom, so
   * `queryByText` finds them either way — the same reason `ProjectSetup`'s own
   * accordion cases read the `open` attribute instead.
   */
  it('files the lifecycle policy behind a disclosure rather than in the form', async () => {
    fetchProjectRules.mockResolvedValue({ rules: [] });
    renderRules();

    const policy = await screen.findByText(/A new rule judges runs finished after it is added/);
    const disclosure = policy.closest('details');
    expect(disclosure).not.toBeNull();
    expect(disclosure!.open).toBe(false);
    expect(disclosure!).toHaveTextContent('When does this rule apply?');
    // The clause that used to be the Applies-to helper lives here now too, so
    // the policy is stated once rather than split across the form.
    expect(disclosure!).toHaveTextContent(/log header names the simulation/);
  });

  /**
   * ═══ AND IT SURVIVES THE SAVE, WHICH IS THE DEFECT THE `??` EXISTS FOR ═══
   *
   * The two cases above are satisfied EXACTLY AS WELL by a plain
   * `open={settled && empty}` — and that spelling is a controller rather than a
   * default, so it shuts the form the instant a reader's first rule lands and
   * the list stops being empty. Which is the moment they are most likely to be
   * authoring a second.
   *
   * What prevents it is not the reader touching the control: React's own write
   * of the `open` attribute fires a `toggle`, so `formOpen` has already latched
   * `true` by the time the list becomes non-empty, and the `??` fallback never
   * applies again. Load-bearing, and invisible — deleting the `onToggle` leaves
   * every other case in this file green.
   *
   * WAITING FOR THE SAVED RULE TO APPEAR IS WHAT STOPS THIS BEING VACUOUS. A
   * form still open because nothing ever refetched proves nothing at all, so
   * the non-empty list has to be a fact on screen before `open` is read.
   */
  it('keeps the creation form open after the reader saves their first rule', async () => {
    const user = userEvent.setup();
    fetchProjectRules.mockResolvedValue({ rules: [] });
    renderRules();

    const button = await screen.findByRole('button', { name: /add rule/i });
    const disclosure = button.closest('details')!;
    // Names WHICH disclosure this case is about: the lifecycle policy sits in a
    // second `<details>` beside Save, and a `closest` that ever resolved that
    // one instead would assert something else entirely while still passing.
    expect(disclosure.querySelector('summary')).toHaveTextContent('New rule');

    // The latch needs the form to have actually been opened, so the
    // settled-empty state must arrive BEFORE the save rather than racing it.
    await waitFor(() => {
      expect(disclosure.open).toBe(true);
    });

    await user.type(await screen.findByLabelText(/name \(optional\)/i), 'Checkout p95 gate');
    // What the refetch triggered by a successful create will see.
    fetchProjectRules.mockResolvedValue({ rules: [rule()] });
    await user.click(button);

    await waitFor(() => expect(createProjectRule).toHaveBeenCalledTimes(1));
    await screen.findByText('Whole-run p95 response time');

    expect(screen.getByRole('button', { name: /add rule/i }).closest('details')!.open).toBe(true);
  });
});

