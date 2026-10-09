import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Package, PackageKind } from '@perfportal/contracts';
import type { ProjectAccess } from '../access/useAccess';
import Button from '../components/Button';
import Card from '../components/Card';
import CopyIdButton from '../components/CopyIdButton';
import FormField, { hintId } from '../components/FormField';
import { MoreIcon, UploadIcon } from '../components/icons';
import { SkeletonTable } from '../components/Skeleton';
import { EmptyState, ErrorState, LoadingState } from '../components/States';
import TableFrame from '../components/TableFrame';
import { INPUT, ROW, TABLE, TD, TH, THEAD, TH_ROW } from '../components/tableStyles';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../components/ui/dropdown-menu';
import { ProblemError } from '../api/fetch';
import {
  PACKAGE_ACCEPT,
  createPackage,
  deletePackage,
  fetchPackages,
  packagesQueryKey,
  renamePackage,
  uploadPackageContent,
} from '../api/packages';
import { formatBytes } from '../api/uploadBundle';
import useIsCompact from '../useIsCompact';
import { formatInstant } from './format';
import { projectNewRunnerRunPath } from './paths';
import ProjectShell from './ProjectShell';

/**
 * Packages, as a project section — backlog item #8 of the Gatling Enterprise
 * comparison.
 *
 * ═══ WHAT GATLING ENTERPRISE DRAWS, AND WHAT THIS DRAWS INSTEAD ═══
 *
 * Its Packages page is a table — Name, Format, Used by, File, Last upload,
 * Actions — with an Upload button and a row menu. This is the same table minus
 * its Team column, because this product has no teams; plus a New package
 * disclosure above it, because here a package can be made empty and given its
 * file later.
 *
 * "USED BY" IS THE REASON TO LOOK AT A PACKAGE AT ALL. A jar's name tells you
 * what it holds; what has run from it, and how often, is the question a reader
 * arrives with — and it is the answer to "can I retire this?". `0 tests · 0
 * runs` is a fact and is drawn as one, never as a blank: a package nothing has
 * run from is exactly the one that is safe to delete.
 *
 * ═══ THE TITLE COMES FROM THE SHELL ═══
 *
 * `ProjectShell` titles the document `Packages · <project>` for every section
 * but the project's own page, and a second `useDocumentTitle` here would be two
 * writers working only by the accident of effect order — the reason `RunList`
 * is told not to when it sits under one.
 *
 * `key={slug}` for the reason `ProjectRulesPage` carries one — a same-route
 * param change otherwise reuses the instance and carries a half-typed form and
 * an armed delete into a project they do not belong to. Prefixed, because
 * CLAUDE.md records two siblings keyed off the same params rendering one of
 * them four times behind a console warning nobody reads.
 */
export default function ProjectPackages() {
  return (
    <ProjectShell current="packages">
      {({ slug, access }) => (
        <PackagesPanel key={`packages:${slug}`} slug={slug} may={mayFrom(access)} />
      )}
    </ProjectShell>
  );
}

/**
 * ═══ WHAT THE READER MAY CHANGE, EACH CONTROL BY THE ACTION IT TAKES ═══
 *
 * Every role reads packages; changing one is gated, and each control asks for
 * the action the API guards it with:
 *
 *   New package, Upload, Rename   `packages:manage`
 *   Delete                        `packages:delete`
 *   New run from this package     `runner:run` — gate by destination: the
 *                                 form it opens exists to start a run
 *
 * Asked once, from the shell's answer (one question per page), and handed to
 * the table row and the phone card alike — both draw `PackageActions`, so the
 * rule lives in one place for both layouts. Hidden until known: every flag is
 * false until access is, so nothing is offered before it is. There is nothing
 * to REFUSE on this page — reading it is every role's — so a reader below
 * these sees the packages and no `NoAccess` sentence.
 */
interface May {
  readonly manage: boolean;
  readonly delete: boolean;
  readonly startRun: boolean;
}

function mayFrom(access: ProjectAccess): May {
  return {
    manage: access.can('packages:manage'),
    delete: access.can('packages:delete'),
    startRun: access.can('runner:run'),
  };
}

/** Whether a row has any action to draw at all — and so whether the Actions column has anything to hold. */
const anyAction = (may: May): boolean => may.manage || may.delete || may.startRun;

const FORMAT_LABEL: Readonly<Record<PackageKind, string>> = {
  gatling_jar: 'Jar',
  gatling_bundle: 'Bundle',
};

/** The New package select says what the thing IS; the table says what format
 *  it is in. Two words for two questions, and the table's has to fit a column. */
const FORMAT_OPTION: Readonly<Record<PackageKind, string>> = {
  gatling_jar: 'Gatling jar',
  gatling_bundle: 'Runnable bundle',
};

/** The table's accessible name. It used to be a sentence restating the
 *  section ("This project's packages: …"), printed above both layouts; under
 *  the clean-UI text rule a name is a few words and the restatement is gone. */
const TABLE_NAME = 'Packages';

/** The one row that is in an armed state, if any — see `PackagesPanel`. */
type Armed = { readonly id: string; readonly mode: 'rename' | 'delete' };

const plural = (n: number, word: string): string => `${String(n)} ${word}${n === 1 ? '' : 's'}`;

/** `2 tests · 9 runs`. Both halves always, so a package nothing has run from
 *  reads `0 tests · 0 runs` rather than an empty cell. */
const usedBy = (usage: Package['usage']): string =>
  `${plural(usage.tests, 'test')} · ${plural(usage.runs, 'run')}`;

function PackagesPanel({ slug, may }: { readonly slug: string; readonly may: May }) {
  const packages = useQuery({
    queryKey: packagesQueryKey(slug),
    queryFn: () => fetchPackages(slug),
  });
  const compact = useIsCompact();
  const [query, setQuery] = useState('');

  /**
   * Whether the creation form is open, once the reader has said so.
   *
   * `null` means they have not touched it, and only then does the default
   * below apply. A `<details>` whose `open` is recomputed from the data on
   * every render is not a default — it is a controller that shuts the form
   * under somebody the moment their first package lands. What keeps it open
   * is the `toggle` event: React's own write of the `open` attribute fires
   * one, so the choice latches `true` while the list is still empty and the
   * fallback never applies again (`ProjectRules` records the same).
   */
  const [formOpen, setFormOpen] = useState<boolean | null>(null);

  /**
   * One row armed at a time — renaming or confirming a delete — exactly as
   * `ProjectRules` arms one rule: arming a second disarms the first, so two
   * destructive confirmations are never on screen together.
   */
  const [armed, setArmed] = useState<Armed | null>(null);

  const items = packages.data?.items;
  // The empty state is a fact about a SETTLED query. `data` is undefined while
  // it is in flight, and defaulting to open then would flash the whole form
  // onto the screen and collapse it again when six packages arrived.
  const settledAndEmpty = packages.isSuccess && (items?.length ?? 0) === 0;

  const needle = query.toLowerCase();
  const visible = useMemo(
    () => (items ?? []).filter((pkg) => pkg.name.toLowerCase().includes(needle)),
    [items, needle],
  );

  const actions = anyAction(may);

  return (
    <div className="flex flex-col gap-4">
      {may.manage && (
        <Card as="div">
          <details
            open={formOpen ?? settledAndEmpty}
            onToggle={(event) => setFormOpen(event.currentTarget.open)}
            className="group"
          >
            <summary className="cursor-pointer list-none text-[0.8125rem] font-medium text-primary marker:hidden">
              {/* "New package", NOT "Create package": the submit button inside
                  carries that name, and two controls with one accessible name in
                  one form is the duplicate-name defect this repo has paid for
                  three times. */}
              New package
            </summary>
            <NewPackageForm slug={slug} />
          </details>
        </Card>
      )}

      {packages.isPending ? (
        <LoadingState label="Loading packages…">
          {/* The table's own columns: five, and Actions only with
              `anyAction` — the same test its header and rows apply. */}
          <SkeletonTable columns={5 + (actions ? 1 : 0)} rows={3} />
        </LoadingState>
      ) : packages.isError ? (
        <ErrorState
          title="The packages could not be loaded"
          detail={
            packages.error instanceof ProblemError ? packages.error.detail : packages.error.message
          }
          remediation={
            packages.error instanceof ProblemError ? packages.error.remediation : undefined
          }
        />
      ) : (items ?? []).length === 0 ? (
        /* The body points at New package above, so it is said only to a reader
           who is shown it: to anyone else "create one above" names a control
           that is not there. */
        <EmptyState
          title="No packages yet"
          body={
            may.manage
              ? 'Create one above, or start a run with a jar upload — the jar becomes a package either way.'
              : undefined
          }
        />
      ) : (
        <>
          <label className="flex max-w-sm flex-col gap-1.5 text-[0.8125rem] font-medium">
            Search packages
            <input
              type="search"
              className={INPUT}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>

          {visible.length === 0 ? (
            <p className="rounded-lg border border-default bg-sunken px-3 py-2 text-[0.8125rem] text-muted">
              No package matches “{query}”.
            </p>
          ) : compact ? (
            <section aria-label="Packages" className="flex flex-col gap-3">
              <ul className="flex flex-col gap-2">
                {visible.map((pkg) => (
                  <PackageCard
                    key={pkg.id}
                    slug={slug}
                    pkg={pkg}
                    armed={armed}
                    onArm={setArmed}
                    may={may}
                  />
                ))}
              </ul>
            </section>
          ) : (
            <TableFrame name={TABLE_NAME} label="Packages table">
              <table className={TABLE}>
                <caption className="sr-only">{TABLE_NAME}</caption>
                <thead className={THEAD}>
                  <tr>
                    <th className={TH}>Name</th>
                    <th className={TH}>Format</th>
                    <th className={TH}>Used by</th>
                    <th className={TH}>File</th>
                    <th className={TH}>Last upload</th>
                    {/* A column holds something or is not drawn: for a
                        reader offered no action, every cell would be empty. */}
                    {actions && <th className={TH}>Actions</th>}
                  </tr>
                </thead>
                <tbody>
                  {visible.map((pkg) => (
                    <PackageRow
                      key={pkg.id}
                      slug={slug}
                      pkg={pkg}
                      armed={armed}
                      onArm={setArmed}
                      may={may}
                    />
                  ))}
                </tbody>
              </table>
            </TableFrame>
          )}
        </>
      )}
    </div>
  );
}

/* ======================================================================== *
 * NEW PACKAGE
 * ======================================================================== */

function NewPackageForm({ slug }: { readonly slug: string }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [kind, setKind] = useState<PackageKind>('gatling_jar');
  const [file, setFile] = useState<File | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const fileId = useId();

  const clearFile = () => {
    setFile(null);
    if (fileInput.current !== null) fileInput.current.value = '';
  };

  const create = useMutation({
    mutationFn: () => createPackage(slug, { name: name.trim(), kind }, file),
    // Returned, so the form stays busy until the refetched list is on screen —
    // the reader sees the package they made appear, not a form that reset and
    // a list that has not caught up.
    onSuccess: () => {
      setName('');
      clearFile();
      return queryClient.invalidateQueries({ queryKey: packagesQueryKey(slug) });
    },
  });

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (name.trim() === '') return;
    create.mutate();
  };

  return (
    <form onSubmit={onSubmit} className="mt-3 flex flex-col gap-3">
      <label className="flex flex-col gap-1.5 text-[0.8125rem] font-medium">
        Name
        <input
          className={INPUT}
          value={name}
          maxLength={120}
          required
          onChange={(event) => setName(event.target.value)}
        />
      </label>

      <label className="flex flex-col gap-1.5 text-[0.8125rem] font-medium">
        Format
        <select
          className={INPUT}
          value={kind}
          onChange={(event) => {
            setKind(event.target.value as PackageKind);
            // The chosen file belonged to the OTHER format: a jar left in the
            // input under "Runnable bundle" would be refused by the server
            // after the whole upload, for a mistake the page could have undone.
            clearFile();
          }}
        >
          {(Object.keys(FORMAT_OPTION) as PackageKind[]).map((value) => (
            <option key={value} value={value}>
              {FORMAT_OPTION[value]}
            </option>
          ))}
        </select>
      </label>

      {/* ═══ A NAME IDENTIFIES, A DESCRIPTION EXPLAINS ═══
          The sentence is the field's hint: behind its ⓘ (clean UI PR 4) and
          still the input's DESCRIPTION through `aria-describedby`. Inside the
          `<label>` it once became the input's accessible name — "File
          (optional) A package can be made empty and given its first file from
          its row later." — which is review 09-13 M21's defect. */}
      <FormField
        label="File"
        id={fileId}
        optional
        hint="A package can be made empty and given its first file from its row later."
      >
        <input
          id={fileId}
          ref={fileInput}
          type="file"
          data-testid="new-package-file"
          accept={PACKAGE_ACCEPT[kind]}
          aria-describedby={hintId(fileId)}
          className="min-w-0 max-w-full text-[0.8125rem] text-primary file:mr-3 file:rounded-md file:border file:border-default file:bg-surface file:px-3 file:py-1.5 file:text-[0.8125rem] file:text-primary"
          onChange={(event) => setFile(event.target.files?.[0] ?? null)}
        />
      </FormField>

      {create.isError && <Problem error={create.error} />}

      <div>
        {/* The page's ONE primary — `Button`'s rule, and why the armed delete
            below is not one. */}
        <Button type="submit" variant="primary" loading={create.isPending}>
          Create package
        </Button>
      </div>
    </form>
  );
}

/* ======================================================================== *
 * ONE PACKAGE: A TABLE ROW ON A DESKTOP, A CARD ON A PHONE
 * ======================================================================== */

interface RowProps {
  readonly slug: string;
  readonly pkg: Package;
  readonly armed: Armed | null;
  readonly onArm: (next: Armed | null) => void;
  readonly may: May;
}

/**
 * `—`, NOT THE CREATION DATE, for a package with no file. `updatedAt` is the
 * moment a package was created until a file arrives, so printing it under
 * "Last upload" would claim an upload that never happened, one cell from
 * "No file yet".
 */
function LastUpload({ pkg }: { readonly pkg: Package }) {
  if (pkg.current === null) return <span className="text-muted">—</span>;
  return <time dateTime={pkg.updatedAt}>{formatInstant(pkg.updatedAt)}</time>;
}

function FileCell({ current }: { readonly current: Package['current'] }) {
  if (current === null) return <span className="text-muted">No file yet</span>;
  return (
    <div className="flex flex-col gap-0.5">
      <span className="break-all">{current.filename}</span>
      <span className="flex flex-wrap items-center gap-1.5 text-[0.75rem] text-muted">
        <span>{formatBytes(current.bytes)}</span>
        {current.gatlingVersion !== null && (
          <span className="rounded-md border border-default bg-sunken px-1.5 py-0.5 font-mono text-[0.6875rem] text-primary">
            {/* The word is for a screen reader: a bare "3.15.1" next to a size
                names nothing. Sighted readers get it from the column. */}
            <span className="sr-only">Gatling </span>
            {current.gatlingVersion}
          </span>
        )}
      </span>
    </div>
  );
}

/** The package id's copy button, named after its row — a page of twenty
 *  buttons all called "Copy" is the duplicate-name defect `CopyIdButton` says
 *  it exists to avoid. */
function NameCell({ pkg, size }: { readonly pkg: Package; readonly size: 'row' | 'touch' }) {
  return (
    <span className="flex min-w-0 items-center gap-1">
      <span className="font-medium break-all text-primary">{pkg.name}</span>
      <CopyIdButton value={pkg.id} label={`Copy package id ${pkg.id}`} size={size} />
    </span>
  );
}

function PackageRow({ slug, pkg, armed, onArm, may }: RowProps) {
  return (
    <tr data-testid="package-row" data-package-id={pkg.id} className={ROW}>
      <th scope="row" className={TH_ROW}>
        <NameCell pkg={pkg} size="row" />
      </th>
      <td className={TD}>{FORMAT_LABEL[pkg.kind]}</td>
      <td className={TD}>{usedBy(pkg.usage)}</td>
      <td className={TD}>
        <FileCell current={pkg.current} />
      </td>
      <td className={`${TD} whitespace-nowrap`}>
        <LastUpload pkg={pkg} />
      </td>
      {/* The cell goes with its column: `PackagesPanel` draws the Actions
          header by the same `anyAction`. */}
      {anyAction(may) && (
        <td className={TD}>
          <PackageActions slug={slug} pkg={pkg} armed={armed} onArm={onArm} may={may} />
        </td>
      )}
    </tr>
  );
}

/**
 * The same facts as a card, for a viewport under 768px — six columns do not
 * fit a phone, and a table scrolled sideways hides the one column (Actions)
 * that is the point of the row. The testids are the table row's own: a compact
 * layout is not a reason for a spec to have to know which one it is looking at.
 */
function PackageCard({ slug, pkg, armed, onArm, may }: RowProps) {
  return (
    <li
      data-testid="package-row"
      data-package-id={pkg.id}
      className="flex flex-col gap-2 rounded-xl border border-default bg-surface p-3"
    >
      <div className="flex items-start justify-between gap-2">
        <NameCell pkg={pkg} size="touch" />
        <span className="shrink-0 rounded-md border border-default bg-sunken px-1.5 py-0.5 text-[0.75rem] text-muted">
          {FORMAT_LABEL[pkg.kind]}
        </span>
      </div>
      <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-3 gap-y-1 text-[0.8125rem]">
        <dt className="text-muted">Used by</dt>
        <dd>{usedBy(pkg.usage)}</dd>
        <dt className="text-muted">File</dt>
        <dd className="min-w-0">
          <FileCell current={pkg.current} />
        </dd>
        <dt className="text-muted">Last upload</dt>
        <dd>
          <LastUpload pkg={pkg} />
        </dd>
      </dl>
      {anyAction(may) && <PackageActions slug={slug} pkg={pkg} armed={armed} onArm={onArm} may={may} />}
    </li>
  );
}

/* ======================================================================== *
 * A ROW'S ACTIONS: UPLOAD, AND A MENU OF RENAME / NEW RUN / DELETE
 * ======================================================================== */

/** A failure in the server's own words. Every `/v1` failure carries a `detail`
 *  and a `remediation`, and both are more actionable than anything invented
 *  here — the rule `States.tsx` follows. */
function Problem({ error }: { readonly error: unknown }) {
  const problem = error instanceof ProblemError ? error : null;
  return (
    <div
      role="alert"
      className="rounded-lg border border-default bg-sunken p-3 text-[0.8125rem] text-primary"
    >
      {problem?.detail ?? (error instanceof Error ? error.message : 'That did not work.')}
      {problem !== null && problem.remediation !== '' && (
        <p className="mt-1 text-muted">{problem.remediation}</p>
      )}
    </div>
  );
}

function PackageActions({
  slug,
  pkg,
  armed,
  onArm,
  may,
}: {
  readonly slug: string;
  readonly pkg: Package;
  readonly armed: Armed | null;
  readonly onArm: (next: Armed | null) => void;
  /** What the reader may do — see `May`. A control, and an armed block behind one, is drawn only with its flag. */
  readonly may: May;
}) {
  const queryClient = useQueryClient();
  /* An armed block goes with the control that arms it: a role that drops
     while a rename or a delete is open (Review Focus 3) takes the block away
     rather than leaving a Save or a Delete package the API would refuse. */
  const mode =
    armed?.id === pkg.id && (armed.mode === 'rename' ? may.manage : may.delete) ? armed.mode : null;
  const refresh = () => queryClient.invalidateQueries({ queryKey: packagesQueryKey(slug) });

  const fileInput = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  /** The latest `mode`, for an async callback that outlives the render it was
   *  made in. Written in an effect, never during render. */
  const latestMode = useRef(mode);
  useEffect(() => {
    latestMode.current = mode;
  }, [mode]);

  const [draft, setDraft] = useState(pkg.name);
  const reasonId = useId();
  const newRunReasonId = useId();

  /* The two ends of an in-flight upload. `progress` is `null` until the browser
     has reported anything, a fraction below 1 while bytes move, and 1 once they
     have all been sent — at which point the server is reading the jar's
     manifest, which is a different thing for the reader to wait for. */
  const [progress, setProgress] = useState<number | null>(null);

  const upload = useMutation({
    mutationFn: (file: File) => {
      setProgress(null);
      return uploadPackageContent(slug, pkg.id, file, setProgress);
    },
    // Returned: the status stays until the refreshed row is there to replace it.
    onSuccess: refresh,
  });

  const rename = useMutation({
    mutationFn: (name: string) => renamePackage(slug, pkg.id, name),
    onSuccess: async () => {
      await refresh();
      // Only if this row is still the armed one. A reader who armed ANOTHER row
      // while this save was in flight must not have that row disarmed, or their
      // focus taken, by the answer to a question they have moved on from — and
      // `close()` does both: it disarms whatever is armed and focuses this row.
      if (latestMode.current === 'rename') close();
    },
  });

  const remove = useMutation({
    mutationFn: () => deletePackage(slug, pkg.id),
    onSuccess: refresh,
    // A REFUSED DELETE IS NEWS ABOUT THE LIST. A 409 says a run of this package
    // is queued or running — which the menu did not know, or its Delete would
    // not have been enabled. Left alone, the menu keeps offering an enabled
    // Delete after the server has said no; refetched, it shows the reason.
    onError: refresh,
  });

  /**
   * Arms rename or delete, starting that block from NOTHING. `rename` and
   * `remove` live here, and this component never unmounts, so a refused
   * attempt's error would otherwise be waiting when the reader came back to the
   * block — an old "that name is taken" shown over an input they have not
   * touched. Every way into a block passes through here (another row's arming
   * disarms this one silently), so this is the one place the reset belongs.
   */
  function arm(next: Armed['mode']) {
    if (next === 'rename') {
      rename.reset();
      setDraft(pkg.name);
    } else {
      remove.reset();
    }
    onArm({ id: pkg.id, mode: next });
  }

  /** Leaves rename or delete, and puts focus on the one control that is still
   *  there: the block the reader was in is about to unmount under it. */
  function close() {
    onArm(null);
    trigger.current?.focus();
  }

  const active = pkg.usage.activeJobs;
  const uploading = upload.isPending;
  const sending = progress === null || progress < 1;

  const onRenameSubmit = (event: FormEvent) => {
    event.preventDefault();
    const next = draft.trim();
    if (next === '') return;
    if (next === pkg.name) {
      close();
      return;
    }
    rename.mutate(next);
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {may.manage && (
          <>
            <input
              ref={fileInput}
              type="file"
              hidden
              data-testid={`package-file-${pkg.id}`}
              accept={PACKAGE_ACCEPT[pkg.kind]}
              onChange={(event) => {
                const file = event.target.files?.[0];
                // Cleared so choosing the same file again — after fixing it — is a
                // change the browser reports.
                event.target.value = '';
                if (file !== undefined) upload.mutate(file);
              }}
            />
            {/* The accessible name CONTAINS the visible word (WCAG 2.5.3) and names
                the row, so a page of packages is not a page of buttons called
                "Upload". */}
            <Button
              size="sm"
              aria-label={`Upload a file to ${pkg.name}`}
              loading={uploading}
              onClick={() => fileInput.current?.click()}
            >
              {!uploading && <UploadIcon className="h-3.5 w-3.5" />}
              Upload
            </Button>
          </>
        )}

        {/* NEVER A MENU WITH NO ITEM LEFT IN IT — a trigger that opens onto
            nothing is a control that does nothing. Each action `anyAction`
            counts puts an item in this menu, and this component is drawn only
            when `anyAction` holds (the row's cell and the card both ask it),
            so a menu drawn here always holds at least one. */}
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            {/* NAMED AFTER ITS ROW — `ChartActions` and `ProjectRules` name
                theirs the same way, for the same reason. */}
            <button
              ref={trigger}
              type="button"
              aria-label={`${pkg.name}: package actions`}
              className="transition-ui inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted hover:bg-sunken hover:text-primary data-[state=open]:bg-sunken data-[state=open]:text-primary [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11"
            >
              <MoreIcon className="h-4 w-4" aria-hidden="true" />
            </button>
          </DropdownMenuTrigger>
          {/* NO `onCloseAutoFocus` OPT-OUT, and that is deliberate. Selecting
              Rename or Delete swaps in a block whose own control takes focus
              (`autoFocus`), and the worry is Radix handing focus back to the
              trigger AFTER that and stealing it. Its dropdown does not when the
              menu is non-modal: focus moving outside the content while it
              closes counts as an interaction outside it, and the return is
              skipped (`hasInteractedOutsideRef`, in `react-dropdown-menu`). The
              cases that wait the menu out, and a macrotask more, would notice
              Radix changing its mind; a guard written here was measured and
              was unwitnessed — removing it failed nothing. */}
          {/* Each item only with its own action (see `May`); the separator
              only between two groups that are both there. */}
          <DropdownMenuContent align="end" className="w-[17rem]">
            {may.manage && <DropdownMenuItem onSelect={() => arm('rename')}>Rename</DropdownMenuItem>}
            {/* ═══ NO NEW RUN FROM A PACKAGE WITH NOTHING TO RUN ═══
                The form only offers packages that have a file, and a link
                naming one without falls back to the first that does — so this
                item, on an empty package, opened a form ready to queue a load
                test of a package the reader did not choose. Disabled instead,
                with its reason in text tied to it: the Delete item's pattern
                below, for the same reason. Not a link while disabled — a
                disabled item that still carried an `href` would still go
                somewhere for anything that follows it.

                And not at all for a reader who may not start a run: the form
                it opens exists to start one (gate by destination). */}
            {may.startRun &&
              (pkg.current === null ? (
                <>
                  <p id={newRunReasonId} className="px-2 pb-1 text-[0.75rem] leading-snug text-muted">
                    Upload a file to it first.
                  </p>
                  <DropdownMenuItem disabled aria-describedby={newRunReasonId}>
                    New run from this package
                  </DropdownMenuItem>
                </>
              ) : (
                <DropdownMenuItem asChild>
                  <Link to={projectNewRunnerRunPath(slug, pkg.id)}>New run from this package</Link>
                </DropdownMenuItem>
              ))}
            {(may.manage || may.startRun) && may.delete && <DropdownMenuSeparator />}
            {/* ═══ THE REASON IS TEXT, NOT A TOOLTIP ═══
                `ChartActions`' rule for a disabled item. A `title` is invisible
                on touch and unreachable by keyboard, and a menu hides the item
                until it is opened, so a refusal that cannot be read is not an
                explanation. `aria-describedby` ties the line to the item it is
                about, which a bare paragraph inside a menu does not. */}
            {may.delete && (
              <>
                {active > 0 && (
                  <p id={reasonId} className="px-2 pb-1 text-[0.75rem] leading-snug text-muted">
                    {`${plural(active, 'run')} of it ${active === 1 ? 'is' : 'are'} queued or running`}
                  </p>
                )}
                <DropdownMenuItem
                  disabled={active > 0}
                  aria-describedby={active > 0 ? reasonId : undefined}
                  onSelect={() => arm('delete')}
                >
                  Delete
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* A status exists ONLY while there is one. A page of a dozen packages
          must not carry a dozen permanently-empty live regions — the rule
          `ChartActions` and `CopyIdButton` record for the same reason. */}
      {uploading && (
        <p role="status" className="text-[0.75rem] text-muted">
          {sending
            ? progress === null
              ? 'Uploading…'
              : `Uploading… ${String(Math.round(progress * 100))}%`
            : 'Processing…'}
        </p>
      )}
      {upload.isError && <Problem error={upload.error} />}

      {mode === 'rename' && (
        <form onSubmit={onRenameSubmit} className="flex flex-col gap-2">
          <input
            autoFocus
            aria-label={`New name for ${pkg.name}`}
            className={INPUT}
            value={draft}
            maxLength={120}
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => setDraft(event.target.value)}
          />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" loading={rename.isPending} disabled={draft.trim() === ''}>
              Save
            </Button>
            <Button size="sm" variant="ghost" onClick={close}>
              Cancel
            </Button>
          </div>
          {rename.isError && <Problem error={rename.error} />}
        </form>
      )}

      {mode === 'delete' && (
        <div className="flex flex-col gap-2">
          <p className="text-[0.75rem] text-muted">
            {`Delete package "${pkg.name}"? Its runs keep their history.`}
          </p>
          <div className="flex flex-wrap gap-2">
            {/* NOT `primary` — `Button`'s rule is exactly one per screen, and
                this page's is Create package. An armed confirmation that
                reached for it would be a second, and the most prominent
                control on screen would become the destructive one. `secondary`
                costs nothing: this lives inside a block the reader armed on
                purpose, under a sentence saying what it does, beside a Cancel
                that holds focus. */}
            <Button
              size="sm"
              variant="secondary"
              loading={remove.isPending}
              onClick={() => remove.mutate()}
            >
              Delete package
            </Button>
            <Button size="sm" variant="ghost" autoFocus onClick={close}>
              Cancel
            </Button>
          </div>
          {remove.isError && <Problem error={remove.error} />}
        </div>
      )}
    </div>
  );
}
