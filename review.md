<!-- Hallmark · pre-emit critique: P5 H5 E4 S5 R5 V4 -->
# PerfPortal — performance engineer UI/UX review

**Review date:** 13 September 2026  
**Application:** http://localhost:3000/  
**Account:** QA account supplied for this review  
**Repository baseline:** `d7cafc1`  
**Deliverable:** Review and recommendations only. No application changes retained.

## Assessment

**The current application is functional, but its layout is not yet intuitive or polished enough for an enterprise performance-engineering product.** Your concern about excess text is justified. The deeper issue is that the application makes users read explanations to understand information that should be communicated through layout, labels, and direct actions.

The application often presents all of its implementation concepts simultaneously: execution status, release verdict, platform gates, simulation checks, methodology, configuration details, and raw metric expressions. Most of those concepts are useful, but they do not deserve equal prominence on every screen.

An engineer opening a run should immediately understand:

1. Did the test execute successfully?
2. Did performance meet the required limits?
3. What failed, and where should I investigate?
4. What changed against the relevant baseline?

Today, the interface answers those questions across repeated status blocks, long paragraphs, and distant tables. A modern appearance will come primarily from fixing this organization, followed by visual consistency. Smaller text, extra icons, more cards, or a new color palette will not solve it.

“Gatling Enterprise level” is used here as a quality target: clear performance workflows, trustworthy evidence, manageable configuration, and consistent interaction. This is not a claim of feature parity or a current competitive audit of Gatling Enterprise.

## Review coverage and limits

Signed in with the supplied QA account and inspected the populated run list, a failed Checkout run, its SLA evidence, populated comparison, project tests, Add results, and populated rule management. Read the related presentation source, including launch-form structure. The account exposed 13 runs across Checkout, Payments, Search, and gdemo, with failed, incomplete, passed-SLA, and unevaluated examples.

The principal run reviewed was `c2a7c145-44cf-4d34-a8fd-3d112c5d1bb5`, belonging to `checkout-smoke`. Its observed results included 895 requests, 20 errors, a 2.23% error rate, and approximately 646ms p95 response time. These are demo observations, not production performance claims.

This pass did not execute load, create or delete rules, revoke credentials, test every responsive breakpoint, or verify backend authorization and security. Earlier observations are distinguished from current findings where applicable. Production readiness still requires live-state, accessibility, failure-recovery, and scale testing.

## What improved since the earlier review

Several earlier defects have received targeted fixes in the current source: the rule link destination, fragment scrolling, table disclosure accessibility, rule target validation, and empty SLA count handling. The list's investigation hint is now a link. API tokens has a more accurate name. The navigator chart's plot is more readable.

These fixes are valuable, but they have mostly repaired individual defects inside the existing structure. The remaining problem is the structure itself. In some places, fixes added more explanatory text, so correctness improved while the screen became harder to scan.

## Priority 1 — correctness and decision clarity

### 1. SLA actual values use inconsistent units

**Location:** Run overview, SLA evidence cards/table; `RunDetail.tsx`, assertion formatting.

The failed error-rate rule displays a limit of **1%**, but its card says **Actual 0.02**. The table exposes **0.0223463687150838**, and the main metric says **2.23%**. The decision panel repeats the raw expression `error_rate … ≤ 0.01 — actual 0.0223463687150838`.

An engineer should not have to convert a stored fraction to interpret a failed rule. The rounded `0.02` can look lower than the displayed limit of `1%` when units are omitted.

**Recommendation:** use a shared metric-aware formatter for limit, actual, evidence card, table, and summary. Display `Error rate: 2.23% · Limit: ≤1%`. Display latency with an explicit unit and reasonable precision. Keep raw values in export or an optional technical-details view.

**Acceptance:** equivalent measurements have the same units everywhere. No ordinary evidence row exposes floating-point serialization noise.

### 2. The outcome panel repeats the same conclusion too many times

**Location:** `RunDecisionBand.tsx`.

The failed run shows a large FAILED label, passed/failed/not-applicable counts, colored ticks, a raw failure sentence, execution/platform/simulation rows, another set of count tiles, and export/compare controls. At 1440×900, this band measured approximately **262px high**. Run totals started around document **y953**, below the first viewport.

**Recommendation:** replace the dominant panel with three concise outcomes:

- `Execution: Completed`
- `SLA: 2 failed · 2 passed · 1 not checked`
- `Simulation checks: 2 failed`

Put the actual failures immediately below as actionable evidence. Keep detailed counts and export in a secondary control. Preserve the distinction between an execution failure and a performance failure.

**Acceptance:** the first desktop screen contains the outcome, p95, error rate, throughput, and a direct investigation action.

### 3. User-facing rule language still exposes the internal schema

**Location:** release summary, assertions, Rules.

Expressions such as `error_rate of the run (response_time)` and `p95 of Cart (group_cumulated)` are difficult to read and sometimes conceptually confusing. Why is error rate described with a response-time family? Engineers may understand the data model eventually, but the UI should not require that learning first.

**Recommendation:** use `Whole-run error rate`, `Search p95 response time`, and `Cart p95 cumulative response time`. Put the raw expression in Details. Use the same terminology in rule authoring and results.

### 4. “Vs previous” does not identify the baseline clearly enough

**Location:** run metric cards and Compare.

The overview displays percentage changes “vs previous.” The populated comparison then warns that selected runs differ in environment and branch: production versus staging, and main versus feature/cart-rewrite. Both build identities were unknown.

This does not establish that the selected baseline is wrong. It establishes that the overview's shorthand hides information needed to judge relevance.

**Recommendation:** identify the actual baseline near the metric comparison, link to it, and surface material environment/build differences next to deltas. Offer an explicit baseline selection. Avoid suggesting statistical significance from a small difference without supporting evidence.

## Priority 2 — navigation and page organization

### 5. Project navigation changes depending on the page

The project screen offers Project runs, Add results, and New on-prem run. Rules and API tokens appear inside a different three-item configuration navigation. Users must remember which screen contains a destination.

**Recommendation:** one stable project navigation across project pages: **Tests · Runs · Add results · SLA rules · API tokens**. Keep **Run test** as a clear action. Preserve project context throughout.

### 6. Test identity is less prominent than the simulation class

The breadcrumb identifies `checkout-smoke`, but the run heading is `example.ParitySimulation`. Checkout has both smoke and soak tests using that class. Repeating the class as the main identity makes different user tasks look the same.

**Recommendation:** lead with the test name and a short run identifier or meaningful run name. Show the simulation class as secondary technical metadata. Retain class search for engineers who need it.

### 7. Run-list explanations compete with the run list

The current health block explains pagination, overlapping categories, execution states, SLA verdicts, and simulation checks in one paragraph. The four counters each add another explanatory phrase. A separate table caption and methodology disclosure follow.

**Recommendation:** show a short `On this page` label and compact counts. Move the precise definitions to one accessible disclosure. Keep columns self-describing. Do not turn page-local counts into apparent organization-wide health statistics.

### 8. Filters are over-framed

The filter area has a card, “Filter runs,” “Search runs,” multiple labels, and an Apply action before the rows begin.

**Recommendation:** one compact toolbar with search and labeled filters, a visible active-filter summary, and Clear when needed. Retain a deliberate Apply interaction if querying is expensive; do not change search behavior merely for appearance. Give routine filters less visual weight than the data.

### 9. Overview contains too many competing evidence presentations

SLA outcomes appear in the decision band, an evidence summary, individual assertion cards, and a full table. Simulation checks then use another presentation. This creates length without equivalent additional information.

**Recommendation:** one failed-check table with columns **Check · Target · Actual · Limit · Outcome · Investigate**. Group platform and simulation checks explicitly. Collapse passed checks by default. Raw messages should be expandable, not repeated in every representation.

### 10. Time selection consumes prime space on the overview

The shared time navigator appears before the main metrics. Most first visits need whole-run results; the user has not yet decided whether a narrower interval matters.

**Recommendation:** use a compact, clearly labeled time-range control that expands for selection. An active interval must remain visible. Consider a permanently expanded navigator on chart-focused screens, while keeping the overview evidence-first. Do not silently mix whole-run assertions with windowed metrics.

## Priority 2 — forms and configuration

### 11. Add results presents three instruction manuals at once

Import results, Run a test, and Configure CI are all expanded. Their prerequisites, shell commands, format details, runner behavior, and plugin instructions compete for attention.

**Recommendation:** show three short choices and reveal only the selected workflow. Each choice should state what the user needs and the next action. Keep detailed integration instructions available within that workflow.

Suggested choices:

| Choice | Supporting line |
|---|---|
| Import via API | Send an existing Gatling report |
| Run a test | Execute a test on your runner |
| Connect CI | Send reports from your pipeline |

A real browser-upload workflow would improve manual use, but is a separate product feature. Until it exists, do not label an API-only workflow in a way that implies a file picker.

### 12. Rule creation dominates rule management

Checkout already has six rules, yet a fully expanded creation form appears before the existing rules. A returning user usually wants to inspect or change an existing limit, not create another one.

**Recommendation:** lead with the rules list and an **Add rule** button. Open a focused form or side panel on demand. For the empty state, show the creation flow immediately. Distinguish project-wide and test-specific rules with a filter or grouping.

### 13. Rule fields require too much interpretation

The form combines Applies to, Name, Scope, Family, Metric, Must be, and Threshold. “Family” is an internal concept, while common choices and advanced choices carry equal weight. The sentence preview is useful and should stay.

**Recommendation:** organize the form as:

1. **Applies to:** all tests or a named test.
2. **Measure:** whole run, request, group, or scenario; show Target only when required.
3. **Limit:** measurement, statistic, comparator, value with unit.
4. One readable preview, optional name, Save.

Offer common presets such as response-time p95 and error rate without removing supported custom percentiles. Keep meaningful labels visible; placeholders are not labels.

### 14. Form help still teaches implementation lifecycle in the primary flow

The Applies to helper discusses log-header matching; another paragraph explains when a rule starts judging runs. These are useful policy details but distract from entering the rule.

**Recommendation:** short field help, then a `When does this rule apply?` disclosure near Save. Its wording must match the actual backend lifecycle. Do not replace a complicated policy with an inaccurate promise.

### 15. Rule maintenance is visually dominated by repeated actions

Every populated rule row ends with Disable and Delete. The primary surface emphasizes management actions while the threshold itself is written as a long technical sentence.

**Recommendation:** structure target, metric, limit, and enabled state into scan-friendly columns. Keep a clear enabled control and move less frequent destructive actions into a row menu with accessible names and existing confirmation behavior. Evaluate an Edit action as a product capability; do not assume disable/delete is sufficient for normal maintenance.

### 16. Launch form repeats the task instead of guiding it

The source presents New on-prem run, Queue a run, “Three steps,” and numbered Artifact/Execution/Review sections. An unfilled review repeats empty values. This is a long form labeled as steps rather than a genuinely guided sequence.

**Recommendation:** one title, required artifact and simulation inputs first, execution context next, advanced JVM/properties collapsed, and a concise review immediately before Queue. Avoid repeating unset optional values. Show runner readiness near the action without claiming current availability from historical jobs.

## Priority 2 — comparison and investigation

### 17. Comparison choices are difficult to recognize

The picker uses timestamps such as `09-13 11:31` and `08-07 11:00 · e0b6ec`. Those distinguish records mechanically but do not tell an engineer which build or environment they are choosing.

**Recommendation:** a run picker showing test/run name, environment, branch/build, time, and outcome. Explicitly identify Current and Baseline. Support filtering when history grows; timestamp buttons will not scale well.

### 18. Comparison asks users to compute request-level changes

The per-request table shows one numeric column per run. For example, Catalog/Recommendations/Related Items showed 146.95 versus 2515.46, while many other rows were unchanged. There is no visible delta column in the inspected table.

**Recommendation:** add absolute and percentage change with units and clear baseline direction. Offer sorting by change and filtering to changed requests. Treat missing measurements as unavailable, never zero. Provide request drill-down where the application has the necessary mapping.

### 19. Comparability guidance is useful but verbose

The comparison correctly flags environment/branch/build differences, but opens with a general warning sentence followed by multiple facts. Summary cards then repeat the active selection and metric.

**Recommendation:** a concise `Different environment and branch` notice with details available. Put metric and baseline controls together, followed by the principal delta and chart/table. Keep the warning near the conclusion it qualifies.

## Priority 3 — visual consistency and accessibility

### 20. Too much interface chrome has equal weight

Borders, nested cards, muted descriptions, status badges, large verdict typography, and multiple export buttons all compete. The page has weak separation between navigation, primary evidence, and supporting documentation.

**Recommendation:** a restrained surface hierarchy, fewer nested panels, consistent heading sizes, and one primary action per task. Preserve the existing brand rather than introducing decorative gradients or an unrelated theme.

### 21. Long accessible names remain a problem

Current table captions include entire methodology paragraphs. The rule Applies to control's accessible name includes its long helper text. These patterns can be cumbersome for assistive-technology users as well as reflecting excess visible copy.

**Recommendation:** concise accessible names, separate descriptions with `aria-describedby`, and properly exposed disclosures. Verify with keyboard and a screen reader; DOM inspection alone is not an accessibility certification.

### 22. Terminology should be consistent across workflows

The app mixes run, test, simulation, assertion, check, gate, and verdict. These are not all synonyms. It also uses raw metric identifiers in some places and natural language in others.

**Recommendation:** define and apply a small vocabulary: **Test** for the reusable workload, **Run** for an execution, **SLA rule** for a platform limit, **Simulation check** for a declared test assertion. Use context in outcome labels. Retain implementation terms in advanced details.

## Proposed wireframes

These are layout recommendations, not implemented changes.

### Run overview

```text
Project / Test / Run
Checkout smoke — run c2a7c145             Compare   More
Production · main · 13 Sep, 11:31         Details

Execution: Completed   SLA: 2 failed   Simulation checks: 2 failed

p95 response time       Error rate       Throughput       Requests
646 ms                  2.23%            14.41/s           895
Baseline: [identified run] · differences visible when relevant

Overview | Charts | Errors | Generators | Trends | Compare
Time range: Whole run [Change]

Failed checks
Check              Target       Actual       Limit        Action
Error rate         Whole run    2.23%        ≤1%          Open errors
p95 response time  Search       1826.58ms    ≤100ms        Open request

Request statistics
[Search requests] [Columns] [Download]
...
Other checks [collapsed]     Technical details [collapsed]
```

### Rule management

```text
Checkout
Tests | Runs | Add results | SLA rules | API tokens

SLA rules                                      Add rule
[All tests] [Enabled] [Search rules]

Name                  Applies to       Measurement        Limit    Enabled
Error rate under 1%   Every test       Error rate         ≤1%      Yes
Search response time  Every test       Search p95         ≤100ms   Yes
```

### Add rule

```text
Add SLA rule
Applies to        [All tests]
Measure           [Request]       Target [Search]
Measurement       [Response time]
Statistic         [p95]           Condition [At most]
Limit             [100] ms

Search p95 response time must be at most 100ms.
Name (optional)   [...]
When does this apply? [collapsed]
                                    Cancel   Save rule
```

## Copy guidance

| Current pattern | Recommended copy |
|---|---|
| error_rate of the run (response_time) ≤ 0.01 — actual 0.022346… | Error rate 2.23% exceeds the 1% limit |
| Long page-health explanation | On this page · How counts work |
| Family | Measurement |
| A live run is matched to its test as soon as the log header… | Move to lifecycle help |
| Three ways to get a run into this project… | Add results |
| Three steps: what to run, how to run it… | Remove; section labels already explain the form |
| Every request… a dash means… | Put unit in the table header; missing-data definition in help |
| Vs previous | Vs [identified baseline] |

The goal is not to delete every paragraph. Keep text that prevents a wrong decision, explains a missing prerequisite, or helps recover from failure. Move reference material and repeated explanations out of the default reading path.

## Recommended implementation order

1. **Correct evidence formatting:** consistent units, precision, failure wording, and baseline identity.
2. **Restructure run overview:** compact outcomes, primary metrics above the fold, one failure-evidence presentation.
3. **Unify project navigation:** stable destinations and stronger test identity.
4. **Clean configuration:** existing rules first, focused authoring, one Add results workflow at a time, simpler launch review.
5. **Improve comparison:** identifiable baselines, request deltas, meaningful sorting and drill-down.
6. **Validate the system:** responsive layouts, keyboard/screen-reader use, live and failure states, long names, and large histories.

Before describing the product as enterprise-ready, validate those workflows with representative users and populated states. This review does not establish security, reliability, role-management, audit-history, or backend feature readiness.

## Final recommendation

Keep the technical capability and redesign how users reach and interpret it. Make the default screen a concise working surface; make detailed explanations available when requested. The highest-value change is a consistent information hierarchy across the product, supported by accurate labels and direct investigation actions.

**Review inventory: 4 decision/correctness priorities · 15 workflow/layout priorities · 3 consistency/accessibility priorities.**
