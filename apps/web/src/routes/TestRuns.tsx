import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { TestSummary } from '@perfportal/contracts';
import Button, { linkButtonClasses } from '../components/Button';
import Card from '../components/Card';
import { ChevronRightIcon, LayersIcon, TestIcon } from '../components/icons';
import { ErrorState, LoadingState } from '../components/States';
import { SkeletonTable } from '../components/Skeleton';
import { INPUT } from '../components/tableStyles';
import { ProblemError } from '../api/fetch';
import { fetchProjects, projectsQueryKey } from '../api/projects';
import {
  fetchProjectTest,
  projectTestQueryKey,
  projectTestsQueryKey,
  updateProjectTest,
} from '../api/tests';
import RunList from './RunList';
import { projectPath, projectRunsPath } from './paths';

/**
 * One test: what it is, and every run of it.
 *
 * THE PAGE IS THE RUN HISTORY. Everything above the list — breadcrumb,
 * heading, simulation class, run count — is identity, and the reason a reader
 * came here is the sequence of runs underneath, newest first. That is why the
 * rename form is behind a disclosure rather than sitting open: renaming is a
 * once-in-a-test's-life action, and a form permanently occupying the space
 * above the data would make the page about administration.
 *
 * ═══ THE `<h1>` IS OWNED HERE, NOT BY `RunList` ═══
 *
 * `RunList` draws its own page heading everywhere else. This page needs a
 * breadcrumb above the heading and a metadata strip below it, so it renders
 * the heading itself and passes `showHeading={false}` — see that prop's own
 * docstring. Two `<h1>`s in one document is not a styling problem: a
 * screen-reader user navigating by heading meets the page twice.
 *
 * `useDocumentTitle` is deliberately NOT called here. `RunList` calls it with
 * the same `heading` string this page renders, so the title is set once, by
 * one component, rather than by a parent and a child racing each other on
 * every render.
 */
export default function TestRuns() {
  const { slug = '', testSlug = '' } = useParams<{ slug: string; testSlug: string }>();
  const [renaming, setRenaming] = useState(false);

  const projects = useQuery({ queryKey: projectsQueryKey, queryFn: fetchProjects });
  const project = projects.data?.items.find((p) => p.slug === slug) ?? null;

  const test = useQuery({
    queryKey: projectTestQueryKey(slug, testSlug),
    queryFn: () => fetchProjectTest(slug, testSlug),
  });

  if (test.isPending) {
    return (
      <div className="flex flex-col gap-4">
        <Breadcrumb projectSlug={slug} projectName={project?.name ?? slug} testName={testSlug} />
        <LoadingState label="Loading this test…">
          <SkeletonTable columns={6} rows={6} />
        </LoadingState>
      </div>
    );
  }

  if (test.isError) {
    // A 404 lands here too, and it is the likeliest arrival: a link to a test
    // that has since been deleted, or a hand-edited URL. The server's own
    // words say which — `No test "checkout-smoke" in this project.` — so this
    // renders them rather than inventing a page-not-found of its own.
    const error = test.error;
    const problem = error instanceof ProblemError ? error : null;
    return (
      <div className="flex flex-col gap-4">
        <Breadcrumb projectSlug={slug} projectName={project?.name ?? slug} testName={testSlug} />
        <ErrorState
          title="This test could not be loaded"
          titleAs="h1"
          detail={problem?.detail ?? error.message}
          remediation={problem?.remediation}
          action={
            <Link to={projectPath(slug)} className={linkButtonClasses}>
              <TestIcon className="h-3.5 w-3.5" />
              All tests in this project
            </Link>
          }
        />
      </div>
    );
  }

  const row = test.data;

  const caption = (
    <>
      Every run of {row.name}, newest first. “Started” is the load test’s own start time; rows
      marked <em>ingest time</em> have not been parsed yet, so they fall back to when PerfPortal
      received the run. Focus is the first operational action to take from the row.
    </>
  );

  return (
    <div className="flex flex-col gap-4">
      <Breadcrumb projectSlug={slug} projectName={project?.name ?? slug} testName={row.name} />

      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1.5">
            <h1 className="text-xl font-semibold tracking-tight break-all sm:text-2xl">
              {row.name}
            </h1>
            {row.description !== null && row.description !== '' && (
              <p className="max-w-2xl text-[13px] leading-relaxed text-muted">{row.description}</p>
            )}
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {/* `aria-expanded`, because this button REVEALS something rather
                than navigating — without it a screen reader announces
                "Rename" with no indication that a form has just appeared
                below it.

                `aria-controls` ONLY WHILE EXPANDED. The form is unmounted when
                closed, and an `aria-controls` naming an id that is not in the
                document is a dangling reference — some assistive tech offers a
                "jump to controlled element" that then goes nowhere.
                `aria-expanded` already carries the state on its own. */}
            <Button
              size="sm"
              aria-expanded={renaming}
              aria-controls={renaming ? 'test-rename' : undefined}
              onClick={() => setRenaming((open) => !open)}
            >
              {renaming ? 'Cancel rename' : 'Rename'}
            </Button>
            {/* "Project runs", never "All runs" — the rail's own org-wide row
                already owns that name on every page. See `ProjectTests`. */}
            <Link to={projectRunsPath(slug)} className={linkButtonClasses}>
              <LayersIcon className="h-3.5 w-3.5" />
              Project runs
            </Link>
          </div>
        </div>

        {/* The same bordered chip strip `RunHeader` uses, and for the same
            reason: these are VALUES, they wear the mono face, and a divider
            between each is what says they are two facts rather than one
            sentence that lost its punctuation. */}
        <div className="grid grid-cols-1 gap-x-4 gap-y-3 rounded-lg border border-default bg-surface px-4 py-3 font-mono text-[12px] text-muted shadow-panel sm:flex sm:flex-wrap sm:items-start sm:gap-x-0 sm:gap-y-3 sm:divide-x sm:divide-default">
          <Chip name="Simulation class" label={`Simulation class: ${row.simulationClass}`}>
            {row.simulationClass}
          </Chip>
          {/* The test's WHOLE history, not a page of it: this endpoint is not
              paginated, so unlike the run list's own count this number needs
              no "on this page" caveat. */}
          <Chip name="Runs" label={`${row.runCount} ${row.runCount === 1 ? 'run' : 'runs'}`}>
            {row.runCount} {row.runCount === 1 ? 'run' : 'runs'}
          </Chip>
        </div>
      </header>

      {renaming && (
        <RenameForm
          projectSlug={slug}
          test={row}
          onDone={() => setRenaming(false)}
        />
      )}

      <RunList
        // `key` for the same reason `ProjectRuns` carries one: moving from one
        // test to another matches the SAME route, so React reuses this
        // instance and its cursor survives into a scope where it no longer
        // resolves — and `RunRepository.list` answers an unresolvable cursor
        // with an empty page, so the reader would get a blank list for no
        // visible reason. Keyed on BOTH slugs, because the project can change
        // under a test slug that happens to exist in each.
        key={`${slug}/${testSlug}`}
        projectSlug={slug}
        testSlug={testSlug}
        heading={row.name}
        showHeading={false}
        caption={caption}
        emptyBody={
          'This test exists because a run of it was parsed at some point, so an empty list here ' +
          'means those runs have since been deleted.'
        }
      />
    </div>
  );
}

/**
 * Project › test. The trailing segment is plain text with `aria-current`,
 * never a link to the page you are already on — the same rule `RunHeader`'s
 * breadcrumb follows.
 *
 * The project name falls back to its slug while `GET /v1/projects` is in
 * flight, and the test name to ITS slug in the loading and error branches
 * above, where no name has arrived and may never. Both are real identifiers
 * rather than placeholders, which is what makes the fallback honest.
 */
function Breadcrumb({
  projectSlug,
  projectName,
  testName,
}: {
  readonly projectSlug: string;
  readonly projectName: string;
  readonly testName: string;
}) {
  return (
    <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-[13px] text-muted">
      <Link
        to={projectPath(projectSlug)}
        className="transition-ui font-medium text-accent hover:underline hover:underline-offset-2"
      >
        {projectName}
      </Link>
      <ChevronRightIcon className="h-3.5 w-3.5 opacity-50" />
      <span aria-current="page" className="min-w-0 truncate">
        {testName}
      </span>
    </nav>
  );
}

/**
 * Rename, or re-describe.
 *
 * ═══ WHAT THIS FORM CANNOT CHANGE IS THE INTERESTING PART ═══
 *
 * There is no simulation-class field and no slug field, and neither is an
 * oversight. `UpdateTestRequestSchema` is `.strict()` and rejects both — the
 * class because editing it would SPLIT the test rather than rename it (every
 * future run of the old class would create a second test and start a second
 * history, silently, with the only symptom a trend line going quiet), the slug
 * because it is a URL somebody has shared. So the class is shown on the page
 * above, as a fact about the test, and not here as a field.
 *
 * AN EMPTY DESCRIPTION SENDS `null`, WHICH CLEARS IT. The contract draws that
 * distinction deliberately — `undefined` means "leave this alone" and is what
 * omitting the field says — so a reader who empties the box and saves has to
 * get the erasure they asked for rather than a silent no-op.
 */
function RenameForm({
  projectSlug,
  test,
  onDone,
}: {
  readonly projectSlug: string;
  readonly test: TestSummary;
  readonly onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(test.name);
  const [description, setDescription] = useState(test.description ?? '');

  const save = useMutation({
    mutationFn: () =>
      updateProjectTest(projectSlug, test.slug, {
        name: name.trim(),
        description: description.trim() === '' ? null : description.trim(),
      }),
    onSuccess: () => {
      // The LIST key, which is a prefix of the detail key (see `tests.ts`), so
      // one call refreshes both this page and the project's test list behind
      // it. A rename that left the list showing the old name would look like
      // it had not saved.
      void queryClient.invalidateQueries({ queryKey: projectTestsQueryKey(projectSlug) });
      onDone();
    },
  });

  const problem = save.error instanceof ProblemError ? save.error : null;
  // The same rule the server enforces, checked here so the message lands
  // beside the field rather than arriving as a 400 after a round trip.
  const nameEmpty = name.trim() === '';

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (nameEmpty) return;
    save.mutate();
  }

  return (
    <Card as="div" data-testid="test-rename">
      <form id="test-rename" aria-label="Rename this test" onSubmit={submit} className="flex flex-col gap-3">
        <div className="grid gap-3 md:grid-cols-[minmax(220px,1fr)_minmax(260px,2fr)] md:items-start">
          <label className="flex flex-col gap-1.5 text-[12px] font-medium text-muted">
            Name
            <input
              className={INPUT}
              value={name}
              maxLength={200}
              onChange={(event) => setName(event.currentTarget.value)}
            />
          </label>
          <label className="flex flex-col gap-1.5 text-[12px] font-medium text-muted">
            Description
            <input
              className={INPUT}
              value={description}
              maxLength={2000}
              placeholder="What this test covers"
              onChange={(event) => setDescription(event.currentTarget.value)}
            />
          </label>
        </div>

        <p className="text-[12px] leading-relaxed text-muted">
          The simulation class stays <code className="font-mono">{test.simulationClass}</code> — it
          is the key a parsed run is matched on, so changing it would split this test’s history
          rather than rename it. Emptying the description clears it.
        </p>

        {/* THE SAME INLINE-ERROR LOOK `ProjectRules` AND `ProjectSetup` USE —
            a bordered sunken block, not red text. Red would have to reach
            `--color-status-failed` by arbitrary value, which `tokens.test.ts`
            gates: the status palette is deliberately not published through
            `@theme`, because a `text-status-failed` utility invites use as a
            chart FILL and the fill palette is a different set of values. The
            exemption list in that gate is meant to shrink, not grow. */}
        {save.isError && (
          <div role="alert" className="rounded-lg border border-default bg-sunken p-3 text-[13px] text-primary">
            {problem?.detail ?? save.error.message}
            {problem?.remediation !== undefined && (
              <p className="mt-1 text-muted">{problem.remediation}</p>
            )}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" size="sm" variant="primary" loading={save.isPending} disabled={nameEmpty}>
            Save
          </Button>
          <Button size="sm" onClick={onDone}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  );
}

/**
 * One metadata chip, in `RunHeader`'s shape: a visible uppercase overline
 * above the value, and `role="group"` + `aria-label` on the VALUE node.
 *
 * The role is not decoration. A bare `<span>` computes to role "generic",
 * which is Name-from-PROHIBITED, so `aria-label` on one is silently ignored —
 * the same trap `RunHeader.tsx`'s own `Chip` and `NamedBadge` document at
 * length.
 */
function Chip({
  name,
  label,
  children,
}: {
  readonly name: string;
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="min-w-0 sm:px-4 sm:first:pl-0 sm:last:pr-0">
      <p className="text-[10px] font-semibold tracking-[0.1em] text-muted uppercase">{name}</p>
      <span
        role="group"
        aria-label={label}
        className="mt-1 block break-all text-[12px] text-primary"
      >
        {children}
      </span>
    </div>
  );
}
