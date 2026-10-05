# Clean UI, PR 4 — the project area and forms — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add results, New on-prem run, SLA rules, API tokens, New project and Packages lose their prose under the text rule — hints behind ⓘs, one-line status, no card descriptions — and `tsc` then refuses a description under a card title.

**Architecture:** One shared `FormField` (label, ⓘ hint, visible notice/error line) and one shared `RunnerStatusLine` are built first; each page is then edited in place, one task per page; the last code task deletes `Card.description` and `ProjectShell.intro` and pins their absence with `@ts-expect-error`.

**Tech Stack:** React 19, React Router, TanStack Query, Radix Popover (`InfoTip`), Tailwind v4, Vitest + Testing Library (jsdom), Playwright.

**Spec:** `docs/superpowers/specs/2026-10-04-clean-ui-project-area-design.md` (and the programme spec's text rule, `docs/superpowers/specs/2026-10-04-clean-ui-design.md`).

## Global Constraints

- Palette, theme, tokens, fonts, routes, contracts, APIs and data do not change.
- Node 22 (`nvm use`); every gate's exit code read on its own (`cmd > file 2>&1; echo "exit=$?"`), never through a pipe.
- Status colours inline (`style={{ color: 'var(--color-status-…)' }}`); `text-status-*` utilities emit nothing.
- `InfoTip`: `label` is `About <subject>`; never inside a heading, a `<th>` or a `<label>`; its panel holds text only, never a link (the panel's focus stays on the trigger, so a link inside is not reachable by Tab).
- `<details name="add-results">` keeps its `<h2>` outside the `<summary>`; `EntryCard` testids stay derived from the title (`entry-import-results`, `entry-run-a-test`, `entry-configure-ci`).
- Copy is the spec's, verbatim, wherever the spec quotes it.
- Every new or re-pointed assertion is red-verified by a mutation with its replacement count asserted; restore with `git checkout -- <file>` only on a file with no uncommitted changes (commit a checkpoint first).
- Never `git add -A` (untracked `docs/ui-review-2026-09-13/`, `review.md`, `scripts/seed-manual-test.mjs` must never be committed); commit messages via `git commit -F -` with a quoted heredoc; no attribution lines.
- Integration and e2e run against scratch stores (scratch `DATABASE_URL`, scratch Redis index, `PERFPORTAL_E2E_PORT`), never concurrently with each other.

## Review Focus

1. **A stalled runner.** Its action ("Check a runner is running and pointed at this instance.") must be on screen, not only behind the ⓘ. Pinned in Task 2.
2. **The test field when the tests list cannot load.** It carries both a notice and a hint; both must reach the control's description, and only the notice is visible. Pinned in Task 4.
3. **A malformed system property.** The message shows under the field as it is typed and goes once the line is fixed, and the submit is still refused. Pinned in Task 4.
4. **The "Add a project-wide rule" link on a test's page.** It must go to `/projects/:slug/rules`, and nothing on the page may still say "setup page". Pinned in Task 5.
5. **Add results' accordion.** Exactly two `<details name="add-results">`, none nested in another, and in a real engine opening CI's closes Import's. Pinned in Task 3.

---

### Task 1: `FormField`, and `InfoTip` taking a description id

**Files:**
- Modify: `apps/web/src/components/InfoTip.tsx` (optional `descriptionId` prop, used instead of `useId()` when given)
- Create: `apps/web/src/components/FormField.tsx`
- Create: `apps/web/test/FormField.test.tsx`
- Modify: `apps/web/test/InfoTip.test.tsx` (one case)

**Interfaces:**
- Produces:
  - `InfoTip({ label, children, descriptionId }: { readonly label: string; readonly children: ReactNode; readonly descriptionId?: string })`. With `descriptionId`, the hidden copy carries that id, so a control's `aria-describedby` can point at the one copy rather than a second.
  - `export default function FormField(props: { readonly label: string; readonly id: string; readonly optional?: boolean; readonly hint?: string; readonly notice?: string; readonly error?: string; readonly children: ReactNode })`.
  - `export const hintId = (id: string) => \`${id}-hint\``, `noticeId` (`-notice`), `errorId` (`-error`).
- Layout: a label row (`<label htmlFor={id}>` with the `(optional)` span inside it, then `InfoTip label={\`About ${label}\`} descriptionId={hintId(id)}` beside it when `hint` is set), the children, then a visible `<p id={noticeId(id)}>` in `--color-status-pending` when `notice` is set and a visible `<p id={errorId(id)}>` in `--color-status-failed` when `error` is set. `FormField` never sets attributes on its children.
- `error` is not in the spec: it is where New on-prem run's malformed-property message moves when the Review group goes (Task 4).

- [ ] **Step 1: Write the failing tests** in `apps/web/test/FormField.test.tsx`:

```tsx
it('names the control by its label, with the optional marker inside it', () => {
  render(<FormField label="Branch" id="f-branch" optional><input id="f-branch" /></FormField>);
  expect(screen.getByRole('textbox')).toHaveAccessibleName('Branch (optional)');
});
it('puts the hint behind an info beside the label, and hands it to the control as one description', () => {
  render(
    <FormField label="Test" id="f-test" hint="Which test this run belongs to.">
      <input id="f-test" aria-describedby={hintId('f-test')} />
    </FormField>,
  );
  const input = screen.getByRole('textbox');
  expect(input).toHaveAccessibleName('Test');
  expect(input).toHaveAccessibleDescription('Which test this run belongs to.');
  const tip = screen.getByRole('button', { name: 'About Test' });
  expect(tip.closest('label')).toBeNull();
  expect(tip).toHaveAccessibleDescription('Which test this run belongs to.');
  expect(document.querySelectorAll(`[id="${hintId('f-test')}"]`)).toHaveLength(1);
  expect(document.getElementById(hintId('f-test'))).not.toBeVisible();
});
it('draws no info without a hint', () => {
  render(<FormField label="Name" id="f-name"><input id="f-name" /></FormField>);
  expect(screen.queryByRole('button')).toBeNull();
});
it('shows a notice and an error as visible lines at their own ids', () => {
  render(
    <FormField label="Test" id="f-t" notice="Tests couldn't be loaded — type the slug." error="Line 2 must be key=value.">
      <input id="f-t" aria-describedby={`${noticeId('f-t')} ${errorId('f-t')}`} />
    </FormField>,
  );
  expect(document.getElementById(noticeId('f-t'))).toBeVisible();
  expect(document.getElementById(errorId('f-t'))).toBeVisible();
  expect(screen.getByRole('textbox')).toHaveAccessibleDescription(
    "Tests couldn't be loaded — type the slug. Line 2 must be key=value.",
  );
});
```

And in `InfoTip.test.tsx`: `it('carries the description at the id it is given')` — render `<InfoTip label="About x" descriptionId="given-id">body</InfoTip>`; the trigger's `aria-describedby` is `"given-id"` and `document.getElementById('given-id')` has text `body`.

- [ ] **Step 2: Run them, expect failure**

Run: `pnpm exec vitest run apps/web/test/FormField.test.tsx apps/web/test/InfoTip.test.tsx`
Expected: FAIL — cannot resolve `../src/components/FormField`, and the InfoTip case fails on `aria-describedby`.

- [ ] **Step 3: Implement** `descriptionId` in `InfoTip.tsx` (`const generated = useId(); const id = descriptionId ?? generated;`, keeping hook order) and `FormField.tsx` as in Interfaces.

- [ ] **Step 4: Run them, expect pass**, then red-verify: drop `descriptionId={hintId(id)}` from `FormField` (the second case fails on the control's description); move the `InfoTip` inside the `<label>` (fails on `tip.closest('label')` and on the accessible name).

- [ ] **Step 5: Commit** `apps/web/src/components/InfoTip.tsx apps/web/src/components/FormField.tsx apps/web/test/FormField.test.tsx apps/web/test/InfoTip.test.tsx`.

---

### Task 2: `RunnerStatusLine`, shared by both pages

**Files:**
- Modify: `apps/web/src/routes/runnerReadiness.ts` (`detail` → `fact`; export `RUNNER_STATUS_INFO`)
- Create: `apps/web/src/routes/RunnerStatusLine.tsx`
- Create: `apps/web/test/RunnerStatusLine.test.tsx`
- Modify: `apps/web/src/routes/NewRunnerRun.tsx` (`RunnerStatusCard` ~L1200–1256: keep `Card headingLevel={2} title="Runner"`, body is `<RunnerStatusLine query={query} />`; delete `READINESS_COLOR`, the footnote and the error paragraph)
- Modify: `apps/web/src/routes/ProjectSetup.tsx` (Run a test card renders `<RunnerStatusLine query={jobs} />` first in its body; delete `EntryStatus`, `runnerStatus`, `STATUS_KIND`, `STATUS_COLOR`, and `EntryCard`'s `status` prop with its header badge and `status.note` box)
- Modify: `apps/web/test/runnerReadiness.test.ts`, `apps/web/test/NewRunnerRun.test.tsx` ("never claims a runner is available on no evidence"), `apps/web/test/ProjectSetup.test.tsx` (the runner-status `describe` and "still shows all three choices…": `entry-status` → `runner-status`)

**Interfaces:**
- Consumes: `InfoTip` (Task 1).
- Produces:
  - `RunnerReadiness = { kind; headline; fact; ahead; needsSetup }` (no `detail`).
  - `export const RUNNER_STATUS_INFO = "Inferred from this project's jobs. This instance is not told when a runner connects or leaves, so whether one is listening right now is known only once a job is claimed. A runner runs one job at a time."`
  - `export default function RunnerStatusLine({ query }: { readonly query: Pick<UseQueryResult<RunnerJobListResponse, Error>, 'isPending' | 'isError' | 'data'> })`. It renders one `<p data-testid="runner-status">`: the headline (mono, uppercase, `●`, the colour map moved from `NewRunnerRun`'s `READINESS_COLOR`), an `aria-hidden` `·`, the fact in muted text, and `InfoTip label="About runner status"` with `RUNNER_STATUS_INFO`. Pending: `Checking…` alone. Failed: headline `Status unavailable` (not-applicable colour), the fact `The job list could not be loaded`, and no ⓘ.
- Facts, verbatim (`countLabel`/`agoLabel` as today):
  - unknown: `No run queued from this project yet`
  - idle: `` `Last job finished ${agoLabel(…)}` ``
  - busy: `` `A new run waits behind ${countLabel(ahead, 'job')}` ``
  - waiting: `` `${countLabel(queued.length, 'job')} queued, none claimed yet` ``
  - stalled: `` `Queued ${agoLabel(waited)}, unclaimed. Check a runner is running and pointed at this instance.` ``

- [ ] **Step 1: Write the failing tests.** `RunnerStatusLine.test.tsx`, using the `job(status, agedMs)` fixture shape from `ProjectSetup.test.tsx`:
  - `it('says Checking… while the job list loads')`
  - `it('reports a failed list as unavailable, not as a runner state')`: text `Status unavailable` and `The job list could not be loaded`; `queryByRole('button', { name: 'About runner status' })` is null.
  - `it('states the headline and one short fact')`, over `it.each` for unknown (no jobs), busy (one `running`), waiting (one `queued` 10 s old) and idle (one `complete` 20 min old). The `runner-status` text matches `^headline\s*·\s*fact` (with the ⓘ's hidden copy excluded, i.e. read the visible spans).
  - `it('keeps a stalled runner’s action on screen')` (Review Focus 1): one `queued` job 12 min old; `getByText(/Check a runner is running and pointed at this instance/)` is visible and is not inside the hidden description.
  - `it('puts the caveat behind one info')`: the `About runner status` trigger's description matches `/inferred from this project's jobs/i`, `/not told when a runner connects/i` and `/one job at a time/i`.

  Re-point `runnerReadiness.test.ts`'s `detail` assertions to `fact` ("2 jobs", "10 minutes", "20 minutes ago"). Its idle case's `/unknown/i` moves to an assertion that `RUNNER_STATUS_INFO` says whether one is listening "is known only once a job is claimed". In `NewRunnerRun.test.tsx`, "inferred from the jobs" becomes the trigger's description. In `ProjectSetup.test.tsx`, `entry-status` becomes `runner-status`, and "distinguishes not being able to ask…" expects `The job list could not be loaded`.

- [ ] **Step 2: Run, expect failure**

Run: `pnpm exec vitest run apps/web/test/RunnerStatusLine.test.tsx apps/web/test/runnerReadiness.test.ts apps/web/test/NewRunnerRun.test.tsx apps/web/test/ProjectSetup.test.tsx`
Expected: FAIL — `RunnerStatusLine` unresolved; `fact` undefined; `runner-status` absent on Add results.

- [ ] **Step 3: Implement** the three source changes above.

- [ ] **Step 4: Run, expect pass**; red-verify: put the stalled action into `RUNNER_STATUS_INFO` instead of the fact (Review Focus 1's case fails); drop the `InfoTip` (the caveat case fails).

- [ ] **Step 5: Commit** the files listed.

---

### Task 3: Add results — each card a title and its action

**Files:**
- Modify: `apps/web/src/routes/ProjectSetup.tsx` (`EntryCard` and the three cards, ~L118–420)
- Modify: `apps/web/test/ProjectSetup.test.tsx`
- Modify: `apps/web/e2e/project-tests.spec.ts` ("opening one workflow on Add results collapses the other"; "a bundle can be uploaded from the browser and becomes a run")

**Interfaces:**
- Consumes: `RunnerStatusLine` (Task 2), `InfoTip`.
- Produces: `EntryCard({ title, icon, children, disclosure }: { readonly title: string; readonly icon: ReactNode; readonly children: ReactNode; readonly disclosure?: { readonly summary: string; readonly children: ReactNode } })`. `description` is gone. `disclosure` renders `<details name="add-results">` with a static `<summary>{summary}</summary>`.
- The cards, per the spec's Add results section:
  - **Import results:** children are `<BundleUpload slug={slug} />`. The disclosure has summary `Or post it from a terminal` and holds: the line `Needs <code>PERFPORTAL_TOKEN</code> (Completed reports) · <Link to={projectAccessPath(slug)}>Create one</Link>`, then `InfoTip label="About posting results"` with "The picker above and this command reach the same ingest pipeline. The bundle is a .tgz of the run directory Gatling wrote, simulation.log included; the response is a 202 with the run's id, and the worker parses it in the background.", then the `upload-command` `<pre>`.
  - **Run a test:** children are `RunnerStatusLine`; then, only while `runnerReadiness(items).needsSetup`, `<Link data-testid="runner-setup" to={projectAccessPath(slug)}>Create a runner token</Link>`; then the New on-prem run link button. The "streams the log" paragraph is deleted.
  - **Configure CI:** no children. The disclosure has summary `Show me how` and holds: the line `Store the token as <code>PERFPORTAL_TOKEN</code> in your pipeline secrets · <Link …>Create one</Link>` with `InfoTip label="About the CI step"` carrying "branch and commitSha let the Compare page tell a regression from a different build; both are optional.", then the `ci-command` `<pre>`, then the line `Live view while the build runs: Gradle plugin <code>dev.vantrix.gatling</code>`.

- [ ] **Step 1: Write and re-point the unit tests** in `ProjectSetup.test.tsx`:
  - "names the token it needs and links to it…" is re-pointed. Inside Import's `<details>`: a link named exactly `Create one` with href `/projects/alpha/access`, and the details' text matches `/PERFPORTAL_TOKEN.{0,3}\(Completed reports\)/`. The card text OUTSIDE the details matches neither `/token/i` nor `/\bmint|\bscoped?s?\b/i`. The no-token-form assertions are kept.
  - `it('shows the picker at once and carries no description under any card')`: Import's `input[type="file"]` exists and has no `details` ancestor; none of `/finished Gatling report/`, `/No bundle yet/`, `/trend line keeps itself/`, `/streams the log/`, `/secret store/` appears; all three `<h2>`s are present.
  - "groups the card disclosures…" is re-pointed (Review Focus 5): exactly two `<details>`, both `name="add-results"`, and no `<details>` inside another (`d.parentElement?.closest('details') == null` for all).
  - "says nothing is known when…" setup part: `runner-setup` is a link with accessible name exactly `Create a runner token` and href `/projects/alpha/access`. The "a runner is working" case keeps its absence check.
  - `it('puts the CI notes behind an info and keeps one line about the plugin')`: inside CI's details, a link `Create one` with access href; `About the CI step`'s description matches `/commitSha/`; the text matches `/Gradle plugin\s*dev\.vantrix\.gatling/`.
  - "keeps each path's commands closed…", "carries an absolute URL…" and "refers to the token by environment variable…" stay unchanged and must still pass.

- [ ] **Step 2: Run, expect failure**

Run: `pnpm exec vitest run apps/web/test/ProjectSetup.test.tsx`
Expected: FAIL on the new and re-pointed cases (three `<details>` with one nested; the picker inside a details; descriptions present).

- [ ] **Step 3: Implement** the `EntryCard` change and the three cards.

- [ ] **Step 4: Run, expect pass**; red-verify: nest the terminal `<details>` back inside a card-level one (the grouping case fails); put `BundleUpload` back inside the disclosure (the picker case fails).

- [ ] **Step 5: Re-point the e2e cases** in `project-tests.spec.ts`:
  - The accordion case clicks `importCard.getByText('Or post it from a terminal')` (one click, no outer summary) and expects `upload-command` visible. It then clicks CI's `Show me how`, expects `ci-command` visible, and expects Import's `details` `toHaveJSProperty('open', false)` plus `upload-command`'s `checkVisibility()` polled to `false`. Keep the pair; rewrite the comment so it says there is now one disclosure ancestor.
  - The upload case drops its summary click and asserts `bundle-file` is attached and `Upload bundle` reachable without opening anything.
  - Run: `pnpm exec playwright test apps/web/e2e/project-tests.spec.ts --project=chromium` against scratch stores. Expected: PASS.

- [ ] **Step 6: Commit** the three files.

---

### Task 4: New on-prem run — no Review group, hints behind ⓘ

**Files:**
- Modify: `apps/web/src/routes/NewRunnerRun.tsx`
- Modify: `apps/web/test/NewRunnerRun.test.tsx`

**Interfaces:**
- Consumes: `FormField`, `hintId`, `noticeId`, `errorId` (Task 1).
- Changes:
  - The private `Field` (~L1259) is deleted; every call site uses `FormField` with the same `label`/`id`/`optional`/`hint`. Controls that pointed at the literal `${id}-hint` use `hintId(id)`.
  - The Review fieldset (~L761–797) is deleted, along with `ReviewSummary`, `ReviewRow` and `ReviewSource`. The `formError` alert and the Queue run button stay as the form's last children, outside any fieldset.
  - System properties: `FormField error={parsedProperties.kind === 'error' ? parsedProperties.message : undefined}`. The textarea's `aria-describedby` is `hintId` plus `errorId` while an error shows, and it sets `aria-invalid` then.
  - Test fallback (tests list failed): `notice="Tests couldn't be loaded — type the slug."` and `hint="Lower case, hyphens, no spaces — a slug that names no test yet creates one."`; the input's `aria-describedby` is `` `${noticeId('runner-test')} ${hintId('runner-test')}` ``.
  - Typed simulation class in package mode: the constant is renamed `SIMULATIONS_UNKNOWN_NOTICE` (text unchanged) and passed as `notice`; the input's `aria-describedby` is `noticeId('runner-simulation')`.
  - Runner logs card: `title={\`Runner logs · ${jobId.slice(0, 8)}\`}`, with no description.

- [ ] **Step 1: Re-point and add tests** in `NewRunnerRun.test.tsx`:
  - Both legend cases expect `['Package', 'Execution']`.
  - The M11 "shows what is set and what is still needed…" and "adds an optional row once…" cases, and the four cases under the `REVIEW` banner (~L1389–1440), are deleted. In their place goes `it('has no review group — the form is its own review')`: no `review-summary` testid; `Queue run` has no `fieldset` ancestor; with a package served, the Package select's selected option text includes the file name and `1.8 MB` (`packageOptionLabel` is where the package, file and size are read back).
  - The alpha.jar case at ~L264 reads `getByText(/alpha\.jar/i)` unscoped, since the file control is the only place that names it now.
  - "reads back the system properties as they will be passed…" becomes `it('says what the properties are for behind the field’s info')`: `About System properties`' description matches `/does not interpret them/`.
  - "says which line is malformed…" (Review Focus 3): typing `this line has no equals sign` shows a visible message matching `/must be key=value/i` that is the textarea's description, with `aria-invalid="true"`; replacing the text with `a=b` removes the message and `aria-invalid`; with the malformed line, `Queue run` still shows the alert and no start call is made.
  - Simulations-unknown case (~L776): the line is visible and `simulation.getAttribute('aria-describedby')` is `runner-simulation-notice`.
  - `it('says why the slug is typed when the tests list cannot load')` (Review Focus 2): with `fetchProjectTests` rejected, the notice `Tests couldn't be loaded — type the slug.` is visible; the input's description contains both the notice and `Lower case, hyphens, no spaces`; and the hint text is not visible.
  - "never claims a runner…" was already re-pointed in Task 2.

- [ ] **Step 2: Run, expect failure**

Run: `pnpm exec vitest run apps/web/test/NewRunnerRun.test.tsx`
Expected: FAIL on the legends, the no-review case, the properties error under the field, and both notice cases.

- [ ] **Step 3: Implement** the changes above.

- [ ] **Step 4: Run, expect pass**; red-verify: drop `error=` from System properties (Review Focus 3's case fails); omit `hintId` from the fallback's `aria-describedby` (Review Focus 2's case fails).

- [ ] **Step 5: Commit** the two files.

---

### Task 5: SLA rules, on both pages

**Files:**
- Modify: `apps/web/src/routes/ProjectRules.tsx`
- Modify: `apps/web/test/ProjectRules.test.tsx`

**Interfaces:**
- Consumes: `FormField`, `hintId`, `InfoTip`, `projectRulesPath` (`./paths`).
- Changes, per the spec's SLA rules section:
  - The `Card`'s `description` (~L811–815) is deleted.
  - Applies to (project page, ~L876–935): `FormField label="Applies to" id={fieldId('appliesTo')} hint="A rule for one test judges only that test’s runs."`. The select gets `id={fieldId('appliesTo')}` and `aria-describedby={hintId(fieldId('appliesTo'))}`; `helpId` is deleted if it has no other caller.
  - Test page (~L861–874): the boxed paragraph becomes `<p>Applies to <span className="text-primary">{testLabel}</span> only · <Link to={projectRulesPath(slug)}>Add a project-wide rule</Link></p>`.
  - The lifecycle `<details>` (~L1205–1218) becomes `InfoTip label="About when rules apply"` beside the Add rule button. Its text: "A new rule judges runs finished after it is added. Runs already complete keep their verdicts, and a run streaming right now keeps the rules it started under. A live run is matched to its test as soon as the log header names the simulation, so a test’s rules apply from that moment on."
  - Test page `emptyNote`: `No rules for this test — the project-wide rules below apply.`

- [ ] **Step 1: Re-point and add tests** in `ProjectRules.test.tsx`:
  - "fixes new rules to this test…" (Review Focus 4): `getByText(/setup page/i)` becomes `queryByText(/setup page/i)` is null; the link named exactly `Add a project-wide rule` has href `/projects/checkout/rules`; and the paragraph's text matches `/^Applies to\s*Payments sweep\s*only/`.
  - "files the lifecycle policy behind a disclosure…" becomes `it('files the lifecycle policy behind an info beside Save')`: the `About when rules apply` trigger's description matches `/judges runs finished after it is added/` and `/log header names the simulation/`; the trigger shares a parent with the `Add rule` button; and no `<summary>` reads `When does this rule apply?`.
  - "states when a new rule takes effect" now reads the trigger's description instead of `rule-preview`. "makes exactly one claim…" stays as is.
  - `it('says nothing under the SLA rules title')`, on both pages: neither `/Gates (this project’s|every run of)/` nor `/A run with no rules gets no verdict/` appears. On the project page with no rules, `/no release verdict/` still appears; on a test's page with no own rules, `No rules for this test — the project-wide rules below apply.` appears.
  - "names the Applies to control without reading its help aloud" stays and must pass, plus: a button named `About Applies to` exists.

- [ ] **Step 2: Run, expect failure**

Run: `pnpm exec vitest run apps/web/test/ProjectRules.test.tsx`
Expected: FAIL on the re-pointed and new cases.

- [ ] **Step 3: Implement** the changes above.

- [ ] **Step 4: Run, expect pass**; red-verify: point the link at `projectSetupPath` (Review Focus 4 fails); put the `InfoTip` back inside a `<details>` (the beside-Save case fails).

- [ ] **Step 5: Commit** the two files.

---

### Task 6: API tokens, New project, Packages

**Files:**
- Modify: `apps/web/src/routes/ProjectAccess.tsx` (drop `intro=` ~L65; drop the Create a token `description` ~L173; Expires ~L213–235 becomes `FormField label="Expires" id="token-expiry" hint="An expired token stops authenticating; it is not deleted, and the list still says it existed."` with `id="token-expiry"` and `aria-describedby={hintId('token-expiry')}` on the select, keeping `data-testid="token-expiry"`)
- Modify: `apps/web/src/routes/NewProject.tsx` (the `Card` loses `title` and `description`; the private `Field` is deleted in favour of `FormField`)
- Modify: `apps/web/src/routes/ProjectPackages.tsx` (File field ~L325–340 becomes `FormField label="File" id={fileId} optional hint="A package can be made empty and given its first file from its row later."`; the input's `aria-describedby={hintId(fileId)}`; `fileHelpId` is deleted)
- Modify: `apps/web/test/ProjectAccess.test.tsx`, `apps/web/test/NewProject.test.tsx`, `apps/web/test/ProjectPackages.test.tsx`

**Interfaces:**
- Consumes: `FormField`, `hintId` (Task 1).

- [ ] **Step 1: Write and re-point tests**
  - `ProjectAccess.test.tsx`: `it('opens on the form, with no intro and no card description')`. Neither `/Credentials for CI/` nor `/Name it after/` appears; the `Create a token` heading is present. The `Expires` select's accessible name is `Expires` and its description matches `/stops authenticating/`; an `About Expires` button exists; and that sentence is not visible.
  - `NewProject.test.tsx`: `it('names the page once')`. The only heading is the `<h1>` `New project`; neither `Project details` nor `/Name the service/` appears; the two fields are still named `Project name` and `URL slug`.
  - `ProjectPackages.test.tsx`: the file-help case keeps its exact accessible-description assertion and adds that an `About File` button exists and that the sentence is not visible.

- [ ] **Step 2: Run, expect failure**

Run: `pnpm exec vitest run apps/web/test/ProjectAccess.test.tsx apps/web/test/NewProject.test.tsx apps/web/test/ProjectPackages.test.tsx`
Expected: FAIL on each new or extended case.

- [ ] **Step 3: Implement** the three source changes.

- [ ] **Step 4: Run, expect pass**; red-verify one mutation per file: restore the intro; restore `title="Project details"`; make the File hint visible.

- [ ] **Step 5: Commit** the six files.

---

### Task 7: Delete the props, and pin their absence

**Files:**
- Modify: `apps/web/src/components/Card.tsx` (delete `description` and both places it renders)
- Modify: `apps/web/src/routes/ProjectShell.tsx` (delete `intro`, ~L110/115/276)
- Modify: `apps/web/test/Card.test.tsx`, `apps/web/test/ProjectShell.test.tsx`

**Interfaces:**
- Consumes: Tasks 3–6 removed every caller (`grep -rn "description=\|intro=" apps/web/src --include=*.tsx | grep -v aria-` must print nothing before this task starts).

- [ ] **Step 1: Replace the test.** `Card.test.tsx`'s "renders the description under the title…" becomes:

```tsx
it('takes no description: a card title stands alone', () => {
  // @ts-expect-error — `description` was deleted (clean UI PR 4): nothing is written under a card title.
  render(<Card title="Requests" description="per second">{null}</Card>);
  expect(screen.queryByText('per second')).toBeNull();
});
```

  And in `ProjectShell.test.tsx`, through that file's existing render helper: `it('takes no intro')` passes `intro="x"` under `// @ts-expect-error`, and `x` is absent.

- [ ] **Step 2: Run, expect failure.** Run `pnpm typecheck > "$WS/tc.txt" 2>&1; echo "exit=$?"`. Expected: exit 2. The props still exist, so neither `@ts-expect-error` has an error to absorb, and `TS2578: Unused '@ts-expect-error' directive` is reported for both.

- [ ] **Step 3: Delete** the two props.

- [ ] **Step 4: Run** `pnpm typecheck` (expected exit 0) and `pnpm exec vitest run apps/web/test/Card.test.tsx apps/web/test/ProjectShell.test.tsx` (expected PASS). Red-verify: re-add `readonly description?: string` to `Card`'s props; typecheck fails with TS2578 at the test's line.

- [ ] **Step 5: Commit** the four files.

---

### Task 8: The gate, the measurement, the review, the record

- [ ] **Step 1:** Re-read every comment in the files touched by Tasks 2–7 that describes a deleted description, the Review group, the status note, the nested terminal disclosure, the lifecycle disclosure or the setup-page pointer, and correct each to what the code does. Commit alone.
- [ ] **Step 2:** Run the gates in order, each exit code read on its own.
  - `pnpm typecheck`, then `pnpm lint`.
  - `pnpm test:unit`. Predict the floor from the source first: two new unit files (`FormField`, `RunnerStatusLine`) and the net case change counted from the diff.
  - `pnpm test:integration`, behind the load and free-memory gate on scratch stores. Only `runnerReadiness.test.ts` is a `.ts` file it also runs.
  - `pnpm test:e2e --workers=2`. The e2e count stays 188: every browser change is inside an existing case.
  - Read every failure, fix it, and re-run.
- [ ] **Step 3:** Run the before/after word audit at 1440×900 against the developer database, the same headless pass as PR 3. Pages: Add results, API tokens, SLA rules, New on-prem run, a test's page, Packages, New project. Before: 180/145, 403/38, 71/24, 295/76, 319/42, 64/0, and New project measured on `main`.
- [ ] **Step 4:** Final whole-branch review on Opus: the review package plus `code-reviewer.md`, this Review Focus verbatim, and the ledger's rulings. Then one fix pass, each fix RED→GREEN.
- [ ] **Step 5:** `CLAUDE.md` entry and floors, committed alone.
- [ ] **Step 6:** Push, open the PR (no attribution), dispatch `gh workflow run ci.yml --ref feat/clean-ui-project-area`, and bind the PR. Merge only on the user's word.
