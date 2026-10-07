<!-- Hallmark · pre-emit critique: P5 H5 E4 S5 R4 V4 -->
# PerfPortal UI/UX review — 13 September 2026

The application has improved since the previous review, but it still reads like documentation surrounding a dashboard. The primary problem is information hierarchy: repeated explanations and neutral statuses occupy the space where an engineer needs latency, errors, throughput, and failed checks. Reducing font size would make this worse. Remove repetition, clarify scope through labels, and put evidence before configuration guidance.

**28 findings: 6 critical · 18 major · 4 minor.** These are UX review priorities, not security severity ratings. Critical means misleading analytical information, a broken investigation interaction, or an accessibility defect in a shared control. Major means substantial friction or a production workflow gap. Minor means localized consistency or copy polish.

## Scope and evidence

Reviewed the authenticated local application at `http://localhost:3000`, using the supplied M17 account, against repository HEAD `0c91fe3`. Inspected Runs, project tests, Add results, SLA rules, Access, the launch form, run overview, Charts, Errors, Load generators, Trends, and Compare. Tested a 10–30 second window, cross-tab window persistence, rule draft/validation, and theme switching. Read relevant source to verify causes. No rules, tokens, projects, or jobs were created; no load was launched. Theme and viewport were restored.

Primary desktop viewport: 1440×900. Visually inspected 375px mobile and desktop light/dark themes. Checked overview document width at 320, 414, 768, and 1024px; these checks found no page-level horizontal overflow. They are not a complete interaction audit at each width. Wide tables still need local scrolling tests with real devices and assistive technology.

The account has one completed run, no configured SLA rules, and no recorded generator telemetry. Populated multi-run comparisons, live runs, runner failure/recovery, token creation/revocation, and server error states were not exercised. This review cannot certify every state or production readiness. It is a concrete backlog from the available workflows, not a security, scalability, or WCAG conformance audit.

Evidence images: [Runs](01-runs.png), [desktop overview](02-overview-desktop.png), [Add results](03-add-results.png), [rules](04-rules.png), [launch](05-launch.png), [errors](06-errors.png), [mobile overview](07-mobile.png), [light theme](08-light.png).

## What improved since the previous review

| Improvement observed | Remaining work |
|---|---|
| Run rows now include p95, error rate, and environment | The health explanation is stale, and the investigation hint is not actionable |
| Simulation assertions now show target, metric, bound, and actual | Raw assertion prose duplicates the structured fields; target is not a drill-down |
| Add results, SLA rules, and Access are separate destinations | Configuration navigation is inconsistent outside those destinations |
| Rule authoring offers recorded targets and a sentence preview | Empty-target previews are misleading; lifecycle explanations conflict |
| Setup curl examples use an absolute local origin | Import still requires terminal work; all setup instructions are expanded together |
| Mobile overview fits the page width | Metadata and the decision panel still consume the first screen |
| Window selection survives run-section navigation | The compact navigator chart is visually broken |
| Compare explains the one-run state | Its call to action does not take the user toward adding a second result |

## Critical findings

### C01 — Failed simulation check is visually subordinate to “Not evaluated”

**Where:** `apps/web/src/routes/RunDecisionBand.tsx:102–253`; overview and other run sections. **Tell:** competing hierarchy and duplicated status.

The sample run has a failed Search check: p95 **1939.53 ms**, bound **<100 ms**. The dominant panel instead says “NOT EVALUATED,” repeats the badge and zero counts, and displays an unqualified **Failed 0** alongside “Simulation checks 1 failed.” These counts represent different systems, but require reading prose to reconcile. A fast scan can miss the actual failure.

**Fix:** show three compact, explicitly named outcomes: `Execution: Completed`, `SLA: Not configured`, `Simulation checks: 1 failed`. Give the failure the strongest attention signal. Remove empty SLA count tiles. Do not relabel simulation failures as a platform release verdict.

**Accept when:** someone can identify the failed check and distinguish it from SLA evaluation without opening help or reading a paragraph.

### C02 — Compact time navigator has almost no usable plot height

**Where:** `apps/web/src/charts/Chart.tsx:674–739,930`. **Tell:** compressed data visualization.

The navigator is reduced to a 160px canvas, but retains bottom space for a legend that is hidden, plus brush and axis bands. Y-axis ticks collide and the plotted data becomes a thin stripe. Confirmed in dark and light screenshots.

**Fix:** calculate navigator-specific gutters and omit space for absent controls. Preserve enough plot height for readable ticks; a navigator does not need the full chart toolbar or full analytical axis treatment.

**Accept when:** tick labels do not overlap at desktop/mobile sizes and selecting a time range remains clear with keyboard and pointer controls.

### C03 — “Configure rules” opens the wrong destination

**Where:** `apps/web/src/routes/RunDetail.tsx:1014–1021`. **Tell:** broken task continuation.

Clicking “Configure rules for this project” opens `/projects/web-demo/setup`, now titled **Add results**, rather than `/projects/web-demo/rules`. Source still uses `projectSetupPath`.

**Fix:** link directly to project rules. Preserve the explanation that new rules do not retroactively change this historical run.

**Accept when:** one click opens the correct project's rule authoring screen.

### C04 — Failed-check link changes the fragment without revealing the check

**Where:** `RunDecisionBand.tsx`, run routing/scroll handling, `RunDetail.tsx:1230,1266`. **Tell:** broken investigation shortcut.

In the observed desktop session, clicking “See the failed simulation check” set `#simulation-assertions` but left the target below the viewport. A subsequent measurement still showed scrollY 82 and the target about 1482px below the viewport top. This defeats the primary investigation link.

**Fix:** resolve the fragment after the target renders, scroll it into view, and move focus to an appropriate heading. Verify both same-page clicks and direct fragment URLs; do not rely solely on changing the URL.

### C05 — Run-health explanation contradicts its calculation

**Where:** `apps/web/src/routes/RunList.tsx:653,883–887,1309`. **Tell:** inaccurate explanatory copy.

The page says counts exclude simulation assertions, and describes Needs attention as “Failed, incomplete, or SLA failed.” Its calculation includes failed simulation checks. The sample displays Needs attention 1 despite complete execution and no SLA verdict. The implementation has improved while the explanation remained behind.

**Fix:** use `Needs attention` with a concise definition covering execution failures and failed checks. Prefer a scoped label such as `On this page` and contextual help over the current paragraph. Define whether overlapping categories are intentional: the same run currently counts as both Needs attention and Unjudged.

### C06 — Shared table disclosure is focusable inside `aria-hidden`

**Where:** `apps/web/src/components/TableFrame.tsx:101–116`. **Tell:** inaccessible progressive disclosure.

“How these numbers are counted” is a native interactive `<summary>` nested inside `aria-hidden="true"`. This removes its semantics from the accessibility tree while leaving an interactive element in the DOM. The long original caption still names the table, so the visible-copy reduction does not reduce accessible verbosity.

**Fix:** remove `aria-hidden` from the interactive subtree. Give the table a short caption and expose optional methodology as an accessible disclosure/description. Avoid duplicating the full prose as the accessible name.

**Accept when:** keyboard and screen-reader users can discover, expand, and collapse the disclosure, and the table has a concise useful name.

## Major findings

| ID | Where / tell | Observed flaw and concrete correction |
|---|---|---|
| M01 | `RunDecisionBand.tsx`, `RunDetail.tsx`; reading order | At 1440×900 the decision band was 316px high, run totals began around document y1007, and statistics around y1828. Put a compact outcome strip and key metrics before the time navigator. Collapse unchanged metadata. Aim to show failure, p95, error rate, and throughput in the first desktop viewport. |
| M02 | Mobile run header/decision band; excessive vertical stacking | At 375px the decision panel was 539px high and totals began around y1125. Replace stacked repeated status prose with short labeled rows. Keep run name, environment, outcome, and primary metrics before secondary metadata. Width fit alone is not mobile usability. |
| M03 | `RunDetail.tsx:1006–1023`, `ProjectRules.tsx`; oversized empty states | No-rule messaging occupies a substantial card, despite already being explained in the decision band or beside the form. Use one compact `No SLA rules configured · Configure rules` row. On Rules, remove the separate large empty-state treatment below an already visible first-rule form. |
| M04 | `ProjectSetup.tsx:52–160`; documentation presented as task UI | All three paths display their explanations, prerequisites, code, and implementation caveats at once, with the third card below the first two. Start with three short choices: Import report, Run a test, Connect CI. Expand only the chosen workflow. Keep optional format/SDK details in help. |
| M05 | Add results / Import results; capability mismatch | The import path requires creating a token and posting an archive from a terminal; the UI explicitly says there is no browser upload. For a polished manual workflow, add a real file picker with accepted formats, validation, progress, and processing state. Until implemented, label the path `Import via API` so the promised interaction is honest. |
| M06 | `ProjectRules.tsx:550–554,742–743`; conflicting policy explanations | One helper says every rule applies to a live run when its header names the simulation. Another says new rules judge runs finished after creation while current streaming runs retain their starting rules. The overview describes ingestion-time rules. Establish the actual snapshot event with backend owners, then use one precise statement everywhere. This review confirms copy inconsistency, not which backend policy is correct. |
| M07 | `ProjectRules.tsx` preview/target selector; valid-looking incomplete draft | Selecting Request without a target shows `Every request: …`, but submitting that draft produces a target-required error. “Every request” is not the authored behavior. Show `Choose a request to preview this rule` until required inputs are valid; offer an explicit all-request option only if the backend supports it. |
| M08 | `ProjectRules.tsx:454` and form errors; implementation prose exposed | The target error explains run-scoped schema combinations instead of simply identifying the missing request. Observed error leaves focus on Add rule and sets no `aria-invalid` field. Associate a concise error with the field, mark it invalid, and focus the first invalid field. Replace the source's empty-threshold explanation with `Enter a threshold in milliseconds`; its assertion that every run breaches zero is not universally true across metrics/comparators. |
| M09 | Rule Family/Metric controls; internal data model as UX | `Family`, raw `p95`, and `Group cumulated` require implementation knowledge. Lead with human labels: Measurement, Statistic, Limit. Use compatible metric options for the selected scope and a short example for uncommon group measurements. Preserve the useful natural-language preview. |
| M10 | Project overview and `ProjectConfigPage`; inconsistent navigation | Project tests exposes Project runs, Add results, and New on-prem run, while Rules and Access are discovered through the setup screen. Provide stable project navigation across project pages: Tests, Runs, Add results, Rules, API tokens. Keep launch as an action rather than another competing navigation concept. |
| M11 | `NewRunnerRun.tsx:240–245` and form; staged labels without staged interaction | New on-prem run → Queue a run → Three steps → Artifact/Execution/Review repeats the task. All sections and an empty review are present at once. Use one title and either a genuine step flow or a compact form with a review section populated after valid input. Hide unset optional review rows. |
| M12 | Setup/launch runner readiness; action required to diagnose availability | “Queue one to find out whether a node is connected” asks the user to schedule work as a health check. The UI admits readiness is inferred from job history. Add heartbeat-backed availability with last-seen time, or accurately show `Runner availability unknown` with a connection-check/setup action. Do not imply job history proves current connectivity. |
| M13 | `RunDetail.tsx:1266` simulation assertion table; redundant evidence | Structured Target/Metric/Bound/Actual columns now work, but the complete assertion repeats them. Make the raw expression expandable. Link Search to its request analysis, and make the failure row a direct path to evidence rather than a dead end. |
| M14 | `RunList.tsx:1276`; action-looking plain text | The red `investigate` focus hint is a span, despite the table describing Focus as the first operational action. Make it a real link to the failed check or error evidence. If it is only a status, rename it `Needs investigation` and avoid action styling. |
| M15 | `tables/ErrorsTable.tsx`, Errors route; prose compensates for generic labels | “Percentage” needs a long paragraph to explain its denominator. Use `Share of errors`; keep `24 failed requests · 2 error types` adjacent. Add a request drill-down/filter when mappings are available. The current raw messages and counts explain what failed but not which request to investigate. |
| M16 | `RunTelemetry.tsx:185–186`; empty state without recovery | “No telemetry was recorded” and “No load generator reported” repeat the absence with no next action. Show one sentence plus `Set up generator telemetry` or documented steps. Keep selected-window emptiness distinct from telemetry never recorded. |
| M17 | Charts route / shared chart toolbar; excessive repeated controls | Every chart repeats table, JSON, CSV, and fullscreen actions. Across the many charts this produces a large control surface. Keep fullscreen and an accessible overflow menu; group export formats under Download. Organize charts into investigation groups such as Load, Latency, and Errors, with clear scope and outcome labels. |
| M18 | `ProjectAccess.tsx:60,143–159,354`; unclear access concept | “Access” suggests members/roles but the page is API tokens. “Mint” and “Scopes” are avoidable jargon; creation labels are humanized while table cells revert to `ingest, read`. Rename to API tokens, Create token, Permissions, and use consistent permission labels. Token expiry/rotation controls were not visible; assess these as product requirements before enterprise rollout, without implying the backend lacks them. |

## Minor findings

| ID | Where / tell | Correction |
|---|---|---|
| N01 | Run totals/statistics/charts; vocabulary drift | Standardize `Errors`, `Successful`, `Requests/s`, and `p95 response time`; retain OK/KO or Cnt/s only when explicitly needed for Gatling parity, with a glossary. Avoid mixing assertions, checks, gates, and verdicts without scope. |
| N02 | Run totals; repeated estimation caveat | Put percentile approximation methodology in one accessible help location, instead of repeating “an estimate, accurate to within 1%” under both percentile cards. Keep units beside values. |
| N03 | App header/project rail; hierarchy polish | Theme controls and Sign out consume persistent chrome while account/organization context is faint. Use an accessible account menu and a compact theme preference, and identify what the project's “not evaluated” badge summarizes—or omit that ambiguous badge. |
| N04 | Tables/setup/empty states; over-explained routine UI | Remove phrases such as “You have reached the end of the list,” “Available now,” “same as the name,” and “Show 2 checks that did not fail” where ordinary labels suffice. Use disabled pagination, no capability badge, an em dash, and `Other checks (2)` with statuses respectively. |

## Copy changes to make immediately

These are proposed replacements, not changes already applied. Keep necessary policy and unit information; move methodology out of the primary reading path.

| Current pattern | Proposed default copy |
|---|---|
| Long run-health caveat | `On this page` + accessible `How counts work` disclosure with the corrected definition |
| Repeated Not evaluated block | `SLA: Not configured` |
| Failed 0 beside a simulation failure | Remove unused SLA counts; show `Simulation checks: 1 failed` |
| Configure rules for this project | `Configure SLA rules` — linked to Rules |
| Three ways to get a run into this project… | `Add results` with short workflow choices |
| Every build posts its own report, so the trend line keeps itself up to date | `Send reports from your CI pipeline.` |
| No runner seen yet + inference paragraphs | `Runner availability unknown` + a useful connection/setup action |
| Target schema error | `Choose a request.` |
| Empty threshold implementation explanation | `Enter a threshold in milliseconds.` (adapt unit to metric) |
| Mint a token / Scopes | `Create API token` / `Permissions` |
| Percentage | `Share of errors` |
| Two no-telemetry sentences | `No generator telemetry recorded.` + setup link |

## Target layout for a performance engineer

**Run overview, top to bottom:**

1. Breadcrumb, run name, environment, date, and overflow actions. Secondary metadata in Details.
2. Compact execution/SLA/simulation-check outcomes, with a direct failure link.
3. p95 response time, error rate, throughput, total requests; p99 and mean can follow at lower emphasis.
4. Failed-check evidence: Search, p95, actual 1939.53ms, required <100ms, Open request.
5. Statistics table and a compact linked time window. Be explicit about whole-run versus selected-window values.
6. Optional passed checks, raw assertions, and configuration guidance in disclosures.

Do not convert this into a promotional landing-page layout or add decorative cards. Keep the existing orange accent, restrained surfaces, and analytical density. Use spacing and typography to separate data groups; remove nested panel borders and repeated titles where the content already establishes context. The light-theme pass showed the same hierarchy problem, so changing colors alone will not resolve it.

**Runs:** compact filters, optional summary counters, useful rows immediately below. **Rules:** concise valid form, one preview, existing rules list. **Add results:** choice first, selected instructions second. **Launch:** required inputs first, relevant readiness near Queue, one review. **Errors:** counts and actionable error/request evidence before methodology. **API tokens:** existing tokens plus Create token, with consistent permissions and visible lifecycle information.

## Recommended delivery order and acceptance gates

**First: restore trust and interactions.** Fix C01–C06 and the rule-preview/lifecycle/error issues. Add focused regression checks for the incorrect route, fragment scrolling after render, target-required preview, health calculation/copy agreement, and disclosure accessibility.

**Second: simplify the three main journeys.** Rework run overview reading order, Add results choice flow, and project navigation. Remove duplicate explanations during that change rather than adding more guidance around the current structure. Validate that an engineer can answer “Did it finish?”, “What failed?”, and “Where do I investigate?” from the first screen and its immediate links.

**Third: complete production workflows.** Establish real runner availability, accessible form errors, telemetry setup recovery, manual import expectations, token lifecycle requirements, and consistent exports. Validate populated and failing states with representative fixtures rather than relying on this single demo run.

Before calling the UI production-ready, exercise: many projects/tests and long names; zero and hundreds of runs; live/disconnected/failed/incomplete runs; passed/failed/not-applicable SLA and simulation checks; selected-window versus whole-run evidence; multiple comparisons; populated telemetry; invalid uploads; expired sessions; permission-denied states; slow loading and retry; keyboard-only navigation and screen-reader announcements; light/dark themes; 320/375/414/768/1024/1440px; and 200% text zoom. Table-local horizontal scroll is acceptable when row identity, headers, and controls remain usable.

The strongest existing assets are the technical evidence, structured assertions, improved run rows, and clearer separation of setup concerns. The next iteration should make those assets easier to reach and interpret. **6 critical · 18 major · 4 minor.**
