# Packages as first-class sources — design

Backlog item #8 of the Gatling Enterprise comparison. A **package** is a
project's named, reusable Gatling artifact: uploaded once, run many times,
replaced by uploading a new build, and deleted when nothing is running from it.

## Why

Today a package is not a thing. Every on-prem run uploads its jar again as a
new `runner_artifact` row tied to that one job, and only a retry reuses it. The
developer database holds **9 artifact rows with one SHA-256 between them** — the
same jar stored nine times. A reader cannot see what has been uploaded, cannot
start a run without re-uploading, and CI cannot push a new build anywhere but
into a run.

## What Gatling Enterprise does — measured, 2026-10-02

Read from the user's own cloud.gatling.io account, read-only, through Claude in
Chrome (navigation, menus and dialogs opened and cancelled; nothing created,
uploaded, saved or deleted), plus Gatling's own documentation page "Package
configuration".

| Surface | Gatling Enterprise |
|---|---|
| Where | Sources › **Packages** (beside Git repositories), org-wide, "Leader role or higher" |
| Columns | **Name** with a copyable `package_…` id · **Format** (`JVM`/`JS` badge) · **Team** (links to the team) · **Tests** (a count; hover says "1 test linked") · **Filename** (name, size `1.79 MB`, Gatling-version badge `3.15.1`) · **Last update** (`15/08/2026 17:28:35 GMT+5:30`), newest first |
| Toolbar | **Create**, search by name, rows per page 10–50, pagination; sort on Name, Format, Team, Filename, Last update; filters on Name, Format, Filename |
| Row actions | **Upload** button; ⋮ menu: **Edit** (Name and Team only), **Create test from package** (`/simulations/create?pkgId=…`), **Delete** |
| Delete | disabled while used, with the tooltip "This package cannot be deleted because it is used by 1 test" |
| Create | Name, Team, and an **optional** single `.jar` or `.zip` "packaged with Gatling Enterprise plugin" |
| Format | assigned from the language (JVM or JS) and **cannot change**: "a JS package cannot replace a JVM package: you have to create a new package" |
| Upload | **replaces** the file; no version history. Also by API: `PUT /api/public/artifacts/<PACKAGE_ID>/content?filename=…` with a token holding the Packages permission |
| In a test | a test is a saved launch configuration; step 1 is "Select your package and simulation": a **Package** dropdown (format, name, team), then a **Simulation** dropdown listing the classes inside that package (`--Choose a simulation--`, `example.BasicSimulation`) |
| Tests list | a **Source** column, `JVM BasicSimulation`, linking to `/sources/packages?search=BasicSimulation` |

## Decisions (the user's, 2026-10-02)

1. **Upload once, run many.** Start an on-prem run by choosing a package and one
   of its simulations; CI can push a new jar to a package by API. Not the full
   Gatling Enterprise model: PerfPortal's tests stay groupings of runs, not
   launch configurations (that is its own, larger item).
2. **The existing upload-and-start request keeps working**, folded into packages.
3. **Re-upload replaces on screen and keeps the old jar underneath**, so a run, a
   retry and the Logs tab always point at the exact bytes that ran.
4. **Delete is refused only while a run of the package is queued or running.**
5. **Approach A:** a new `package` table, with each `runner_artifact` row becoming
   one version of a package.

## Corrections to the design as discussed

Checked against the code while writing this, and recorded so the reader can see
where the spec departs from the conversation:

- **"Jobs are unchanged" was not quite true.** `runner_artifact` also holds two
  PER-JOB fields — `simulation_class` (the runner reads it from the artifact to
  build `-s <class>`) and `name` (the RUN name from the form). A version shared
  by many runs cannot hold either, so both move to `runner_job`.
- **The retention sweep has to split.** `deleteTerminalArtifactsOlderThan`
  deletes an artifact TOGETHER with its jobs and their log files once every job
  is terminal and past the window, and it never sees an artifact with no jobs —
  which is exactly what a version uploaded by `PUT` and superseded before it ran
  would be.
- **"Used by" is counted on the run, not through jobs.** Counting through
  `runner_job` would shrink silently as retention removed old jobs. `run` gains
  `package_id`, set when the runner opens the run.
- **There is no run-page surface that shows a package today**, so "shown as
  package deleted" lands where a package IS shown: the on-prem jobs table and the
  Logs line, which was written at queue time and keeps the name.

## Data

### `package` (new)

| Column | |
|---|---|
| `id uuid` | `gen_random_uuid()` |
| `org_id`, `project_id` | tenant columns, with the composite tenant FK every project-scoped table carries; `ON DELETE CASCADE` from the project |
| `name text` | 1–120 characters after trimming; **unique per project ignoring case** (`unique index on (project_id, lower(name))`) |
| `kind text` | `gatling_jar` or `gatling_bundle`, fixed at creation (`RunnerArtifactKindSchema`) |
| `current_artifact_id uuid null` | the version a run starts from; null for a package created with no file |
| `created_at`, `updated_at timestamptz` | `updated_at` is the last upload |

### `runner_artifact` — now one version of a package

- **gains `package_id uuid null`** → `package(id)` with the tenant FK,
  `ON DELETE SET NULL`. Null means the package was deleted; the row stays as the
  record of what a job ran until retention removes it.
- **gains `simulations text[] null`** — the jar manifest's `Gatling-Simulations`,
  read at upload by `readGatlingJar`, which the start path already opens to
  refuse a class the jar does not declare. Null for a runnable bundle (no such
  list) and for every backfilled row (SQL cannot open a jar).
- **`name` and `simulation_class` become nullable** and are no longer read: they
  stay populated on rows written before this change and on rows the old start
  path writes, for a rolling deploy's older pods.

### `runner_job`

- **gains `name text` and `simulation_class text`**, backfilled from the job's
  artifact. The runner builds `-s` from the job's class, the executor logs the
  job's name, and `retry`'s `INSERT … SELECT` carries both.

### `run`

- **gains `package_id uuid null`** → `package(id)`, `ON DELETE SET NULL`, with an
  index. Set by `markRunOpened` in the same statement that attaches the run to
  its job, from the job's version's package. Null for every run that did not come
  from a package (uploads, the Gradle plugin, runs from before this change).

### Backfill (the migration)

- One package per project per **filename stem** and kind
  (`gatling-gradle-plugin-demo-kotlin-main-tests.jar` →
  `gatling-gradle-plugin-demo-kotlin-main-tests`); a name already taken in the
  project gets `-2`, `-3`.
- Every existing artifact row joins its package as a version; the **newest**
  becomes current. Duplicate-content rows stay (jobs point at them) and age out
  through retention.
- `runner_job.name` / `simulation_class` copied from each job's artifact.
- `run.package_id` set for every run a runner job produced, from that job's
  version.

## Retention

The runner's sweep (`RUNNER_ARTIFACT_RETENTION_DAYS`, default 30) becomes two
passes in one transaction each:

1. **Jobs:** a terminal job whose `updated_at` is past the window is deleted with
   its events and its log file — what happens today, decoupled from its artifact.
2. **Versions:** a version is deleted with its file when it is **not current**,
   **no job references it any more**, and it was uploaded before the window.

A package's current version is never swept. A version whose package was deleted
is not current and goes in pass 2 once its jobs are gone.

## API

All under the project, tenant-checked exactly as the runner routes are (another
project's package is a 404, never a 403). Writes take a session or a token with
the `runner` scope; delete takes a session only (`SessionOnlyGuard` on the
handler, the split the tests routes already use).

| Request | |
|---|---|
| `GET /v1/projects/:slug/packages` | every package in the project, newest upload first: `id, name, kind, createdAt, updatedAt`, `current` (`artifactId, filename, bytes, sha256, gatlingVersion, simulations, uploadedAt`, or `null`), and `usage` (`tests`, `runs` — distinct over `run.package_id` — and `activeJobs`). Bearer `read` scope or a session |
| `POST /v1/projects/:slug/packages` | multipart: `metadata` `{ name, kind }` and an optional `file`. **201** with the package — created synchronously, which is the bar `openapi.integration.test.ts`'s 201 allowlist sets |
| `PUT /v1/projects/:slug/packages/:id/content?filename=` | the raw file as the body, streamed to disk under `MAX_RUNNER_ARTIFACT_BYTES`; Gatling Enterprise's own shape. Becomes the current version — or, when its SHA-256 equals an existing version of this package, that version becomes current and nothing new is stored. **200** with the package |
| `PATCH /v1/projects/:slug/packages/:id` | `{ name }` |
| `DELETE /v1/projects/:slug/packages/:id` | **204**; removes the package row and every version's FILE (rows stay as job history). Session only |
| `POST /v1/projects/:slug/runner/runs` | **two bodies on one route.** `application/json` `{ packageId, simulationClass, name, … }` (the rest of today's metadata) runs the package's current version. `multipart/form-data` is today's upload-and-start, unchanged for every caller, plus an optional `package` metadata field |

The multipart start places its jar in the package named by `package`, else by
the file's name stem (the backfill's grouping), creating it when absent — so a
CI job posting a fresh build each time gets one package with a new current
version, not a package per build. Either way the upload becomes the package's
current version — the latest build sent is what "run this package" means — and
an upload identical to an existing version of that package reuses that row and
file rather than storing the jar again.

### Errors

| Code | Status | When |
|---|---|---|
| `PACKAGE_NAME_TAKEN` | 409 | create or rename to a name the project already has (ignoring case) |
| `PACKAGE_IN_USE` | 409 | delete while a job using any of its versions is queued, claimed or running; the detail names the count |
| `PACKAGE_KIND_MISMATCH` | 400 | a bundle uploaded to a jar package, or the reverse |
| `PACKAGE_HAS_NO_FILE` | 409 | a JSON start for a package with no current version |
| `PACKAGE_DELETED` | 409 | a retry of a job whose version's package was deleted |
| `SIMULATION_CLASS_NOT_IN_ARTIFACT` | 400 | (existing) a JSON start naming a class the current version's `simulations` does not list, when that list is known |
| `RUNNER_ARTIFACT_NOT_A_JAR`, `BUNDLE_*`, `BUNDLE_TOO_LARGE` | 400 / 413 | (existing) the same checks the start path runs, applied to `POST` and `PUT` |

Every remediation names a real lever (the remediation-coverage guard), and every
operation, status and schema goes into the OpenAPI document, which the
route-coverage guard checks in both directions.

### The Logs line

The first queue event reads `Using package: '<artifact name>' (<size>)`, and that
"name" is the RUN name from the form. It names the **package** (`'<package
name>'`), which is what Gatling Enterprise's `Using package: 'no-code'` names.

## Contract (`packages/contracts`)

- `PackageSchema`, `PackageVersionSchema`, `PackageUsageSchema`,
  `PackageListResponseSchema`, `CreatePackageRequestSchema` (name, kind),
  `RenamePackageRequestSchema`.
- `RunnerStartByPackageRequestSchema` — `packageId` plus today's
  `RunnerStartMetadataSchema` fields minus `artifactKind` and `gatlingVersion`.
- `RunnerStartMetadataSchema` gains `package` (optional, 1–120).
- `RunnerJobSchema` gains `name`, `simulationClass`, `packageId` and
  `packageName`, each `.nullable().optional()` for the rolling-deploy reason the
  contract already argues; `RunnerArtifactSchema` keeps `name` and
  `simulationClass`, filled from the job, so no consumer of the start response
  breaks.

## Web

### The Packages page — `/projects/:slug/packages`

- A sixth project section, **Packages**, between *Add results* and *SLA rules*
  in `ProjectShell`'s strip.
- **Table**, Gatling Enterprise's columns without Team:
  - **Name**, with the package id behind the existing `CopyIdButton`;
  - **Format** — a badge, *Jar* or *Bundle*;
  - **Used by** — "2 tests · 9 runs" (Gatling Enterprise counts tests only;
    runs matter here because a test is a grouping);
  - **File** — filename, size and a Gatling-version badge; "No file yet" for an
    empty package;
  - **Last upload**, newest first.
- **Search by name**, client-side. No column sorts or filters: a project holds a
  handful of packages.
- **Upload** per row: picks a file and `PUT`s it, with the progress and
  processing states *Add results*' upload already has.
- **⋮ menu:** **Rename**; **New run from this package** (opens the New run form
  with `?package=<id>`); **Delete**, behind the two-step confirm. Refused, the
  item says why in TEXT ("2 runs of it are queued or running") rather than in a
  hover tooltip — `ChartActions`' rule for a disabled menu item.
- **New package** — a disclosure above the table (name, format, optional file),
  the pattern the SLA rules page settled on; open by default when the project has
  none.
- Below 768px the rows become cards, as the run list's do.

### The New run form

The **Artifact** group becomes **Package**:

- a **Package** dropdown of the project's packages that have a file
  (`name · filename · 1.79 MB · Gatling 3.15.1`), with a last option **Upload a
  new jar…** that shows today's file and type fields plus a **Package name**
  defaulting to the file's name stem;
- **Simulation** is a dropdown of the chosen package's `simulations`; free text,
  with a sentence saying why, where the list is unknown (a bundle, a backfilled
  jar, a jar being uploaded now);
- `?package=<id>` preselects; a project with no packages opens on the upload
  fields;
- the **Review** group reads back the package and the exact file;
- **Gatling version** shows only when uploading.

The on-prem **jobs table** gains a **Package** column: the name, or "Package
deleted".

## Verification

- Floors predicted from the source before any gate runs, from **188 / 2526,
  173 / 2187, 180**.
- Every new case red-verified from a checkpoint commit with the replacement count
  asserted.

| Layer | Pins |
|---|---|
| migration | backfill: one package per stem and kind, newest current, a taken name suffixed, job name/class copied, `run.package_id` set |
| persistence | name unique ignoring case; identical-content upload reuses its version; delete refused with an active job and allowed without; delete keeps version rows and nulls `package_id`; retention never sweeps a current version, sweeps a superseded one with no jobs, and still sweeps old jobs |
| api | tenancy (another project's package is a 404); scopes and session-only delete; the 201; JSON start runs the current version; multipart start groups by `package` then stem; a retry after a re-upload runs its OLD version; `PACKAGE_DELETED` on retry; OpenAPI coverage both ways |
| runner | builds `-s` from the job's class; the Logs line names the package |
| web | page columns and usage; the refused-delete reason in text; the form's dropdowns, `?package=`, the upload fallback; the jobs table's Package column |
| browser | create, upload, start a run from the package, delete refused then allowed, a phone width |

**Real Gatling run**, on the developer database with the API, worker and runner
on their own Redis index: upload the reference jar once and start two runs
without re-uploading; `PUT` a rebuilt jar and check a retry of the first job ran
its OLD version; check the Logs line names the package. Then a dispatched
cross-browser run, a CLAUDE.md entry, one PR, merged with `--merge` only when the
user says so.

## Not in this item

- Tests as launch configurations, and Gatling Enterprise's "Create test from
  package" in its literal sense.
- A visible version history, or running an older version on purpose.
- Teams, and Gatling Enterprise's Format filter and column sorts.
- A Source column on the tests catalogue — a PerfPortal test can mix runs from
  several packages; the Packages page's Used-by count is the link.
- Packages for the Gradle-plugin and upload paths, which carry no jar.
