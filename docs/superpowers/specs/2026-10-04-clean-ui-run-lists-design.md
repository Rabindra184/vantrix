# Clean UI, PR 3 — the run lists — design

2026-10-04. PR 3 of the clean-UI programme. The programme spec,
`docs/superpowers/specs/2026-10-04-clean-ui-design.md`, holds the text rule
this PR applies and is not restated here. PR 1 (#259) built `InfoTip`; PR 2
(#260, merge `3843b33`) cleaned the run page.

Scope: the three run lists — All runs (`/runs`), a project's runs
(`/projects/:slug/runs`) and a test's runs (`/projects/:slug/tests/:test`) —
which are one component, `RunList`, plus the test page's own header strip in
`TestRuns`.

Decisions settled in brainstorming:

1. **The simulation name leads with its class, the package above it in small
   muted type**, breaking only at dots and camelCase word boundaries — never
   mid-word.
2. **The Focus column goes.** The one fact only it carried — a simulation
   assertion that failed — moves into the Verdict cell, shown only when it
   happens.
3. **The tally is one plain line**: "On this page", four counts with labels,
   and one ⓘ.
4. **Started is shortened and stays after the measurements**; the timezone is
   stated once, in its column header.
5. **Approach 1:** two new focused files (`SimulationName`, `RunTally`), the
   rest edited in place. One PR, six tasks.

Palette, theme, routes, contracts and APIs do not change.

## Why

Measured after PR 2, the same headless pass at 1440×900 over the developer
database's real runs (words inside `<main>`):

| page | words |
| --- | ---: |
| All runs | 503 |
| A project's runs | 380 |
| A test's runs | 351 |

The pages carry little prose any more; what they carry is repetition and
width:

- "investigate" in a Focus column on every row, restating what Status and
  Verdict already say;
- the run total twice ("Runs · 23 runs" in the heading, "On this page · 23
  runs" in the tally), a "How counts work" disclosure, and a description under
  each of the four counts;
- class names broken anywhere ("example.P / aritySimul / ation"), because the
  cell is `break-all`;
- a 239px Started cell repeating the year and the timezone on every row, which
  is why the table needs 1078px and scrolls sideways below 1440;
- on a test's page, a "Simulation class" chip repeating the heading.

## The name cell (`SimulationName`)

New file `apps/web/src/routes/SimulationName.tsx`, exporting
`SimulationName({ name }: { name: string })`.

- It renders the package with its trailing dot (`example.`) as a block of
  11px muted text above the class name (`ParitySimulation`) at the link's
  size. A name with no dot renders the class name alone.
- **Every break-free piece is its own `whitespace-nowrap` span, joined by
  `<wbr>`.** The pieces are each package segment with its dot, and each
  camelCase word of the class name (a split before an upper-case letter that
  follows a lower-case letter or digit). So a line can end only at a dot or a
  word boundary, and the column's minimum width is its longest piece.
- The spans join with nothing between them, so the cell's `textContent` is the
  full name — search, copying text and every existing `run-simulation` text
  assertion read `example.ParitySimulation` as before.
- `RunRow` and `RunCard` both render it inside the existing run link. The
  `break-all` on the cell (and on the card's link) goes; `min-w-0` stays. The
  copy button stays beside the link.
- Unchanged: the short-id fallback for a run with no simulation, and a test's
  list, where the column is "Run" and shows "Run 11".

## The Verdict cell and Focus

- When `checks.failed > 0` the Verdict cell gains a second line under its
  badge: "1 assertion failed" / "N assertions failed", 12px, in the
  failed-status colour (`style={{ color: 'var(--color-status-failed)' }}`, the
  status palette's route). No line otherwise. The card's verdict gets the same
  line.
- **Focus is deleted**: the column, the card's Focus row, `FocusHint`,
  `FOCUS_MARKS` and `focusFor`. `needsAttention` and `isInFlight` stay — the
  tally counts with them.
- The table's ⓘ (`TableFrame`'s `info`) loses its Focus sentence.
- The loading skeleton's column count drops by one — 8 on All runs, 7
  elsewhere — still derived from `projectSlug === null`.

## The tally (`RunTally`)

New file `apps/web/src/routes/RunTally.tsx`, exporting
`RunTally({ items }: { items: readonly RunListItem[] })`. It replaces
`RunListHealth` and `HealthTile`, in the same place between the filters and
the table.

- One line, no border or card:
  `On this page   23 Needs attention   0 In flight   0 Passed gates   11 Unjudged   ⓘ`.
  Counts mono semibold in the primary text colour, labels 12px muted. All four
  always show, zeros included. The line wraps on a phone.
- The region keeps `aria-label="Run health on this page"`; "On this page"
  keeps `data-testid="health-scope"`; each count keeps
  `health-<label-slug>` (`health-needs-attention`, …).
- Removed: the run total from the scope line (the heading already says it),
  the four descriptions, the "How counts work" disclosure and its paragraph.
- The ⓘ is `InfoTip` with `label="About these counts"`. Its text says what
  each count includes — Needs attention: failed, stopped early, SLA verdict
  failed, or a simulation assertion failed; In flight: pending, parsing or
  live; Passed gates: SLA verdict passed; Unjudged: no verdict, or not
  evaluated — that a run can be in two counts, and that the counts cover this
  page only.
- `healthSummary`, `needsAttention` and `isInFlight` are unchanged in
  behaviour.

## Started and the column order

- Order on the desktop table:
  `[Project] · Simulation (or Run) · Status · Verdict · p95 · Errors · Started · Environment`
  (Project on All runs only, as today; Focus gone).
- New `formatListInstant(iso: string, now?: Date): string` in
  `apps/web/src/routes/format.ts`: month, day and time ("Oct 2, 7:44 PM"),
  the year only when it differs from `now`'s ("Sep 30, 2025, 10:32 PM"), no
  zone. Built per call, never at module scope.
- New `zoneLabel(iso: string): string` in the same file: the instant's
  short zone name as `formatInstant` prints it (`GMT+5:30`, `EST`).
- The header reads `Started (<zone>)`, the zone taken from the page's first
  row. A row whose own `zoneLabel` differs (a daylight-saving change between
  runs) keeps its zone as a suffix, so no time is shown under the wrong zone.
- `<time dateTime>` and the "ingest time" marker stay.
- The phone cards keep `formatInstant` unchanged: one time per card and no
  shared header to carry the zone.
- Expected effect: the table needs about 860px instead of 1078px and fits
  without sideways scrolling at 1280 and 1440. Measured, not assumed.

## A test's page (`TestRuns`)

The "Simulation class" chip is omitted when the simulation class equals the
test's name — every test created from its class — which is the rule
`RunHeader` already follows for its own class chip. A named test
(`checkout-smoke`) keeps it. The "Runs" chip stays.

## Testing

- `SimulationName.test.tsx`: pieces rejoin to the full name; package and class
  split; camelCase pieces; no dot; no `break-all` anywhere in the cell.
- `RunTally.test.tsx`: the four counts and labels from a fixture page; no
  run total in the scope; no descriptions; the ⓘ's description names each
  count and the page-local scope; zeros shown.
- `RunList.test.tsx` / `RunList.compact.test.tsx`: no Focus column or card
  row; the assertion line appears only for `checks.failed > 0` (paired with a
  run without it); header order; the zone header and a differing-zone suffix;
  the skeleton's column count.
- `format.test.ts`: `formatListInstant` and `zoneLabel`, zone-pinned
  (Asia/Kolkata; New York across a daylight-saving change), each also run
  under `TZ=UTC`.
- `TestRuns.test.tsx`: the class chip omitted when it equals the name, kept
  when it does not.
- Browser: in the existing 56-character case every name piece renders on one
  line at 768, 1024 and 375; the existing guards (p95 and Errors on screen at
  six widths, no sideways scroll at 320 and 414, the copy button beside the
  name, the phone's first card) are re-run, not loosened; the table's width is
  measured at 1100, 1280 and 1440.
- Tests pinning removed things (Focus, the tally descriptions, "How counts
  work", the old Started text) are re-pointed at their claims or deleted with
  them. Every new or re-pointed assertion is red-verified by a mutation.
- The gate: `typecheck`, `lint`, `test:unit`, `test:integration`, `test:e2e`,
  each from its own exit code; a before/after word audit of the three pages;
  an Opus whole-branch review; floors updated in `CLAUDE.md`; the
  `e2e-cross-browser` job dispatched before merge.

## Out of scope

- The SLA-rules panel on a test's page (its prose is `ProjectRules`, PR 4).
- Merging Status and Verdict into one column.
- Any colour, token, font, theme, route, contract, API or data change.
- Splitting `RunList.tsx` into more files beyond the two above.
