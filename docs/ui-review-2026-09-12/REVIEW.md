<!-- Hallmark · pre-emit critique: P4 H5 E4 S5 R4 V4 -->
# PerfPortal — functional UI and design review

**Reviewed 12 September 2026. Perspective: a performance engineer investigating a regression and preparing a release recommendation.**

The application has useful analytical capabilities and a consistent visual foundation, but the interface makes engineers work too hard to establish what a number means, find the evidence, and maintain context during investigation. Some issues can produce an incorrect conclusion. A visual refresh should follow correction of those issues.

**36 findings: 9 critical · 23 major · 4 minor.** These are review priorities, not security vulnerability ratings. Critical means misleading evidence, an unsafe configuration default, a broken analysis interaction, or a materially broken layout. Major means substantial investigation friction or an incomplete workflow. Minor means localized polish or accessibility semantics.

## Scope and confidence

Signed in to the supplied local instance and inspected both available runs: `example.AssertionCorpus` and `example.ParitySimulation`, in project Web Demo. The account contained only two completed runs, one per test; neither had a platform SLA verdict. The parity run provided real request groups, errors, and simulation assertions for investigation.

Browser coverage: sign-in, organization run list, search/apply/clear and no-results recovery, project test catalog, test history and rule form, both run overviews, Charts, Errors, Trends, empty Compare, empty Load generators, Search request details, project setup, and the new on-prem run form. Inspected layout at 320, 375, 414, 768, 1024, 1280 and 1440 CSS pixels. The browser used the system-selected dark theme. Width measurements were taken from the rendered DOM; screenshots are supporting evidence.

Source coverage supplements the browser: run shell, filters, comparison selection/metrics/export, group details, rule validation, runner form, shared tables/states/tokens, and cohort query. Findings below distinguish **Observed**, **Source-confirmed**, and **Design assessment**. Source-confirmed findings have not all been reproduced through a submitted form or a populated comparison.

No application implementation was changed. No tests, rules, tokens, or runs were created or deleted, and no load was launched. Only this report and screenshot evidence were added. The existing untracked `infra/clean-test-residue.sql` was left alone.

Limitations: populated multi-run comparison, active streaming, populated telemetry, large histories, server failures, permission-denied roles, light theme, complete keyboard/screen-reader operation, and chart download/full-screen interactions were not verified live. The final browser checks were blocked by automatic approval review reporting the account usage limit. The invalid time-range interaction was submitted, but its final screen could not be collected; that finding is established from source. Group details and New project were source-reviewed, not visited. This is a thorough review of the available surface, not a claim that every possible state is defect-free or that all flaws have been found.

## What a performance engineer needs to answer

| Question | Current experience | Required direction |
|---|---|---|
| Did the test execute successfully? | Processing completion looks reassuring beside no SLA evaluation. | Separate execution state, platform gates, simulation checks, and request failures. |
| Is this release acceptable? | Large verdict dominates; simulation failures are below a large time selector. | Explicit decision with evidence and policy scope; never imply unchecked means passed. |
| What regressed? | Run list has no performance metrics; comparison needs a deeper visit. | p95, error rate, throughput and a named baseline in the triage surface. |
| Where and when did it degrade? | Tabs and request navigation lose the chosen interval; scopes differ. | Persistent analysis context, clearly scoped charts/tables, linked failure drilldowns. |
| Was the experiment comparable? | Test membership defines the cohort; environment/load compatibility is not surfaced. | Show environment, workload, duration, version and generator differences before interpreting deltas. |
| Can I share the conclusion? | Run export is a small JSON identity/SLA payload; comparison metric is not in the URL. | Reproducible analysis links and a scoped evidence report. |

## Critical findings

### C01 — Request details falsely claim the entire run had no errors

**Observed and source-confirmed.** Open ParitySimulation → Search. The Errors section says “No errors were recorded for this run” and “Every request this run made came back OK.” Search has zero failed requests, but its parent run has **24 failed requests out of 895**. A scoped result is presented as a whole-run conclusion.

**Fix:** Pass the scope into the error component. Say “No errors recorded for Search” and keep the parent run's error count available in the context header. Do not infer success of the whole run from a request-scoped empty error array.

**Acceptance:** Search shows zero errors for Search; the parent still shows 24 failed requests. A request with failures names that request in its error caption too.

Source: [ErrorsTable.tsx:128](/Users/rabindrabiswal/Workspace/perf-dashboard/apps/web/src/tables/ErrorsTable.tsx:128), [RequestDetail.tsx:81](/Users/rabindrabiswal/Workspace/perf-dashboard/apps/web/src/routes/RequestDetail.tsx:81). [Screenshot](/Users/rabindrabiswal/Workspace/perf-dashboard/docs/ui-review-2026-09-12/06-request-scope.png).

### C02 — Failure summaries exclude simulation assertions without making that boundary clear enough

**Observed and source-confirmed.** Both run headers show “Not evaluated” and **0 passed · 0 failed**. ParitySimulation has a failed Search p95 simulation assertion; AssertionCorpus has many failed simulation assertions. The organization list nevertheless says “Needs attention: 0.” The counters are platform-SLA counters, but their short labels look like overall test health.

**Fix:** Present separate labeled outcomes: “Execution completed,” “Platform gates: not configured,” and “Simulation checks: 1 failed.” Give failed simulation checks a prominent link. Keep release policy explicit; do not silently redefine the platform SLA verdict to include another system's checks.

**Acceptance:** An engineer can identify the failed simulation check on the first screen without scrolling. No overall attention count says zero while known failed checks are hidden elsewhere.

Source: [RunDecisionBand.tsx:51](/Users/rabindrabiswal/Workspace/perf-dashboard/apps/web/src/routes/RunDecisionBand.tsx:51), [RunShell.tsx:134](/Users/rabindrabiswal/Workspace/perf-dashboard/apps/web/src/routes/RunShell.tsx:134), [RunList.tsx:508](/Users/rabindrabiswal/Workspace/perf-dashboard/apps/web/src/routes/RunList.tsx:508).

### C03 — The global time-window control implies a scope that several sections do not honor

**Observed and source-confirmed.** On Errors, select 10–30 seconds. The page announces that window and narrows the error series, but the error table retains whole-run counts of **15 + 9 = 24**. On Trends, the same control accepts 10–30 seconds, although the historical query does not consume that window. Compare is also rendered under the same selector without windowed comparison queries.

**Fix:** Hide the run-time selector from whole-run historical views. For Errors, either support windowed error aggregation or explicitly label the table “Whole-run error totals — unaffected by time selection.” Display each measure's scope next to its title. Apply the same distinction to assertions and exports.

**Acceptance:** Every visible “Showing 10–30s” message identifies which sections it affects. No unqualified whole-run table appears to be a windowed result.

Source: [RunDetail.tsx:606](/Users/rabindrabiswal/Workspace/perf-dashboard/apps/web/src/routes/RunDetail.tsx:606), [RunShell.tsx:210](/Users/rabindrabiswal/Workspace/perf-dashboard/apps/web/src/routes/RunShell.tsx:210), [RunTrends.tsx:70](/Users/rabindrabiswal/Workspace/perf-dashboard/apps/web/src/routes/RunTrends.tsx:70), [RunCompare.tsx:121](/Users/rabindrabiswal/Workspace/perf-dashboard/apps/web/src/routes/RunCompare.tsx:121).

### C04 — Changing analysis tabs clears the selected interval

**Observed and source-confirmed.** After applying 10–30s, opening Trends or Charts clears the From/To inputs. The tab links use paths without the query string. Request/group links similarly lead to unwindowed detail queries. The engineer's selected incident interval is lost while following evidence.

**Fix:** Preserve supported time parameters across run tabs and scoped details, and restore them on return. Where a destination intentionally uses whole-run data, state that boundary while retaining the investigation context for the return journey.

**Acceptance:** Overview → Charts → Errors → request → Back keeps the chosen interval wherever applicable. Browser Back restores filters and the relevant row/scroll position.

Source: [RunTabs.tsx:98](/Users/rabindrabiswal/Workspace/perf-dashboard/apps/web/src/routes/RunTabs.tsx:98), [RequestDetail.tsx:70](/Users/rabindrabiswal/Workspace/perf-dashboard/apps/web/src/routes/RequestDetail.tsx:70), [GroupDetail.tsx:111](/Users/rabindrabiswal/Workspace/perf-dashboard/apps/web/src/routes/GroupDetail.tsx:111).

### C05 — The release panel breaks at a normal 1024px desktop breakpoint

**Observed and source-confirmed.** At 1024px the sidebar is present and the verdict panel switches to three columns. Its large word and action column consume nearly all available width. The explanatory text becomes a thin vertical strip and overlaps the action area. The panel measured approximately **395px tall**, before the time selector and actual data.

**Fix:** Use a compact decision strip with a bounded title and flexible explanation. Base its layout on available content width, not the viewport breakpoint that also introduces the sidebar. Stack the explanation/actions before they collide.

**Acceptance:** No overlapping text at 1024×900 or 1280×800, with long status labels and large text. Test content width with the sidebar both expanded and collapsed.

Source: [RunDecisionBand.tsx:69](/Users/rabindrabiswal/Workspace/perf-dashboard/apps/web/src/routes/RunDecisionBand.tsx:69). [1024px evidence](/Users/rabindrabiswal/Workspace/perf-dashboard/docs/ui-review-2026-09-12/11-1024-verdict.png), [1280px evidence](/Users/rabindrabiswal/Workspace/perf-dashboard/docs/ui-review-2026-09-12/07-laptop-verdict.png).

### C06 — Comparison eligibility does not establish experiment comparability

**Source-confirmed; populated comparison not available in this account.** The cohort query groups completed runs by project/test. It does not constrain environment, workload, target configuration or branch. The picker labels primarily identify run time, while the summary calls one run “Best selected.” The same simulation can run against staging and production, or at very different offered loads.

**Fix:** Show a comparability summary before interpretation: environment, build/commit, duration, load profile, target and generator configuration where recorded. Default to a relevant cohort and visibly flag differences. Missing metadata must read “Unknown,” not “Compatible.” Allow intentional cross-configuration comparison.

**Acceptance:** A lower p95 at substantially lower load is not presented as an unqualified improvement. Cross-environment selections are visibly identified.

Source: [trends.ts:99](/Users/rabindrabiswal/Workspace/perf-dashboard/packages/persistence/src/metrics/trends.ts:99), [RunCompare.tsx:111](/Users/rabindrabiswal/Workspace/perf-dashboard/apps/web/src/routes/RunCompare.tsx:111), [compareSummary.ts:41](/Users/rabindrabiswal/Workspace/perf-dashboard/apps/web/src/routes/compareSummary.ts:41).

### C07 — Comparison percentile populations differ between the overlay and summary

**Source-confirmed; requires a populated comparison regression fixture.** The overlay uses `bucket.percentilesOk`; the matrix and summary use the statistics row's `percentiles`. These are different sources/populations, not just different aggregation periods. In addition, the overlay's max branch sits after an empty-OK-percentiles guard, so a bucket with no successful responses can lose its maximum even when failed requests have timings.

**Fix:** Explicitly identify successful/all/failed response populations and align the chart, summary and matrix with the selected population. Treat combined extrema separately when the source cannot provide outcome-specific extrema. Preserve failed-only bucket maxima when displaying combined maximum latency.

**Acceptance:** A comparison fixture with slow failures and failed-only buckets retains those measurements and makes population differences explicit. Do not average bucket percentiles to create a whole-run percentile.

Source: [compare.ts:88](/Users/rabindrabiswal/Workspace/perf-dashboard/apps/web/src/charts/transforms/compare.ts:88), [buildCompareMatrix.ts:57](/Users/rabindrabiswal/Workspace/perf-dashboard/apps/web/src/tables/buildCompareMatrix.ts:57), [compareSummary.ts:28](/Users/rabindrabiswal/Workspace/perf-dashboard/apps/web/src/routes/compareSummary.ts:28).

### C08 — An invalid time range silently resets analysis to the whole run

**Source-confirmed.** `TimeBrush.apply()` calls `onChange(null)` for nonnumeric, negative, or reversed input. Typing From=30 and To=10 therefore requests a scope reset instead of validation. This interaction was submitted, but the final browser state was blocked by the usage limit.

**Fix:** Keep the previous valid window, retain the draft inputs, and show a field-linked error: “End must be later than start.” Validate bounds and make clamping visible. Use a form so Enter applies the selection.

**Acceptance:** Invalid input never broadens the analysis scope silently. Errors are visible and programmatically associated with the affected fields.

Source: [TimeBrush.tsx:93](/Users/rabindrabiswal/Workspace/perf-dashboard/apps/web/src/charts/TimeBrush.tsx:93).

### C09 — An empty SLA threshold becomes a real zero threshold

**Source-confirmed; no rule submitted.** The form passes `Number(threshold)` to validation. An empty string or whitespace becomes `0`. The input is not required, and the schema accepts finite numeric values, so a missing threshold can become an unintended gate.

**Fix:** Reject blank text before numeric conversion; require an explicit value. Keep zero valid when deliberately entered. Validate units and metric-specific bounds without conflating absence with zero.

**Acceptance:** Empty/whitespace thresholds cannot create a rule. An explicitly entered zero is preserved if valid for that metric.

Source: [ProjectRules.tsx:172](/Users/rabindrabiswal/Workspace/perf-dashboard/apps/web/src/routes/ProjectRules.tsx:172), [ProjectRules.tsx:357](/Users/rabindrabiswal/Workspace/perf-dashboard/apps/web/src/routes/ProjectRules.tsx:357), [rules.ts:202](/Users/rabindrabiswal/Workspace/perf-dashboard/packages/contracts/src/rules.ts:202).

## Major findings

### M01 — Overview puts decision evidence far below decorative and explanatory content

**Observed.** At 1440×900, the parity run's time selector starts around y=483 and is about 460px tall. Run totals begin at **y=1570** and Statistics at **y=1745**. Even three simulation assertions push the main numbers well past the first screen. The assertion corpus pushes them much farther.

**Fix / acceptance:** Put headline p95, p99, error rate, throughput, sample count and duration directly below a compact context/decision header. Show failed checks next; collapse passed checks. At 1440×900 the essential metrics and first actionable failure should be visible without scrolling.

Source: [RunShell.tsx:127](/Users/rabindrabiswal/Workspace/perf-dashboard/apps/web/src/routes/RunShell.tsx:127), [RunDetail.tsx:507](/Users/rabindrabiswal/Workspace/perf-dashboard/apps/web/src/routes/RunDetail.tsx:507). [Overview](/Users/rabindrabiswal/Workspace/perf-dashboard/docs/ui-review-2026-09-12/04-run-overview.png).

### M02 — Run rows cannot support performance triage

**Observed.** The organization list contains Started, Project, Simulation, Status, Verdict and Focus, but no latency, errors, throughput, environment or baseline delta. “review” in Focus is plain text, not a direct action. Engineers must open each run to discover whether it is interesting.

**Fix / acceptance:** Add a configurable core column set: run/build identity, environment, execution/check status, p95, error rate, achieved throughput, duration, and delta against a named baseline. Show unavailable data explicitly. Provide Compare and investigate actions. Keep advanced columns optional.

Source: [RunList.tsx:240](/Users/rabindrabiswal/Workspace/perf-dashboard/apps/web/src/routes/RunList.tsx:240), [RunList.tsx:851](/Users/rabindrabiswal/Workspace/perf-dashboard/apps/web/src/routes/RunList.tsx:851).

### M03 — Large health cards summarize only the current page

**Observed.** The UI honestly explains that paging changes the counts, but then gives those local counts prominent dashboard-card treatment. An organization health overview should not change meaning when the user presses Next.

**Fix / acceptance:** Either calculate totals across the filtered result set and label the time range, or reduce this to a compact “On this page” summary beside pagination. Do not put a page-local mini-dashboard above the actual work list.

Source: [RunList.tsx:508](/Users/rabindrabiswal/Workspace/perf-dashboard/apps/web/src/routes/RunList.tsx:508).

### M04 — Test history opens with configuration rather than history

**Observed.** Opening ParitySimulation's test page places Rename/Delete and a fully expanded SLA authoring form above the run history. The page users visit repeatedly to inspect results prioritizes occasional administration.

**Fix / acceptance:** Use test navigation for Runs, Trends and Rules/Settings. Default to Runs with recent performance context. Keep Delete in a clearly separated administrative area. A test page should expose its latest run immediately.

Source: [TestRuns.tsx:210](/Users/rabindrabiswal/Workspace/perf-dashboard/apps/web/src/routes/TestRuns.tsx:210). [Test history](/Users/rabindrabiswal/Workspace/perf-dashboard/docs/ui-review-2026-09-12/03-test-history.png).

### M05 — Baseline selection is implicit, and a zero baseline is mislabeled as missing

**Source-confirmed.** The comparison baseline is the first selected non-current run. There is no explicit baseline role selector. A baseline value of zero produces `deltaPercent=null`, displayed as “Waiting for baseline,” even though the baseline exists. This is especially relevant when errors rise from zero.

**Fix / acceptance:** Let the engineer explicitly designate a baseline. Show its identity and absolute values. Display “0 → 2 errors/s; relative change undefined” instead of waiting. Selection order must not silently redefine the baseline.

Source: [compareSummary.ts:40](/Users/rabindrabiswal/Workspace/perf-dashboard/apps/web/src/routes/compareSummary.ts:40), [RunCompare.tsx:315](/Users/rabindrabiswal/Workspace/perf-dashboard/apps/web/src/routes/RunCompare.tsx:315).

### M06 — Shared comparison links omit the selected metric

**Source-confirmed.** Run selection is stored in `?runs=`, but the metric is component state initialized to p95. A colleague opening a link to an errors comparison receives p95 instead. Baseline role is also not explicit URL state.

**Fix / acceptance:** Serialize metric, response population and baseline alongside selected runs. Reload and a second session should reconstruct the same analytical question.

Source: [RunCompare.tsx:49](/Users/rabindrabiswal/Workspace/perf-dashboard/apps/web/src/routes/RunCompare.tsx:49).

### M07 — “Compare previous” promises a comparison that may not exist

**Observed and source-confirmed.** Both demo runs show the action, but each lands on “Nothing to compare yet.” Separately, the default-selection code can choose a newer neighbor for the oldest run, which conflicts with the word “previous.”

**Fix / acceptance:** Use “Compare runs” unless a specific previous run is known. Offer “Compare with [run/build]” when eligible; otherwise explain the unavailable action or direct the user to the next useful step. Keep the Compare destination discoverable.

Source: [RunDecisionBand.tsx:172](/Users/rabindrabiswal/Workspace/perf-dashboard/apps/web/src/routes/RunDecisionBand.tsx:172), [compareSelection.ts:105](/Users/rabindrabiswal/Workspace/perf-dashboard/apps/web/src/routes/compareSelection.ts:105).

### M08 — Request and group details drop the identity of the experiment

**Observed on request; source-confirmed on group.** Search opens with only “Back to this run” and “Search.” The run, build, environment and timestamp disappear. Two Search pages from different runs become difficult to distinguish. The global project rail also lacks the run context.

**Fix / acceptance:** Keep a compact breadcrumb and run context: Project → Test → Run/build → Request/group. Include environment, date and analysis window. A screenshot or browser tab should be identifiable without retracing navigation.

Source: [RequestDetail.tsx:99](/Users/rabindrabiswal/Workspace/perf-dashboard/apps/web/src/routes/RequestDetail.tsx:99), [GroupDetail.tsx:144](/Users/rabindrabiswal/Workspace/perf-dashboard/apps/web/src/routes/GroupDetail.tsx:144).

### M09 — Error diagnosis stops at message counts

**Observed.** Errors shows HTTP-check messages, count and share, but neither row links to affected requests or a time interval. The engineer must manually rediscover the failing operation in Statistics. “Errors (2)” counts distinct messages while run totals show 24 failed requests; the tab label does not explain the count type.

**Fix / acceptance:** Label “2 error types · 24 failed requests” and provide affected-request drilldowns, occurrence interval and copyable details where the captured data supports them. Unavailable dimensions should be named, not invented.

Source: [ErrorsTable.tsx:139](/Users/rabindrabiswal/Workspace/perf-dashboard/apps/web/src/tables/ErrorsTable.tsx:139), [RunTabs.tsx:110](/Users/rabindrabiswal/Workspace/perf-dashboard/apps/web/src/routes/RunTabs.tsx:110).

### M10 — Simulation assertions are a raw report instead of an investigation surface

**Observed.** The assertion corpus is a long, unfiltered list of prose with a bare Actual column. Values like 2643 and 100 lack per-row units. Failed Search is text, not a link. The parity run shows two passing checks before its failing check.

**Fix / acceptance:** Default to failed first; offer Failed/Passed/N/A filters and a compact passed disclosure. Use columns for target, metric, operator, threshold with unit, actual with unit, and outcome. Link request/group targets to their evidence. Preserve original tool wording in expandable detail.

Source: [RunDetail.tsx:1128](/Users/rabindrabiswal/Workspace/perf-dashboard/apps/web/src/routes/RunDetail.tsx:1128).

### M11 — Statistics exposes too many columns without enough semantic structure

**Observed and source-confirmed.** The default table puts roughly fifteen columns in view, uses Gatling abbreviations such as KO and Cnt/s, and places request and group rows together. The scoped one-row table drops the run table's visible Response Time (ms) group heading. Engineers must remember both units and whether a row represents a request or an aggregate group.

**Fix / acceptance:** Default to Requests, Failures, Error %, RPS, p50, p95, p99 and max; expose remaining columns through a selector. Use visible request/group types and metric-family labels. Show milliseconds in scoped table headers. Do not imply that group totals can be added to request totals.

Source: [StatisticsTable.tsx:647](/Users/rabindrabiswal/Workspace/perf-dashboard/apps/web/src/tables/StatisticsTable.tsx:647), [ScopedStatistics.tsx:56](/Users/rabindrabiswal/Workspace/perf-dashboard/apps/web/src/tables/ScopedStatistics.tsx:56).

### M12 — Charts are organized as a report inventory, not a diagnostic sequence

**Observed.** On the 1440px viewport, nine analysis charts follow a separate full-size time-selector chart in a single column. Aggregate ranges and a large OK/KO donut precede latency-over-time. To correlate offered load, throughput, latency and errors, the user scrolls through unrelated aggregate views. Percentiles default to six lines, logarithmic scale, OK-only quantiles and combined extrema; a footnote carries the population caveat.

**Fix / acceptance:** Lead with synchronized load, throughput, p95/p99 and error time series. Put distributions under a secondary view. Make response population and scale prominent; select fewer default bands. Preserve the existing shared time-axis behavior. Reduce the brush to a short navigator.

Source: [RunDetail.tsx:855](/Users/rabindrabiswal/Workspace/perf-dashboard/apps/web/src/routes/RunDetail.tsx:855), [PercentilesChart.tsx:48](/Users/rabindrabiswal/Workspace/perf-dashboard/apps/web/src/charts/PercentilesChart.tsx:48). [Chart stack](/Users/rabindrabiswal/Workspace/perf-dashboard/docs/ui-review-2026-09-12/05-charts.png).

### M13 — “Export run” substantially overstates its payload

**Source-confirmed.** The button exports identity, execution state/verdict and platform assertions. It does not include the headline statistics, errors, simulation assertions, chart evidence or selected interval. Its name suggests a complete run artifact.

**Fix / acceptance:** Rename the existing action “Export SLA summary (JSON),” or implement an export menu with explicit content and format choices. A review report should include context, measurement scope, metrics, failures and baseline identity. The export must disclose omissions.

Source: [runExport.ts:4](/Users/rabindrabiswal/Workspace/perf-dashboard/apps/web/src/routes/runExport.ts:4), [RunDecisionBand.tsx:58](/Users/rabindrabiswal/Workspace/perf-dashboard/apps/web/src/routes/RunDecisionBand.tsx:58).

### M14 — The provided upload command is not directly runnable

**Observed and source-confirmed.** Project setup's curl example ends in `/v1/runs`, with no scheme or host. A shell does not resolve this against the page origin. The visible onboarding recipe cannot be copied and run as presented.

**Fix / acceptance:** Render a complete instance URL or define a BASE_URL variable immediately above the command. Add Copy command and the bundle-format prerequisites. Validate the displayed recipe with a disposable fixture when implementing; no command was executed during this audit.

Source: [ProjectSetup.tsx:252](/Users/rabindrabiswal/Workspace/perf-dashboard/apps/web/src/routes/ProjectSetup.tsx:252). [Setup](/Users/rabindrabiswal/Workspace/perf-dashboard/docs/ui-review-2026-09-12/08-setup.png).

### M15 — Setup mixes unrelated jobs and hides import behind credentials

**Observed.** API-token creation, test ingestion instructions, token management and SLA rules share one page. The only route for completed-report import is a shell example. “New on-prem run” is the prominent action even when an engineer already has a result bundle to analyze.

**Fix / acceptance:** Provide explicit entry choices: Import results, Run test, Configure CI. Separate Rules from Integrations/Access in project navigation. A completed-report import can be a later feature; immediately give it a clear guide and status rather than burying it in token management.

Source: [ProjectSetup.tsx:169](/Users/rabindrabiswal/Workspace/perf-dashboard/apps/web/src/routes/ProjectSetup.tsx:169), [ProjectTests.tsx:73](/Users/rabindrabiswal/Workspace/perf-dashboard/apps/web/src/routes/ProjectTests.tsx:73).

### M16 — The launch form does not establish execution readiness

**Observed and source-confirmed.** The page provides a static “Node policy” panel saying one active job, but no visible connected-runner health, capacity, compatibility or expected queue readiness. Target/load parameters are generic system properties. Advanced JVM and commit fields compete with the basic launch path. Test is a free-text slug that can silently create a different test when mistyped.

**Fix / acceptance:** Group the form into artifact, execution configuration and review. Show current runner availability where supported, with explicit unknown/unavailable states. Select existing tests with a separate “Create test” path. Summarize target/load values when the artifact contract exposes them; do not assume every simulation uses the same properties.

Source: [NewRunnerRun.tsx:195](/Users/rabindrabiswal/Workspace/perf-dashboard/apps/web/src/routes/NewRunnerRun.tsx:195). [New run](/Users/rabindrabiswal/Workspace/perf-dashboard/docs/ui-review-2026-09-12/09-new-run.png).

### M17 — SLA authoring requires internal vocabulary and exact-name knowledge

**Observed and source-confirmed.** Family, Scope and raw metric identifiers expose the data model. Request targets are free text even when recorded requests already exist. `error_rate` is deliberately labeled as a fraction, but engineers see percentages elsewhere and must convert. Validation messages include schema paths rather than field-specific guidance.

**Fix / acceptance:** Use metric names with visible units, a recorded-target picker plus an explicit custom target option, and a sentence preview such as “Search p95 must be ≤ 800 ms.” Accept error rate in percent and convert internally. Preserve custom percentiles. Show inherited project rules separately from test rules and explain when new rules take effect.

Source: [ProjectRules.tsx:172](/Users/rabindrabiswal/Workspace/perf-dashboard/apps/web/src/routes/ProjectRules.tsx:172), [ProjectRules.tsx:285](/Users/rabindrabiswal/Workspace/perf-dashboard/apps/web/src/routes/ProjectRules.tsx:285), [rules.ts:101](/Users/rabindrabiswal/Workspace/perf-dashboard/packages/contracts/src/rules.ts:101).

### M18 — Mobile hides the useful summary behind several screens of chrome and explanation

**Observed.** At 375px the first run table begins around **y=1123**. On the parity overview, totals begin around **y=2274**. At 320px they start around y=2500. Deep analysis uses a “desktop task” gate, but its promised headline summary is itself far down the page. This is primarily a hierarchy problem; the measured root did not overflow horizontally.

**Fix / acceptance:** Provide a compact mobile run summary: identity, decision, failed checks, p95, errors and one trend. Collapse filters by default and use concise run cards. Keep advanced analysis opt-in, with neutral wording such as “Open detailed table.” The basic decision must fit in the initial mobile screen.

Source: [RunList.tsx:519](/Users/rabindrabiswal/Workspace/perf-dashboard/apps/web/src/routes/RunList.tsx:519), [DesktopOnly.tsx:63](/Users/rabindrabiswal/Workspace/perf-dashboard/apps/web/src/routes/DesktopOnly.tsx:63). [Mobile list](/Users/rabindrabiswal/Workspace/perf-dashboard/docs/ui-review-2026-09-12/10-mobile-runs.png).

### M19 — The shell omits organization and signed-in identity

**Observed and source-confirmed.** The header provides a brand, three theme choices and Sign out, but no organization name, current user or role. In an enterprise tool, engineers need to know which tenant and authority they are using before configuring gates or launching tests.

**Fix / acceptance:** Show organization context and an account menu with identity and role if available. Keep theme selection in that menu or another secondary area. Add organization switching only if the account model supports it; do not invent multi-tenant UI capabilities.

Source: [AppShell.tsx:77](/Users/rabindrabiswal/Workspace/perf-dashboard/apps/web/src/AppShell.tsx:77).

### M20 — Empty states explain absence but rarely provide the next action

**Observed.** “No SLA rules were evaluated” has no direct Rules link. Empty telemetry says no generator reported but gives no setup or troubleshooting route. Empty comparison says another run is needed but offers no contextual route to launch/import. These are valid data states with incomplete workflows.

**Fix / acceptance:** Give each state one appropriate action: Configure rules, Open telemetry setup, Run again or Import results. Distinguish not configured, no samples in the selected interval, no historical data and failed retrieval. State when a change affects only future runs.

Source: [RunDetail.tsx:925](/Users/rabindrabiswal/Workspace/perf-dashboard/apps/web/src/routes/RunDetail.tsx:925), [RunTelemetry.tsx:179](/Users/rabindrabiswal/Workspace/perf-dashboard/apps/web/src/routes/RunTelemetry.tsx:179), [RunCompare.tsx:226](/Users/rabindrabiswal/Workspace/perf-dashboard/apps/web/src/routes/RunCompare.tsx:226).

### M21 — Timestamps omit timezone and hide useful precision

**Observed and source-confirmed.** Started is rendered as a local date and minute without timezone. Two engineers can see different wall times for the same run, and multiple runs within one minute are hard to distinguish. Duration uses raw seconds, which becomes harder to scan for long soak tests.

**Fix / acceptance:** Show the active timezone near date controls and expose an exact ISO timestamp on demand. Include build/short ID beside run time. Format long durations as h/m/s while retaining exact duration in details/export.

Source: [format.ts:30](/Users/rabindrabiswal/Workspace/perf-dashboard/apps/web/src/routes/format.ts:30), [RunHeader.tsx:278](/Users/rabindrabiswal/Workspace/perf-dashboard/apps/web/src/routes/RunHeader.tsx:278).

### M22 — Navigation can land the engineer partway down an unrelated detail page

**Observed; source corroborates absence of route-level restoration in the app shell.** After using the long chart page and opening a request, the screenshot initially showed lower request charts rather than its heading. An explicit scroll to the top was required to inspect identity. This deserves a focused browser regression test; it is distinct from preserving a deliberate return-to-list position.

**Fix / acceptance:** On navigation to a new run/request/group, place the viewport and keyboard focus at its heading. On Back, restore the prior list/analysis position. Preserve scroll when switching tabs only if the selected context remains visible and meaningful.

Source: [AppShell.tsx:111](/Users/rabindrabiswal/Workspace/perf-dashboard/apps/web/src/AppShell.tsx:111), [RequestDetail.tsx:99](/Users/rabindrabiswal/Workspace/perf-dashboard/apps/web/src/routes/RequestDetail.tsx:99).

### M23 — The project test catalog gives little useful differentiation

**Observed; scale concerns source-confirmed but not exercised with a large project.** Test name and simulation class repeat the same long string in both rows. Latest run shows status badges without its date or performance summary. There is no catalog search or environment/performance filter. The page is a thin directory rather than a useful test overview.

**Fix / acceptance:** Emphasize a human-readable test name, put class in secondary text, and show latest run date, p95, error rate and check status. Add search and filtering when catalog size warrants it. Keep run count and a direct latest-run action.

Source: [ProjectTests.tsx:126](/Users/rabindrabiswal/Workspace/perf-dashboard/apps/web/src/routes/ProjectTests.tsx:126). [Test catalog](/Users/rabindrabiswal/Workspace/perf-dashboard/docs/ui-review-2026-09-12/02-project-tests.png).

## Minor findings

### m01 — Small uppercase mono text is overused

**Observed/design assessment.** Status pills use 10px uppercase mono text; table labels use 11px uppercase mono. Metadata and repeated eyebrows receive the same treatment. This makes an analytical tool feel like a collection of tiny instrument labels and consumes width without improving information density.

**Fix:** Use sentence-case 12–13px labels and a consistent readable body scale. Reserve mono for identifiers and appropriate numeric columns. Retain tabular numerals. This is a readability assessment, not a claim that the existing palette fails measured contrast requirements.

Source: [Badge.tsx:66](/Users/rabindrabiswal/Workspace/perf-dashboard/apps/web/src/components/Badge.tsx:66), [tableStyles.ts:89](/Users/rabindrabiswal/Workspace/perf-dashboard/apps/web/src/components/tableStyles.ts:89). Hallmark tell: excessive eyebrow/label treatment.

### m02 — Explanatory paragraphs replace concise labels and contextual help

**Observed/design assessment.** Most tables begin with a paragraph explaining ingestion behavior, pagination semantics or percentile internals. The information is useful, but it competes with the data on every visit. Multiple rounded/bordered containers repeat the same visual weight.

**Fix:** Use a short caption and visible scope/unit labels. Put calculation details in a focused help disclosure. Reserve strong containers for distinct tasks, not every subregion. Preserve accessible descriptions without making a whole paragraph the table's only practical name.

Source: [RunList.tsx:205](/Users/rabindrabiswal/Workspace/perf-dashboard/apps/web/src/routes/RunList.tsx:205), [ProjectTests.tsx:126](/Users/rabindrabiswal/Workspace/perf-dashboard/apps/web/src/routes/ProjectTests.tsx:126), [States.tsx:93](/Users/rabindrabiswal/Workspace/perf-dashboard/apps/web/src/components/States.tsx:93). Hallmark tell: repeated container rhythm / centered empty-state treatment.

### m03 — Form labels and heading levels need a semantic cleanup

**Observed and source-confirmed.** Optional field accessible names are concatenated as “Environmentoptional” and “Gatling versionoptional.” Setup and runner pages jump from h1 to Card's h3. These are avoidable accessibility navigation and polish issues, even though the forms do have associated labels.

**Fix:** Use “Environment (optional)” and separate help text with `aria-describedby`. Let Card accept the correct heading level. Verify keyboard flow and announcements with a screen reader during implementation.

Source: [NewRunnerRun.tsx:353](/Users/rabindrabiswal/Workspace/perf-dashboard/apps/web/src/routes/NewRunnerRun.tsx:353), [Card.tsx:75](/Users/rabindrabiswal/Workspace/perf-dashboard/apps/web/src/components/Card.tsx:75).

### m04 — Chart copy sometimes describes the wrong concept

**Observed and source-confirmed.** The 3-second assertion-corpus run says it is “long enough” to require 3000ms buckets. The data may legitimately have that resolution, but the explanation invents a reason from bucket width alone. Request detail chart titles say “Number of requests/responses” while their axes represent rates.

**Fix:** Say “Data resolution: 3 seconds; shorter spikes may be hidden.” Name rate charts “Requests/s” and “Responses/s.” State the recorded fact without inferring why the producer chose it.

Source: [rates.ts:111](/Users/rabindrabiswal/Workspace/perf-dashboard/apps/web/src/charts/transforms/rates.ts:111), [RequestDetail.tsx:31](/Users/rabindrabiswal/Workspace/perf-dashboard/apps/web/src/routes/RequestDetail.tsx:31).

## Proposed interface structure

The intended visual character should be a restrained analytical workspace: readable typography, compact controls, clear units, one primary action per task, and color used for outcomes and selected state. The existing neutral surfaces and orange accent can support that. Changing the brand palette or adding gradients is not the priority.

**Application shell:** organization/project context at the top; a compact project navigator; account menu on the right. Within a project, persistent destinations for Tests, Runs, Rules and Integrations. Runner availability should appear where execution is configured.

**Runs:** concise title/count/action row → compact filter toolbar → run table. Optional health summary belongs beside filters and must clearly state its scope. Support result import and run creation as distinct tasks.

**Test:** identity and short description → latest result and trend → Runs / Trends / Rules / Settings. Keep mutation forms out of the default history view.

**Run overview, in reading order:**

1. Project/test/run identity, environment, build, timestamp, duration.
2. Compact execution/platform-gate/simulation-check summary, with a link to each failed check.
3. p95, p99, error %, throughput, request count and load context; deltas only against a named relevant baseline.
4. Failed-check evidence and top affected requests.
5. Short time navigator and synchronized diagnostic charts.
6. Request/group statistics with configurable columns.
7. Passed checks, advanced distributions, raw artifacts and calculation details behind appropriate disclosures.

**Comparison:** explicit current run and baseline → compatibility differences → metric/population/window controls → absolute values and deltas → overlay → per-request regression table. Serialize the complete analysis state. Keep unknown, zero and missing measurements distinct.

**Request/group:** retain the run context and interval; show scoped metrics and failures first; then latency/load evidence. Link related requests/errors instead of sending the reader back to a generic report.

## Suggested implementation order

| Phase | Deliverable | Findings | Exit condition |
|---|---|---|---|
| 1. Trust and correctness | Correct scope copy, simulation failure visibility, time-window semantics, threshold validation, comparison population/compatibility | C01–C09 | Known failing data cannot appear successful or silently change analytical scope. |
| 2. Daily investigation | Compact run header, useful run table, persistent context, diagnostic chart order, explicit baseline | M01–M12, M18, M21–M23 | An engineer can identify and investigate the parity run's Search failure with a short, coherent path. |
| 3. Setup and communication | Separate setup workflows, actionable empty states, clear launch readiness, useful sharing/export | M13–M17, M19–M20 | Import/launch/setup instructions are concrete; a shared view reconstructs the same evidence. |
| 4. Design-system polish | Type scale, labels, captions, headings, consistent responsive components | m01–m04 | Both themes and target widths are visually and semantically verified. |

These are dependencies, not time estimates. Start in existing components and routes; a framework rewrite is not justified by this review.

## Verification plan for the repair work

Create controlled fixtures covering: failed simulation checks with no platform rules; platform-gate failure with successful execution; zero-error baseline versus a regressed run; a request with zero errors inside a run with failures; all-failure time buckets; known errors inside and outside a chosen interval; the same test with different environment/load metadata; long names; empty and large histories; missing telemetry; failed API responses; active/finalizing/incomplete runs.

Verify the important journeys end to end: list triage → run → failure → request → return; choose interval → change tabs → drill down; choose baseline/metric → copy link → reopen; import/setup instruction → valid result; create rule with blank/zero/percentage thresholds; keyboard-only navigation through chart controls and forms. Validate actual chart data in addition to rendered presence.

Use 1440×900 and 1280×800 as primary desktop checks, 1024px as a critical sidebar breakpoint, 768px tablet, and 320/375/414px compact checks. Check zoom/large text separately. Test light and dark themes and chart colors. Local horizontal scrolling for a wide table is acceptable if the row identity and scope remain usable; hiding overflow is not a fix for inaccessible content.

## Existing strengths worth retaining

- The UI uses real tables, labels, navigation regions, status text and a skip link.
- Charts expose data-table, CSV, JSON and full-screen affordances; their execution still needs live verification.
- Numeric tables already use tabular figures and right alignment.
- Search filtering is server-oriented and URL-backed; observed no-results recovery worked.
- Distinct missing-data states, explicit denominator explanations, simulation assertions and separate metric families provide a useful domain foundation.
- The React/Tailwind/ECharts implementation has shared tokens, components and route boundaries suitable for incremental correction.

Enterprise capabilities such as SSO, role administration, immutable policy history, audit trails, retention and approval/report workflows should receive a separate requirements and authorization review. Their absence from this demo UI is not proof that every related backend capability is missing. No security or backend performance certification is implied by this audit.

**Verdict:** useful analytical functionality with significant trust and workflow defects. Fix the meaning and reading order first, then refine the visual system. **9 critical · 23 major · 4 minor.**
