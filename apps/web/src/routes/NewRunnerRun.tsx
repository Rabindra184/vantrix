import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type Dispatch,
  type FormEvent,
  type SetStateAction,
} from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import type {
  Package,
  RunnerArtifactKind,
  RunnerJob,
  RunnerJobListResponse,
  RunnerJobLogsResponse,
  RunnerJobStatus,
  RunnerStartByPackageRequest,
  RunnerStartMetadata,
  RunnerStartResponse,
} from '@perfportal/contracts';
import Button, { linkButtonClasses } from '../components/Button';
import Card from '../components/Card';
import FormField, { errorId, hintId, noticeId } from '../components/FormField';
import { EmptyState, ErrorState, LoadingState } from '../components/States';
import TableFrame from '../components/TableFrame';
import { ChevronLeftIcon, PlayIcon, RefreshIcon, StopIcon, UploadIcon } from '../components/icons';
import { ProblemError } from '../api/fetch';
import { fetchPackages, packagesQueryKey } from '../api/packages';
import { fetchProjects, projectsQueryKey } from '../api/projects';
import {
  cancelRunnerJob,
  fetchRunnerJobLogs,
  fetchRunnerJobs,
  runnerJobLogsQueryKey,
  retryRunnerJob,
  runnerJobsQueryKey,
  startRunnerRun,
  startRunnerRunFromPackage,
} from '../api/runner';
import { fetchProjectTests, projectTestsQueryKey } from '../api/tests';
import { formatBytes } from '../api/uploadBundle';
import { ROW, TABLE, TD, TH, THEAD, INPUT } from '../components/tableStyles';
import RunnerStatusLine from './RunnerStatusLine';
import useDocumentTitle from '../useDocumentTitle';
import { projectPath, runPath } from './paths';

type FormState = {
  name: string;
  /**
   * WHERE THE RUN'S FILE COMES FROM.
   *
   *   null      — not decided yet: the packages list has not settled. The form
   *               cannot know which fields to draw, and a guess made before the
   *               answer arrived is how a form flashes the wrong ones and
   *               switches a moment later, so it draws the Package group
   *               loading instead.
   *   'package' — start from `packageId`'s current version: a JSON start, no
   *               upload.
   *   'upload'  — send a file, filed in the package `packageName` names.
   *
   * DECIDED ONCE, WHEN THE LIST FIRST SETTLES — `package` if any package has a
   * file, else `upload` (and also `upload` when the list could not be loaded)
   * — and changed after that only by the reader. A list that refreshes later
   * (an upload creates a package) must never move the fields under somebody
   * who is part-way through filling them in; the form offers the new package
   * through `Choose an existing package` instead.
   */
  source: 'package' | 'upload' | null;
  /** The package the reader picked; '' means "the default" — the one
   *  `?package=` named if it can be run, else the first that can. */
  packageId: string;
  /** Upload mode only: the package the file is filed in. Blank means the
   *  package its filename stem names — the server's rule, not this form's. */
  packageName: string;
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
  source: null,
  packageId: '',
  packageName: '',
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

/* ======================================================================== *
 * PACKAGES — A RUN STARTS FROM ONE, AND UPLOADING A JAR IS THE LAST OPTION
 * ======================================================================== */

/** The Package select's last option: not a package, a way to make one. */
const UPLOAD_OPTION = '__upload__';

/** Said under the typed Simulation field when a package's list is UNKNOWN. */
const SIMULATIONS_UNKNOWN_NOTICE = "This package's simulations aren't known yet — type the class.";

/**
 * A package that has a file. One without cannot be started, so it is not
 * offered — a choice the reader could make and the server would refuse is the
 * defect `FAMILIES_FOR_SCOPE` exists to prevent on the rules form.
 */
type OfferedPackage = Package & { readonly current: NonNullable<Package['current']> };

function offeredPackages(items: readonly Package[]): OfferedPackage[] {
  return items.filter((item): item is OfferedPackage => item.current !== null);
}

/** `Checkout · checkout.jar · 1.8 MB · Gatling 3.15.1` — the exact file a start
 *  would run, which is what separates two packages that differ in a letter. */
function packageOptionLabel({ name, current }: OfferedPackage): string {
  const version = current.gatlingVersion ? ` · Gatling ${current.gatlingVersion}` : '';
  return `${name} · ${current.filename} · ${formatBytes(current.bytes)}${version}`;
}

/**
 * The simulations a package declares, or null when the form cannot offer a
 * choice from them.
 *
 * NULL IS "UNKNOWN", NEVER "NONE" — the contract's rule (`PackageVersionSchema`),
 * for a bundle or a jar with no manifest header. An empty list is treated the
 * same, because a dropdown with no options is a control that cannot be used,
 * and typing a class is the only way forward either way.
 */
function knownSimulations(pkg: OfferedPackage | null): readonly string[] | null {
  const list = pkg?.current.simulations ?? null;
  return list !== null && list.length > 0 ? list : null;
}

/**
 * The package an upload of `filename` is filed in when none is named: its name
 * without the extension (`.tar.gz` counted as one), at most 112 characters.
 *
 * A COPY of the server's rule, which is the authority — this only previews it,
 * in the Package name field's placeholder, so a reader can see the name
 * that WOULD be used before the start uses it. The two have to agree for the
 * preview to be true, and one table of cases pins both copies.
 *
 * THE SERVER'S RULE IS TWO STEPS, AND THIS COPIES BOTH. The start stores the
 * upload under `sanitizeFilename(name)` and takes the stem of THAT
 * (`packageNameFromFilename`, both in `apps/api/src/runner/package-files.ts`),
 * so `checkout (1).jar` is filed under `checkout _1_` — and a preview of the
 * stem alone read `checkout (1)`, a package the start never makes.
 */
function packageNameFromFile(filename: string): string {
  const stem = sanitizeFilename(filename).replace(/(\.tar\.gz|\.[^.]+)$/i, '').slice(0, 112).trim();
  return stem === '' ? 'package' : stem;
}

/**
 * The server's `sanitizeFilename`, mirrored exactly: the basename (POSIX, which
 * is what `path.basename` is on the server), every character outside letters,
 * digits, underscore, dot, hyphen and space made an underscore, and
 * `gatling-artifact` for nothing left. A browser's `File.name` carries no
 * directory, so the first step is the server's and never changes anything here.
 */
function sanitizeFilename(filename: string): string {
  const base = filename.replace(/\/+$/, '').split('/').pop() ?? '';
  return base.replace(/[^\w.\- ]/g, '_') || 'gatling-artifact';
}

/** What a submit hands the mutation: one of two requests to one route. */
type Launch =
  | { readonly kind: 'package'; readonly request: RunnerStartByPackageRequest }
  | { readonly kind: 'upload'; readonly metadata: RunnerStartMetadata; readonly artifact: File };

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

  /* ═══ WHERE THE FORM OPENS IS DECIDED BY THE PACKAGES, NOT ASSUMED ═══
   *
   * `mode` has three values on purpose:
   *
   *   loading — the packages list has not settled. The Package group draws its
   *             own loading state and nothing else about the file, because
   *             opening on the upload fields (the old form) and switching a
   *             moment later would put a file input under the pointer that
   *             vanishes as the reader reaches for it.
   *   package — a package has a file and the reader has not asked to upload.
   *   upload  — everything else: no package has a file, the list could not be
   *             loaded (a launch form must not be blocked by a dropdown it
   *             could not fill — the test picker's rule), or the reader
   *             chose `Upload a new jar…`.
   *
   * THE DECISION IS MADE DURING RENDER, NOT IN AN EFFECT, for the reason
   * `useLiveRun` resets its state that way: an effect commits one frame of the
   * undecided form first, and the whole point is that there is no frame in
   * which the wrong fields are on screen. React re-renders at once, before
   * anything is committed, and the guard (`source` is no longer null) ends it.
   *
   * THE PACKAGE IS DERIVED. `?package=<id>` preselects a package only when it
   * is among those that can be run: the Packages page builds that link from a
   * list, and by the time it is followed the package may have lost its file or
   * gone. A link naming something the form cannot offer is ignored, and the
   * first package with a file is chosen instead — the form opens usable rather
   * than on a value no option carries. And it SAYS so, in a line above the
   * select: a fallback made in silence is a form ready to queue a load test of
   * a package the reader did not choose, looking exactly like the one they
   * did. */
  const [searchParams] = useSearchParams();
  const requestedPackage = searchParams.get('package');
  const packages = useQuery({
    queryKey: packagesQueryKey(slug),
    queryFn: () => fetchPackages(slug),
    enabled: slug !== '',
  });
  const offered = useMemo(() => offeredPackages(packages.data?.items ?? []), [packages.data]);
  if (form.source === null && !packages.isPending) {
    setForm((current) => ({ ...current, source: offered.length > 0 ? 'package' : 'upload' }));
  }
  const defaultPackage = offered.find((p) => p.id === requestedPackage) ?? offered[0] ?? null;
  // An EMPTY `?package=` names nothing, so there is no link to have ignored.
  const linkIgnored =
    requestedPackage !== null && requestedPackage !== '' && !offered.some((p) => p.id === requestedPackage);
  const chosenPackage = offered.find((p) => p.id === form.packageId) ?? defaultPackage;
  const mode: 'loading' | 'package' | 'upload' =
    form.source === null
      ? 'loading'
      : form.source === 'package' && chosenPackage !== null
        ? 'package'
        : 'upload';

  /* ═══ FOCUS FOLLOWS A SWITCH BETWEEN PACKAGE AND UPLOAD ═══
   *
   * The control a reader just used is gone after either switch, so focus has to
   * be put somewhere deliberately — the first control of the mode they entered:
   * the file input (the thing uploading needs first) or the Package select.
   *
   * A REF SET BY THE HANDLERS, ACTED ON AFTER THE COMMIT. Focusing inside the
   * handler would target a control that is not rendered yet. The ref records
   * only that the READER asked for a switch, so nothing takes focus when the
   * list settles under them or the mode changes for any other reason; and it is
   * read once and cleared, so a switch that did not change the mode cannot
   * leave a stale request for a later one. */
  const focusAfterSwitch = useRef<'upload' | 'package' | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const packageSelectRef = useRef<HTMLSelectElement>(null);
  useEffect(() => {
    const wanted = focusAfterSwitch.current;
    focusAfterSwitch.current = null;
    if (wanted === 'upload' && mode === 'upload') fileInputRef.current?.focus();
    if (wanted === 'package' && mode === 'package') packageSelectRef.current?.focus();
  }, [mode]);

  /* The simulation a start will carry. From a package with a known list it is
     the reader's pick, or the FIRST of the list when they have not picked or
     their pick is not in THIS package's list — so "the first one is selected
     when the package changes" is a property of what is rendered, which a
     handler that forgets to reset something cannot break, and a list that
     changes under the reader cannot leave a value no option carries.
     Everywhere else it is what was typed. The handlers still clear the typed
     text when the package or the source changes: it belongs to what it was
     typed for. */
  const simulations = mode === 'package' ? knownSimulations(chosenPackage) : null;
  const simulationClass =
    simulations === null
      ? form.simulationClass
      : simulations.includes(form.simulationClass)
        ? form.simulationClass
        : (simulations[0] ?? '');

  const mutation = useMutation({
    mutationFn: (launch: Launch) =>
      launch.kind === 'package'
        ? startRunnerRunFromPackage(slug, launch.request)
        : startRunnerRun({ projectSlug: slug, metadata: launch.metadata, artifact: launch.artifact }),
    onSuccess: (response) => {
      setCreated(response);
      void queryClient.invalidateQueries({ queryKey: runnerJobsQueryKey(slug) });
      // An upload files its jar in a package — made on the spot when the name
      // is new — and a start from one changes that package's `usage`, so the
      // list is stale either way. It refreshes IN THE BACKGROUND: the fields
      // stay as they are (`source` was decided once) and `Choose an existing
      // package` appears when there is now one to choose.
      void queryClient.invalidateQueries({ queryKey: packagesQueryKey(slug) });
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
    // Nothing can be started until the packages list has said which kind of
    // start this is. The button is disabled meanwhile; this is the Enter key.
    if (mode === 'loading') return;
    const parsedProps = parseSystemProperties(form.systemProperties);
    if (parsedProps.kind === 'error') {
      setFormError(parsedProps.message);
      return;
    }

    // `testMode` decides whether a slug travels at all: 'default' means the
    // worker groups by simulation class, which is not the same fact as an
    // empty text box.
    const test = form.testMode !== 'default' && form.test.trim() ? form.test.trim() : undefined;

    // THE OPTIONAL KEYS ARE NAMED IN EACH LITERAL, with possibly-undefined
    // values, never spread in conditionally: a mistyped key inside
    // `...(x ? { … } : {})` is accepted by the compiler and silently never
    // sent, which is how a field once reached three submit paths and missed
    // the fourth. Written twice on purpose — a shared object would hide the
    // same typo from both literals.
    if (mode === 'package' && chosenPackage !== null) {
      setFormError(null);
      mutation.mutate({
        kind: 'package',
        request: {
          packageId: chosenPackage.id,
          simulationClass: simulationClass.trim(),
          name: form.name.trim(),
          environment: form.environment.trim() ? form.environment.trim() : undefined,
          branch: form.branch.trim() ? form.branch.trim() : undefined,
          commitSha: form.commitSha.trim() ? form.commitSha.trim() : undefined,
          test,
          javaOptions: form.javaOptions.trim() ? form.javaOptions.trim() : undefined,
          systemProperties: parsedProps.value,
        },
      });
      return;
    }

    if (artifact === null) {
      setFormError('Choose the jar or bundle this node should run.');
      return;
    }
    setFormError(null);
    mutation.mutate({
      kind: 'upload',
      artifact,
      metadata: {
        name: form.name.trim(),
        artifactKind: form.artifactKind,
        simulationClass: simulationClass.trim(),
        gatlingVersion: form.gatlingVersion.trim() ? form.gatlingVersion.trim() : undefined,
        environment: form.environment.trim() ? form.environment.trim() : undefined,
        branch: form.branch.trim() ? form.branch.trim() : undefined,
        commitSha: form.commitSha.trim() ? form.commitSha.trim() : undefined,
        test,
        javaOptions: form.javaOptions.trim() ? form.javaOptions.trim() : undefined,
        systemProperties: parsedProps.value,
        // Blank means the file's own stem, which the SERVER works out: sending
        // this form's copy of the rule would make the client the authority on
        // a name the server has to reconcile with the database anyway.
        package: form.packageName.trim() ? form.packageName.trim() : undefined,
      },
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
     is a worse failure than the clutter the disclosure removes.

     A Gatling version describes a FILE, so it neither shows nor counts outside
     upload mode: a value typed for an upload and abandoned for a package must
     not sit in the count of a disclosure that does not contain it. */
  const advancedCount = [
    form.commitSha,
    mode === 'upload' ? form.gatlingVersion : '',
    form.javaOptions,
    form.systemProperties,
  ].filter((value) => value.trim() !== '').length;

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
              more headings inside one form would make the outline claim the
              form is sections of the page rather than parts of one control.

              AND THE NUMBERS ARE GONE (review M11). "1 · Artifact", "2 ·
              Execution", "3 · Review" are "staged labels without staged
              interaction": an ordinal promises a flow that gates step 2 behind
              step 1, and this form has always shown all three at once and
              submitted in one go. The grouping is real and stays; only the
              claim that it is a sequence goes. And since clean UI PR 4 there
              are two: the third, Review, read every field back and is gone —
              see the note above Queue run. */}
          <form className="flex flex-col gap-6" onSubmit={submit}>
            <fieldset className="flex flex-col gap-4">
              {/* ═══ THE GROUP WAS "ARTIFACT" AND IS "PACKAGE" ═══
                  A run starts from one of the project's packages — a named,
                  reusable artifact — and a file is something the reader
                  uploads INTO one. The old name described the file; the
                  decision this group asks for is which package. */}
              <legend className={LEGEND}>Package</legend>

              {/* Only where the select is drawn: in upload mode there is
                  nothing "below" to choose from. Tied to the select, so a
                  screen reader landing on it hears why it holds what it does. */}
              {mode === 'package' && linkIgnored && (
                <p id="runner-package-link" className="text-[0.8125rem] leading-snug text-muted">
                  The package in this link has no file to run, or is not in this project. Choose one below.
                </p>
              )}

              {mode === 'upload' && (
                /* THE INPUT IS `sr-only`, SO THE LABEL WEARS ITS FOCUS RING.
                   The app-wide `:focus-visible` rule lands on the input, which
                   is clipped to one pixel — tabbing to the file control showed
                   nothing at all. `has-[:focus-visible]` puts the same 2px
                   `--color-ring` outline on the visible box around it. */
                <label className="flex cursor-pointer flex-col gap-2 rounded-xl border border-dashed border-default bg-sunken p-4 transition-ui hover:bg-page has-[:focus-visible]:[outline:2px_solid_var(--color-ring)] has-[:focus-visible]:outline-offset-2">
                  <span className="flex items-center gap-2 text-sm font-medium text-primary">
                    <UploadIcon className="h-4 w-4" />
                    Artifact file
                  </span>
                  <span className="text-[0.8125rem] text-muted">{artifactHint}</span>
                  <input
                    ref={fileInputRef}
                    className="sr-only"
                    type="file"
                    accept=".jar,.zip,.tgz,.tar.gz"
                    onChange={(event) => setArtifact(event.target.files?.[0] ?? null)}
                  />
                </label>
              )}

              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                {mode === 'upload' ? (
                  <FormField
                    key="artifact-kind"
                    label="Artifact type"
                    id="runner-kind"
                    hint={ARTIFACT_HINTS[form.artifactKind]}
                  >
                    <select
                      id="runner-kind"
                      className={INPUT}
                      aria-describedby={hintId('runner-kind')}
                      value={form.artifactKind}
                      onChange={update('artifactKind', setForm)}
                    >
                      <option value="gatling_jar">Gatling jar</option>
                      <option value="gatling_bundle">Runnable bundle</option>
                    </select>
                  </FormField>
                ) : (
                  /* DISTINCT KEYS for the two controls that share this slot.
                     Without them React sees a `Field` holding a `select` in
                     both branches and REUSES the DOM node, so focus on the
                     Package select silently becomes focus on `Artifact type`
                     — a native select fires `change` on ArrowDown, so a
                     keyboard user gets there just by arrowing. */
                  <FormField key="package-select" label="Package" id="runner-package">
                    <select
                      id="runner-package"
                      ref={packageSelectRef}
                      className={INPUT}
                      aria-describedby={mode === 'package' && linkIgnored ? 'runner-package-link' : undefined}
                      disabled={mode === 'loading'}
                      value={mode === 'loading' ? '' : (chosenPackage?.id ?? '')}
                      onChange={(event) => {
                        const chosen = event.target.value;
                        if (chosen === UPLOAD_OPTION) focusAfterSwitch.current = 'upload';
                        // The simulation is cleared with the package: it
                        // belongs to the package that listed it.
                        setForm((current) =>
                          chosen === UPLOAD_OPTION
                            ? { ...current, source: 'upload', simulationClass: '' }
                            : { ...current, packageId: chosen, simulationClass: '' },
                        );
                      }}
                    >
                      {mode === 'loading' ? (
                        <option value="">Loading packages…</option>
                      ) : (
                        <>
                          {offered.map((pkg) => (
                            <option key={pkg.id} value={pkg.id}>
                              {packageOptionLabel(pkg)}
                            </option>
                          ))}
                          <option value={UPLOAD_OPTION}>Upload a new jar…</option>
                        </>
                      )}
                    </select>
                  </FormField>
                )}
                <SimulationField
                  mode={mode}
                  simulations={simulations}
                  value={simulationClass}
                  onChange={(value) => setForm((current) => ({ ...current, simulationClass: value }))}
                />
              </div>

              {mode === 'upload' && (
                <div className="grid grid-cols-1 items-end gap-4 md:grid-cols-2">
                  {/* ═══ THE WEB LEVER FOR "THAT NAME IS ANOTHER KIND" ═══
                      Leaving this blank files the upload in the package its
                      file's name stem names — which is what the placeholder
                      shows. `foo.jar` after `foo.zip` has the SAME stem and a
                      different kind, so the server refuses it with a
                      remediation naming the metadata's "package" field; typing
                      a different name here is how the upload goes elsewhere. */}
                  <FormField label="Package name" id="runner-package-name" optional>
                    <input
                      id="runner-package-name"
                      className={INPUT}
                      value={form.packageName}
                      // `PackageNameSchema`'s own cap: the server refuses a
                      // longer name, so the field stops short of one.
                      maxLength={120}
                      placeholder={artifact === null ? undefined : packageNameFromFile(artifact.name)}
                      onChange={update('packageName', setForm)}
                    />
                  </FormField>
                  {offered.length > 0 && (
                    <button
                      type="button"
                      className="w-fit cursor-pointer pb-2 text-[0.8125rem] font-medium text-accent hover:underline hover:underline-offset-2"
                      onClick={() => {
                        focusAfterSwitch.current = 'package';
                        setForm((current) => ({ ...current, source: 'package', simulationClass: '' }));
                      }}
                    >
                      Choose an existing package
                    </button>
                  )}
                </div>
              )}
            </fieldset>

            <fieldset className="flex flex-col gap-4">
              <legend className={LEGEND}>Execution</legend>

              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <FormField label="Run name" id="runner-name">
                  <input id="runner-name" className={INPUT} value={form.name} onChange={update('name', setForm)} required />
                </FormField>
                <FormField label="Environment" id="runner-environment" optional>
                  <input id="runner-environment" className={INPUT} value={form.environment} onChange={update('environment', setForm)} />
                </FormField>
              </div>

              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <FormField label="Branch" id="runner-branch" optional>
                  <input id="runner-branch" className={INPUT} value={form.branch} onChange={update('branch', setForm)} />
                </FormField>
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
                    <FormField label="Commit SHA" id="runner-commit" optional>
                      <input id="runner-commit" className={INPUT} value={form.commitSha} onChange={update('commitSha', setForm)} />
                    </FormField>
                    {mode === 'upload' && (
                      <FormField label="Gatling version" id="runner-gatling-version" optional>
                        <input id="runner-gatling-version" className={INPUT} value={form.gatlingVersion} onChange={update('gatlingVersion', setForm)} />
                      </FormField>
                    )}
                  </div>

                  <FormField label="JVM options" id="runner-java-options" optional>
                    <input id="runner-java-options" className={INPUT} value={form.javaOptions} onChange={update('javaOptions', setForm)} />
                  </FormField>

                  {/* ═══ NOT EVERY SIMULATION READS THE SAME PROPERTIES ═══

                      The placeholder used to read `baseUrl=…` / `users=250`,
                      which quietly asserts that those are the target and load
                      knobs of this product. They are not: a system property is
                      whatever the simulation's own code looks up, and two
                      simulations in one project need not share a single name.
                      The hint (behind the field's ⓘ) says so; nothing on the
                      page labels any of it "target" or "load". */}
                  <FormField
                    label="System properties"
                    id="runner-system-properties"
                    optional
                    hint="One key=value per line, passed to the JVM as -Dkey=value. Which names mean anything is up to your simulation — PerfPortal does not interpret them."
                    /* A malformed line is flagged HERE, as it is typed (clean UI
                       PR 4). The Review group used to be the one place it showed
                       while it could still be fixed cheaply; the submit still
                       refuses it with the alert below. */
                    error={parsedProperties.kind === 'error' ? parsedProperties.message : undefined}
                  >
                    <textarea
                      id="runner-system-properties"
                      className={`${INPUT} min-h-28 resize-y py-2 font-mono`}
                      aria-describedby={
                        parsedProperties.kind === 'error'
                          ? `${hintId('runner-system-properties')} ${errorId('runner-system-properties')}`
                          : hintId('runner-system-properties')
                      }
                      aria-invalid={parsedProperties.kind === 'error' || undefined}
                      value={form.systemProperties}
                      onChange={update('systemProperties', setForm)}
                    />
                  </FormField>
                </div>
              </details>
            </fieldset>

            {/* ═══ NO REVIEW GROUP (clean UI PR 4) ═══
                The form is its own review. The group that read every field
                back sat between the last field and this button: the package
                select already names the package, its file and its size, the
                upload's default package name is that field's placeholder, a
                missing required field is refused where it is, and a malformed
                property is flagged under its own field. What stays is the
                error alert and Queue run, outside any group. */}
            {(formError !== null || mutation.isError) && (
              <div role="alert" className="rounded-lg border border-default bg-sunken p-3 text-[0.8125rem] text-primary">
                {formError ?? problem?.detail ?? mutationError?.message}
                {problem?.remediation && <p className="mt-1 text-muted">{problem.remediation}</p>}
              </div>
            )}

            <div className="flex flex-wrap items-center gap-3">
              <Button type="submit" variant="primary" loading={mutation.isPending} disabled={mode === 'loading'}>
                <PlayIcon className="h-3.5 w-3.5" />
                Queue run
              </Button>
            </div>
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
      <FormField
        label="Test"
        id="runner-test"
        optional
        notice="Tests couldn't be loaded — type the slug."
        hint="Lower case, hyphens, no spaces — a slug that names no test yet creates one."
      >
        <input
          id="runner-test"
          className={INPUT}
          value={form.test}
          placeholder="checkout-soak"
          aria-describedby={`${noticeId('runner-test')} ${hintId('runner-test')}`}
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
      </FormField>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <FormField
        label="Test"
        id="runner-test"
        hint="Which test this run belongs to. The default groups runs by their simulation class."
      >
        <select
          id="runner-test"
          className={INPUT}
          value={value}
          aria-describedby={hintId('runner-test')}
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
      </FormField>

      {form.testMode === 'new' && (
        <FormField
          label="New test slug"
          id="runner-test-new"
          hint="Lower case, hyphens, no spaces. The server refuses a display name outright rather than slugifying it, which is what stops a typo becoming a second test."
        >
          <input
            id="runner-test-new"
            className={INPUT}
            value={form.test}
            placeholder="checkout-soak"
            aria-describedby={hintId('runner-test-new')}
            onChange={(event) => setForm((current) => ({ ...current, test: event.target.value }))}
            required
          />
        </FormField>
      )}
    </div>
  );
}

/* ======================================================================== *
 * WHICH SIMULATION — CHOSEN FROM THE PACKAGE'S LIST WHEN IT HAS ONE
 * ======================================================================== */

/**
 * The simulation to run: a dropdown over what the chosen package DECLARES, or
 * the typed field it replaces when that is not known.
 *
 * ═══ A TYPED CLASS IS ONLY AS GOOD AS ITS SPELLING ═══
 *
 * A jar's manifest lists its simulations, and the server refuses a class the
 * jar does not declare (`SIMULATION_CLASS_NOT_IN_ARTIFACT`) — after the start
 * has been sent. Offering the list moves that refusal to where it is free: a
 * choice the reader cannot get wrong.
 *
 * ═══ UNKNOWN IS NOT NONE ═══
 *
 * A bundle, or a jar with no manifest header, declares nothing the product can
 * read, and `simulations: null` says so. The field then degrades to typing and
 * SAYS why — a text box that appeared where a dropdown was expected, with no
 * word on it, would read as a bug. In upload mode there is no package to be
 * unknown about, so the hint is not shown and the field is the plain old one.
 *
 * Loading draws the dropdown, disabled and empty: the control the field is
 * most likely to become, rather than a text box that turns into one.
 */
function SimulationField({
  mode,
  simulations,
  value,
  onChange,
}: {
  readonly mode: 'loading' | 'package' | 'upload';
  readonly simulations: readonly string[] | null;
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  if (mode === 'loading') {
    return (
      <FormField label="Simulation" id="runner-simulation">
        <select id="runner-simulation" className={INPUT} disabled value="" onChange={() => undefined}>
          <option value="" />
        </select>
      </FormField>
    );
  }

  if (simulations !== null) {
    return (
      <FormField label="Simulation" id="runner-simulation">
        <select
          id="runner-simulation"
          className={INPUT}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        >
          {simulations.map((simulation) => (
            <option key={simulation} value={simulation}>
              {simulation}
            </option>
          ))}
        </select>
      </FormField>
    );
  }

  return (
    <FormField
      label="Simulation class"
      id="runner-simulation"
      notice={mode === 'package' ? SIMULATIONS_UNKNOWN_NOTICE : undefined}
    >
      <input
        id="runner-simulation"
        className={INPUT}
        value={value}
        placeholder={mode === 'upload' ? 'example.BasicSimulation' : undefined}
        aria-describedby={mode === 'package' ? noticeId('runner-simulation') : undefined}
        onChange={(event) => onChange(event.target.value)}
        required
      />
    </FormField>
  );
}

/* ======================================================================== *
 * RUNNER STATUS — WHAT THE OLD "NODE POLICY" PANEL CLAIMED TO BE
 * ======================================================================== */

/**
 * The runner's status beside the form — the same one line Add results draws
 * (`RunnerStatusLine`), under this page's "Runner" heading.
 */
function RunnerStatusCard({
  query,
}: {
  readonly query: UseQueryResult<RunnerJobListResponse, Error>;
}) {
  return (
    <Card headingLevel={2} title="Runner">
      <RunnerStatusLine query={query} />
    </Card>
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
  // The name, not a sentence restating it (clean-UI text rule); the e2e
  // suite finds this table by "On-prem runner jobs".
  const name = 'On-prem runner jobs';
  return (
    <div className="flex flex-col gap-4">
      <TableFrame name={name} label="On-prem runner jobs table">
        <table className={TABLE}>
          <caption className="sr-only">{name}</caption>
          <thead className={THEAD}>
            <tr>
              <th scope="col" className={TH}>Created</th>
              <th scope="col" className={TH}>Package</th>
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
                {/* THREE ANSWERS. A name; NULL, once the package was deleted
                    (the job stays and the package does not, which is worth
                    saying); or ABSENT, an API that predates packages — which
                    says nothing, and must not claim a deletion. */}
                <td className={TD}>{job.packageName ?? (job.packageId === null ? 'Package deleted' : '—')}</td>
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
                  {/* `items-start`: a column flex box stretches its children,
                      and the lone Logs button of a finished job would become
                      the cell's whole width. */}
                  <div className="flex flex-col items-start gap-1.5">
                    <RunnerJobActions
                      job={job}
                      cancelling={cancelMutation.isPending && cancelMutation.variables === job.id}
                      retrying={retryMutation.isPending && retryMutation.variables === job.id}
                      logsSelected={selectedLogJobId === job.id}
                      onCancel={() => cancelMutation.mutate(job.id)}
                      onRetry={() => retryMutation.mutate(job.id)}
                      onLogs={() => setSelectedLogJobId((current) => current === job.id ? null : job.id)}
                    />
                    {/* ═══ A REFUSED RETRY OR CANCEL SAYS SO, ON ITS OWN ROW ═══
                        Both answered in silence: a click that came back 409
                        left the row exactly as it was, with nothing on screen
                        saying the server had refused. The answer is drawn
                        under the button that asked, so it names its job by
                        where it is. An alert EXISTS only while there is one —
                        a table of N jobs must not carry N empty live regions,
                        the rule `ChartActions` records for a component drawn
                        many times on one page. */}
                    {retryMutation.isError && retryMutation.variables === job.id && (
                      <JobActionProblem action="retry" error={retryMutation.error} />
                    )}
                    {cancelMutation.isError && cancelMutation.variables === job.id && (
                      <JobActionProblem action="cancel" error={cancelMutation.error} />
                    )}
                  </div>
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
  /* ═══ NO RETRY FOR A JOB WHOSE PACKAGE WAS DELETED ═══
     A retry re-runs the job's own version, and the server refuses one whose
     package is gone (409 PACKAGE_DELETED) — so the button could only ever be
     refused. The row's own "Package deleted" cell is the reason, one column
     over. STRICTLY `null`: `undefined` is an API pod that predates packages
     and says nothing about them, and such a job keeps its Retry. */
  if ((job.status === 'failed' || job.status === 'cancelled') && job.packageId !== null) {
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

/**
 * A refused retry or cancel, in the server's own words — its `detail` and its
 * `remediation`, as the refused start above the table shows them. The first
 * line says which act it answers, because the alert sits under both kinds of
 * button and a 409 detail does not always name the verb.
 *
 * `max-w` because this lives in a table cell: an auto-layout column grows to
 * its content's widest line, and a sentence that never wrapped would push the
 * whole jobs table sideways.
 */
function JobActionProblem({
  action,
  error,
}: {
  readonly action: 'retry' | 'cancel';
  readonly error: Error;
}) {
  const problem = error instanceof ProblemError ? error : null;
  return (
    <div
      role="alert"
      className="max-w-[18rem] rounded-lg border border-default bg-sunken p-2 text-[0.75rem] leading-snug text-primary"
    >
      <p className="font-medium">
        {action === 'retry' ? 'This job could not be retried.' : 'This job could not be cancelled.'}
      </p>
      <p>{problem?.detail ?? error.message}</p>
      {problem !== null && problem.remediation !== '' && (
        <p className="mt-1 text-muted">{problem.remediation}</p>
      )}
    </div>
  );
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
    <Card headingLevel={2} title={`Runner logs · ${jobId.slice(0, 8)}`}>
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
