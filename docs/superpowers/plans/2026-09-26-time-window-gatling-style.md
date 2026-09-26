# Time window, Gatling-style Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the run page's time window Gatling Enterprise's controls — an always-visible absolute range with presets, an Offset/Datetime mode that relabels every single-run time axis, a navigator header, and six zoom and pan buttons — keeping the drag strip and the From/To fields.

**Architecture:** Pure pieces first: clock formatters in `routes/format.ts`, the measured step math in `routes/window.ts`, a storage-backed mode preference beside `theme.ts`. A React context (`charts/TimeAxisContext.tsx`) carries the viewer's mode and the run's anchor (`toolStartedAt`); `Chart` reads it in its one elapsed-millisecond branch and becomes the only place an elapsed axis is named. `RunShell` and both drill-downs provide it; `CompareChart` pins elapsed. `TimeBrush` is rebuilt around the range line, the mode dropdown, the navigator header and the six buttons.

**Tech Stack:** TypeScript, React 18, React Router 6, TanStack Query 5, ECharts 6.1 (mocked in unit tests), Radix dropdown menu (`components/ui/dropdown-menu.tsx`), lucide icons via `components/icons.tsx`, Vitest 4 + Testing Library, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-26-time-window-gatling-style-design.md` — read it before starting; this plan argues from it.

## Global Constraints

- **Client-side only.** No backend, contract, migration or API change. `RunIdentity.toolStartedAt` is already on the wire.
- **Node from `.nvmrc` (22)**: `source ~/.nvm/nvm.sh && nvm use` before any test. On Node 20 the jsdom project fails to LOAD and still prints a green summary.
- **Floors before this branch (main 84a3300):** unit **163 files / 2036 tests**, integration **147 / 1856**, e2e **150**. A unit run below 163 files did not run everything.
- **The URL keeps offset milliseconds** (spec deviation A) and **the whole run keeps an empty URL** (B): every step, preset or drag that covers the whole run commits `null`.
- **The From/To fields stay** (C), with every existing testid: `time-brush`, `time-window-toggle`, `window-from`, `window-to`, `window-apply`, `window-clear`, `window-error`, `window-applied`.
- **Chart data tables keep their numeric `Elapsed (s)` columns** (D). Only axis notation changes.
- **No anchor, no Datetime** (E). **Durations use `formatDuration`** (F); the navigator's Duration is `activityMs ?? durationMs`.
- **Gatling's words are copied exactly:** presets `Last 5 Minutes`, `Last 15 Minutes`, `Last 30 Minutes`, `Last 1 hour`, `Last 1 day`, `Everything`; buttons `Fast backward`, `Backward`, `Zoom out`, `Zoom in`, `Forward`, `Fast forward`; mode options `Offset` and `Datetime (<IANA zone> - <GMT offset>)`; header `Resolution: …` and `Duration: …`.
- **Zone-pinned tests.** Every case that formats wall-clock time sets `TZ` to `Asia/Kolkata` and asserts the flip took (`new Date('2026-08-15T00:00:00Z').getHours() === 5`) before anything else. **This machine's own zone is Asia/Kolkata**, so a pin that silently fails still passes here and fails only on CI's UTC runners: every such file is also run under `TZ=UTC` before its task is committed.
- **A module-scope `Intl.DateTimeFormat` freezes the zone at import** (measured: built under TZ=UTC, it kept printing UTC after the flip). New formatters build per call or read the `Date`'s own fields.
- **No conditional spread of an object literal** (`...(c ? { … } : {})`) outside `Chart.tsx`, which is the lint rule's one exemption.
- **Styling:** type sizes in rem (`text-[0.75rem]`), never `text-[Npx]`; no `[var(--…)]` utilities; status colours through `style={{ color: 'var(--color-status-failed)' }}` as `TimeBrush` already does.
- **Red-verify every new or re-pointed test.** Commit a checkpoint BEFORE the first mutation. Apply each mutation with a replacement-count assertion (`perl -0pi -e '$n = s/…/…/g; die "expected 1, got $n\n" unless $n == 1' <file>`), run, confirm the NAMED case fails with the expected message, restore with `git checkout HEAD -- <file>`, and finish with `git status --short` showing only the three pre-existing untracked paths.
- **Git:** never `git add -A` — name every path (`docs/ui-review-2026-09-13/`, `review.md` and `scripts/seed-manual-test.mjs` are untracked and must stay out). Commit with `git commit -F - <<'MSG'` (a quoted heredoc interprets nothing). `git log --oneline origin/main..HEAD` must list only this branch's commits.
- **Every task ends with** `pnpm typecheck` and `pnpm lint`, each read by its OWN exit code (`pnpm typecheck > "$SCRATCH/tc.txt" 2>&1; echo "exit=$?"`), never through a pipe.

## File map

| File | Change | Responsibility |
|---|---|---|
| `apps/web/src/routes/format.ts` | modify | clock notation: `formatElapsedClock`, `formatClockTime`, `formatZoneOffset`, `formatZoneName`, `formatInstantSeconds` |
| `apps/web/src/routes/window.ts` | modify | the measured step math: `WINDOW_STEPS`, `WINDOW_PRESETS`, `snapBound`, `stepWindow`, `canStep`, `presetWindow` |
| `apps/web/src/timeAxisPreference.ts` | create | the viewer's mode, stored like the theme |
| `apps/web/src/charts/TimeAxisContext.tsx` | create | `TimeAxisProvider`, `ElapsedOnly`, `useTimeAxis` |
| `apps/web/src/charts/Chart.tsx` | modify | `ChartXAxis` makes `name`/`tickUnit` exclusive; the elapsed branch reads the context |
| `apps/web/src/charts/{PercentilesChart,TelemetryCharts,ErrorsChart,RatesChart,UsersChart}.tsx` | modify | drop their `name: 'Elapsed (s)'` literals |
| `apps/web/src/charts/CompareChart.tsx` | modify | drop its literal; wrap in `ElapsedOnly` |
| `apps/web/src/routes/RunShell.tsx` | modify | provide the anchor; pass `runActivityMs` |
| `apps/web/src/routes/RequestDetail.tsx`, `GroupDetail.tsx` | modify | provide the anchor |
| `apps/web/src/components/icons.tsx` | modify | five icons |
| `apps/web/src/charts/TimeBrush.tsx` | rewrite | range line, presets, mode, header, six buttons |
| `apps/web/test/format.test.ts`, `window.test.ts`, `Chart.test.tsx`, `TimeBrush.test.tsx`, `timeAxis.test.ts`, `RunShell.test.tsx`, `RequestDetail.test.tsx`, `GroupDetail.test.tsx` | modify | new and re-pointed cases |
| `apps/web/test/timeAxisPreference.test.ts`, `TimeAxisContext.test.tsx` | create | the preference and the context |
| `apps/web/e2e/time-window.spec.ts` | create | the seams, in a browser |
| `apps/web/e2e/run-tables.spec.ts`, `apps/web/e2e/helpers.ts` | modify | the re-measured M01 number |
| `CLAUDE.md` | modify | the entry and the floors |

## Dependency order

```
1 (formatters) ──┐
2 (step math) ───┼──> 6 (TimeBrush) ──> 7 (e2e) ──> 8 (gates, CLAUDE.md, PR)
3 (context) ──> 4 (Chart) ──> 5 (providers) ──┘
```

`$SCRATCH` below is the session scratchpad directory; any throwaway file goes there, never in the repo.

---

### Task 1: Clock formatters

**Files:**
- Modify: `apps/web/src/routes/format.ts`
- Test: `apps/web/test/format.test.ts`

**Interfaces:**
- Produces: `formatElapsedClock(ms: number): string`, `formatClockTime(epochMs: number): string`, `formatZoneOffset(epochMs: number): string`, `formatZoneName(): string`, `formatInstantSeconds(epochMs: number): string`, all exported from `apps/web/src/routes/format.ts`.

- [ ] **Step 1: Write the failing tests**

In `apps/web/test/format.test.ts`, replace the import block (lines 1-2) with:

```ts
import { describe, expect, it } from 'vitest';
import {
  formatClockTime,
  formatDuration,
  formatElapsedClock,
  formatInstant,
  formatInstantSeconds,
  formatOffset,
  formatZoneName,
  formatZoneOffset,
} from '../src/routes/format';

/**
 * Pins the process zone for one case and restores it afterwards.
 *
 * THIS MACHINE'S OWN ZONE IS Asia/Kolkata, so a pin that silently failed to
 * take would still pass here and fail only on CI's UTC runners. Every case
 * asserts the flip landed before asserting anything else, and this file is
 * also run under `TZ=UTC` before it is trusted.
 */
function inZone(zone: string, body: () => void): void {
  const original = process.env.TZ;
  try {
    process.env.TZ = zone;
    body();
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
}

/** Asia/Kolkata is +05:30, so UTC midnight reads 05. */
const kolkataTook = (): void => {
  expect(new Date('2026-08-15T00:00:00Z').getHours()).toBe(5);
};
```

Append at the end of the file:

```ts
/* ======================================================================== *
 * THE TIME WINDOW'S CLOCKS — Gatling Enterprise's Offset and Datetime
 * ======================================================================== */

describe('formatElapsedClock — Offset mode’s tick notation', () => {
  it('writes an offset into the run as HH:MM:SS', () => {
    expect(formatElapsedClock(0)).toBe('00:00:00');
    expect(formatElapsedClock(15_000)).toBe('00:00:15');
    expect(formatElapsedClock(75_000)).toBe('00:01:15');
  });

  it('floors, like a clock', () => {
    expect(formatElapsedClock(42_999)).toBe('00:00:42');
  });

  it('lets the hours run past 24 for a long soak', () => {
    expect(formatElapsedClock(26 * 3_600_000 + 61_000)).toBe('26:01:01');
  });
});

describe('formatClockTime — Datetime mode’s tick notation', () => {
  it('reads the reader’s own 24-hour clock', () => {
    inZone('Asia/Kolkata', () => {
      kolkataTook();
      // Gatling Enterprise's own measured pair: elapsed 00:00:15 on a run
      // that began 17:12:09 (11:42:09Z) is 17:12:24.
      expect(formatClockTime(Date.UTC(2026, 7, 15, 11, 42, 9) + 15_000)).toBe('17:12:24');
    });
  });

  it('wraps at midnight', () => {
    inZone('Asia/Kolkata', () => {
      kolkataTook();
      const lateEvening = Date.UTC(2026, 7, 15, 18, 29, 50); // 23:59:50 IST
      expect(formatClockTime(lateEvening)).toBe('23:59:50');
      expect(formatClockTime(lateEvening + 20_000)).toBe('00:00:10');
    });
  });
});

describe('formatZoneOffset — what a wall-clock axis is labelled with', () => {
  /** What Intl itself prints for the same instant, so this is not a second opinion. */
  const intlShortOffset = (epochMs: number): string =>
    new Intl.DateTimeFormat('en-US', { timeZoneName: 'shortOffset' })
      .formatToParts(epochMs)
      .find((part) => part.type === 'timeZoneName')!.value;

  it('agrees with Intl, including a half-hour zone and zero', () => {
    for (const zone of ['Asia/Kolkata', 'UTC', 'America/New_York']) {
      inZone(zone, () => {
        const at = Date.UTC(2026, 6, 1, 12, 0, 0);
        expect(formatZoneOffset(at)).toBe(intlShortOffset(at));
      });
    }
    inZone('Asia/Kolkata', () => {
      kolkataTook();
      expect(formatZoneOffset(Date.UTC(2026, 7, 15))).toBe('GMT+5:30');
    });
  });

  it('takes the offset at the instant it is given, not today’s', () => {
    inZone('America/New_York', () => {
      expect(new Date('2026-07-01T12:00:00Z').getHours()).toBe(8);
      expect(formatZoneOffset(Date.UTC(2026, 6, 1, 12))).toBe('GMT-4');
      expect(formatZoneOffset(Date.UTC(2026, 0, 15, 12))).toBe('GMT-5');
    });
  });
});

describe('formatZoneName', () => {
  it('names the zone the page is in', () => {
    inZone('Asia/Kolkata', () => {
      kolkataTook();
      // Derived, not written down: ICU spells this zone Asia/Calcutta or
      // Asia/Kolkata depending on its version.
      expect(formatZoneName()).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
      expect(formatZoneName()).toMatch(/^Asia\/(Calcutta|Kolkata)$/);
    });
  });
});

describe('formatInstantSeconds — both ends of a window', () => {
  it('tells apart two instants inside one minute, which formatInstant cannot', () => {
    inZone('Asia/Kolkata', () => {
      kolkataTook();
      const start = Date.UTC(2026, 7, 15, 11, 42, 9);
      const end = start + 30_000;
      expect(formatInstant(new Date(start).toISOString())).toBe(
        formatInstant(new Date(end).toISOString()),
      );
      expect(formatInstantSeconds(start)).not.toBe(formatInstantSeconds(end));
    });
  });

  it('names the zone and carries the seconds', () => {
    inZone('Asia/Kolkata', () => {
      kolkataTook();
      const out = formatInstantSeconds(Date.UTC(2026, 7, 15, 11, 42, 9));
      expect(out).toContain('GMT+5:30');
      // `17:12:09` in a 24-hour locale, `5:12:09 PM` in a 12-hour one.
      expect(out).toMatch(/\b(17|5):12:09\b/);
      expect(out).toMatch(/2026/);
    });
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm exec vitest run apps/web/test/format.test.ts`
Expected: FAIL — `formatClockTime` and its siblings are not exported (`TypeError: ... is not a function`), while the existing `formatDuration`/`formatOffset`/`formatInstant` cases still pass.

- [ ] **Step 3: Implement**

In `apps/web/src/routes/format.ts`, replace the `INSTANT_FORMAT` declaration:

```ts
const INSTANT_FORMAT = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  timeZoneName: 'short',
});
```

with:

```ts
const INSTANT_OPTIONS: Intl.DateTimeFormatOptions = {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  timeZoneName: 'short',
};

const INSTANT_FORMAT = new Intl.DateTimeFormat(undefined, INSTANT_OPTIONS);
```

Directly after `formatInstant`, add:

```ts
/**
 * `formatInstant` to the SECOND, for the ends of a time window.
 *
 * `formatInstant` stops at the minute, so both ends of a 30-second window
 * would read identically. Same locale, same zone name, same date style, so
 * the run header and the window's range line never write one instant two
 * ways.
 *
 * BUILT PER CALL, NOT AT MODULE SCOPE, and that is a measurement: a
 * module-scope `Intl.DateTimeFormat` resolves the zone once, at import, and
 * one built under TZ=UTC kept printing UTC after the zone was switched to
 * Asia/Kolkata. A zone-pinned test could not be written against it. The range
 * line calls this twice per render.
 */
export function formatInstantSeconds(epochMs: number): string {
  return new Intl.DateTimeFormat(undefined, { ...INSTANT_OPTIONS, second: '2-digit' }).format(
    epochMs,
  );
}

const two = (n: number): string => String(n).padStart(2, '0');

/**
 * An offset into a run as `HH:MM:SS`, the notation Gatling Enterprise's Offset
 * mode ticks an axis in.
 *
 * FLOORED, like a clock: `00:00:42` until the 43rd second has begun. The
 * wall-clock twin below floors too, reading the date's own fields, so the two
 * modes never disagree about which second a point is in.
 *
 * THE HOURS ARE NOT WRAPPED. A 26-hour soak reads `26:00:00`, not `02:00:00`.
 */
export function formatElapsedClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${two(Math.floor(total / 3600))}:${two(Math.floor((total % 3600) / 60))}:${two(total % 60)}`;
}

/**
 * An instant as `HH:MM:SS` on the reader's own 24-hour clock, Datetime mode's
 * tick notation. The date is not repeated per tick; the range line above the
 * charts carries it.
 *
 * FROM THE DATE'S OWN FIELDS, not `Intl`: they follow the zone the page is in
 * at the moment of the call, and cost nothing in an axis formatter that
 * ECharts calls once per tick per redraw.
 */
export function formatClockTime(epochMs: number): string {
  const at = new Date(epochMs);
  return `${two(at.getHours())}:${two(at.getMinutes())}:${two(at.getSeconds())}`;
}

/**
 * The reader's UTC offset AT A GIVEN INSTANT, spelled as `Intl` spells a short
 * offset: `GMT+5:30`, `GMT-4`, `GMT`.
 *
 * AT AN INSTANT, NOT NOW. A run recorded in New York in July is GMT-4 when it
 * is read in January, and labelling its axis GMT-5 would put every tick an
 * hour out. Callers pass the run's own start.
 */
export function formatZoneOffset(epochMs: number): string {
  const minutes = -new Date(epochMs).getTimezoneOffset();
  if (minutes === 0) return 'GMT';
  const sign = minutes > 0 ? '+' : '-';
  const h = Math.floor(Math.abs(minutes) / 60);
  const m = Math.abs(minutes) % 60;
  return `GMT${sign}${h}${m === 0 ? '' : `:${two(m)}`}`;
}

/** The reader's IANA zone as the browser names it, e.g. `Asia/Calcutta`. */
export function formatZoneName(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}
```

- [ ] **Step 4: Run to verify they pass, in both zones**

Run: `pnpm exec vitest run apps/web/test/format.test.ts`
Expected: PASS.
Run: `TZ=UTC pnpm exec vitest run apps/web/test/format.test.ts`
Expected: PASS — the pins take effect from a UTC start too.

- [ ] **Step 5: Checkpoint commit**

```bash
git add apps/web/src/routes/format.ts apps/web/test/format.test.ts
git commit -F - <<'MSG'
Add the clock formatters the time window's axes and range line need

formatElapsedClock and formatClockTime are Gatling Enterprise's Offset and
Datetime tick notations; formatZoneOffset labels a wall-clock axis with the
offset at the run's own start; formatInstantSeconds is formatInstant to the
second, for the ends of a window.

Built per call or from the Date's own fields, never at module scope: a
module-scope Intl formatter resolves the zone at import, measured to keep
printing UTC after the zone was switched.
MSG
```

- [ ] **Step 6: Red-verify**

Each mutation, then `git checkout HEAD -- apps/web/src/routes/format.ts`:

1. Wall clock in UTC: `perl -0pi -e '$n = s/at\.getHours\(\)/at.getUTCHours()/g; die "expected 1, got $n\n" unless $n == 1' apps/web/src/routes/format.ts` → run the file → FAIL in "reads the reader’s own 24-hour clock" (`11:12:24` for `17:12:24`) and "wraps at midnight".
2. The zone frozen at import: `perl -0pi -e '$n = s/return new Intl\.DateTimeFormat\(undefined, \{ \.\.\.INSTANT_OPTIONS, second: \x272-digit\x27 \}\)\.format\(\n    epochMs,\n  \);/return SECONDS_FORMAT.format(epochMs);/g; die "expected 1, got $n\n" unless $n == 1' apps/web/src/routes/format.ts && perl -0pi -e '$n = s/(const two = )/const SECONDS_FORMAT = new Intl.DateTimeFormat(undefined, { ...INSTANT_OPTIONS, second: \x272-digit\x27 });\n\n$1/g; die "expected 1, got $n\n" unless $n == 1' apps/web/src/routes/format.ts` → run with `TZ=UTC` → FAIL in "names the zone and carries the seconds" (no `GMT+5:30`). Run it WITHOUT `TZ=UTC` too and record that it PASSES there: that pair is the trap this constraint exists for.
3. Today's offset: `perl -0pi -e '$n = s/-new Date\(epochMs\)\.getTimezoneOffset\(\)/-new Date().getTimezoneOffset()/g; die "expected 1, got $n\n" unless $n == 1' apps/web/src/routes/format.ts` → FAIL in "takes the offset at the instant it is given" (one of July/January mismatches, whichever season today is).
4. Wrapped hours: `perl -0pi -e '$n = s/two\(Math\.floor\(total \/ 3600\)\)/two(Math.floor(total \/ 3600) % 24)/g; die "expected 1, got $n\n" unless $n == 1' apps/web/src/routes/format.ts` → FAIL in "lets the hours run past 24" (`02:01:01`).

Finish with `git status --short`.

- [ ] **Step 7: Typecheck and lint**

Run `pnpm typecheck` and `pnpm lint`, each by its own exit code. Expected: `exit=0` twice.

---

### Task 2: The measured step math

**Files:**
- Modify: `apps/web/src/routes/window.ts`
- Test: `apps/web/test/window.test.ts`

**Interfaces:**
- Produces, from `apps/web/src/routes/window.ts`:
  - `interface Span { readonly fromMs: number; readonly toMs: number }`
  - `type WindowStep = 'fast-backward' | 'backward' | 'zoom-out' | 'zoom-in' | 'forward' | 'fast-forward'`
  - `WINDOW_STEPS: readonly { step: WindowStep; label: string }[]` (Gatling's order and words)
  - `WINDOW_PRESETS: readonly { label: string; spanMs: number | null }[]`
  - `snapBound(ms: number, runMs: number, resolutionMs: number): number`
  - `stepWindow(current: Span, step: WindowStep, runMs: number, resolutionMs: number): Window | null`
  - `canStep(current: Span, step: WindowStep, runMs: number, resolutionMs: number): boolean`
  - `presetWindow(spanMs: number | null, runMs: number, resolutionMs: number): Window | null`
  - A returned `Window` always has `bucketWidthMs: 0` (the client convention `parseWindow` uses); `null` is the whole run.

- [ ] **Step 1: Write the failing tests**

In `apps/web/test/window.test.ts`, replace line 2 (`import { parseWindow, serialiseWindow } from '../src/routes/window';`) with:

```ts
import {
  canStep,
  parseWindow,
  presetWindow,
  serialiseWindow,
  snapBound,
  stepWindow,
  WINDOW_PRESETS,
  WINDOW_STEPS,
  type Span,
  type WindowStep,
} from '../src/routes/window';
```

Append at the end of the file:

```ts
/* ======================================================================== *
 * THE SIX CONTROLS, AGAINST GATLING ENTERPRISE'S OWN FIGURES
 * ======================================================================== */

/**
 * Every expectation in the first block was measured on cloud.gatling.io
 * against a two-minute run that began 17:12:09 (the spec's table), and is
 * written here as the offset it is: 17:12:39 is 30 s.
 */
const GATLING_RUN_MS = 120_000;
const SECOND = 1_000;
const w = (fromMs: number, toMs: number) => ({ fromMs, toMs, bucketWidthMs: 0 });

describe('stepWindow — Gatling Enterprise’s measured steps', () => {
  it('zooms in by a quarter from each edge, keeping the centre', () => {
    // 17:12:09–17:14:09 became 17:12:39–17:13:39.
    expect(stepWindow({ fromMs: 0, toMs: 120_000 }, 'zoom-in', GATLING_RUN_MS, SECOND)).toEqual(
      w(30_000, 90_000),
    );
  });

  it('zooms out by a quarter from each edge, cut at the run’s end rather than slid', () => {
    // 17:13:09–17:14:09 became 17:12:54–17:14:09: 60 s to 75 s.
    expect(stepWindow({ fromMs: 60_000, toMs: 120_000 }, 'zoom-out', GATLING_RUN_MS, SECOND)).toEqual(
      w(45_000, 120_000),
    );
  });

  it('pans backward by a fifth of the width, keeping it', () => {
    // 17:12:39–17:13:39 became 17:12:27–17:13:27.
    expect(stepWindow({ fromMs: 30_000, toMs: 90_000 }, 'backward', GATLING_RUN_MS, SECOND)).toEqual(
      w(18_000, 78_000),
    );
  });

  it('pans forward by a fifth', () => {
    // 17:12:09–17:13:09 became 17:12:21–17:13:21.
    expect(stepWindow({ fromMs: 0, toMs: 60_000 }, 'forward', GATLING_RUN_MS, SECOND)).toEqual(
      w(12_000, 72_000),
    );
  });

  it('fast-pans by the whole width', () => {
    // 17:12:25–17:12:44 became 17:12:44–17:13:03.
    expect(stepWindow({ fromMs: 16_000, toMs: 35_000 }, 'fast-forward', GATLING_RUN_MS, SECOND)).toEqual(
      w(35_000, 54_000),
    );
  });

  it('slides a pan against the start, keeping the width', () => {
    // 17:12:27–17:13:27, fast back, became 17:12:09–17:13:09.
    expect(stepWindow({ fromMs: 18_000, toMs: 78_000 }, 'fast-backward', GATLING_RUN_MS, SECOND)).toEqual(
      w(0, 60_000),
    );
  });
});

describe('stepWindow — the resolution and the ends', () => {
  it('lands an interior bound on the nearest multiple of the resolution', () => {
    // A typed window is off the grid; a fifth of 20 s is 4 s.
    expect(stepWindow({ fromMs: 10_300, toMs: 30_300 }, 'backward', GATLING_RUN_MS, SECOND)).toEqual(
      w(6_000, 26_000),
    );
  });

  it('keeps the run’s own end exactly, so its last partial bucket is never dropped', () => {
    // 63,161 ms is the reference run's span; rounded it would be 63,000.
    expect(stepWindow({ fromMs: 40_000, toMs: 60_000 }, 'forward', 63_161, SECOND)).toEqual(
      w(43_000, 63_161),
    );
  });

  it('never zooms in narrower than one bucket', () => {
    // A quarter of 1.6 s rounds both edges onto 11 s; the bucket holding the
    // centre is what is left.
    expect(stepWindow({ fromMs: 10_200, toMs: 11_800 }, 'zoom-in', GATLING_RUN_MS, SECOND)).toEqual(
      w(11_000, 12_000),
    );
  });

  it('is the whole run, no window at all, once a step covers it', () => {
    expect(stepWindow({ fromMs: 10_000, toMs: 110_000 }, 'zoom-out', GATLING_RUN_MS, SECOND)).toBeNull();
  });

  it('snaps to a coarser resolution when the run has one', () => {
    // A long run's buckets widen in powers of two. The same zoom at 1 s would
    // be 25–75 s.
    expect(stepWindow({ fromMs: 0, toMs: 100_000 }, 'zoom-in', GATLING_RUN_MS, 4_000)).toEqual(
      w(24_000, 76_000),
    );
  });
});

describe('snapBound', () => {
  it('keeps both ends of the run exactly and rounds everything between', () => {
    expect(snapBound(-5, 63_161, SECOND)).toBe(0);
    expect(snapBound(63_161, 63_161, SECOND)).toBe(63_161);
    expect(snapBound(70_000, 63_161, SECOND)).toBe(63_161);
    expect(snapBound(12_499, 63_161, SECOND)).toBe(12_000);
    expect(snapBound(12_500, 63_161, SECOND)).toBe(13_000);
  });
});

describe('canStep — the buttons at their limits', () => {
  const enabled = (current: Span, step: WindowStep): boolean =>
    canStep(current, step, GATLING_RUN_MS, SECOND);

  it('offers only Zoom in while the whole run is selected', () => {
    const whole = { fromMs: 0, toMs: GATLING_RUN_MS };
    expect(WINDOW_STEPS.filter(({ step }) => enabled(whole, step)).map(({ step }) => step)).toEqual([
      'zoom-in',
    ]);
  });

  it('stops backward at the start and forward at the end', () => {
    const atStart = { fromMs: 0, toMs: 30_000 };
    expect(enabled(atStart, 'backward')).toBe(false);
    expect(enabled(atStart, 'fast-backward')).toBe(false);
    expect(enabled(atStart, 'forward')).toBe(true);
    const atEnd = { fromMs: 90_000, toMs: GATLING_RUN_MS };
    expect(enabled(atEnd, 'forward')).toBe(false);
    expect(enabled(atEnd, 'fast-forward')).toBe(false);
    expect(enabled(atEnd, 'backward')).toBe(true);
  });

  it('stops zooming in at one bucket', () => {
    expect(enabled({ fromMs: 10_000, toMs: 11_000 }, 'zoom-in')).toBe(false);
    expect(enabled({ fromMs: 10_000, toMs: 12_000 }, 'zoom-in')).toBe(true);
  });

  it('names the six controls in Gatling’s order and words', () => {
    expect(WINDOW_STEPS.map(({ label }) => label)).toEqual([
      'Fast backward', 'Backward', 'Zoom out', 'Zoom in', 'Forward', 'Fast forward',
    ]);
  });
});

describe('presetWindow — measured back from the run’s end', () => {
  const FOUR_HOURS = 4 * 3_600_000;

  it('takes the final stretch of a long run', () => {
    expect(presetWindow(5 * 60_000, FOUR_HOURS, SECOND)).toEqual(w(FOUR_HOURS - 5 * 60_000, FOUR_HOURS));
  });

  it('is the whole run when the preset is at least as long as the run', () => {
    expect(presetWindow(5 * 60_000, 63_161, SECOND)).toBeNull();
    expect(presetWindow(63_161, 63_161, SECOND)).toBeNull();
  });

  it('is the whole run for Everything', () => {
    expect(presetWindow(null, FOUR_HOURS, SECOND)).toBeNull();
  });

  it('offers Gatling’s six presets, in its words', () => {
    expect(WINDOW_PRESETS.map((preset) => preset.label)).toEqual([
      'Last 5 Minutes', 'Last 15 Minutes', 'Last 30 Minutes', 'Last 1 hour', 'Last 1 day', 'Everything',
    ]);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm exec vitest run apps/web/test/window.test.ts`
Expected: FAIL — `stepWindow is not a function` (and its siblings); the existing `parseWindow`/`rangeSuffix`/query-key cases still pass.

- [ ] **Step 3: Implement**

Append to `apps/web/src/routes/window.ts`, after `serialiseWindow` and before the closing `rangeSuffix` comment:

```ts
/** A stretch of the run in elapsed milliseconds, `[fromMs, toMs)`. */
export interface Span {
  readonly fromMs: number;
  readonly toMs: number;
}

export type WindowStep =
  | 'fast-backward'
  | 'backward'
  | 'zoom-out'
  | 'zoom-in'
  | 'forward'
  | 'fast-forward';

/**
 * Gatling Enterprise's six navigator controls, in its order and named with its
 * words. Each button's accessible name and tooltip is its `label`.
 */
export const WINDOW_STEPS: readonly { readonly step: WindowStep; readonly label: string }[] = [
  { step: 'fast-backward', label: 'Fast backward' },
  { step: 'backward', label: 'Backward' },
  { step: 'zoom-out', label: 'Zoom out' },
  { step: 'zoom-in', label: 'Zoom in' },
  { step: 'forward', label: 'Forward' },
  { step: 'fast-forward', label: 'Fast forward' },
];

/**
 * Gatling Enterprise's range presets, spelled as it spells them, its mixed
 * capitals included. Measured back from the run's END: a finished run's "last
 * five minutes" are its final five. `null` is the whole run.
 */
export const WINDOW_PRESETS: readonly { readonly label: string; readonly spanMs: number | null }[] = [
  { label: 'Last 5 Minutes', spanMs: 5 * 60_000 },
  { label: 'Last 15 Minutes', spanMs: 15 * 60_000 },
  { label: 'Last 30 Minutes', spanMs: 30 * 60_000 },
  { label: 'Last 1 hour', spanMs: 60 * 60_000 },
  { label: 'Last 1 day', spanMs: 24 * 60 * 60_000 },
  { label: 'Everything', spanMs: null },
];

/**
 * One bound, snapped the way every step's result is.
 *
 * AN END OF THE RUN IS KEPT EXACTLY. Rounding the run's own span to the
 * resolution would drop its last partial bucket (63,161 ms rounds to 63,000),
 * and a window stepped to the end would quietly stop short of it. Every other
 * bound lands on the nearest multiple of the resolution, which is what makes
 * each one a whole second in Gatling Enterprise's own measurements.
 */
export function snapBound(ms: number, runMs: number, resolutionMs: number): number {
  if (ms <= 0) return 0;
  if (ms >= runMs) return runMs;
  return Math.min(runMs, Math.round(ms / resolutionMs) * resolutionMs);
}

/** A span covering the whole run is the whole run: no window at all. */
function asWindow(fromMs: number, toMs: number, runMs: number): Window | null {
  return fromMs <= 0 && toMs >= runMs ? null : { fromMs, toMs, bucketWidthMs: 0 };
}

/**
 * The window one of the six controls moves to, from `current`.
 *
 * MEASURED ON GATLING ENTERPRISE, not designed (the spec's table):
 *
 *   zoom in                       each edge inward by 25% of the width
 *   zoom out                      each edge outward by 25%, CUT at the ends
 *   backward, forward             20% of the width, the width kept
 *   fast backward, fast forward   100% of the width, the width kept
 *
 * A pan that would leave the run SLIDES against the end and keeps its width;
 * a zoom that would leave it is cut. So zoom out is not zoom in's inverse:
 * in halves the width, out grows it by half. A result covering the whole run
 * is `null`, the rule `TimeBrush.commit` already applies to a drag.
 */
export function stepWindow(
  current: Span,
  step: WindowStep,
  runMs: number,
  resolutionMs: number,
): Window | null {
  const from = Math.max(0, current.fromMs);
  const to = Math.min(runMs, current.toMs);
  const width = to - from;
  const snap = (ms: number): number => snapBound(ms, runMs, resolutionMs);

  if (step === 'zoom-in') {
    const a = snap(from + width / 4);
    const b = snap(to - width / 4);
    if (b - a >= resolutionMs) return asWindow(a, b, runMs);
    // NEVER NARROWER THAN ONE BUCKET, the finest thing stored: the bucket
    // holding the centre. The run's last bucket may be partial, and that is
    // still one bucket.
    const bucket = Math.floor((from + to) / 2 / resolutionMs) * resolutionMs;
    return asWindow(bucket, Math.min(runMs, bucket + resolutionMs), runMs);
  }
  if (step === 'zoom-out') {
    return asWindow(snap(from - width / 4), snap(to + width / 4), runMs);
  }

  const fraction = step === 'fast-backward' || step === 'fast-forward' ? 1 : 0.2;
  const direction = step === 'fast-backward' || step === 'backward' ? -1 : 1;
  let a = from + direction * fraction * width;
  let b = to + direction * fraction * width;
  if (a < 0) {
    a = 0;
    b = width;
  }
  if (b > runMs) {
    b = runMs;
    a = runMs - width;
  }
  return asWindow(snap(a), snap(b), runMs);
}

/**
 * Whether a control can move `current` at all: the six buttons' disabled
 * state. Zoom in stops at one bucket; zoom out and every pan stop when the
 * whole run is selected; backward stops at the start, forward at the end.
 *
 * STATED AS RULES, not as "the step changes nothing": a window the reader
 * TYPED is off the resolution grid, and a step that is otherwise a no-op
 * would still nudge it by a snap, leaving a button that looks live and moves
 * a bound by 300 ms.
 */
export function canStep(current: Span, step: WindowStep, runMs: number, resolutionMs: number): boolean {
  const from = Math.max(0, current.fromMs);
  const to = Math.min(runMs, current.toMs);
  switch (step) {
    case 'zoom-in':
      return to - from > resolutionMs;
    case 'zoom-out':
      return from > 0 || to < runMs;
    case 'backward':
    case 'fast-backward':
      return from > 0;
    case 'forward':
    case 'fast-forward':
      return to < runMs;
  }
}

/**
 * A preset's window: the final `spanMs` of the run. A preset at least as long
 * as the run is the whole run, which is Gatling's "Last 1 day" on a one-minute
 * test.
 */
export function presetWindow(spanMs: number | null, runMs: number, resolutionMs: number): Window | null {
  if (spanMs === null || spanMs >= runMs) return null;
  return asWindow(snapBound(runMs - spanMs, runMs, resolutionMs), runMs, runMs);
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm exec vitest run apps/web/test/window.test.ts`
Expected: PASS.

- [ ] **Step 5: Checkpoint commit**

```bash
git add apps/web/src/routes/window.ts apps/web/test/window.test.ts
git commit -F - <<'MSG'
Add the time window's step math, pinned to Gatling Enterprise's figures

Zoom moves each edge 25% of the width, pan 20%, fast pan 100%. Pans slide
against the run's ends keeping the width; zoom is cut at them, so zoom out
is not zoom in's inverse. Every interior bound lands on the resolution and
an end of the run is kept exactly, so the last partial bucket is never
dropped. Each expectation is the offset of a range measured on
cloud.gatling.io.
MSG
```

- [ ] **Step 6: Red-verify**

Each mutation, then `git checkout HEAD -- apps/web/src/routes/window.ts`:

1. A third instead of a quarter: `perl -0pi -e '$n = s/snap\(from \+ width \/ 4\)/snap(from + width \/ 3)/g; die "expected 1, got $n\n" unless $n == 1' apps/web/src/routes/window.ts` → FAIL in "zooms in by a quarter from each edge".
2. The end rounded: `perl -0pi -e '$n = s/  if \(ms >= runMs\) return runMs;\n//g; die "expected 1, got $n\n" unless $n == 1' apps/web/src/routes/window.ts` → FAIL in "keeps the run’s own end exactly" and in `snapBound`.
3. No slide: `perl -0pi -e '$n = s/  if \(a < 0\) \{\n    a = 0;\n    b = width;\n  \}\n//g; die "expected 1, got $n\n" unless $n == 1' apps/web/src/routes/window.ts` → FAIL in "slides a pan against the start".
4. Zoom in allowed at one bucket: `perl -0pi -e '$n = s/return to - from > resolutionMs;/return to - from >= resolutionMs;/g; die "expected 1, got $n\n" unless $n == 1' apps/web/src/routes/window.ts` → FAIL in "stops zooming in at one bucket".

- [ ] **Step 7: Typecheck and lint** — `exit=0` twice.

---

### Task 3: The mode preference and the time-axis context

**Files:**
- Create: `apps/web/src/timeAxisPreference.ts`
- Create: `apps/web/src/charts/TimeAxisContext.tsx`
- Test: `apps/web/test/timeAxisPreference.test.ts` (node project), `apps/web/test/TimeAxisContext.test.tsx` (jsdom project)

**Interfaces:**
- Produces, from `apps/web/src/timeAxisPreference.ts`: `type TimeAxisMode = 'offset' | 'datetime'`, `TIME_AXIS_STORAGE_KEY = 'perfportal-time-axis'`, `isTimeAxisMode(value: unknown): value is TimeAxisMode`, `readTimeAxisMode(): TimeAxisMode`, `writeTimeAxisMode(mode: TimeAxisMode): void`.
- Produces, from `apps/web/src/charts/TimeAxisContext.tsx`: `interface TimeAxisContextValue { mode: TimeAxisMode; anchorMs: number | null; setMode(mode: TimeAxisMode): void }`, `TimeAxisProvider({ anchor: string | null | undefined; children })`, `ElapsedOnly({ children })`, `useTimeAxis(): TimeAxisContextValue`. Outside any provider `useTimeAxis()` returns `{ mode: 'offset', anchorMs: null, setMode: no-op }`.

- [ ] **Step 1: Write the failing tests**

Create `apps/web/test/timeAxisPreference.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  readTimeAxisMode,
  TIME_AXIS_STORAGE_KEY,
  writeTimeAxisMode,
} from '../src/timeAxisPreference';

/** A `Storage` stand-in: the node project has no `localStorage` of its own. */
function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the time-axis preference', () => {
  it('is Offset when nothing is stored, Gatling Enterprise’s own default', () => {
    vi.stubGlobal('localStorage', memoryStorage());
    expect(readTimeAxisMode()).toBe('offset');
  });

  it('round-trips a choice', () => {
    const storage = memoryStorage();
    vi.stubGlobal('localStorage', storage);
    writeTimeAxisMode('datetime');
    expect(storage.getItem(TIME_AXIS_STORAGE_KEY)).toBe('datetime');
    expect(readTimeAxisMode()).toBe('datetime');
  });

  it('reads an unknown stored value as Offset', () => {
    vi.stubGlobal('localStorage', memoryStorage({ [TIME_AXIS_STORAGE_KEY]: 'wallclock' }));
    expect(readTimeAxisMode()).toBe('offset');
  });

  it('survives a storage that throws, in both directions', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    });
    expect(readTimeAxisMode()).toBe('offset');
    expect(() => writeTimeAxisMode('datetime')).not.toThrow();
  });
});
```

Create `apps/web/test/TimeAxisContext.test.tsx`:

```tsx
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ElapsedOnly, TimeAxisProvider, useTimeAxis } from '../src/charts/TimeAxisContext';
import { TIME_AXIS_STORAGE_KEY } from '../src/timeAxisPreference';

// `vitest.config.ts` sets no `globals`, so Testing Library's automatic cleanup
// never registers; see `RequestDetail.test.tsx` for what leaking DOM costs.
afterEach(() => {
  cleanup();
  localStorage.removeItem(TIME_AXIS_STORAGE_KEY);
});

const ANCHOR = '2026-08-15T11:42:09.000Z';

/** The last value the probe read, for calling `setMode` from a test. */
const seen: { value?: ReturnType<typeof useTimeAxis> } = {};

function Probe() {
  seen.value = useTimeAxis();
  return <span data-testid="probe">{`${seen.value.mode}|${String(seen.value.anchorMs)}`}</span>;
}

describe('TimeAxisProvider', () => {
  it('opens on Offset when nothing is stored', () => {
    render(
      <TimeAxisProvider anchor={ANCHOR}>
        <Probe />
      </TimeAxisProvider>,
    );
    expect(screen.getByTestId('probe')).toHaveTextContent(`offset|${Date.parse(ANCHOR)}`);
  });

  it('opens on the stored mode', () => {
    localStorage.setItem(TIME_AXIS_STORAGE_KEY, 'datetime');
    render(
      <TimeAxisProvider anchor={ANCHOR}>
        <Probe />
      </TimeAxisProvider>,
    );
    expect(screen.getByTestId('probe')).toHaveTextContent(/^datetime\|/);
  });

  it('remembers a change, so the next page opens on it', () => {
    const first = render(
      <TimeAxisProvider anchor={ANCHOR}>
        <Probe />
      </TimeAxisProvider>,
    );
    act(() => seen.value!.setMode('datetime'));
    expect(screen.getByTestId('probe')).toHaveTextContent(/^datetime\|/);

    first.unmount();
    render(
      <TimeAxisProvider anchor={ANCHOR}>
        <Probe />
      </TimeAxisProvider>,
    );
    expect(screen.getByTestId('probe')).toHaveTextContent(/^datetime\|/);
  });

  it('has no anchor for a run that recorded none, or an unreadable one', () => {
    render(
      <TimeAxisProvider anchor={null}>
        <Probe />
      </TimeAxisProvider>,
    );
    expect(screen.getByTestId('probe')).toHaveTextContent('offset|null');
    cleanup();

    render(
      <TimeAxisProvider anchor="not-a-date">
        <Probe />
      </TimeAxisProvider>,
    );
    expect(screen.getByTestId('probe')).toHaveTextContent('offset|null');
  });
});

describe('ElapsedOnly', () => {
  it('pins elapsed time beneath it, whatever the viewer chose', () => {
    localStorage.setItem(TIME_AXIS_STORAGE_KEY, 'datetime');
    render(
      <TimeAxisProvider anchor={ANCHOR}>
        <ElapsedOnly>
          <Probe />
        </ElapsedOnly>
      </TimeAxisProvider>,
    );
    expect(screen.getByTestId('probe')).toHaveTextContent('offset|null');
  });
});

describe('outside any provider', () => {
  it('reads elapsed time, so a chart on its own renders as it always has', () => {
    render(<Probe />);
    expect(screen.getByTestId('probe')).toHaveTextContent('offset|null');
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm exec vitest run apps/web/test/timeAxisPreference.test.ts apps/web/test/TimeAxisContext.test.tsx`
Expected: FAIL — both files fail to import (`Failed to resolve import "../src/timeAxisPreference"`).

- [ ] **Step 3: Implement**

Create `apps/web/src/timeAxisPreference.ts`:

```ts
/**
 * How a viewer reads a run's time axes: `offset`, elapsed from the run's start
 * (Gatling Enterprise's default), or `datetime`, their own wall clock.
 *
 * A READING PREFERENCE, so per viewer and never in the URL. That is AC-DASH-4's
 * line: a shared link carries the question (the window), not how its sender
 * likes to read the answer. Stored the way `theme.ts` stores the theme and
 * `ProjectRail` its collapse: one key, every read and write inside `try`, and
 * anything unrecognised reading as the default.
 */
export type TimeAxisMode = 'offset' | 'datetime';

export const TIME_AXIS_STORAGE_KEY = 'perfportal-time-axis';

export function isTimeAxisMode(value: unknown): value is TimeAxisMode {
  return value === 'offset' || value === 'datetime';
}

/**
 * The stored mode, or `offset`, including when storage throws, which it does
 * in Safari's private mode. A preference is not worth a crash on first paint.
 */
export function readTimeAxisMode(): TimeAxisMode {
  try {
    const stored = localStorage.getItem(TIME_AXIS_STORAGE_KEY);
    return isTimeAxisMode(stored) ? stored : 'offset';
  } catch {
    return 'offset';
  }
}

export function writeTimeAxisMode(mode: TimeAxisMode): void {
  try {
    localStorage.setItem(TIME_AXIS_STORAGE_KEY, mode);
  } catch {
    // A choice that does not survive a reload is a smaller failure than one
    // that throws on the change that made it.
  }
}
```

Create `apps/web/src/charts/TimeAxisContext.tsx`:

```tsx
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { readTimeAxisMode, writeTimeAxisMode, type TimeAxisMode } from '../timeAxisPreference';

/**
 * Which clock one run's time axes read, and the instant that clock starts at.
 *
 * `anchorMs` is the run's `toolStartedAt`, and it shares its zero with every
 * series offset: the worker writes it from the engine's own run start, and
 * every series is built from that same start. So wall-clock time is exactly
 * `anchorMs + offsetMs`, with no lead-in to correct for.
 *
 * `mode` is the VIEWER'S CHOICE and `anchorMs` the RUN'S FACT. A chart reads
 * the wall clock only when both allow it; a run with no anchor reads elapsed
 * whatever was chosen.
 */
export interface TimeAxisContextValue {
  readonly mode: TimeAxisMode;
  readonly anchorMs: number | null;
  readonly setMode: (mode: TimeAxisMode) => void;
}

/**
 * Elapsed, no anchor, nothing to change. The value outside any provider, so a
 * chart rendered on its own reads as it always has, and the one `ElapsedOnly`
 * pins for a figure spanning several runs.
 */
const ELAPSED_ONLY: TimeAxisContextValue = {
  mode: 'offset',
  anchorMs: null,
  setMode: () => {},
};

const TimeAxisContext = createContext<TimeAxisContextValue>(ELAPSED_ONLY);

/**
 * One run's time axis, for everything beneath it.
 *
 * THE ANCHOR ARRIVES AS A PROP, from the run read the page already holds
 * (`RunShell`'s `identity`, a drill-down's `useRunTerminal`), so this adds no
 * query and no observer. The mode lives here, seeded from storage, so every
 * chart on a page switches together and a drill-down opened afterwards reads
 * the same choice back.
 */
export function TimeAxisProvider({
  anchor,
  children,
}: {
  /** The run's `toolStartedAt`, when it is known. */
  readonly anchor: string | null | undefined;
  readonly children: ReactNode;
}) {
  const [mode, setModeState] = useState<TimeAxisMode>(readTimeAxisMode);
  const setMode = useCallback((next: TimeAxisMode) => {
    setModeState(next);
    writeTimeAxisMode(next);
  }, []);
  const parsed = anchor == null ? Number.NaN : Date.parse(anchor);
  const anchorMs = Number.isFinite(parsed) ? parsed : null;
  const value = useMemo(() => ({ mode, anchorMs, setMode }), [mode, anchorMs, setMode]);
  return <TimeAxisContext.Provider value={value}>{children}</TimeAxisContext.Provider>;
}

/**
 * Elapsed time for everything beneath, whatever the viewer chose.
 *
 * FOR A FIGURE THAT SPANS RUNS. Compare overlays up to five, each with its own
 * wall clock and no single anchor; Gatling Enterprise's comparison stays
 * elapsed for the same reason.
 */
export function ElapsedOnly({ children }: { readonly children: ReactNode }) {
  return <TimeAxisContext.Provider value={ELAPSED_ONLY}>{children}</TimeAxisContext.Provider>;
}

/** The time axis the nearest provider describes. */
export function useTimeAxis(): TimeAxisContextValue {
  return useContext(TimeAxisContext);
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm exec vitest run apps/web/test/timeAxisPreference.test.ts apps/web/test/TimeAxisContext.test.tsx`
Expected: PASS, 4 + 6 cases.

- [ ] **Step 5: Checkpoint commit**

```bash
git add apps/web/src/timeAxisPreference.ts apps/web/src/charts/TimeAxisContext.tsx apps/web/test/timeAxisPreference.test.ts apps/web/test/TimeAxisContext.test.tsx
git commit -F - <<'MSG'
Add the time-axis mode, a stored preference carried by a context

The viewer's Offset or Datetime choice is stored like the theme and read
back on every page; the run's anchor, toolStartedAt, arrives as a prop from
the run read each page already holds, so the provider adds no query.
ElapsedOnly pins elapsed time for a figure spanning several runs. Outside
any provider the value is elapsed with no anchor, so a chart on its own is
unchanged.
MSG
```

- [ ] **Step 6: Red-verify**

Each mutation, then `git checkout HEAD -- <file>`:

1. Storage ignored: `perl -0pi -e '$n = s/useState<TimeAxisMode>\(readTimeAxisMode\)/useState<TimeAxisMode>(\x27offset\x27)/g; die "expected 1, got $n\n" unless $n == 1' apps/web/src/charts/TimeAxisContext.tsx` → FAIL in "opens on the stored mode" and "remembers a change".
2. Not written: `perl -0pi -e '$n = s/    writeTimeAxisMode\(next\);\n//g; die "expected 1, got $n\n" unless $n == 1' apps/web/src/charts/TimeAxisContext.tsx` → FAIL in "remembers a change" only, at its assertion after the remount.
3. ElapsedOnly passes through: `perl -0pi -e '$n = s/value=\{ELAPSED_ONLY\}>\{children\}/value={useTimeAxis()}>{children}/g; die "expected 1, got $n\n" unless $n == 1' apps/web/src/charts/TimeAxisContext.tsx` → FAIL in "pins elapsed time beneath it".
4. Unknown value trusted: `perl -0pi -e '$n = s/return isTimeAxisMode\(stored\) \? stored : \x27offset\x27;/return (stored ?? \x27offset\x27) as TimeAxisMode;/g; die "expected 1, got $n\n" unless $n == 1' apps/web/src/timeAxisPreference.ts` → FAIL in "reads an unknown stored value as Offset".

- [ ] **Step 7: Typecheck and lint** — `exit=0` twice.

---

### Task 4: `Chart` names and labels every elapsed axis from the mode

**Files:**
- Modify: `apps/web/src/charts/Chart.tsx`
- Modify: `apps/web/src/charts/PercentilesChart.tsx`, `TelemetryCharts.tsx`, `ErrorsChart.tsx`, `RatesChart.tsx`, `UsersChart.tsx`, `TimeBrush.tsx`, `CompareChart.tsx`
- Test: `apps/web/test/Chart.test.tsx`, `apps/web/test/timeAxis.test.ts`, `apps/web/test/TimeBrush.test.tsx`

**Interfaces:**
- Consumes: `useTimeAxis`, `ElapsedOnly`, `TimeAxisProvider` (Task 3); `formatElapsedClock`, `formatClockTime`, `formatZoneOffset` (Task 1).
- Produces: `ChartXAxis` becomes a union in which `name` and `tickUnit: 'ms-as-s'` cannot both be set (`name?: never` in the elapsed variant). An elapsed-millisecond axis is named `Elapsed`, or `Time (<GMT offset at the anchor>)` in Datetime with an anchor; its ticks and its axis-pointer label read `HH:MM:SS` from one function; it carries `minInterval: 1000`.

- [ ] **Step 1: Write the failing tests**

In `apps/web/test/Chart.test.tsx`:

(a) Replace the import on line 2 with `import { act, cleanup, render, screen } from '@testing-library/react';` and add after the `import type { ChartData } …` line:

```ts
import { ElapsedOnly, TimeAxisProvider, useTimeAxis } from '../src/charts/TimeAxisContext.js';
import { TIME_AXIS_STORAGE_KEY } from '../src/timeAxisPreference.js';
```

(b) Re-point the pointer case in `describe('Chart — the shared time axis', …)`. Replace the whole `it('labels the POINTER in the same units as the ticks', …)` block with:

```tsx
  it('labels the POINTER in the same clock as the ticks', () => {
    // The pointer's label is the tooltip's title. Without this the percentile
    // chart's ticks read elapsed time while the tooltip above them announced
    // "49,000.00", the raw millisecond value to two decimals.
    render(
      <Chart
        id="a"
        title="Requests per second"
        data={seriesData(['All'])}
        xAxis={{ type: 'value', tickUnit: 'ms-as-s' }}
      />,
    );
    const axis = lastOption()['xAxis'] as {
      axisLabel: { formatter?: (value: number) => string };
      axisPointer?: { label?: { formatter?: (p: { value: number }) => string } };
    };
    expect(axis.axisPointer?.label?.formatter?.({ value: 49_000 })).toBe('00:00:49');
    expect(axis.axisPointer?.label?.formatter?.({ value: 49_000 })).toBe(
      axis.axisLabel.formatter?.(49_000),
    );
  });
```

(c) In `describe('Chart — the warm-up band', …)`, replace
`const msAxis = { type: 'value', name: 'Elapsed (s)', tickUnit: 'ms-as-s' } as const;`
with
`const msAxis = { type: 'value', tickUnit: 'ms-as-s' } as const;`

(d) Append at the end of the file:

```tsx
/* ======================================================================== *
 * THE TIME MODE: Gatling Enterprise's Offset and Datetime
 * ======================================================================== */

/**
 * Pins the process zone for one case. THIS MACHINE'S OWN ZONE IS
 * Asia/Kolkata, so a pin that silently failed would pass here and fail only
 * on CI's UTC runners: every case asserts the flip landed first, and the file
 * is also run under `TZ=UTC`.
 */
function inZone(zone: string, body: () => void): void {
  const original = process.env.TZ;
  try {
    process.env.TZ = zone;
    body();
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
}

describe('Chart — the time axis follows the viewer’s mode', () => {
  // 17:12:09 in Asia/Kolkata: the start of the run Gatling was measured on.
  const ANCHOR = '2026-08-15T11:42:09.000Z';
  const kolkataTook = () => expect(new Date('2026-08-15T00:00:00Z').getHours()).toBe(5);

  afterEach(() => {
    localStorage.removeItem(TIME_AXIS_STORAGE_KEY);
  });

  const timeAxis = () =>
    lastOption()['xAxis'] as {
      name?: string;
      minInterval?: number;
      axisLabel: { formatter?: (value: number) => string };
      axisPointer?: { label?: { formatter?: (p: { value: number }) => string } };
    };

  const elapsedChart = (
    <Chart
      id="t"
      title="Requests per second"
      data={seriesData(['All'])}
      xAxis={{ type: 'value', tickUnit: 'ms-as-s' }}
    />
  );

  it('reads elapsed HH:MM:SS under an axis named Elapsed, by default', () => {
    render(elapsedChart);
    expect(timeAxis().name).toBe('Elapsed');
    expect(timeAxis().axisLabel.formatter?.(75_000)).toBe('00:01:15');
  });

  it('reads the wall clock in Datetime, named for the zone at the run’s start', () => {
    inZone('Asia/Kolkata', () => {
      kolkataTook();
      localStorage.setItem(TIME_AXIS_STORAGE_KEY, 'datetime');
      render(<TimeAxisProvider anchor={ANCHOR}>{elapsedChart}</TimeAxisProvider>);
      expect(timeAxis().name).toBe('Time (GMT+5:30)');
      // Gatling's own measured pair: elapsed 00:00:15 on this run is 17:12:24.
      expect(timeAxis().axisLabel.formatter?.(15_000)).toBe('17:12:24');
      expect(timeAxis().axisPointer?.label?.formatter?.({ value: 15_000 })).toBe('17:12:24');
    });
  });

  it('stays elapsed in Datetime when the run recorded no start', () => {
    localStorage.setItem(TIME_AXIS_STORAGE_KEY, 'datetime');
    render(<TimeAxisProvider anchor={null}>{elapsedChart}</TimeAxisProvider>);
    expect(timeAxis().name).toBe('Elapsed');
    expect(timeAxis().axisLabel.formatter?.(15_000)).toBe('00:00:15');
  });

  it('stays elapsed under ElapsedOnly, whatever the viewer chose', () => {
    localStorage.setItem(TIME_AXIS_STORAGE_KEY, 'datetime');
    render(
      <TimeAxisProvider anchor={ANCHOR}>
        <ElapsedOnly>{elapsedChart}</ElapsedOnly>
      </TimeAxisProvider>,
    );
    expect(timeAxis().name).toBe('Elapsed');
  });

  it('leaves every other axis alone', () => {
    localStorage.setItem(TIME_AXIS_STORAGE_KEY, 'datetime');
    render(
      <TimeAxisProvider anchor={ANCHOR}>
        <Chart
          id="s"
          title="Scatter"
          data={seriesData(['All'])}
          xAxis={{ type: 'value', name: 'Response time (ms)' }}
        />
      </TimeAxisProvider>,
    );
    expect(timeAxis().name).toBe('Response time (ms)');
    expect(timeAxis().axisLabel.formatter).toBeUndefined();
    expect(timeAxis().minInterval).toBeUndefined();
  });

  it('never ticks an elapsed axis finer than a second', () => {
    // Zoomed to one bucket, ECharts would tick every 200 ms and print one
    // HH:MM:SS five times.
    render(elapsedChart);
    expect(timeAxis().minInterval).toBe(1000);
  });

  it('redraws when the mode changes, not only when the data does', () => {
    inZone('Asia/Kolkata', () => {
      kolkataTook();
      const handle: { setMode?: (mode: 'offset' | 'datetime') => void } = {};
      function Switch() {
        handle.setMode = useTimeAxis().setMode;
        return null;
      }
      render(
        <TimeAxisProvider anchor={ANCHOR}>
          <Switch />
          {elapsedChart}
        </TimeAxisProvider>,
      );
      expect(timeAxis().name).toBe('Elapsed');
      act(() => handle.setMode!('datetime'));
      expect(timeAxis().name).toBe('Time (GMT+5:30)');
    });
  });
});
```

(e) In `apps/web/test/timeAxis.test.ts`, replace the whole block from the comment `/**\n * ═══ AN ELAPSED AXIS IN SECONDS ALWAYS CONVERTS ═══` through the end of `describe('every elapsed axis converts its own ticks', …)` with:

```ts
/**
 * ═══ AN ELAPSED AXIS IS NAMED ONCE, BY `Chart` ═══
 *
 * Every time series in this product plots raw `startOffsetMs` (a value axis
 * carries x per point) and passes `tickUnit: 'ms-as-s'`, which is what makes
 * `Chart` draw its ticks and its pointer as clock time. Until the time mode
 * arrived, each chart ALSO named that axis `Elapsed (s)`: thirteen literals
 * across seven files, kept in step with `tickUnit` by this guard's previous
 * form, which counted the two per file.
 *
 * The name now follows the viewer's mode, `Elapsed` or `Time (GMT+5:30)`, so
 * it can only be decided in one place. `ChartXAxis` refuses a `name` beside
 * `tickUnit` at compile time; this refuses the other way back to the drift, a
 * chart component spelling an elapsed axis name itself on an axis that then
 * does not convert. `Elapsed (ms)` is covered by the same pattern: the plotted
 * value is always milliseconds, and a chart that wants to say so is a chart
 * that forgot to convert.
 */
describe('every elapsed axis is named by Chart alone', () => {
  it('leaves the elapsed-axis name to Chart, in every chart component', () => {
    const dir = fromRepo('apps/web/src/charts');
    const files = (
      readdirSync(dir, { recursive: true, encoding: 'utf8' }) as unknown as string[]
    ).filter((f) => typeof f === 'string' && f.endsWith('.tsx'));

    const offenders: string[] = [];
    let convertingAxes = 0;
    for (const f of files) {
      // Comments stripped: the comment explaining this rule quotes the
      // spelling it forbids.
      const src = readFileSync(join(dir, f), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '');
      // COUNTED IN EVERY FILE, `Chart.tsx` included: the construct that must
      // exist for the absence below to mean anything.
      convertingAxes += src.match(/tickUnit: 'ms-as-s'/g)?.length ?? 0;
      if (f === 'Chart.tsx') continue;
      for (const m of src.matchAll(/name: ['"`]Elapsed[^'"`]*['"`]/g)) offenders.push(`${f}: ${m[0]}`);
    }

    expect(offenders).toEqual([]);
    // A positive beside the absence, counting the construct rather than the
    // verdict: an empty chart directory would satisfy the check above.
    expect(convertingAxes).toBeGreaterThan(10);
  });
});
```

(f) In `apps/web/test/TimeBrush.test.tsx`, the navigator's own axis changes with this task, so its case is re-pointed here and not left red until Task 6. Replace the docstring above `it('labels that axis in seconds while still plotting milliseconds', …)` with:

```ts
  /**
   * ═══ THE NAME DESCRIBES WHAT THE READER SEES, THE DATA STAYS IN ms ═══
   *
   * This replaces an assertion that the name read `(s)`, which was right while
   * the ticks were bare seconds and is wrong now: they read `HH:MM:SS`,
   * Gatling Enterprise's Offset notation, under a name `Chart` decides from
   * the viewer's time mode.
   *
   * The protection that assertion gave, that the name must not lie about the
   * axis, is kept by pinning the whole chain in one place: the plotted x is
   * still milliseconds (the brush contract), the formatter is what turns those
   * into clock time, and the name says elapsed because that is what ends up
   * under the ticks. A change to any one of the three without the others
   * fails here.
   */
```

rename the case `'labels that axis as elapsed clock time while still plotting milliseconds'`, and replace its four assertions

```ts
    expect(axis.name).toMatch(/\(s\)/);
    expect(axis.name).not.toMatch(/\(ms\)/);

    // The formatter is what makes that true, so it has to exist and convert.
    expect(axis.axisLabel.formatter).toBeTypeOf('function');
    expect(axis.axisLabel.formatter!(20_000)).toBe('20');
    expect(axis.axisLabel.formatter!(63_161)).toBe('63');
```

with

```ts
    expect(axis.name).toBe('Elapsed');

    // The formatter is what makes that true, so it has to exist and convert.
    expect(axis.axisLabel.formatter).toBeTypeOf('function');
    expect(axis.axisLabel.formatter!(20_000)).toBe('00:00:20');
    expect(axis.axisLabel.formatter!(63_161)).toBe('00:01:03');
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm exec vitest run apps/web/test/Chart.test.tsx apps/web/test/timeAxis.test.ts apps/web/test/TimeBrush.test.tsx`
Expected: FAIL — the pointer case (`'49 s'` for `'00:00:49'`); every case in the new describe (the name is the caller's `undefined`, not `Elapsed`, the ticks are bare seconds, there is no `minInterval`); the re-pointed guard, listing the thirteen `name: 'Elapsed (s)'` literals; and the re-pointed TimeBrush case (`'20'` for `'00:00:20'`). Every other case passes.

- [ ] **Step 3: Implement `ChartXAxis`**

In `apps/web/src/charts/Chart.tsx`:

1. Add after the `import { tooltipFormatter, … } from './tooltip';` line:

```ts
import { useTimeAxis } from './TimeAxisContext';
import { formatClockTime, formatElapsedClock, formatZoneOffset } from '../routes/format';
```

2. Change `export interface ChartXAxis {` to `interface ChartXAxisBase {`.
3. Delete the line `  readonly name?: string;` directly under it.
4. Delete the `tickUnit` member together with its docstring (the block from `  /**\n   * Renders a MILLISECOND value axis with SECOND tick labels.` through `  readonly tickUnit?: 'ms-as-s';`).
5. Directly after that interface's closing `}`, add:

```ts
/**
 * `name` and `tickUnit` are EXCLUSIVE, and the type says so.
 *
 * An elapsed-millisecond axis is named by `Chart` itself, from the viewer's
 * time mode (`Elapsed`, or `Time (GMT+5:30)` over wall-clock ticks), so a
 * caller that also named it would put a second, stale answer on the page. It
 * used to be thirteen hand-written `name: 'Elapsed (s)'` literals kept in step
 * with `tickUnit` only by `timeAxis.test.ts`; now passing both does not
 * compile.
 */
export type ChartXAxis = ChartXAxisBase &
  (
    | { readonly name?: string; readonly tickUnit?: undefined }
    | {
        /**
         * Draws a MILLISECOND value axis as clock time: `HH:MM:SS` elapsed
         * from the run's start, or the reader's own wall clock in Datetime
         * mode (`TimeAxisProvider`). The axis pointer's label, which is the
         * tooltip's title, follows the ticks.
         *
         * ═══ IT CHANGES THE LABELS AND NOTHING ELSE ═══
         *
         * The axis stays in milliseconds, because on the time-window strip
         * the axis' units ARE the contract: the `dataZoom` slider reports its
         * handles in them and `TimeBrush` writes those numbers straight to
         * the URL. Converting the axis itself would silently re-denominate
         * every committed window, the same class of bug as drawing the scalar
         * form on a value axis, which once turned a drag over a third of a
         * 63 s run into `?from=0&to=7`.
         *
         * A STRING, not a formatter function: it lands in the option effect's
         * dependency list, and a caller-built closure would be a fresh
         * identity every render and re-run that effect continuously.
         */
        readonly tickUnit: 'ms-as-s';
        readonly name?: never;
      }
  );
```

- [ ] **Step 4: Implement the elapsed branch**

Still in `Chart.tsx`:

1. Directly after `const xAxisMax = xAxis?.max;`, add:

```ts
  /**
   * THE CLOCK THIS AXIS READS, from the nearest `TimeAxisProvider`.
   *
   * Only an elapsed-millisecond axis can be relabelled, and only to the wall
   * clock when the viewer chose it AND the run has an anchor: `null` means
   * elapsed. A primitive, like every axis field here, because the option
   * effect lists it.
   */
  const timeAxis = useTimeAxis();
  const wallAnchorMs =
    xAxisTickUnit === 'ms-as-s' && timeAxis.mode === 'datetime' ? timeAxis.anchorMs : null;
  /**
   * The x axis' name as drawn. An elapsed-millisecond axis is named here and
   * nowhere else (`ChartXAxis`): `Elapsed` over elapsed ticks, or the zone over
   * wall-clock ones, taken at the run's START so a run recorded in July is
   * labelled for July whenever it is read.
   */
  const drawnXAxisName =
    xAxisTickUnit === 'ms-as-s'
      ? wallAnchorMs === null
        ? 'Elapsed'
        : `Time (${formatZoneOffset(wallAnchorMs)})`
      : xAxisName;
```

2. In `categoryAxis`, replace `name: xAxisName,` with `name: drawnXAxisName,` (one occurrence inside `const categoryAxis = {`).
3. Directly before `const numericAxis = {`'s docstring (the `/**` that opens "FOR A CHART WHOSE X IS A MEASURED QUANTITY"), add:

```ts
    /**
     * One clock for the ticks and the pointer: elapsed `HH:MM:SS`, or the
     * reader's wall clock when the time mode and the run's anchor allow it.
     */
    const timeLabel = (value: number): string =>
      wallAnchorMs === null ? formatElapsedClock(value) : formatClockTime(wallAnchorMs + value);
```

4. In `numericAxis`: replace `name: xAxisName,` with `name: drawnXAxisName,`; replace

```ts
        // Milliseconds on the axis, seconds on the label — see
        // `ChartXAxis.tickUnit`. `Math.round`, not a fixed precision: the
        // strip's ticks land on whole seconds and `20` reads as a time where
        // `20.0` reads as a measurement.
        ...(xAxisTickUnit === 'ms-as-s'
          ? { formatter: (value: number) => String(Math.round(value / 1000)) }
          : {}),
      },
```

with

```ts
        // Milliseconds on the axis, clock time on the label: see
        // `ChartXAxis` and `timeLabel` above.
        ...(xAxisTickUnit === 'ms-as-s' ? { formatter: timeLabel } : {}),
      },
      // NEVER FINER THAN A SECOND on an elapsed axis. The zoom buttons can
      // narrow a window to one bucket, and ECharts would then tick it every
      // 200 ms: five labels reading the same HH:MM:SS.
      ...(xAxisTickUnit === 'ms-as-s' ? { minInterval: 1000 } : {}),
```

and replace

```ts
                formatter: (params: { value: number | string }) =>
                  `${Math.round(Number(params.value) / 1000)} s`,
```

with

```ts
                formatter: (params: { value: number | string }) => timeLabel(Number(params.value)),
```

5. In the grid's `bottom:` expression, replace `(xAxisName === undefined ? 32 : 56)` with `(drawnXAxisName === undefined ? 32 : 56)`.
6. In the option effect's dependency array, replace the line `    xAxisName,` with the two lines `    drawnXAxisName,` and `    wallAnchorMs,`, and in the comment above the array replace ``(`yAxisType`,\n    // `yAxisName`, `xAxisName`)`` wording so it names `drawnXAxisName` instead of `xAxisName`.

`grep -n "xAxisName" apps/web/src/charts/Chart.tsx` must now show only its declaration and its use inside `drawnXAxisName`.

- [ ] **Step 5: Drop the thirteen literals, and keep Compare elapsed**

Each line below asserts its own count, so a file that holds more or fewer literals than the survey found stops the step instead of half-editing it:

```bash
drop() { perl -0pi -e '$n = s/\n[ \t]*name: \x27Elapsed \(s\)\x27,(?=\n)//g; die "expected $ENV{WANT}, got $n\n" unless $n == $ENV{WANT}' "$1"; }
WANT=6 drop apps/web/src/charts/TelemetryCharts.tsx
WANT=2 drop apps/web/src/charts/UsersChart.tsx
WANT=1 drop apps/web/src/charts/PercentilesChart.tsx
WANT=1 drop apps/web/src/charts/ErrorsChart.tsx
WANT=1 drop apps/web/src/charts/RatesChart.tsx
```

Then the two inline ones:

```bash
perl -0pi -e '$n = s/xAxis=\{\{ type: \x27value\x27, name: \x27Elapsed \(s\)\x27, tickUnit: \x27ms-as-s\x27 \}\}/xAxis={{ type: \x27value\x27, tickUnit: \x27ms-as-s\x27 }}/g; die "expected 1, got $n\n" unless $n == 1' apps/web/src/charts/TimeBrush.tsx
perl -0pi -e '$n = s/xAxis=\{\{ type: \x27value\x27, name: \x27Elapsed \(s\)\x27, tickUnit: \x27ms-as-s\x27 \}\}/xAxis={{ type: \x27value\x27, tickUnit: \x27ms-as-s\x27 }}/g; die "expected 1, got $n\n" unless $n == 1' apps/web/src/charts/CompareChart.tsx
```

`grep -rn "Elapsed (s)'" apps/web/src/charts --include=*.tsx` must return nothing.

In `apps/web/src/charts/CompareChart.tsx`, add `import { ElapsedOnly } from './TimeAxisContext';` after `import Chart from './Chart';`, wrap the `<Chart id="compare-overlay" … />` element in `<ElapsedOnly>…</ElapsedOnly>`, and append to the comment block directly above its `xAxis` line (the one ending `…silent about the table. */`) the paragraph, inside that same comment:

```
         *
         * ELAPSED ALWAYS, wrapped in `ElapsedOnly`: five runs have five wall
         * clocks and no single anchor, so this axis never takes the viewer's
         * Datetime mode. Gatling Enterprise's comparison does the same.
```

- [ ] **Step 6: Run to verify they pass, in both zones**

Run: `pnpm exec vitest run apps/web/test/Chart.test.tsx apps/web/test/timeAxis.test.ts apps/web/test/TimeBrush.test.tsx`
Expected: PASS, all three files.
Run: `TZ=UTC pnpm exec vitest run apps/web/test/Chart.test.tsx` — PASS.

- [ ] **Step 7: Checkpoint commit**

```bash
git add apps/web/src/charts/Chart.tsx apps/web/src/charts/PercentilesChart.tsx apps/web/src/charts/TelemetryCharts.tsx apps/web/src/charts/ErrorsChart.tsx apps/web/src/charts/RatesChart.tsx apps/web/src/charts/UsersChart.tsx apps/web/src/charts/TimeBrush.tsx apps/web/src/charts/CompareChart.tsx apps/web/test/Chart.test.tsx apps/web/test/timeAxis.test.ts apps/web/test/TimeBrush.test.tsx
git commit -F - <<'MSG'
Name and label every elapsed axis in Chart, from the viewer's time mode

An elapsed-millisecond axis now reads HH:MM:SS, or the reader's wall clock
in Datetime mode when the run has an anchor, and the axis pointer (the
tooltip's title) follows the ticks through one function. Its name follows
the mode, Elapsed or Time (GMT+5:30), taken at the run's start.

So the name can only be decided in Chart: the thirteen name: 'Elapsed (s)'
literals across seven components are gone, ChartXAxis refuses a name beside
tickUnit at compile time, and timeAxis.test.ts's pairing guard is
re-pointed to refuse a chart spelling the name itself. Compare pins elapsed
time: five runs have five wall clocks. An elapsed axis never ticks finer
than a second, which a one-bucket window would otherwise print five times.
MSG
```

- [ ] **Step 8: Red-verify**

Each mutation, then `git checkout HEAD -- <file>`:

1. The mode not a dependency: `perl -0pi -e '$n = s/    drawnXAxisName,\n    wallAnchorMs,\n//g; die "expected 1, got $n\n" unless $n == 1' apps/web/src/charts/Chart.tsx` → FAIL in "redraws when the mode changes" only.
2. The mode ignored: `perl -0pi -e '$n = s/xAxisTickUnit === \x27ms-as-s\x27 && timeAxis\.mode === \x27datetime\x27 \?/xAxisTickUnit === \x27ms-as-s\x27 ?/g; die "expected 1, got $n\n" unless $n == 1' apps/web/src/charts/Chart.tsx` → FAIL in "redraws when the mode changes" at its FIRST assertion (`Time (GMT+5:30)` before any switch).
3. No floor on the interval: `perl -0pi -e '$n = s/\n      \.\.\.\(xAxisTickUnit === \x27ms-as-s\x27 \? \{ minInterval: 1000 \} : \{\}\),//g; die "expected 1, got $n\n" unless $n == 1' apps/web/src/charts/Chart.tsx` → FAIL in "never ticks an elapsed axis finer than a second".
4. Compare follows the mode: remove the `<ElapsedOnly>` wrapper in `CompareChart.tsx` → the unit suite stays GREEN (no unit case renders `CompareChart` in a provider); record that, because it is Task 7's e2e case that must catch it.
5. A chart names its own axis again, on an axis that does not convert: `perl -0pi -e '$n = s/tickUnit: \x27ms-as-s\x27,/name: \x27Elapsed (s)\x27,/g; die "expected 1, got $n\n" unless $n == 1' apps/web/src/charts/ErrorsChart.tsx` → typecheck PASSES (the plain-name variant) and the guard FAILS naming `ErrorsChart.tsx`.
6. Both again: `perl -0pi -e '$n = s/tickUnit: \x27ms-as-s\x27,/tickUnit: \x27ms-as-s\x27, name: \x27Elapsed (s)\x27,/g; die "expected 1, got $n\n" unless $n == 1' apps/web/src/charts/ErrorsChart.tsx` → `pnpm typecheck` exits 2 with TS2322 on `ErrorsChart.tsx`.
7. The collector rots: `perl -0pi -e '$n = s/f\.endsWith\(\x27\.tsx\x27\)\);\n\n    const offenders/f.endsWith(\x27.tsxx\x27));\n\n    const offenders/g; die "expected 1, got $n\n" unless $n == 1' apps/web/test/timeAxis.test.ts` → FAIL: `expected 0 to be greater than 10`.

- [ ] **Step 9: Typecheck and lint** — `exit=0` twice. (Typecheck covers the test projects; this is the step that sees any fixture still passing `name` beside `tickUnit`.)

---

### Task 5: Every single-run page provides its anchor

**Files:**
- Modify: `apps/web/src/routes/RunShell.tsx`, `apps/web/src/routes/RequestDetail.tsx`, `apps/web/src/routes/GroupDetail.tsx`
- Test: `apps/web/test/RunShell.test.tsx`, `apps/web/test/RequestDetail.test.tsx`, `apps/web/test/GroupDetail.test.tsx`

**Interfaces:**
- Consumes: `TimeAxisProvider`, `useTimeAxis` (Task 3); `TIME_AXIS_STORAGE_KEY` (Task 3); `runQueryKey` from `apps/web/src/api/run.ts`.
- Produces: under `RunShell` (every tab and `TimeBrush`) and on both drill-downs, `useTimeAxis().anchorMs === Date.parse(run.toolStartedAt)`.

- [ ] **Step 1: Write the failing tests**

(a) `apps/web/test/RunShell.test.tsx`: add `import { useTimeAxis } from '../src/charts/TimeAxisContext';` to the imports, and append:

```tsx
/**
 * THE RUN'S CLOCK REACHES EVERY TAB. `RunShell` provides the anchor its
 * charts read wall-clock time from, off the identity it already holds, so no
 * tab reads the run a second time to learn when it started.
 */
describe('RunShell — the run’s time axis reaches every tab', () => {
  function AxisProbe() {
    return <div data-testid="axis-probe">{String(useTimeAxis().anchorMs)}</div>;
  }

  function renderWithProbe(identity: ComponentProps<typeof RunShell>['identity']) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[`/runs/${RUN.id}`]}>
          <Routes>
            <Route
              path="/runs/:runId"
              element={
                <RunShell
                  identity={identity}
                  status="complete"
                  terminal
                  verdict={RUN.verdict}
                  windowable={RUN.windowable}
                  live={null}
                  capReached={false}
                  onRetry={() => {}}
                />
              }
            >
              <Route index element={<AxisProbe />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  it('anchors every chart beneath it to the run’s own start', async () => {
    renderWithProbe(RUN);
    expect(await screen.findByTestId('axis-probe')).toHaveTextContent(
      String(Date.parse(RUN.toolStartedAt!)),
    );
  });

  it('has no anchor for a run that recorded no start', async () => {
    renderWithProbe({ ...RUN, toolStartedAt: null });
    expect(await screen.findByTestId('axis-probe')).toHaveTextContent('null');
  });
});
```

(b) `apps/web/test/RequestDetail.test.tsx`: change the testing-library import to `import { cleanup, render, screen, waitFor, within } from '@testing-library/react';`, add after the imports:

```tsx
import type { RunResponse } from '@perfportal/contracts';
import { runQueryKey } from '../src/api/run';
import { TIME_AXIS_STORAGE_KEY } from '../src/timeAxisPreference';

/* ECharts is replaced so a case can read what each chart HANDS the renderer;
   no existing case here draws a chart, so none of them notices. */
const { setOptionSpy } = vi.hoisted(() => ({ setOptionSpy: vi.fn() }));
vi.mock('../src/charts/echarts.js', () => ({
  echarts: {
    init: vi.fn(() => ({
      group: undefined as string | undefined,
      setOption: setOptionSpy,
      dispose: vi.fn(),
      resize: vi.fn(),
      on: vi.fn(),
      getOption: vi.fn(),
    })),
    connect: vi.fn(),
  },
}));

/** Pins the process zone; see `format.test.ts` for why the flip is asserted. */
async function inZone(zone: string, body: () => Promise<void>): Promise<void> {
  const original = process.env.TZ;
  try {
    process.env.TZ = zone;
    await body();
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
}

/** Every elapsed-time axis name any chart on the page handed the renderer. */
const timeAxisNames = (): string[] =>
  setOptionSpy.mock.calls
    .map(([option]) => (option as { xAxis?: { name?: string } }).xAxis?.name)
    .filter((name): name is string => name === 'Elapsed' || (name?.startsWith('Time (') ?? false));
```

and append:

```tsx
describe('RequestDetail — its charts read the viewer’s clock', () => {
  const RUN_ID = '00000000-0000-4000-8000-00000000000a';
  const RUN: RunResponse = {
    id: RUN_ID,
    project: { id: '11111111-1111-4111-8111-111111111111', slug: 'checkout', name: 'Checkout' },
    status: 'complete',
    verdict: 'not_evaluated',
    tool: 'gatling',
    toolVersion: '3.15.1',
    simulation: 'example.ParitySimulation',
    description: null,
    durationMs: 63161,
    startedAt: '2026-08-15T11:42:09.000Z',
    toolStartedAt: '2026-08-15T11:42:09.000Z',
    assertions: [],
  };

  afterEach(() => {
    localStorage.removeItem(TIME_AXIS_STORAGE_KEY);
    vi.unstubAllGlobals();
    setOptionSpy.mockReset();
  });

  /**
   * THE DRILL-DOWN IS A SIBLING OF THE RUN ROUTE, not a child of `RunShell`,
   * so the shell's provider never reaches it. Without its own, a reader who
   * chose Datetime on the run page would open a request and read elapsed
   * time with nothing saying so.
   */
  it('follows Datetime, anchored to the run’s start, like the run page', async () => {
    await inZone('Asia/Kolkata', async () => {
      expect(new Date('2026-08-15T00:00:00Z').getHours()).toBe(5);
      localStorage.setItem(TIME_AXIS_STORAGE_KEY, 'datetime');
      vi.stubGlobal('fetch', (input: RequestInfo) =>
        String(input).includes('/series')
          ? Promise.resolve(new Response(JSON.stringify(fixture.series), { status: 200 }))
          : Promise.resolve(new Response('{}', { status: 500 })),
      );
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      client.setQueryData(runQueryKey(RUN_ID), { state: 'ready', run: RUN });

      render(
        <QueryClientProvider client={client}>
          <MemoryRouter initialEntries={[`/runs/${RUN_ID}/requests/Search`]}>
            <Routes>
              <Route path="/runs/:runId/requests/:name" element={<RequestDetail />} />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>,
      );

      await waitFor(() => expect(timeAxisNames().length).toBeGreaterThan(0));
      expect(new Set(timeAxisNames())).toEqual(new Set(['Time (GMT+5:30)']));
    });
  });
});
```

(c) `apps/web/test/GroupDetail.test.tsx` (its testing-library import already carries `waitFor`): add after the imports:

```tsx
import type { RunResponse } from '@perfportal/contracts';
import { runQueryKey } from '../src/api/run';
import { TIME_AXIS_STORAGE_KEY } from '../src/timeAxisPreference';

/* ECharts is replaced so a case can read what each chart HANDS the renderer;
   no existing case here draws a chart, so none of them notices. */
const { setOptionSpy } = vi.hoisted(() => ({ setOptionSpy: vi.fn() }));
vi.mock('../src/charts/echarts.js', () => ({
  echarts: {
    init: vi.fn(() => ({
      group: undefined as string | undefined,
      setOption: setOptionSpy,
      dispose: vi.fn(),
      resize: vi.fn(),
      on: vi.fn(),
      getOption: vi.fn(),
    })),
    connect: vi.fn(),
  },
}));

/** Pins the process zone; see `format.test.ts` for why the flip is asserted. */
async function inZone(zone: string, body: () => Promise<void>): Promise<void> {
  const original = process.env.TZ;
  try {
    process.env.TZ = zone;
    await body();
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
}

/** Every elapsed-time axis name any chart on the page handed the renderer. */
const timeAxisNames = (): string[] =>
  setOptionSpy.mock.calls
    .map(([option]) => (option as { xAxis?: { name?: string } }).xAxis?.name)
    .filter((name): name is string => name === 'Elapsed' || (name?.startsWith('Time (') ?? false));
```

and append:

```tsx
describe('GroupDetail — its charts read the viewer’s clock', () => {
  const RUN_ID = '00000000-0000-4000-8000-00000000000b';
  const RUN: RunResponse = {
    id: RUN_ID,
    project: { id: '11111111-1111-4111-8111-111111111111', slug: 'checkout', name: 'Checkout' },
    status: 'complete',
    verdict: 'not_evaluated',
    tool: 'gatling',
    toolVersion: '3.15.1',
    simulation: 'example.ParitySimulation',
    description: null,
    durationMs: 63161,
    startedAt: '2026-08-15T11:42:09.000Z',
    toolStartedAt: '2026-08-15T11:42:09.000Z',
    assertions: [],
  };

  afterEach(() => {
    localStorage.removeItem(TIME_AXIS_STORAGE_KEY);
    vi.unstubAllGlobals();
    setOptionSpy.mockReset();
  });

  /** A SIBLING OF THE RUN ROUTE, like the request page; see its twin there. */
  it('follows Datetime, anchored to the run’s start, like the run page', async () => {
    await inZone('Asia/Kolkata', async () => {
      expect(new Date('2026-08-15T00:00:00Z').getHours()).toBe(5);
      localStorage.setItem(TIME_AXIS_STORAGE_KEY, 'datetime');
      vi.stubGlobal('fetch', (input: RequestInfo) =>
        String(input).includes('/series')
          ? Promise.resolve(new Response(JSON.stringify(fixture.groupSeries), { status: 200 }))
          : Promise.resolve(new Response('{}', { status: 500 })),
      );
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      client.setQueryData(runQueryKey(RUN_ID), { state: 'ready', run: RUN });

      render(
        <QueryClientProvider client={client}>
          <MemoryRouter initialEntries={[`/runs/${RUN_ID}/groups/Cart`]}>
            <Routes>
              <Route path="/runs/:runId/groups/:name" element={<GroupDetail />} />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>,
      );

      await waitFor(() => expect(timeAxisNames().length).toBeGreaterThan(0));
      expect(new Set(timeAxisNames())).toEqual(new Set(['Time (GMT+5:30)']));
    });
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm exec vitest run apps/web/test/RunShell.test.tsx apps/web/test/RequestDetail.test.tsx apps/web/test/GroupDetail.test.tsx`
Expected: FAIL — the probe reads `null` for a run with an anchor, and both drill-downs report `{'Elapsed'}` instead of `{'Time (GMT+5:30)'}`. Every pre-existing case in the three files passes.

- [ ] **Step 3: Implement**

`apps/web/src/routes/RunShell.tsx`: add `import { TimeAxisProvider } from '../charts/TimeAxisContext';` after the `TimeBrush` import, then

```bash
perl -0pi -e '$n = s/  return \(\n    <div className="flex flex-col gap-6">\n/  return (\n    \/\/ THE RUN\x27S CLOCK, for every tab and for the time window above them: the\n    \/\/ anchor comes off the identity this shell already holds, so nothing\n    \/\/ reads the run a second time to learn when it started.\n    <TimeAxisProvider anchor={identity.toolStartedAt}>\n    <div className="flex flex-col gap-6">\n/g; die "expected 1, got $n\n" unless $n == 1' apps/web/src/routes/RunShell.tsx
perl -0pi -e '$n = s/      <\/RouteErrorBoundary>\n    <\/div>\n  \);\n\}/      <\/RouteErrorBoundary>\n    <\/div>\n    <\/TimeAxisProvider>\n  );\n}/g; die "expected 1, got $n\n" unless $n == 1' apps/web/src/routes/RunShell.tsx
```

`apps/web/src/routes/RequestDetail.tsx`: add `import { TimeAxisProvider } from '../charts/TimeAxisContext';`, then

```bash
perl -0pi -e '$n = s/  return \(\n    <div className="flex flex-col gap-8">\n      <header className="flex flex-col gap-3">/  return (\n    \/\/ A SIBLING OF THE RUN ROUTE, so `RunShell`\x27s clock never reaches this\n    \/\/ page: it provides the run\x27s own, from the run it already read.\n    <TimeAxisProvider anchor={run?.toolStartedAt}>\n    <div className="flex flex-col gap-8">\n      <header className="flex flex-col gap-3">/g; die "expected 1, got $n\n" unless $n == 1' apps/web/src/routes/RequestDetail.tsx
perl -0pi -e '$n = s/        \{\(data\) => <ScatterChart scatter=\{data\} \/>\}\n      <\/Payload>\n    <\/div>\n  \);\n\}/        {(data) => <ScatterChart scatter={data} \/>}\n      <\/Payload>\n    <\/div>\n    <\/TimeAxisProvider>\n  );\n}/g; die "expected 1, got $n\n" unless $n == 1' apps/web/src/routes/RequestDetail.tsx
```

`apps/web/src/routes/GroupDetail.tsx`: add the same import, then

```bash
perl -0pi -e '$n = s/  return \(\n    <div className="flex flex-col gap-8">\n      \{\/\* Back link above the heading/  return (\n    \/\/ A SIBLING OF THE RUN ROUTE; see `RequestDetail`.\n    <TimeAxisProvider anchor={run?.toolStartedAt}>\n    <div className="flex flex-col gap-8">\n      {\/* Back link above the heading/g; die "expected 1, got $n\n" unless $n == 1' apps/web/src/routes/GroupDetail.tsx
perl -0pi -e '$n = s/        <\/Fragment>\n      \)\)\}\n    <\/div>\n  \);\n\}/        <\/Fragment>\n      ))}\n    <\/div>\n    <\/TimeAxisProvider>\n  );\n}/g; die "expected 1, got $n\n" unless $n == 1' apps/web/src/routes/GroupDetail.tsx
```

If any `perl` dies, read the file's real bytes (`sed -n '<range>p' <file> | cat -A | head`) and rebuild the anchor from them; never from a display that has been re-indented.

- [ ] **Step 4: Run to verify they pass, in both zones**

Run: `pnpm exec vitest run apps/web/test/RunShell.test.tsx apps/web/test/RequestDetail.test.tsx apps/web/test/GroupDetail.test.tsx` — PASS.
Run: `TZ=UTC pnpm exec vitest run apps/web/test/RequestDetail.test.tsx apps/web/test/GroupDetail.test.tsx` — PASS.

- [ ] **Step 5: Checkpoint commit**

```bash
git add apps/web/src/routes/RunShell.tsx apps/web/src/routes/RequestDetail.tsx apps/web/src/routes/GroupDetail.tsx apps/web/test/RunShell.test.tsx apps/web/test/RequestDetail.test.tsx apps/web/test/GroupDetail.test.tsx
git commit -F - <<'MSG'
Provide the run's clock on the run page and on both drill-downs

RunShell anchors every tab and the time window to the run's toolStartedAt,
off the identity it already holds. The request and group pages are
siblings of the run route, not children, so the shell's provider never
reached them: each provides the run's own clock from the run it already
reads, and a reader who chose Datetime keeps it on a drill-down.
MSG
```

- [ ] **Step 6: Red-verify**

Each mutation, then `git checkout HEAD -- <file>`:

1. `perl -0pi -e '$n = s/<TimeAxisProvider anchor=\{identity\.toolStartedAt\}>/<TimeAxisProvider anchor={null}>/g; die "expected 1, got $n\n" unless $n == 1' apps/web/src/routes/RunShell.tsx` → FAIL in "anchors every chart beneath it" only.
2. `perl -0pi -e '$n = s/<TimeAxisProvider anchor=\{run\?\.toolStartedAt\}>/<TimeAxisProvider anchor={null}>/g; die "expected 1, got $n\n" unless $n == 1' apps/web/src/routes/RequestDetail.tsx` → FAIL in RequestDetail's new case only (`{'Elapsed'}`).
3. The same mutation on `GroupDetail.tsx` → FAIL in GroupDetail's new case only.

- [ ] **Step 7: Typecheck and lint** — `exit=0` twice.

---

### Task 6: `TimeBrush` — range line, presets, mode, navigator header, six buttons

**Files:**
- Modify: `apps/web/src/components/icons.tsx`
- Rewrite: `apps/web/src/charts/TimeBrush.tsx`
- Modify: `apps/web/src/routes/RunShell.tsx` (one prop)
- Test: `apps/web/test/TimeBrush.test.tsx`

**Interfaces:**
- Consumes: Task 1's formatters, Task 2's `WINDOW_PRESETS`, `WINDOW_STEPS`, `canStep`, `presetWindow`, `stepWindow`, `Span`, `WindowStep`; Task 3's `useTimeAxis`, `TimeAxisProvider`, `TIME_AXIS_STORAGE_KEY`; `formatDuration`.
- Produces: `TimeBrush` gains an optional `runActivityMs?: number | null` prop. New testids: `window-range` (the range trigger), `time-axis-mode` (the select), `time-axis-no-anchor`, `window-resolution`, `window-duration`, `window-step-<step>` for each `WindowStep`. Every existing testid is kept.

- [ ] **Step 1: Add the icons**

In `apps/web/src/components/icons.tsx` add `ChevronDown,` after `Check,`, `ChevronsLeft,` and `ChevronsRight,` after `ChevronRight,`, and `ZoomIn,` and `ZoomOut,` after `Upload,` in the `lucide-react` import, then after `export const ChevronLeftIcon = icon(ChevronLeft);` add:

```ts
// The time window: its range menu and Gatling Enterprise's six navigator
// controls.
export const ChevronDownIcon = icon(ChevronDown);
export const FastBackwardIcon = icon(ChevronsLeft);
export const FastForwardIcon = icon(ChevronsRight);
export const ZoomInIcon = icon(ZoomIn);
export const ZoomOutIcon = icon(ZoomOut);
```

- [ ] **Step 2: Write the failing tests**

In `apps/web/test/TimeBrush.test.tsx`:

(a) Add to the imports:

```tsx
import { TimeAxisProvider } from '../src/charts/TimeAxisContext';
import { formatDuration } from '../src/routes/format';
import { presetWindow, stepWindow, WINDOW_PRESETS, WINDOW_STEPS } from '../src/routes/window';
import { TIME_AXIS_STORAGE_KEY } from '../src/timeAxisPreference';
```

(b) Replace `renderBrush` with:

```tsx
async function renderBrush(
  props: {
    onChange?: (next: unknown) => void;
    window?: unknown;
    applied?: unknown;
    /** Present to render under a run's clock; absent renders outside any provider. */
    anchor?: string | null;
    runDurationMs?: number;
    runActivityMs?: number | null;
  } = {},
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const brush = (
    <TimeBrush
      runId={RUN}
      runDurationMs={props.runDurationMs ?? 63_161}
      runActivityMs={props.runActivityMs}
      window={(props.window ?? null) as never}
      applied={(props.applied ?? null) as never}
      onChange={(props.onChange ?? (() => undefined)) as never}
    />
  );
  render(
    <QueryClientProvider client={client}>
      {props.anchor === undefined ? brush : <TimeAxisProvider anchor={props.anchor}>{brush}</TimeAxisProvider>}
    </QueryClientProvider>,
  );
  await waitFor(() => expect(setOptionSpy).toHaveBeenCalled());
}

/** Pins the process zone; see `format.test.ts` for why the flip is asserted. */
async function inZone(zone: string, body: () => Promise<void>): Promise<void> {
  const original = process.env.TZ;
  try {
    process.env.TZ = zone;
    await body();
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
}
```

(c) Re-point "names the applied window from the outside" to the always-visible range line:

```tsx
  /** Shut, the always-visible range line still says which stretch the numbers describe. */
  it('names the applied window from the outside', async () => {
    await renderBrush({ window: { fromMs: 10_000, toMs: 30_000 } });
    const range = screen.getByTestId('window-range');
    // No provider, so no anchor: the ends are elapsed clock time.
    expect(range).toHaveTextContent('00:00:10 → 00:00:30');
    expect(range).toHaveTextContent('20s');
    expect(screen.getByTestId('time-window-toggle').textContent ?? '').not.toMatch(/whole run/i);
  });
```

(d) Append:

```tsx
/* ====================================================================== *
 * GATLING ENTERPRISE'S TIME CONTROLS (docs/superpowers/specs/2026-09-26-…)
 * ====================================================================== */

describe('TimeBrush — Gatling Enterprise’s time controls', () => {
  // 17:12:09 in Asia/Kolkata: the start of the run Gatling was measured on.
  const ANCHOR = '2026-08-15T11:42:09.000Z';
  const WHOLE = { fromMs: 0, toMs: 63_161 };
  const RESOLUTION = fixture.series.bucketWidthMs;
  const kolkataTook = () => expect(new Date('2026-08-15T00:00:00Z').getHours()).toBe(5);

  afterEach(() => {
    localStorage.removeItem(TIME_AXIS_STORAGE_KEY);
  });

  it('states the window as a range to the second, in the reader’s zone', async () => {
    await inZone('Asia/Kolkata', async () => {
      kolkataTook();
      await renderBrush({ anchor: ANCHOR, window: { fromMs: 30_000, toMs: 90_000 }, runDurationMs: 120_000 });
      const range = screen.getByTestId('window-range');
      // Gatling's 17:12:39 → 17:13:39, in whichever hour cycle the locale uses.
      expect(range).toHaveTextContent(/:12:39/);
      expect(range).toHaveTextContent(/:13:39/);
      expect(range).toHaveTextContent('GMT+5:30');
      expect(range).toHaveTextContent('60s');
    });
  });

  it('states the snapped window once a response reports one, held to the run', async () => {
    await renderBrush({
      window: { fromMs: 10_300, toMs: 63_161 },
      applied: { fromMs: 10_000, toMs: 64_000, bucketWidthMs: 1_000 },
    });
    // The snap reached a bucket past the run's end; the line stops at it.
    expect(screen.getByTestId('window-range')).toHaveTextContent('00:00:10 → 00:01:03');
  });

  it('offers Gatling’s presets, and one longer than the run is the whole run', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    await renderBrush({ onChange, window: { fromMs: 10_000, toMs: 30_000 } });

    await user.click(screen.getByTestId('window-range'));
    const items = await screen.findAllByRole('menuitem');
    expect(items.map((item) => item.textContent)).toEqual(WINDOW_PRESETS.map((p) => p.label));

    await user.click(screen.getByRole('menuitem', { name: 'Last 5 Minutes' }));
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('measures a preset back from the end of a long run', async () => {
    const FOUR_HOURS = 4 * 3_600_000;
    const onChange = vi.fn();
    const user = userEvent.setup();
    await renderBrush({ onChange, runDurationMs: FOUR_HOURS });

    await user.click(screen.getByTestId('window-range'));
    await user.click(await screen.findByRole('menuitem', { name: 'Last 15 Minutes' }));

    expect(onChange).toHaveBeenCalledWith(presetWindow(15 * 60_000, FOUR_HOURS, RESOLUTION));
    expect(onChange.mock.calls[0]![0]).not.toBeNull();
  });

  it('names the reader’s zone in the Datetime option, taken at the run’s start', async () => {
    await inZone('Asia/Kolkata', async () => {
      kolkataTook();
      await renderBrush({ anchor: ANCHOR });
      const select = screen.getByTestId('time-axis-mode') as HTMLSelectElement;
      expect([...select.options].map((option) => option.textContent)).toEqual([
        'Offset',
        `Datetime (${Intl.DateTimeFormat().resolvedOptions().timeZone} - GMT+5:30)`,
      ]);
      expect(select.value).toBe('offset');
    });
  });

  it('switches every axis beneath it to the wall clock, and remembers', async () => {
    await inZone('Asia/Kolkata', async () => {
      kolkataTook();
      const user = userEvent.setup();
      await renderBrush({ anchor: ANCHOR });

      await user.selectOptions(screen.getByTestId('time-axis-mode'), 'datetime');

      await waitFor(() =>
        expect((lastOption()['xAxis'] as { name: string }).name).toBe('Time (GMT+5:30)'),
      );
      expect(localStorage.getItem(TIME_AXIS_STORAGE_KEY)).toBe('datetime');
    });
  });

  it('offers Datetime only to a run that recorded its start, and says why not', async () => {
    await renderBrush({ anchor: null });
    const datetime = [...(screen.getByTestId('time-axis-mode') as HTMLSelectElement).options].find(
      (option) => option.value === 'datetime',
    )!;
    expect(datetime.disabled).toBe(true);
    expect(screen.getByTestId('time-axis-no-anchor')).toBeVisible();
  });

  it('heads the navigator with its resolution and the run’s Duration', async () => {
    await renderBrush({ runActivityMs: 62_136 });
    expect(screen.getByTestId('window-resolution')).toHaveTextContent(
      `Resolution: ${formatDuration(RESOLUTION)}`,
    );
    // `activityMs`, the number the run header calls Duration, never the
    // series span, which is a second longer on this run.
    expect(screen.getByTestId('window-duration')).toHaveTextContent('Duration: 62s');
  });

  it('offers only Zoom in while the whole run is shown, each control named in Gatling’s words', async () => {
    await renderBrush();
    const live = WINDOW_STEPS.filter(
      ({ step }) => !(screen.getByTestId(`window-step-${step}`) as HTMLButtonElement).disabled,
    );
    expect(live.map(({ step }) => step)).toEqual(['zoom-in']);
    for (const { step, label } of WINDOW_STEPS) {
      expect(screen.getByTestId(`window-step-${step}`)).toHaveAccessibleName(label);
      expect(screen.getByTestId(`window-step-${step}`)).toHaveAttribute('title', label);
    }
  });

  it('commits the window a control moves to, on the navigator’s buckets', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    await renderBrush({ onChange });
    await user.click(screen.getByTestId('window-step-zoom-in'));
    expect(onChange).toHaveBeenLastCalledWith(stepWindow(WHOLE, 'zoom-in', WHOLE.toMs, RESOLUTION));
  });

  it('steps from the window in the URL, not the snapped one', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    const requested = { fromMs: 20_000, toMs: 40_000, bucketWidthMs: 0 };
    await renderBrush({
      onChange,
      window: requested,
      applied: { fromMs: 20_000, toMs: 41_000, bucketWidthMs: 1_000 },
    });
    await user.click(screen.getByTestId('window-step-forward'));
    expect(onChange).toHaveBeenLastCalledWith(stepWindow(requested, 'forward', WHOLE.toMs, RESOLUTION));
  });

  it('stops Forward at the run’s end', async () => {
    await renderBrush({ window: { fromMs: 40_000, toMs: 63_161 } });
    expect(screen.getByTestId('window-step-forward')).toBeDisabled();
    expect(screen.getByTestId('window-step-backward')).toBeEnabled();
  });

  it('offers no step until the navigator’s resolution is known', async () => {
    const fetchSpy = vi.fn(() => Promise.resolve(new Response('{}', { status: 500 })));
    vi.stubGlobal('fetch', fetchSpy);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <TimeBrush runId={RUN} runDurationMs={63_161} window={null} onChange={() => undefined} />
      </QueryClientProvider>,
    );
    // Asserted AFTER the series request has answered, with an error: still no
    // resolution, so still no step — not merely a first paint before the fetch.
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    for (const { step } of WINDOW_STEPS) {
      expect(screen.getByTestId(`window-step-${step}`)).toBeDisabled();
    }
  });
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `pnpm exec vitest run apps/web/test/TimeBrush.test.tsx`
Expected: FAIL — `Unable to find an element by: [data-testid="window-range"]` (and the other new testids) in every new case and in the re-pointed "names the applied window from the outside". Every other case passes, including the clock-time case Task 4 re-pointed.

- [ ] **Step 4: Implement**

Replace `apps/web/src/charts/TimeBrush.tsx` with:

```tsx
import { useEffect, useId, useRef, useState, type ComponentType } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Window } from '@perfportal/contracts';
import Chart from './Chart';
import { seriesQuery } from '../api/metrics';
import { RATE_ROLES, toRequestRate } from './transforms/rates';
import { useTimeAxis } from './TimeAxisContext';
import {
  formatDuration,
  formatElapsedClock,
  formatInstantSeconds,
  formatZoneName,
  formatZoneOffset,
} from '../routes/format';
import {
  WINDOW_PRESETS,
  WINDOW_STEPS,
  canStep,
  presetWindow,
  stepWindow,
  type Span,
  type WindowStep,
} from '../routes/window';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../components/ui/dropdown-menu';
import {
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  FastBackwardIcon,
  FastForwardIcon,
  ZoomInIcon,
  ZoomOutIcon,
} from '../components/icons';

/**
 * The run's time window, after Gatling Enterprise's time controls: an
 * always-visible range with presets, the Offset/Datetime mode every
 * single-run axis follows, and a timeline holding the navigator strip, its
 * six zoom and pan controls, and the exact From/To fields.
 * (docs/superpowers/specs/2026-09-26-time-window-gatling-style-design.md)
 *
 * ═══ THE STRIP ALWAYS SHOWS THE WHOLE RUN ═══
 *
 * `seriesQuery(..., null)`, never the current window. If the strip narrowed
 * with the selection, a reader would be brushing the very thing they brush
 * with: each drag would shrink the axis under the handles and there would be
 * no gesture that widens it again. The strip is the map, not the territory.
 * It also shares its cache key with the unwindowed series the rest of the
 * page may already hold, so it usually costs nothing.
 *
 * ═══ THE FIELDS ARE NOT A FALLBACK, THEY ARE THE PRECISION PATH ═══
 *
 * ECharts' dataZoom is pointer-only, and six coarse steps cannot reach an
 * exact 30 s to 90 s. Gatling has no fields; this keeps them (the spec's
 * deviation C) because they are what makes the window usable without a mouse
 * and exact with one.
 *
 * ═══ ONE DRAG IS ONE NAVIGATION ═══
 *
 * `datazoom` fires on every frame of a drag. Committing each frame would mean
 * a URL entry and six refetches per pixel; the range is held and written once
 * the drag settles. A button or a preset is one navigation too, and cancels a
 * drag still settling so the drag cannot land after it and undo it.
 */
const SETTLE_MS = 250;

const STEP_ICONS: Record<WindowStep, ComponentType<{ className?: string }>> = {
  'fast-backward': FastBackwardIcon,
  backward: ChevronLeftIcon,
  'zoom-out': ZoomOutIcon,
  'zoom-in': ZoomInIcon,
  forward: ChevronRightIcon,
  'fast-forward': FastForwardIcon,
};

/**
 * Both ends of a stretch and its width, as the range line writes them.
 *
 * ABSOLUTE WHENEVER THE RUN HAS AN ANCHOR, in either mode: Gatling
 * Enterprise's range line does not change with Offset or Datetime, which
 * relabel the AXES. Without an anchor there is no absolute time to write, so
 * the ends are elapsed clock time (deviation E).
 */
function describeSpan(span: Span, anchorMs: number | null) {
  const at = (offsetMs: number): string =>
    anchorMs === null ? formatElapsedClock(offsetMs) : formatInstantSeconds(anchorMs + offsetMs);
  return { start: at(span.fromMs), end: at(span.toMs), width: formatDuration(span.toMs - span.fromMs) };
}

export default function TimeBrush({
  runId,
  runDurationMs,
  runActivityMs,
  window,
  applied,
  onChange,
}: {
  readonly runId: string;
  readonly runDurationMs: number;
  /**
   * The span the run page labels "Duration" (`activityMs`), for the
   * navigator's own Duration. Absent, the series span stands in, the same
   * `activityMs ?? durationMs` `RunHeader` computes.
   */
  readonly runActivityMs?: number | null;
  readonly window: Window | null;
  /** The snapped window a response reported, when one has arrived. */
  readonly applied?: Window | null;
  readonly onChange: (next: Window | null) => void;
}) {
  const fromId = useId();
  const toId = useId();
  const errorId = useId();
  const { mode, anchorMs, setMode } = useTimeAxis();

  /** Set when `apply` refuses; cleared by a valid apply, and by any change to
   *  the selection itself so a stale complaint never outlives its input. */
  const [rangeError, setRangeError] = useState<string | null>(null);

  /* Open when the run is already narrowed, closed when it is not. The EFFECT
     keeps that true after the first render: the shell does not remount
     between tabs, so a window arriving from a URL would otherwise leave an
     active narrowing behind a closed timeline. It never closes the timeline
     on its own; that is the reader's to do. */
  const [open, setOpen] = useState(() => window !== null);
  useEffect(() => {
    if (window !== null) setOpen(true);
  }, [window]);

  // THE WHOLE RUN, deliberately unwindowed; see the docstring.
  const series = useQuery(seriesQuery(runId, 'run', '', 'response_time', null));

  /** The navigator's resolution: the width of the buckets it draws. Until they
   *  arrive it is unknown, and so is every step. */
  const resolutionMs = series.data?.bucketWidthMs ?? null;

  /**
   * WHERE A STEP STARTS: the window in the URL, or the whole run.
   *
   * NOT the snapped `applied` window the range line states. Its end is
   * `min(ceil(to / width) × width, last bucket + width)`, which can land a
   * bucket short of the run's end or past it, so every "at the end" decision
   * (is Forward live, where does a pan slide to) would be wrong by that
   * bucket.
   */
  const current: Span = window ?? { fromMs: 0, toMs: runDurationMs };

  /**
   * WHAT THE NUMBERS DESCRIBE: the snapped window once a response reports it,
   * the requested one until then, the whole run when neither, held to the
   * run itself because the snap can reach a bucket past its end. A window's
   * header states the range the numbers were computed over, never the one
   * that was dragged (`WindowSchema.bucketWidthMs`).
   */
  const shownWindow = applied ?? window;
  const range = describeSpan(
    {
      fromMs: Math.max(0, shownWindow?.fromMs ?? 0),
      toMs: Math.min(runDurationMs, shownWindow?.toMs ?? runDurationMs),
    },
    anchorMs,
  );
  const zoneLabel = anchorMs === null ? null : `${formatZoneName()} - ${formatZoneOffset(anchorMs)}`;

  const asSeconds = (ms: number): string => String(Math.round(ms / 1000));
  const [from, setFrom] = useState(() => (window ? asSeconds(window.fromMs) : ''));
  const [to, setTo] = useState(() => (window ? asSeconds(window.toMs) : ''));

  // The URL is the source of truth, so a back button or a pasted link moves the
  // fields rather than leaving them describing a window no longer selected.
  useEffect(() => {
    setFrom(window ? asSeconds(window.fromMs) : '');
    setTo(window ? asSeconds(window.toMs) : '');
    setRangeError(null);
  }, [window]);

  const settle = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (settle.current !== null) clearTimeout(settle.current);
  }, []);
  const cancelSettle = (): void => {
    if (settle.current !== null) clearTimeout(settle.current);
    settle.current = null;
  };

  const commit = (fromMs: number, toMs: number): void => {
    cancelSettle();
    settle.current = setTimeout(() => {
      // A drag covering the whole extent is a request for the whole run, not a
      // window that happens to match it, so the URL loses its parameters
      // rather than pinning a range that would then not follow a re-ingest.
      if (fromMs <= 0 && toMs >= runDurationMs) onChange(null);
      else onChange({ fromMs, toMs: Math.min(toMs, runDurationMs), bucketWidthMs: 0 });
    }, SETTLE_MS);
  };

  const step = (which: WindowStep): void => {
    if (resolutionMs === null) return;
    cancelSettle();
    onChange(stepWindow(current, which, runDurationMs, resolutionMs));
  };

  const choosePreset = (spanMs: number | null): void => {
    if (spanMs === null) {
      cancelSettle();
      onChange(null);
    } else if (resolutionMs !== null) {
      cancelSettle();
      onChange(presetWindow(spanMs, runDurationMs, resolutionMs));
    }
  };

  const apply = (): void => {
    const parse = (raw: string, fallback: number): number | null => {
      if (raw.trim() === '') return fallback;
      const n = Number(raw);
      return Number.isFinite(n) && n >= 0 ? Math.round(n * 1000) : null;
    };
    const fromMs = parse(from, 0);
    const toMs = parse(to, runDurationMs);

    /* ═══ AN INVALID RANGE IS REFUSED, NEVER WIDENED ═══
     *
     * This used to answer every unparseable, negative or reversed input with
     * `onChange(null)`, which is not a neutral failure: it is the signal for
     * "the whole run". So a reader who typed From=30 To=10 got a SILENTLY
     * BROADER scope than the one they already had. Refusing leaves the
     * previous window standing, and `window` not changing keeps the reader's
     * typing in place so the mistake can be corrected. Widening on purpose is
     * still one click away: "Whole run", and the Everything preset. */
    if (fromMs === null || toMs === null) {
      setRangeError('Enter the window as seconds — for example 10 and 30.');
      return;
    }
    if (fromMs >= toMs) {
      setRangeError('End must be later than start.');
      return;
    }

    setRangeError(null);
    onChange({ fromMs, toMs: Math.min(toMs, runDurationMs), bucketWidthMs: 0 });
  };

  // Requests/s: the densest, most continuous view of a run's shape, which is
  // what a reader is aiming at when they drag.
  //
  // `{ x: 'ms' }` IS LOAD-BEARING, not a formatting choice. The slider reports
  // its handles in the x axis' own units and `commit` writes those straight to
  // the URL as milliseconds; the category form's scalars made those units
  // RATES, and a drag across the first third of this run committed
  // `?from=0&to=7`.
  const rates = series.data ? toRequestRate(series.data, { x: 'ms' }) : null;

  return (
    <section
      aria-label="Time window"
      data-testid="time-brush"
      className="rounded border border-default bg-surface"
    >
      {/* ═══ ALWAYS VISIBLE: WHICH STRETCH, AND WHICH CLOCK ═══
       *
       * The range line states the window from outside the timeline, so a
       * closed timeline never hides an active narrowing (review M01's safety
       * property), and it opens Gatling's presets. The mode beside it relabels
       * every single-run time axis; it is a reading preference and never
       * enters the URL. Neither sits inside the `<summary>` below, whose
       * descendants are presentational in the accessibility tree. */}
      <div className="flex flex-wrap items-center gap-2 p-3">
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              data-testid="window-range"
              aria-label={`Time range ${range.start} to ${range.end}, ${range.width}. Choose a preset`}
              className="transition-ui inline-flex max-w-full items-center gap-2 rounded border border-default bg-surface px-2 py-1 text-left text-[0.75rem] text-primary hover:bg-sunken data-[state=open]:bg-sunken"
            >
              <span className="min-w-0">
                {range.start} → {range.end}
              </span>
              <span aria-hidden="true" className="h-4 w-px shrink-0 bg-default" />
              <span className="shrink-0 tabular-nums">{range.width}</span>
              <ChevronDownIcon className="h-3.5 w-3.5 shrink-0" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-[12rem]">
            {WINDOW_PRESETS.map((preset) => (
              <DropdownMenuItem
                key={preset.label}
                disabled={preset.spanMs !== null && resolutionMs === null}
                onSelect={() => choosePreset(preset.spanMs)}
              >
                {preset.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <select
          data-testid="time-axis-mode"
          aria-label="Time axis"
          // A run with no anchor reads elapsed whatever was chosen, so the
          // control says so rather than showing a choice it cannot honour.
          value={anchorMs === null ? 'offset' : mode}
          onChange={(event) => setMode(event.target.value === 'datetime' ? 'datetime' : 'offset')}
          className="rounded border border-default bg-surface px-2 py-1 text-sm text-primary"
        >
          <option value="offset">Offset</option>
          <option value="datetime" disabled={anchorMs === null}>
            {zoneLabel === null ? 'Datetime' : `Datetime (${zoneLabel})`}
          </option>
        </select>

        {anchorMs === null && (
          <p data-testid="time-axis-no-anchor" className="text-[0.75rem] text-muted">
            Datetime needs the time this run started, which it did not record.
          </p>
        )}
      </div>

      <details
        open={open}
        onToggle={(event) => setOpen(event.currentTarget.open)}
        className="group"
      >
        <summary
          data-testid="time-window-toggle"
          className="flex cursor-pointer list-none items-center gap-2 px-3 pb-3 text-[0.75rem] font-medium text-accent hover:underline hover:underline-offset-2"
        >
          <span className="group-open:hidden">Timeline</span>
          <span className="hidden group-open:inline">Hide timeline</span>
          {/* "Whole run" stays load-bearing (review M01): it tells a reader the
              numbers below are the run's own before they open anything. */}
          {window === null && <span className="font-normal text-muted">· whole run</span>}
        </summary>

        <div className="flex flex-col gap-3 p-3 pt-0">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="flex gap-4 text-[0.75rem] text-muted">
              <span data-testid="window-resolution">
                Resolution: {resolutionMs === null ? '—' : formatDuration(resolutionMs)}
              </span>
              <span data-testid="window-duration">
                Duration: {formatDuration(runActivityMs ?? runDurationMs)}
              </span>
            </p>
            <div role="group" aria-label="Move the window" className="flex gap-1">
              {WINDOW_STEPS.map(({ step: which, label }) => {
                const Icon = STEP_ICONS[which];
                return (
                  <button
                    key={which}
                    type="button"
                    data-testid={`window-step-${which}`}
                    aria-label={label}
                    title={label}
                    disabled={
                      resolutionMs === null || !canStep(current, which, runDurationMs, resolutionMs)
                    }
                    onClick={() => step(which)}
                    className="transition-ui inline-flex h-7 w-7 items-center justify-center rounded border border-default bg-surface text-primary hover:bg-sunken disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <Icon className="h-4 w-4" />
                  </button>
                );
              })}
            </div>
          </div>

          {rates !== null && (
            <Chart
              id="time-window"
              // NAMES THE MEASURE, not the control; "whole run" because the
              // strip never narrows with the selection (see the docstring).
              title="Requests per second, whole run"
              // A NAVIGATOR, NOT A FIGURE: axes kept so a reader can see where
              // they are dragging, the legend dropped because the chart below
              // names the same All/OK/KO.
              navigator
              data={rates}
              kind="line"
              // The app-wide status colours; without them the strip drew
              // All/OK/KO in the categorical palette, disagreeing with
              // `RatesChart` directly below.
              roles={RATE_ROLES}
              // A VALUE AXIS in elapsed milliseconds, which is what the slider
              // reports and the URL speaks. `Chart` labels it as clock time and
              // names it from the time mode.
              xAxis={{ type: 'value', tickUnit: 'ms-as-s' }}
              unit="/s"
              brush={{
                value: window,
                onChange: commit,
              }}
            />
          )}

          <div className="flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-1">
              <label htmlFor={fromId} className="text-[0.75rem] text-muted">
                From (s)
              </label>
              <input
                id={fromId}
                data-testid="window-from"
                inputMode="numeric"
                aria-invalid={rangeError === null ? undefined : true}
                aria-describedby={rangeError === null ? undefined : errorId}
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                placeholder="0"
                className="w-24 rounded border border-default bg-surface px-2 py-1 text-sm text-primary"
              />
            </div>

            <div className="flex flex-col gap-1">
              <label htmlFor={toId} className="text-[0.75rem] text-muted">
                To (s)
              </label>
              <input
                id={toId}
                data-testid="window-to"
                inputMode="numeric"
                aria-invalid={rangeError === null ? undefined : true}
                aria-describedby={rangeError === null ? undefined : errorId}
                value={to}
                onChange={(e) => setTo(e.target.value)}
                placeholder={asSeconds(runDurationMs)}
                className="w-24 rounded border border-default bg-surface px-2 py-1 text-sm text-primary"
              />
            </div>

            <button
              type="button"
              onClick={apply}
              data-testid="window-apply"
              className="rounded border border-default bg-surface px-3 py-1 text-sm text-primary"
            >
              Apply window
            </button>

            {window !== null && (
              <button
                type="button"
                onClick={() => {
                  cancelSettle();
                  onChange(null);
                }}
                data-testid="window-clear"
                className="rounded border border-default bg-surface px-3 py-1 text-sm text-primary"
              >
                Whole run
              </button>
            )}

            {/* `role="alert"`: a response to the reader's own action, and the
                figures deliberately do NOT move to signal it. Rendered only
                when there is something to say, so this never contributes an
                empty live region to a page that already mounts several. */}
            {rangeError !== null && (
              <p
                id={errorId}
                role="alert"
                data-testid="window-error"
                className="w-full text-[0.75rem]"
                /* `var()`, not a `text-status-failed` utility: the status
                   tokens are declared on `:root` rather than inside
                   `@theme inline`, so that spelling emits nothing at all. */
                style={{ color: 'var(--color-status-failed)' }}
              >
                {rangeError}
              </p>
            )}

            {/* THE SNAPPED RANGE, announced: `role="status"` so a screen
                reader is told the figures now describe a different stretch,
                in the same words the range line above uses. */}
            {applied != null && (
              <p role="status" data-testid="window-applied" className="text-[0.75rem] text-muted">
                Showing {range.start} → {range.end}, snapped to{' '}
                {formatDuration(applied.bucketWidthMs)} buckets
              </p>
            )}
          </div>
        </div>
      </details>
    </section>
  );
}
```

In `apps/web/src/routes/RunShell.tsx`, add `runActivityMs={identity.activityMs}` to the `<TimeBrush …>` element, directly after `runDurationMs={identity.durationMs}`.

- [ ] **Step 5: Run to verify they pass, in both zones**

Run: `pnpm exec vitest run apps/web/test/TimeBrush.test.tsx apps/web/test/RunShell.test.tsx` — PASS.
Run: `TZ=UTC pnpm exec vitest run apps/web/test/TimeBrush.test.tsx` — PASS.

- [ ] **Step 6: Checkpoint commit**

```bash
git add apps/web/src/components/icons.tsx apps/web/src/charts/TimeBrush.tsx apps/web/src/routes/RunShell.tsx apps/web/test/TimeBrush.test.tsx
git commit -F - <<'MSG'
Give the time window Gatling Enterprise's range, presets, mode and steps

Always visible: the window as an absolute range to the second in the
reader's zone, opening Gatling's six presets, and the Offset/Datetime mode
that relabels every single-run axis. In the timeline: a header stating the
navigator's resolution and the run's Duration, and Fast backward, Backward,
Zoom out, Zoom in, Forward and Fast forward, each disabled at its limit.
The strip and the From/To fields stay.

A step starts from the window in the URL, not the snapped one, whose end
can fall a bucket short of the run's end or past it. The range line still
states the snapped window, held to the run.
MSG
```

- [ ] **Step 7: Red-verify**

Each mutation, then `git checkout HEAD -- <file>`:

1. Steps from the snap: `perl -0pi -e '$n = s/const current: Span = window \?\?/const current: Span = applied ?? window ??/g; die "expected 1, got $n\n" unless $n == 1' apps/web/src/charts/TimeBrush.tsx` → FAIL in "steps from the window in the URL, not the snapped one" only.
2. Duration from the series span: `perl -0pi -e '$n = s/formatDuration\(runActivityMs \?\? runDurationMs\)/formatDuration(runDurationMs)/g; die "expected 1, got $n\n" unless $n == 1' apps/web/src/charts/TimeBrush.tsx` → FAIL in "heads the navigator" (`Duration: 63s`).
3. The snap not held to the run: `perl -0pi -e '$n = s/toMs: Math\.min\(runDurationMs, shownWindow\?\.toMs \?\? runDurationMs\)/toMs: shownWindow?.toMs ?? runDurationMs/g; die "expected 1, got $n\n" unless $n == 1' apps/web/src/charts/TimeBrush.tsx` → FAIL in "held to the run" (`00:01:04`).
4. The mode not written: `perl -0pi -e '$n = s/onChange=\{\(event\) => setMode\(/onChange={(event) => void (/g; die "expected 1, got $n\n" unless $n == 1' apps/web/src/charts/TimeBrush.tsx` → FAIL in "switches every axis beneath it".
5. Datetime offered without an anchor: `perl -0pi -e '$n = s/<option value="datetime" disabled=\{anchorMs === null\}>/<option value="datetime">/g; die "expected 1, got $n\n" unless $n == 1' apps/web/src/charts/TimeBrush.tsx` → FAIL in "offers Datetime only to a run that recorded its start".
6. Steps live without a resolution: `perl -0pi -e '$n = s/resolutionMs === null \|\| !canStep/resolutionMs !== null \&\& !canStep/g; die "expected 1, got $n\n" unless $n == 1' apps/web/src/charts/TimeBrush.tsx` → FAIL in "offers no step until the navigator’s resolution is known".

- [ ] **Step 8: Typecheck and lint** — `exit=0` twice.

---

### Task 7: The seams, in a browser

**Files:**
- Create: `apps/web/e2e/time-window.spec.ts`
- Modify: `apps/web/e2e/run-tables.spec.ts` (the M01 history), `apps/web/e2e/helpers.ts` (`openTimeWindow`'s docstring), `apps/web/test/TimeBrush.test.tsx` (the M01 docstring's number)

**Interfaces:**
- Consumes: testids from Task 6; `seedAdmin`, `seedRunWithData` (`apps/web/e2e/fixtures.ts`); `apiJson`, `openTimeWindow`, `plot`, `signIn` (`apps/web/e2e/helpers.ts`); `runChartsPath`, `runComparePath` (`apps/web/src/routes/paths.ts`).

- [ ] **Step 1: Bring up an isolated stack**

The developer database holds nine real Gatling runs and `pnpm test:e2e` seeds through the real API without truncating, so everything runs against a scratch database and a scratch Redis index:

```bash
source ~/.nvm/nvm.sh && nvm use
docker exec infra-postgres-1 psql -U perfportal -d perfportal -c 'DROP DATABASE IF EXISTS perfportal_tw' -c 'CREATE DATABASE perfportal_tw'
export DATABASE_URL=postgresql://perfportal:perfportal@localhost:5433/perfportal_tw
export REDIS_URL=redis://localhost:6380/10
export S3_ENDPOINT=http://localhost:9000 S3_ACCESS_KEY=perfportal S3_SECRET_KEY=perfportal123
docker exec infra-redis-1 redis-cli -n 10 FLUSHDB
pnpm --filter @perfportal/persistence run migrate:deploy
lsof -nP -iTCP:3000 -sTCP:LISTEN   # if anything holds 3000, export PERFPORTAL_E2E_PORT=3100
```

- [ ] **Step 2: Write the spec**

Create `apps/web/e2e/time-window.spec.ts`:

```ts
import { expect, test, type Page } from '@playwright/test';
import { seedAdmin, seedRunWithData } from './fixtures.js';
import { apiJson, openTimeWindow, plot, signIn } from './helpers.js';
import { runChartsPath, runComparePath } from '../src/routes/paths.js';

/**
 * ═══ GATLING ENTERPRISE'S TIME CONTROLS, IN A BROWSER ═══
 * (docs/superpowers/specs/2026-09-26-time-window-gatling-style-design.md)
 *
 * The unit layer hands each component its anchor and its payload; these cases
 * prove the seams no fixture can: a real run's `toolStartedAt` reaching the
 * axes, the mode surviving a reload without entering the URL, a drill-down
 * reached by URL reading the same clock, and Compare refusing it.
 *
 * PINNED TO Asia/Kolkata, a non-zero and DST-free offset: CI runs in UTC,
 * where an anchor read in the wrong zone is invisible. Every case asserts the
 * pin took before anything else.
 */
test.use({ timezoneId: 'Asia/Kolkata' });

const CLOCK = /^\d{2}:\d{2}:\d{2}$/;

/** Every string a chart's canvas drew, in document order. */
async function drawnText(page: Page, testId: string): Promise<string[]> {
  return plot(page.getByTestId(testId)).locator('text').allTextContents();
}

/** The HH:MM:SS labels, which on these charts are the x axis' ticks alone. */
async function clockTicks(page: Page, testId: string): Promise<string[]> {
  return (await drawnText(page, testId)).filter((text) => CLOCK.test(text));
}

async function zonePinned(page: Page): Promise<void> {
  expect(await page.evaluate(() => new Date('2026-08-15T00:00:00Z').getHours())).toBe(5);
}

/** HH:MM:SS on Asia/Kolkata's clock, computed here rather than by the page. */
const kolkataClock = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Kolkata',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});
const clockMs = (clock: string): number => {
  const [h, m, s] = clock.split(':').map(Number);
  return ((h! * 60 + m!) * 60 + s!) * 1000;
};

test('Datetime relabels the charts to the wall clock, survives a reload, and never touches the URL', async ({ page }) => {
  const admin = await seedAdmin();
  const runId = await seedRunWithData(admin.orgId);
  await signIn(page, admin);
  await page.goto(runChartsPath(runId));
  await zonePinned(page);

  const run = await apiJson<{ toolStartedAt: string }>(page, `/v1/runs/${runId}`);
  const anchorMs = Date.parse(run.toolStartedAt);

  // Offset, the default: elapsed clock time under an axis named Elapsed.
  await expect.poll(() => drawnText(page, 'chart-percentiles')).toContain('Elapsed');
  const elapsed = await clockTicks(page, 'chart-percentiles');
  expect(elapsed.length).toBeGreaterThanOrEqual(2);

  const url = page.url();
  const zone = await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  const mode = page.getByTestId('time-axis-mode');
  await expect(mode.locator('option[value="datetime"]')).toHaveText(`Datetime (${zone} - GMT+5:30)`);
  await mode.selectOption('datetime');

  // The SAME ticks, relabelled: each is the run's own start plus its offset.
  // Polled, because the redraw replaces the labels rather than editing them.
  await expect.poll(() => drawnText(page, 'chart-percentiles')).toContain('Time (GMT+5:30)');
  await expect
    .poll(() => clockTicks(page, 'chart-percentiles'))
    .toEqual(elapsed.map((tick) => kolkataClock.format(anchorMs + clockMs(tick))));
  expect(page.url()).toBe(url);

  // A reading preference survives a reload and still never reaches the URL.
  await page.reload();
  await expect(mode).toHaveValue('datetime');
  await expect.poll(() => drawnText(page, 'chart-percentiles')).toContain('Time (GMT+5:30)');
  expect(page.url()).toBe(url);
});

test('the zoom buttons step by Gatling’s fractions, and zooming out returns to the whole run', async ({ page }) => {
  const admin = await seedAdmin();
  const runId = await seedRunWithData(admin.orgId);
  await signIn(page, admin);
  await page.goto(runChartsPath(runId));
  await openTimeWindow(page);

  // An independent oracle: the spec asks the API, never the app's own builder.
  const run = await apiJson<{ durationMs: number }>(page, `/v1/runs/${runId}`);
  const series = await apiJson<{ bucketWidthMs: number }>(
    page,
    `/v1/runs/${runId}/series?scope=run&name=&family=response_time`,
  );
  const span = run.durationMs;
  const resolution = series.bucketWidthMs;

  const zoomIn = page.getByTestId('window-step-zoom-in');
  const zoomOut = page.getByTestId('window-step-zoom-out');
  await expect(zoomOut).toBeDisabled();
  await zoomIn.click();

  await expect(page).toHaveURL(/[?&]from=\d+/);
  const params = new URL(page.url()).searchParams;
  const from = Number(params.get('from'));
  const to = Number(params.get('to'));
  // A quarter in from each edge, each bound on the navigator's buckets.
  expect(from % resolution).toBe(0);
  expect(to % resolution).toBe(0);
  expect(Math.abs(from - span / 4)).toBeLessThanOrEqual(resolution / 2);
  expect(Math.abs(to - (span * 3) / 4)).toBeLessThanOrEqual(resolution / 2);

  // Zoom out grows the width by HALF, not double: once is still a window…
  await zoomOut.click();
  await expect(page).toHaveURL(new RegExp(`[?&]from=(?!${from}(?!\\d))\\d+`));
  // …and the second reaches both ends, which is no window at all.
  await zoomOut.click();
  await expect(page).not.toHaveURL(/[?&]from=/);
  await expect(zoomOut).toBeDisabled();
});

test('a preset longer than the run returns it to the whole run', async ({ page }) => {
  const admin = await seedAdmin();
  const runId = await seedRunWithData(admin.orgId);
  await signIn(page, admin);
  await page.goto(runChartsPath(runId));
  await openTimeWindow(page);

  const run = await apiJson<{ durationMs: number }>(page, `/v1/runs/${runId}`);
  // The claim needs a run shorter than the preset; say so rather than assume it.
  expect(run.durationMs).toBeLessThan(5 * 60_000);

  await page.getByTestId('window-step-zoom-in').click();
  await expect(page).toHaveURL(/[?&]from=/);

  await page.getByTestId('window-range').click();
  await page.getByRole('menuitem', { name: 'Last 5 Minutes', exact: true }).click();
  await expect(page).not.toHaveURL(/[?&]from=/);
});

test('a request’s own page reads the clock the reader chose', async ({ page }) => {
  const admin = await seedAdmin();
  const runId = await seedRunWithData(admin.orgId);
  await signIn(page, admin);
  await page.goto(runChartsPath(runId));
  await zonePinned(page);
  await page.getByTestId('time-axis-mode').selectOption('datetime');
  await expect.poll(() => drawnText(page, 'chart-percentiles')).toContain('Time (GMT+5:30)');

  const stats = await apiJson<{ stats: { scope: string; name: string }[] }>(page, `/v1/runs/${runId}/stats`);
  const request = stats.stats.find((row) => row.scope === 'request');
  expect(request, 'the seeded run carries no request rows').toBeDefined();

  // A SIBLING of the run route: RunShell's clock cannot reach it.
  await page.goto(`/runs/${runId}/requests/${encodeURIComponent(request!.name)}`);
  await zonePinned(page);
  await expect.poll(() => drawnText(page, 'chart-percentiles')).toContain('Time (GMT+5:30)');
});

test('Compare stays elapsed while the reader reads wall-clock time elsewhere', async ({ page }) => {
  const admin = await seedAdmin();
  await seedRunWithData(admin.orgId);
  const runId = await seedRunWithData(admin.orgId);
  await signIn(page, admin);
  await page.goto(runChartsPath(runId));
  await zonePinned(page);
  await page.getByTestId('time-axis-mode').selectOption('datetime');
  // A positive control: the mode really took on this page.
  await expect.poll(() => drawnText(page, 'chart-percentiles')).toContain('Time (GMT+5:30)');

  await page.goto(runComparePath(runId));
  await expect.poll(() => drawnText(page, 'chart-compare-overlay')).toContain('Elapsed');
  expect((await drawnText(page, 'chart-compare-overlay')).some((text) => text.startsWith('Time ('))).toBe(false);
});
```

- [ ] **Step 3: Run the new spec**

Run: `pnpm exec playwright test apps/web/e2e/time-window.spec.ts --workers=2`
Expected: `5 passed`. Read the runner's own `Running 5 tests using 2 workers` line back.

- [ ] **Step 4: Red-verify the seams (checkpoint first)**

Commit a checkpoint of the spec (`git add apps/web/e2e/time-window.spec.ts` then a `git commit -F -` with "Checkpoint: time window e2e"), then each mutation, re-running only the named case with `-g`, then `git checkout HEAD -- <file>`:

1. `CompareChart` without `ElapsedOnly` (the mutation Task 4 recorded as invisible to the unit suite): delete the `<ElapsedOnly>` and `</ElapsedOnly>` lines → "Compare stays elapsed" FAILS.
2. `RequestDetail` without its provider: `perl -0pi -e '$n = s/<TimeAxisProvider anchor=\{run\?\.toolStartedAt\}>/<TimeAxisProvider anchor={null}>/g; die "expected 1, got $n\n" unless $n == 1' apps/web/src/routes/RequestDetail.tsx` → "a request’s own page" FAILS.
3. Zoom out doubles the width: `perl -0pi -e '$n = s/snap\(from - width \/ 4\), snap\(to \+ width \/ 4\)/snap(from - width \/ 2), snap(to + width \/ 2)/g; die "expected 1, got $n\n" unless $n == 1' apps/web/src/routes/window.ts` → "the zoom buttons step" FAILS at the first zoom out (the URL clears one click early).
4. The anchor read in UTC: `perl -0pi -e '$n = s/at\.getHours\(\)/at.getUTCHours()/g; die "expected 1, got $n\n" unless $n == 1' apps/web/src/routes/format.ts` → the relabel case FAILS on the tick list, every tick 5:30 out. On a UTC machine this mutation would pass: the pin is what makes it visible.

Playwright's `webServer` runs `pnpm build` before every invocation, so each mutation does reach the bundle. Still check it did before believing a result, because a green build command is not evidence the output changed: for mutation 4, `grep -l getUTCHours apps/web/dist/assets/*.js` must name a file.

- [ ] **Step 5: Re-measure M01's fold, and record it**

Playwright collects only `apps/web/e2e`, so the throwaway measurement lives there for one run and is deleted before anything is staged. Create `apps/web/e2e/zz-measure.spec.ts`:

```ts
import { test } from '@playwright/test';
import { seedAdmin, seedRunWithData } from './fixtures.js';
import { signIn } from './helpers.js';
import { runPath } from '../src/routes/paths.js';

test.use({ viewport: { width: 1440, height: 900 } });

test('measure', async ({ page }) => {
  const admin = await seedAdmin();
  const runId = await seedRunWithData(admin.orgId);
  await signIn(page, admin);
  await page.goto(runPath(runId));
  const totals = page.locator('section[aria-label="Run totals"]');
  await totals.waitFor();
  const top = await totals.evaluate((el) => el.getBoundingClientRect().top);
  const brush = await page.getByTestId('time-brush').evaluate((el) => el.getBoundingClientRect().height);
  console.log(`MEASURED totalsTop=${top} timeWindowHeight=${brush}`);
});
```

Run: `pnpm exec playwright test apps/web/e2e/zz-measure.spec.ts --reporter=list`, read the `MEASURED` line, then `rm apps/web/e2e/zz-measure.spec.ts`. The top must be below 900; if it is not, stop and report rather than moving the bound.

Record the two numbers:
- `apps/web/e2e/run-tables.spec.ts`: after the line `   *      649  after M01 collapsed the time window (332px -> 44px)` add `   *      ⟨top⟩  after the window's range line and mode became always visible (44px -> ⟨height⟩px)`, with the measured values.
- `apps/web/e2e/helpers.ts` (`openTimeWindow`'s docstring): replace `It is 44px closed, and it OPENS ITSELF whenever` with `It is ⟨height⟩px closed (its range line and mode stay visible), and it OPENS ITSELF whenever`, and reflow the paragraph.
- `apps/web/test/TimeBrush.test.tsx`: replace `Closed it is 44px and the totals\n   * begin at y649.` with `Closed it is ⟨height⟩px, range line and mode included, and the totals\n   * begin at y⟨top⟩.`

- [ ] **Step 6: Commit**

```bash
git add apps/web/e2e/time-window.spec.ts apps/web/e2e/run-tables.spec.ts apps/web/e2e/helpers.ts apps/web/test/TimeBrush.test.tsx
git commit -F - <<'MSG'
Prove the time window's seams in a browser

Datetime relabels the Charts tab's ticks to the run's own start plus each
offset, survives a reload and never enters the URL; zoom in lands a quarter
in from each edge on the navigator's buckets and two zoom outs return to
the whole run; a preset longer than the run clears the window; a request
drill-down, a sibling of the run route, reads the same clock; Compare stays
elapsed. Pinned to Asia/Kolkata, since an anchor read in the wrong zone is
invisible on a UTC runner. M01's fold re-measured and recorded.
MSG
```

`git log --oneline origin/main..HEAD` must show the spec commit, this plan's commit and this task's commits only.

---

### Task 8: Gates, floors, CLAUDE.md, PR

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Confirm nothing else is using the stack**

```bash
ps -axo args | grep -E '[v]itest|[v]ite build|[p]laywright|perf-dashboard.*[d]ist/main\.js' | grep -v '@playwright/mcp'
docker exec infra-redis-1 redis-cli -n 10 LLEN bull:ingest:wait
uptime; vm_stat | head -2; sysctl vm.swapusage
```

Expected: no suite or stray API/worker process (the `@playwright/mcp` servers are unrelated and excluded), queue depth 0, 1-minute load below 8 and 5-minute below 10, free pages well above 4,390. If the load gate is not met, WAIT; do not start behind an expired gate.

- [ ] **Step 2: The five gates, each by its own exit code, integration before e2e**

With Step 1 of Task 7's scratch exports still in the shell (re-create `perfportal_tw` and flush db 10 first):

```bash
pnpm typecheck > "$SCRATCH/g-tc.txt" 2>&1; echo "typecheck exit=$?"
pnpm lint > "$SCRATCH/g-lint.txt" 2>&1; echo "lint exit=$?"
pnpm test:unit > "$SCRATCH/g-unit.txt" 2>&1; echo "unit exit=$?"; tail -6 "$SCRATCH/g-unit.txt"
pnpm test:integration > "$SCRATCH/g-int.txt" 2>&1; echo "integration exit=$?"; tail -6 "$SCRATCH/g-int.txt"
pnpm test:e2e > "$SCRATCH/g-e2e.txt" 2>&1; echo "e2e exit=$?"; tail -4 "$SCRATCH/g-e2e.txt"
```

Expected: five `exit=0`; the unit total is 163 + 2 = **165 files** and 2036 plus this branch's cases, with no `Errors` line; integration is **148 files** (one new `.ts` file) and 1856 plus the cases added to `.ts` files; e2e is **155**. Compute each prediction by counting the cases this branch added (`git diff origin/main --stat` plus `grep -c "^\s*it("` per touched test file) BEFORE reading the totals, and chase any difference in either direction. Then `TZ=UTC pnpm test:unit > "$SCRATCH/g-unit-utc.txt" 2>&1; echo "unit-utc exit=$?"` — the whole unit suite on CI's zone.

- [ ] **Step 3: Write the CLAUDE.md entry**

Insert a new entry directly after the paragraph that begins `**AND ITS e2e IS THE FIRST THAT RUNS ON THREE ENGINES.**` (before `The live-duration-is-activity-span branch added…`), and replace the headline floor `**151 files / 1855 tests**` a few lines above it with the measured unit floor. Fill each ⟨…⟩ with the number Step 2 measured:

```
The time-window-gatling-style branch added TWO unit files —
`apps/web/test/timeAxisPreference.test.ts` (4) and
`apps/web/test/TimeAxisContext.test.tsx` (6) — and cases across `format`,
`window`, `Chart`, `TimeBrush`, `RunShell`, `RequestDetail` and `GroupDetail`,
from **163 / 2036 to ⟨unit files⟩ / ⟨unit tests⟩**. Integration moves with the
`.ts` files at **⟨int files⟩ / ⟨int tests⟩**, and **e2e rises to ⟨e2e⟩**
(`apps/web/e2e/time-window.spec.ts`). It is backlog item #1 of the Gatling
Enterprise comparison: that product's time controls, copied from measurements
of its behaviour rather than from screenshots.

**EVERY STEP WAS MEASURED ON GATLING ENTERPRISE BEFORE IT WAS WRITTEN.** Zoom
moves each edge 25% of the width, pan 20%, fast pan 100%; pans slide against
the run's ends and keep their width, zoom is CUT at them, so zoom out is not
zoom in's inverse (in halves the width, out grows it by half). The unit cases
are those measured ranges written as offsets, and the e2e case that clears the
window takes exactly two zoom outs for the same reason.

**A MODULE-SCOPE `Intl.DateTimeFormat` FREEZES THE ZONE AT IMPORT, AND THIS
MACHINE IS IN ASIA/KOLKATA.** Measured: a formatter built under TZ=UTC kept
printing UTC after the zone was switched. So a zone-pinned test against one
passes on this machine, whose own zone is the pin, and fails only on CI's UTC
runners. The new formatters build per call or read the `Date`'s own fields,
and every zone-pinned file was also run under `TZ=UTC`; the mutation that
moved `formatInstantSeconds` to module scope PASSED here and FAILED under
`TZ=UTC`, which is the whole trap in one pair of runs.

**A STEP STARTS FROM THE URL'S WINDOW, NOT THE SERVER'S SNAPPED ONE**, a
refinement found while planning: `snapWindow`'s end is
`min(ceil(to / width) × width, last bucket + width)`, which lands a bucket
short of the run's end or past it, so every "at the end" decision would be
wrong by that bucket. The range line still states the snapped window, held to
the run.

**AN ELAPSED AXIS IS NAMED IN ONE PLACE NOW.** Thirteen `name: 'Elapsed (s)'`
literals across seven components moved into `Chart`, which names the axis from
the viewer's mode, and `ChartXAxis` refuses `name` beside `tickUnit` at compile
time. `timeAxis.test.ts`'s per-file pairing guard is re-pointed to refuse a
chart component spelling the name itself, with its vacuity counter on the
construct (`tickUnit: 'ms-as-s'`), not on the verdict.

**THE DRILL-DOWNS ARE SIBLINGS OF THE RUN ROUTE**, so a provider in `RunShell`
alone would have left their charts elapsed in Datetime mode with nothing
saying so. Each provides the run's own clock, and the e2e case reaches one by
URL.

**`CompareChart` WITHOUT `ElapsedOnly` WAS INVISIBLE TO THE UNIT SUITE**, which
never renders it under a provider; only the e2e case caught it. Recorded so
the next reader does not mistake a green unit run for coverage of it.

**M01's FOLD, RE-MEASURED:** the window is ⟨height⟩px closed with its range
line and mode always visible, and the run totals begin at y⟨top⟩ at 1440x900,
inside the bound.

**WHAT WAS RUN.** `typecheck` and `lint` green by their own exit codes;
`test:unit` **⟨unit files⟩ / ⟨unit tests⟩**, zero failures and zero `Errors`
lines, and again under `TZ=UTC`; `test:integration` **⟨int files⟩ /
⟨int tests⟩, exit 0**; `pnpm test:e2e` **⟨e2e⟩ passed, exit 0** — against a
SCRATCH DATABASE (`perfportal_tw`) and a scratch Redis INDEX (db 10).
```

Add to that entry anything the execution itself taught that a future reader would otherwise rediscover: a gate that failed and why, a mutation that landed somewhere unexpected, a measurement that overturned a claim in this plan.

- [ ] **Step 4: Commit, push, PR**

```bash
git add CLAUDE.md
git commit -F - <<'MSG'
Record the time window's floors and what building it taught
MSG
git log --oneline origin/main..HEAD
git push -u origin feat/time-window-gatling-style
gh pr create --base main --head feat/time-window-gatling-style \
  --title "Give the time window Gatling Enterprise's time controls" \
  --body-file "$SCRATCH/pr-body.md"
```

Write `$SCRATCH/pr-body.md` first: what changed (the four controls), the deviations kept (A to F in one line each), what was measured and how, the three floors, and the e2e count.

- [ ] **Step 5: Watch CI by SHA, then merge**

```bash
N=<pr number>
before=$(gh pr view $N --json headRefOid -q .headRefOid)
s=$(gh pr checks $N --json name,state)
after=$(gh pr view $N --json headRefOid -q .headRefOid)
[ "$before" = "$after" ] && echo "$s" | jq -e 'length > 3 and all(.state=="SUCCESS" or .state=="SKIPPED")'
```

Repeat until it succeeds on one SHA. Before merging, dispatch the cross-browser job, which a PR's own run never executes: `gh workflow run ci.yml --ref feat/time-window-gatling-style`, and wait for it — the e2e spec pins a timezone, and whether Firefox and WebKit honour `timezoneId` under the runner is not something Chromium can answer. Then `gh pr merge $N --merge --delete-branch` (merge commit, never squash), confirm with `git ls-remote origin refs/heads/main`, and clean up: drop `perfportal_tw`, `FLUSHDB` Redis db 10, and confirm the developer database still holds its nine runs.
