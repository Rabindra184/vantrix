# Clean UI, PR 2 — the run page — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the repetition from the run page: a slim release-gate band, tiles that are label + value + a delta naming its run, no header verdict badge, gate cards that state each rule once, one Bands dropdown on the percentile chart, and one-line empty states.

**Architecture:** Edits to existing run-page components only. Two small additions: a `DropdownMenuCheckboxItem` in the shared menu wrapper and a `BandsMenu` component for the percentile chart. `StatTile` gains an `info` slot and a `ReactNode` delta label. Explanations go behind PR 1's `InfoTip`.

**Tech Stack:** React 19, TypeScript, Tailwind v4, Radix (`@radix-ui/react-dropdown-menu`, `@radix-ui/react-popover` via `InfoTip`), vitest + Testing Library, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-04-clean-ui-run-page-design.md` (and the programme's text rule in `docs/superpowers/specs/2026-10-04-clean-ui-design.md`).

## Global Constraints

- Node 22 (`source ~/.nvm/nvm.sh && nvm use`) before every command.
- No colour, token, font, theme, route, contract or API change.
- Every tile change lands on BOTH renderings: the finished run's `RunStats` and the live run's `LiveSummary` (`apps/web/src/routes/RunSummary.tsx`).
- `InfoTip` never inside a heading or a `<th>`; its `label` is `About ${subject}`; its content holds no link (PR 1 keeps focus on the trigger, so a link inside is unreachable by Tab).
- Every new or edited test file imports `'@testing-library/jest-dom/vitest'` and calls `afterEach(cleanup)`.
- Red-verify each new case: checkpoint commit, one mutation, assert its replacement count is 1, read the failing assertion, restore with `git checkout HEAD -- <file>`.
- Re-pointing an existing case: point it at what replaced the text (an `InfoTip` description, a row, a link) or delete it with the claim it made. Never loosen a query to keep it green.
- Stage files by name (never `git add -A`); commit with `git commit -F -` and a quoted heredoc; no attribution lines.
- Read each gate's own exit code, never a pipeline's.

## Review Focus

1. **The first run of a test has no previous run.** It must show no deltas, no comparison row, and tiles still aligned. Pinned in Task 2.
2. **Every SLA rule came back not applicable.** The gates row must say `not evaluated`, never a failure sentence or "passed". Pinned in Task 1.
3. **Several platform gates failed.** The gates row must name the first and say "and N more". Pinned in Task 1.
4. **A live run.** Its tiles carry no hint lines and still offer the p95 ⓘ. Pinned in Task 2.
5. **Every band unticked.** The trigger reads `Bands · 0`, the chart shows its existing empty state, and the menu still opens to tick one back. Pinned in Task 5.

---

### Task 1: The release-gate band

**Files:**
- Modify: `apps/web/src/routes/RunDecisionBand.tsx`
- Test: `apps/web/test/RunDecisionBand.test.tsx`

**Interfaces:**
- Produces: no prop change. The middle column holds only `<dl data-testid="run-outcomes">` with its two `Outcome` rows (`outcome-gates`, `outcome-simulation`). The right column holds only the two actions. `gate-ticks`, `decision-detail`, the counts sentence, `DecisionCount`, `tickMarks` and `decisionDetail` no longer exist.

The gates row's value, in order:

| state | value |
| --- | --- |
| `assertions === undefined` | `not reported yet` |
| `!rulesRan(...)` | `not evaluated` |
| `assertions.length === 0` | `not configured` |
| any failed | `describeSlaOutcome(first) ?? first.message`, then ` and ${failed - 1} more` when `failed > 1`; tone `failed` |
| none failed, `counts.passed === 0` | `not evaluated` |
| otherwise | `passed` |

The simulation row: `not reported` / `none declared` / `passed` / unchanged `"${n} failed — ${expression}"` with its link.

- [ ] **Step 1: Write the failing tests** (use the file's existing fixture helpers for a run, assertions and tool assertions)

```tsx
it('states one row per system and repeats no counts', () => {
  // one failed run-scope error-rate gate, one passed p95 gate, one failed tool assertion
  expect(screen.queryByTestId('gate-ticks')).toBeNull();
  expect(screen.queryByTestId('decision-detail')).toBeNull();
  expect(screen.queryByText(/passed · .* failed/)).toBeNull();
  expect(screen.queryByText('N/A')).toBeNull();
  expect(screen.getByTestId('outcome-gates')).toHaveTextContent(/exceeds the 1% limit/);
  expect(screen.getByTestId('outcome-simulation')).toHaveTextContent(/1 failed/);
});

it('names the first failed gate and how many more failed', () => {
  // three failed gates
  expect(screen.getByTestId('outcome-gates')).toHaveTextContent(/and 2 more/);
});

it.each([
  ['no rules', [], 'not configured'],
  ['every rule not applicable', [/* all outcome 'not_applicable' */], 'not evaluated'],
  ['all passed', [/* all 'passed' */], 'passed'],
])('says the gates outcome in a word when %s', (_case, assertions, word) => {
  expect(screen.getByTestId('outcome-gates')).toHaveTextContent(new RegExp(`^Platform gates\\s*${word}$`));
});

it('keeps the two actions and nothing else on the right', () => {
  expect(screen.getByRole('link', { name: 'Compare runs' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /Export SLA summary/ })).toBeInTheDocument();
});
```

- [ ] **Step 2: Run, see them fail** — `pnpm exec vitest run apps/web/test/RunDecisionBand.test.tsx`.
- [ ] **Step 3: Implement** per Interfaces, deleting the removed pieces and the helpers only they used (lint reports any left unused).
- [ ] **Step 4: Run the file and re-point what fails** by the Global Constraints rule; expected exit 0.
- [ ] **Step 5: Red-verify** — put the counts sentence back (fails the first case); drop the "and N more" suffix (fails the second); map an all-not-applicable list to `passed` (fails that `it.each` row).
- [ ] **Step 6: Commit** — "Slim the release-gate band to its verdict, one row per system and its actions".

---

### Task 2: The stat tiles — finished and live

**Files:**
- Modify: `apps/web/src/components/StatTile.tsx`, `apps/web/src/routes/RunStats.tsx`, `apps/web/src/routes/RunSummary.tsx` (`LiveSummary`)
- Test: `apps/web/test/RunStats.test.tsx`, `apps/web/test/RunOverviewTab.baseline.test.tsx`, `apps/web/test/RunSummary.live.test.tsx`

**Interfaces:**
- Consumes: `InfoTip` (PR 1).
- Produces:
  - `StatTile`: `hint` is removed; `delta.label` widens to `ReactNode`; a new `info?: ReactNode` renders inside the `<dt>` after the label, which moves into its own `<span>`.
  - `RunStats`: `deltaFor` returns `{ change: string; tone } | undefined`, where `change` is `"+7.7%"`. The tile's delta label is `<>{change} vs <Link to={runPath(baseline.id)}>{baselineName}</Link></>`, where `baselineName` is `runName(baseline.runNumber)` or `previous run` when the number is null or undefined.
  - `BaselineNote` and the `percentile-method` disclosure are deleted. A new `ComparisonNote({ previous, here, previousName })` with `data-testid="comparison-note"` renders nothing when no finding is `differs` or `unknown`. Otherwise it renders a chip `data-testid="comparison-differs"` (only when some finding `differs`) with text `summariseConditions(findings.filter(f => f.kind === 'differs'))`, plus `<InfoTip label={`About the comparison with ${previousName}`}>` listing each notable finding as `${label}: this run ${values[0] ?? 'unknown'}, ${previousName} ${values[1] ?? 'unknown'}`.
  - The p95 tile's `info` (both renderings) is `<InfoTip label="About p95">`, with content: `p95 is estimated from a sketch of the whole run, accurate to within 1%, and shown clamped to the run’s own minimum and maximum. Error rate, requests and peak users are counted, not estimated.`
  - `LiveSummary`: every `hint` removed; p95 gets the same `info`.

- [ ] **Step 1: Write the failing tests**

```tsx
// RunStats.test.tsx (its renderStats helper already wraps a router)
it('names the run each delta compares against, as a link', () => {
  // baseline TrendRun with runNumber 10
  const links = screen.getAllByRole('link', { name: 'Run 10' });
  expect(links).toHaveLength(3); // error rate, requests, p95
  links.forEach((l) => expect(l).toHaveAttribute('href', runPath(BASELINE.id)));
  expect(screen.getByTestId('stat-error-rate').closest('div')).toHaveTextContent(/% vs Run 10/);
});

it('says vs previous run when the baseline has no number', () => {
  expect(screen.getAllByRole('link', { name: 'previous run' })).toHaveLength(3);
});

it('shows no deltas and no comparison row on a test’s first run', () => {
  // baseline null
  expect(screen.queryByRole('link', { name: /Run \d+|previous run/ })).toBeNull();
  expect(screen.queryByTestId('comparison-note')).toBeNull();
});

it('carries no hint lines', () => {
  expect(screen.queryByText(/of [\d,]+ requests/)).toBeNull();
  expect(screen.queryByText(/successful, .* failed/)).toBeNull();
  expect(screen.queryByText(/busiest moment/)).toBeNull();
  expect(screen.queryByText(/^estimate$/)).toBeNull();
  expect(screen.queryByText(/How percentiles are measured/)).toBeNull();
});

it('puts the p95 caveat behind an info beside its label', () => {
  expect(screen.getByRole('button', { name: 'About p95' })).toHaveAccessibleDescription(/within 1%/);
});

it('shows the differs chip only when the runs differ, and the comparison info whenever a finding exists', () => {
  // here.environment 'production', baseline.environment 'staging', branch unknown on one side
  expect(screen.getByTestId('comparison-differs')).toHaveTextContent('Different environment');
  expect(screen.getByRole('button', { name: 'About the comparison with Run 10' }))
    .toHaveAccessibleDescription(/Branch: this run .*unknown/);
  // re-render with only an unknown finding:
  expect(screen.queryByTestId('comparison-differs')).toBeNull();
  expect(screen.getByRole('button', { name: 'About the comparison with Run 10' })).toBeInTheDocument();
});

// RunSummary.live.test.tsx
it('gives the live tiles no hint lines and the same p95 info', () => {
  expect(screen.queryByText(/so far$/)).toBeNull();
  expect(screen.queryByText(/of [\d,]+ requests/)).toBeNull();
  expect(screen.getByRole('button', { name: 'About p95' })).toBeInTheDocument();
});
```

- [ ] **Step 2: Run, see them fail** — `pnpm exec vitest run apps/web/test/RunStats.test.tsx apps/web/test/RunOverviewTab.baseline.test.tsx apps/web/test/RunSummary.live.test.tsx`.
- [ ] **Step 3: Implement** per Interfaces. `pnpm typecheck` then names every `hint=` caller; remove them all.
- [ ] **Step 4: Run the three files and re-point what fails** (the baseline note's sentence cases become the link and `ComparisonNote` cases); expected exit 0.
- [ ] **Step 5: Red-verify** — drop the `Link` and keep plain text (fails the link cases); render the chip for an unknown-only finding (fails the chip case); restore one hint on the live p95 tile (fails the live case).
- [ ] **Step 6: Commit** — "Make each tile a label, a value and a delta that names its run".

---

### Task 3: The header's verdict badge goes

**Files:**
- Modify: `apps/web/src/routes/RunHeader.tsx` (the `NamedBadge` with `testId="run-verdict"`, ~line 420)
- Test: `apps/web/test/RunHeader.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
it('draws the status badge and no verdict badge', () => {
  // a complete, failed run
  expect(screen.getByTestId('run-status')).toBeInTheDocument();
  expect(screen.queryByTestId('run-verdict')).toBeNull();
});
```

Use the status badge's real testid from the file if it differs.

- [ ] **Step 2: Run, see it fail.**
- [ ] **Step 3: Remove the verdict badge** and any helper only it used; keep the `verdict` prop if other code in the header reads it, otherwise remove it and let `tsc` name the callers.
- [ ] **Step 4: Run `RunHeader.test.tsx` and re-point what fails;** expected exit 0.
- [ ] **Step 5: Red-verify** by restoring the badge; then commit: "Leave the verdict to the lifecycle strip and the band, not the header".

---

### Task 4: Gate cards state each rule once

**Files:**
- Modify: `apps/web/src/routes/AssertionBars.tsx` (~line 156)
- Test: `apps/web/test/AssertionBars.test.tsx`

**Interfaces:**
- Produces: the sentence `<p>` renders only when `describeSlaOutcome(a) === null`, i.e. a not-applicable gate, with `a.message` as its text.

- [ ] **Step 1: Write the failing tests**

```tsx
it('does not restate a passed or failed gate in a sentence', () => {
  expect(screen.queryByText(/exceeds the 1% limit\./)).toBeNull();
  expect(screen.queryByText(/is within the 2000 ms limit\./)).toBeNull();
  expect(screen.getByText(/Actual: 3\.1285%/)).toBeInTheDocument();
});

it('keeps the reason a not-applicable gate could not judge', () => {
  expect(screen.getByText(/No latency statistics/)).toBeInTheDocument();
});
```

Build the fixtures from the file's existing gate fixtures, so the two values match what `describeSlaOutcome` and the N/A message produce.

- [ ] **Step 2: Run, see the first fail.**
- [ ] **Step 3: Implement** per Interfaces.
- [ ] **Step 4: Run the file and re-point what fails;** expected exit 0.
- [ ] **Step 5: Red-verify** by rendering the sentence always; then commit: "State each gate's rule and actual once, keeping only a not-applicable gate's reason".

---

### Task 5: The percentile chart's Bands dropdown

**Files:**
- Modify: `apps/web/src/components/ui/dropdown-menu.tsx` (add and export `DropdownMenuCheckboxItem`, styled like `DropdownMenuRadioItem`, with an `ItemIndicator` check)
- Create: `apps/web/src/charts/BandsMenu.tsx`
- Modify: `apps/web/src/charts/PercentilesChart.tsx` (replace the "Percentile bands" `ControlGroup` of `Chip`s)
- Test: create `apps/web/test/BandsMenu.test.tsx`; re-point `apps/web/test/PercentilesChart.identity.test.tsx`

**Interfaces:**
- Produces: `export default function BandsMenu(props: { readonly id: string; readonly selected: readonly Band[]; readonly onToggle: (band: Band) => void }): JSX.Element`.
  - The trigger is a `<button>` with text `Bands · ${selected.length}`, `aria-label` `Percentile bands, ${n} selected`, and `data-testid` `bands-${id}`.
  - The content holds one `DropdownMenuCheckboxItem` per `BANDS` entry, in `BANDS` order: `checked={selected.includes(band)}`, `onSelect={(e) => e.preventDefault()}` (the menu stays open), `onCheckedChange={() => onToggle(band)}`, `data-testid` `band-${band}-${id}` (kept, so existing queries keep a handle), and a swatch `span` styled `background: var(--chart-pct-${band})`, then the band's existing label.
- `PercentilesChart` renders `<ControlGroup label="Percentile bands"><BandsMenu id={id} selected={bands} onToggle={toggle} /></ControlGroup>` on the same `ControlBar` as the outcome and scale controls.

- [ ] **Step 1: Write the failing tests** in `BandsMenu.test.tsx` (render `PercentilesChart` with the existing reference series fixture used by `PercentilesChart.identity.test.tsx`)

```tsx
it('opens one checkbox per band, in band order, reflecting the selection', async () => {
  await user.click(screen.getByRole('button', { name: 'Percentile bands, 6 selected' }));
  const items = screen.getAllByRole('menuitemcheckbox');
  expect(items.map((i) => i.textContent)).toEqual(['min', '25%', '50%', '75%', '80%', '85%', '90%', '95%', '99%', 'max']);
  expect(screen.getByTestId('band-p95-percentiles')).toHaveAttribute('aria-checked', 'true');
  expect(screen.getByTestId('band-p25-percentiles')).toHaveAttribute('aria-checked', 'false');
});

it('toggles a band by keyboard and stays open', async () => {
  screen.getByRole('button', { name: /Percentile bands/ }).focus();
  await user.keyboard('{Enter}');
  // arrow to 25% and press Space
  expect(screen.getByTestId('band-p25-percentiles')).toHaveAttribute('aria-checked', 'true');
  expect(screen.getByRole('menu')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Percentile bands, 7 selected' })).toBeInTheDocument();
});

it('closes on Escape and returns focus to the trigger', async () => { /* … */ });

it('draws what is ticked', async () => {
  // tick 25%, then read the chart's data table
  expect(screen.getByTestId('chart-data-percentiles')).toHaveTextContent('25%');
});

it('reads Bands · 0 with nothing ticked and still opens', async () => {
  // untick all six defaults
  expect(screen.getByRole('button', { name: 'Percentile bands, 0 selected' })).toHaveTextContent('Bands · 0');
  expect(screen.getByRole('status')).toHaveTextContent(/no percentile bands are selected/i);
});
```

The exact item labels come from the chart's existing band labels; read them rather than assuming, and keep the assertion a whole-list `toEqual`.

- [ ] **Step 2: Run, see them fail.**
- [ ] **Step 3: Implement** the wrapper export, `BandsMenu`, and the swap in `PercentilesChart`.
- [ ] **Step 4: Run `BandsMenu.test.tsx`, `PercentilesChart.identity.test.tsx` and `Chart.test.tsx`, re-pointing chip clicks to "open the menu, then click the item";** expected exit 0.
- [ ] **Step 5: Red-verify** — remove the `onSelect` `preventDefault` (fails "stays open"); reverse the item order (fails the order case).
- [ ] **Step 6: Commit** — "Fold the percentile chart's ten band chips into one Bands menu".

---

### Task 6: One-line empty states, the Trends line, and the whole-run tag

**Files:**
- Modify: `apps/web/src/tables/ErrorsTable.tsx` (the empty state's `body`, both branches, ~line 208); `apps/web/src/routes/RequestDetail.tsx` (the not-found `body`, ~line 214); `apps/web/src/routes/RunTrends.tsx` (the "Overlay up to …" span, ~line 154); `apps/web/src/routes/WholeRunNotice.tsx`
- Test: `apps/web/test/ErrorsTable.test.tsx`, `apps/web/test/RequestDetail.test.tsx`, `apps/web/test/GroupDetail.test.tsx`, and the Trends test file that renders the Compare link

**Interfaces:**
- Produces: `WholeRunNotice({ what })` renders `<p data-testid="whole-run-notice">` containing a short visible tag `Whole-run figures`, followed by `<InfoTip label="About whole-run figures">The time window you selected does not narrow {what} — these endpoints report the whole run. The run’s Report still honours it.</InfoTip>`.

- [ ] **Step 1: Write the failing tests**

```tsx
it('says an empty errors result in one line', () => {
  // scoped and unscoped
  expect(screen.queryByText(/came back OK/)).toBeNull();
  expect(screen.getByText(/No errors recorded for Search/)).toBeInTheDocument();
});

it('tags whole-run figures under a window and explains behind an info', () => {
  expect(screen.getByTestId('whole-run-notice')).toHaveTextContent(/^Whole-run figures/);
  expect(screen.getByRole('button', { name: 'About whole-run figures' }))
    .toHaveAccessibleDescription(/does not narrow/);
});
```

Plus: the request-not-found state has no "The link may be from a different run" sentence, and Trends has no "Overlay up to" text while its Compare link stays.

- [ ] **Step 2: Run, see them fail.**
- [ ] **Step 3: Implement** the four edits.
- [ ] **Step 4: Run the files and re-point what fails;** expected exit 0.
- [ ] **Step 5: Red-verify** by restoring `WholeRunNotice`'s paragraph (fails the tag case); then commit: "Keep empty states to one line and tag whole-run figures behind an info".

---

### Task 7: Browser coverage, measurement, and shipping

**Files:**
- Modify: `apps/web/e2e/run-charts.spec.ts` (chip clicks at ~997–1110 become "open the Bands menu, then click the item", and `aria-pressed` becomes `aria-checked`), plus whatever the full run shows needs re-pointing
- Create a case in `apps/web/e2e/info-tip.spec.ts` or `run-charts.spec.ts`: the Bands menu by keyboard
- Modify: `CLAUDE.md` (an entry and the floors)

- [ ] **Step 1: The keyboard case**

```ts
test('the percentile chart’s Bands menu works from the keyboard', async ({ page }) => {
  // seedAdmin → seedRunWithData → signIn → goto runPath(runId)
  const trigger = page.getByRole('button', { name: /^Percentile bands, \d+ selected$/ });
  await trigger.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('menu')).toBeVisible();
  // ArrowDown to "25%", Space, then the menu is still open and the trigger counts one more
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
});
```

- [ ] **Step 2: Scratch stores and the full e2e run.** Create database `perfportal_cleanui2`, migrate it, and use a free Redis index. Then run `pnpm test:e2e > $W/e2e.txt 2>&1; echo "exit=$?"`, read back the `Running N tests` line, and re-point what fails. Expected: `mobile.spec.ts`'s first-tile bound still holds.
- [ ] **Step 3: The full gate**, each by its own exit code: `typecheck`, `lint`, `test:unit`, then `test:integration` behind the load gate (1-minute load < 8 and 5-minute load < 10), then `test:e2e`.
- [ ] **Step 4: The after-audit.** Re-run the headless text audit on the same routes and the same run; record Summary, Report, request, group and Trends before and after.
- [ ] **Step 5: The final whole-branch review** on the strongest model, then one fix pass.
- [ ] **Step 6: The `CLAUDE.md` entry and floors,** committed alone.
- [ ] **Step 7: Push, open the PR, dispatch `e2e-cross-browser`, and bind the PR.** Merge only on the user's word, after the SHA-pinned green check.
