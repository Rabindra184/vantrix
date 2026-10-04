# Clean UI, PR 1 — InfoTip, and no prose in Chart or TableFrame — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an `InfoTip` toggletip and move every chart caveat and every table caption off the screen and behind it, so no chart or table draws an explanatory paragraph.

**Architecture:** One new component (`InfoTip`, Radix Popover, with a `hidden` description copy linked by `aria-describedby`), one new slot on `SectionHeading`, and two shared components (`Chart`, `TableFrame`) whose prose-drawing props are removed so the change holds by construction. The ten `TableFrame` callers move or delete their caption text per the spec's table. No route, contract, colour or token changes.

**Tech Stack:** React 19, TypeScript, Tailwind v4, `@radix-ui/react-popover`, vitest + Testing Library (jsdom), Playwright.

**Spec:** `docs/superpowers/specs/2026-10-04-clean-ui-design.md` (sections "The text rule" and "PR 1 — shared pieces").

## Global Constraints

- Node 22: `source ~/.nvm/nvm.sh && nvm use` before every command. On Node 20 the jsdom suite silently skips.
- No colour, token, font or theme change; the panel reuses `bg-surface`, `border-default`, `shadow-panel`, `text-primary`, `text-muted`.
- No route, data contract or API change.
- An `InfoTip` is NEVER inside a heading element or a `<th>` — only beside one (spec, "Never inside a heading or a `<th>`").
- Every `InfoTip` `label` names its subject: `About ${subject}` — never "More info".
- Every new or edited test file imports `'@testing-library/jest-dom/vitest'` and calls `afterEach(cleanup)` (vitest `globals` is off, so Testing Library's auto-cleanup never registers).
- Red-verify every new case: commit a checkpoint, apply one mutation, assert the replacement count is exactly 1 before running, read the failing assertion, restore with `git checkout HEAD -- <file>`.
- Stage files by name; never `git add -A` (the root holds three untracked files that must not be committed). Commit with `git commit -F -` and a quoted heredoc. No attribution lines.
- Read each gate's own exit code (`cmd > /tmp/x.txt 2>&1; echo "exit=$?"`), never a pipeline's.

## Review Focus

1. **A trigger placed inside a heading.** The heading's accessible name and its `textContent` must stay exactly the heading text, because `run-tables.spec.ts` pins each tab's heading outline by `textContent`. Pinned in Task 2.
2. **Several InfoTips on one page.** The Summary will carry several; opening a second must close the first, and their names must differ. Pinned in Task 1.
3. **A trigger near the right edge of a phone screen.** The panel must stay inside the viewport (Radix `collisionPadding`). Pinned in Task 5's 375px e2e case on a table frame's top-right ⓘ.
4. **Content containing a link.** The trigger's accessible description must still read as the full sentence, and the link must not become a tab stop while the panel is closed. Pinned in Task 1.
5. **A component given no caveat.** It must draw no ⓘ and no extra row, so tables and charts without one keep their height. Pinned in Task 3 (`Chart`) and Task 4 (`TableFrame`).

---

### Task 1: `InfoTip`

**Files:**
- Create: `apps/web/src/components/InfoTip.tsx`
- Modify: `apps/web/src/components/icons.tsx` (add `export const InfoIcon = icon(Info);` beside the others, importing `Info` from `lucide-react`)
- Modify: `apps/web/package.json`, `pnpm-lock.yaml` (add `@radix-ui/react-popover`)
- Test: `apps/web/test/InfoTip.test.tsx`

**Interfaces:**
- Produces: `export default function InfoTip(props: { readonly label: string; readonly children: ReactNode }): JSX.Element` from `apps/web/src/components/InfoTip.tsx`. Renders a `<button type="button">` (accessible name = `label`, `aria-describedby` = the hidden copy's `useId()` id) and a sibling `<span hidden id=…>{children}</span>`. While open, a portalled Radix `Popover.Content` with `role="dialog"` and `aria-label={label}` holds `children`.

- [ ] **Step 0: Record the floors on the untouched branch**

Run: `pnpm test:unit > /tmp/unit0.txt 2>&1; echo "exit=$?"; tail -6 /tmp/unit0.txt`
Expected: exit=0 and the last two lines show the current floor (CLAUDE.md records 194 files / 2667 tests). Write the two numbers down; every later floor is this plus the cases this plan adds or removes.

- [ ] **Step 1: Add the dependency**

Run: `pnpm --filter @perfportal/web add @radix-ui/react-popover@^1.1`
Then: `pnpm audit --prod > /tmp/audit.txt 2>&1; echo "exit=$?"; tail -3 /tmp/audit.txt`
Expected: exit=0, "No known vulnerabilities found".

- [ ] **Step 2: Write the failing tests** in `apps/web/test/InfoTip.test.tsx`

```tsx
const tip = (label = 'About p95', body: ReactNode = 'p95 is an estimate, accurate to within 1%.') =>
  render(<InfoTip label={label}>{body}</InfoTip>);

it('names the trigger after its subject', () => {
  tip();
  expect(screen.getByRole('button', { name: 'About p95' })).toBeInTheDocument();
});

it('describes the trigger with the caveat while closed, and draws no panel', () => {
  tip();
  expect(screen.getByRole('button', { name: 'About p95' }))
    .toHaveAccessibleDescription('p95 is an estimate, accurate to within 1%.');
  expect(screen.queryByRole('dialog')).toBeNull();
});

it.each([['click'], ['{Enter}'], [' ']])('opens on %s', async (how) => {
  tip();
  const user = userEvent.setup();
  const trigger = screen.getByRole('button', { name: 'About p95' });
  if (how === 'click') await user.click(trigger); else { trigger.focus(); await user.keyboard(how); }
  expect(await screen.findByRole('dialog', { name: 'About p95' })).toHaveTextContent('accurate to within 1%');
});

it('closes on Escape and returns focus to the trigger', async () => {
  tip();
  const user = userEvent.setup();
  const trigger = screen.getByRole('button', { name: 'About p95' });
  await user.click(trigger);
  await screen.findByRole('dialog');
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(trigger).toHaveFocus();
});

it('gives two InfoTips distinct names, and opening one closes the other', async () => {
  render(<><InfoTip label="About p95">A.</InfoTip><InfoTip label="About errors">B.</InfoTip></>);
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'About p95' }));
  await screen.findByRole('dialog', { name: 'About p95' });
  await user.click(screen.getByRole('button', { name: 'About errors' }));
  expect(await screen.findByRole('dialog', { name: 'About errors' })).toBeInTheDocument();
  expect(screen.queryByRole('dialog', { name: 'About p95' })).toBeNull();
});

it('keeps a link out of the tab order while closed and live in the panel', async () => {
  tip('About vs previous', <>Compared with <a href="/runs/r10">Run 10</a>.</>);
  expect(screen.queryByRole('link', { name: 'Run 10' })).toBeNull();
  const trigger = screen.getByRole('button', { name: 'About vs previous' });
  expect(trigger).toHaveAccessibleDescription('Compared with Run 10.');
  await userEvent.setup().click(trigger);
  expect(await screen.findByRole('link', { name: 'Run 10' })).toHaveAttribute('href', '/runs/r10');
});
```

The link case renders inside a `MemoryRouter` only if the content uses `<Link>`; a plain `<a>` needs none.

- [ ] **Step 3: Run them and see them fail**

Run: `pnpm exec vitest run apps/web/test/InfoTip.test.tsx`
Expected: FAIL — cannot resolve `../src/components/InfoTip`.

- [ ] **Step 4: Implement `InfoTip`**

Radix `Popover.Root` / `Popover.Trigger asChild` / `Popover.Portal` / `Popover.Content` with `side="top"`, `align="start"`, `sideOffset={6}`, `collisionPadding={8}`, `aria-label={label}`. Trigger classes: `transition-ui inline-flex h-5 w-5 items-center justify-center rounded text-muted hover:text-primary` plus the app's existing focus-ring utility, holding `<InfoIcon className="h-3.5 w-3.5" aria-hidden="true" />`. Panel classes: `z-50 max-w-72 rounded-lg border border-default bg-surface p-3 text-[0.8125rem] leading-relaxed text-primary shadow-panel`. The trigger and the `hidden` span are siblings inside an inline `<span className="inline-flex items-center">`.

- [ ] **Step 5: Run the tests to green**

Run: `pnpm exec vitest run apps/web/test/InfoTip.test.tsx`
Expected: all cases PASS. If the description case reads empty, the jsdom accname library is not following `aria-describedby` into the `hidden` span's descendants — report it rather than switching to `sr-only`; Task 5's Chromium check is the arbiter.

- [ ] **Step 6: Red-verify**

Checkpoint commit, then two mutations, one at a time:
- drop `aria-describedby` from the trigger → the "describes the trigger" and link cases fail;
- render the copy without `hidden` → the link case fails (`queryByRole('link')` finds it while closed).

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/InfoTip.tsx apps/web/src/components/icons.tsx apps/web/test/InfoTip.test.tsx apps/web/package.json pnpm-lock.yaml
git commit -F - <<'MSG'
Add InfoTip, a toggletip whose caveat is the trigger's description
MSG
```

---

### Task 2: `SectionHeading` gains an `info` slot

**Files:**
- Modify: `apps/web/src/components/SectionHeading.tsx`
- Test: create `apps/web/test/SectionHeading.test.tsx`

**Interfaces:**
- Consumes: `InfoTip` (Task 1).
- Produces: `SectionHeading` accepts `readonly info?: ReactNode`; callers pass an `<InfoTip label={`About ${heading}`}>…</InfoTip>`. When `info` is set, the heading element and `info` sit as siblings in `<div className="flex items-center gap-1.5">`; with an `overline`, that row replaces the bare heading under it. With no `info`, the markup is unchanged.

- [ ] **Step 1: Write the failing tests**

```tsx
it('keeps the heading’s name and text its own when it carries an info slot', () => {
  render(<SectionHeading info={<InfoTip label="About Statistics">Times in ms.</InfoTip>}>Statistics</SectionHeading>);
  const heading = screen.getByRole('heading', { level: 2, name: 'Statistics' });
  expect(heading.textContent).toBe('Statistics');
  expect(heading).not.toContainElement(screen.getByRole('button', { name: 'About Statistics' }));
});

it('carries the slot beside an overlined heading too', () => {
  render(<SectionHeading overline="Run telemetry" info={<InfoTip label="About Statistics">x</InfoTip>}>Statistics</SectionHeading>);
  expect(screen.getByText('Run telemetry')).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Statistics' }).textContent).toBe('Statistics');
  expect(screen.getByRole('button', { name: 'About Statistics' })).toBeInTheDocument();
});

it('draws no trigger without info', () => {
  render(<SectionHeading>Errors</SectionHeading>);
  expect(screen.queryByRole('button')).toBeNull();
});
```

- [ ] **Step 2: Run, see the first two fail** — `pnpm exec vitest run apps/web/test/SectionHeading.test.tsx` → no button found.
- [ ] **Step 3: Implement the slot** as described in Interfaces.
- [ ] **Step 4: Run to green**, then red-verify by moving `{info}` INSIDE the heading element → the first case fails on `textContent`.
- [ ] **Step 5: Commit** `SectionHeading.tsx` and its test: "Give SectionHeading an info slot beside, never inside, the heading".

---

### Task 3: `Chart` caveats move behind an `InfoTip`

**Files:**
- Modify: `apps/web/src/charts/Chart.tsx` (the header row near line 1119; delete the limitation block near line 1194)
- Test: `apps/web/test/Chart.test.tsx` (rewrite the cases at ~146 and ~209; add one)

**Interfaces:**
- Consumes: `InfoTip` (Task 1).
- Produces: no prop change. `data.limitation` and `assignment.limitation` render inside one `<InfoTip label={`About ${title}`}>`, each string as its own `<p>`, placed as a sibling directly after the chart's `<h3>` inside `<div className="flex min-w-0 items-start gap-1.5">`. With neither defined, no `InfoTip` renders. The empty-state `<p role="status">` is unchanged.

- [ ] **Step 1: Rewrite and add the tests**

```tsx
it('states the palette’s limitation behind the chart’s info, naming what was left out', () => {
  // the existing seven-series fixture
  const trigger = screen.getByRole('button', { name: `About ${TITLE}` });
  expect(trigger).toHaveAccessibleDescription(/first 6 of 7/i);
  expect(trigger).toHaveAccessibleDescription(/Logout/);
  expect(screen.getByText(/not drawn/i)).not.toBeVisible(); // only the hidden copy carries it
});

it('puts a transform’s own limitation behind the same info', () => {
  // data={{ ...seriesData(['OK']), limitation: 'Bins above 10000 ms are incomplete.' }}
  expect(screen.getByRole('button', { name: `About ${TITLE}` }))
    .toHaveAccessibleDescription('Bins above 10000 ms are incomplete.');
});

it('draws no info when the chart has no caveat', () => {
  // seriesData(['OK']) with no limitation
  expect(screen.queryByRole('button', { name: /^About / })).toBeNull();
});
```

`TITLE` is whatever title the file's existing fixtures pass; read it from the case being rewritten.

- [ ] **Step 2: Run, see them fail** — `pnpm exec vitest run apps/web/test/Chart.test.tsx`.
- [ ] **Step 3: Implement** as described in Interfaces.
- [ ] **Step 4: Run `Chart.test.tsx` and the seven `transforms.*` files to green** (`pnpm exec vitest run apps/web/test/Chart.test.tsx apps/web/test/transforms`). The transform files must pass untouched.
- [ ] **Step 5: Red-verify** — render the limitation block back as visible paragraphs → the first case fails; always render the `InfoTip` → the no-caveat case fails.
- [ ] **Step 6: Commit** `Chart.tsx` and `Chart.test.tsx`: "Move chart caveats behind an InfoTip beside the title".

---

### Task 4: `TableFrame` stops drawing captions, and its ten callers follow

**Files:**
- Modify: `apps/web/src/components/TableFrame.tsx`
- Modify the callers: `apps/web/src/tables/StatisticsTable.tsx`, `apps/web/src/tables/ErrorsTable.tsx`, `apps/web/src/tables/CompareMatrix.tsx`, `apps/web/src/routes/NewRunnerRun.tsx`, `apps/web/src/routes/ProjectTests.tsx`, `apps/web/src/routes/RunList.tsx` (table AND `RunCards`), `apps/web/src/routes/TestRuns.tsx` (its `caption` override), `apps/web/src/routes/ProjectPackages.tsx`, `apps/web/src/routes/ProjectAccess.tsx`, `apps/web/src/routes/ProjectRules.tsx` (`RulesTable` ×3), `apps/web/src/routes/GroupsList.tsx`
- Test: rewrite `apps/web/test/TableFrame.test.tsx`; re-point failing cases in the callers' tests (`ErrorsTable`, `StatisticsTable`, `CompareMatrix`, `ProjectTests`, `ProjectAccess`, `ProjectRules`, `ProjectPackages`, `NewRunnerRun`, `RunList`, `RunList.compact`, `TestRuns`)

**Interfaces:**
- Consumes: `InfoTip` (Task 1), `SectionHeading`'s `info` (Task 2).
- Produces: `TableFrame({ name, label, info, children }: { readonly name: string; readonly label: string; readonly info?: ReactNode; readonly children: ReactNode })`. The caller still renders `<caption className="sr-only">{name}</caption>` inside its `<table>`. `info`, when set, renders `<div data-testid="table-info" className="flex justify-end px-3 pt-2"><InfoTip label={`About ${name}`}>{info}</InfoTip></div>` above the scroll box; when unset, nothing is added. `summary`, `caption`, `CAPTION_MORE` and `CAPTION_LESS` no longer exist. `RunList`'s `caption` prop is renamed `info` (still optional; `TestRuns` passes its text through it).

Each caller follows the spec's table ("The ten callers, where each caveat goes"). The deciding sentences, so nothing is improvised:

| caller | `name` | caveat |
| --- | --- | --- |
| `StatisticsTable` | `Statistics` | `CAPTION_TEXT` → `<SectionHeading info={<InfoTip label="About Statistics">…</InfoTip>}>` at both heading sites (~887, ~939); the visible `summary` line is deleted |
| `ErrorsTable` | `Errors`; scoped `Errors for ${scopeLabel}` | both caption branches → its `SectionHeading` (~243) `info` |
| `CompareMatrix` | `Per-request comparison` | caption → its `SectionHeading` "By request" (~102) `info`; `summary` deleted |
| `NewRunnerRun` jobs | `On-prem runner jobs` | deleted |
| `ProjectTests` | `Tests` | `TableFrame` `info` keeps the sentences about naming, "Runs" counting the whole history and the em dash; "Every test in this project, newest first." and the `summary` are deleted |
| `RunList` table + `RunCards` | `Runs` | `TableFrame` `info` keeps the "Started" / ingest-time sentence and the Focus sentence (the column leaves in PR 3); `summaryLine` is deleted; `RunCards` drops its `<details>` and renders the same `info` through an `InfoTip` labelled `About Runs` beside its list |
| `ProjectPackages` | `Packages` | deleted |
| `ProjectAccess` | `API tokens` | `TableFrame` `info` keeps the secret-shown-once and rotation sentences; "Every API token in this project." is deleted |
| `ProjectRules` `RulesTable` ×3 | its existing `label` | `TableFrame` `info` keeps the disabled-rule and deleting-changes-other-tests sentences; "newest first" clauses are deleted |
| `GroupsList` | `Groups` | `TableFrame` `info` keeps the two-p95 sentence |

- [ ] **Step 1: Rewrite `TableFrame.test.tsx`**

```tsx
it('draws no visible caption and names the table with its short name', () => {
  renderFrame({ name: 'Statistics' });
  expect(screen.getByRole('table', { name: 'Statistics' })).toBeInTheDocument();
  expect(screen.queryByText(/How these numbers are counted/)).toBeNull();
});

it('puts its caveat behind an InfoTip named after the table', () => {
  renderFrame({ name: 'Statistics', info: 'Times are in milliseconds.' });
  expect(screen.getByRole('button', { name: 'About Statistics' }))
    .toHaveAccessibleDescription('Times are in milliseconds.');
});

it('adds no row and no trigger without a caveat', () => {
  const { container } = renderFrame({ name: 'Statistics' });
  expect(screen.queryByRole('button')).toBeNull();
  expect(container.querySelector('[data-testid="table-info"]')).toBeNull();
});
```

`renderFrame` renders a one-row table with `<caption className="sr-only">{name}</caption>`. The file's existing focusable-inside-`aria-hidden` guard stays: it must still find nothing.

- [ ] **Step 2: Run, see it fail** — `pnpm exec vitest run apps/web/test/TableFrame.test.tsx`.
- [ ] **Step 3: Implement `TableFrame`** per Interfaces, then `pnpm typecheck > /tmp/tc.txt 2>&1; echo "exit=$?"` — expected exit=2 with one error per caller; that list is the to-do for Step 4.
- [ ] **Step 4: Convert each caller** per the table above until `pnpm typecheck` exits 0.
- [ ] **Step 5: Run the web unit suite and re-point what fails**

Run: `pnpm exec vitest run apps/web/test > /tmp/web.txt 2>&1; echo "exit=$?"`
Re-point each failure by its claim, never by loosening:
- a case reading a caption's `textContent` for a number (e.g. `ErrorsTable.test.tsx` ~357–369, ~597: "200 errors", "1 error") reads `screen.getByRole('button', { name: /^About Errors/ })`'s accessible description instead;
- a case finding a table by a sentence-long name uses the short name;
- a case asserting the visible summary line or the `How these numbers are counted` disclosure is deleted with it, unless it asserts a caveat that survives — then it asserts that caveat through the `InfoTip`.

Expected after: exit=0.

- [ ] **Step 6: Red-verify** — render `info` as a visible `<p>` instead of an `InfoTip` → the `TableFrame` caveat case fails; always render the `table-info` row → the no-caveat case fails.
- [ ] **Step 7: Commit** every file named above: "Stop TableFrame drawing captions; each table's caveat moves behind an InfoTip or goes".

---

### Task 5: Browser coverage

**Files:**
- Create: `apps/web/e2e/info-tip.spec.ts`
- Modify: `apps/web/e2e/project-tests.spec.ts:66` (re-point `/every test in this project/i` to `{ name: 'Tests', exact: true }`)
- Modify: whichever e2e cases fail under the full run, re-pointed by the same rules as Task 4 Step 5

**Interfaces:**
- Consumes: `seedAdmin`, `seedRunWithData` (`apps/web/e2e/fixtures.ts`), `signIn` (`apps/web/e2e/helpers.ts`).

- [ ] **Step 1: Write the spec**

```ts
test('a chart’s caveat opens from its info, lands on screen, and Escape returns focus', async ({ page }) => {
  // seedAdmin → seedRunWithData → signIn → page.goto(`/runs/${runId}`)
  const chart = page.getByTestId('chart-percentiles');
  const trigger = chart.getByRole('button', { name: 'About Response time percentiles over time' });
  await expect(trigger).toHaveAccessibleDescription(/no successful response/i);
  await trigger.click();
  const panel = page.getByRole('dialog', { name: 'About Response time percentiles over time' });
  await expect(panel).toBeInViewport({ ratio: 1 });
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test('a table frame’s info stays on a 375px screen', async ({ page }) => {
  // seedAdmin (project `checkout`) → seedRunWithData (gives the project a test) → signIn
  // page.setViewportSize({ width: 375, height: 812 }); page.goto('/projects/checkout') — ProjectTests has no card layout, so the table renders
  const trigger = page.getByRole('button', { name: 'About Tests' });
  await trigger.click();
  await expect(page.getByRole('dialog', { name: 'About Tests' })).toBeInViewport({ ratio: 1 });
});
```

The heading outline is unchanged by construction; `run-tables.spec.ts`'s exact-outline cases are the guard and must pass untouched.

- [ ] **Step 2: Run the stack and the new spec**

Bring up the stack and env per CLAUDE.md "Verification", stop any API on :3000, then:
`pnpm test:e2e -- apps/web/e2e/info-tip.spec.ts apps/web/e2e/project-tests.spec.ts > /tmp/e2e1.txt 2>&1; echo "exit=$?"`
Expected: exit=0.

- [ ] **Step 3: Run the whole e2e suite and re-point what fails** — `pnpm test:e2e > /tmp/e2e.txt 2>&1; echo "exit=$?"`; read `Running N tests using M workers` back; expected the old count + 2.
- [ ] **Step 4: Red-verify** — add `avoidCollisions={false}` to `Popover.Content` → the top-right trigger's `align="start"` panel runs off the right edge and the 375px case fails on `toBeInViewport`.
- [ ] **Step 5: Commit** the e2e files: "Pin InfoTip in a real browser: the description, the viewport, Escape".

---

### Task 6: Measure, record, ship

**Files:**
- Modify: `CLAUDE.md` (new entry at the top of "Verification", floors updated)

- [ ] **Step 1: The full gate**, each by its own exit code, integration before e2e, against a scratch database and Redis index as CLAUDE.md prescribes: `pnpm typecheck`, `pnpm lint`, `pnpm test:unit`, `pnpm test:integration`, `pnpm test:e2e`, `pnpm audit --prod`. Expected: all exit 0; unit = Step 0's floor + 1 file (`InfoTip.test.tsx`) + 1 file (`SectionHeading.test.tsx`) and the net case delta; integration moves only if a `.ts` test changed (none planned); e2e = old + 2.
- [ ] **Step 2: Measure after.** Build, start the API on the developer database, re-run the headless audit used for the spec (same routes, same run `4a68b12d…`, 1440×900). Record each page's words and prose words beside the spec's "before" table, and save before/after screenshots of the run Summary and a project page.
- [ ] **Step 3: Write the `CLAUDE.md` entry** — the floors, what moved, the before/after table, and every red-verify with what it failed. Commit it alone.
- [ ] **Step 4: Cross-browser before merge.** Push, then `gh workflow run ci.yml --ref feat/clean-ui-infotip`; the `e2e-cross-browser` job must pass (WebKit has handled a portalled popover differently here before).
- [ ] **Step 5: Open the PR** to `main`, bind it with the ccd_pr tools, and merge with `--merge` only after the SHA-pinned green check CLAUDE.md prescribes.
