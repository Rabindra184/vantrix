import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import {
  CreateSlaRuleRequestSchema,
  SLA_METRIC_SCALARS,
  SLA_RULE_COMPARATORS,
  SLA_RULE_FAMILIES,
  SLA_RULE_SCOPES,
  slaMetricUnit,
  describeSlaRule,
  type Assertion,
  type CreateSlaRuleRequest,
  type SlaRule,
  type SlaRuleListResponse,
  type SlaRuleScope,
  percentToFraction,
} from '@perfportal/contracts';
import Button from '../components/Button';
import Card from '../components/Card';
import { ErrorState, LoadingState } from '../components/States';
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
import { fetchRuns, runsQueryKey } from '../api/runs';
import { statsQuery } from '../api/metrics';
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

/**
 * ═══ WHICH MEASUREMENTS EXIST AT WHICH SCOPE — review M09 ═══
 *
 * The form offered all four families at every scope, and two of those
 * combinations can never resolve. `engine.ts` files a group's timings ONLY
 * under `group_cumulated` and `group_duration`, and it files those ONLY with
 * `scope === 'group'` — which is why `tool-assertions.ts` selects them as
 * `s.family === 'group_cumulated' && s.scope === 'group'`.
 *
 * So "Group cumulated" on a whole-run gate authored a rule the evaluator will
 * report `not_applicable` for on every run, for ever, while reading as
 * configured protection. That is the same silent-gate class as the fraction
 * trap this file already records: legal, resolvable-looking, and never firing.
 * The schema cannot refuse it — both fields are independently valid enums —
 * so the FORM is the only place it can be prevented.
 */
const FAMILIES_FOR_SCOPE: Record<
  (typeof SLA_RULE_SCOPES)[number],
  readonly (typeof SLA_RULE_FAMILIES)[number][]
> = {
  run: ['response_time', 'latency'],
  scenario: ['response_time', 'latency'],
  request: ['response_time', 'latency'],
  group: ['group_cumulated', 'group_duration'],
};

/**
 * What the two group measurements actually measure, since neither name says.
 * M09 asks for "a short example for uncommon group measurements"; this is the
 * difference a reader cannot guess, measured on the reference run: a group's
 * cumulated time is the sum of its requests' own times, its duration also
 * counts the waiting between them, and on that fixture the second runs about
 * 80ms higher at every percentile.
 */
const FAMILY_EXAMPLE: Partial<Record<(typeof SLA_RULE_FAMILIES)[number], string>> = {
  group_cumulated: 'Time inside the group’s own requests, added up — what Gatling’s group page reports.',
  group_duration: 'The same, plus the waiting between those requests, so it reads higher.',
};

const COMPARATOR_LABELS: Record<(typeof SLA_RULE_COMPARATORS)[number], string> = {
  lte: 'at most (≤)',
  gte: 'at least (≥)',
};

/**
 * WHAT EACH FIELD IS CALLED ON SCREEN, AND WHAT TO DO ABOUT IT.
 *
 * Keyed by the request's own property names because that is what a Zod issue
 * path carries — which is exactly the string the reader must never see. The
 * label is the form's own wording, so the message points at a control they can
 * find; the help is the action, in the vocabulary of this form rather than of
 * the schema.
 *
 * A field missing from this map degrades to "This rule: <the schema's
 * message>", which is still better than a path and is the honest answer for a
 * field nobody has written guidance for yet.
 */
const FIELD_GUIDANCE: Record<string, { label: string; help: string }> = {
  name: {
    label: 'Name',
    help: 'A short label for this gate. Leave it empty and the rule is named by what it measures.',
  },
  testSlug: {
    label: 'Applies to',
    help: 'Pick one of this project’s tests, or leave it on every test.',
  },
  scope: {
    label: 'Scope',
    help: 'Whole run judges the run’s own totals; the others judge one named request, group or scenario.',
  },
  targetName: {
    label: 'Target',
    help: 'Name the request, group or scenario this rule judges — or set the scope to Whole run, which needs no target.',
  },
  /* ═══ THE QUESTION IS PLAIN; THE ANSWER IS STILL THE SYSTEM'S WORD ═══
   *
   * M09 objects that `Family`, `Metric` and `Threshold` "require
   * implementation knowledge" and asks for Measurement, Statistic, Limit.
   * Those are the LABELS, and they move.
   *
   * The VALUES do not. `p95` stays `p95`, because review N01 spent four
   * branches making that one word mean one thing everywhere — it is the
   * statistics table's column, the run-totals tile, and what
   * `formatSlaThreshold` and the preview sentence below render. Renaming it
   * here would re-open exactly the drift that pass closed, and would leave a
   * reader unable to find on the run page the thing they had just gated.
   * M09 lists "raw p95" among its examples; this is the half of that finding
   * it is right to decline, and it is declined on the evidence of the other
   * one. */
  family: {
    label: 'Measurement',
    help: 'What is being measured. Response time is the usual one; a group gate measures the group’s own timings.',
  },
  metric: {
    label: 'Statistic',
    help: 'Which figure from that measurement: a percentile such as p95 or p99.9 (strictly between 0 and 100), or one of the named measures in the list.',
  },
  comparator: { label: 'Must be', help: 'Whether the measured value has to stay below or above the limit.' },
  threshold: {
    label: 'Limit',
    help: 'A number, in the unit shown beside the field. Error rate is authored as a percentage.',
  },
};

/* ======================================================================== *
 * POINTING AT THE FIELD, NOT JUST NAMING IT (review 09-13 M08)
 * ======================================================================== */

/**
 * The DOM id of one control on this form.
 *
 * Every field here is an `<input>` or a `<select>` INSIDE its own `<label>`,
 * which associates the two perfectly and leaves the control with no id at all.
 * That is enough right up to the moment something has to FIND the control:
 * `aria-describedby` needs an id on the message, `aria-invalid` needs to be on
 * the control itself, and moving the caret needs a handle on it. So every
 * field the form can refuse now carries one, keyed by the same request
 * property name `FIELD_GUIDANCE` is keyed by — the string a Zod issue path
 * hands back — so there is exactly one spelling of "which field".
 *
 * A field with no rendered control degrades to no focus and no `aria-invalid`,
 * with the message still announced: `scope`, `family` and `comparator` are
 * closed `<select>`s whose every option is legal, so nothing can name them
 * today, and a future refinement that does should not have to be added here
 * before the error can be reported at all.
 */
const fieldId = (field: string): string => `rule-field-${field}`;

/** The one message block, named once so its two references cannot drift. */
const FORM_ERROR_ID = 'rule-form-error';

/** What a scoped rule is being asked to name, in that scope's own noun. */
const scopeTargetLabel = (scope: Exclude<SlaRuleScope, 'run'>): string =>
  scope === 'request' ? 'request' : scope === 'group' ? 'group' : 'scenario';

/** Which control the message is about, or null when it is about the rule. */
interface FormError {
  readonly field: string | null;
  readonly title: string;
  readonly help?: string;
}

/* ======================================================================== *
 * THE TARGET, PICKED FROM WHAT A RUN ACTUALLY RECORDED (review M17)
 * ======================================================================== */

/**
 * ═══ FREE TEXT AGAINST A SET THIS PRODUCT ALREADY KNOWS ═══
 *
 * The target was an `<input>` with a `GET /catalog` placeholder, matched
 * against "the name this run recorded" — a name the author had to remember
 * exactly, from a table on another page, while this product had a list of them
 * the whole time. A typo is not refused, because a target no run has reported
 * yet is LEGAL and useful: the rule reads "not checked" until one does. So
 * validation cannot help here and only the control can, exactly as with the
 * test picker on the launch form.
 *
 * ═══ WHERE THE NAMES COME FROM ═══
 *
 * The most recent COMPLETE run in this scope — the project's, or the test's
 * when this panel is on a test's page — and its statistics rows, filtered to
 * the scope the rule is being written for. Two requests, made only when the
 * scope actually needs a target, and both already cached by the run page a
 * reader has usually just come from.
 *
 * It is deliberately a suggestion and not a constraint. "Something else" keeps
 * the typed field, because a rule written BEFORE the endpoint it guards exists
 * is a legitimate thing to do and refusing it would be the schema's mistake
 * made in the UI instead.
 */
const CUSTOM_TARGET = '__custom__';

function TargetField({
  slug,
  testSlug,
  scope,
  value,
  onChange,
  invalid,
}: {
  readonly slug: string;
  readonly testSlug: string | null;
  readonly scope: Exclude<SlaRuleScope, 'run'>;
  readonly value: string;
  readonly onChange: (next: string) => void;
  /** True while the form's message is about this field — see `fieldId`. */
  readonly invalid: boolean;
}) {
  // The newest complete run tells us what this project records. `status`
  // complete only: a pending or failed run has no statistics rows to read.
  const runs = useQuery({
    queryKey: runsQueryKey(null, slug, { status: 'complete' }, testSlug),
    queryFn: () => fetchRuns(null, slug, { status: 'complete' }, testSlug),
  });
  const latestRunId = runs.data?.items[0]?.id ?? null;
  const stats = useQuery({ ...statsQuery(latestRunId ?? ''), enabled: latestRunId !== null });

  const recorded = useMemo(() => {
    const names = new Set<string>();
    for (const row of stats.data?.stats ?? []) {
      if (row.scope === scope && row.name !== '') names.add(row.name);
    }
    return [...names].sort((a, b) => a.localeCompare(b));
  }, [stats.data, scope]);

  /* TYPING MODE IS STICKY ONCE CHOSEN, and it also starts true whenever the
     current value is not one of the recorded names — which is what happens
     when the reader changes the SCOPE after picking, since a request name is
     not a group name. Without that the select would silently show its
     placeholder over a value the form is still holding. */
  const [custom, setCustom] = useState(false);
  const typing = custom || (value !== '' && !recorded.includes(value));

  const label = scopeTargetLabel(scope);

  // NO LIST TO OFFER — no complete run yet, or the reads failed. The field
  // degrades to what it was, with a line saying why rather than an empty
  // select that looks like the project has no requests.
  if (runs.isError || stats.isError || (!runs.isPending && latestRunId === null)) {
    return (
      <label className="flex flex-col gap-1.5 text-[13px] font-medium">
        Target
        <input
          id={fieldId('targetName')}
          aria-invalid={invalid || undefined}
          aria-describedby={invalid ? FORM_ERROR_ID : undefined}
          className={INPUT}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="GET /catalog"
        />
        <span className="text-[11px] font-normal text-muted">
          {runs.isError || stats.isError
            ? `The recorded ${label} names could not be loaded, so type the name this run reports.`
            : `No completed run here yet, so there are no recorded ${label} names to choose from. Type the name a run will report.`}
        </span>
      </label>
    );
  }

  return (
    <label className="flex flex-col gap-1.5 text-[13px] font-medium">
      Target
      {typing ? (
        <>
          <input
            id={fieldId('targetName')}
            aria-invalid={invalid || undefined}
            aria-describedby={invalid ? FORM_ERROR_ID : undefined}
            className={INPUT}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder="GET /catalog"
            autoFocus={custom}
          />
          {recorded.length > 0 && (
            <button
              type="button"
              className="w-fit text-[11px] font-normal text-accent hover:underline hover:underline-offset-2"
              onClick={() => {
                setCustom(false);
                onChange('');
              }}
            >
              Choose from the {recorded.length} recorded {label}
              {recorded.length === 1 ? '' : 's'} instead
            </button>
          )}
        </>
      ) : (
        <select
          id={fieldId('targetName')}
          aria-invalid={invalid || undefined}
          aria-describedby={invalid ? FORM_ERROR_ID : undefined}
          className={INPUT}
          value={value}
          onChange={(e) => {
            if (e.target.value === CUSTOM_TARGET) {
              setCustom(true);
              onChange('');
              return;
            }
            onChange(e.target.value);
          }}
        >
          <option value="">Choose a recorded {label}…</option>
          {recorded.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
          <option value={CUSTOM_TARGET}>Something else…</option>
        </select>
      )}
      <span className="text-[11px] font-normal text-muted">
        {stats.isPending && latestRunId !== null
          ? `Reading the ${label} names from the newest completed run…`
          : `Matched against the name a run records. A target no run has reported yet is allowed — its rule reads “not checked” until one does.`}
      </span>
    </label>
  );
}

/** The scalars, plus the percentiles a reader reaches for most often. */
const METRIC_SUGGESTIONS = ['p50', 'p75', 'p95', 'p99', ...SLA_METRIC_SCALARS];

export default function ProjectRules({
  slug,
  testSlug = null,
  testName = null,
  showTitle = true,
}: {
  readonly slug: string;
  /**
   * False on the project's own SLA rules PAGE, where `ProjectShell`'s nav
   * already names the section and carries `aria-current="page"` on it —
   * review M15 gave rules a destination of their own rather than a block at
   * the foot of setup, and M10 left the naming of that destination to the
   * nav rather than to a heading.
   *
   * The same rule `RunList.showHeading` follows, for the same reason: a
   * heading's correctness is a property of the DOCUMENT, which no component
   * can see from inside itself. It stays TRUE on a test's page, where this
   * panel sits beside a run list and a title is the only thing telling the
   * two apart.
   *
   * The DESCRIPTION is kept either way. It is the sentence that says what a
   * rule does and that a run with none gets no verdict, and it is as true on
   * a page as it is in a panel.
   */
  readonly showTitle?: boolean;
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

  /* KEEPS THE PAIR VALID WHEN THE SCOPE MOVES UNDER IT. Changing the scope can
     leave `family` naming a measurement that scope has no rows for — the very
     combination `FAMILIES_FOR_SCOPE` exists to prevent — and a `<select>` whose
     value is not among its options renders BLANK rather than correcting
     itself, so the form would submit the stale family while showing nothing.
     Derived in the scope handler rather than an effect: this is a consequence
     of one event, not a synchronisation between two states. */
  const [comparator, setComparator] = useState<(typeof SLA_RULE_COMPARATORS)[number]>('lte');
  const [threshold, setThreshold] = useState('800');
  /* ═══ A FIELD AND A SENTENCE, NEVER A SCHEMA PATH (review M17) ═══
   *
   * This was one string built as `${issue.path.join('.')}: ${issue.message}`,
   * so a reader met `targetName: Required` — a property name from a Zod
   * object, which is the data model leaking into the one place somebody is
   * being asked to fix something. The `title` still carries the schema's own
   * reason, which is often specific and worth keeping; `help` is what the
   * reader should DO, named in the form's own vocabulary.
   *
   * `field` was added by review 09-13 M08 — naming the field in a sentence is
   * not the same as pointing at it, and the caret stayed on the submit button
   * while the message described a control four rows up. */
  const [formError, setFormError] = useState<FormError | null>(null);

  /* ═══ THE MESSAGE MOVES THE CARET (review 09-13 M08) ═══
   *
   * IN AN EFFECT RATHER THAN IN THE HANDLER, and that is the load-bearing
   * detail. Focusing inside `onSubmit` runs BEFORE React commits the render
   * that adds `aria-invalid` and `aria-describedby`, so a screen reader would
   * announce the field in its old, valid-looking state and never read the
   * message. After the commit both are on the element the caret lands on.
   *
   * `setFormError` is called with a FRESH OBJECT on every refusal, so
   * submitting the same broken draft twice still re-runs this and pulls the
   * caret back — an effect keyed on a memoised value would fire once and then
   * leave the second attempt feeling like nothing happened.
   */
  useEffect(() => {
    if (formError === null || formError.field === null) return;
    const control = document.getElementById(fieldId(formError.field));
    if (control !== null) control.focus();
  }, [formError]);

  // Both derived, never stored: a unit that could disagree with the metric box
  // beside it would be worse than no unit at all.
  const storedUnit = slaMetricUnit(metric.trim());
  /* ═══ THE AUTHOR TYPES A PERCENTAGE; THE WIRE CARRIES A FRACTION ═══
   *
   * `error_rate` is `koCount / count`, so the evaluator compares 0.0268 while
   * the tiles, the statistics table and the errors tab all render that same
   * number as 2.68%. Asking the author to be the one place that converts is
   * what produced the trap this form already warned about: `1` meaning "one
   * percent" is a legal, resolvable, permanently PASSING gate of ≤ 100%.
   *
   * So the FIELD takes a percentage and `percentToFraction` stores a fraction.
   * Nothing about the contract, the wire or the evaluator changes, and rules
   * authored before this read back exactly as they did. */
  const authorUnit = storedUnit === 'fraction' ? '%' : storedUnit;

  /* THE SENTENCE, or null while there is nothing true to say. `null` for an
     unresolvable metric as well as an unparseable threshold: `describeSlaRule`
     would happily render "p95th must be at most 800" for a metric the engine
     refuses, which is a preview that lies in the one case the author most
     needs to be told. */
  const thresholdNumber = threshold.trim() === '' ? Number.NaN : Number(threshold);
  /* ═══ A SCOPED RULE WITH NO TARGET HAS NO PREVIEW (review 09-13 M07) ═══
   *
   * `describeSlaRule` renders "Every request: …" when a scoped rule names no
   * target, which is a reasonable reading of the DATA and a false description
   * of what this form will do: the submit refuses that draft outright, because
   * the schema requires a target for every scope but `run`. So the preview
   * promised a rule the button would not create.
   *
   * The describer keeps that branch — a STORED rule can legitimately be read
   * that way, and the run page's evidence panel uses the same function — and
   * the FORM stops asking for it while the draft is incomplete. The missing
   * field is named instead; see `previewBlocker`. */
  const needsTarget = scope !== 'run' && targetName.trim() === '';
  /* The noun this scope's target is called by, for every sentence that has to
     ask for one. `'target'` is the run arm and is never rendered — a run rule
     has no target field, so nothing below reaches for this — but it is a true
     word rather than a wrong one if that ever stops being the case. */
  const targetLabel = scope === 'run' ? 'target' : scopeTargetLabel(scope);
  const preview =
    needsTarget || !Number.isFinite(thresholdNumber) || slaMetricUnit(metric.trim()) === null
      ? null
      : describeSlaRule({
          scope,
          targetName: scope === 'run' ? null : targetName.trim() === '' ? null : targetName.trim(),
          metric: metric.trim(),
          comparator,
          threshold:
            storedUnit === 'fraction' ? percentToFraction(thresholdNumber) : thresholdNumber,
        });

  /** What the preview is waiting for, in the order the form asks for it. */
  const previewBlocker = needsTarget
    ? `Choose a ${targetLabel} to preview this rule.`
    : slaMetricUnit(metric.trim()) === null
      ? 'Name a metric this run can resolve — a percentile such as p95, or one of the listed measures.'
      : 'Enter a threshold and this will say, in words, what the rule gates.';
  /* The old warning caught a FRACTION above 1 — the "typed 1, meant 1%" case
     that this field's own unit now prevents. What is still worth catching is a
     percentage above 100: `error_rate` cannot exceed 1, so ≤ 150% is a gate no
     run can breach, exactly as ≤ 100% was. */
  const thresholdWarning =
    storedUnit === 'fraction' && Number.isFinite(Number(threshold)) && Number(threshold) > 100
      ? `An error rate cannot exceed 100%, so ${threshold}% is a gate no run can breach.`
      : null;

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

    /* ═══ AN EMPTY THRESHOLD IS NOT ZERO, AND `Number` DISAGREES ═══
     *
     * `Number('')` and `Number('   ')` are both `0`, and `0` is a perfectly
     * legal threshold — so a blank field used to author a real gate rather
     * than fail validation. The schema cannot catch this and never could: by
     * the time it sees the value, an absent threshold and a deliberate zero
     * are the same number. The only place the difference still exists is
     * here, in the raw string, which is why the check has to happen before
     * the conversion rather than inside the contract.
     *
     * The resulting gate is not inert: a blank field authors a bound of zero,
     * which judges every future run against a number nobody chose.
     *
     * WHAT IT DOES *NOT* SAY ANY MORE (review 09-13 M08): this message used to
     * end "a gate of ≤ 0, which every run breaches". True for `lte` on a
     * response time, and false the moment either half moves — `p95 ≥ 0` passes
     * on every run there will ever be, and `count ≤ 0` passes on a run that
     * recorded nothing. A warning that overstates its case is one the reader
     * learns to discount. The unit comes from the field's own label instead,
     * which is a fact this form already computes and can always defend.
     *
     * A zero somebody actually typed stays valid; `ProjectRules.test.tsx`
     * pins that alongside the two refusals, so a fix that simply rejected
     * falsy thresholds would fail there. */
    if (threshold.trim() === '') {
      setFormError({
        field: 'threshold',
        title: `Limit: enter a number${authorUnit === null ? '' : ` in ${authorUnit}`}.`,
        help: 'An empty box is not zero — leaving it blank would author a bound of 0, which is not the gate you are choosing.',
      });
      return;
    }

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
      // PERCENT IN, FRACTION OUT — see `authorUnit`. Non-fraction metrics are
      // already in their stored unit and pass straight through.
      threshold:
        storedUnit === 'fraction' ? percentToFraction(Number(threshold)) : Number(threshold),
    });
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      if (issue === undefined) {
        setFormError({ field: null, title: 'The rule is not valid.' });
        return;
      }
      /* The FIRST path segment, because every field on this form is a
         top-level key of the request — and `String()` because a Zod path
         segment can be a number for an array index, which none of these are
         but which would otherwise read as `[object Object]` if one ever is. */
      const key = String(issue.path[0] ?? '');
      const field = FIELD_GUIDANCE[key];

      /* ═══ THE SCHEMA DESCRIBES BOTH HALVES; THIS FORM KNOWS WHICH ═══
       *
       * `targetMatchesScope` refuses two opposite mistakes with one sentence —
       * "a run-scoped rule takes no target name; a scenario, group or request
       * rule needs one" — which is right for an API consumer, who can send
       * either. An author who has already chosen Request and left the box
       * empty gets a rule of grammar where they wanted the missing word: half
       * of it describes a combination this form cannot even produce, since a
       * run rule renders no target field at all. Named here rather than in the
       * contract, because the contract does not know the scope is settled.
       * (review 09-13 M08) */
      if (key === 'targetName' && scope !== 'run') {
        setFormError({
          field: key,
          title: `Target: name the ${targetLabel} this rule judges.`,
          help: `Pick one this project has recorded, or type the name a run will report — a ${targetLabel} no run has reported yet is allowed.`,
        });
        return;
      }

      setFormError({
        field: key === '' ? null : key,
        title: `${field?.label ?? 'This rule'}: ${issue.message}`,
        help: field?.help,
      });
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
        // `title={undefined}` rather than a conditional spread: CLAUDE.md
        // records that the excess-property check does not reach inside a
        // spread, so a mistyped key there is accepted in silence. `title`
        // is optional on `Card`, so passing undefined is the same thing and
        // stays in front of the compiler.
        title={showTitle ? 'SLA rules' : undefined}
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
              {/* THIS PARAGRAPH USED TO CARRY A CAVEAT, and it is worth knowing
                  why it does not any more. A test-scoped rule could once not
                  appear in a run's live banner at all: `run.test_id` was only
                  resolved by the pipeline at finalize, so a streaming run
                  belonged to no test and matched no test rule. `LiveFoldOwner`
                  now resolves it from the log header the decoder reads within
                  the first few hundred bytes, so the banner applies these
                  rules like any other. Nothing here needs to warn a reader
                  about a gap that no longer exists. */}
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
              {/* ═══ TWO SENTENCES IN ONE FORM SAID OPPOSITE THINGS
                  (review 09-13 M06) ═══

                  This read "Every rule here applies to a live run as soon as
                  its log header names the simulation", while the preview below
                  says a run streaming right now keeps the rules it started
                  under. Read together they contradict each other about the one
                  question an author asks after saving.

                  Both describe real mechanisms and neither was a lie — they are
                  about DIFFERENT things. `LiveFoldOwner.#identify` resolves the
                  run's test from the log header and widens the rule set to that
                  test's rules, which is the initial load COMPLETING; and
                  `FoldState.rules` is loaded once per run on purpose, so an
                  edit mid-run cannot make a breach appear with no change in the
                  data. What was missing is that both are true of rules that
                  ALREADY EXISTED when the run was claimed.

                  So this sentence stops making a claim about newly-added rules
                  and says the thing that is only true here: which runs a
                  test-scoped rule judges. The lifecycle is stated once, beside
                  the button that creates one. */}
              <span className="text-[11px] font-normal text-muted">
                A rule for one test judges only that test’s runs. A live run is matched to its
                test as soon as the log header names the simulation, so the rules written for that
                test apply from that moment on.
              </span>
            </label>
          )}

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1.5 text-[13px] font-medium">
              Name (optional)
              <input
                id={fieldId('name')}
                aria-invalid={formError?.field === 'name' || undefined}
                aria-describedby={formError?.field === 'name' ? FORM_ERROR_ID : undefined}
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
                onChange={(e) => {
                  const next = e.target.value as typeof scope;
                  setScope(next);
                  // See the note by `metric`'s state: a scope change can strand
                  // the family on a measurement this scope has no rows for.
                  const allowed = FAMILIES_FOR_SCOPE[next];
                  if (!allowed.includes(family)) setFamily(allowed[0]!);
                }}
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
            <TargetField
              slug={slug}
              testSlug={testSlug}
              scope={scope}
              value={targetName}
              onChange={setTargetName}
              invalid={formError?.field === 'targetName'}
            />
          )}

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <label className="flex flex-col gap-1.5 text-[13px] font-medium">
              Measurement
              {/* ONLY WHAT CAN RESOLVE AT THIS SCOPE — see `FAMILIES_FOR_SCOPE`.
                  Offering a group measurement on a whole-run gate authored a
                  rule that reports `not_applicable` on every run for ever. */}
              <select
                className={INPUT}
                value={family}
                onChange={(e) => setFamily(e.target.value as typeof family)}
              >
                {FAMILIES_FOR_SCOPE[scope].map((value) => (
                  <option key={value} value={value}>
                    {FAMILY_LABELS[value]}
                  </option>
                ))}
              </select>
              {/* The one thing neither group name says out loud. */}
              {FAMILY_EXAMPLE[family] !== undefined && (
                <span className="font-normal text-[12px] leading-snug text-muted">
                  {FAMILY_EXAMPLE[family]}
                </span>
              )}
            </label>
            <label className="flex flex-col gap-1.5 text-[13px] font-medium">
              Statistic
              {/* A datalist, not a select: the evaluator accepts ANY percentile
                  in (0, 100), so a closed list would refuse p99.95 while the
                  engine answers it. The suggestions cover what is reached for;
                  the schema decides what is legal. */}
              <input
                id={fieldId('metric')}
                aria-invalid={formError?.field === 'metric' || undefined}
                aria-describedby={formError?.field === 'metric' ? FORM_ERROR_ID : undefined}
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
              {/* THE UNIT IS PART OF THE LABEL, not a placeholder. `error_rate`
                  is a fraction while every other screen renders it as a
                  percentage, so an author who types 1 for "one percent" builds
                  a gate meaning 100% that no run can ever breach — valid,
                  evaluated, and permanently PASSED. A placeholder vanishes the
                  moment they type; the label is still there when they choose
                  the number. */}
              {/* THE AUTHORING UNIT, which for a fraction metric is now a
                  PERCENTAGE rather than the stored fraction. See `authorUnit`
                  above — the conversion moved out of the author's head and
                  into `percentToFraction`. */}
              Limit{authorUnit === null ? '' : ` (${authorUnit})`}
              <input
                id={fieldId('threshold')}
                className={INPUT}
                inputMode="decimal"
                aria-invalid={formError?.field === 'threshold' || undefined}
                /* BOTH, WHEN BOTH APPLY. This field is the one place two
                   messages can be live at once — the fraction warning above
                   100% and a refusal from the submit — and
                   `aria-describedby` takes a LIST, so replacing one with the
                   other would silently drop whichever came second. */
                aria-describedby={
                  [
                    thresholdWarning === null ? null : 'rule-threshold-warning',
                    formError?.field === 'threshold' ? FORM_ERROR_ID : null,
                  ]
                    .filter((id) => id !== null)
                    .join(' ') || undefined
                }
                value={threshold}
                onChange={(e) => setThreshold(e.target.value)}
              />
            </label>
          </div>
          {/* Rendered only when there IS a warning, so this is never an empty
              live region a screen reader has to step through — the same rule
              `ChartActions`' copy feedback follows. */}
          {thresholdWarning !== null && (
            <p
              id="rule-threshold-warning"
              role="status"
              className="text-[13px] leading-snug"
              /* INLINE, not a `text-status-pending` utility: the status colours
                 are declared on `:root` rather than inside `@theme inline`, so
                 Tailwind generates no utility for them and the class would emit
                 nothing at all — silently, which tokens.test.ts exists to catch
                 elsewhere. `StatTile` and `RunList` reference them this same
                 way. */
              style={{ color: 'var(--color-status-pending)' }}
            >
              {thresholdWarning}
            </p>
          )}

          {/* ═══ ONE BLOCK, AND THE INVALID FIELD POINTS AT IT ═══
           *
           * Kept where it is rather than moved under each control: the fields
           * sit four to a row on a wide screen, so a sentence inside a
           * quarter-width cell wraps to four lines and shoves the grid row
           * around it. Full width, immediately above the button, with the
           * offending control carrying `aria-describedby` to it and the caret
           * already on that control. `role="alert"` stays for the case that
           * has no field to focus — an issue on a control this form does not
           * render — where the live region is the only announcement there is. */}
          {formError !== null && (
            <div
              id={FORM_ERROR_ID}
              role="alert"
              className="rounded-lg border border-default bg-sunken p-3 text-[13px]"
            >
              <p className="text-primary">{formError.title}</p>
              {formError.help !== undefined && (
                <p className="mt-1 leading-snug text-muted">{formError.help}</p>
              )}
            </div>
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

          {/* ═══ THE RULE AS A SENTENCE (review M17) ═══
           *
           * Seven controls, each individually reasonable, and none of them
           * states what the reader has actually built. Two go wrong in
           * silence: a metric whose unit was misjudged — the fraction trap
           * this form already warns about — and a comparator pointing the
           * wrong way, since `throughput at most 50/s` is a legal gate that
           * fails a run for being FAST. A sentence is the only rendering in
           * which both are obvious, because it reads as a claim that is
           * either true or absurd.
           *
           * Built from the value that would be SENT, not the one typed: for a
           * fraction metric the form takes a percentage and stores a
           * fraction, so a preview off the raw input would agree with the box
           * above it and disagree with the row it is about to create. */}
          <div
            data-testid="rule-preview"
            className="rounded-lg border border-default bg-sunken p-3 text-[13px]"
          >
            {preview === null ? (
              /* NAMES WHAT IS MISSING rather than listing everything. "Fill in
                 the metric and the threshold" was wrong for the reader whose
                 metric and threshold were already fine and whose TARGET was
                 not — which is the draft the submit refuses, and so exactly the
                 one that needed telling. */
              <p className="text-muted">{previewBlocker}</p>
            ) : (
              <p className="text-primary">{preview}</p>
            )}
            {/* WHEN IT STARTS JUDGING, which is the question an author asks
                straight after "did that save". A run is judged by the rules
                that existed when it was finalized, and a run already streaming
                keeps the set it was claimed with — `FoldState.rules` is loaded
                once per run on purpose, so that a rule edited mid-run cannot
                make a breach appear with no change in the data. */}
            <p className="mt-2 text-[12px] leading-snug text-muted">
              A new rule judges runs finished after it is added. Runs already complete keep their
              verdicts, and a run streaming right now keeps the rules it started under.
            </p>
          </div>

          <div>
            <Button type="submit" variant="primary" loading={createMutation.isPending}>
              Add rule
            </Button>
          </div>
        </form>
      </Card>

      <RulesPanel
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

/**
 * ═══ INHERITED RULES ARE A SEPARATE TABLE NOW (review M17) ═══
 *
 * On a test's page this listed the union — the test's own rules and the
 * project-wide ones it inherits — distinguished only by the words in one
 * column. The review asks for them shown separately, and the reason is that
 * they are not equally editable in the reader's mind: deleting an inherited
 * rule changes every OTHER test in the project, and a row that looks like the
 * one above it does not carry that warning.
 *
 * Split, the Applies-to column becomes a constant within each table and goes —
 * the same argument `RunList` makes for dropping the Project column on a
 * project's own list. The heading carries what the column used to say.
 */
function RulesPanel({
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
    /* ═══ THE FORM IS RIGHT THERE (review 09-13 M03) ═══
     *
     * A full `EmptyState` card told the reader to "add one above" directly
     * beneath the form for adding one. An empty state earns its size when it
     * explains an absence the reader cannot otherwise account for; this one
     * sits under the explanation AND the remedy, both already visible.
     *
     * The consequence is the part worth keeping — a project with no rules gets
     * no verdict — so it stays, as one line. */
    return (
      <p className="rounded-lg border border-default bg-sunken px-3 py-2 text-[13px] text-muted">
        No rules yet. Until this project has one, its runs complete with no release verdict.
      </p>
    );
  }

  const problem = deleteError instanceof ProblemError ? deleteError : null;
  const all = rules.data.rules;
  /* `test == null` is a project-wide rule. Nullable AND optional, and both
     read the same: null is a genuine project rule, undefined is a response
     from an API pod that predates the field, and a reader can act on neither
     difference. */
  const own = all.filter((rule) => rule.test != null);
  const inherited = all.filter((rule) => rule.test == null);

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

      {scopedToTest ? (
        <>
          <RulesTable
            items={own}
            caption={`Rules written for this test, newest first. They judge its runs and no other test’s. A disabled rule stays here but is not evaluated.`}
            label="Test SLA rules"
            emptyNote="No rule has been written for this test yet — it is judged by the project-wide rules below."
            confirming={confirming}
            onConfirming={onConfirming}
            togglingId={togglingId}
            deletingId={deletingId}
            onToggle={onToggle}
            onDelete={onDelete}
          />
          <RulesTable
            items={inherited}
            caption="Project-wide rules, which judge every test here including this one. Deleting one changes every other test in the project."
            label="Inherited SLA rules"
            emptyNote="This project has no project-wide rules, so nothing is inherited."
            confirming={confirming}
            onConfirming={onConfirming}
            togglingId={togglingId}
            deletingId={deletingId}
            onToggle={onToggle}
            onDelete={onDelete}
          />
        </>
      ) : (
        <RulesTable
          items={all}
          caption="Every SLA rule in this project, newest first. A disabled rule stays here but is not evaluated."
          label="SLA rules"
          showAppliesTo
          confirming={confirming}
          onConfirming={onConfirming}
          togglingId={togglingId}
          deletingId={deletingId}
          onToggle={onToggle}
          onDelete={onDelete}
        />
      )}
    </div>
  );
}

/** One table of rules. See `RulesPanel` for why there can be two. */
function RulesTable({
  items,
  caption,
  label,
  emptyNote,
  showAppliesTo = false,
  confirming,
  onConfirming,
  togglingId,
  deletingId,
  onToggle,
  onDelete,
}: {
  readonly items: readonly SlaRule[];
  readonly caption: string;
  readonly label: string;
  /** Shown instead of the table when this group is empty. Splitting one list
   *  in two creates a state neither half had: a group with no rows, which is
   *  information rather than an error. */
  readonly emptyNote?: string;
  /** Only on the project-wide list, where the column varies. Inside a group it
   *  would be the same word on every row. */
  readonly showAppliesTo?: boolean;
  readonly confirming: string | null;
  readonly onConfirming: (id: string | null) => void;
  readonly togglingId?: string;
  readonly deletingId?: string;
  readonly onToggle: (ruleId: string, enabled: boolean) => void;
  readonly onDelete: (ruleId: string) => void;
}) {
  if (items.length === 0) {
    return emptyNote === undefined ? null : (
      <p className="rounded-lg border border-default bg-sunken p-3 text-[13px] leading-relaxed text-muted">
        {emptyNote}
      </p>
    );
  }

  return (
      <TableFrame caption={caption} label={label}>
        <table className={TABLE}>
          <caption className="sr-only">{caption}</caption>
          <thead className={THEAD}>
            <tr>
              <th className={TH}>Name</th>
              {showAppliesTo && <th className={TH}>Applies to</th>}
              <th className={TH}>Rule</th>
              <th className={TH}>Status</th>
              <th className={TH}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {items.map((rule) => (
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
                {showAppliesTo && (
                  <td data-testid="rule-applies-to" className={TD}>
                    {rule.test == null ? (
                      <span className="text-muted">Every test</span>
                    ) : (
                      rule.test.name
                    )}
                  </td>
                )}
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
