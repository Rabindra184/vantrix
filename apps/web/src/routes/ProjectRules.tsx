import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import {
  CreateSlaRuleRequestSchema,
  SLA_METRIC_SCALARS,
  SLA_RULE_COMPARATORS,
  SLA_RULE_FAMILIES,
  SLA_RULE_SCOPES,
  type Assertion,
  type CreateSlaRuleRequest,
  type SlaRule,
  type SlaRuleListResponse,
} from '@perfportal/contracts';
import Button from '../components/Button';
import Card from '../components/Card';
import { EmptyState, ErrorState, LoadingState } from '../components/States';
import TableFrame from '../components/TableFrame';
import { ProblemError } from '../api/fetch';
import {
  createProjectRule,
  deleteProjectRule,
  fetchProjectRules,
  projectRulesQueryKey,
  updateProjectRule,
} from '../api/rules';
import { fetchProjectTests, projectTestsQueryKey } from '../api/tests';
import { INPUT, ROW, TABLE, TD, TH, THEAD } from '../components/tableStyles';
import { describeAssertionRule } from './assertions';

/**
 * Authoring the gates a project's runs are judged against.
 *
 * A SEPARATE FILE from `ProjectSetup`, which already carries two components
 * and 400 lines. The setup page composes this one; nothing else about it
 * changes.
 *
 * THE FORM VALIDATES BEFORE IT SUBMITS, against the same schema the server
 * uses. That is not belt-and-braces — `resolveMetric` returns null for a name
 * it cannot resolve and `evaluateRules` records `not_applicable` rather than
 * failing, so a rule written as `p95th` would save, evaluate as "not checked"
 * on every run forever, and look like configured protection. The server is
 * the authority and rejects it too; catching it here is what lets the message
 * appear beside the field that is wrong.
 */

const SCOPE_LABELS: Record<(typeof SLA_RULE_SCOPES)[number], string> = {
  run: 'Whole run',
  scenario: 'Scenario',
  group: 'Group',
  request: 'Request',
};

const FAMILY_LABELS: Record<(typeof SLA_RULE_FAMILIES)[number], string> = {
  response_time: 'Response time',
  latency: 'Latency',
  group_cumulated: 'Group cumulated',
  group_duration: 'Group duration',
};

const COMPARATOR_LABELS: Record<(typeof SLA_RULE_COMPARATORS)[number], string> = {
  lte: 'at most (≤)',
  gte: 'at least (≥)',
};

/** The scalars, plus the percentiles a reader reaches for most often. */
const METRIC_SUGGESTIONS = ['p50', 'p75', 'p95', 'p99', ...SLA_METRIC_SCALARS];

export default function ProjectRules({
  slug,
  testSlug = null,
  testName = null,
}: {
  readonly slug: string;
  /**
   * When given, this panel is on a TEST's page: it lists the rules that judge
   * that test — its own plus the project-wide ones — and every rule authored
   * here applies to that test alone.
   *
   * ═══ WHY THERE IS NO "APPLIES TO" SELECT IN THIS MODE ═══
   *
   * A reader on a test's page could in principle author a project-wide gate
   * from it, and an earlier draft offered the choice. It is a footgun: the
   * page is titled after one test, the select's default would have to be that
   * test, and the one non-default option silently widens the rule to every
   * OTHER test in the project — a mistake nothing on the page would show
   * afterwards, since a project-wide rule looks identical in this list. The
   * project's setup page is where a project-wide gate is authored, and it says
   * so below.
   */
  readonly testSlug?: string | null;
  /** How to NAME that test in prose. Falls back to the slug, which is real. */
  readonly testName?: string | null;
}) {
  const queryClient = useQueryClient();
  const scopedToTest = testSlug !== null;
  const testLabel = testName ?? testSlug ?? '';

  const rules = useQuery({
    queryKey: projectRulesQueryKey(slug, testSlug),
    queryFn: () => fetchProjectRules(slug, testSlug),
  });

  // The project's tests, for the "Applies to" select — and ONLY in project
  // mode, where that select exists. A test page has its answer already and
  // must not pay for a list it will not draw.
  const tests = useQuery({
    queryKey: projectTestsQueryKey(slug),
    queryFn: () => fetchProjectTests(slug),
    enabled: !scopedToTest,
  });

  /**
   * Which test a NEW rule applies to. `''` is project-wide, matching the
   * empty-valued `<option>` — a `<select>` cannot carry `null` as a value, and
   * mapping the empty string once here is better than every read site
   * remembering to.
   */
  const [appliesTo, setAppliesTo] = useState('');
  const [name, setName] = useState('');
  const [scope, setScope] = useState<(typeof SLA_RULE_SCOPES)[number]>('run');
  const [targetName, setTargetName] = useState('');
  const [family, setFamily] = useState<(typeof SLA_RULE_FAMILIES)[number]>('response_time');
  const [metric, setMetric] = useState('p95');
  const [comparator, setComparator] = useState<(typeof SLA_RULE_COMPARATORS)[number]>('lte');
  const [threshold, setThreshold] = useState('800');
  const [formError, setFormError] = useState<string | null>(null);

  // One row armed at a time, exactly as `TokenTable`'s revoke does it: arming
  // a second disarms the first, so two destructive confirmations can never be
  // on screen together.
  const [confirming, setConfirming] = useState<string | null>(null);

  // THE PREFIX, not this panel's own key. A rule authored on a test's page
  // changes what project setup shows too (and a project-wide one changes every
  // test's page), and TanStack matches keys by prefix — so invalidating
  // `['project-rules', slug]` refreshes every scoped variant at once rather
  // than leaving whichever page the reader visits next showing a list that
  // predates their own edit.
  const invalidate = () =>
    void queryClient.invalidateQueries({ queryKey: ['project-rules', slug] });

  const createMutation = useMutation({
    mutationFn: (body: CreateSlaRuleRequest) => createProjectRule(slug, body),
    onSuccess: () => {
      setName('');
      setTargetName('');
      setFormError(null);
      invalidate();
    },
  });

  const updateMutation = useMutation({
    mutationFn: (vars: { ruleId: string; enabled: boolean }) =>
      updateProjectRule(slug, vars.ruleId, { enabled: vars.enabled }),
    onSuccess: invalidate,
  });

  const deleteMutation = useMutation({
    mutationFn: (ruleId: string) => deleteProjectRule(slug, ruleId),
    onSuccess: invalidate,
  });

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    const parsed = CreateSlaRuleRequestSchema.safeParse({
      name: name.trim() === '' ? null : name.trim(),
      // On a test's page the answer is fixed; in project mode it is whatever
      // the select holds, with `''` meaning project-wide.
      testSlug: scopedToTest ? testSlug : appliesTo === '' ? null : appliesTo,
      scope,
      // A run rule takes NO target and every other scope needs one — the
      // schema refuses the wrong combination either way, and the field only
      // renders for the scopes that use it.
      targetName: scope === 'run' ? null : targetName.trim() === '' ? null : targetName.trim(),
      family,
      metric: metric.trim(),
      comparator,
      threshold: Number(threshold),
    });
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      setFormError(
        issue === undefined
          ? 'The rule is not valid.'
          : `${issue.path.join('.') || 'rule'}: ${issue.message}`,
      );
      return;
    }
    setFormError(null);
    createMutation.mutate(parsed.data);
  }

  const createProblem =
    createMutation.error instanceof ProblemError ? createMutation.error : null;

  return (
    <div className="flex flex-col gap-4">
      <Card
        title="SLA rules"
        description={
          scopedToTest
            ? `Gates every run of ${testLabel} is judged against — this test's own, plus the project-wide ones. A run with no rules gets no verdict.`
            : 'Gates this project’s runs are judged against. A rule can cover every test or just one. A run with no rules gets no verdict.'
        }
      >
        <form onSubmit={onSubmit} className="flex flex-col gap-3">
          {/* ═══ APPLIES TO — WHAT THE RULE JUDGES, NOT WHAT IT MEASURES ═══

              Deliberately the FIRST field, and deliberately not called a
              scope: "Scope" below already means run/scenario/group/request,
              and two selects sharing that word is how somebody gates the
              wrong thing while reading their own configuration as correct. */}
          {scopedToTest ? (
            <p className="rounded-lg border border-default bg-sunken p-3 text-[12px] leading-relaxed text-muted">
              A rule added here applies to <span className="text-primary">{testLabel}</span> only.
              To gate every test in this project, add it on the project’s setup page instead.
              {/* THE LIVE CAVEAT, stated where the rule is authored rather than
                  discovered later. `run.test_id` is resolved from the parsed
                  log header, so it is null for a whole live stream — a
                  test-scoped rule cannot appear in the live banner and judges
                  the final report. A reader who watched a live run and saw
                  their new gate missing would reasonably conclude it was
                  broken. */}
              <span className="mt-1 block">
                Test rules are evaluated on the finished report, so they do not appear in a run’s
                live banner while it is still streaming. Project-wide rules do.
              </span>
            </p>
          ) : (
            <label className="flex flex-col gap-1.5 text-[13px] font-medium">
              Applies to
              <select
                className={INPUT}
                value={appliesTo}
                onChange={(e) => setAppliesTo(e.target.value)}
              >
                <option value="">Every test in this project</option>
                {(tests.data?.tests ?? []).map((t) => (
                  <option key={t.id} value={t.slug}>
                    {t.name}
                  </option>
                ))}
              </select>
              <span className="text-[11px] font-normal text-muted">
                A rule for one test is evaluated on its finished report, so it does not appear in a
                live run’s banner. A project-wide rule does.
              </span>
            </label>
          )}

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1.5 text-[13px] font-medium">
              Name (optional)
              <input
                className={INPUT}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Checkout p95 gate"
              />
            </label>
            <label className="flex flex-col gap-1.5 text-[13px] font-medium">
              Scope
              <select
                className={INPUT}
                value={scope}
                onChange={(e) => setScope(e.target.value as typeof scope)}
              >
                {SLA_RULE_SCOPES.map((value) => (
                  <option key={value} value={value}>
                    {SCOPE_LABELS[value]}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {/* Rendered only for the scopes that match BY name. A run rule reads
              the run's own aggregate row and has nothing to target, so the
              field would be a box that must stay empty. */}
          {scope !== 'run' && (
            <label className="flex flex-col gap-1.5 text-[13px] font-medium">
              Target name
              <input
                className={INPUT}
                value={targetName}
                onChange={(e) => setTargetName(e.target.value)}
                placeholder="GET /catalog"
              />
              <span className="text-[11px] font-normal text-muted">
                Matched against the name this run recorded. A target no run has yet reported is
                allowed — its rule reads “not checked” until one does.
              </span>
            </label>
          )}

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <label className="flex flex-col gap-1.5 text-[13px] font-medium">
              Family
              <select
                className={INPUT}
                value={family}
                onChange={(e) => setFamily(e.target.value as typeof family)}
              >
                {SLA_RULE_FAMILIES.map((value) => (
                  <option key={value} value={value}>
                    {FAMILY_LABELS[value]}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1.5 text-[13px] font-medium">
              Metric
              {/* A datalist, not a select: the evaluator accepts ANY percentile
                  in (0, 100), so a closed list would refuse p99.95 while the
                  engine answers it. The suggestions cover what is reached for;
                  the schema decides what is legal. */}
              <input
                className={INPUT}
                list="sla-metric-suggestions"
                value={metric}
                onChange={(e) => setMetric(e.target.value)}
              />
              <datalist id="sla-metric-suggestions">
                {METRIC_SUGGESTIONS.map((value) => (
                  <option key={value} value={value} />
                ))}
              </datalist>
            </label>
            <label className="flex flex-col gap-1.5 text-[13px] font-medium">
              Must be
              <select
                className={INPUT}
                value={comparator}
                onChange={(e) => setComparator(e.target.value as typeof comparator)}
              >
                {SLA_RULE_COMPARATORS.map((value) => (
                  <option key={value} value={value}>
                    {COMPARATOR_LABELS[value]}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1.5 text-[13px] font-medium">
              Threshold
              <input
                className={INPUT}
                inputMode="decimal"
                value={threshold}
                onChange={(e) => setThreshold(e.target.value)}
              />
            </label>
          </div>

          {formError !== null && (
            <p role="alert" className="rounded-lg border border-default bg-sunken p-3 text-[13px]">
              {formError}
            </p>
          )}

          {createMutation.isError && (
            <div
              role="alert"
              className="rounded-lg border border-default bg-sunken p-3 text-[13px] text-primary"
            >
              {createProblem?.detail ?? createMutation.error.message}
              {createProblem?.remediation !== undefined && (
                <p className="mt-1 text-muted">{createProblem.remediation}</p>
              )}
            </div>
          )}

          <div>
            <Button type="submit" variant="primary" loading={createMutation.isPending}>
              Add rule
            </Button>
          </div>
        </form>
      </Card>

      <RulesTable
        rules={rules}
        scopedToTest={scopedToTest}
        confirming={confirming}
        onConfirming={setConfirming}
        togglingId={updateMutation.isPending ? updateMutation.variables?.ruleId : undefined}
        deletingId={deleteMutation.isPending ? deleteMutation.variables : undefined}
        onToggle={(ruleId, enabled) => updateMutation.mutate({ ruleId, enabled })}
        onDelete={(ruleId) => deleteMutation.mutate(ruleId)}
        failedDelete={deleteMutation.isError ? deleteMutation.variables : undefined}
        deleteError={deleteMutation.error}
      />
    </div>
  );
}

function RulesTable({
  rules,
  scopedToTest,
  confirming,
  onConfirming,
  togglingId,
  deletingId,
  onToggle,
  onDelete,
  failedDelete,
  deleteError,
}: {
  readonly rules: UseQueryResult<SlaRuleListResponse>;
  /**
   * Changes what the Applies-to column MEANS, not whether it renders. On a
   * test's page every row already judges that test, so naming the test on each
   * one would be a column of the same word; what a reader needs to know there
   * is which rows are the project's and which are this test's own.
   */
  readonly scopedToTest: boolean;
  readonly confirming: string | null;
  readonly onConfirming: (id: string | null) => void;
  readonly togglingId?: string;
  readonly deletingId?: string;
  readonly onToggle: (ruleId: string, enabled: boolean) => void;
  readonly onDelete: (ruleId: string) => void;
  readonly failedDelete?: string;
  readonly deleteError: unknown;
}) {
  if (rules.isPending) return <LoadingState label="Loading rules…" />;
  if (rules.isError) {
    const problem = rules.error instanceof ProblemError ? rules.error : null;
    return (
      <ErrorState
        title="The SLA rules could not be loaded"
        detail={problem?.detail}
        remediation={problem?.remediation}
      />
    );
  }
  if (rules.data.rules.length === 0) {
    return (
      <EmptyState
        title="No SLA rules yet"
        body="Add one above. Until a project has a rule, its runs complete with no release verdict."
      />
    );
  }

  const problem = deleteError instanceof ProblemError ? deleteError : null;

  return (
    <div className="flex flex-col gap-3">
      {/* A destructive mutation that failed MUST announce itself, and must not
          claim a state it cannot know — the same wording discipline
          `TokenTable`'s revoke failure uses. */}
      {failedDelete !== undefined && deleteError !== null && (
        <div
          role="alert"
          className="rounded-lg border border-default bg-sunken p-3 text-[13px] text-primary"
        >
          That rule may still be active — deleting it did not complete.
          {problem?.detail !== undefined && <p className="mt-1">{problem.detail}</p>}
          {problem?.remediation !== undefined && <p className="mt-1 text-muted">{problem.remediation}</p>}
        </div>
      )}

      <TableFrame
        caption="Every SLA rule in this project, newest first. A disabled rule stays here but is not evaluated."
        label="SLA rules"
      >
        <table className={TABLE}>
          <caption className="sr-only">SLA rules for this project</caption>
          <thead className={THEAD}>
            <tr>
              <th className={TH}>Name</th>
              <th className={TH}>Applies to</th>
              <th className={TH}>Rule</th>
              <th className={TH}>Status</th>
              <th className={TH}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rules.data.rules.map((rule) => (
              <tr key={rule.id} className={ROW}>
                {/* An unnamed rule falls back to an em dash rather than to its
                    own expression, which the next column already carries. */}
                <td className={TD}>{rule.name ?? '—'}</td>
                {/* WHAT THIS RULE JUDGES. `rule.test` is nullable AND optional
                    — null is a genuine project-wide rule, undefined is a
                    response from an API pod that predates the field — and both
                    render the same, because a reader can act on neither
                    difference and "every test" is the truthful reading of an
                    absent one. */}
                <td data-testid="rule-applies-to" className={TD}>
                  {rule.test == null ? (
                    <span className="text-muted">
                      {scopedToTest ? 'Every test (project-wide)' : 'Every test'}
                    </span>
                  ) : scopedToTest ? (
                    'This test'
                  ) : (
                    rule.test.name
                  )}
                </td>
                {/* The SAME describer the run page and the evaluator's own
                    message use, so a rule reads identically everywhere it
                    appears. */}
                <td className={`${TD} font-mono text-[12px]`}>{describe(rule)}</td>
                <td className={TD}>{rule.enabled ? 'Enabled' : 'Disabled'}</td>
                <td className={TD}>
                  {confirming === rule.id ? (
                    <div className="flex flex-col gap-2">
                      <p className="text-[12px] text-muted">
                        Permanent. Runs already judged keep their verdicts.
                      </p>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          variant="primary"
                          size="sm"
                          loading={deletingId === rule.id}
                          onClick={() => {
                            onConfirming(null);
                            onDelete(rule.id);
                          }}
                        >
                          Confirm delete
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => onConfirming(null)}>
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      <Button
                        variant="secondary"
                        size="sm"
                        loading={togglingId === rule.id}
                        onClick={() => onToggle(rule.id, !rule.enabled)}
                      >
                        {rule.enabled ? 'Disable' : 'Enable'}
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => onConfirming(rule.id)}>
                        Delete
                      </Button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableFrame>
    </div>
  );
}

/**
 * A stored rule in the shape `describeAssertionRule` reads.
 *
 * THE WIDENING IS THE REASON THIS EXISTS. `SlaRuleSchema` types `scope`,
 * `family` and `comparator` as plain strings on purpose — a response schema
 * echoes whatever is stored, so one row written before an enum narrowed
 * renders as itself instead of 500ing the list (see `TokenSummarySchema`).
 * `describeAssertionRule` takes the evaluator's narrower `Assertion['rule']`.
 * Reconciling them in one named function keeps the assertion to a single
 * place with the argument attached, rather than an inline cast in the middle
 * of a table cell.
 *
 * The comparator is the only field the describer branches on, and anything
 * that is not `lte` already renders as `≥` there, so narrowing it here says
 * exactly what that function would conclude anyway.
 */
function describe(rule: SlaRule): string {
  return describeAssertionRule({
    scope: rule.scope,
    targetName: rule.targetName,
    family: rule.family,
    metric: rule.metric,
    comparator: rule.comparator === 'lte' ? 'lte' : 'gte',
    threshold: rule.threshold,
  } as Assertion['rule']);
}
