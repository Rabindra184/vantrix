# Clean UI, PR 2 — the run page — design

2026-10-04. PR 2 of the clean-UI programme. The programme spec,
`docs/superpowers/specs/2026-10-04-clean-ui-design.md`, holds the text rule
this PR applies and is not restated here. PR 1 (#259, merge `0b42889`) built
`InfoTip`, the `SectionHeading` `info` slot, and stopped `Chart` and
`TableFrame` printing prose.

Decisions settled in brainstorming:

1. **The release-gate band stays, slimmed.** It is the control-room design's
   signature; the repetition inside it goes.
2. **A tile is a label, a value and a delta that names its run.**
3. **The header's verdict badge goes**; the lifecycle strip carries the
   verdict on every tab, the band on the Summary.
4. **The percentile chart's ten band chips become one "Bands" dropdown.**
5. **One PR, six tasks.**

Palette, theme, routes, contracts and APIs do not change.

## Why

Measured after PR 1, the same headless pass at 1440×900 over the developer
database's real runs: the Run Summary still carries 388 words, 191 of them
prose in 14 blocks. The repetition is the point:

- the verdict three times (header badge, lifecycle strip, band);
- the gate counts four times (a sentence, a tick strip, three count tiles, and
  the band's "Platform gates 1 passed · 1 failed" row);
- a hint line on every tile, two of which restate another tile;
- the "vs previous is Run 10 (started …) — the one that started immediately
  before this in this test." sentence under the tiles;
- every platform gate card stating its rule, its actual, and then a sentence
  restating both;
- ten band chips above a legend listing the same bands in the same colours.

## The release-gate band (`RunDecisionBand`)

Three columns, nothing repeated:

- **Left — unchanged.** The verdict word and its "Release gate" label.
- **Middle — two rows**, one per system, each its conclusion:
  - **Platform gates.** When a gate failed: the first failing gate's own
    sentence (`describeSlaOutcome`, e.g. "Whole-run error rate 3.1285% exceeds
    the 1% limit." — its precision unchanged), followed by "and N more" when more than one failed.
    Otherwise one word or phrase: `passed`, `not configured`,
    `not evaluated`.
  - **Simulation assertions.** As today: "1 failed — <expression>" with the
    link to the failed assertion; or `passed` / `none declared`.
- **Right — the actions only.** "Compare runs" and "Export SLA summary (JSON)".

**Removed:** the counts sentence ("1 passed · 1 failed · 0 not applicable"),
the tick strip (`gate-ticks`), the three `DecisionCount` tiles, and the
`decision-detail` paragraph — its only content that carried information, the
failing gate's sentence, is now the gates row. The counts appear once on the
page, in the gate cards' headers.

The distinctions the band already draws stay intact: "not configured" (no
rule) is not "not evaluated" (rules judged nothing), and an unprocessed
incomplete run's gates are "not evaluated — the run left nothing to judge"
shortened to `not evaluated`.

## The stat tiles

Applies to BOTH renderings of the totals: the finished run's (`RunStats`) and
the live run's (`LiveSummary` in `RunSummary.tsx`). CLAUDE.md records three
times that a change to one of these stops short of the other.

- **A tile is a label, a value and, where a previous run exists, a delta.**
- **The delta names its run:** `+7.7% vs Run 10`, where `Run 10` is a link to
  that run. With no run number it reads `vs previous run`, still linked. This
  replaces `BaselineNote`'s "“vs previous” is Run 10 (started …) — the one
  that started immediately before this in this test." Three tiles carry a
  delta, so the page holds three links of one name to one destination — same
  name, same target, which accessibility guidance permits.
- **Every hint line goes:** "28 of 895 requests", "867 successful, 28 failed",
  "concurrent, at the busiest moment", "estimate" — and live: "concurrent, so
  far", "an estimate, so far", and the live counts lines.
- **p95's caveat moves behind an `InfoTip`** beside the p95 label ("About
  p95"): it is estimated from a sketch, accurate to within 1%, and shown
  clamped to the row's own minimum and maximum.
- **The "How percentiles are measured" disclosure is removed.** Its one point a
  reader needs is the p95 `InfoTip`.
- **Comparability, under the tiles, only when there is something to say:**
  - a short warning chip when the two runs actually DIFFER — the existing
    `summariseConditions` over the `different` findings only (e.g. "Different
    environment and branch"). Visible, because it changes whether a delta can
    be trusted (the text rule's data-integrity exception);
  - an `InfoTip` ("About the comparison with Run 10") listing every finding,
    differences and not-recorded alike;
  - with no notable finding, nothing renders.

A tile's SLA tint and the windowed-tint withholding are unchanged.

## The header (`RunHeader`)

The verdict badge (`data-testid="run-verdict"`) is removed. The status badge
stays — status and verdict are different facts. On a phone the lifecycle strip
collapses to one step, and a failed verdict is a step that did not end well, so
it is the step a phone already shows.

## The gate cards (`AssertionBars`)

- A **passed or failed** platform gate shows its rule as the title, its outcome
  mark and `Actual: …`. The sentence restating rule and actual goes.
- A **not-applicable** gate keeps its sentence: there it is the reason it could
  not judge, which nothing else on the card says.
- Simulation-assertion cards (expression, outcome, actual, target) are
  unchanged.
- The card headers keep their counts — the only place counts remain.

## The percentile chart's "Bands" dropdown (`PercentilesChart`)

- The ten band chips become one trigger reading `Bands · <n>` (accessible name
  "Percentile bands, <n> selected"), opening a Radix `DropdownMenu` of
  `CheckboxItem`s — one per band, each with its colour swatch, in today's
  order.
- **The menu stays open while bands are ticked** (`onSelect` prevents the
  default close); arrow keys move, Space toggles, Escape closes and returns
  focus to the trigger.
- It sits on one row with the existing OK/KO/All switch and the Logarithmic
  toggle.
- The band-selection state, its defaults, and the "no percentile bands are
  selected" empty state are unchanged; only the control is.

## Smaller run-page leftovers

- **Empty states are one line.** The scoped errors empty state ("No errors
  recorded for <request>") loses its body. The request-not-found state keeps
  its title and its "Back to this run" link and loses its body.
- **Trends:** the "Compare these runs" card loses "Overlay up to 5 of them on
  one metric."
- **Drill-downs under a selected window:** `WholeRunNotice`'s paragraph becomes
  a short visible tag, `Whole-run figures`, with an `InfoTip` carrying the
  explanation. Visible, because it changes how every number on the page is
  read.

## Testing

- **Unit.** Cases that pinned removed text are re-pointed at what replaced it
  (an `InfoTip` description, a row, a link) or deleted with the claim they
  made. New cases: the band's two rows and the absence of counts, ticks and
  count tiles; the gates row showing a failing gate's sentence and "and N
  more"; the tiles' `vs Run N` link and its fallback; the p95 `InfoTip`; the
  comparison chip present only when runs differ and the comparison `InfoTip`
  present whenever a finding exists; the live tiles carrying no hints; no
  verdict badge in the header; the gate card sentence only on a
  not-applicable gate; the Bands menu — trigger count, keyboard toggling, menu
  staying open, the chart's drawn series following the ticks; the one-line
  empty states; the `Whole-run figures` tag. Each new case is red-verified by
  a mutation from a checkpoint commit.
- **e2e.** The suite is run whole and re-pointed by the same rules. One new
  case drives the Bands menu by keyboard in a real browser. `mobile.spec.ts`'s
  first-tile bound must still hold (the band gets shorter, so it should only
  get easier).
- **Cross-browser.** `e2e-cross-browser` is dispatched on the branch before
  merge — a dropdown menu and a popover are what WebKit has handled differently
  here before.
- **Before / after.** The headless text audit is re-run on the same routes and
  the same run; the numbers go in the PR and the `CLAUDE.md` entry.
- **The gate**, each by its own exit code: `typecheck`, `lint`, `test:unit`,
  `test:integration`, `test:e2e`.

## Out of scope

- The run lists (PR 3) and the project area and forms (PR 4).
- Any colour, token, font, theme, route, contract or API change.
- PR 1's deferred minors, except where this PR's own code touches them.
