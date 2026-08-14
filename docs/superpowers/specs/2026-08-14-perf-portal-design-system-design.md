# Design system: slate surface, reference palette, shared primitives — design

Sub-project 1 of 3 in the enterprise-UI family. Replaces the token layer and
introduces the four primitives the other two sub-projects will build on, then
applies both to the pages that already exist.

Reference: a Magic Patterns mockup of a Gatling dashboard, supplied as
`~/Downloads/4a5fc112-…`. It is a **source of visual decisions, not of code** —
nothing is copied from it; its palette values and its layout ideas are adopted
where they beat ours and rejected where they do not, with the reasons recorded
below.

---

## 1. Scope

In:

- `tokens.css` restructured, and the token vocabulary extended
- `charts/theme.ts` re-sourced to the reference palette
- `palette.test.ts` rewritten around the new gates
- Four primitives: `Card`, `Badge`, `StatTile`, and shared table styles
- The 62 arbitrary-value utility strings migrated to `@theme` names
- Six stat tiles on the run page, fed from the run-scope stats row

Out, and deferred to named siblings:

| Deferred | To |
|---|---|
| `GET /v1/projects`, session-scoped | sub-project 2 (API) |
| Sidebar, run header, Overview/Requests/Errors tabs | sub-project 3 (shell and IA) |

No route changes, no URL changes, no API changes. The only page whose content
moves is the run page, and only by gaining a stat row above its tables.

---

## 2. Four token blocks become three

### 2a. Why there are four today

`tokens.css` declares every token in `:root`, again under
`@media (prefers-color-scheme: dark)`, and again under `[data-theme='light']`
and `[data-theme='dark']`. The last two exist so an explicit toggle can beat
the OS preference **in both directions**, which a media query alone cannot do.
The file says so, and it is correct.

The cost is that `palette.test.ts` spends roughly 150 lines — `blockAfter`,
`tokenIn`, the `BLOCKS` table, the alias resolver — proving those four copies
agree with each other and with `theme.ts`. That machinery is load-bearing
precisely because the duplication is real.

This sub-project adds about fifteen tokens. At four blocks each that is sixty
new declarations and a fourth cross-check, for tokens that carry no argument —
`--color-surface-sunken` is not a decision anyone will want to audit four
times.

### 2b. `light-dark()` was the plan, and it is rejected — measured

The intended design was one declaration per token:

```css
:root { color-scheme: light dark; --color-surface: light-dark(#ffffff, #1e293b); }
```

It is **not viable here**, and the reason is specific rather than about browser
support (`CSS.supports` returns true in our Chromium).

`theme.ts` reads live token values through
`getComputedStyle(...).getPropertyValue(name)` — the one path a `--chart-*`
token travels to reach a rendered mark. **A custom property computes to its
token stream, not to a resolved value.** Measured in Chromium: that read
returns the literal string `light-dark(#ffffff, #1e293b)`, in every
`color-scheme` state, which is what would then be handed to ECharts as a
colour.

The workaround does function — set `color: var(--token)` on a probe element and
read `getComputedStyle(probe).color`, which correctly yields
`rgb(255, 255, 255)` and `rgb(30, 41, 59)` under forced light and dark. It is
rejected anyway: it converts a pure string read into a DOM probe on the app's
single colour path, returns `rgb()` where `palette.test.ts` compares hexes,
and — worst — defeats the documented jsdom fallback in `token()`, where an
absent stylesheet currently yields `''` and a probe would instead yield an
authoritative-looking black.

### 2b′. Three blocks, not four

```css
:root { /* light */ }
@media (prefers-color-scheme: dark) { :root:not([data-theme='light']) { /* dark */ } }
[data-theme='dark'] { /* dark */ }
```

The dark arm is written twice instead of four times; light once instead of
twice. `[data-theme='light']` disappears entirely — the `:not()` in the media
query does its job, which is what made it a separate block in the first place.
Explicit overrides still win in both directions.

`theme.ts` is untouched by this. `token()`, `markColor`, `livePalette` and the
jsdom fallback all keep working exactly as they do today, which is the point:
the colour path is the riskiest thing in this sub-project and this change does
not go near it.

`palette.test.ts`'s block machinery shrinks from four blocks to three and keeps
its shape rather than being replaced.

### 2c. `@theme`, and the sweep

Components currently write `bg-[var(--color-surface)]`. Under Tailwind v4's
`@theme` those become `bg-surface`, `text-muted`, `border-default`.

The sweep is small and bounded: **62 occurrences across 13 files, but only five
distinct tokens** — `--color-text-muted` (30), `--color-border` (24),
`--color-surface` (3), `--color-text-primary` (3), `--color-status-failed` (2).
It lands as its own commit, before the primitives, so the primitives are
written in the new idiom rather than converted after the fact.

`marks.tsx` is the fourteenth file mentioning `var(--`, and the one deliberate
exception: its `Mark.colour` is an inline `style` value, not a utility class,
because the colour travels as data through `Marked` and `Badge`. It keeps
`var(--color-status-*)` and is not part of the 62.

---

## 3. The palette

### 3a. Slate, not neutral grey

The reference is inconsistent with itself here: its CSS surfaces are chroma-0
neutrals, while its `chartTheme.ts` uses slate — `#0f172a` ink, `#e2e8f0` grid,
`#64748b` labels. Charts are most of the page, so this resolves toward **slate
throughout**. Cool neutrals also sit better beneath a green→red data ramp than
warm greys do.

| Token | Light | Dark |
|---|---|---|
| `--color-surface-page` | `#f8fafc` | `#0f172a` |
| `--color-surface` (card) | `#ffffff` | `#1e293b` |
| `--color-surface-sidebar` | `#ffffff` | `#0f172a` |
| `--color-surface-sunken` | `#f1f5f9` | `#334155` |
| `--color-border` | `#e2e8f0` | `#334155` |
| `--color-divider` | `#f1f5f9` | `#1e293b` |
| `--color-text-primary` | `#0f172a` | `#f8fafc` |
| `--color-text-muted` | `#64748b` | `#94a3b8` |
| `--color-text-subtle` | `#94a3b8` | `#64748b` |
| `--color-accent` | `#4f46e5` | `#818cf8` |

`--color-surface-page` distinct from `--color-surface` is what gives cards
definition without shadows. The reference paints both white and relies on
borders alone; a page of twelve bordered white cards on white reads as a wire
grid.

### 3b. Status: mark and text are different colours

This is the one place the reference is not adopted as-is, and the reason is
measured rather than aesthetic. Its `ok: #10b981` used as **text** on white
measures **2.54:1**; `pending: #f59e0b` measures **2.15:1**. WCAG AA needs 4.5.

No single value serves both grounds — `#047857` passes on white at 5.48 and
fails on a dark card at 2.67; `#10b981` is exactly the reverse. So status
splits in two, and the per-theme divergence is the strongest practical argument
for §2b:

| Role | Mark (chart fills) | Text light | on `#ffffff` | Text dark | on `#1e293b` |
|---|---|---|---|---|---|
| passed | `#10b981` | `#047857` | 5.48 | `#10b981` | 5.77 |
| failed | `#ef4444` | `#dc2626` | 4.83 | `#f87171` | 5.29 |
| pending | `#f59e0b` | `#b45309` | 5.02 | `#f59e0b` | 6.81 |
| not applicable | `#94a3b8` | `#64748b` | 4.76 | `#94a3b8` | 5.71 |

Charts therefore keep the reference's look exactly; only text and badges use
the darker arm.

### 3c. Percentiles become an ordered ramp

`min → max` stops being interchangeable categorical hues and becomes a
severity ramp. **Ten steps ship**, not the five originally scoped here — one
colour per band `PercentilesChart` can draw (D-7's exact set): `min`, `p25`,
`p50`, `p75`, `p80`, `p85`, `p90`, `p95`, `p99`, `max`. Five of the ten are
this section's original values (`p50` `#22c55e`, `p75` `#84cc16`, `p95`
`#f59e0b`, `p99` `#f97316`, `max` `#ef4444`), fixed on their own bands from
the reference; the other five (`min`, `p25`, `p80`, `p85`, `p90`) fill the arc
between and around them.

Measured against gates in `palette.test.ts` adapted for a ten-step ramp,
rather than the four-step `--chart-band-*` gates reused unmodified:

- hue angle: 181.7° → 164.8° → 149.6° → 130.8° → 116.0° → 101.3° → 85.7° →
  70.1° → 47.6° → 25.3°, monotonically decreasing
- adjacent ΔE: minimum **4.17** (`p80 → p85`) — floor **4.0**
- two-apart ΔE: minimum **8.23** (`p80 → p90`) — floor **8.0**
- ends ΔE: **37.42** (`min → max`) — floor **35**

**Why these floors sit below the four-step band ramp's 7.5/15**: ten steps
spread across roughly the same ~156° hue arc a four-step ramp spans are
necessarily closer together than four steps are — this is arithmetic, not a
looser standard. Holding this ramp to 7.5/15 would be a demand that it stop
being a ten-step ramp; Gatling's own four-step ramp already misses 7.5 on one
adjacent pair (§9's corroboration), and a four-times-denser ramp misses it
more.

**Record the tightness, precisely, because these floors are set close enough
to the measured minima that they pin these specific hexes rather than assert
a general property that would survive re-picking them**: `p80 → p85` clears
its adjacent floor by only 0.17, and `p80 → p90` clears its two-apart floor by
only 0.23. That neighbourhood — `p80`/`p85`/`p90`, the three steps this
section added between the original `p75` and `p95` — is this ramp's weakest,
and a future nudge to any of the three is the likeliest way to break it. The
original ramp's own tightest pair, `p50 → p75` at 7.98, is unchanged and is no
longer this ramp's tightest.

Note for anyone extending this: the ramp is **not** monotonic in lightness
(OKLCH L dips at `p50` and rises again through `p85`). Neither is the existing
band ramp. A lightness gate would fail both. Hue rotation is what carries the
ordering here, and hue rotation is what gets gated.

### 3d. The categorical six

Still needed: `toConcurrentUsers` draws one series per scenario, and
`assignPalette`'s six-slot cap and no-wraparound rule are unchanged by any of
this.

The reference's own `--chart-1..5` are its weakest values — two adjacent
yellows in light mode — so they are **not** adopted. Six hues are re-sourced
from the same Tailwind family for coherence with everything else:

`#4f46e5` indigo · `#0d9488` teal · `#8b5cf6` violet · `#d97706` amber ·
`#0ea5e9` sky · `#e11d48` rose

Assignment order is fixed and must not be reordered, for the reason
`theme.ts` already states: reordering silently recolours every existing chart.

---

## 4. Decision record: the colour-vision gate is removed

`CATEGORICAL` is Okabe–Ito, adopted because colour-vision-deficiency separation
is the one palette property this repo does not compute — simulating
protanopia/deuteranopia requires transcribed matrices, and a matrix transcribed
slightly wrong yields a test that passes while certifying nothing. The property
was **inherited** from a palette published as colour-universal.

Replacing it with the reference palette gives that up. This is a deliberate
decision taken with the tradeoff stated, not an oversight, and it is recorded
here so nobody later "fixes" it by reverting.

**What limits the damage.** `marks.tsx` already renders every status as shape,
then word, then colour — in that order of importance — and every chart carries
a complete data table as its parity surface. So what is lost is discrimination
of **series identity** in a multi-series chart, not discrimination of
**outcomes**. A reader with a colour-vision deficiency can still tell passed
from failed everywhere in the app, and can still read every plotted value.

**What replaces the gate.** The adjacent-pair ΔE 15 check for the categorical
palette is retained — it is a normal-vision separation check, and it is what
stops two scenario lines becoming indistinguishable. Added: the status contrast
gate of §3b, which the old palette never had.

---

## 5. Primitives

Four, each replacing something the pages currently do by hand.

**`Card`** — bordered surface, optional title and one-line description. It
**wraps** `Chart.tsx`'s existing `<figure>` rather than replacing it: the
`data-testid`, the `<h3>`, the limitation prose and the data table all stay
exactly where the e2e suite expects them. A card that absorbed the figure would
silently move the parity surface.

**`Badge`** — a pill taking a `Mark` from `marks.tsx` directly. It inherits the
glyph-word-colour rule rather than re-deciding it. `Marked` stays for inline
use; `Badge` is the chip form.

**`StatTile`** — label, value, hint. §6.

**Table styles** — not a component. Tighter rows, `--color-surface-sunken`
header, right-aligned numerics, `font-variant-numeric: tabular-nums`. The
tables set these per file today; this is one place instead of four.

---

## 6. Stat tiles on the run page

Six tiles above the statistics table: total requests, error rate, mean
throughput, mean response, p95, p99 — each with a hint line, as the reference
has them.

**Every value comes from the run-scope stats row the page already fetches.**
No new request, no new endpoint, no derived figure that the table below does
not also show.

Error rate specifically: the payload carries its own `errorRate` field, and
`StatisticsTable`'s `% KO` column renders `r.errorRate * 100` to two decimals.
The tile reads that same field with that same expression. Recomputing it as
`koCount / count` would be arithmetically identical today and would still be a
second definition of one number, placed a few hundred pixels from the first and
free to disagree the day the server's rounding changes.

This is the one content change in the sub-project, and it is why
`run-detail.spec.ts` is touched rather than merely re-passing.

---

## 7. Architecture

| File | Change |
|---|---|
| `apps/web/src/styles/tokens.css` | Restructured to three blocks (§2b′), `@theme` export, ~15 new tokens |
| `apps/web/src/charts/theme.ts` | `CATEGORICAL`/`CATEGORICAL_DARK` re-sourced; `STATUS_COLORS` split mark/text; percentile ramp added beside `BAND_*` |
| `apps/web/src/components/Card.tsx` | New |
| `apps/web/src/components/Badge.tsx` | New |
| `apps/web/src/components/StatTile.tsx` | New |
| `apps/web/src/charts/Chart.tsx` | Figure wrapped in `Card`; no option or transform change |
| `apps/web/src/charts/PercentilesChart.tsx` | Consumes the ramp instead of categorical slots |
| `apps/web/src/routes/RunDetail.tsx` | Stat row added above the tables |
| 14 files | Arbitrary-value sweep (§2c) |
| `apps/web/test/palette.test.ts` | Rewritten (§8) |

`theme.ts` stays the single source of colour truth and `tokens.css` stays the
runtime source; the mirroring between them, and the test that enforces it,
survive the restructure. Only the *shape* of the check changes.

---

## 8. Testing

**`palette.test.ts`, revised rather than rewritten.** Kept, and this is the
larger part of the file: the OKLCH conversion, chroma floor, lightness band,
categorical adjacent-pair ΔE 15, the band ramp's two floors, and the
block-agreement machinery — `blockAfter`, `tokenIn`, the alias resolver — whose
`BLOCKS` table loses its `[data-theme='light']` row and keeps the other three.
Removed: the CVD gate (§4). Added: status contrast ≥ 4.5:1 against its own
ground in both themes; percentile ramp hue monotonicity plus the two ΔE floors.

Dropping `light-dark()` is what makes this a revision instead of a rewrite, and
that is the second reason to prefer §2b′ — the risk of re-deriving 150 lines of
working gate was never priced into the original plan.

**Primitives** — jsdom unit tests. Plain React, no ECharts, they test cleanly
there.

**The badge's accessible name goes in Playwright, not jsdom.** `CLAUDE.md`
records why: `dom-accessibility-api` does not consult a descendant's
`aria-label` and Chromium does, so a badge whose glyph pollutes its own
accessible name passes every jsdom assertion and fails in a browser. That trap
has been paid for once already.

**Chart regression** — the existing `run-charts.spec.ts` "every chart actually
draws" assertion is the net for the theme change, and `request-detail.spec.ts`'s
scatter test now counts marks against its data table rather than asserting a
path exists.

**Not added: visual regression snapshots.** They would catch this class of
change, but every intentional restyle then churns a directory of PNGs and the
suite costs more attention than it returns. The token gates plus "charts still
draw marks" cover the failure modes that actually reach a reader.

---

## 9. Falsification checkpoints

1. ~~`light-dark()` survives `getComputedStyle`.~~ **Run, and it failed** — see
   §2b. The custom property computes to its token stream, so the read returns
   `light-dark(#ffffff, #1e293b)` verbatim. §2b′ is the design that replaced
   it. Left here rather than deleted: the next person to propose collapsing
   `tokens.css` to one block will have this idea too, and the measurement is
   the answer.
2. **Status contrast holds against the surface actually used.** The numbers in
   §3b are measured against `#ffffff` and `#1e293b`. If a badge ends up on
   `--color-surface-sunken`, they must be re-measured against that.
3. **The percentile ramp still clears its OWN floors — 4.0 adjacent, 8.0
   two-apart, 35 ends — not the four-step band ramp's 7.5/15** (§3c explains
   why a ten-step ramp is held to lower floors). The measured minima are
   `p80 → p85` at 4.17 (adjacent), `p80 → p90` at 8.23 (two-apart), and
   `min → max` at 37.42 (ends). Any nudge to `p80`, `p85` or `p90` re-runs
   this — that neighbourhood is where every floor sits closest to its
   measured minimum.
4. **The stat tiles agree with the table.** Error rate on the tile and `% KO`
   in the row below are the same quantity; assert they render the same value
   rather than trusting two call sites.

---

## 10. Success criteria

- `pnpm typecheck && pnpm lint && pnpm test:unit && pnpm test:integration && pnpm test:e2e` all green
- `tokens.css` is three blocks, not four; `[data-theme='light']` is gone and
  `palette.test.ts` proves the remaining three agree with `theme.ts`
- No `[var(--` arbitrary-value string remains in `apps/web/src` outside `marks.tsx`
- Every chart still draws marks, in both themes
- Status text clears 4.5:1 in both themes, enforced by test rather than by review
- The run page shows six stat tiles whose values match the statistics table
