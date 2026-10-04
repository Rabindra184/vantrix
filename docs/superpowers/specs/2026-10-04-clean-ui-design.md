# Clean UI — design

2026-10-04. The goal: an enterprise-grade, modern, clean UI in the spirit of
Gatling Enterprise, without unwanted text. Decisions settled in brainstorming:

1. **The palette and theme stay.** The control-room colours, both themes, the
   fonts and the tokens are unchanged. What changes is LAYOUT, CHARTS and TEXT.
2. **Explanations follow rule C.** A caveat tied to one specific number, chart
   or table moves behind an ⓘ beside it; general prose is deleted.
3. **Shared pieces first, then one page area at a time** — four PRs, in order.
4. **Routes, data contracts and APIs do not change.** This is presentation work.

## Why

Measured 2026-10-04 against the developer database's real runs at 1440×900
(a headless pass over every route, words inside `<main>`; "prose" = visible
paragraphs, list items and captions of seven words or more):

| page | words | prose words | prose blocks |
| --- | ---: | ---: | ---: |
| Run Summary | 478 | 251 | 16 |
| Add results | 180 | 145 | 7 |
| API tokens | 527 | 101 | 3 |
| New on-prem run | 308 | 84 | 5 |
| A test's runs | 441 | 68 | 4 |
| Request detail | 289 | 48 | 3 |
| SLA rules | 103 | 41 | 2 |

Beyond the counts: the release-gate band states its counts three times (a
sentence, a tick strip, three tiles); the run lists carry two "How … counted"
links, a sentence restating the heading, four tally tiles each with a
description, and a "Focus: investigate" column repeated on every row; and
simulation names wrap mid-word ("example.P / aritySimul / ation").

The cause is historical rather than accidental: review rounds answered each
correctness concern by adding a sentence on screen. The concerns were real;
the sentences are what this design moves out of the way.

## The text rule

Governs every PR below.

1. **Always visible.** Labels — headings, tab names, column headers, field
   labels, button text, units, status words in badges — as noun phrases, never
   sentences. And data: numbers, names, timestamps, values.
2. **Visible only when the reader must act.**
   - an error: what failed, plus one line on the fix;
   - an empty state: one short line plus the action that fills it;
   - form validation, next to its field;
   - a destructive confirmation, one sentence;
   - a live status: a short phrase ("Live", "Reconnecting", "Processing").
3. **Behind an ⓘ beside what it qualifies.** A caveat that changes how one
   specific number, chart or table should be read — p95 is an estimate within
   1%; which run "vs previous" means; a table that ignores the selected window;
   a chart's absent points, truncated bins or OK-only bands.
4. **Deleted.** Sentences restating a heading; "how it works" paragraphs;
   "How counts work" / "How these numbers are counted" links; card
   descriptions under titles; how-to prose around a command (the command block
   stays — it is the instruction).

**Two firm limits**, so the rule is checkable rather than arguable:

- no card or section carries a description line under its title;
- no visible paragraph longer than one sentence, except inside an empty state
  or an error.

**Data-integrity warnings that change a decision stay visible as short
phrases**, never only behind an ⓘ — a run that stopped early ("Stopped early")
and a partial live view ("Partial data").

**Accessibility does not regress.** Every caveat behind an ⓘ is in the
accessibility tree (below); captions remain their table's accessible name,
shortened to a few words.

## The four PRs

| # | branch | scope |
| --- | --- | --- |
| 1 | `feat/clean-ui-infotip` | `InfoTip`, the `SectionHeading` slot, `Chart` and `TableFrame` stop drawing prose — **this spec** |
| 2 | own spec | the run page: Summary, Report, request and group pages |
| 3 | own spec | the run lists: All runs, project runs, a test's runs |
| 4 | own spec | the project area and forms; `Card`'s `description` prop removed |

PRs 2–4 are sketched at the end and get their own short specs when reached.

## PR 1 — shared pieces

### `InfoTip`

`apps/web/src/components/InfoTip.tsx`.

```tsx
<InfoTip label="About p95">p95 is estimated from a sketch, accurate to within 1%.</InfoTip>
```

- **Trigger.** A `<button type="button">` holding the lucide `Info` icon at
  14px (`h-3.5 w-3.5`), `text-muted`, `hover:text-primary`, with the app's
  existing focus ring. The icon is re-exported through `components/icons.tsx`
  like every other icon.
- **`label` is required** and becomes the button's accessible name. It names
  the button after its SUBJECT ("About p95", "About Response time
  percentiles over time"), because N buttons called "More info" in one
  document is the duplicate-name defect this repo has paid for three times.
- **Interaction: a toggletip, not a hover tooltip.** Click, tap, Enter or Space
  opens; Escape, an outside click or a second activation closes; focus returns
  to the trigger. A hover-only tooltip is unreachable on touch and unreliable
  from a keyboard, so it would hide exactly the caveats this exists to keep.
- **Mechanism: `@radix-ui/react-popover`** — the same family as the dropdown
  menus already in the app. It owns positioning beside the trigger, collision
  flipping, the portal, focus and dismissal. Content is portalled and mounted
  only while open, so ten closed InfoTips add nothing to the page.
- **The caveat is always in the accessibility tree, as the trigger's
  description.** The same content is rendered once in an element carrying the
  `hidden` attribute, whose id the trigger names in `aria-describedby`. The
  accessible-description computation follows `aria-describedby` into hidden
  nodes, so a screen reader announces "About p95, button, p95 is estimated
  from a sketch…" on focus, without opening anything. `hidden` rather than
  `sr-only` is deliberate: a hidden copy contributes no second tab stop and no
  second reading of the text in browse mode. The open panel repeats it;
  opt-in repetition is the honest trade, since a focusable control cannot be
  marked redundant.
- **Content is a `ReactNode`**, so "vs previous" can link to the run it means.
  The link is live in the open panel; inside the `hidden` copy it is inert by
  construction.
- **Panel.** The card surface, `border-default`, `shadow-panel`, `p-3`,
  `text-[0.8125rem] leading-relaxed`, `max-w-72`. No new colours or tokens.
- **Never inside a `<th>`.** Chromium folds a descendant button's name into
  the column header's accessible name ("p95 About p95"), which breaks both a
  screen reader's announcement and the e2e suite's exact `columnheader`
  queries. jsdom cannot see this (it does not consult a descendant's
  `aria-label`). Column-level caveats go in the table's section ⓘ.

### `SectionHeading` gains an `info` slot

`info?: ReactNode`, rendered as an `InfoTip` immediately after the heading
text, labelled `About ${heading text}`. This is where a table's long caption
goes. No other change to `SectionHeading`.

### `Chart`

- The block under the plot that renders `data.limitation` and
  `assignment.limitation` as paragraphs is removed. Both strings render inside
  one `InfoTip` placed directly after the chart's visible title, labelled
  `About ${title}`; with neither present there is no ⓘ.
- The transforms are untouched: they still produce `limitation`, so the
  transform tests (the seven `transforms.*` files) stay valid. Only the
  rendering moves.
- The empty-state `<p role="status">` stays visible — an empty state is
  allowed by the rule.
- Chart controls, legends and the band chips are NOT touched here; that is
  PR 2's layout work.

### `TableFrame`

- **No visible caption.** The `aria-hidden` caption paragraph, the `summary`
  prop, the `<details>` disclosure and `CAPTION_MORE` / `CAPTION_LESS` are
  removed.
- **`caption` becomes `name: string`**, a short accessible name rendered as
  the table's `<caption class="sr-only">`. Callers pass the same string they
  render, as today.
- **Each caller's long text** moves into the `info` slot of the section
  heading that names its table, or is deleted where it restates that heading.

The ten callers and the names that keep existing queries matching:

| caller | short name | queried by |
| --- | --- | --- |
| `StatisticsTable` | Statistics | `/statistics/i` ×5 |
| `ErrorsTable` | Errors | `/errors/i` ×7, `/error/i` ×1 |
| `CompareMatrix` | Per-request comparison | `/request/i` |
| `NewRunnerRun` (jobs) | On-prem runner jobs | `/on-prem runner jobs/i` |
| `ProjectTests` | Tests | `/every test in this project/i` → **re-pointed** to `/^tests$/i` |
| `RunList` | Runs | — |
| `ProjectPackages` | Packages | — |
| `ProjectAccess` | API tokens | — |
| `ProjectRules` ×3 | Test SLA rules / Inherited SLA rules / SLA rules (each table's existing `label`) | — |
| `GroupsList` | Groups | — |

`ProjectTests`' current name is a sentence restating its heading, so it is the
one query that changes; it is re-pointed to the new exact name, never loosened.

- **`RunList`'s compact card layout** renders the same caption behind the same
  disclosure strings without a `<table>`. It moves to an `InfoTip` in this PR,
  because removing the shared strings otherwise leaves phone and desktop
  disagreeing about identical prose.
- **`ErrorsTable` and `StatisticsTable` tests** that read the caption's
  `textContent` for the denominator are re-pointed at the InfoTip trigger's
  accessible description, which carries the same words.

### Holding the line

After PR 1, neither `Chart` nor `TableFrame` CAN draw a visible caveat
paragraph: the props that did are gone, and a caller still passing one fails
`tsc`. The card-description limit is enforced at the end of PR 4, when
`Card`'s `description` prop is deleted.

### Testing PR 1

Every new case is red-verified: a mutation from a checkpoint commit, its
replacement count asserted, the failing case read at its assertion.

- **`InfoTip.test.tsx`** — the trigger is named by `label`; the hidden copy is
  linked through `aria-describedby` and carries the content; click, Enter and
  Space open; Escape closes and returns focus to the trigger; the panel is
  absent while closed; two InfoTips with different labels have distinct names;
  a link in the content is live in the panel and is not a tab stop while the
  panel is closed; the trigger's accessible description equals the content's
  text.
- **`Chart.test.tsx`** — a `limitation` renders inside an InfoTip and not as a
  visible paragraph; no InfoTip without one; the empty state stays visible.
- **`TableFrame` and its callers' tests** — no visible caption; the table's
  accessible name is the short name; the caption text is reachable through the
  section heading's InfoTip.
- **e2e** — every existing `getByRole('table', { name })` still resolves (the
  re-pointed one included); one new case opens a chart's ⓘ in a real browser,
  asserts the panel is inside the viewport and readable, and that Escape closes
  it and focus returns.
- **Cross-browser.** A `workflow_dispatch` of `e2e-cross-browser` on the branch
  before merge: a portalled popover is exactly what WebKit has handled
  differently here before.
- **Before / after.** The headless text audit is re-run on the same routes and
  the same runs; the prose-word table above is recorded again, with
  screenshots, in the PR and the `CLAUDE.md` entry.
- **The gate.** `typecheck`, `lint`, `test:unit`, `test:integration`,
  `test:e2e`, each read from its own exit code, plus `pnpm audit --prod` for
  the new dependency. Floors are updated in `CLAUDE.md`.

## PRs 2–4, sketched

Each gets its own spec; these are scope boundaries, not designs.

- **PR 2 — run page.** The release-gate band states its counts once; tile hint
  lines shrink to a unit or a delta; "vs previous", "How percentiles are
  measured" and the conditions line become ⓘs; the gate and assertion cards
  state each rule once (today: rule, actual, and a sentence restating both);
  chart cards are tidied (band chips, scale toggle, legend); the errors section
  loses its description; the request and group drill-downs follow suit.
- **PR 3 — run lists.** The tally strip keeps counts and labels only; the
  "Focus" column goes; simulation names stop wrapping mid-word; the column
  order is reviewed against what a reader scans first.
- **PR 4 — project area and forms.** Add results, API tokens, SLA rules,
  Packages and New on-prem run lose their prose under the rule — command blocks
  stay, paragraphs around them go; then `Card`'s `description` prop is deleted
  so `tsc` enforces the first firm limit from then on.

## Out of scope

- Any colour, token, font or theme change.
- Any route, contract, API or data change.
- New features. A docs site for the methodology deleted from screens is a
  separate decision, not part of this work.
