# Control-room redesign — design

2026-08-22. Approved direction: implement the Flowstep redesign ("mission
control for release decisions", Flowstep file `bedb760c`, 16 screens) in
`apps/web`. Two decisions were made explicitly and are settled:

1. **Both themes stay.** The mockup palette becomes the dark theme verbatim;
   a light variant is derived from the same hues. The Light/Dark/System
   toggle, `theme.ts`, and the `index.html` pre-paint script are untouched.
2. **Foundation first.** Three sub-projects, each one `feat/*` branch and one
   PR, in order: foundation + shell, run-page gate strip, charts + tables.

The mockups deliberately mirror the app's existing information architecture —
same routes, tabs, tables, filters — so nothing here changes a route, an
accessible name, a heading outline, or any data contract. This is a retheme
plus component redesigns.

## Sub-project 1 — foundation + shell (`feat/redesign-foundation`)

### Palette

The mirror discipline holds: `SURFACE_TOKENS` in `apps/web/src/charts/theme.ts`
is the source of truth, `tokens.css`'s three blocks restate it, and
`palette.test.ts` fails on disagreement. Both files change in lockstep.

| role | light (derived) | dark (mockup) |
| --- | --- | --- |
| page | `#f5f7fb` | `#0d1220` |
| card | `#ffffff` | `#151c2c` |
| sidebar | `#f9fafd` | `#101727` |
| sunken | `#eef1f7` | `#0f1524` |
| border | `#dde4ee` | `#273349` |
| divider (rule) | `#edf1f7` | `#1e2941` |
| text-primary | `#0f1524` | `#e8edf6` |
| text-muted | `#5a6a83` | `#8c99af` |
| accent | `#c2410c` | `#f97316` |
| accent-foreground | `#ffffff` | `#0d1220` |
| ring | `#8b5cf6` (unchanged) | `#a78bfa` (unchanged) |

Accent moves from indigo to orange — the redesign's one action colour. Light
mode uses orange-700 because `#f97316` fails 4.5:1 as text on white; dark mode
uses the mockups' `#f97316` with ink foreground. The ring stays violet for the
reason `theme.ts` already documents: a focus ring must be visible against the
accent's own fill, and an orange ring on an orange button is invisible.

The brand tile gains `--color-brand-foreground` (`#0d1220`, all three blocks —
presentation-only, not mirrored), aliased as `--color-on-brand`, because the
tile's glyph must be ink-on-orange in both themes and white-on-orange is a
2.8:1 graphic. `--color-brand` itself is unchanged.

**Not touched in this sub-project:** `--color-status-*`, `--chart-status-*`,
`--chart-1..6`, `--chart-band-*`, `--chart-pct-*`, `--chart-gridline`. The
status/chart palettes move (if at all) in sub-project 3. `palette.test.ts`'s
contrast gates were hand-checked against the new dark card `#151c2c`: every
status text colour still clears 4.5:1.

### Typography

Geist / Geist Mono are replaced by three vendored variable faces, same
discipline as today's `fonts.css` (variable woff2, latin + latin-ext subsets
only, `font-weight` range syntax, `font-display: swap`, Google's own
unicode-ranges):

- **Inter** — body and UI (`--font-family-sans`). Carries `cv11`.
- **Space Grotesk** — display: headings and, later, the verdict word
  (`--font-family-display`, new token, aliased as `--font-display` so
  `font-display` becomes a utility). A base-layer rule sets `h1, h2, h3` to
  the display family so the change is one decision, not thirty files.
- **JetBrains Mono** — all data (`--font-family-mono`). Keeps global `tnum`.

Body stays 14px; `--header-height` stays 3.5rem; the iOS 16px input rule and
reduced-motion block are untouched.

### Shell components

- `ThemeToggle` — restyled as a pill (rounded-full container and segments);
  keeps all three segments, `role="radiogroup"`, the exact `aria-label`s, and
  the no-effect mount discipline. Class changes only.
- `AppShell` — header keeps `h-header`, stickiness, and DOM order (skip link
  first — pinned by `project-rail.spec.ts`). Brand glyph goes ink via
  `text-on-brand`.
- `ProjectRail` — active row becomes raised surface + orange left edge bar
  (a presentational `<span>` with no text, so the pinned verbatim
  `textContent` of every row is unchanged); collapse stays CSS-only.
- `Badge` — LED restyle: squared dot, mono label, tighter radius. **No
  `text-transform`** — Playwright computes accessible names with it applied
  (CLAUDE.md), so label case stays exactly as the data renders it.
- `Button` — primary picks up orange via the accent token; radius/weight
  polish only.

Charts inherit the new surfaces immediately (`chartTheme` reads tokens off the
live document; its fallbacks are `SURFACE_TOKENS`, updated in the same edit).

### Verification

`pnpm typecheck && pnpm lint && pnpm test:unit && pnpm test:integration &&
pnpm test:e2e` on Node 22, integration before e2e, nothing else touching the
stack. Unit floor 124 files / 1299 tests; integration 118 / 1355; e2e 94 —
this sub-project adds no files, so any count below those floors means a
silently-skipped run, and any behavioural test that fails is a defect in this
work, not an expected casualty. Expected legitimate churn: `palette.test.ts`
mirrors (updated in lockstep), plus any unit test that pins a specific class
string a restyle changes (each is updated with its component, never deleted).
Build and grep the emitted CSS for `font-display`-generated utilities and the
new tokens, per the `@theme` silent-failure lesson.

## Sub-project 2 — run-page gate strip (`feat/redesign-run-page`)

`RunDecisionBand` becomes the release-gate strip: verdict word set huge in
Space Grotesk (styled `div`, **not a heading** — `run-tables.spec.ts` pins the
Overview tab's outline as exactly `['Assertions', 'Simulation assertions',
'Statistics']`), one tick per SLA rule (green/red/grey, `aria-hidden`
presentation with the existing counts as the accessible text), counts, and the
existing Compare previous / Export run actions. LED badges and the hairline
metadata chip strip on `RunHeader`. Scope and DOM constraints per the
five-tab-live-page spec's conventions.

## Sub-project 3 — charts + tables (`feat/redesign-charts`)

ECharts palette swap to the redesign hues (categorical set, gridlines,
percentile ramp tuning) — the full `theme.ts` + `tokens.css` + `palette.test.ts`
mirror update, keeping green/red reserved for OK/KO and the band ramp's
severity ordering. Stat tiles (28px mono values), table header restyle
(letter-spacing, never `text-transform`), `TimeBrush` styling. The
`TimeBrush.test.tsx` no-CATEGORICAL-hue guard and `timeAxis.test.ts` stay
green throughout or the change is wrong.
