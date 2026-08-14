# Design System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace PerfPortal's token layer with the slate/reference palette, add the four shared primitives, and put six stat tiles on the run page.

**Architecture:** `tokens.css` drops from four declaration blocks to three and gains ~15 tokens exported through Tailwind v4 `@theme`; `charts/theme.ts` stays the single compiled source of colour truth and `palette.test.ts` keeps proving the two agree, with its gate set changed rather than replaced. Primitives are added under `apps/web/src/components/` and consumed by existing pages without moving any route.

**Tech Stack:** React 18, Tailwind v4 (`@tailwindcss/vite`), ECharts 6 (SVG renderer), Vitest (jsdom + node), Playwright.

**Spec:** `docs/superpowers/specs/2026-08-14-perf-portal-design-system-design.md`

## Global Constraints

- Node 22 (`.nvmrc` pins 22.19.0). Run `nvm use` first.
- Full gate before claiming done: `pnpm typecheck && pnpm lint && pnpm test:unit && pnpm test:integration && pnpm test:e2e`. `test:integration` and `test:e2e` need the docker stack and the env vars in `infra/README.md`, and must never run concurrently — both truncate the same database.
- Branch is `feat/design-system`, already created, already carrying the spec commit. One PR to `main`, merged with `--merge`, never squashed.
- **Colour values are edited in `charts/theme.ts`, never in `tokens.css` first.** `tokens.css` mirrors it; `palette.test.ts` fails if they disagree.
- Expectations are computed from the payload, never hard-coded. A test that writes down a number `reference-run.json` supplies breaks on the next re-capture for a reason that is not a defect.
- `?name=X` without `scope` is silently ignored by the metrics endpoints. Both parameters, always.
- Accessible-name assertions go in Playwright, never jsdom: `dom-accessibility-api` does not consult a descendant's `aria-label` and Chromium does.

---

## File Structure

| File | Responsibility |
|---|---|
| `apps/web/src/styles/tokens.css` | Runtime token values, three blocks, `@theme` export |
| `apps/web/src/charts/theme.ts` | Compiled colour truth: palettes, ramps, role→token map |
| `apps/web/test/palette.test.ts` | The gate that keeps the two above honest |
| `apps/web/src/components/Card.tsx` | Bordered surface with optional title/description |
| `apps/web/src/components/Badge.tsx` | Status pill rendering a `Mark` |
| `apps/web/src/components/StatTile.tsx` | Label / value / hint tile |
| `apps/web/src/components/tableStyles.ts` | Shared table class strings |
| `apps/web/src/charts/Chart.tsx` | Wraps its figure in `Card`; lifts the palette cap for role-coloured charts |
| `apps/web/src/charts/PercentilesChart.tsx` | Consumes the ten-step ramp |
| `apps/web/src/routes/RunDetail.tsx` | Gains the stat row |

---

### Task 1: Four token blocks become three

**Files:**
- Modify: `apps/web/src/styles/tokens.css:75-155`
- Modify: `apps/web/test/palette.test.ts:217-230`

**Interfaces:**
- Consumes: nothing
- Produces: a three-block `tokens.css` — `:root`, `@media (prefers-color-scheme: dark) { :root:not([data-theme='light']) }`, `[data-theme='dark']`. Every later task adds tokens to exactly these three.

- [ ] **Step 1: Write the failing test**

In `apps/web/test/palette.test.ts`, replace the four-entry `BLOCKS` array (lines 219-230) with three, and add a guard that the removed block is really gone:

```ts
const BLOCKS = [
  { where: ':root (light)', block: () => blockAfter(':root'), mode: 'light' as const },
  {
    where: '@media (prefers-color-scheme: dark) :root',
    block: () => blockAfter(':root', mediaDark),
    mode: 'dark' as const,
  },
  { where: "[data-theme='dark']", block: () => blockAfter("[data-theme='dark']"), mode: 'dark' as const },
];

/**
 * `[data-theme='light']` is GONE, and its absence is the assertion. The media
 * query's own `:not([data-theme='light'])` is what lets an explicit light
 * override win over a dark OS setting, so a re-added block would be a second,
 * silently-diverging copy of the light values rather than a safety net.
 */
it('declares no [data-theme=\'light\'] block', () => {
  expect(css).not.toContain("[data-theme='light'] {");
});

it('scopes the dark media block so an explicit light theme still wins', () => {
  expect(css).toContain("@media (prefers-color-scheme: dark)");
  expect(css.slice(mediaDark, mediaDark + 200)).toContain(":root:not([data-theme='light'])");
});
```

- [ ] **Step 2: Run it to make sure it fails**

```bash
pnpm vitest run apps/web/test/palette.test.ts
```

Expected: FAIL — `declares no [data-theme='light'] block` fails because the block is still there, and the `:not(...)` assertion fails because the media block currently opens with a bare `:root`.

- [ ] **Step 3: Change tokens.css**

Delete the entire `[data-theme='light'] { … }` block (lines 105-129). Change the media query's selector from `:root` to `:root:not([data-theme='light'])`. Leave `[data-theme='dark']` as it is. Replace the comment above the explicit-override blocks with:

```css
/* Three blocks, not four. The media query's own :not() is what lets an
   explicit light theme beat a dark OS setting, so [data-theme='light'] needs
   no block of its own — and not having one is what stops the light values
   existing in two places that can disagree. */
```

- [ ] **Step 4: Run the tests and make sure they pass**

```bash
pnpm vitest run apps/web/test/palette.test.ts
```

Expected: PASS, all blocks. Then `pnpm test:unit` — still 605 passing.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/styles/tokens.css apps/web/test/palette.test.ts
git commit -m "refactor(web): tokens.css declares three blocks, not four"
```

---

### Task 2: The new surface, text and accent tokens

**Files:**
- Modify: `apps/web/src/charts/theme.ts`
- Modify: `apps/web/src/styles/tokens.css`
- Modify: `apps/web/test/palette.test.ts`

**Interfaces:**
- Consumes: Task 1's three blocks
- Produces: `SURFACE_TOKENS` exported from `theme.ts` as `Readonly<Record<ChartMode, Readonly<Record<SurfaceRole, string>>>>` where
  `type SurfaceRole = 'page' | 'card' | 'sidebar' | 'sunken' | 'border' | 'divider' | 'text-primary' | 'text-muted' | 'text-subtle' | 'accent' | 'accent-foreground' | 'ring'`.
  Tailwind utility names produced: `bg-page`, `bg-surface`, `bg-sidebar`, `bg-sunken`, `border-default`, `border-divider`, `text-primary`, `text-muted`, `text-subtle`, `bg-accent`, `text-accent`, `ring-accent`.

- [ ] **Step 1: Write the failing test**

Add to `palette.test.ts`:

```ts
const SURFACE_TOKENS_UNDER_TEST: readonly { role: SurfaceRole; token: string }[] = [
  { role: 'page', token: '--color-surface-page' },
  // Three tokens carry a longer name than their role so the @theme key can
  // hold the short one. A key that reads a var of its OWN name is circular.
  { role: 'card', token: '--color-surface-card' },
  { role: 'sidebar', token: '--color-surface-sidebar' },
  { role: 'sunken', token: '--color-surface-sunken' },
  { role: 'border', token: '--color-border' },
  { role: 'divider', token: '--color-rule' },
  { role: 'text-primary', token: '--color-text-primary' },
  { role: 'text-muted', token: '--color-text-muted' },
  { role: 'text-subtle', token: '--color-text-subtle' },
  { role: 'accent', token: '--color-accent-base' },
  { role: 'accent-foreground', token: '--color-accent-foreground' },
  { role: 'ring', token: '--color-ring' },
];

it.each(BLOCKS)('$where carries the surface tokens theme.ts exports', ({ where, block, mode }) => {
  const body = block();
  const found = SURFACE_TOKENS_UNDER_TEST.map(({ token }) => tokenIn(body, token, where));
  expect(found).toEqual(
    SURFACE_TOKENS_UNDER_TEST.map(({ role }) => SURFACE_TOKENS[mode][role].toUpperCase()),
  );
});
```

Import `SURFACE_TOKENS` and `SurfaceRole` from `../src/charts/theme`.

- [ ] **Step 2: Run it to make sure it fails**

```bash
pnpm vitest run apps/web/test/palette.test.ts
```

Expected: FAIL at import — `SURFACE_TOKENS` is not exported from `theme.ts`.

- [ ] **Step 3: Add the values to theme.ts**

```ts
/**
 * The SURFACE scale — everything that is not a mark and not a status.
 *
 * Slate rather than a chroma-zero grey, resolving an inconsistency in the
 * reference this was taken from: its CSS surfaces are neutral while its own
 * chart theme uses slate ink and slate gridlines. The charts are most of the
 * page, so the charts win.
 *
 * `page` and `card` are DIFFERENT VALUES on purpose. A card is defined by
 * sitting on a lighter/darker ground than the page; drawn white-on-white it is
 * a wire outline, and twelve of them read as a grid rather than as twelve
 * things.
 */
export type SurfaceRole =
  | 'page' | 'card' | 'sidebar' | 'sunken' | 'border' | 'divider'
  | 'text-primary' | 'text-muted' | 'text-subtle'
  | 'accent' | 'accent-foreground' | 'ring';

export const SURFACE_TOKENS: Readonly<Record<ChartMode, Readonly<Record<SurfaceRole, string>>>> = {
  light: {
    page: '#f8fafc', card: '#ffffff', sidebar: '#ffffff', sunken: '#f1f5f9',
    border: '#e2e8f0', divider: '#f1f5f9',
    'text-primary': '#0f172a', 'text-muted': '#64748b', 'text-subtle': '#94a3b8',
    accent: '#4f46e5', 'accent-foreground': '#ffffff', ring: '#6366f1',
  },
  dark: {
    page: '#0f172a', card: '#1e293b', sidebar: '#0f172a', sunken: '#334155',
    border: '#334155', divider: '#1e293b',
    'text-primary': '#f8fafc', 'text-muted': '#94a3b8', 'text-subtle': '#64748b',
    accent: '#818cf8', 'accent-foreground': '#0f172a', ring: '#818cf8',
  },
};
```

- [ ] **Step 4: Mirror them into tokens.css, in all three blocks**

Light block values from `SURFACE_TOKENS.light`, both dark blocks from `SURFACE_TOKENS.dark`. `--color-border`, `--color-text-primary` and `--color-text-muted` already exist — change their values rather than adding duplicates. Delete `--color-surface-raised`, which nothing reads.

**A `@theme` key and the runtime token it reads must not share a name.** `@theme inline { --color-surface: var(--color-surface) }` defines `--color-surface` at `:root` with its own value — a self-reference that resolves to nothing, silently. Three of this task's tokens would collide, so those three runtime tokens carry a distinct name and the `@theme` keys keep the short ones every later task's utilities assume:

| Runtime token | `@theme` key | Utility |
|---|---|---|
| `--color-surface-card` | `--color-surface` | `bg-surface` |
| `--color-rule` | `--color-divider` | `border-divider` |
| `--color-accent-base` | `--color-accent` | `bg-accent`, `text-accent` |

The other seven have no collision — `--color-surface-page` vs `--color-page`, `--color-border` vs `--color-default`, and so on — and keep the names in `SURFACE_TOKENS`.

Then add the `@theme` export at the top of the file, after `@import 'tailwindcss';`:

```css
@theme inline {
  --color-page: var(--color-surface-page);
  --color-surface: var(--color-surface-card);
  --color-sidebar: var(--color-surface-sidebar);
  --color-sunken: var(--color-surface-sunken);
  --color-default: var(--color-border);
  --color-divider: var(--color-rule);
  --color-primary: var(--color-text-primary);
  --color-muted: var(--color-text-muted);
  --color-subtle: var(--color-text-subtle);
  --color-accent: var(--color-accent-base);
}
```

One knock-on, and it is the whole reason the rename is safe to make here: `chartTheme` reads `token('--color-surface', …)` for the tooltip background. Change that single call to `'--color-surface-card'`. Nothing else in `apps/web/src` reads these three by name — Task 3 rewrites every call site to the utility form.

- [ ] **Step 5: Run tests**

```bash
pnpm vitest run apps/web/test/palette.test.ts && pnpm test:unit
```

Expected: PASS.

- [ ] **Step 6: Verify a utility actually resolves**

```bash
pnpm --filter @perfportal/web build
```

Then grep the built CSS for the generated class to prove `@theme` wired up rather than silently producing nothing:

```bash
grep -c 'bg-surface\|text-muted' apps/web/dist/assets/*.css
```

Expected: a non-zero count.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/charts/theme.ts apps/web/src/styles/tokens.css apps/web/test/palette.test.ts
git commit -m "feat(web): the slate surface scale, gated like every other token"
```

---

### Task 3: The arbitrary-value sweep

**Files:**
- Modify: 13 files under `apps/web/src` (see below)
- Create: `apps/web/test/tokens.test.ts`

**Interfaces:**
- Consumes: Task 2's `@theme` utility names
- Produces: no `[var(--` string anywhere in `apps/web/src` except `routes/marks.tsx`

- [ ] **Step 1: Write the failing test**

Create `apps/web/test/tokens.test.ts`:

```ts
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../src', import.meta.url));

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return tsxFiles(path);
    return path.endsWith('.tsx') ? [path] : [];
  });
}

/**
 * `bg-[var(--color-surface)]` was how every component reached a token before
 * Tailwind v4's `@theme` gave them real names. The arbitrary-value form still
 * WORKS, which is exactly why it needs a gate: it is invisible in review, and
 * one of them re-introduced next to `bg-surface` leaves two spellings of the
 * same colour with nothing to notice the drift.
 *
 * `marks.tsx` is exempt and stays exempt: its colour travels as DATA on a
 * `Mark`, through an inline `style`, because `Marked` and `Badge` both render
 * it. That is not a utility class and has no `@theme` equivalent.
 */
describe('components reach tokens by name, not by arbitrary value', () => {
  it('has no [var(--…)] utility outside marks.tsx', () => {
    const offenders = tsxFiles(SRC)
      .filter((path) => !path.endsWith('marks.tsx'))
      .flatMap((path) => {
        const hits = readFileSync(path, 'utf8').match(/\[var\(--[a-z-]+\)\]/g) ?? [];
        return hits.map((hit) => `${path.slice(SRC.length + 1)}: ${hit}`);
      });
    expect(offenders).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

```bash
pnpm vitest run apps/web/test/tokens.test.ts
```

Expected: FAIL listing 62 offenders across 13 files.

- [ ] **Step 3: Do the sweep**

Five substitutions, applied across `AppShell.tsx`, `SignOutButton.tsx`, `AuthGate.tsx`, `charts/Chart.tsx`, `charts/DataTable.tsx`, `charts/PercentilesChart.tsx`, `tables/StatisticsTable.tsx`, `tables/ErrorsTable.tsx`, `routes/Login.tsx`, `routes/RunList.tsx`, `routes/RunDetail.tsx`, `routes/NoOrg.tsx`, `routes/payload.tsx`:

| Find | Replace |
|---|---|
| `text-[var(--color-text-muted)]` | `text-muted` |
| `border-[var(--color-border)]` | `border-default` |
| `bg-[var(--color-surface)]` | `bg-surface` |
| `text-[var(--color-text-primary)]` | `text-primary` |
| `text-[var(--color-status-failed)]` | `text-[color:var(--color-status-failed)]` |

The last is not a rename. Status colour has no `@theme` utility because it is a *semantic* value that `marks.tsx` owns; the `color:` prefix keeps it an explicit arbitrary colour so the regex above does not match it and nobody mistakes it for a surface token.

- [ ] **Step 4: Run tests**

```bash
pnpm vitest run apps/web/test/tokens.test.ts && pnpm test:unit && pnpm typecheck && pnpm lint
```

Expected: all PASS.

- [ ] **Step 5: Confirm nothing changed visually before committing**

```bash
pnpm build && pnpm test:e2e
```

Expected: 46 passing. This task is a pure rename; any e2e failure here is a real regression, not a snapshot.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src apps/web/test/tokens.test.ts
git commit -m "refactor(web): reach tokens by name, and gate the old spelling"
```

---

### Task 4: The categorical six, re-sourced

**Files:**
- Modify: `apps/web/src/charts/theme.ts:31-66`
- Modify: `apps/web/src/styles/tokens.css`
- Modify: `apps/web/test/palette.test.ts:105-155`

**Interfaces:**
- Consumes: Task 1's blocks
- Produces: `CATEGORICAL` and `CATEGORICAL_DARK` as the six values below; `assignPalette`'s signature and the six-slot cap are unchanged.

- [ ] **Step 1: Write the failing test**

In `palette.test.ts`, delete the `describe.each(MODES)` case titled `separates every adjacent pair by at least ΔE 15 for normal vision`'s CVD framing **only in its comment**, and change the expected palette. Replace the `MODES` constant's palettes by editing `theme.ts` in step 3 — the test reads `paletteFor(mode)`, so the assertion to add is the new values themselves:

```ts
it('is the six hues the design system names', () => {
  expect(paletteFor('light')).toEqual([
    '#4f46e5', '#0d9488', '#8b5cf6', '#d97706', '#0ea5e9', '#e11d48',
  ]);
});
```

- [ ] **Step 2: Run it to make sure it fails**

```bash
pnpm vitest run apps/web/test/palette.test.ts -t 'six hues the design system names'
```

Expected: FAIL — receives the Okabe–Ito values.

- [ ] **Step 3: Change theme.ts**

Replace `CATEGORICAL` and `CATEGORICAL_DARK`, and replace the Okabe–Ito docblock with the decision record:

```ts
/**
 * The categorical series palette. Six hues, fixed assignment order, no
 * seventh — `assignPalette` leaves an excess series undrawn and says so rather
 * than reusing a colour.
 *
 * THIS PALETTE IS NOT COLOUR-VISION-SAFE, AND THAT IS A DECISION, NOT AN
 * OVERSIGHT. It replaced Okabe–Ito, which was chosen precisely because CVD
 * separation is the one property this repo does not compute — simulating
 * protanopia requires transcribed matrices, and one transcribed slightly wrong
 * yields a test that passes while certifying nothing. That property was
 * inherited from a published palette and is now given up, deliberately, for
 * visual coherence with the rest of the design system.
 *
 * What limits the cost: `routes/marks.tsx` renders every status as shape, then
 * word, then colour, and every chart carries a complete data table. So what is
 * lost is telling two SERIES apart, never telling a pass from a failure.
 *
 * Do not reorder. The order is the assignment order, so reordering silently
 * recolours every existing chart.
 */
export const CATEGORICAL = [
  '#4f46e5', // indigo
  '#0d9488', // teal
  '#8b5cf6', // violet
  '#d97706', // amber
  '#0ea5e9', // sky
  '#e11d48', // rose
] as const;

/**
 * The same six hues on a dark ground, derived by the rule this file has always
 * used: hold the hue angle, clamp OKLCH L into the 0.48–0.67 dark band, and
 * reduce chroma only as far as the sRGB gamut forces.
 *
 * The Tailwind-400 values these started from (`#818cf8`, `#2dd4bf`, `#a78bfa`,
 * `#f59e0b`, `#38bdf8`, `#fb7185`) are all ABOVE the band — L 0.68 to 0.79 —
 * and would glare on a dark surface. Measured, not guessed: all six failed.
 */
export const CATEGORICAL_DARK = [
  '#6c71fe', // indigo  — L 0.620
  '#30a79a', // teal    — L 0.660
  '#9469ff', // violet  — L 0.640
  '#d77500', // amber   — L 0.660
  '#059ddf', // sky     — L 0.660
  '#ee2f52', // rose    — L 0.620
] as const;
```

These are verified against every gate in `palette.test.ts`: all six inside 0.48–0.67, all above the 0.1 chroma floor, adjacent ΔE 23.78 / 26.49 / 33.10 / 30.13 / 34.75 against the floor of 15.

- [ ] **Step 4: Update the gate's own comment**

The `SEPARATION_FLOOR` check stays — it is a normal-vision separation gate and still earns its place. Change only its title and comment so it stops claiming a CVD guarantee:

```ts
it('separates every adjacent pair by at least ΔE 15', () => {
```

- [ ] **Step 5: Mirror into tokens.css, all three blocks**

`--chart-1` … `--chart-6` from `CATEGORICAL` in the light block and `CATEGORICAL_DARK` in both dark blocks.

- [ ] **Step 6: Run tests**

```bash
pnpm vitest run apps/web/test/palette.test.ts && pnpm test:unit
```

Expected: PASS, including the retained lightness-band, chroma-floor and ΔE-15 gates — all three were measured against these exact values before this plan was written, so a failure here means a hex was mistyped, not that the values are wrong. Never adjust the gate.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/charts/theme.ts apps/web/src/styles/tokens.css apps/web/test/palette.test.ts
git commit -m "feat(web): re-source the categorical six, and record what that costs"
```

---

### Task 5: Status splits into mark and text

**Files:**
- Modify: `apps/web/src/charts/theme.ts`
- Modify: `apps/web/src/styles/tokens.css`
- Modify: `apps/web/test/palette.test.ts`

**Interfaces:**
- Consumes: Tasks 1-2
- Produces: `STATUS_COLORS` keeps its name and its `Record<ChartMode, Record<StatusRole, string>>` shape but now holds **text** values; new `STATUS_MARK_COLORS` of the same shape holds **mark** values. `liveMarkColors` reads mark tokens (`--chart-status-*`); `marks.tsx` keeps reading `--color-status-*` and needs no change.

- [ ] **Step 1: Write the failing test**

```ts
/**
 * Text has to clear AA against the ground it is drawn on, and no single value
 * does it in both themes: #047857 measures 5.48 on white and 2.67 on the dark
 * card; #10b981 is the reverse. Hence two palettes, and hence this gate — the
 * old palette had none, because Primer's values happened to pass.
 */
const AA = 4.5;

function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const n = Number.parseInt(hex.slice(1), 16);
    const ch = (v: number) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * ch((n >> 16) & 0xff) + 0.7152 * ch((n >> 8) & 0xff) + 0.0722 * ch(n & 0xff);
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe.each(['light', 'dark'] as const)('status TEXT is legible in %s mode', (mode) => {
  const ground = SURFACE_TOKENS[mode].card;
  it.each(['passed', 'pending', 'neutral', 'failed'] as const)('%s clears AA on the card', (role) => {
    expect(contrast(STATUS_COLORS[mode][role], ground)).toBeGreaterThanOrEqual(AA);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

```bash
pnpm vitest run apps/web/test/palette.test.ts -t 'status TEXT is legible'
```

Expected: FAIL in dark mode — the current dark values were chosen against `#14171a`, and Task 2 moved the card to `#1e293b`.

- [ ] **Step 3: Split the palettes in theme.ts**

```ts
/** Status as TEXT — labels, badges, `marks.tsx`. Gated at 4.5:1 on the card. */
export const STATUS_COLORS: Readonly<Record<ChartMode, Readonly<Record<StatusRole, string>>>> = {
  light: { passed: '#047857', pending: '#b45309', neutral: '#64748b', failed: '#dc2626' },
  dark: { passed: '#10b981', pending: '#f59e0b', neutral: '#94a3b8', failed: '#f87171' },
};

/**
 * Status as a MARK — chart fills, where the colour sits in a shape large
 * enough that the text rule does not apply and the brighter value reads
 * better. Same four roles, same order, different job.
 */
export const STATUS_MARK_COLORS: Readonly<Record<ChartMode, Readonly<Record<StatusRole, string>>>> = {
  light: { passed: '#10b981', pending: '#f59e0b', neutral: '#94a3b8', failed: '#ef4444' },
  dark: { passed: '#10b981', pending: '#f59e0b', neutral: '#94a3b8', failed: '#ef4444' },
};
```

Point `fallbackFor` and `ROLE_TOKEN` at the MARK values and the `--chart-status-*` tokens, since `liveMarkColors` feeds `chartTheme().roles`, which is only ever consumed as a mark colour by `IndicatorsChart`, `RequestCountChart` and `ScatterChart`.

- [ ] **Step 4: Add both token sets to tokens.css, all three blocks**

`--color-status-{passed,pending,not-applicable,failed}` take the TEXT values.
`--chart-status-{passed,pending,not-applicable,failed}` take the MARK values.
`--chart-band-under` and `--chart-band-failed` alias the **mark** tokens — they are bands in a chart.

- [ ] **Step 5: Extend the drift check to both sets**

Add a `BLOCKS` case for `--chart-status-*` against `STATUS_MARK_COLORS`, mirroring the existing one for `--color-status-*` against `STATUS_COLORS`.

- [ ] **Step 6: Run tests**

```bash
pnpm vitest run apps/web/test/palette.test.ts && pnpm test:unit && pnpm typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/charts/theme.ts apps/web/src/styles/tokens.css apps/web/test/palette.test.ts
git commit -m "feat(web): status is one colour as text and another as a mark"
```

---

### Task 6: The ten-step percentile ramp

**Files:**
- Modify: `apps/web/src/charts/theme.ts`
- Modify: `apps/web/src/charts/Chart.tsx:163-167,285-296,361-389`
- Modify: `apps/web/src/charts/PercentilesChart.tsx`
- Modify: `apps/web/src/styles/tokens.css`
- Modify: `apps/web/test/palette.test.ts`
- Modify: `apps/web/e2e/run-charts.spec.ts:649-661` (comment only)

**Interfaces:**
- Consumes: Tasks 1-5
- Produces: `type PercentileRole = 'pct-min' | 'pct-p25' | 'pct-p50' | 'pct-p75' | 'pct-p80' | 'pct-p85' | 'pct-p90' | 'pct-p95' | 'pct-p99' | 'pct-max'`, added to the `MarkRole` union; `PERCENTILE_RAMP: readonly PercentileRole[]` in band order; `PERCENTILE_COLORS: Readonly<Record<ChartMode, Readonly<Record<PercentileRole, string>>>>`. `Chart` gains no new prop — passing `roles` now also lifts the six-hue cap.

- [ ] **Step 1: Write the failing test**

```ts
/**
 * An ORDERED ramp, so the gate is ordering, not separation. Hue must fall
 * monotonically green→red across all ten; that rotation IS the information.
 *
 * The ΔE floors are lower than the band ramp's on purpose and are the MEASURED
 * minima rounded down. Ten steps across one hue arc are necessarily closer
 * together than four; a floor set at the four-step ramp's 7.5 would be a
 * demand that this ramp stop being a ramp. Their job is to catch a duplicate
 * or a step nudged onto its neighbour, not to claim adjacent steps are
 * independently identifiable.
 *
 * Lightness is NOT gated and is NOT monotonic (it dips at p50 and rises again
 * through p85). The five values this ramp inherits from the reference are
 * fixed on their own bands, and they are not lightness-ordered; a lightness
 * gate would fail them and the four-step band ramp alike.
 */
const PCT_ADJACENT_FLOOR = 4.0;
const PCT_TWO_APART_FLOOR = 8.0;
const PCT_ENDS_FLOOR = 35;

describe.each(['light', 'dark'] as const)('the percentile ramp (%s)', (mode) => {
  const ramp = PERCENTILE_RAMP.map((role) => PERCENTILE_COLORS[mode][role]);

  it('is ten distinct colours', () => {
    expect(new Set(ramp).size).toBe(10);
  });

  it('rotates hue monotonically from green to red', () => {
    const hues = ramp.map((hex) => hueOf(hexToOkLab(hex)));
    expect(hues.every((h, i) => i === 0 || h < hues[i - 1])).toBe(true);
  });

  it('keeps adjacent steps apart', () => {
    const lab = ramp.map(hexToOkLab);
    const tooClose = lab.slice(1)
      .map((next, i) => ({ pair: `${PERCENTILE_RAMP[i]}→${PERCENTILE_RAMP[i + 1]}`, dE: deltaE(lab[i]!, next) }))
      .filter(({ dE }) => dE < PCT_ADJACENT_FLOOR);
    expect(tooClose).toEqual([]);
  });

  it('keeps two-apart steps further apart still', () => {
    const lab = ramp.map(hexToOkLab);
    const tooClose: string[] = [];
    for (let i = 0; i + 2 < lab.length; i++) {
      if (deltaE(lab[i]!, lab[i + 2]!) < PCT_TWO_APART_FLOOR) tooClose.push(`${PERCENTILE_RAMP[i]}→${PERCENTILE_RAMP[i + 2]}`);
    }
    expect(tooClose).toEqual([]);
  });

  it('separates its ends', () => {
    expect(deltaE(hexToOkLab(ramp[0]!), hexToOkLab(ramp[9]!))).toBeGreaterThanOrEqual(PCT_ENDS_FLOOR);
  });
});
```

Add the `hueOf` helper beside the existing `chroma`:

```ts
const hueOf = (c: OkLab): number => { const d = Math.atan2(c.b, c.a) * 180 / Math.PI; return d < 0 ? d + 360 : d; };
```

- [ ] **Step 2: Run it to make sure it fails**

```bash
pnpm vitest run apps/web/test/palette.test.ts -t 'percentile ramp'
```

Expected: FAIL at import — `PERCENTILE_RAMP` is not exported.

- [ ] **Step 3: Add the ramp to theme.ts**

These are the measured values; light and dark share them, as the reference's do:

```ts
export const PERCENTILE_RAMP: readonly PercentileRole[] = [
  'pct-min', 'pct-p25', 'pct-p50', 'pct-p75', 'pct-p80',
  'pct-p85', 'pct-p90', 'pct-p95', 'pct-p99', 'pct-max',
];

const RAMP = {
  'pct-min': '#2fdac4', 'pct-p25': '#32d29c', 'pct-p50': '#22c55e',
  'pct-p75': '#84cc16', 'pct-p80': '#b6c641', 'pct-p85': '#d4c026',
  'pct-p90': '#e8b10c', 'pct-p95': '#f59e0b', 'pct-p99': '#f97316',
  'pct-max': '#ef4444',
} as const;

export const PERCENTILE_COLORS: Readonly<Record<ChartMode, Readonly<Record<PercentileRole, string>>>> =
  { light: RAMP, dark: RAMP };
```

Add `PercentileRole` to `MarkRole`, add the ten `--chart-pct-*` entries to `ROLE_TOKEN`, and extend `fallbackFor` with a `pct-` branch.

- [ ] **Step 4: Lift the palette cap for role-coloured charts**

In `Chart.tsx`, the cap must not truncate a ten-series chart that brought its own ten colours. Change the assignment memo:

```ts
  // A chart that declares `roles` brought its own colour per series and is not
  // spending categorical hues, so the six-slot cap does not apply to it. The
  // cap exists to stop a SEVENTH series wrapping back to `--chart-1`; a ramp
  // has no wraparound to prevent. Charts without `roles` are unaffected.
  const assignment = useMemo(() => {
    const names = data.series.map((series) => series.name);
    if (roles !== undefined) {
      return { drawn: names.map((name, index) => ({ index, name, color: '' })), undrawn: [] };
    }
    const essential = data.series.flatMap((series, i) => (series.essential === true ? [i] : []));
    return assignPalette(names, mode, essential);
  }, [data.series, mode, roles]);
```

The empty `color` is never read: the option's `color` array comes from `roles.map(...)` whenever `roles` is defined, which the existing code already does.

- [ ] **Step 5: Have PercentilesChart pass the ramp**

```ts
  // The transform always emits series in BANDS order, so the roles must be the
  // SELECTED bands in that same order — `bands` is toggle order, which is not
  // it. Memoised because `roles` is in Chart's option-effect dependency list.
  const roles = useMemo(
    () => BANDS.filter((band) => bands.includes(band)).map((band) => `pct-${band}` as MarkRole),
    [bands],
  );
```

Pass `roles={roles}` to `<Chart/>`. Add `import type { MarkRole } from './theme';` and `useMemo` to the existing `react` import.

- [ ] **Step 6: Mirror the ten tokens into tokens.css, all three blocks, and run the tests**

```bash
pnpm vitest run apps/web/test/palette.test.ts && pnpm test:unit && pnpm typecheck && pnpm lint
```

Expected: PASS.

- [ ] **Step 7: Correct the now-stale e2e comment**

`run-charts.spec.ts:660` says six are drawn "because ten lines on one axis is more than a sighted reader can follow **and more than the palette has hues for**". The second half stops being true here. Replace with:

```ts
  // Six DRAWN, because six is the DEFAULT SELECTION — ten lines on one axis is
  // more than a sighted reader can follow. It is no longer a palette limit:
  // the percentile ramp has a colour for all ten and the reader can select
  // them.
```

- [ ] **Step 8: Prove all ten can now draw**

Add to `run-charts.spec.ts`:

```ts
test('selecting every band draws all ten, which the palette used to forbid', async ({ page }) => {
  const admin = await seedAdmin();
  const runId = await seedRunWithData(admin.orgId);
  await signIn(page, admin);
  await page.goto(`/runs/${runId}`);
  await settled(page);

  const chart = page.getByTestId('chart-percentiles');
  for (const band of ['p25', 'p80', 'p85', 'p90']) {
    const button = page.getByTestId(`band-${band}-percentiles`);
    if ((await button.getAttribute('aria-pressed')) !== 'true') await button.click();
  }

  await expect.poll(() => legendLabels(chart)).toHaveLength(10);
  // And no "showing 6 of 10" prose, because nothing was dropped.
  await expect(chart.getByText(/not drawn/)).toHaveCount(0);
});
```

- [ ] **Step 9: Run e2e and commit**

```bash
pnpm build && pnpm test:e2e
git add apps/web/src apps/web/test apps/web/e2e
git commit -m "feat(web): percentiles get an ordered ten-step ramp, and all ten can draw"
```

---

### Task 7: `Card`, and `Chart` inside one

**Files:**
- Create: `apps/web/src/components/Card.tsx`
- Create: `apps/web/test/Card.test.tsx`
- Modify: `apps/web/src/charts/Chart.tsx:402-438`

**Interfaces:**
- Consumes: Task 2's utilities
- Produces: `export default function Card({ title, description, as, 'data-testid': testId, children }: { title?: string; description?: string; as?: 'section' | 'figure'; 'data-testid'?: string; children: ReactNode })`. Renders `as` (default `'section'`) with `bg-surface border-default`, forwarding `data-testid` to that element. When `title` is given it renders an `<h3>`; otherwise it renders no heading at all.

- [ ] **Step 1: Write the failing test**

```tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import Card from '../src/components/Card';

describe('Card', () => {
  it('renders its children inside the element the caller asked for', () => {
    const { container } = render(<Card as="figure"><p>body</p></Card>);
    expect(container.querySelector('figure')).not.toBeNull();
    expect(screen.getByText('body')).toBeInTheDocument();
  });

  /**
   * `Chart` renders its own <h3> and the e2e suite locates charts by it. A Card
   * that always drew a heading would give every chart two.
   */
  it('renders no heading when given no title', () => {
    render(<Card><p>body</p></Card>);
    expect(screen.queryByRole('heading')).toBeNull();
  });

  it('renders the description under the title when both are given', () => {
    render(<Card title="Requests" description="per second">{null}</Card>);
    expect(screen.getByRole('heading', { name: 'Requests' })).toBeInTheDocument();
    expect(screen.getByText('per second')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

```bash
pnpm vitest run apps/web/test/Card.test.tsx
```

Expected: FAIL — cannot resolve `../src/components/Card`.

- [ ] **Step 3: Write Card.tsx**

```tsx
import type { ReactNode } from 'react';

/**
 * The bordered surface every chart and table sits on.
 *
 * `title` is OPTIONAL and defaults to drawing nothing, because `Chart` already
 * renders its own `<h3>` and the e2e suite finds charts by it. A card that
 * always drew a heading would give every figure two, and the accessible name
 * of the figure would become whichever one won.
 */
export default function Card({
  title,
  description,
  as: Element = 'section',
  children,
}: {
  readonly title?: string;
  readonly description?: string;
  readonly as?: 'section' | 'figure';
  readonly children: ReactNode;
}) {
  return (
    <Element className="flex flex-col gap-2 rounded-lg border border-default bg-surface p-4">
      {title !== undefined && <h3 className="text-lg font-semibold">{title}</h3>}
      {description !== undefined && <p className="text-sm text-muted">{description}</p>}
      {children}
    </Element>
  );
}
```

- [ ] **Step 4: Run it to make sure it passes**

```bash
pnpm vitest run apps/web/test/Card.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Put Chart's figure inside one**

In `Chart.tsx`, change the outer `<figure data-testid={...} className="flex flex-col gap-2 m-0">` to `<Card as="figure">` wrapping the existing contents, keeping `data-testid` on the figure. `Card` needs to forward it, so add a `data-testid` prop:

```tsx
  readonly 'data-testid'?: string;
```

and spread it onto `Element`. **Do not move the `<h3>` into `Card`'s `title`** — `Chart`'s heading is inside the figure and the e2e suite reads it there.

- [ ] **Step 6: Run the full front-end gate**

```bash
pnpm test:unit && pnpm typecheck && pnpm lint && pnpm build && pnpm test:e2e
```

Expected: PASS. The e2e chart locators are `figure[data-testid^="chart-"]`, which is preserved by construction.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/Card.tsx apps/web/test/Card.test.tsx apps/web/src/charts/Chart.tsx
git commit -m "feat(web): charts sit on a card, without moving their figure"
```

---

### Task 8: `Badge`

**Files:**
- Create: `apps/web/src/components/Badge.tsx`
- Create: `apps/web/test/Badge.test.tsx`
- Modify: `apps/web/src/routes/RunList.tsx` (status and verdict cells)
- Modify: `apps/web/e2e/run-list.spec.ts`

**Interfaces:**
- Consumes: `Mark` from `routes/marks.tsx`
- Produces: `export default function Badge({ mark }: { mark: Mark })` — a `<span>` carrying glyph (aria-hidden), label text, and `mark.colour` as its text colour.

- [ ] **Step 1: Write the failing test**

```tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import Badge from '../src/components/Badge';
import { VERDICT } from '../src/routes/marks';

describe('Badge', () => {
  /**
   * The glyph is decorative and the WORD carries the meaning — the same rule
   * `Marked` follows, inherited rather than re-decided. A screen reader
   * announcing "white heavy check mark passed" says it twice, once badly.
   */
  it('exposes the word and hides the glyph', () => {
    render(<Badge mark={VERDICT.passed} />);
    expect(screen.getByText('passed')).toBeInTheDocument();
    expect(screen.getByText('✓')).toHaveAttribute('aria-hidden', 'true');
  });

  it('renders each verdict with its own word', () => {
    render(<Badge mark={VERDICT.not_evaluated} />);
    expect(screen.getByText('not evaluated')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

```bash
pnpm vitest run apps/web/test/Badge.test.tsx
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write Badge.tsx**

```tsx
import type { Mark } from '../routes/marks';

/**
 * `Marked` in pill form, and deliberately NOT a second vocabulary: it takes the
 * same `Mark`, so a status that gains a glyph or changes a word changes in one
 * place and both renderings follow.
 *
 * The colour is the mark's TEXT colour (`--color-status-*`), which is gated at
 * 4.5:1 against the card — the brighter `--chart-status-*` values are for
 * fills, and would fail here.
 */
export default function Badge({ mark }: { readonly mark: Mark }) {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border border-default px-2 py-0.5 text-sm"
      style={{ color: mark.colour }}
    >
      <span aria-hidden="true">{mark.glyph}</span>
      {mark.label}
    </span>
  );
}
```

- [ ] **Step 4: Run it to make sure it passes**

```bash
pnpm vitest run apps/web/test/Badge.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Use it in the run list, and assert the accessible name in Playwright**

Swap `<Marked mark={…}/>` for `<Badge mark={…}/>` in `RunList.tsx`'s status and verdict cells. Then add to `run-list.spec.ts`:

```ts
test('a badge does not leak its glyph into the row’s accessible name', async ({ page }) => {
  const admin = await seedAdmin();
  await seedRunWithData(admin.orgId);
  await signIn(page, admin);
  await page.goto('/runs');

  // Chromium, not jsdom: dom-accessibility-api does not consult a descendant's
  // aria-hidden the way a real AT tree does, so this assertion is only
  // meaningful in a browser (CLAUDE.md).
  const cell = page.getByRole('cell', { name: /complete/ }).first();
  await expect(cell).toBeVisible();
  expect(await cell.getAttribute('aria-label')).toBeNull();
});
```

- [ ] **Step 6: Run the gate and commit**

```bash
pnpm test:unit && pnpm typecheck && pnpm lint && pnpm build && pnpm test:e2e
git add apps/web/src/components/Badge.tsx apps/web/test/Badge.test.tsx apps/web/src/routes/RunList.tsx apps/web/e2e/run-list.spec.ts
git commit -m "feat(web): status reads as a badge, from the same Mark as before"
```

---

### Task 9: Shared table styles

**Files:**
- Create: `apps/web/src/components/tableStyles.ts`
- Modify: `apps/web/src/tables/StatisticsTable.tsx`, `apps/web/src/tables/ErrorsTable.tsx`, `apps/web/src/charts/DataTable.tsx`

**Interfaces:**
- Consumes: Task 2's utilities
- Produces: `export const TABLE`, `THEAD`, `TH`, `TD`, `TD_NUM`, `ROW` — plain `string` constants.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { TD_NUM, THEAD } from '../src/components/tableStyles';

describe('table styles', () => {
  /**
   * Numeric columns must be tabular and right-aligned or a column of response
   * times cannot be scanned — digits of different widths make 1,143 look
   * shorter than 999. This is the one style with a legibility argument behind
   * it rather than a taste one, so it is the one with a test.
   */
  it('right-aligns numerics and uses tabular figures', () => {
    expect(TD_NUM).toContain('text-right');
    expect(TD_NUM).toContain('tabular-nums');
  });

  it('gives the header the sunken surface', () => {
    expect(THEAD).toContain('bg-sunken');
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

```bash
pnpm vitest run apps/web/test/tableStyles.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write tableStyles.ts**

```ts
/**
 * The table look, in one place.
 *
 * Three tables set these per file today — the statistics table, the errors
 * table, and every chart's data table — and a density change had to be made
 * three times and agreed three times.
 */
export const TABLE = 'w-full border-collapse text-left text-sm';
export const THEAD = 'bg-sunken';
export const TH = 'px-3 py-2 font-semibold';
export const ROW = 'border-b border-divider';
export const TD = 'px-3 py-1.5';
export const TD_NUM = 'px-3 py-1.5 text-right tabular-nums';
```

- [ ] **Step 4: Apply them in the three tables**

Replace the per-file class strings. **Do not change any `data-testid`, `scope`, `<caption>` or cell ORDER** — `run-tables.spec.ts` asserts column headings and cell counts, and `readTable` reads by position.

- [ ] **Step 5: Run the gate**

```bash
pnpm test:unit && pnpm typecheck && pnpm lint && pnpm build && pnpm test:e2e
```

Expected: PASS, 46 e2e.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/tableStyles.ts apps/web/test/tableStyles.test.ts apps/web/src/tables apps/web/src/charts/DataTable.tsx
git commit -m "feat(web): one table style instead of three"
```

---

### Task 10: `StatTile`, and the run page's stat row

**Files:**
- Create: `apps/web/src/components/StatTile.tsx`
- Create: `apps/web/src/routes/RunStats.tsx`
- Create: `apps/web/test/RunStats.test.tsx`
- Modify: `apps/web/src/routes/RunDetail.tsx:292-306`
- Modify: `apps/web/e2e/run-detail.spec.ts`

**Interfaces:**
- Consumes: Tasks 2, 7
- Produces: `StatTile({ label, value, hint, testId }: { label: string; value: string; hint?: string; testId?: string })` — `testId` lands on the `<dd>`, so the assertion reads the value and not the label; `RunStats({ stats }: { stats: StatsResponse })` rendering a `<dl>` of six tiles, or nothing when the payload carries no run-scope row.

- [ ] **Step 1: Write the failing test**

Derive every expectation from the fixture, never from a written-down number:

```tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { StatsResponse } from '@perfportal/contracts';
import reference from './fixtures/reference-run.json';
import RunStats from '../src/routes/RunStats';

const stats = reference.stats as StatsResponse;
const runRow = stats.stats.find((r) => r.scope === 'run')!;

describe('RunStats', () => {
  it('shows the run row’s own totals', () => {
    render(<RunStats stats={stats} />);
    expect(screen.getByTestId('stat-total-requests')).toHaveTextContent(
      runRow.count.toLocaleString(),
    );
  });

  /**
   * The tile and the `% KO` column of the statistics table below it are the
   * SAME quantity, and must be read from the same place: the payload's own
   * `errorRate` field, times 100, to two decimals — which is exactly what
   * `StatisticsTable`'s `% KO` column does (`value: (r) => r.errorRate * 100`).
   *
   * NOT `koCount / count`. That is arithmetically the same number today and
   * would still be a second definition of it, sitting a few hundred pixels
   * from the first, free to disagree the day the server's rounding changes.
   */
  it('reads error rate from the same field the table does', () => {
    render(<RunStats stats={stats} />);
    const expected = (runRow.errorRate * 100).toFixed(2);
    expect(screen.getByTestId('stat-error-rate')).toHaveTextContent(expected);
  });

  it('renders nothing when the payload has no run-scope row', () => {
    const { container } = render(<RunStats stats={{ ...stats, stats: [] }} />);
    expect(container).toBeEmptyDOMElement();
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

```bash
pnpm vitest run apps/web/test/RunStats.test.tsx
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write StatTile.tsx**

```tsx
export default function StatTile({
  label,
  value,
  hint,
  testId,
}: {
  readonly label: string;
  readonly value: string;
  readonly hint?: string;
  readonly testId?: string;
}) {
  return (
    <div className="rounded-lg border border-default bg-surface p-4">
      <dt className="text-xs font-medium uppercase tracking-wide text-muted">{label}</dt>
      <dd data-testid={testId} className="mt-1 text-2xl font-semibold tabular-nums">
        {value}
      </dd>
      {hint !== undefined && <p className="mt-1 text-xs text-subtle">{hint}</p>}
    </div>
  );
}
```

- [ ] **Step 4: Write RunStats.tsx**

Six tiles: total requests, error rate, mean throughput, mean response, p95, p99. Every value from the run-scope row — `count`, `errorRate`, `okCount`, `koCount`, `throughputRps`, `meanMs`, `maxMs`, `percentiles.p95`, `percentiles.p99`. Error rate is `errorRate * 100` to two decimals, the same expression and the same precision `StatisticsTable`'s `% KO` column uses. Return `null` when `stats.stats.find((r) => r.scope === 'run')` is `undefined`:

```tsx
/**
 * §13.2's headline numbers, above the tables.
 *
 * EVERY VALUE COMES FROM THE RUN-SCOPE STATS ROW the page already fetched —
 * `statsQuery` is asked for twice on this page and served once from cache, so
 * this adds no request. Nothing here is derived from anywhere else: a tile that
 * disagreed with the statistics table directly beneath it would be worse than
 * no tile.
 */
```

- [ ] **Step 5: Run it to make sure it passes**

```bash
pnpm vitest run apps/web/test/RunStats.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Render it on the run page**

In `RunDetail.tsx`'s `Tables`, render `<RunStats/>` above the statistics `TableSection`, inside the same `TableSection`-style query branch so a failed `/stats` still explains itself rather than showing six dashes.

- [ ] **Step 7: Assert it in Playwright against the table below it**

```ts
test('the stat tiles agree with the statistics table', async ({ page }) => {
  const admin = await seedAdmin();
  const runId = await seedRunWithData(admin.orgId);
  await signIn(page, admin);
  await page.goto(`/runs/${runId}`);

  // `stat-row-total` is the All Requests row — the run's own totals, in its own
  // <tbody>, and the same row RunStats reads. NOT `stat-row`, which is the
  // per-request and per-group rows in the second body.
  //
  // Its first cell is a <th scope="row"> carrying "All Requests", so the Total
  // column is the first <td>.
  const tile = await page.getByTestId('stat-total-requests').textContent();
  const totalCell = page.getByTestId('stat-row-total').locator('td').first();
  expect((await totalCell.textContent())?.trim()).toBe(tile?.trim());
});
```

- [ ] **Step 8: Run the full gate**

```bash
pnpm typecheck && pnpm lint && pnpm test:unit && pnpm test:integration && pnpm test:e2e
```

Expected: all green.

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/components/StatTile.tsx apps/web/src/routes/RunStats.tsx apps/web/test/RunStats.test.tsx apps/web/src/routes/RunDetail.tsx apps/web/e2e/run-detail.spec.ts
git commit -m "feat(web): six stat tiles, computed from the row the table shows"
```

---

## Final verification

- [ ] Run the whole gate from a clean build:

```bash
pnpm build && pnpm typecheck && pnpm lint && pnpm test:unit && pnpm test:integration && pnpm test:e2e
```

- [ ] Look at the app in a browser, in **both** themes. Charts must draw in both — the dark values are only exercised by eye, since no test forces `prefers-color-scheme`:

```bash
pnpm --filter @perfportal/api start
```

- [ ] Confirm the success criteria in spec §10, item by item.
- [ ] Open one PR to `main`. Merge with `--merge`, never squash.
