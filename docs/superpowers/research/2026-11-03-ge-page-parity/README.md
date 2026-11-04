# Gatling Enterprise page-by-page comparison — 2026-11-03

Every page of Gatling Enterprise Cloud (org `demo-perf`, trial) compared with
PerfPortal, to turn "every page GE shows exists here" into a ranked list
instead of choosing one item at a time. The raw record of each page — every
control, column, option list and the exact wording — is in
[page-notes.md](page-notes.md). This file is the verdict and the ranking.

**Limits of this pass.** The account had 0 credits, so no run could be
started: a live run, a stop criterion firing and a campaign score were not
seen. Git repositories is locked to private-location customers. Everything
else was opened. Created in the account for the pass: campaign
`perfportal-parity-probe` (holds the one test, no score until it runs), a
public link to Run 2 (expires 10/11/2026), one AI trends analysis and one AI
run comparison. Nothing else was saved.

## Already at parity

Measured earlier and not re-measured, except where a delta is noted:

| GE | PerfPortal |
| --- | --- |
| Run Summary: tiles, lifecycle strip, assertions bar, charts, errors table; band checklist and OK/KO/* picker on the percentiles chart | Summary tab (#254), `BandsMenu` and outcome picker |
| Report sections: Requests, Groups, Virtual users, Connections, DNS, Load generators | Report tab, GE report parity PRs 1–5 |
| Logs | Logs tab — on-prem runner runs only (#250) |
| Packages | Packages section (#257) |
| AI run analysis | AI run analysis (#296, #297), with every number checked |
| Test Trends: Responses status, Response time percentiles, Throughput across runs | Trends tab, the same three charts |
| Compare: overlay plus per-request table with % change against a reference | Compare tab and matrix |
| Home: tests that need attention, 7-day activity | Home (portfolio-home branch) |
| Tests list: name + copyable id, source, last run, status | Tests catalogue |

**Where PerfPortal is ahead.** Compare keeps its selection in the URL (GE
loses it on reload). Every figure is exact and verified against the raw log,
while GE disagrees with itself: Run 2's p99 is 2479 ms on Trends and 2383 ms
on Compare and in its own AI analysis. GE's AI trends analysis also made a
false derived claim ("max is identical across runs, 4191 ms": it is 4159 and
4191), the same class of error measured in its per-run analysis on
2026-11-02. Our number check exists to stop exactly that.

## Gaps, ranked

Ranked by value to a reader of this product (an on-prem install, one load
generator per run) against cost. B = bounded, A = architectural.

| # | Gap | Kind | What GE does |
| --- | --- | --- | --- |
| 1 | **Report scenario / group / request pickers** | B | Scenario, then Group (nested, with a "no group" entry), then Request, enabled once a group is picked; a group with one request selects it. Every chart in the section narrows. Kept in the URL per section (`?requests-group=Cart&requests-request=Add+To+Cart`). |
| 2 | **Compare: more metrics, a time-range slider, a pinnable reference** | B | 11 metrics: p50 p90 p95 p99 p99.9 p99.99 max, throughput, errors, concurrent users, CPU usage (we have 6). A range slider above the overlay. A pin column choosing which run the % changes are measured against. |
| 3 | **Custom report and PDF export** | A | A block editor: Title, Text Area, New Page, Status, Comments, Assertions, Summary, any of the ~26 Report charts, three count tables. Each block picks its own run, so one report can show several runs. Save as a report (with data) or a template (without), Load either, Preview & Print to PDF. |
| 4 | **Stop criteria** | A | "Stop when the [load generators' CPU usage / global response time / global error ratio] on the last [5/10/30/60] seconds is over [n]". Fits our runner and live fold, and protects the system under test. |
| 5 | **AI trends analysis and AI run comparison** | A, builds on #11 | Trends: confidence and direction chips ("medium confidence", "degrading"), a one-line lead, Health / Insights / Recommendations. Comparison of 2–5 runs: Insights / Recommendations / Explore in chart. Both about 40 s, free, stored. |
| 6 | **Public links** | B | Per run, with expiry from 1 week to 2 years or custom; a stripped read-only page (Summary, Report, Logs; no AI card, no Compare, no edit). An org-level switch turns the feature on or off. No revoke control was found. |
| 7 | **A test as a saved launch configuration** | A | The parked item from #8. A 7-section wizard: package and simulation (+ load-test type: Standard, Stress, Spike, Capacity, Soak, Smoke); locations; injection-profile override (open/closed model, per-scenario steps, five templates, a curve preview); JVM properties and environment variables on top of org-wide defaults; SLOs (p50…p99.9999, error ratio) that replace the simulation's assertions; ramp-up and ramp-down exclusion; stop criteria. Save, or Save and launch. |
| 8 | **Campaigns** | A | Tests grouped under a business goal, each scored on Methodology, Objectives and Confidence, with a campaign score and a score trend. Scores appear only after a linked test runs, and the campaign UI has no target fields, so the scoring rules are unseen. Needs Gatling's docs and one run before it can be specified. |
| 9 | Run title and View properties | B | An editable run title separate from the description; a properties panel with the run's id, simulation, trigger, Java system properties, environment variables, locations and stop criteria. |
| 10 | Per-user report settings | B | User menu › Percentiles: which of Min, 25…99.99, Max every percentile chart draws. Overlaps the open "13 percentile rows on the response-time charts" item. |
| 11 | Org-wide defaults and settings | B | Default load-generator properties for every test; an org time-zone override. |
| 12 | Usage | B | Minutes of test and runs launched per day, by team and by test, with CSV download (credits are not applicable). |
| 13 | Notifications | A | Slack and Microsoft Teams (a run summary with assertion results when a run ends), Jira Cloud (a work item when a run fails); org-wide, each with Test connection and a preview. Deprioritised in October. |
| 14 | Teams and roles | A | An organisation role plus per-team roles on five levels (Viewer, Contributor, Tester, Leader, Administrator); API tokens carry roles too. We have three project roles plus admin, which covers an on-prem install. |
| 15 | Observability export | A | Datadog, Dynatrace, OpenTelemetry, InfluxDB, New Relic. |

## Not applicable

Credits, plans and billing; dedicated IPs; managed and private locations
(PerfPortal is itself on-prem); the integrations catalogue as a page (it is a
list of documentation links); Git repositories (locked on this account, and
tied to private locations).

## Suggested order

1–2 are bounded and improve pages people read every day; take them first,
possibly as one branch. 3 and 6 are the sharing story (a PDF for a review, a
link for someone without an account) and could share a design. 4 and 7 are
the launch story and belong together, since stop criteria live in the test
configuration. 5 extends the AI work while it is fresh. 8 needs research
before it can be specified.
