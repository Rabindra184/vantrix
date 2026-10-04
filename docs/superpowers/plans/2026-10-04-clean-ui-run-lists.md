# Clean UI, PR 3 — the run lists — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The three run lists lose their repetition and width — the class name leads and never breaks mid-word, Focus goes, the tally is one line, Started is short — with no route, contract or API change.

**Architecture:** `RunList.tsx` is edited in place; two new focused files, `SimulationName.tsx` (the name cell, shared by the table row and the phone card) and `RunTally.tsx` (the one-line tally), take the new pieces. `format.ts` gains two date helpers. `TestRuns.tsx` drops a chip that repeats its heading.

**Tech Stack:** React 19, React Router, Tailwind v4, Vitest + Testing Library (jsdom), Playwright.

**Spec:** `docs/superpowers/specs/2026-10-04-clean-ui-run-lists-design.md` (and the programme spec's text rule, `docs/superpowers/specs/2026-10-04-clean-ui-design.md`).

## Global Constraints

- Palette, theme, tokens, fonts, routes, contracts, APIs and data do not change.
- Node 22 (`nvm use`); every gate's exit code read on its own (`cmd > file 2>&1; echo "exit=$?"`), never through a pipe.
- Status colours are applied inline (`style={{ color: 'var(--color-status-failed)' }}`); `text-status-*` utilities emit nothing.
- `InfoTip`: `label` named after its subject ("About these counts"); never inside a heading or a `<th>`.
- No `Intl.DateTimeFormat` at module scope in new code — build per call.
- Every new or re-pointed assertion is red-verified by a mutation with its replacement count asserted; restore with `git checkout -- <file>` only on a file with no uncommitted changes.
- Never `git add -A` (untracked `docs/ui-review-2026-09-13/`, `review.md`, `scripts/seed-manual-test.mjs` must never be committed); commit messages via `git commit -F -` with a quoted heredoc; no attribution lines.
- Integration and e2e run against scratch stores (a scratch `DATABASE_URL`, a scratch Redis index, `PERFPORTAL_E2E_PORT`), never concurrently with each other.

## Review Focus

1. **Runs on one page that straddle a daylight-saving change.** The header names the first row's zone; a row in another zone must show its own suffix, never a time under the wrong zone. Pinned in Task 4.
2. **A class name with no dot and no camelCase boundary** (`loadtest`). It renders whole as one piece, with no package line and no stray `<wbr>`. Pinned in Task 1.
3. **A run whose `checks` is null, absent or `{ failed: 0 }`.** It gets no assertion line, and one failure reads in the singular. Pinned in Task 2.
4. **A run from an earlier year** (in January, a December run) shows its year; this year's runs do not. Pinned in Task 4.
5. **A run the worker has not parsed** (`simulation: null`) keeps its short id on the org list, and a test's list keeps "Run N". `SimulationName` is not used for either. Pinned in Task 1.

---

### Task 1: `SimulationName` in the row and the card

**Files:**
- Create: `apps/web/src/routes/SimulationName.tsx`
- Create: `apps/web/test/SimulationName.test.tsx`
- Modify: `apps/web/src/routes/RunList.tsx` (`RunRow` cell `run-simulation` ~L1430: drop `break-all`, keep `min-w-0`; `RunCard` link ~L1289: drop `break-all`; both render `<SimulationName name={run.simulation} />` where they render `run.simulation` today; the long `break-all` comment above the cell is rewritten to say what the cell does now)
- Modify: `apps/web/e2e/run-list.spec.ts` (inside "a real simulation class does not push the triage columns off screen")

**Interfaces:**
- Produces: `export default function SimulationName({ name }: { readonly name: string }): JSX.Element` and, for tests, `export function namePieces(name: string): { package: string[]; className: string[] }`.

- [ ] **Step 1: Write the failing unit tests** in `apps/web/test/SimulationName.test.tsx`:

```tsx
it('splits the package from the class and the class at its words', () => {
  expect(namePieces('com.acme.checkout.CheckoutPeakLoadSimulation')).toEqual({
    package: ['com.', 'acme.', 'checkout.'],
    className: ['Checkout', 'Peak', 'Load', 'Simulation'],
  });
});
it('keeps a name with no dot and no word boundary as one piece', () => {
  expect(namePieces('loadtest')).toEqual({ package: [], className: ['loadtest'] });
});
it('renders text that rejoins to the full name, with no break-all', () => {
  const { container } = render(<SimulationName name="example.ParitySimulation" />);
  expect(container.textContent).toBe('example.ParitySimulation');
  expect(container.querySelector('.break-all')).toBeNull();
  expect(container.querySelectorAll('wbr').length).toBeGreaterThan(0);
  for (const piece of container.querySelectorAll('[data-name-piece]')) {
    expect(piece).toHaveClass('whitespace-nowrap');
  }
});
it('draws the package as its own muted line and omits it when there is none', () => {
  const { container, rerender } = render(<SimulationName name="example.ParitySimulation" />);
  expect(container.querySelector('[data-name-package]')).toHaveTextContent('example.');
  rerender(<SimulationName name="loadtest" />);
  expect(container.querySelector('[data-name-package]')).toBeNull();
  expect(container.querySelector('wbr')).toBeNull();
});
```

And one case in `apps/web/test/RunList.test.tsx` (Review Focus 5): on `/runs` a row with `simulation: null` shows `run.id.slice(0, 8)` and a test's list shows `Run 3` for `runNumber: 3`, and in neither cell is there a `[data-name-package]` element.

- [ ] **Step 2: Run them, expect failure**

Run: `pnpm exec vitest run apps/web/test/SimulationName.test.tsx apps/web/test/RunList.test.tsx`
Expected: FAIL — cannot resolve `../src/routes/SimulationName` (the RunList case passes already; it is a keeper, red-verified in Step 5).

- [ ] **Step 3: Implement `SimulationName` and `namePieces`**

`namePieces`: split on the last `.`; package segments each keep their trailing dot; the class splits before an upper-case letter that follows a lower-case letter or a digit (`/(?<=[a-z0-9])(?=[A-Z])/`). Render: a `<span data-name-package className="block text-[0.6875rem] font-normal text-muted">` of package pieces when non-empty, then the class pieces; every piece a `<span data-name-piece className="whitespace-nowrap">`, consecutive pieces separated by `<wbr />`, no whitespace between elements. Use it in `RunRow` and `RunCard` for the simulation branch only.

- [ ] **Step 4: Add the browser assertion** at the end of the 56-character case in `run-list.spec.ts`: at 768 and 1024 (table) and at 375 (cards, after `page.setViewportSize({ width: 375, height: 812 })` and `page.goto('/runs')`), every `[data-testid="run-simulation"] [data-name-piece]` has `getClientRects().length === 1`, with the message naming the piece and width.

- [ ] **Step 5: Run, then red-verify**

Run: `pnpm exec vitest run apps/web/test/SimulationName.test.tsx apps/web/test/RunList.test.tsx apps/web/test/RunList.compact.test.tsx` → PASS. Then, with the scratch env, `pnpm exec playwright test apps/web/e2e/run-list.spec.ts apps/web/e2e/copy-ids.spec.ts apps/web/e2e/acceptance.spec.ts` → PASS.
Red-verify: (a) piece class `whitespace-nowrap` → `break-all` fails the unit no-break case and the browser one-line case; (b) `RunRow` rendering `<SimulationName>` for a null simulation (fallback removed) fails the Focus-5 keeper.
If `copy-ids.spec.ts`'s "button beside the name" guard fails because the link is now two lines, re-point it at its claim (the button sits beside the link's first line and the class pieces keep at least the header word's width) and ledger a ruling.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/routes/SimulationName.tsx apps/web/test/SimulationName.test.tsx apps/web/src/routes/RunList.tsx apps/web/test/RunList.test.tsx apps/web/e2e/run-list.spec.ts
git commit -F - <<'MSG'
Lead the run lists' name cell with the class, breaking only at words
MSG
```

### Task 2: The assertion line in the Verdict cell, and Focus removed

**Files:**
- Modify: `apps/web/src/routes/RunList.tsx` (Verdict `<td>` in `RunRow`; the badge group in `RunCard`; delete the Focus `<th>`/`<td>`, the card's Focus `<div>`, `FocusHint`, `Focus`, `FOCUS_MARKS`, `focusFor`; the `info` sentence about Focus; `SkeletonTable columns={projectSlug === null ? 8 : 7}`)
- Modify: `apps/web/test/RunList.test.tsx`, `apps/web/test/RunList.compact.test.tsx`

**Interfaces:**
- Consumes: `RunListItem['checks']` (`{ failed: number; total: number } | null | undefined`).
- Produces: in `RunList.tsx`, `function AssertionLine({ checks }: { readonly checks: RunListItem['checks'] }): JSX.Element | null`, rendering `<span data-testid="run-assertions-failed" className="block text-[0.75rem]" style={{ color: 'var(--color-status-failed)' }}>` with `1 assertion failed` / `${n} assertions failed`, or null.

- [ ] **Step 1: Write the failing tests** — re-point "summarizes the current page and adds a focus signal after verdict" (delete its Focus lines; the tally half moves to Task 3) and delete the "the Focus cell" describe with its claim; add:

```tsx
it('names a failed simulation assertion in the Verdict cell, and only then', async () => {
  renderList([TRIAGE_ROW, { ...TRIAGE_ROW, id: '77777777-7777-4777-8777-777777777777', checks: { failed: 0, total: 3 } },
              { ...TRIAGE_ROW, id: '88888888-8888-4888-8888-888888888888', checks: null }]);
  const lines = await screen.findAllByTestId('run-assertions-failed');
  expect(lines).toHaveLength(1);
  expect(lines[0]).toHaveTextContent(/^1 assertion failed$/);
});
it('counts failed assertions in the plural', async () => {
  renderList([{ ...TRIAGE_ROW, checks: { failed: 2, total: 3 } }]);
  expect(await screen.findByTestId('run-assertions-failed')).toHaveTextContent(/^2 assertions failed$/);
});
it('draws no Focus column', async () => {
  renderList([...ROWS]);
  await screen.findByRole('columnheader', { name: 'Simulation' });
  expect(screen.queryByRole('columnheader', { name: 'Focus' })).toBeNull();
  expect(screen.queryByText('investigate')).toBeNull();
});
```

In `RunList.compact.test.tsx`: the card shows the same line for a `checks.failed > 0` row and no `Focus` term; the "carries the caveat behind an info" case asserts the description no longer mentions Focus (`not.toHaveAccessibleDescription(/Focus/)`) and still mentions `ingest time`.

- [ ] **Step 2: Run, expect failure** — `pnpm exec vitest run apps/web/test/RunList.test.tsx apps/web/test/RunList.compact.test.tsx` → FAIL (no `run-assertions-failed`; Focus header present).

- [ ] **Step 3: Implement** `AssertionLine` under the Verdict badge in both layouts, delete Focus as listed, update the `info` and the skeleton count.

- [ ] **Step 4: Run, then red-verify** — same command → PASS. Red-verify: `checks.failed > 0` → `>= 0` fails the only-then case; the plural ternary inverted fails the plural case.

- [ ] **Step 5: Commit** (`RunList.tsx`, both test files): "Move a failed simulation assertion into the Verdict cell and drop Focus".

### Task 3: `RunTally`

**Files:**
- Create: `apps/web/src/routes/RunTally.tsx`
- Create: `apps/web/test/RunTally.test.tsx`
- Modify: `apps/web/src/routes/RunList.tsx` (render `<RunTally items={items} />` where `<RunListHealth items={items} />` is; delete `RunListHealth`, `HealthTile`, `healthSummary`, `HEALTH_SCOPE`, `HEALTH_CAVEAT`; move `needsAttention`/`isInFlight` into `RunTally.tsx` — after Task 2 nothing else in `RunList.tsx` reads them)
- Modify: `apps/web/test/RunList.test.tsx`, `apps/web/test/RunList.compact.test.tsx` (re-point the tally cases)

**Interfaces:**
- Produces: `export default function RunTally({ items }: { readonly items: readonly RunListItem[] })`, with `needsAttention`, `isInFlight` and the count reduction private to the file. Markup: `<section aria-label="Run health on this page">`, `<span data-testid="health-scope">On this page</span>`, each count a `<div data-testid="health-<slug>">` holding the number and its label, then `<InfoTip label="About these counts">`.

- [ ] **Step 1: Write the failing tests** in `RunTally.test.tsx`, from a four-run fixture (one failed, one pending, one passed, one with `verdict: null`):

```tsx
it('counts the page in four labelled numbers, zeros included', () => {
  render(<RunTally items={FOUR} />);
  for (const [id, n] of [['needs-attention', 1], ['in-flight', 1], ['passed-gates', 1], ['unjudged', 2]] as const) {
    expect(screen.getByTestId(`health-${id}`)).toHaveTextContent(String(n));
  }
  render(<RunTally items={[]} />);   // separate render: every count reads 0
});
it('scopes the counts without repeating the run total, and carries no descriptions', () => {
  render(<RunTally items={FOUR} />);
  expect(screen.getByTestId('health-scope')).toHaveTextContent(/^On this page$/);
  expect(screen.queryByText(/Pending, parsing, or live/)).toBeNull();
  expect(screen.queryByText('How counts work')).toBeNull();
  expect(screen.queryByRole('group')).toBeNull();
});
it('puts what each count includes behind one info', () => {
  render(<RunTally items={FOUR} />);
  const info = screen.getByRole('button', { name: 'About these counts' });
  expect(info).toHaveAccessibleDescription(/simulation assertion failed/i);
  expect(info).toHaveAccessibleDescription(/more than one/i);
  expect(info).toHaveAccessibleDescription(/this page only/i);
});
```

Re-point in `RunList.test.tsx`: the scope assertion (`/on this page · N runs/`) becomes `toHaveTextContent(/^On this page$/)`; "names what the counts do not include" reads the info's description instead of the region's text. In `RunList.compact.test.tsx`: the four "tally keeps both caveats" cases read the info's description (page-local, counts simulation assertions, more than one, no denial), and "shows the scope visibly and folds the methodology" asserts `On this page` and the info at both widths, with no `group`.

- [ ] **Step 2: Run, expect failure** — `pnpm exec vitest run apps/web/test/RunTally.test.tsx apps/web/test/RunList.test.tsx apps/web/test/RunList.compact.test.tsx` → FAIL (module missing; old scope text).

- [ ] **Step 3: Implement `RunTally`** — one `flex flex-wrap items-baseline gap-x-5 gap-y-1 text-[0.75rem]` line, no border; counts `font-mono text-[0.8125rem] font-semibold tabular-nums text-primary`, labels `text-muted`. The info text (spec, verbatim in meaning): Needs attention — failed, stopped early, SLA verdict failed, or a simulation assertion failed; In flight — pending, parsing or live; Passed gates — SLA verdict passed; Unjudged — no verdict, or not evaluated; a run can be counted more than once; the counts cover this page only.

- [ ] **Step 4: Run, then red-verify** — same command plus `pnpm exec playwright test apps/web/e2e/run-list.spec.ts apps/web/e2e/mobile.spec.ts` → PASS. Red-verify: drop the `checks` arm of `needsAttention` (the existing "counts a failing simulation check" case fails); restore the run total in the scope (the scope case fails).

- [ ] **Step 5: Commit** (`RunTally.tsx`, `RunTally.test.tsx`, `RunList.tsx`, both RunList test files): "Draw the run tally as one line of counts with one info".

### Task 4: Started and the column order

**Files:**
- Modify: `apps/web/src/routes/format.ts`, `apps/web/test/format.test.ts`
- Modify: `apps/web/src/routes/RunList.tsx` (`<th>` `Started (${zone})`; the Started `<td>`; the order comment block)
- Modify: `apps/web/test/RunList.test.tsx`

**Interfaces:**
- Produces: `export function formatListInstant(iso: string, now: Date = new Date()): string` and `export function zoneLabel(iso: string): string` in `format.ts`.

- [ ] **Step 1: Write the failing tests** in `format.test.ts` (each zone case asserts its flip took, as the file's helpers do):

```ts
it('drops the zone, and the year when it is this year', () => inZone('Asia/Kolkata', () => {
  kolkataTook();
  const out = formatListInstant('2026-10-02T14:14:00Z', new Date('2026-10-04T00:00:00Z'));
  expect(out).toMatch(/Oct/); expect(out).toMatch(/(7|19):44/);
  expect(out).not.toMatch(/2026/); expect(out).not.toMatch(/GMT|UTC/);
}));
it('keeps the year for a run from an earlier year', () => inZone('Asia/Kolkata', () => {
  kolkataTook();
  expect(formatListInstant('2025-12-30T10:00:00Z', new Date('2026-01-05T00:00:00Z'))).toMatch(/2025/);
}));
it('names the zone formatInstant names, and two across a DST change', () => inZone('America/New_York', () => {
  expect(new Date('2026-01-15T12:00:00Z').getHours()).toBe(7);
  const winter = '2026-03-01T15:00:00Z', summer = '2026-04-01T15:00:00Z';
  expect(formatInstant(winter).endsWith(zoneLabel(winter))).toBe(true);
  expect(zoneLabel(winter)).not.toBe(zoneLabel(summer));
}));
```

In `RunList.test.tsx`: the header order is `['Project','Simulation','Status','Verdict','p95','Errors', /^Started \(.+\)$/,'Environment']` on `/runs` (read via `getAllByRole('columnheader')`); and, with `process.env.TZ = 'America/New_York'` set in a `try`/`finally` that restores it (asserting the flip took, as `format.test.ts` does), two rows with `toolStartedAt` 2026-04-01 (first) and 2026-03-01: exactly one `run-started` cell carries a zone suffix, and it differs from the zone in the header.

- [ ] **Step 2: Run, expect failure** — `pnpm exec vitest run apps/web/test/format.test.ts apps/web/test/RunList.test.tsx` → FAIL (not exported; header `Started`).

- [ ] **Step 3: Implement** — `formatListInstant`: `new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', ...(differentYear ? { year: 'numeric' } : {}) })` built per call, year compared in local time. `zoneLabel`: `formatToParts` with `timeZoneName: 'short'`, return the `timeZoneName` part. `RunList`: the header zone is `zoneLabel` of the first item's started instant; a row appends ` ${zoneLabel}` (muted) when it differs; `<time dateTime>` and the "ingest time" marker stay; the order is `[Project] · Simulation/Run · Status · Verdict · p95 · Errors · Started · Environment`; `RunCard` keeps `formatInstant`.

- [ ] **Step 4: Run, then red-verify; measure** — same command, and under `TZ=UTC pnpm exec vitest run apps/web/test/format.test.ts` → PASS. Red-verify: always include the year (the this-year case fails); never suffix a row (the DST case fails). Then with the scratch env `pnpm exec playwright test apps/web/e2e/run-list.spec.ts apps/web/e2e/copy-ids.spec.ts` → PASS, and measure the table's `scrollWidth` against its box at 1100, 1280 and 1440 on `/runs` (throwaway script; record the numbers in the ledger).

- [ ] **Step 5: Commit** (`format.ts`, `format.test.ts`, `RunList.tsx`, `RunList.test.tsx`): "Shorten Started and state its timezone once, in the header".

### Task 5: The test page's class chip

**Files:**
- Modify: `apps/web/src/routes/TestRuns.tsx` (~L348, the `Simulation class` `Chip`)
- Modify: `apps/web/test/TestRuns.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
it('omits the class chip when the class is the test’s own name', async () => {
  stubFetch({ test: { ...TEST, name: 'example.CheckoutSimulation' } });   // this file's helpers
  renderPage();
  await screen.findByRole('heading', { level: 1, name: 'example.CheckoutSimulation' });
  expect(screen.queryByText('Simulation class')).toBeNull();
  expect(screen.getByText(/2 runs/)).toBeInTheDocument();
});
```

plus a keeper: `stubFetch()` with `TEST` as is (`name: 'Checkout smoke'`), and the chip shows `example.CheckoutSimulation`.

- [ ] **Step 2: Run, expect failure** — `pnpm exec vitest run apps/web/test/TestRuns.test.tsx` → FAIL (chip present).
- [ ] **Step 3: Implement** — render the chip only when `row.simulationClass !== row.name`.
- [ ] **Step 4: Run, then red-verify** — PASS; the condition removed fails the new case, the condition inverted fails the keeper.
- [ ] **Step 5: Commit** (`TestRuns.tsx`, `TestRuns.test.tsx`): "Stop a test's page repeating its class when the class is its name".

### Task 6: The gate, the measurement, the review, the record

- [ ] **Step 1:** Re-read every comment in `RunList.tsx`, `RunTally.tsx`, `SimulationName.tsx`, `TestRuns.tsx` and the touched specs that describes Focus, the tally tiles, "How counts work", `break-all` on the name or the 239px Started; correct each to what the code does. Commit alone.
- [ ] **Step 2:** `pnpm typecheck`, `pnpm lint`, `pnpm test:unit` (predict the new floor from the source first: two new unit files plus the cases above), then `pnpm test:integration` behind the load gate on scratch stores (only `format.test.ts` is a `.ts` file it also runs), then `pnpm test:e2e --workers=2` (e2e count unchanged at 188 — every browser assertion above goes inside an existing case). Each exit code read on its own; every failure read, fixed and re-run.
- [ ] **Step 3:** Before/after word audit of `/runs`, `/projects/gatling-demo/runs` and the test page against the developer database at 1440×900 (before: 503, 380, 351 words).
- [ ] **Step 4:** Final whole-branch review on Opus (review package + `code-reviewer.md`, this Review Focus verbatim, the ledger's rulings); one fix pass, each fix RED→GREEN.
- [ ] **Step 5:** `CLAUDE.md` entry and floors, committed alone.
- [ ] **Step 6:** Push, open the PR (no attribution), dispatch `gh workflow run ci.yml --ref feat/clean-ui-run-lists`, bind the PR. Merge only on the user's word.
