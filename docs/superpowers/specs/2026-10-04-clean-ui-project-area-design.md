# Clean UI, PR 4 — the project area and forms — design

2026-10-04. PR 4, the last of the clean-UI programme. The programme spec,
`docs/superpowers/specs/2026-10-04-clean-ui-design.md`, holds the text rule
this PR applies and is not restated here. PR 1 (#259) built `InfoTip`; PR 2
(#260) cleaned the run page; PR 3 (#261, merge `cc77cc2`) cleaned the run
lists.

Scope: Add results (`ProjectSetup`), the on-prem runner status shared by Add
results and New on-prem run, New on-prem run (`NewRunnerRun`), SLA rules
(`ProjectRules`, on the project's own page and on a test's page), API tokens
(`ProjectAccess`), New project and Packages. Last, `Card`'s `description`
prop and `ProjectShell`'s `intro` prop are deleted, so `tsc` refuses a
description under a card title — the programme's first firm limit — from then
on.

Decisions settled in brainstorming:

1. **New on-prem run loses its Review group.** The form is its own review;
   a missing required field is marked on the field.
2. **Runner status is a headline and one short fact**, with the caveat behind
   one ⓘ, in one shared component for both pages.
3. **Each Add results card shows its title and its action**; commands are one
   click away.
4. **Field hints go behind an ⓘ beside the label**; format rules are carried
   by the placeholder example and the inline error; a degraded state stays as
   one visible line.
5. **Approach 1:** one PR; a shared `FormField`, then the pages one at a time,
   then the prop deletions.

Palette, theme, routes, contracts and APIs do not change.

## Why

Measured after PR 3, the same headless pass at 1440×900 over the developer
database (words inside `<main>`, and prose words: paragraphs, list items and
captions of seven words or more):

| page | words | prose |
| --- | ---: | ---: |
| Add results | 180 | 145 |
| API tokens | 403 | 38 |
| SLA rules | 71 | 24 |
| New on-prem run | 295 | 76 |
| A test's page (the rules panel) | 319 | 42 |
| Packages | 64 | 0 |

Add results is four-fifths prose: a description under every card, a boxed
status note, and paragraphs around every command. New on-prem run reads every
field back in a Review group before the button. Forms print a help line under
fields whose label already says what they are.

## The shared form field (`FormField`)

New file `apps/web/src/components/FormField.tsx`, exporting

```ts
FormField({ label, id, optional, hint, notice, children }: {
  label: string; id: string; optional?: boolean;
  hint?: string; notice?: string; children: ReactNode;
})
hintId(id: string): string    // `${id}-hint`
noticeId(id: string): string  // `${id}-notice`
```

- A label row holds `<label htmlFor={id}>` with the "(optional)" marker inside
  it, as today — the accessible name stays "Branch (optional)".
- With a `hint`: an `InfoTip` named `About ${label}` sits **beside** the
  label, never inside it (a trigger inside a `<label>` joins the control's
  name). The hint text is also rendered as `<span id={hintId(id)} hidden>`,
  so a control that sets `aria-describedby={hintId(id)}` keeps its
  description and a screen reader hears it on focus.
- No visible line under the control, except a `notice`: one sentence for a
  degraded state the reader has to act on, rendered visibly at
  `id={noticeId(id)}` in the pending status colour
  (`style={{ color: 'var(--color-status-pending)' }}`). A control under a
  notice points `aria-describedby` at it.
- Callers set `aria-describedby` on their own control; `FormField` does not
  reach into its children.
- It replaces the private `Field` in `NewRunnerRun.tsx` and `NewProject.tsx`,
  and is used for the hinted fields in `ProjectRules`, `ProjectAccess` and
  `ProjectPackages`.

## Runner status (`RunnerStatusLine`)

- `runnerReadiness.ts`: `RunnerReadiness.detail` becomes `fact`, one short
  line per state; `headline`, `kind`, `ahead` and `needsSetup` are unchanged.

  | state | headline · fact |
  | --- | --- |
  | unknown | Runner availability unknown · No run queued from this project yet |
  | idle | No job in flight · Last job finished `agoLabel(...)` |
  | busy | A runner is working · A new run waits behind `N jobs` |
  | waiting | Waiting to be claimed · `N jobs` queued, none claimed yet |
  | stalled | Nothing is claiming work · Queued `agoLabel(waited)`, unclaimed. Check a runner is running and pointed at this instance. |

- A new exported constant `RUNNER_STATUS_INFO` in the same file holds the
  caveat: status is inferred from this project's jobs; this instance is not
  told when a runner connects or leaves, so whether one is listening right now
  is known only once a job is claimed; a runner runs one job at a time.
- New file `apps/web/src/routes/RunnerStatusLine.tsx`, exporting
  `RunnerStatusLine({ query })` over the project's runner-jobs query. It
  renders the headline (mono, `●` in the state's status colour, as today), a
  `·`, the fact in muted text, and an `InfoTip` labelled
  `About runner status` carrying `RUNNER_STATUS_INFO`. While the query is
  pending: "Checking…". When it fails: "Status unavailable · The job list
  could not be loaded". It keeps `data-testid="runner-status"`.
- Add results' Run a test card and New on-prem run's Runner card both render
  it. The Runner card's footnote ("This instance is not told when a runner
  connects…") and its error paragraph go; `EntryCard` loses its `status` prop
  and the boxed `status.note`, since the runner was its only status.

## Add results (`ProjectSetup`)

`EntryCard` loses `description`. Each card is a title, then its action.
`EntryCard`'s disclosure takes its summary text from the caller, still as
`<details name="add-results">`; the `<h2>` stays outside the `<summary>`, and
testids stay derived from the title.

**Import results**
- The file picker (`BundleUpload`) is the card's body, visible at once.
- The card's disclosure is summarised "Or post it from a terminal". Inside:
  one line, "Needs `PERFPORTAL_TOKEN` (Completed reports) · Create one" —
  "Create one" links to `projectAccessPath(slug)` — with an `InfoTip`
  labelled `About posting results` beside it carrying the two paragraphs that
  used to follow the command (the same pipeline as the picker; the `.tgz`
  layout); then the curl command (`data-testid="upload-command"`).
- The token requirement no longer sits on the card: a signed-in upload through
  the picker needs none.

**Run a test**
- `RunnerStatusLine`, then the **New on-prem run** link button.
- "The runner streams the log as it is written…" is deleted.
- The setup paragraph (`data-testid="runner-setup"`) becomes one link,
  "Create a runner token" to `projectAccessPath(slug)`, shown only while
  `needsSetup`.

**Configure CI**
- The disclosure keeps "Show me how". Inside: one line, "Store the token as
  `PERFPORTAL_TOKEN` in your pipeline secrets · Create one", with an
  `InfoTip` labelled `About the CI step` carrying the branch and commit-SHA
  note; then the command (`data-testid="ci-command"`); then one line, "Live
  view while the build runs: Gradle plugin `dev.vantrix.gatling`".
- The card's own sentence about the pipeline's secret store is deleted (the
  line inside says it).

Import's and CI's disclosures are the page's two `<details name="add-results">`:
opening one closes the other, and nothing is nested inside another disclosure.

## New on-prem run (`NewRunnerRun`)

- **The Review group is deleted**: the fieldset, `ReviewSummary`, `ReviewRow`
  and their missing-field flags. The error alert and **Queue run** stay at the
  end of the form, outside any fieldset.
- Missing fields are refused where they are. The required text inputs (run
  name, new test slug, typed simulation class) already carry `required`; the
  package and simulation selects always hold a value; an upload with no file
  keeps its existing "Choose the jar or bundle this node should run." error.
  Server refusals keep the alert with their remediation.
- The Package and Execution legends stay. The one-line notice for a
  `?package=` link the form could not honour stays.
- Hints behind `FormField`'s ⓘ: Artifact type, System properties, Test, New
  test slug. The format rules ride in those hints; the placeholder
  (`checkout-soak`) and the inline error carry them on screen.
- Notices (visible, one line): "Tests couldn't be loaded — type the slug." on
  the test fallback; "This package's simulations aren't known yet — type the
  class." on the typed simulation class in package mode.
- The Runner card renders `RunnerStatusLine`.
- Runner logs: the title carries the job — "Runner logs · 1a2b3c4d" — and the
  card's description goes.
- Unchanged: the Run queued card, the jobs table and its empty state.

## SLA rules (`ProjectRules`)

- The card's description goes on both pages. What it said is carried by the
  two tables' existing ⓘs (which runs each set judges) and by the empty state,
  which states the no-verdict consequence where it bites.
- Project page: the Applies-to help line becomes `FormField`'s ⓘ.
- A test's page: the boxed paragraph becomes one line, "Applies to
  **{test}** only · Add a project-wide rule", the second half a link to
  `projectRulesPath(slug)`. (The paragraph pointed at "the project's setup
  page", where rules have not lived since review M15.)
- "When does this rule apply?" stops being a disclosure and becomes an
  `InfoTip` beside Save, labelled `About when rules apply`, carrying the same
  two sentences.
- A test's page with no rules of its own: "No rules for this test — the
  project-wide rules below apply."
- Unchanged: the preview sentence, the threshold warning, the form errors and
  server remediation, the delete confirmation, the Measure and Limit legends,
  the unit in the Limit label, both tables and their ⓘs, the project page's
  empty state.

## API tokens, New project, Packages

- **API tokens.** The page intro goes, and `ProjectShell`'s `intro` prop with
  it. The Create a token description goes; the reveal panel keeps "Token shown
  once · Copy it before leaving this page." The Expires helper goes behind
  `FormField`'s ⓘ. Unchanged: "Next: use it to add results", the revoke
  confirmation, the empty state.
- **New project.** The card's description goes, and its "Project details"
  title — which restates the "New project" `<h1>`, the one-title fix review
  M11 made to New on-prem run. The private `Field` becomes `FormField`.
- **Packages.** "A package can be made empty and given its first file from its
  row later." goes behind the File field's ⓘ. The empty state, the no-match
  line and the delete confirmation stay.

## Holding the line

`Card.description`, `EntryCard.description` and `ProjectShell.intro` are
deleted. `Card.test.tsx` carries a `// @ts-expect-error` render that passes
`description`: if the prop returns, the directive is unused and
`pnpm typecheck` fails.

## Testing

- `FormField.test.tsx`: the label's accessible name with and without
  "(optional)"; the ⓘ beside the label and not inside it; the control's
  accessible description is the hint through `hintId`; no ⓘ without a hint;
  the notice visible at `noticeId`.
- `runnerReadiness.test.ts`: re-pointed at the five facts and
  `RUNNER_STATUS_INFO`.
- `RunnerStatusLine` cases (pending, failed, each state's headline and fact,
  the ⓘ's description) in a new `RunnerStatusLine.test.tsx`.
- `ProjectSetup.test.tsx`, `NewRunnerRun.test.tsx`, `ProjectRules.test.tsx`,
  `ProjectAccess.test.tsx`, `NewProject.test.tsx`, `ProjectPackages.test.tsx`
  and `TestRuns.test.tsx`: tests pinning removed prose are re-pointed at their
  claims or deleted with them; every absence assertion is paired with a
  positive.
- Browser: `project-tests.spec.ts`' accordion case re-pointed at the two
  disclosures; any spec reading deleted prose re-pointed.
- Every new or re-pointed assertion is red-verified by a mutation.
- The gate: `typecheck`, `lint`, `test:unit`, `test:integration`, `test:e2e`,
  each from its own exit code; a before/after word audit of the six pages and
  New project; an Opus whole-branch review; floors updated in `CLAUDE.md`; the
  `e2e-cross-browser` job dispatched before merge.

## Out of scope

- Any colour, token, font, theme, route, contract, API or data change.
- The run lists' empty-state bodies (PR 3's pages).
- Runner health beyond what the job list shows (there is no heartbeat).
- New features.
