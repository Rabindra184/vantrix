# Summary and Report

**Status:** approved 2026-10-01, in chat, section by section.
Backlog item #7 of the Gatling Enterprise comparison: the run page becomes
Gatling Enterprise's two pages — a **Summary** that is always the whole run,
and a **Report** carrying the time window and the run's charts in collapsible
sections. Five tabs replace seven. No API, contract or database change: every
number on both pages is already served.

## What Gatling Enterprise does, measured

Read from the user's own cloud.gatling.io account on 2026-10-01, read-only,
through Claude in Chrome, on the account's only two runs: a 2-minute no-code
run (one request, `GET Home`) and a 3-second JVM run (one request, `Session`).

| | Summary — `…/runs/<id>` | Report — `…/runs/<id>/details` |
|---|---|---|
| Time window | **none — always the whole run.** Opened with a 30-second `from`/`to` in its URL it still read 900 requests, the whole run's count, and drew no timeline | the window bar (from, to, duration, an Offset/Datetime switch) and the request timeline live here alone; a 30-second window narrows every chart |
| Above the content | run name, Summary · Report · Logs, Compare runs, the run's metadata, an "AI run analysis" card, the lifecycle strip | run name, Summary · Report · Logs, Compare runs — then straight to the window. **No lifecycle strip, no headline numbers** |
| Content | 4 headline numbers: **Error ratio, Total requests, Max. concurrent V.U, P95 response time**. An assertions bar, "1 assertion failed, 1 assertion successful", **collapsed until clicked** even though it holds a failure, expanding into one card per assertion ("Global: percentage of failed events is less than 5.0 — Failed with value 100"). Two charts side by side: **Requests and Responses per Second** (lines Requests, Total, Responses OK, Responses KO) and **Response Time Percentiles**. The errors table | collapsible sections, in this order: **Requests** (open), **Groups, Virtual users, Connections, DNS, Load Generators** (closed) |

Sections, as measured:

| Section | Charts (titles as GE writes them) | Controls |
|---|---|---|
| Requests | Requests and Responses per Second · Responses per Second by Status · Response Time Percentiles · Response Time Distribution · Response Time Percentiles Distribution · Errors per Second | a **Charts / Table** switch (Charts by default); Scenario, Group and Request pickers kept in the URL (`requests-scenario`, `requests-group`, `requests-request`). **Table** is the statistics table — Flat / Hierarchy, Download CSV, every percentile — filtered by Scenario alone |
| Groups | on both runs only "There is no group to display." | — |
| Virtual users | Users Arrival Rate · Users Termination Rate · Concurrent Users | — |
| Connections | Connection Open and Close Rate · TCP Connection By State · TCP Connect Duration Percentiles · TCP Connect Duration Distribution · TCP Connection Percentiles Distribution · TLS Handshake Duration Percentiles · TLS Handshake Duration Distribution · TLS Handshake Duration Percentiles Distribution · Bandwidth Usage per second | Remote |
| DNS | DNS Resolution per Second · DNS Resolution Duration Distribution · DNS Resolution Duration Percentiles Distribution · DNS Resolution Duration Percentiles | Hostname |
| Load Generators | GC Counts per Second · GC Time per Second · CPU usage in percent · Memory Usage in MB · TCP Connections Events per Second · TCP Segment Events per Second | Load generator (`hostname`, `injector` join the URL once it opens) |

Behaviour, as measured:

- **Sections open independently.** Opening Groups left Requests open; all six
  can be open at once.
- **Which sections are open is kept nowhere.** Not in the URL, and a reload
  goes back to Requests alone; `localStorage` holds no key for it.
- The Charts / Table choice is not in the URL either.
- Summary, Report and Logs links each carry the page's WHOLE query string
  (window and pickers) to the next page; only the Report applies it.
- The markup is thin: the three page links are plain anchors with no current
  marker, section headers are clickable `div`s with no button role and no
  `aria-expanded`, and neither page has a heading per section. Their layout
  and behaviour are copied; their markup is not.

Not measurable from this account, recorded rather than guessed:

- **A populated Groups section.** Neither run has a group, and running a
  grouped simulation needs credits the account no longer has.
- **The pickers' default on a multi-request run.** Both runs have one
  request, so whether GE opens on "all requests" or on the first one cannot
  be told apart.
- **Live behaviour.** Both runs are finished.
- **The AI run analysis.** Its card ("Let the magic happen and get a full
  report analysis on your run in minutes", button *Analyze with AI*) starts a
  generation, so it was not clicked. Taken as its own backlog item, #11.

## Decisions taken, and the ones declined

Each was put to the user as a choice; the chosen one is first.

- **GE's full shape.** Tabs become Summary · Report · Logs · Trends ·
  Compare; Overview, Charts, Load generators and Errors fold into the two
  pages. Declined: splitting Overview alone while keeping the other tabs
  (Report would hold one table and a reader would still hunt), and turning
  only the Charts tab into sections (the behaviour without the split).
- **The statistics table lives where GE keeps it** — Report › Requests ›
  Table, Charts the default view. One deviation, for this repository's
  shareable-view rule (AC-DASH-4): a URL carrying the table's sort or filter
  opens straight on Table, so a shared sorted link still lands on what it
  shared. Declined: opening Requests on Table, and keeping the table on the
  Summary as well.
- **The lifecycle strip and the verdict band move onto the Summary only**,
  as GE's do. The live SLA breach banner still shows on every page while a
  run streams: it reports a breach happening now, not a summary, and GE's
  live behaviour was not measured. Declined: keeping both above every page,
  and a one-line verdict on the other pages.
- **GE's four headline numbers** — Error rate, Requests, Peak users, p95, in
  GE's order and this product's existing words (review N01's vocabulary).
  All four exist live and finished, so the tiles stop changing when a run
  ends. Throughput, p99 and mean are in the Report's table. Declined:
  keeping today's six, and GE's four plus throughput.
- **GE's chart list wherever the data allows.** The two charts the served
  data can draw are built; this product's two extras stay; what nothing
  collects is omitted, never drawn empty. Declined: dropping the extras, and
  regrouping without building anything.
- **The pickers are deferred** to their own item. Declined: Request and
  Group pickers now (Errors per second cannot be narrowed by its endpoint),
  and all three (the engine files no scenario statistics).
- **Two assertion bars, one per system** — Platform gates and Simulation
  assertions — each GE's bar and cards, keeping the separation review N01
  argued for: one is the organisation's policy and the other the test
  author's own checks. **One deviation: a bar holding a failure opens
  itself.** GE keeps even a failing bar shut; here a failed check is never a
  click away. Declined: one merged bar, and keeping today's two tables.
- **The Report's path is `/report`, not GE's `/details`.** Every other tab's
  path here is its label (`/logs`, `/trends`, `/compare`); a path naming
  something other than its own tab is not worth copying.
- **A section is a heading holding a button, and a closed section mounts
  nothing.** Declined: `<details>`/`<summary>` — it keeps closed content
  mounted, so every chart in every closed section would query and draw into
  a hidden box (the 0×0 layout this repository records), a heading inside a
  `<summary>` leaves the outline, and nested disclosures have already broken
  a WebKit case here.
- **One branch, one PR.** Declined: a pure move first and GE's content
  second, which would ship a layout matching neither product.
- **The AI run analysis is #11**, after this change builds the page it lives
  on.

## Pages and URLs

| URL | Page | Window |
|---|---|---|
| `/runs/:id` | Summary | **never applied** |
| `/runs/:id/report` | Report | applied — the window control lives here alone |
| `/runs/:id/logs` (runner runs only), `/trends`, `/compare` | unchanged | unchanged (none) |

- Tabs, in order: **Summary · Report · Logs · Trends · Compare**. Logs keeps
  its rule (runner runs only, after Report).
- **The old paths redirect**, keeping every query parameter they carry:
  `/charts` → `/report`; `/load-generators` → `/report` with the Load
  generators section opened; `/errors` → `/runs/:id` scrolled to the errors
  table. Anything else stays the run-section-not-found page.
- **The window travels the way GE's does.** Every tab link carries `from`
  and `to`; only the Report applies them. A reader can leave the Report for
  the Summary and come back to the same window.
- **Open sections are remembered nowhere**, as measured: a Report opens with
  Requests open and the rest shut, on every visit and every reload. The one
  exception is the `/load-generators` redirect, which opens that section on
  the visit it produces — an old link to that page has to land on its
  content.

## The Summary — always the whole run

Top to bottom. "Moved" means an existing component keeps its behaviour.

1. **The run header**, on every page and unchanged — except the **Peak
   users** chip, which goes: Peak users is a headline number now, and a
   value shown twice says nothing new.
2. **The lifecycle strip**, moved from above every tab.
3. **The verdict band**, moved from above every tab. Its "See the failed
   simulation assertion" link targets the Simulation assertions bar on this
   page and opens it.
4. **Headline numbers: Error rate · Requests · Peak users · p95.** The same
   four live and finished. They keep this product's "vs previous" changes
   and the baseline note, and the SLA tint rules are unchanged. On a phone
   the existing sparklines stay beneath them.
5. **Platform gates** and **Simulation assertions**, two bars replacing the
   two evidence tables. A bar reads like GE's ("1 failed, 2 passed") and
   expands into one card per check — what was checked, the limit, the
   actual value, the outcome — in the words today's tables already use
   (`describeSlaMeasurement`, `formatSlaValue`, the simulation's own
   expression). **A bar holding a failure opens itself.** A bar with nothing
   to judge keeps today's distinctions verbatim: gates "not configured",
   "not reported yet", or "not evaluated — the run left nothing to judge".
6. **Two charts side by side**, GE's pair: **Requests and responses per
   second over time** (new, below) and **Response time percentiles over
   time** — the whole run, always. Withheld on a phone, as charts are now.
7. **The errors table**, moved from the Errors tab, its request filter
   included and still in the URL. Its endpoint takes no window, so it was
   always the whole run.

While a run streams: the headline numbers read the live data; the two charts
behave as on today's live Charts tab; the errors table as on today's live
Errors tab; the bars show what has been judged so far.

Above every page there remain only the run header, the live SLA breach
banner and the live streaming status.

Heading outline: **Platform gates · Simulation assertions · Over time ·
Errors**. "Over time" is visually hidden: GE draws no heading there and the
chart titles say what they are, but without it the charts' own `<h3>`s would
sit under "Simulation assertions".

## The Report — the window and the sections

**The time window, at the top and always open.** Today it is a collapsed
disclosure — review M01's trade, made so the run's totals fit above the fold
on the page that carried them. The Report carries no totals, and GE's window
bar and timeline are always shown. Behaviour is unchanged: the brush, the
steps and presets, the Datetime / Elapsed mode, `from`/`to` in the URL.

Then the sections, in GE's order, each a heading holding a button:

| Section | Opens | Contents |
|---|---|---|
| **Requests** | open | **Charts / Table.** Charts (the default): Requests and responses per second over time (new) · Response time percentiles over time · Response time distribution · Response time percentiles distribution · Errors per second · then this product's two: Response time ranges · Number of requests. Table: the statistics table as it is today — column picker, sort, filter, CSV — with the glossary beneath it, since every word it defines is in that table. A URL carrying the table's sort or filter opens Table |
| **Groups** | closed | one row per group — name, count, OK, KO, and the p95 of its cumulated and of its wall-clock duration — each linking to its group page. "This run has no groups." when it has none. This product's own design: GE's populated section could not be measured |
| **Virtual users** | closed | Users started per second · Concurrent users over time · **Users ended per second** (new, below) |
| **Connections** | closed | Bandwidth · Connections by state — the two GE places here that the load-generator agent collects. GE's other seven are omitted: nothing collects them |
| **Load generators** | closed | CPU usage · Memory usage · TCP connection events · TCP segment events. When no agent reported, the tab's own empty state ("No generator telemetry recorded"), unchanged |

**DNS is left out**, and so are Responses per second by status (a Gatling
`simulation.log` carries no HTTP status code) and the two GC charts (the agent
does not collect them). A section or chart that can only ever be empty is a
false claim about the run.

A section's button carries `aria-expanded` and `aria-controls`; its content is
mounted only while open, so a closed section runs no query and draws no chart.
Opening one never closes another. On a phone the existing desktop-only rule
applies to every chart, as it does today.

While a run streams: the window is withheld, as now. The Requests charts
stream as today's live Charts tab does; the two distributions and the Table
say they arrive when the run finishes, as now. Virtual users streams — the
live data carries the users series, `ended` included. Connections and Load
generators wait for the run to finish, as the agent data does today.

Heading outline: **Time window · Requests · Groups · Virtual users ·
Connections · Load generators**, with each chart title and the Statistics
heading one level beneath its section.

## The two new charts — no backend change

**Requests and responses per second over time**, GE's four lines, from one
series bucket:

| Line | From |
|---|---|
| Requests | `startedCount` |
| Total | `endedCount` |
| Responses OK | `okCount` |
| Responses KO | `koCount` |

`okCount` and `koCount` are the END-edge split, so OK + KO is the Total line;
the START-edge split (`startedOkCount`/`startedKoCount`) is the wrong source
and must not be used. Each count is divided by its bucket's width in seconds,
as the two rate charts it replaces do.

**Users ended per second**, the twin of Users started per second, from the
users series' per-scenario `ended` counts, live and finished.

The two separate charts "Requests per second over time" and "Responses per
second over time" leave the run page; the request and group pages keep
theirs, and so does the time window's own chart.

## What is built, moved and removed

Built: the Summary and Report page components; the shared section component;
the two assertion bars and their cards; the two transforms and charts; the
Groups list; three redirects.

Moved: the lifecycle strip and the verdict band into the Summary; the time
window into the Report, open; the errors table and its filter into the
Summary; the statistics table and the glossary into Requests › Table; the
agent's six charts across Connections and Load generators.

Removed: the Overview, Charts, Load generators and Errors tabs and their
route components; the Charts tab's group headings (Offered load ·
Throughput · Response time · Outcomes); the two separate rate charts on the
run page; the header's Peak users chip; the error count on the Errors tab's
label.

Every link to an old place is re-pointed, not merely redirected: every caller
of `runChartsPath`, `runTelemetryPath` and `runErrorsPath`, and every anchor
into the old pages (the verdict band's link among them), is found by grep and
changed.

## Tests, and what each must be seen failing for

Every new case is seen failing by a mutation from a checkpoint commit before
it is trusted.

| Case | Fails when |
|---|---|
| section component | a closed section's content is mounted; opening one section closes another; the button loses `aria-expanded` or `aria-controls` |
| assertion bars | a bar holding a failure is shut on arrival; one bar counts both systems; a "not configured" / "not reported yet" / "not evaluated" wording changes |
| combined rate transform | OK and KO come from the start-edge split |
| users ended transform | it reads `started` |
| Summary | any query it makes carries the window |
| Report | a URL with the table's sort or filter opens on Charts |
| redirects | an old path drops `from` or `to`; `/load-generators` lands with its section shut |
| tabs | an old tab reappears; Logs shows on a run with no runner job |
| browser: the Summary ignores the window | its Requests number differs between the bare URL and one carrying a narrow window |
| browser: sections | a section does not open by keyboard; more than Requests is open after a reload |
| browser: old URLs | any of the three lands anywhere but its new place |
| browser: a failing bar | it is shut on arrival |

The thirteen unit files naming the old tab components are re-pointed, keeping
their claims. The ten e2e specs pinning moved headings, chart lists or tab
URLs are updated to the new layout. Geometry bounds are re-measured, never
loosened: the phone fold (`mobile.spec`, 812 px) and the 1440×900 totals bound
should both improve, since the Summary no longer carries the window above its
tiles; the Report gains its own bound — the window and the Requests section's
first chart row inside 900 px. Every figure in the CLAUDE.md entry is a
measurement.

Before merge: the five gates by their own exit codes against a scratch
database, Redis index and e2e port, floors predicted from the source first; a
dispatched cross-browser run (`gh workflow run ci.yml --ref feat/summary-report`)
because collapsible sections are where WebKit's visibility workaround has
bitten this repository before; and a real Gatling run looked at through both
pages, in both themes and at a phone width.

## Not in this change

- The Scenario, Group and Request pickers (deferred: their default is
  unmeasured, scenario statistics do not exist, Errors per second cannot be
  narrowed).
- The AI run analysis (#11).
- The DNS section, Responses per second by status, the GC charts, and GE's
  other seven Connections charts — nothing collects their data.
- Remembering open sections across visits, which GE does not do.
- A populated Groups section copied from GE, which could not be measured.
