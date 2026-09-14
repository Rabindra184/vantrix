import {
  useMemo,
  useState,
  type ChangeEvent,
  type Dispatch,
  type FormEvent,
  type ReactNode,
  type SetStateAction,
} from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import type {
  RunnerArtifactKind,
  RunnerJob,
  RunnerJobListResponse,
  RunnerJobLogsResponse,
  RunnerJobStatus,
  RunnerStartMetadata,
  RunnerStartResponse,
} from '@perfportal/contracts';
import Button, { linkButtonClasses } from '../components/Button';
import Card from '../components/Card';
import { EmptyState, ErrorState, LoadingState } from '../components/States';
import TableFrame from '../components/TableFrame';
import { ChevronLeftIcon, PlayIcon, RefreshIcon, StopIcon, UploadIcon } from '../components/icons';
import { ProblemError } from '../api/fetch';
import { fetchProjects, projectsQueryKey } from '../api/projects';
import {
  cancelRunnerJob,
  fetchRunnerJobLogs,
  fetchRunnerJobs,
  runnerJobLogsQueryKey,
  retryRunnerJob,
  runnerJobsQueryKey,
  startRunnerRun,
} from '../api/runner';
import { fetchProjectTests, projectTestsQueryKey } from '../api/tests';
import { ROW, TABLE, TD, TH, THEAD, INPUT } from '../components/tableStyles';
import { runnerReadiness, type RunnerReadinessKind } from './runnerReadiness';
import useDocumentTitle from '../useDocumentTitle';
import { projectPath, runPath } from './paths';

type FormState = {
  name: string;
  artifactKind: RunnerArtifactKind;
  simulationClass: string;
  gatlingVersion: string;
  environment: string;
  branch: string;
  commitSha: string;
  /**
   * WHICH TEST, as a mode plus a slug — review M16.
   *
   * It was one free-text field, and the review's objection is exact: a typo
   * "can silently create a different test when mistyped". The server is right
   * to accept an unknown slug (that is how a test is created at all), so no
   * validation can tell a new test from a fat-fingered existing one. Only the
   * FORM can, by making choosing an existing test a different act from
   * creating one.
   *
   *   'default'  — send nothing; the worker groups by simulation class.
   *   'existing' — `test` is a slug picked from this project's own list.
   *   'new'      — `test` is a slug the author typed, deliberately.
   */
  testMode: 'default' | 'existing' | 'new';
  test: string;
  javaOptions: string;
  systemProperties: string;
};

const initialForm: FormState = {
  name: '',
  artifactKind: 'gatling_jar',
  simulationClass: '',
  gatlingVersion: '',
  environment: '',
  branch: '',
  commitSha: '',
  testMode: 'default',
  test: '',
  javaOptions: '',
  systemProperties: '',
};

const activeRunnerStatuses = new Set<RunnerJobStatus>(['queued', 'starting', 'running', 'closing']);

/**
 * What each artifact type actually is, in the words of the command that builds
 * it.
 *
 * The form said only "Gatling jar", and the natural way to build one —
 * `gatlingEnterprisePackage`, the command Gatling's own documentation gives
 * you — produces a jar with NO Gatling framework inside it, because Gatling
 * Enterprise supplies that at execution time. Uploading it here used to fail
 * with `Could not find or load main class io.gatling.app.Gatling`, reported as
 * "Gatling finished without producing a simulation.log file". The runner lends
 * its own Gatling now, so that jar is the expected input rather than a trap —
 * and saying so is what stops the next reader building a fat jar they do not
 * need.
 */
const ARTIFACT_HINTS: Record<RunnerArtifactKind, string> = {
  gatling_jar:
    'Built by `gradlew gatlingEnterprisePackage` (or the Maven/sbt equivalent). It does not need to bundle Gatling — the runner supplies the framework.',
  gatling_bundle:
    'A .zip or .tgz holding a Gatling distribution: bin/gatling.sh beside a lib/ of jars, with your simulation among them.',
};

export default function NewRunnerRun() {
  const { slug = '' } = useParams<{ slug: string }>();
  const projects = useQuery({ queryKey: projectsQueryKey, queryFn: fetchProjects });
  const project = projects.data?.items.find((p) => p.slug === slug) ?? null;
  const title = project?.name ? `New run · ${project.name}` : 'New on-prem run';
  useDocumentTitle(title);

  if (projects.isPending) {
    return <LoadingState label="Loading project…" />;
  }

  if (projects.isError) {
    const error = projects.error;
    const problem = error instanceof ProblemError ? error : null;
    return (
      <ErrorState
        titleAs="h1"
        title="The project could not be loaded"
        detail={problem?.detail ?? error.message}
        remediation={problem?.remediation}
      />
    );
  }

  if (project === null) {
    return (
      <ErrorState
        titleAs="h1"
        title="Project not found"
        detail={`No project "${slug}" is visible to this session.`}
        action={<BackToProject slug={slug} />}
      />
    );
  }

  return <NewRunnerRunProject key={slug} slug={slug} projectName={project.name} />;
}

function NewRunnerRunProject({
  slug,
  projectName,
}: {
  readonly slug: string;
  readonly projectName: string;
}) {
  const queryClient = useQueryClient();
  const jobs = useQuery({
    queryKey: runnerJobsQueryKey(slug),
    queryFn: () => fetchRunnerJobs(slug),
    enabled: slug !== '',
    refetchInterval: (query) => hasActiveRunnerJobs(query.state.data) ? 2000 : false,
  });

  const [form, setForm] = useState<FormState>(initialForm);
  const [artifact, setArtifact] = useState<File | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [created, setCreated] = useState<RunnerStartResponse | null>(null);

  const mutation = useMutation({
    mutationFn: (metadata: RunnerStartMetadata) => {
      if (artifact === null) throw new Error('Choose a Gatling artifact before starting the run.');
      return startRunnerRun({ projectSlug: slug, metadata, artifact });
    },
    onSuccess: (response) => {
      setCreated(response);
      void queryClient.invalidateQueries({ queryKey: runnerJobsQueryKey(slug) });
    },
  });

  const artifactHint = useMemo(() => {
    if (artifact === null) return 'No artifact selected.';
    const mb = artifact.size / (1024 * 1024);
    return `${artifact.name} · ${mb < 1 ? `${Math.max(1, Math.round(artifact.size / 1024))} KB` : `${mb.toFixed(1)} MB`}`;
  }, [artifact]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setCreated(null);
    const parsedProps = parseSystemProperties(form.systemProperties);
    if (parsedProps.kind === 'error') {
      setFormError(parsedProps.message);
      return;
    }
    if (artifact === null) {
      setFormError('Choose the jar or bundle this node should run.');
      return;
    }
    setFormError(null);
    mutation.mutate({
      name: form.name.trim(),
      artifactKind: form.artifactKind,
      simulationClass: form.simulationClass.trim(),
      ...(form.gatlingVersion.trim() ? { gatlingVersion: form.gatlingVersion.trim() } : {}),
      ...(form.environment.trim() ? { environment: form.environment.trim() } : {}),
      ...(form.branch.trim() ? { branch: form.branch.trim() } : {}),
      ...(form.commitSha.trim() ? { commitSha: form.commitSha.trim() } : {}),
      // `testMode` decides whether a slug travels at all: 'default' means
      // the worker groups by simulation class, which is not the same fact
      // as an empty text box.
      ...(form.testMode !== 'default' && form.test.trim() ? { test: form.test.trim() } : {}),
      ...(form.javaOptions.trim() ? { javaOptions: form.javaOptions.trim() } : {}),
      systemProperties: parsedProps.value,
    });
  };

  const mutationError = mutation.error;
  const problem = mutationError instanceof ProblemError ? mutationError : null;

  /* Parsed for the REVIEW summary, which has to show what will actually be
     sent rather than the raw text. Submit re-parses rather than reading this,
     because the summary must never be the thing that decides whether the form
     is valid — a value shown to the reader and a value sent to the server have
     to come from one parse, and that parse belongs at the submit. */
  const parsedProperties = useMemo(
    () => parseSystemProperties(form.systemProperties),
    [form.systemProperties],
  );

  /* How many of the collapsed fields carry a value. Without it a JVM option
     typed and then forgotten sits invisible behind a closed disclosure, which
     is a worse failure than the clutter the disclosure removes. */
  const advancedCount = [form.commitSha, form.gatlingVersion, form.javaOptions, form.systemProperties]
    .filter((value) => value.trim() !== '').length;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <Link to={projectPath(slug)} className="inline-flex items-center gap-1 text-[0.8125rem] font-medium text-muted hover:text-primary">
            <ChevronLeftIcon className="h-3.5 w-3.5" />
            {projectName}
          </Link>
          <h1 className="text-xl font-semibold tracking-tight">New on-prem run</h1>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
        {/* ═══ ONE TITLE — review M11 ═══
         *
         * "New on-prem run" (the `<h1>` above), "Queue a run" (this card) and
         * "Three steps: what to run, how to run it, and what will be sent"
         * named one task three times before a reader reached a single field,
         * and the three legends below named it a fourth. The heading stays;
         * the card carries the form and says nothing.
         *
         * The `<h2>` goes with the title — `Card` draws none without one — and
         * that is the right outcome rather than a side effect: the form is not
         * a second section of this page, it IS the page, and an `<h2>`
         * repeating the `<h1>` is what a screen-reader user meets twice. */}
        <Card headingLevel={2}>
          {/* ═══ THREE GROUPS, IN THE ORDER THE DECISIONS ARE MADE (review M16)
              ═══

              The form was one flat run of eleven fields in which a JVM option
              sat between a commit SHA and a system-property textarea, so the
              basic path — pick a jar, name the class, go — was indistinguishable
              from the tuning nobody uses twice.

              `<fieldset>`/`<legend>` rather than headings: a legend groups
              CONTROLS, which is what these are, and it contributes nothing to
              the document's heading outline. This page already has an `<h1>`;
              three more headings inside one form would make the outline claim
              the form is three sections of the page rather than three parts of
              one control.

              AND THE NUMBERS ARE GONE (review M11). "1 · Artifact", "2 ·
              Execution", "3 · Review" are "staged labels without staged
              interaction": an ordinal promises a flow that gates step 2 behind
              step 1, and this form has always shown all three at once and
              submitted in one go. The grouping is real and stays; only the
              claim that it is a sequence goes. */}
          <form className="flex flex-col gap-6" onSubmit={submit}>
            <fieldset className="flex flex-col gap-4">
              <legend className={LEGEND}>Artifact</legend>

              <label className="flex cursor-pointer flex-col gap-2 rounded-xl border border-dashed border-default bg-sunken p-4 transition-ui hover:bg-page">
                <span className="flex items-center gap-2 text-sm font-medium text-primary">
                  <UploadIcon className="h-4 w-4" />
                  Artifact file
                </span>
                <span className="text-[0.8125rem] text-muted">{artifactHint}</span>
                <input
                  className="sr-only"
                  type="file"
                  accept=".jar,.zip,.tgz,.tar.gz"
                  onChange={(event) => setArtifact(event.target.files?.[0] ?? null)}
                />
              </label>

              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <Field label="Artifact type" id="runner-kind" hint={ARTIFACT_HINTS[form.artifactKind]}>
                  <select
                    id="runner-kind"
                    className={INPUT}
                    aria-describedby="runner-kind-hint"
                    value={form.artifactKind}
                    onChange={update('artifactKind', setForm)}
                  >
                    <option value="gatling_jar">Gatling jar</option>
                    <option value="gatling_bundle">Runnable bundle</option>
                  </select>
                </Field>
                <Field label="Simulation class" id="runner-simulation">
                  <input
                    id="runner-simulation"
                    className={INPUT}
                    value={form.simulationClass}
                    placeholder="example.BasicSimulation"
                    onChange={update('simulationClass', setForm)}
                    required
                  />
                </Field>
              </div>
            </fieldset>

            <fieldset className="flex flex-col gap-4">
              <legend className={LEGEND}>Execution</legend>

              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <Field label="Run name" id="runner-name">
                  <input id="runner-name" className={INPUT} value={form.name} onChange={update('name', setForm)} required />
                </Field>
                <Field label="Environment" id="runner-environment" optional>
                  <input id="runner-environment" className={INPUT} value={form.environment} onChange={update('environment', setForm)} />
                </Field>
              </div>

              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <Field label="Branch" id="runner-branch" optional>
                  <input id="runner-branch" className={INPUT} value={form.branch} onChange={update('branch', setForm)} />
                </Field>
                <TestPicker slug={slug} form={form} setForm={setForm} />
              </div>

              {/* ═══ THE TUNING, OUT OF THE WAY OF THE LAUNCH PATH ═══

                  JVM options, arbitrary system properties, a commit SHA and a
                  Gatling override are all real and all rare. The review's
                  objection was that they COMPETED with the basic path; a
                  native `<details>` costs one click to reach them and gives
                  the keyboard behaviour for free. Closed by default, and it
                  says how many of its fields are filled so a value set here
                  cannot be forgotten behind a collapsed summary. */}
              <details className="rounded-xl border border-default bg-sunken p-3" data-testid="advanced">
                <summary className="cursor-pointer list-none text-[0.8125rem] font-medium text-accent hover:underline hover:underline-offset-2">
                  Advanced{advancedCount > 0 ? ` (${advancedCount} set)` : ''}
                </summary>
                <div className="flex flex-col gap-4 pt-3">
                  <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                    <Field label="Commit SHA" id="runner-commit" optional>
                      <input id="runner-commit" className={INPUT} value={form.commitSha} onChange={update('commitSha', setForm)} />
                    </Field>
                    <Field label="Gatling version" id="runner-gatling-version" optional>
                      <input id="runner-gatling-version" className={INPUT} value={form.gatlingVersion} onChange={update('gatlingVersion', setForm)} />
                    </Field>
                  </div>

                  <Field label="JVM options" id="runner-java-options" optional>
                    <input id="runner-java-options" className={INPUT} value={form.javaOptions} onChange={update('javaOptions', setForm)} />
                  </Field>

                  {/* ═══ NOT EVERY SIMULATION READS THE SAME PROPERTIES ═══

                      The placeholder used to read `baseUrl=…` / `users=250`,
                      which quietly asserts that those are the target and load
                      knobs of this product. They are not: a system property is
                      whatever the simulation's own code looks up, and two
                      simulations in one project need not share a single name.
                      The hint says so, and the review summary below echoes
                      back exactly what was typed rather than labelling any of
                      it "target" or "load". */}
                  <Field
                    label="System properties"
                    id="runner-system-properties"
                    optional
                    hint="One key=value per line, passed to the JVM as -Dkey=value. Which names mean anything is up to your simulation — PerfPortal does not interpret them."
                  >
                    <textarea
                      id="runner-system-properties"
                      className={`${INPUT} min-h-28 resize-y py-2 font-mono`}
                      aria-describedby="runner-system-properties-hint"
                      value={form.systemProperties}
                      onChange={update('systemProperties', setForm)}
                    />
                  </Field>
                </div>
              </details>
            </fieldset>

            <fieldset className="flex flex-col gap-4">
              <legend className={LEGEND}>Review</legend>
              <ReviewSummary form={form} artifact={artifact} properties={parsedProperties} />

              {(formError !== null || mutation.isError) && (
                <div role="alert" className="rounded-lg border border-default bg-sunken p-3 text-[0.8125rem] text-primary">
                  {formError ?? problem?.detail ?? mutationError?.message}
                  {problem?.remediation && <p className="mt-1 text-muted">{problem.remediation}</p>}
                </div>
              )}

              <div className="flex flex-wrap items-center gap-3">
                <Button type="submit" variant="primary" loading={mutation.isPending}>
                  <PlayIcon className="h-3.5 w-3.5" />
                  Queue run
                </Button>
              </div>
            </fieldset>
          </form>
        </Card>

        <RunnerStatusCard query={jobs} />
      </div>

      {created !== null && <QueuedJob response={created} />}
      <RecentJobs slug={slug} query={jobs} />
    </div>
  );
}

/**
 * A group's legend. Not a heading — see the comment on the first `<fieldset>`.
 */
const LEGEND =
  'font-mono text-[0.6875rem] font-medium tracking-[0.08em] text-muted uppercase';

/* ======================================================================== *
 * WHICH TEST — CHOSEN, NOT SPELLED (review M16)
 * ======================================================================== */

/**
 * ═══ WHY A FREE-TEXT SLUG WAS A DEFECT AND NOT A SHORTCUT ═══
 *
 * The server accepts any well-formed slug, deliberately: a slug naming no test
 * yet is how a test gets created. That is right, and it means NO validation
 * can tell `checkout-soak` from `checkout-soack` — both are legal, both
 * succeed, and the second silently starts a second test whose history begins
 * at one run. The review calls this out exactly.
 *
 * So the fix is not a stricter field, it is a different control: picking from
 * this project's own tests is one act and creating a test is another, and the
 * reader chooses which they are doing before they type anything.
 *
 * ═══ THE LIST FAILING IS NOT A REASON TO BLOCK A LAUNCH ═══
 *
 * If `GET /v1/projects/:slug/tests` is unavailable the picker degrades to the
 * typed field it replaced, with a line saying why. A launch form that refuses
 * to queue a run because a dropdown could not be populated would be a worse
 * page than the one this replaces.
 */
function TestPicker({
  slug,
  form,
  setForm,
}: {
  readonly slug: string;
  readonly form: FormState;
  readonly setForm: Dispatch<SetStateAction<FormState>>;
}) {
  const tests = useQuery({
    queryKey: projectTestsQueryKey(slug),
    queryFn: () => fetchProjectTests(slug),
    enabled: slug !== '',
  });

  const NEW = '__new__';
  const value = form.testMode === 'default' ? '' : form.testMode === 'new' ? NEW : form.test;

  const onSelect = (event: ChangeEvent<HTMLSelectElement>) => {
    const chosen = event.target.value;
    setForm((current) => {
      if (chosen === '') return { ...current, testMode: 'default', test: '' };
      if (chosen === NEW) return { ...current, testMode: 'new', test: '' };
      return { ...current, testMode: 'existing', test: chosen };
    });
  };

  if (tests.isError) {
    return (
      <Field
        label="Test"
        id="runner-test"
        optional
        hint="This project’s tests could not be loaded, so the slug has to be typed. Lower case, hyphens, no spaces — a slug that names no test yet creates one."
      >
        <input
          id="runner-test"
          className={INPUT}
          value={form.test}
          placeholder="checkout-soak"
          aria-describedby="runner-test-hint"
          onChange={(event) =>
            setForm((current) => ({
              ...current,
              // Typed, so it is a deliberate name either way — the mode only
              // exists to distinguish picking from creating, and there is
              // nothing to pick from here.
              testMode: event.target.value.trim() === '' ? 'default' : 'new',
              test: event.target.value,
            }))
          }
        />
      </Field>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Field
        label="Test"
        id="runner-test"
        hint="Which test this run belongs to. The default groups runs by their simulation class."
      >
        <select
          id="runner-test"
          className={INPUT}
          value={value}
          aria-describedby="runner-test-hint"
          onChange={onSelect}
        >
          <option value="">Group by simulation class (default)</option>
          {(tests.data?.tests ?? []).map((test) => (
            <option key={test.slug} value={test.slug}>
              {test.name}
            </option>
          ))}
          <option value={NEW}>Create a new test…</option>
        </select>
      </Field>

      {form.testMode === 'new' && (
        <Field
          label="New test slug"
          id="runner-test-new"
          hint="Lower case, hyphens, no spaces. The server refuses a display name outright rather than slugifying it, which is what stops a typo becoming a second test."
        >
          <input
            id="runner-test-new"
            className={INPUT}
            value={form.test}
            placeholder="checkout-soak"
            aria-describedby="runner-test-new-hint"
            onChange={(event) => setForm((current) => ({ ...current, test: event.target.value }))}
            required
          />
        </Field>
      )}
    </div>
  );
}

/* ======================================================================== *
 * REVIEW — WHAT WILL ACTUALLY BE SENT
 * ======================================================================== */

/**
 * The third group: everything the submit will carry, read back.
 *
 * ═══ IT SUMMARISES, IT DOES NOT LABEL ═══
 *
 * The review asks to "summarize target/load values when the artifact contract
 * exposes them; do not assume every simulation uses the same properties". The
 * artifact contract exposes none — a Gatling jar declares its simulations and
 * its version, and nothing about what any of them reads — so there is nothing
 * here that can honestly be called a target or a load.
 *
 * What CAN be shown is the exact set of `-D` properties the author typed, as
 * pairs, with a line saying that the simulation decides what they mean. That
 * is a summary of the launch rather than an interpretation of it, and it is
 * also the only place a mistyped key is visible before the run starts.
 */
function ReviewSummary({
  form,
  artifact,
  properties,
}: {
  readonly form: FormState;
  readonly artifact: File | null;
  readonly properties: ReturnType<typeof parseSystemProperties>;
}) {
  /* ═══ ONLY THE ROWS THAT SAY SOMETHING — review M11 ═══
   *
   * The summary listed all eight fields always, so an untouched form showed
   * four em dashes under "Environment", "Branch", "Commit" and "JVM options" —
   * "an empty review present at once", which the finding names. A dash is not
   * a fact about this run; it is the absence of an optional value nobody has
   * chosen to set, and reading it takes a reader's attention for nothing.
   *
   * THE REQUIRED ROWS ARE NOT OPTIONAL ROWS AND DO NOT DISAPPEAR. Artifact,
   * Simulation and Run name stay whether or not they are filled, drawn as
   * MISSING — that is the whole job of this panel, to show the gap before the
   * button is pressed rather than after the server refuses. Hiding them when
   * unset would turn a checklist into a blank card at exactly the moment it is
   * most useful.
   *
   * `Test` stays too, because its default is a real answer ("grouped by
   * simulation class") rather than an absence. */
  const optional = (label: string, value: string) =>
    value.trim() === '' ? null : { label, value: value.trim() };

  const rows: readonly { label: string; value: string; missing?: boolean }[] = [
    { label: 'Artifact', value: artifact?.name ?? 'none chosen', missing: artifact === null },
    { label: 'Simulation', value: form.simulationClass.trim() || 'not set', missing: form.simulationClass.trim() === '' },
    { label: 'Run name', value: form.name.trim() || 'not set', missing: form.name.trim() === '' },
    {
      label: 'Test',
      value:
        form.testMode === 'default'
          ? 'grouped by simulation class'
          : form.test.trim() || 'not set',
      missing: form.testMode !== 'default' && form.test.trim() === '',
    },
    optional('Environment', form.environment),
    optional('Branch', form.branch),
    optional('Commit', form.commitSha),
    optional('JVM options', form.javaOptions),
  ].filter((row): row is { label: string; value: string; missing?: boolean } => row !== null);

  return (
    <div className="rounded-xl border border-default bg-sunken p-4" data-testid="review-summary">
      <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-[0.8125rem] sm:grid-cols-2">
        {rows.map((row) => (
          <div key={row.label} className="flex min-w-0 items-baseline justify-between gap-3">
            <dt className="text-muted">{row.label}</dt>
            {/* A value the submit will REFUSE is drawn as missing rather than
                as an empty cell: the summary's job is to make the gap visible
                before the button is pressed, not after the server says no. */}
            <dd
              className={`min-w-0 truncate text-right ${row.missing === true ? 'italic' : 'text-primary'}`}
              style={row.missing === true ? { color: 'var(--color-status-pending)' } : undefined}
            >
              {row.value}
            </dd>
          </div>
        ))}
      </dl>

      <div className="mt-3 border-t border-divider pt-3">
        <p className="text-[0.75rem] font-medium text-primary">System properties</p>
        {properties.kind === 'error' ? (
          // NOT a `role="alert"`: this text changes on every keystroke in the
          // textarea above, and an assertive live region that re-announces per
          // character is worse than silence. The submit's own alert is the one
          // that speaks, once, when it matters.
          <p className="mt-1 text-[0.75rem] leading-snug" style={{ color: 'var(--color-status-failed)' }}>
            {properties.message}
          </p>
        ) : Object.keys(properties.value).length === 0 ? (
          <p className="mt-1 text-[0.75rem] text-muted">None. The simulation runs on its own defaults.</p>
        ) : (
          <>
            <ul className="mt-1 flex flex-col gap-0.5">
              {Object.entries(properties.value).map(([key, value]) => (
                <li key={key} className="font-mono text-[0.75rem] text-primary">
                  -D{key}={value}
                </li>
              ))}
            </ul>
            <p className="mt-1.5 text-[0.75rem] leading-snug text-muted">
              Passed to the JVM as written. Whether a simulation reads any of these is up to its own
              code — PerfPortal does not interpret them.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

/* ======================================================================== *
 * RUNNER STATUS — WHAT THE OLD "NODE POLICY" PANEL CLAIMED TO BE
 * ======================================================================== */

/* See `runnerReadiness` for why these are the states and why none of them is
   "online". The tokens are read through `var()` because the status colours are
   declared on `:root` rather than in `@theme`, so `text-status-*` emits no
   CSS at all. */
const READINESS_COLOR: Record<RunnerReadinessKind, string> = {
  busy: 'var(--color-status-pending)',
  waiting: 'var(--color-status-pending)',
  stalled: 'var(--color-status-failed)',
  idle: 'var(--color-status-not-applicable)',
  unknown: 'var(--color-status-not-applicable)',
};

/**
 * Replaces the static "Node policy" card.
 *
 * That panel listed "Concurrency: one active job", "Artifact: jar or bundle",
 * "Report: live run" — three facts about the PRODUCT, in the place an engineer
 * looks for a fact about the machine they are about to send work to. The
 * concurrency line survives, inside the sentence where it changes what happens
 * (a run queued behind a busy node), and the other two moved to the fields
 * they describe.
 */
function RunnerStatusCard({
  query,
}: {
  readonly query: UseQueryResult<RunnerJobListResponse, Error>;
}) {
  if (query.isPending) {
    return (
      <Card headingLevel={2} title="Runner">
        <p className="text-[0.8125rem] text-muted">Checking for recent jobs…</p>
      </Card>
    );
  }

  if (query.isError) {
    /* "Could not ask" is a different claim from "nothing is there", and this
       card must not make the second when it means the first. */
    return (
      <Card headingLevel={2} title="Runner" data-testid="runner-status">
        <p className="text-[0.8125rem] font-medium" style={{ color: READINESS_COLOR.unknown }}>
          Status unavailable
        </p>
        <p className="text-[0.8125rem] leading-relaxed text-muted">
          The job list could not be loaded, so nothing is known about the runner either way. You can
          still queue a run.
        </p>
      </Card>
    );
  }

  const readiness = runnerReadiness(query.data.items);

  return (
    <Card headingLevel={2} title="Runner" data-testid="runner-status">
      <p
        className="flex items-center gap-1.5 font-mono text-[0.75rem] font-medium tracking-[0.06em] uppercase"
        style={{ color: READINESS_COLOR[readiness.kind] }}
      >
        <span aria-hidden="true">●</span>
        {readiness.headline}
      </p>
      <p className="text-[0.8125rem] leading-relaxed text-muted">{readiness.detail}</p>
      <p className="text-[0.75rem] leading-snug text-muted">
        This instance is not told when a runner connects; everything above is inferred from the jobs
        this project has queued.
      </p>
    </Card>
  );
}

function Field({
  label,
  id,
  optional = false,
  hint,
  children,
}: {
  readonly label: string;
  readonly id: string;
  readonly optional?: boolean;
  readonly hint?: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      {/* ═══ THE ACCESSIBLE NAME IS THE WHOLE LABEL, CONCATENATED ═══
       *
       * `{label}{<span>optional</span>}` has no text node between the two, so
       * the computed name was "Environmentoptional" — announced as one word,
       * and matched by nothing a test or a user would think to write. The
       * parentheses and the space are not decoration; they are what makes the
       * name a phrase.
       *
       * Still one `<label>` rather than a label plus `aria-describedby`:
       * "(optional)" qualifies WHICH field this is, not how to fill it in, and
       * a describedby is announced after a pause — too late to stop someone
       * filling in a field they could have skipped. `hint` below is the part
       * that is genuinely a description. */}
      <label htmlFor={id} className="text-[0.8125rem] font-medium text-primary">
        {label}
        {optional && <span className="ml-1 font-normal text-muted">(optional)</span>}
      </label>
      {children}
      {/* The id is derived, not passed, so a caller cannot wire
          `aria-describedby` to a hint that is not there — but the attribute
          itself belongs on the CONTROL, which lives in `children` and only the
          caller can reach. */}
      {hint !== undefined && (
        <p id={`${id}-hint`} className="text-[0.8125rem] leading-snug text-muted">
          {hint}
        </p>
      )}
    </div>
  );
}

function QueuedJob({ response }: { readonly response: RunnerStartResponse }) {
  return (
    <Card headingLevel={2} title="Run queued">
      <dl className="grid grid-cols-1 gap-3 text-[0.8125rem] sm:grid-cols-3">
        <div>
          <dt className="text-muted">Job</dt>
          <dd className="font-mono text-primary">{response.job.id.slice(0, 8)}</dd>
        </div>
        <div>
          <dt className="text-muted">Artifact</dt>
          <dd className="truncate text-primary">{response.artifact.filename}</dd>
        </div>
        <div>
          <dt className="text-muted">Status</dt>
          <dd className="text-primary">{response.job.status}</dd>
        </div>
      </dl>
      {response.job.runId !== null && (
        <Link to={runPath(response.job.runId)} className={linkButtonClasses}>
          Open live report
        </Link>
      )}
    </Card>
  );
}

function RecentJobs({ slug, query }: { readonly slug: string; readonly query: UseQueryResult<RunnerJobListResponse, Error> }) {
  const queryClient = useQueryClient();
  const [selectedLogJobId, setSelectedLogJobId] = useState<string | null>(null);
  const logs = useQuery({
    queryKey: runnerJobLogsQueryKey(slug, selectedLogJobId),
    queryFn: () => fetchRunnerJobLogs(slug, selectedLogJobId!),
    enabled: slug !== '' && selectedLogJobId !== null,
    refetchInterval: selectedLogJobId === null ? false : 2000,
  });
  const cancelMutation = useMutation({
    mutationFn: (jobId: string) => cancelRunnerJob(slug, jobId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: runnerJobsQueryKey(slug) });
    },
  });
  const retryMutation = useMutation({
    mutationFn: (jobId: string) => retryRunnerJob(slug, jobId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: runnerJobsQueryKey(slug) });
    },
  });

  if (query.isPending) return <LoadingState label="Loading runner jobs…" />;
  if (query.isError) {
    const error = query.error;
    const problem = error instanceof ProblemError ? error : null;
    return (
      <ErrorState
        title="Runner jobs could not be loaded"
        detail={problem?.detail ?? error.message}
        remediation={problem?.remediation}
      />
    );
  }
  if (query.data.items.length === 0) {
    return <EmptyState title="No on-prem runs yet" body="Queued runner jobs for this project will appear here." />;
  }
  const caption = 'Most recent on-prem runner jobs for this project.';
  return (
    <div className="flex flex-col gap-4">
      <TableFrame caption={caption} label="On-prem runner jobs table">
        <table className={TABLE}>
          <caption className="sr-only">{caption}</caption>
          <thead className={THEAD}>
            <tr>
              <th scope="col" className={TH}>Created</th>
              <th scope="col" className={TH}>Artifact</th>
              <th scope="col" className={TH}>Simulation</th>
              <th scope="col" className={TH}>Status</th>
              <th scope="col" className={TH}>Report</th>
              <th scope="col" className={TH}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {query.data.items.map(({ artifact, job }) => (
              <tr key={job.id} className={ROW}>
                <td className={TD}>{new Date(job.createdAt).toLocaleString()}</td>
                <td className={TD}>{artifact.filename}</td>
                <td className={TD}>{artifact.simulationClass}</td>
                <td className={TD}>{job.status}</td>
                <td className={TD}>
                  {job.runId === null ? (
                    <span className="text-muted">Waiting for runner</span>
                  ) : (
                    <Link to={runPath(job.runId)} className="font-medium text-accent hover:underline">
                      Open report
                    </Link>
                  )}
                </td>
                <td className={TD}>
                  <RunnerJobActions
                    job={job}
                    cancelling={cancelMutation.isPending && cancelMutation.variables === job.id}
                    retrying={retryMutation.isPending && retryMutation.variables === job.id}
                    logsSelected={selectedLogJobId === job.id}
                    onCancel={() => cancelMutation.mutate(job.id)}
                    onRetry={() => retryMutation.mutate(job.id)}
                    onLogs={() => setSelectedLogJobId((current) => current === job.id ? null : job.id)}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableFrame>
      {selectedLogJobId !== null && <RunnerLogsPanel jobId={selectedLogJobId} query={logs} />}
    </div>
  );
}

function hasActiveRunnerJobs(data: RunnerJobListResponse | undefined): boolean {
  return data?.items.some(({ job }) => activeRunnerStatuses.has(job.status)) ?? false;
}

function RunnerJobActions({
  job,
  cancelling,
  retrying,
  logsSelected,
  onCancel,
  onRetry,
  onLogs,
}: {
  readonly job: RunnerJob;
  readonly cancelling: boolean;
  readonly retrying: boolean;
  readonly logsSelected: boolean;
  readonly onCancel: () => void;
  readonly onRetry: () => void;
  readonly onLogs: () => void;
}) {
  const logsButton = (
    <Button size="sm" variant="ghost" onClick={onLogs}>
      {logsSelected ? 'Hide logs' : 'Logs'}
    </Button>
  );
  if (job.status === 'queued' || job.status === 'starting' || job.status === 'running') {
    return (
      <div className="flex flex-wrap items-center gap-1.5">
        {logsButton}
        <Button size="sm" variant="ghost" loading={cancelling} onClick={onCancel}>
          <StopIcon className="h-3.5 w-3.5" />
          Cancel
        </Button>
      </div>
    );
  }
  if (job.status === 'failed' || job.status === 'cancelled') {
    return (
      <div className="flex flex-wrap items-center gap-1.5">
        {logsButton}
        <Button size="sm" variant="ghost" loading={retrying} onClick={onRetry}>
          <RefreshIcon className="h-3.5 w-3.5" />
          Retry
        </Button>
      </div>
    );
  }
  return logsButton;
}

function RunnerLogsPanel({
  jobId,
  query,
}: {
  readonly jobId: string;
  readonly query: UseQueryResult<RunnerJobLogsResponse, Error>;
}) {
  const problem = query.error instanceof ProblemError ? query.error : null;
  return (
    <Card headingLevel={2} title="Runner logs" description={jobId.slice(0, 8)}>
      {query.isPending && <LoadingState label="Loading runner logs…" />}
      {query.isError && (
        <ErrorState
          title="Runner logs could not be loaded"
          detail={problem?.detail ?? query.error.message}
          remediation={problem?.remediation}
        />
      )}
      {query.isSuccess && (
        <div className="flex flex-col gap-2">
          {query.data.truncated && <p className="text-[0.8125rem] text-muted">Showing the latest 256 KB.</p>}
          <pre className="max-h-96 overflow-auto rounded-lg border border-default bg-sunken p-3 font-mono text-xs leading-relaxed text-primary">
            {query.data.text || 'No logs yet.'}
          </pre>
        </div>
      )}
    </Card>
  );
}

function BackToProject({ slug }: { readonly slug: string }) {
  return (
    <Link to={projectPath(slug)} className={linkButtonClasses}>
      <ChevronLeftIcon className="h-3.5 w-3.5" />
      Back to project
    </Link>
  );
}

function update<K extends keyof FormState>(
  key: K,
  setForm: Dispatch<SetStateAction<FormState>>,
) {
  return (event: ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setForm((current) => ({ ...current, [key]: event.target.value as FormState[K] }));
}

function parseSystemProperties(raw: string):
  | { kind: 'ok'; value: Record<string, string> }
  | { kind: 'error'; message: string } {
  const value: Record<string, string> = {};
  for (const [index, line] of raw.split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) {
      return { kind: 'error', message: `System property line ${index + 1} must be key=value.` };
    }
    value[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return { kind: 'ok', value };
}
