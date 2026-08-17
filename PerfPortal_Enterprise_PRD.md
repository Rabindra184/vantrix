# Perf Portal — Enterprise Performance Testing Analytics Platform

**Product Requirements Document**

| | |
|---|---|
| **Document version** | 2.0 |
| **Status** | For review |
| **Date** | 2026-08-07 |
| **Supersedes** | Perf Portal PRD v1.0 — reporting-only, single-tenant scope. Removed from the tree; recoverable via `git show 9f7a571:PerfPortal_PRD.md` |
| **Product type** | Enterprise, cloud-native, self-hostable multi-tenant platform |
| **V1 commitment** | 100% feature parity with the Gatling OSS HTML report, plus centralized history, comparison, and live monitoring |
| **Owners** | Product · Architecture · Performance Engineering · Design |

---

## Contents

| # | Section | # | Section |
|---|---|---|---|
| 1 | [Executive Summary](#1-executive-summary) | 16 | [Technical Architecture](#16-technical-architecture-overview) |
| 2 | [Product Vision](#2-product-vision) | 17 | [API Requirements](#17-api-requirements) |
| 3 | [Business Goals](#3-business-goals) | 18 | [Database Requirements](#18-database-requirements) |
| 4 | [User Personas](#4-user-personas) | 19 | [Security Requirements](#19-security-requirements) |
| 5 | [Product Scope](#5-product-scope) | 20 | [Performance Requirements](#20-performance-requirements) |
| 6 | [Functional Requirements](#6-functional-requirements) | 21 | [Plugin Architecture](#21-plugin-architecture) |
| 7 | [Non-Functional Requirements](#7-non-functional-requirements) | 22 | [UI/UX Requirements](#22-uiux-requirements) |
| 8 | [User Stories](#8-user-stories) | 23 | [Reporting Requirements](#23-reporting-requirements) |
| 9 | [Acceptance Criteria](#9-acceptance-criteria) | 24 | [Analytics Requirements](#24-analytics-requirements) |
| 10 | [Use Cases](#10-use-cases) | 25 | [AI Roadmap](#25-ai-roadmap) |
| 11 | [Information Architecture](#11-information-architecture) | 26 | [Milestones](#26-milestones) |
| 12 | [Navigation Structure](#12-navigation-structure) | 27 | [Release Plan](#27-release-plan) |
| 13 | [Dashboard Specifications](#13-dashboard-specifications) | 28 | [Risks](#28-risks) |
| 14 | [Feature Specifications](#14-feature-specifications) | 29 | [Future Enhancements](#29-future-enhancements) |
| 15 | [Module Breakdown](#15-module-breakdown) | 30 | [Success Metrics](#30-success-metrics) |

**Appendices:** [A — Gatling Parity Matrix](#appendix-a--gatling-oss-report-parity-matrix) · [B — Canonical Data Model](#appendix-b--canonical-event-and-metric-model) · [C — Glossary](#appendix-c--glossary)

---

## 1. Executive Summary

Organizations run load tests continuously, yet the results of those tests evaporate. Each execution produces a self-contained HTML artifact that lives in a CI workspace for a few days and answers exactly one question: *what happened in this run*. It cannot answer the questions that actually drive engineering decisions — *is this build slower than last week*, *which endpoint regressed*, *which commit caused it*, *are we still within SLA*, *is this service degrading across releases*.

Commercial platforms solve this, but bundle it with load-generation infrastructure, price per virtual user, and lock the analytics behind the execution product. Teams that already run load tests well in their own CI are forced to buy the part they don't need to get the part they do.

**Perf Portal is a performance engineering analytics platform.** It ingests results from any load testing tool, normalizes them into a tool-agnostic metric model, stores them durably, and provides interactive dashboards, cross-build comparison, regression detection, SLA gating, and live execution monitoring across hundreds of projects and hundreds of thousands of runs.

**Version 1 is anchored on a single, verifiable commitment: complete feature parity with the Gatling OSS HTML report** (Appendix A). Every chart, statistic, percentile, distribution bin, error breakdown, assertion result, and detail page in that report exists in the platform, with equal or better fidelity — plus filtering, search, sorting, drill-down, and history that the static report cannot provide. Parity is the adoption wedge: a team can delete their HTML artifacts on day one and lose nothing.

Beyond parity, the platform provides centralized execution history, run comparison, performance baselines, regression detection, live monitoring over WebSocket, scheduled and on-demand report generation, a public REST API, RBAC with SSO, audit logging, and a parser plugin architecture that extends to k6, JMeter, Locust, and Artillery without any change to storage, analytics, or presentation code.

### 1.1 What makes this defensible

| Pillar | Why it matters |
|---|---|
| **Verifiable parity** | "Feature parity with the Gatling report" is an objective, testable claim, not a marketing position. It is enforced by an automated parity test suite (§9.1). |
| **Statistically correct aggregation** | Percentiles are stored as mergeable sketches and are never averaged. Re-aggregation at any zoom level is exact. Most trend tooling silently averages percentiles and is wrong. |
| **Tool-agnostic by construction** | The presentation layer cannot determine which tool produced a run. Adding a tool is implementing a plugin, not modifying the product. |
| **Comparison integrity** | Runs carry a comparability fingerprint. Trends never silently connect across environment, profile, or tool changes. |
| **Enterprise-ready from V1** | RBAC, SSO, audit logs, API keys, service accounts, retention policy, and horizontal scalability are V1 requirements, not a later "enterprise tier." |

---

## 2. Product Vision

> **Every performance test execution in the organization is permanently searchable, comparable, and explainable from one place — regardless of which tool produced it.**

Three years out, Perf Portal is where an engineering organization answers performance questions:

- A developer opening a pull request sees whether their branch regressed any endpoint, and by how much, before merging.
- A performance engineer investigating a p99 spike moves from a fleet heatmap to the responsible endpoint to the responsible commit range in under a minute.
- An SRE watches a production-scale soak test in real time, with active users, throughput, and error rate streaming live, and aborts early when error rate crosses a threshold.
- An engineering manager reviews quarterly latency trends across twelve services without opening a single CI job.
- A platform engineer adds support for a new load testing tool by writing one plugin, and every existing dashboard works against it immediately.

The platform does not run load tests. It is the memory, the analysis layer, and the system of record for performance evidence.

### 2.1 Design tenets

1. **Parity before novelty.** No new visualization ships before the equivalent Gatling report element does.
2. **Correctness is not negotiable.** A statistically wrong number presented confidently is worse than no number. Percentile handling, warm-up exclusion, and comparability rules are correctness constraints, not preferences.
3. **The UI never learns the tool.** Tool knowledge terminates at the plugin boundary.
4. **Interaction is instant because data is pre-aggregated.** Zoom, hover, and filter never trigger a raw-data fetch.
5. **Heavy artifacts stay out of the request path.** Raw logs live in object storage and are touched at ingest or explicit reprocess only.
6. **Everything visible in the UI is available via API.** The UI is the first consumer of the public API, not a privileged one.

---

## 3. Business Goals

| # | Goal | Metric | V1 target |
|---|---|---|---|
| **BG-1** | Replace the static HTML report as the primary analysis surface | % of onboarded teams that stop publishing Gatling HTML artifacts | ≥ 70% within 60 days of onboarding |
| **BG-2** | Reduce time to detect a performance regression | Median hours from regressing merge to acknowledged alert | < 2 hours (from a baseline of days) |
| **BG-3** | Reduce time to attribute a regression | Median minutes from alert to identified endpoint + commit range | < 10 minutes |
| **BG-4** | Become the organization's system of record for performance evidence | Runs ingested per week; % of load-testing CI jobs wired to the platform | ≥ 80% of jobs by end of V1 rollout |
| **BG-5** | Support multi-tool organizations without fragmentation | Number of distinct tools ingesting into one deployment | ≥ 3 by V2 |
| **BG-6** | Scale to enterprise footprint without redesign | Projects, runs, concurrent users supported | 1,000 projects · 500,000 runs · 500 concurrent users |
| **BG-7** | Reduce cost of commercial performance-analytics licensing | Licensed seats retired | Deployment-specific; tracked per customer |
| **BG-8** | Make extension a community activity, not a roadmap item | Plugins contributed externally | ≥ 1 by V3 |

---

## 4. User Personas

### 4.1 Priya — Performance Engineer *(primary)*

**Context.** Owns the load testing practice for 8 services. Writes Gatling and k6 simulations. Currently maintains a spreadsheet of p95 values copied out of HTML reports.

**Needs.** Deep single-run analysis at full Gatling fidelity; two-run comparison; endpoint-level drill-down; distribution and saturation analysis; the ability to explain *why* a number moved.

**Frustrations.** Reports vanish. No history. Cross-run comparison is manual. Percentile trends require copying numbers by hand.

**Success.** Opens a run, reaches the responsible endpoint in three clicks, compares to baseline, exports evidence for a release review.

**Primary surfaces.** Run Detail, Request Detail, Comparison, Percentile Dashboard.

---

### 4.2 Daniel — Backend Developer

**Context.** Ships 5–10 changes a week. Cares about performance only when his change causes a problem.

**Needs.** A fast, unambiguous answer to "did my change slow anything down?" delivered where he already works — PR comment, Slack, CI output.

**Frustrations.** Perf dashboards built for specialists. Noisy alerts he has learned to ignore.

**Success.** CI fails with a message naming the endpoint, the delta, and a link. He never opens the platform unless something is wrong.

**Primary surfaces.** CI verdict output, Slack notification, Comparison (deep-linked).

---

### 4.3 Maya — Engineering Manager

**Context.** Owns four teams and twelve services. Reports on reliability quarterly.

**Needs.** Fleet-level health at a glance; trend direction over months; SLA compliance evidence; scheduled reports she doesn't have to request.

**Frustrations.** Has to ask engineers for numbers. No way to see whether things are getting better or worse.

**Success.** A weekly email lands with per-service latency trends and SLA status. Drill-down works when she needs detail.

**Primary surfaces.** Global Overview, Trend Analysis, Scheduled Reports.

---

### 4.4 Sam — SRE

**Context.** Runs capacity and soak tests before major releases. On call.

**Needs.** Live monitoring during long-running tests; the ability to abort early; saturation curves to find the capacity knee; environment comparison.

**Frustrations.** Has to wait for a test to finish to learn it failed in minute three.

**Success.** Watches a 6-hour soak live, sees error rate climb at hour 2, stops the test, and has the evidence captured permanently.

**Primary surfaces.** Live Monitoring, Timeline Dashboard, Error Dashboard.

---

### 4.5 Aisha — Release Manager

**Context.** Gates releases across multiple services.

**Needs.** Deterministic pass/fail per release candidate; threshold and assertion results; deployment and release tracking; auditable evidence.

**Success.** A release dashboard shows every service's SLA status for the candidate build, with a permanent record of what was evaluated.

**Primary surfaces.** Release Tracking, Assertions & Thresholds, Audit Log.

---

### 4.6 Rahul — Platform Engineer

**Context.** Operates the platform. Onboards teams. Extends it.

**Needs.** Straightforward deployment on Kubernetes; observability; RBAC and SSO; retention control; plugin development that doesn't require understanding the whole system.

**Success.** Stands up the platform in a day, onboards a team in ten minutes, writes a Locust plugin in an afternoon against a documented contract and test harness.

**Primary surfaces.** Administration, Plugin Management, Audit Log, Observability.

---

### 4.7 Persona-to-capability matrix

| Capability | Priya | Daniel | Maya | Sam | Aisha | Rahul |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| Run detail at Gatling parity | ●●● | ● | — | ●● | ● | — |
| Run comparison | ●●● | ●●● | ● | ●● | ●● | — |
| Trend analysis | ●●● | ● | ●●● | ●● | ●● | — |
| Live monitoring | ●● | — | — | ●●● | ● | ● |
| SLA / assertions | ●● | ●● | ●● | ●● | ●●● | — |
| Notifications | ●● | ●●● | ●● | ●●● | ●● | ● |
| Scheduled reports | ● | — | ●●● | ● | ●●● | — |
| Administration | ● | — | — | ● | ● | ●●● |
| Plugin development | ● | — | — | — | — | ●●● |

●●● primary · ●● regular · ● occasional

---

## 5. Product Scope

### 5.1 In scope — Version 1 program

Everything below is V1 scope. §26 assigns each item to **GA** or to a **V1.1/V1.2 fast follow** within one quarter of GA.

| Area | Included |
|---|---|
| **Gatling parity** | Every element of the Gatling OSS HTML report (Appendix A), including request, group, and scenario detail pages, latency-vs-response-time distinction, assertions, and configurable percentile columns |
| **Ingestion** | Authenticated bundle upload from any CI; Gatling plugin; synchronous SLA verdict for CI gating; streaming ingestion for live monitoring |
| **Organization** | Organizations, teams, projects, folders, simulations, tags, environments |
| **Execution metadata** | Build number, Git branch, Git commit, environment, tags, injection profile, custom key-value metadata |
| **Analytics** | Historical execution list, trend analysis, run comparison, endpoint × build heatmap, performance baselines, regression detection, SLA monitoring |
| **Live** | WebSocket-driven live run dashboard with incremental aggregation |
| **Dashboards** | All dashboards in §13, plus user-defined custom dashboards and saved views |
| **Reporting** | PDF and HTML export, CSV/JSON data export, scheduled email reports |
| **Integration** | Public REST API with OpenAPI 3.1, WebSocket API, API keys, service accounts, Slack, generic webhooks, CI/CD helpers |
| **Enterprise** | OIDC/SAML SSO, RBAC, audit logs, retention policy, dark mode, favorites, bookmarks, annotations |
| **Plugin architecture** | Full plugin contract with reference implementation, test harness, synthetic data generator |

### 5.2 In scope — Version 2 and later

k6, JMeter, Locust, Artillery plugins · distributed-run merging · APM/tracing correlation · AI-assisted insights (§25) · custom metric definitions · multi-region deployment · marketplace for community plugins.

### 5.3 Explicitly out of scope

| Excluded | Rationale |
|---|---|
| **Executing, scheduling, or orchestrating load tests** | CI already does this well. This boundary is what keeps the platform deployable and focused. It is the single most important non-goal. |
| **Provisioning or managing load injectors** | Follows from the above. |
| **Being an APM or tracing product** | Correlation with APM data is a future integration, not a reimplementation. |
| **Cross-tool numeric comparison** | Tools measure different things. Overlaying them produces confidently wrong conclusions. See §6.4.6. |
| **Synthetic monitoring / uptime checking** | Different product category. |
| **Editing or authoring test scripts** | Scripts live in the user's repository. |

### 5.4 Assumptions

- CI systems can make authenticated outbound HTTPS calls to the platform.
- Load testing tools produce a per-request event log or an equivalent machine-readable output.
- Deployments run on Kubernetes with PostgreSQL, Redis, and S3-compatible object storage available.
- Organizations have an OIDC-capable identity provider (local accounts supported as a fallback for small deployments).

### 5.5 Dependencies

| Dependency | Used for | Failure impact |
|---|---|---|
| PostgreSQL 16+ | Primary datastore | Total outage |
| Redis 7+ | Queue backend, cache, WebSocket pub/sub | Ingestion queues stall; live monitoring degrades; reads fall back to database |
| S3-compatible object storage | Raw bundles, generated reports | Ingestion fails; historical metrics unaffected |
| OIDC provider | Human authentication | New logins fail; existing sessions and API keys unaffected |
| SMTP relay | Email reports | Scheduled reports queue and retry |

---

## 6. Functional Requirements

Requirements are identified `FR-<MODULE>-<n>`.

| Priority | Meaning |
|---|---|
| **P0** | **V1 program — required.** Ships at GA or in a V1.1/V1.2 fast follow |
| **P1** | **V1 program — expected.** May slip to a fast follow if GA is at risk |
| **P2** | Post-V1 |

> **Priority is not a release date.** §26 is the authoritative source for what lands at GA versus in a fast follow — notably, live monitoring, custom dashboards, and scheduled reports are P0 (the product is incomplete without them) but ship in V1.1/V1.2 rather than gating GA. Keeping sequencing in one place prevents two documents from disagreeing about the same requirement.

### 6.1 Project and organization management (`ORG`)

| ID | Requirement | Pri |
|---|---|:-:|
| FR-ORG-1 | **Organizations** are the top-level tenant boundary. All data belongs to exactly one organization. A deployment supports multiple organizations with complete data isolation enforced at the query layer, not the application layer. | P0 |
| FR-ORG-2 | **Teams** group users within an organization. A user may belong to multiple teams with a different role in each. | P0 |
| FR-ORG-3 | **Projects** are the primary unit of ownership and access control. A project belongs to one team, has a unique slug within the organization, and holds simulations, runs, SLA rules, and baselines. | P0 |
| FR-ORG-4 | **Folders** provide arbitrary-depth hierarchical grouping of projects for navigation. Folders affect presentation only, never permissions. Maximum depth 8. | P1 |
| FR-ORG-5 | **Simulations** represent a named, recurring test within a project (e.g. `CheckoutSimulation`). Runs are grouped under a simulation. Simulations are auto-created on first ingest and may be renamed, archived, or merged. | P0 |
| FR-ORG-6 | Projects support **archival**: archived projects are read-only, hidden from default navigation, excluded from fleet aggregates, and retained until explicitly deleted. | P1 |
| FR-ORG-7 | Project deletion is **soft for 30 days** then hard, with an audit record and an admin-only restore path. | P1 |
| FR-ORG-8 | Projects carry configurable settings: warm-up window, indicator thresholds, percentile column selection, endpoint cardinality cap, retention overrides, default baseline strategy, Git host URL template. | P0 |
| FR-ORG-9 | Project-level **cloning** copies settings, SLA rules, and dashboards to a new project without copying runs. | P2 |

### 6.2 Execution metadata (`META`)

| ID | Requirement | Pri |
|---|---|:-:|
| FR-META-1 | Every run captures: project, simulation, tool, tool version, environment, build number, Git branch, Git commit SHA, injection profile, start time, end time, duration, and ingest timestamp. | P0 |
| FR-META-2 | **Tags** are free-form key-value or bare-label annotations attached at ingest or added later. Tags are filterable, searchable, and aggregatable across every list and dashboard. | P0 |
| FR-META-3 | **Environments** are first-class, project-scoped entities (e.g. `staging`, `perf`, `prod-mirror`) with a display name, colour, and ordering. Environment is part of the comparability fingerprint. | P0 |
| FR-META-4 | **Build numbers** are captured verbatim as strings and additionally parsed into a sortable ordinal when numeric, so trends order correctly regardless of CI numbering scheme. | P0 |
| FR-META-5 | **Git branch** is captured and used to scope baselines and trends. Default-branch runs are distinguishable from feature-branch runs. | P0 |
| FR-META-6 | **Git commit** SHA is captured with an optional short message and author. Commit ranges link to the configured Git host (GitHub, GitLab, Bitbucket, Azure DevOps) via a per-project URL template. | P0 |
| FR-META-7 | Arbitrary **custom metadata** (up to 50 key-value pairs per run, 256-char values) is accepted, stored, displayed, and filterable. | P1 |
| FR-META-8 | Metadata is editable post-ingest by users with Member role or above; every edit is audit-logged with before/after values. | P1 |
| FR-META-9 | Each run carries a **comparability fingerprint** derived from tool, environment, simulation, and normalized injection profile. Fingerprint components are stored alongside the hash so the algorithm can be revised and recomputed over history. | P0 |

### 6.3 Ingestion and parser engine (`ING`)

| ID | Requirement | Pri |
|---|---|:-:|
| FR-ING-1 | **One endpoint, every CI.** A single authenticated `POST` accepts a compressed results bundle plus metadata. The same short snippet works from Jenkins, GitHub Actions, GitLab CI, Azure Pipelines, CircleCI, or a shell. | P0 |
| FR-ING-2 | **Tool auto-detection.** When `tool` is omitted, every registered plugin's `detect` runs against the bundle. Exactly one match proceeds; zero or multiple produce an actionable error naming each plugin's reason. | P0 |
| FR-ING-3 | **Synchronous verdict with graceful degradation.** The response returns the run summary and SLA verdict. If processing completes within a bounded window (default 25s), the verdict is returned directly with `200` (pass) or `422` (breach). Otherwise `202` is returned with a status URL; `GET /runs/{id}/verdict` returns the identical code once settled. | P0 |
| FR-ING-4 | **Actionable parse failures.** Every failure carries a stable code, a human-readable cause, a required remediation string, and structured detail (line number, record type, expected vs found). Opaque failures are defects. | P0 |
| FR-ING-5 | **Raw bundle retained** in object storage so metrics can be recomputed and new metrics backfilled over history without re-running any test. | P0 |
| FR-ING-6 | **Streaming ingestion for live monitoring.** A run may be opened, fed incremental event batches during execution, and closed. Partial aggregates are queryable and pushed over WebSocket. | P0 |
| FR-ING-7 | **Idempotent ingest.** An optional `Idempotency-Key` header, unique per project, causes a repeat to return the existing run rather than create a duplicate. | P0 |
| FR-ING-8 | **Reprocessing.** A Maintainer may reprocess any run whose raw bundle is retained, recomputing all metrics with the current engine version. Reprocessing is versioned and audit-logged. | P1 |
| FR-ING-9 | **Bundle size limits** are configurable per organization (default 2 GiB) with a clear `413` response. | P0 |
| FR-ING-10 | **Endpoint cardinality cap** (default 2,000 distinct request names per run) fails the run with an error naming dynamic request names as the likely cause. | P0 |
| FR-ING-11 | Ingestion is **asynchronous and isolated** from the read path. A multi-million-request parse never degrades dashboard latency. | P0 |
| FR-ING-12 | **Backpressure and fairness.** Queue depth is bounded per organization so one tenant's ingest burst cannot starve another's. | P1 |

### 6.4 Statistics engine (`STAT`)

| ID | Requirement | Pri |
|---|---|:-:|
| FR-STAT-1 | **Canonical event model.** Every plugin converts native output into a common request-event stream. All downstream logic is tool-agnostic. | P0 |
| FR-STAT-2 | **Full statistics per scope.** For the run globally, per group, per request, and per scenario: total count, OK count, KO count, KO %, count/second, min, max, mean, standard deviation, and configurable percentiles (default 50th, 75th, 95th, 99th). | P0 |
| FR-STAT-3 | **Response time and latency are tracked separately** where the source tool provides the distinction — response time is the full request duration, latency is time to first byte. Both carry the complete statistic set with their own distributions and percentile series. **Beyond parity, not parity:** Gatling 3.15.1.2 reports no latency at all (§A.9 F-2), so this is capability-gated per §21.3 and hidden for tools that cannot express it. | P1 |
| FR-STAT-4 | **Mergeable percentile sketches.** Percentiles are stored as DDSketch sketches per scope and per time bucket with 1% guaranteed relative accuracy. **Averaging percentiles anywhere in the system is a defect.** Re-aggregation always merges sketches. | P0 |
| FR-STAT-5 | **Pre-bucketed time series.** Every time-series chart reads pre-aggregated buckets. The browser never receives raw per-request events. | P0 |
| FR-STAT-6 | **Adaptive bucketing.** Bucket width is chosen so bucket count stays within a cap, by starting fine and coalescing adjacent buckets. Because sketches merge exactly, coalescing is lossless. | P0 |
| FR-STAT-7 | **Separate started and ended counters** per bucket, so requests/second and responses/second are independently reconstructable — their divergence reveals back-pressure. | P0 |
| FR-STAT-8 | **Warm-up exclusion.** Ramp-period requests are excluded from summary statistics while remaining visible in time series. Warm-up is a configured window in V1 and automatically detected in V1.1. | P0 |
| FR-STAT-9 | **True concurrency when available.** Active-user curves derive from the tool's session records where present, falling back to a requests-in-flight proxy, with the source explicitly indicated in the UI. | P0 |
| FR-STAT-10 | **Response time distribution** computed with log-spaced bins covering the observed range, separately for OK and KO responses. | P0 |
| FR-STAT-11 | **Indicator bands.** Share of requests below the lower bound, between bounds, above the upper bound, and failed — with bounds configurable per project (defaults 800 ms / 1200 ms to match Gatling). | P0 |
| FR-STAT-12 | **Error rollup.** Distinct failure messages with counts and percentage share, per run and per request, retaining the top 200 messages with the remainder rolled into an `other` bucket. | P0 |
| FR-STAT-13 | **Group statistics** include cumulated response time and group duration as distinct metrics, matching Gatling's group semantics. | P0 |
| FR-STAT-14 | **Response time against global RPS** and **latency against global RPS** correlation series, exposing the saturation knee. | P0 |
| FR-STAT-15 | **Percentile stability.** Spread of p95 across recent comparable runs, surfacing services degrading before their median moves. | P2 |
| FR-STAT-16 | Statistics computation is **deterministic and versioned**. The engine version is recorded per run so a change in methodology is detectable and backfillable. | P1 |

#### 6.4.6 Cross-tool comparison rule

Different tools measure different things — notably, tools differ in whether connection establishment is included in request duration. **The platform stores the tool on every run, includes it in the comparability fingerprint, and refuses to place runs from different tools on a shared numeric axis.** Attempting it in the UI produces an explanatory message, not a chart. Valid comparison is always within one project, one tool, and one comparability fingerprint.

### 6.5 Dashboards and visualization (`DASH`)

Detailed specifications in §13.

| ID | Requirement | Pri |
|---|---|:-:|
| FR-DASH-1 | **Global Overview** — organization-wide health: projects as rows with latest status, p95 sparkline, error rate, SLA state, time since last run. | P0 |
| FR-DASH-2 | **Run Detail** — full Gatling-parity single-run view (Appendix A). | P0 |
| FR-DASH-3 | **Request Detail**, **Group Detail**, and **Scenario Detail** pages, each at Gatling parity for that scope. | P0 |
| FR-DASH-4 | **Error Dashboard** — error messages, counts, shares, affected endpoints, error timeline, first/last occurrence. | P0 |
| FR-DASH-5 | **Percentile Dashboard** — percentile bands over time with configurable band selection and log-scaled axis. | P0 |
| FR-DASH-6 | **Distribution Dashboard** — response time and latency histograms with OK/KO series and adjustable binning. | P0 |
| FR-DASH-7 | **Timeline Dashboard** — all time-series charts on a shared, linked time axis with synchronized crosshair and zoom. | P0 |
| FR-DASH-8 | **Comparison Dashboard** — two or more runs side by side with per-endpoint deltas sorted by regression magnitude. | P0 |
| FR-DASH-9 | **Trend Analysis** — any metric for any endpoint across the last N comparable runs with a tolerance band showing normal variation. | P0 |
| FR-DASH-10 | **Heatmap** — endpoints as rows, runs as columns, colour encoding delta versus baseline, each row scaled to its own baseline. | P0 |
| FR-DASH-11 | **Live Monitoring** — real-time dashboard for an in-flight run. | P0 |
| FR-DASH-12 | **Custom Dashboards** — user-composed widget grids from a catalogue, saved and optionally shared with a team. | P1 |
| FR-DASH-13 | **Saved Views** — any filter, sort, time range, and column configuration persistable, nameable, shareable by URL. | P1 |
| FR-DASH-14 | **Interactive drill-down** — clicking any endpoint in any chart or table filters all sibling charts to that endpoint. | P0 |
| FR-DASH-15 | Every chart supports export to PNG and SVG; every table supports export to CSV. | P0 |
| FR-DASH-16 | **Annotations** — notes attached to a run or a point in time, visible on trend charts. | P1 |

### 6.6 Filtering, search, and sorting (`FIND`)

| ID | Requirement | Pri |
|---|---|:-:|
| FR-FIND-1 | **Global search** across projects, simulations, runs, endpoints, tags, build numbers, and commits, with typeahead and keyboard navigation. | P0 |
| FR-FIND-2 | **Faceted filtering** on execution lists: project, simulation, environment, tool, branch, tag, status, SLA verdict, date range, build range. | P0 |
| FR-FIND-3 | **In-table filtering** on the statistics table by request name substring, matching Gatling's filter box behaviour and exceeding it with regex support. | P0 |
| FR-FIND-4 | **Multi-column sorting** on every statistics and execution table, persisted in the URL. | P0 |
| FR-FIND-5 | Filter state is fully **URL-encoded** so any view is shareable and bookmarkable. | P0 |
| FR-FIND-6 | Endpoint-level search within a run supports **grouping-aware** matching, so filtering by a group name shows its child requests. | P0 |
| FR-FIND-7 | Saved filter presets per user, promotable to team-wide. | P1 |

### 6.7 Assertions, thresholds, and SLA (`SLA`)

| ID | Requirement | Pri |
|---|---|:-:|
| FR-SLA-1 | **Tool-native assertions** parsed from the source bundle and displayed with expression, expected value, actual value, and pass/fail — matching the Gatling assertions table. | P0 |
| FR-SLA-2 | **Platform absolute rules.** Per-project, per-endpoint thresholds (e.g. p95 ≤ 800 ms) evaluated at ingest, editable in the UI without a code change. | P0 |
| FR-SLA-3 | **Relative-to-history rules.** Thresholds expressed against the trailing median of comparable runs (e.g. p95 ≤ 120% of the 7-run median). | P0 |
| FR-SLA-4 | **Noise-aware regression detection.** A run is flagged only when a metric exceeds the trailing median by more than a configurable multiple of its own recent variability, so naturally noisy endpoints stop crying wolf while steady ones catch small real regressions. | P0 |
| FR-SLA-5 | **Performance baselines.** A run may be pinned as a named baseline; comparisons and heatmaps default to it. Baselines may also be defined as a rolling window. | P0 |
| FR-SLA-6 | **Rules matching nothing** produce a `not_applicable` result surfaced in the response and UI — never a silent pass, which would hide a typo'd endpoint name forever. | P0 |
| FR-SLA-7 | **Rule snapshots.** Each evaluation records the rule as evaluated, so historical verdicts remain explainable after rules change. | P0 |
| FR-SLA-8 | **Commit attribution.** When a regression fires, the commit range between the last clean comparable run and the current one is shown, linked to the Git host. | P0 |
| FR-SLA-9 | **Acknowledgement workflow.** A regression may be acknowledged with a reason (`real`, `environmental`, `expected`, `test-change`), suppressing repeat alerts for that endpoint until it recovers or worsens. | P1 |
| FR-SLA-10 | Rules support **scopes**: global, per request, per group, per scenario, and wildcard patterns. | P0 |

### 6.8 Live monitoring (`LIVE`)

| ID | Requirement | Pri |
|---|---|:-:|
| FR-LIVE-1 | A run may be opened in `running` state, receive incremental batches, and be closed explicitly or by inactivity timeout. | P0 |
| FR-LIVE-2 | Incremental aggregation updates sketches and buckets without recomputing from scratch. | P0 |
| FR-LIVE-3 | Clients subscribe over **WebSocket** and receive metric deltas at a configurable cadence (default 5s, floor 1s). | P0 |
| FR-LIVE-4 | Live dashboard shows active users, requests/s, responses/s, response time percentiles, error rate, and a live error table. | P0 |
| FR-LIVE-5 | A run interrupted mid-flight is finalized as `incomplete` with all data received retained and clearly marked, never silently presented as complete. | P0 |
| FR-LIVE-6 | Live SLA evaluation may fire **early-abort signals** — the platform reports the breach; the decision to stop the test remains with the caller. | P1 |
| FR-LIVE-7 | WebSocket fan-out scales horizontally across API pods via a shared pub/sub channel. | P0 |
| FR-LIVE-8 | Reconnection replays missed deltas from a bounded buffer; beyond the buffer the client resynchronizes with a full snapshot. | P0 |

### 6.9 Notifications (`NOTIF`)

| ID | Requirement | Pri |
|---|---|:-:|
| FR-NOTIF-1 | **Slack** notifications on SLA breach, regression detection, ingest failure, and run completion, configurable per project and per event type. | P0 |
| FR-NOTIF-2 | **Generic webhooks** with a documented, versioned JSON payload and HMAC-SHA256 signature. | P0 |
| FR-NOTIF-3 | **Email** notifications and scheduled report delivery. | P0 |
| FR-NOTIF-4 | **Microsoft Teams** and **PagerDuty** channels. | P2 |
| FR-NOTIF-5 | Notification content includes the offending metric, endpoint, delta versus baseline, commit range, and a deep link. | P0 |
| FR-NOTIF-6 | **Delivery reliability:** retries with exponential backoff, a dead-letter view, and per-channel delivery history. | P1 |
| FR-NOTIF-7 | **Rate limiting and digest mode** so a broadly failing run produces one summary rather than 200 messages. | P0 |

### 6.10 Reporting and export (`REP`)

| ID | Requirement | Pri |
|---|---|:-:|
| FR-REP-1 | **PDF export** of a run, a comparison, or a dashboard, rendered server-side with charts, at print fidelity. | P0 |
| FR-REP-2 | **Standalone HTML export** — a self-contained, offline-viewable report for archival and external sharing. | P1 |
| FR-REP-3 | **Data export** as CSV and JSON for any table, and for raw time-series at a chosen resolution. | P0 |
| FR-REP-4 | **Scheduled reports** — cron-scheduled generation and email delivery, scoped to a project, folder, team, or saved view. | P0 |
| FR-REP-5 | **Report templates** — executive summary, engineering detail, release gate, and trend digest. | P1 |
| FR-REP-6 | **Public share links** — expiring, revocable, optionally password-protected read-only links to a run or comparison. | P1 |
| FR-REP-7 | **On-demand regeneration of the original tool's native report** from the retained raw bundle. | P2 |

### 6.11 Administration, users, RBAC, audit (`ADMIN`)

| ID | Requirement | Pri |
|---|---|:-:|
| FR-ADMIN-1 | **SSO via OIDC** (V1) and **SAML 2.0** (V1.1), with local accounts as a fallback for small deployments. | P0 |
| FR-ADMIN-2 | **SCIM 2.0** user and group provisioning. | P2 |
| FR-ADMIN-3 | **Role-based access control** with five roles (§6.11.1), scoped per team, plus organization-level Owner. | P0 |
| FR-ADMIN-4 | **Group-to-team mapping** from IdP claims, so team membership is managed in the IdP. | P1 |
| FR-ADMIN-5 | **API keys** — user-scoped, permission-limited, expiring, revocable, with last-used tracking. | P0 |
| FR-ADMIN-6 | **Service accounts** — non-human identities with their own role assignments, owned by a team, for CI and automation. | P0 |
| FR-ADMIN-7 | **Ingest tokens** — project-scoped and revocable, so a leaked token can write to one project only. | P0 |
| FR-ADMIN-8 | **Audit logs** covering authentication, authorization changes, project and rule changes, metadata edits, deletions, exports, share-link creation, plugin changes, and administrative actions — with actor, target, before/after, IP, user agent, and timestamp. | P0 |
| FR-ADMIN-9 | Audit logs are **immutable, retained 400 days by default**, filterable, and exportable. | P0 |
| FR-ADMIN-10 | **Retention policy** configurable per organization and per project, tiered by data class (§18.5). | P0 |
| FR-ADMIN-11 | **Usage and quota visibility** — runs ingested, storage consumed, API calls, per organization and project. | P1 |
| FR-ADMIN-12 | **Plugin management** — list installed plugins with version, supported tool versions, health, and enable/disable per organization. | P0 |
| FR-ADMIN-13 | **System health page** — queue depth, worker status, ingest lag, error rates, storage usage. | P0 |

#### 6.11.1 Role permission matrix

| Capability | Viewer | Member | Maintainer | Team Admin | Org Owner |
|---|:-:|:-:|:-:|:-:|:-:|
| View projects, runs, dashboards, trends, comparisons | ✓ | ✓ | ✓ | ✓ | ✓ |
| Export data and generate reports | ✓ | ✓ | ✓ | ✓ | ✓ |
| Create saved views, favorites, bookmarks | ✓ | ✓ | ✓ | ✓ | ✓ |
| Annotate runs, acknowledge regressions, edit metadata | — | ✓ | ✓ | ✓ | ✓ |
| Create and share team dashboards | — | ✓ | ✓ | ✓ | ✓ |
| Configure SLA rules, baselines, alert channels | — | — | ✓ | ✓ | ✓ |
| Manage projects, simulations, ingest tokens, retention | — | — | ✓ | ✓ | ✓ |
| Reprocess runs; delete runs | — | — | ✓ | ✓ | ✓ |
| Create share links | — | — | ✓ | ✓ | ✓ |
| Manage team membership and roles | — | — | — | ✓ | ✓ |
| Manage service accounts | — | — | — | ✓ | ✓ |
| Manage teams, organizations, SSO, plugins, global settings | — | — | — | — | ✓ |
| View audit logs | — | — | scoped | team | org |

### 6.12 Personalization (`PERS`)

| ID | Requirement | Pri |
|---|---|:-:|
| FR-PERS-1 | **Dark mode** with light, dark, and system-following options, persisted per user. | P0 |
| FR-PERS-2 | **Favorites** — star projects, simulations, or runs; favorites surface in a dedicated navigation section. | P1 |
| FR-PERS-3 | **Bookmarks** — save any URL-encoded view with a user-supplied name. | P1 |
| FR-PERS-4 | **Recently viewed** — the last 20 runs and projects, per user. | P1 |
| FR-PERS-5 | **Per-user defaults** — default environment, default time range, default percentile columns, default landing page. | P1 |
| FR-PERS-6 | **Notification preferences** per user, per channel, per event type. | P1 |

### 6.13 Deployment and release tracking (`REL`)

| ID | Requirement | Pri |
|---|---|:-:|
| FR-REL-1 | **Deployment events** may be recorded via API with version, environment, timestamp, and commit, and are rendered as markers on trend charts. | P1 |
| FR-REL-2 | **Release tracking** groups runs by release candidate and shows SLA status across all services in that release. | P1 |
| FR-REL-3 | **Environment comparison** — the same simulation across two environments, side by side, with an explicit warning that absolute comparison across environments is indicative only. | P1 |

---

## 7. Non-Functional Requirements

### 7.1 Availability

| ID | Requirement |
|---|---|
| NFR-AV-1 | Read and API plane: **99.9%** monthly availability, measured externally. |
| NFR-AV-2 | Ingestion plane: **99.5%** monthly; ingest requests are durably accepted before processing so worker outages delay but never lose runs. |
| NFR-AV-3 | No single point of failure in the application tier; all stateless services run with ≥ 2 replicas and pod anti-affinity. |
| NFR-AV-4 | Rolling deploys with zero read-path downtime; backward-compatible migrations only (expand → migrate → contract). |
| NFR-AV-5 | Graceful degradation: if Redis is unavailable, reads fall back to the database and live monitoring degrades to polling; the platform stays usable. |

### 7.2 Performance

| ID | Requirement | Target |
|---|---|---|
| NFR-PF-1 | Dashboard API read latency | p95 < 300 ms, p99 < 800 ms |
| NFR-PF-2 | Chart interaction (hover, zoom, crosshair, filter) — client-side, never refetching raw data | < 100 ms |
| NFR-PF-3 | Run Detail first contentful paint on a 100-endpoint run | < 1.5 s p95 |
| NFR-PF-4 | Ingestion throughput | 5,000,000 request events parsed, aggregated, and persisted in ≤ 3 minutes on 4 vCPU / 8 GiB |
| NFR-PF-5 | Ingest verdict round trip for a typical run (< 200k events) | < 25 s end to end |
| NFR-PF-6 | Live monitoring delta latency, ingest to browser | < 2 s p95 |
| NFR-PF-7 | Browser payload for any single chart | < 500 KB |
| NFR-PF-8 | Comparison of two runs with 500 endpoints each | < 1 s p95 |
| NFR-PF-9 | Trend query across 100 runs | < 500 ms p95 |
| NFR-PF-10 | Frontend bundle, initial route, gzipped | < 300 KB |
| NFR-PF-11 | Read-path cost scales with **run count, not request volume** |

### 7.3 Scalability

| ID | Requirement | Target |
|---|---|---|
| NFR-SC-1 | Projects per deployment | 1,000+ |
| NFR-SC-2 | Runs per deployment | 500,000+ |
| NFR-SC-3 | Concurrent interactive users | 500 |
| NFR-SC-4 | Concurrent live-monitored runs | 50 |
| NFR-SC-5 | Concurrent WebSocket connections | 2,000 |
| NFR-SC-6 | All stateless tiers scale horizontally; ingestion workers scale independently of the API tier |
| NFR-SC-7 | Time-series storage is partitioned so retention is a partition drop, never a delete storm |
| NFR-SC-8 | Read replicas supported for analytical queries |

### 7.4 Security

Full detail in §19. Summary requirements: no unauthenticated endpoints including ingestion; encryption in transit (TLS 1.3) and at rest; project-scoped revocable tokens; secrets never logged; OWASP ASVS L2 conformance; dependency and container scanning in CI; annual penetration test.

### 7.5 Maintainability

| ID | Requirement |
|---|---|
| NFR-MT-1 | Strict module boundaries enforced by lint rules, not convention. Plugin and statistics modules must not import HTTP, database, or configuration code. |
| NFR-MT-2 | Test coverage: ≥ 85% line coverage on statistics and plugin modules; ≥ 70% overall; 100% of the Gatling parity matrix covered by automated tests. |
| NFR-MT-3 | All public APIs described by a generated OpenAPI 3.1 document; drift between code and spec fails CI. |
| NFR-MT-4 | Database changes only via reviewed, reversible migrations. |
| NFR-MT-5 | Architecture Decision Records for every irreversible choice. |

### 7.6 Extensibility

| ID | Requirement |
|---|---|
| NFR-EX-1 | Adding a load testing tool requires implementing the plugin contract (§21) and changes **no** schema, chart, alerting, access-control, or API code. |
| NFR-EX-2 | The plugin contract ships with a reference implementation, a conformance test harness, and a synthetic data generator, so a contributor can build and verify a plugin without a running system. |
| NFR-EX-3 | Plugins declare **capabilities**; the UI hides visualizations a tool cannot support rather than rendering empty charts. |
| NFR-EX-4 | Plugin API changes follow semantic versioning with a documented deprecation window of two minor releases. |

### 7.7 Observability

| ID | Requirement |
|---|---|
| NFR-OB-1 | Structured JSON logs with correlation IDs propagated across API, queue, and worker. |
| NFR-OB-2 | Prometheus metrics: request rate, latency histograms, error rate, queue depth, ingest lag, parse duration, sketch merge counts, WebSocket connections, cache hit ratio. |
| NFR-OB-3 | OpenTelemetry distributed tracing across HTTP, queue, database, and object storage boundaries. |
| NFR-OB-4 | `/health/live` and `/health/ready` endpoints with dependency checks. |
| NFR-OB-5 | Shipped Grafana dashboards and alert rules for the platform's own operation. |
| NFR-OB-6 | Every error surfaced to a user carries a correlation ID that appears in logs. |

### 7.8 Accessibility

| ID | Requirement |
|---|---|
| NFR-AC-1 | **WCAG 2.2 Level AA** conformance across all interactive surfaces. |
| NFR-AC-2 | Full keyboard operability, visible focus indicators, logical tab order, skip links. |
| NFR-AC-3 | Charts are never colour-only: series are distinguished by pattern, marker shape, or direct labelling; failure encoding is consistent platform-wide. |
| NFR-AC-4 | Every chart has an accessible tabular equivalent reachable by keyboard and screen reader. |
| NFR-AC-5 | `prefers-reduced-motion` respected; no animation is required to understand data. |
| NFR-AC-6 | Minimum contrast 4.5:1 for text and 3:1 for graphical objects, verified in both themes. |
| NFR-AC-7 | Automated accessibility tests in CI plus annual manual audit with assistive technology. |

### 7.9 Internationalization

| ID | Requirement |
|---|---|
| NFR-I18N-1 | All user-facing strings externalized; no concatenated sentences. ICU MessageFormat for plurals and gender-neutral phrasing. |
| NFR-I18N-2 | Locale-aware number, date, duration, and percentage formatting. |
| NFR-I18N-3 | English (en-US) ships in V1; the framework supports additional locales without code change. |
| NFR-I18N-4 | Timezone-aware display with a per-user preference, defaulting to browser timezone; all storage in UTC. |
| NFR-I18N-5 | RTL layout support in the design system, validated with a pseudo-locale. |

### 7.10 Disaster recovery, backup, and retention

| ID | Requirement |
|---|---|
| NFR-DR-1 | **RPO ≤ 15 minutes**, **RTO ≤ 1 hour** for the database. |
| NFR-DR-2 | Continuous WAL archiving with point-in-time recovery; nightly full backups retained 30 days, weekly retained 90 days. |
| NFR-DR-3 | Object storage versioned and cross-region replicated where the provider supports it. |
| NFR-DR-4 | **Restore drills quarterly**, with results recorded. An untested backup is not a backup. |
| NFR-DR-5 | Documented, rehearsed runbooks for database failover, queue drain, and full-region recovery. |
| NFR-DR-6 | Tiered retention (§18.5): per-endpoint statistics indefinite; time series 90 days default; raw bundles 30 days default; audit logs 400 days. All configurable. |

### 7.11 Caching strategy

| Layer | Content | Invalidation | TTL |
|---|---|---|---|
| CDN | Static frontend assets | Content hash in filename | 1 year immutable |
| HTTP | Completed-run responses | `ETag` + `Cache-Control: private` | Immutable once run is terminal |
| Redis | Trend series, fleet aggregates, heatmap matrices | Event-driven on new run ingest for the project | 15 min safety TTL |
| Redis | Session and permission resolution | On role or membership change | 5 min |
| In-process | Plugin registry, project settings | Pub/sub invalidation message | 60 s |
| Client | TanStack Query cache | Query-key invalidation on mutation | 5 min stale time |

**Governing rule:** a completed run is immutable, so its metric responses are indefinitely cacheable. Only aggregate and trend views require invalidation, and only for the project that received a new run.

---

## 8. User Stories

Format: **US-n** — *As a [persona], I want [capability], so that [outcome].* Acceptance criteria are in §9.

### 8.1 Parity and single-run analysis

| ID | Story | Persona | Pri |
|---|---|---|:-:|
| US-1 | I want every chart and statistic from the Gatling HTML report available in the platform, so that I can stop publishing HTML artifacts entirely. | Priya | P0 |
| US-2 | I want to filter the statistics table by request name, so that I can find one endpoint among hundreds. | Priya | P0 |
| US-3 | I want to sort the statistics table by any column, so that I can rank endpoints by p99 or error rate. | Priya | P0 |
| US-4 | I want to click an endpoint and have every chart on the page filter to it, so that I can analyze it without changing pages. | Priya | P0 |
| US-5 | I want to see response time and latency as separate metrics, so that I can distinguish network cost from server cost. | Priya | P0 |
| US-6 | I want a group detail page showing cumulated response time and duration, so that group-level analysis matches what Gatling reports. | Priya | P0 |
| US-7 | I want to see the distribution histogram with OK and KO series, so that I can see whether failures cluster at a particular latency. | Priya | P0 |
| US-8 | I want response time plotted against global RPS, so that I can identify the saturation knee. | Sam | P0 |

### 8.2 History, comparison, and trends

| ID | Story | Persona | Pri |
|---|---|---|:-:|
| US-9 | I want to see every historical execution of a simulation in one list, so that I never lose a result again. | Priya | P0 |
| US-10 | I want to compare two runs side by side with per-endpoint deltas sorted by regression magnitude, so that the worst regression is first. | Priya | P0 |
| US-11 | I want a trend chart of p95 for one endpoint across the last 50 runs with a normal-variation band, so that a real regression is visually obvious. | Maya | P0 |
| US-12 | I want an endpoint × build heatmap, so that I can see at a glance which endpoints are drifting. | Priya | P0 |
| US-13 | I want to pin a run as a baseline, so that all comparisons default to a known-good reference. | Aisha | P0 |
| US-14 | I want trends to visibly break where the environment or profile changed, so that I don't chase a phantom regression. | Priya | P0 |
| US-15 | I want to annotate a run with context, so that a future reader knows infra was noisy that day. | Priya | P1 |

### 8.3 Gating, detection, and notification

| ID | Story | Persona | Pri |
|---|---|---|:-:|
| US-16 | I want CI to fail when an SLA threshold is breached, without writing extra scripting, so that regressions cannot merge silently. | Daniel | P0 |
| US-17 | I want alerts only when a change exceeds an endpoint's own normal noise, so that I don't learn to ignore them. | Daniel | P0 |
| US-18 | I want the alert to name the endpoint, the delta, and the commit range, so that I can start investigating immediately. | Daniel | P0 |
| US-19 | I want to acknowledge a regression as environmental, so that it stops paging the team while remaining on the record. | Sam | P1 |
| US-20 | I want one digest message when a run fails broadly, not two hundred messages. | Sam | P0 |
| US-21 | I want thresholds expressed relative to recent history, so that gates adapt as the service legitimately evolves. | Priya | P0 |

### 8.4 Live monitoring

| ID | Story | Persona | Pri |
|---|---|---|:-:|
| US-22 | I want to watch a running test in real time, so that I can stop a six-hour soak that failed in minute three. | Sam | P0 |
| US-23 | I want live error rate and a live error table, so that I can see what is failing as it fails. | Sam | P0 |
| US-24 | I want a test that dies mid-run to be preserved and clearly marked incomplete, so that partial evidence isn't lost or misread. | Sam | P0 |

### 8.5 Organization, sharing, and reporting

| ID | Story | Persona | Pri |
|---|---|---|:-:|
| US-25 | I want a fleet overview of every project's health, so that one screen answers whether anything is degrading. | Maya | P0 |
| US-26 | I want a weekly emailed trend report, so that I don't have to ask engineers for numbers. | Maya | P0 |
| US-27 | I want to export a run as PDF, so that I can attach evidence to a release review. | Aisha | P0 |
| US-28 | I want to share a read-only link with a vendor, expiring in 7 days, so that I can share evidence without granting access. | Aisha | P1 |
| US-29 | I want to save a filtered view and share its URL, so that my team lands on exactly what I'm looking at. | Priya | P1 |
| US-30 | I want to organize projects into folders and tag runs, so that a thousand projects stay navigable. | Rahul | P1 |

### 8.6 Administration and extension

| ID | Story | Persona | Pri |
|---|---|---|:-:|
| US-31 | I want SSO and IdP-driven team membership, so that access follows joiners and leavers automatically. | Rahul | P0 |
| US-32 | I want project-scoped ingest tokens, so that a leaked CI token cannot write to every project. | Rahul | P0 |
| US-33 | I want an immutable audit log of every permission and configuration change, so that I can answer compliance questions. | Rahul | P0 |
| US-34 | I want to add support for a new load testing tool by writing one plugin, so that adoption isn't blocked on the product roadmap. | Rahul | P0 |
| US-35 | I want service accounts for CI, so that automation isn't tied to a departing employee's account. | Rahul | P0 |
| US-36 | I want retention configurable per data class, so that storage cost stays bounded without losing trend history. | Rahul | P0 |

---

## 9. Acceptance Criteria

Written in Given/When/Then. Each maps to one or more user stories. These are the contract for "done."

### 9.1 Gatling parity — the V1 gate

> **AC-PARITY-1**
> **Given** a reference Gatling simulation with known output, executed and ingested,
> **When** the platform's Run Detail, Request Detail, Group Detail, and Scenario Detail pages are compared element by element against the Gatling-generated HTML report,
> **Then** every chart, table, statistic, and assertion listed in Appendix A is present, **and** every numeric value matches the Gatling report within the tolerances in AC-PARITY-2.

> **AC-PARITY-2** *(revised after verification — see §A.9 F-6, F-8)*
> **Given** the same source data, statistics fall into two classes with different obligations.
>
> **Exact quantities — must match Gatling's displayed value exactly:** total count, OK count, KO count, % KO, count/second, min, max, mean, standard deviation, indicator band counts, error message counts, and distribution bin labels (the midpoint-labelled bins of §A.9 F-8; the platform additionally holds the exact underlying counts, but what Gatling *displays* per bin is a percentage of the combined OK+KO count to 2dp, compared exact to 2dp — not a count).
>
> **Estimated quantities — percentiles — are compared against ground truth, NOT against Gatling's displayed value.** The platform's percentile must fall within **1% relative error of the true percentile computed from the fully sorted decoded event set**. Divergence from the number Gatling prints is expected and correct.

> **Why percentiles are not compared to Gatling.** Gatling's reported percentiles are histogram estimates, not observations. In the reference fixture Gatling reports p99 = 2369 ms, and **2369 does not occur anywhere in the data** — the sorted tail jumps from 2287 to 2501. The true p99 is 2501, so Gatling's figure is 5.3% low.
>
> Requiring a match to Gatling would mean **deliberately reproducing its estimator's error**, which directly contradicts FR-STAT-4 and the product's central accuracy claim. The platform is required to be *more* accurate than the report it replaces, and to be able to say so. Expect Gatling to under-report extreme percentiles on small samples; the gap narrows as sample count grows.

> **AC-PARITY-3**
> **Given** the parity matrix in Appendix A,
> **Then** an automated test asserts each row against a checked-in reference bundle, and CI fails if any row regresses. Parity is re-validated against each newly supported Gatling major version.

> **AC-PARITY-4**
> **Given** a project with non-default `indicators` bounds and non-default percentile columns configured,
> **When** the Run Detail page renders,
> **Then** the indicator bands and statistics table columns reflect that configuration, matching Gatling's configurability.

### 9.2 Ingestion

> **AC-ING-1** — **Given** a valid Gatling bundle and a valid project ingest token, **when** posted to the ingest endpoint, **then** a run is created, all statistics and time series are computed, and a verdict is returned with `200` (pass) or `422` (breach) within the bounded wait window.

> **AC-ING-2** — **Given** a bundle whose processing exceeds the bounded wait, **when** posted, **then** the response is `202` with a status URL, **and** polling that URL returns the identical status code the synchronous path would have returned once processing settles.

> **AC-ING-3** — **Given** an unparseable bundle, **when** posted, **then** the response carries a stable error code, a human-readable cause, a non-empty remediation string, and structured detail, **and** no partial run is left visible.

> **AC-ING-4** — **Given** a worker is killed mid-parse, **when** it restarts, **then** the run is processed to completion exactly once and no data is lost.

> **AC-ING-5** — **Given** the same `Idempotency-Key` posted twice to one project, **then** exactly one run exists and both responses describe it.

> **AC-ING-6** — **Given** a bundle producing more distinct request names than the project's cardinality cap, **then** the run fails with `ENDPOINT_CARDINALITY_EXCEEDED` naming dynamic request names as the likely cause and listing samples.

> **AC-ING-7** — **Given** a run being ingested at maximum throughput, **when** dashboard requests are issued concurrently, **then** read-path p95 latency stays within NFR-PF-1.

### 9.3 Statistical correctness

> **AC-STAT-1** — **Given** a synthetic dataset with a known exact distribution, **when** percentiles are computed via merged sketches at any aggregation level, **then** every result is within 1% relative error of the exact value computed from the fully sorted dataset.

> **AC-STAT-2** — **Given** time-series buckets at 1-second resolution, **when** coalesced to 4-second resolution, **then** the resulting sketches are identical to sketches built directly at 4-second resolution. *(Lossless coalescing invariant.)*

> **AC-STAT-3** — **Given** any code path that produces a percentile, **then** static analysis confirms it derives from a sketch and never from an arithmetic mean of other percentiles. A violation fails CI.

> **AC-STAT-4** — **Given** a project with a configured warm-up window, **then** summary statistics exclude that window **and** time-series charts still display it, visually demarcated.

> **AC-STAT-5** — **Given** two runs with different comparability fingerprints, **when** a trend chart spans them, **then** the line is visibly broken with an explanatory marker, never silently connected.

> **AC-STAT-6** — **Given** two runs produced by different tools, **when** a user attempts to overlay them numerically, **then** the platform declines and explains why, rather than rendering the chart.

### 9.4 Dashboards and interaction

> **AC-DASH-1** — **Given** a run with 500 endpoints, **when** Run Detail loads, **then** first contentful paint is under 1.5 s at p95 and the statistics table is virtualized and scrollable at 60 fps.

> **AC-DASH-2** — **Given** any time-series chart, **when** the user zooms or hovers, **then** no network request is issued and the interaction completes in under 100 ms.

> **AC-DASH-3** — **Given** a user clicks an endpoint in the statistics table, **then** every sibling chart on the page filters to that endpoint and the URL updates to reflect the selection.

> **AC-DASH-4** — **Given** any filtered, sorted, zoomed view, **when** its URL is copied and opened in a new session by an authorized user, **then** the identical view renders.

> **AC-DASH-5** — **Given** the user's system is set to dark mode, **when** the platform loads for the first time, **then** it renders in dark mode with all charts meeting contrast requirements.

### 9.5 Live monitoring

> **AC-LIVE-1** — **Given** a run in `running` state receiving batches, **when** a user opens the live dashboard, **then** metrics update at least every 5 s with end-to-end latency under 2 s at p95.

> **AC-LIVE-2** — **Given** a live client disconnects for under the replay-buffer window, **when** it reconnects, **then** missed deltas are replayed and no data gap appears.

> **AC-LIVE-3** — **Given** a live run stops sending data and exceeds the inactivity timeout, **then** it is finalized as `incomplete`, all received data is retained, and the UI labels it unambiguously.

> **AC-LIVE-4** — **Given** 50 concurrent live runs and 2,000 WebSocket subscribers, **then** delta latency stays within AC-LIVE-1 and no messages are dropped.

### 9.6 SLA, detection, and notification

> **AC-SLA-1** — **Given** an absolute rule `p95 ≤ 800 ms` on endpoint `/checkout` and a run where that endpoint records p95 of 950 ms, **then** the run verdict is `breach`, the response returns `422`, the assertion records actual and threshold, and the configured channels are notified.

> **AC-SLA-2** — **Given** a rule whose pattern matches no endpoint in a run, **then** the assertion records `not_applicable`, the response surfaces the count, and the run is **not** failed on that basis.

> **AC-SLA-3** — **Given** an endpoint whose p95 varies ±15% run to run, **when** a run comes in 10% above the trailing median, **then** no regression is flagged. **When** one comes in 60% above, **then** a regression is flagged.

> **AC-SLA-4** — **Given** a flagged regression, **then** the notification and UI show the commit range between the last clean comparable run and this one, linked to the configured Git host.

> **AC-SLA-5** — **Given** a rule is edited after a run was evaluated, **when** that historical run's assertions are viewed, **then** the rule as originally evaluated is displayed from the stored snapshot.

> **AC-SLA-6** — **Given** a run breaching 200 rules, **then** exactly one digest notification is delivered per channel.

### 9.7 Security and administration

> **AC-SEC-1** — **Given** any API route including ingestion, **when** called without valid credentials, **then** it returns `401` and no data is disclosed. An automated test enumerates every route to prove no unauthenticated surface exists.

> **AC-SEC-2** — **Given** a user with access to organization A, **when** they request a resource in organization B by ID, **then** they receive `404` (not `403`, which would confirm existence).

> **AC-SEC-3** — **Given** an ingest token scoped to project X, **when** used to post to project Y, **then** the request is rejected with `403` and the attempt is audit-logged.

> **AC-SEC-4** — **Given** any permission change, project deletion, metadata edit, export, or share-link creation, **then** an immutable audit record exists with actor, target, before/after, IP, user agent, and timestamp.

> **AC-SEC-5** — **Given** a revoked token or API key, **when** used, **then** it fails immediately with no cache-induced grace period exceeding 60 seconds.

### 9.8 Plugin architecture

> **AC-PLUG-1** — **Given** a new plugin implementing the contract, **when** installed, **then** every dashboard, chart, export, alert, and API endpoint functions against its data with **no changes** to any code outside the plugin.

> **AC-PLUG-2** — **Given** a plugin whose tool does not report latency separately, **then** latency visualizations are hidden rather than rendered empty, driven by the plugin's declared capabilities.

> **AC-PLUG-3** — **Given** the published plugin conformance harness, **when** run against a plugin, **then** it validates the canonical event stream, capability declarations, error handling, and statistical output without requiring a running platform.

---

## 10. Use Cases

### UC-1 — Regression caught and attributed in CI

**Actor** Daniel (Developer) · **Trigger** merge to `main` runs the nightly load test

1. CI executes the Gatling simulation and posts the results bundle with build number, branch, and commit.
2. Ingestion parses, aggregates, and evaluates absolute, relative, and noise-aware rules.
3. `/api/v1/checkout` exceeds its trailing median p95 by 3.4× its recent variability.
4. The response is `422`; CI fails the build.
5. Slack receives a digest naming the endpoint, delta, commit range, and deep link.
6. Daniel opens the comparison view, sees `/checkout` p95 moved 210 ms → 780 ms, and identifies the responsible commit from the three-commit range.

**Alternate — noisy endpoint:** variability is high and the delta is within the noise multiple; no flag is raised and the build passes. *(AC-SLA-3)*

**Alternate — environmental:** Daniel acknowledges the regression as `environmental` with a note; alerts suppress until the metric worsens or recovers. *(FR-SLA-9)*

---

### UC-2 — Retiring the static Gatling report

**Actor** Priya (Performance Engineer) · **Trigger** team evaluates whether the platform can replace HTML artifacts

1. Priya ingests a run whose HTML report she has open beside the platform.
2. She walks the parity matrix: statistics table columns, indicators, error table, active users, distribution, percentiles over time, requests/s, responses/s.
3. She opens a request detail page and confirms response time vs. latency, both distributions, both percentile series, and both RPS correlation charts.
4. She opens a group and confirms cumulated response time and duration.
5. She confirms assertions appear with expression, expected, actual, and status.
6. She finds every number matching within stated tolerance, plus filtering, sorting, and drill-down the static report lacks.
7. The team removes the HTML publishing step from CI. *(BG-1)*

---

### UC-3 — Live soak test aborted early

**Actor** Sam (SRE) · **Trigger** six-hour pre-release soak

1. The injector opens a live run and streams batches every 10 s.
2. Sam opens the live dashboard: active users, requests/s, responses/s, percentiles, error rate.
3. At 02:14 error rate climbs from 0.1% to 4.2%; the live error table shows connection-pool exhaustion.
4. A live SLA rule fires and posts to Slack.
5. Sam stops the test in CI. The platform finalizes the run as `incomplete` with all received data retained and clearly labelled.
6. Post-incident, the run remains permanently available with an annotation recording the cause. *(US-22, US-24, AC-LIVE-3)*

---

### UC-4 — Quarterly reliability review

**Actor** Maya (Engineering Manager) · **Trigger** quarterly business review

1. A scheduled report generates on the first of the quarter across her folder of twelve projects.
2. It contains per-service p95 and error-rate trends, SLA compliance percentages, regression counts, and top regressed endpoints.
3. It arrives by email as PDF.
4. Maya drills into one service showing sustained p95 growth and finds annotations correlating it with a deployment marker.
5. She exports the trend chart for the review deck. *(US-26, FR-REP-4, FR-REL-1)*

---

### UC-5 — Onboarding a new tool via plugin

**Actor** Rahul (Platform Engineer) · **Trigger** a team adopts Locust

1. Rahul reads the plugin contract and runs the reference implementation.
2. He implements `detect`, `parse`, capability declarations, and metadata extraction against the canonical event model.
3. He validates using the conformance harness and the synthetic data generator, with no platform running.
4. He publishes the plugin and enables it for his organization.
5. The team posts a Locust run. Every dashboard works. Latency-specific charts are hidden because the plugin does not declare that capability.
6. No platform code changed. *(US-34, AC-PLUG-1, AC-PLUG-2)*

---

### UC-6 — Release gate across services

**Actor** Aisha (Release Manager) · **Trigger** release candidate `2026.8.1`

1. Each service's pipeline posts its run tagged `release:2026.8.1`.
2. The release dashboard lists every service, its SLA verdict, and its regression status for that tag.
3. Two services show breaches; Aisha opens each comparison and confirms one is a known load-profile change.
4. She records an annotation and exports the release evidence bundle as PDF.
5. The audit log retains who approved what and when. *(FR-REL-2, FR-ADMIN-8)*

---

## 11. Information Architecture

### 11.1 Entity hierarchy

```
Organization
├── Teams ──────────────► Users (role per team)
├── Service Accounts
├── Plugins (enabled per org)
├── Audit Log
└── Folders (nested, presentation only, max depth 8)
    └── Projects                    ◄── the unit of access control
        ├── Settings (warm-up, indicators, percentiles, retention, Git host)
        ├── Environments
        ├── Ingest Tokens
        ├── SLA Rules
        ├── Baselines
        ├── Notification Channels
        ├── Dashboards (custom)
        └── Simulations
            └── Runs                ◄── the unit of analysis
                ├── Metadata (build, branch, commit, tags, environment, profile)
                ├── Assertions (tool-native + platform)
                ├── Annotations
                ├── Statistics ── global │ scenario │ group │ request
                ├── Time Series ── per scope, per bucket
                ├── Errors
                └── Raw Bundle (object storage)
```

### 11.2 Content model per run

| Layer | Content | Retention | Growth driver |
|---|---|---|---|
| **Run header** | Identity, metadata, fingerprint, verdict | Indefinite | Run count |
| **Statistics** | Per-scope aggregates + sketches | Indefinite | Run count × endpoint count |
| **Time series** | Per-bucket counters + sketches | 90 days default | Run count × endpoints × buckets |
| **Errors** | Top 200 messages + rollup | Indefinite | Run count |
| **Assertions** | Results + rule snapshots | Indefinite | Run count × rule count |
| **Raw bundle** | Original archive | 30 days default | Run count × bundle size |

**Design consequence.** Trend history lives entirely in the statistics layer, which is small and never expires. High-resolution detail ages out. A three-year-old run still contributes to trends; only its per-second detail is gone.

### 11.3 Navigation taxonomy

| Axis | Values | Where used |
|---|---|---|
| Scope | Organization → Folder → Project → Simulation → Run → Endpoint | Breadcrumbs, drill-down |
| Time | Absolute range, relative range, last N runs | All history views |
| Environment | Project-defined | Filters, comparison |
| Tool | gatling, k6, jmeter, locust, artillery | Filters — never a comparison axis |
| Branch | Git branch | Trends, baselines |
| Tag | Free-form | Filters, release grouping |
| Status | running, complete, incomplete, failed | Execution lists |
| Verdict | pass, breach, not_evaluated | Execution lists, release dashboard |

---

## 12. Navigation Structure

### 12.1 Primary navigation

```
┌─ Perf Portal ──────────────────────────────────────────────────────────┐
│  [Logo]  Search (⌘K)              Env ▾   Theme ▾   Alerts ▾   User ▾  │
├────────────┬───────────────────────────────────────────────────────────┤
│ SIDEBAR    │                                                           │
│            │                                                           │
│ Overview   │   Breadcrumb: Org / Folder / Project / Simulation / Run   │
│ Projects   │   ──────────────────────────────────────────────────────  │
│ Executions │                                                           │
│ Compare    │   [ Contextual tab bar ]                                  │
│ Trends     │                                                           │
│ Live ●     │   Main content                                            │
│ Reports    │                                                           │
│ ────────   │                                                           │
│ Favorites  │                                                           │
│ Saved      │                                                           │
│ Recent     │                                                           │
│ ────────   │                                                           │
│ Admin      │                                                           │
└────────────┴───────────────────────────────────────────────────────────┘
```

The `Live ●` indicator shows a count badge when runs are in flight.

### 12.2 Route map

| Route | Page | Access |
|---|---|---|
| `/` | Global Overview (fleet health) | Viewer |
| `/projects` | Project browser — folder tree + grid/list toggle | Viewer |
| `/projects/:slug` | Project home — simulations, recent runs, trend summary, SLA state | Viewer |
| `/projects/:slug/simulations/:sim` | Simulation home — execution history, trends, baseline | Viewer |
| `/runs/:runId` | **Run Detail** — global parity view | Viewer |
| `/runs/:runId/requests/:name` | **Request Detail** | Viewer |
| `/runs/:runId/groups/:name` | **Group Detail** | Viewer |
| `/runs/:runId/scenarios/:name` | **Scenario Detail** | Viewer |
| `/runs/:runId/errors` | Error Dashboard | Viewer |
| `/runs/:runId/assertions` | Assertions & Thresholds | Viewer |
| `/runs/:runId/live` | Live Monitoring (running runs) | Viewer |
| `/executions` | Global execution history with facets | Viewer |
| `/compare?runs=a,b` | Comparison Dashboard | Viewer |
| `/trends?project=&metric=&endpoint=` | Trend Analysis | Viewer |
| `/heatmap?project=` | Endpoint × build heatmap | Viewer |
| `/releases/:tag` | Release Tracking | Viewer |
| `/dashboards` · `/dashboards/:id` | Custom dashboards | Viewer / Member to edit |
| `/reports` · `/reports/schedules` | Report generation and schedules | Viewer / Maintainer |
| `/admin/*` | Users, teams, projects, tokens, service accounts, plugins, retention, audit, health | Team Admin / Org Owner |
| `/settings/*` | Personal preferences, API keys, notifications | Authenticated |

### 12.3 Run Detail tab structure

```
Run · CheckoutSimulation · build 4821 · staging · gatling 3.x · 2026-08-07 14:22 · [PASS]
─────────────────────────────────────────────────────────────────────────────
 Overview │ Requests │ Groups │ Scenarios │ Errors │ Assertions │ Timeline │ Raw
```

### 12.4 Interaction and keyboard model

| Interaction | Behaviour |
|---|---|
| Click endpoint row | Filters all sibling charts; updates URL; does not navigate |
| Double-click endpoint row | Navigates to Request Detail |
| Drag on any time chart | Zooms all linked charts to that range |
| Hover on any time chart | Synchronized crosshair with shared tooltip across all linked charts |
| Click legend item | Toggles series across all charts sharing that series |
| `⌘K` / `Ctrl+K` | Global command palette and search |
| `/` | Focus the nearest filter input |
| `g` then `o` / `p` / `e` / `t` | Go to Overview / Projects / Executions / Trends |
| `c` | Compare current run with baseline |
| `?` | Keyboard shortcut reference |
| `Esc` | Clear selection / close overlay |

**Breadcrumb rule.** The breadcrumb always reflects true entity hierarchy and every segment is clickable. Drill-down never traps the user; every filtered state is reachable and reversible via URL.

---

## 13. Dashboard Specifications

Common conventions for every chart:

- **Library** Apache ECharts, canvas renderer, with a shared theme for light and dark.
- **Colour semantics** OK = teal, KO/failure = red, warning band = amber, baseline = neutral grey, current = accent. Failure is red **and** dashed **and** labelled — never colour alone (NFR-AC-3).
- **Linked axes** All time-series charts on a page share one time axis, one crosshair, and one zoom state.
- **No refetch on interaction** All data for the current scope is loaded once; zoom and hover are client-side (NFR-PF-2).
- **Accessible equivalent** Every chart exposes a keyboard-reachable data table (NFR-AC-4).
- **Export** PNG, SVG, and underlying CSV from every chart's overflow menu.

---

### 13.1 Global Overview (fleet health)

**Purpose** One screen answers: is anything degrading anywhere?

| Element | Specification |
|---|---|
| Summary tiles | Total projects · runs in last 24h · active SLA breaches · runs in flight · regressions awaiting acknowledgement |
| Project table | One row per project: name, team, environment, last run time, **p95 sparkline over last 20 comparable runs**, current p95 with delta vs baseline, error rate, SLA badge, regression badge |
| Sparkline | 20-point line, baseline band shaded, current point emphasized; breaks where the fingerprint changed |
| Sorting | By degradation magnitude (default), name, last run, error rate |
| Filtering | Folder, team, environment, tool, tag, SLA state |
| Density | Comfortable / compact toggle, persisted per user |
| Empty state | Onboarding guidance with a copyable CI snippet |

---

### 13.2 Run Detail — Overview tab *(Gatling parity core)*

Ordered to mirror the Gatling report so a migrating user finds everything where they expect it.

| # | Element | Specification | Gatling parity |
|---|---|---|---|
| 1 | **Run header** | Simulation name, description, start time, duration, tool + version, environment, build, branch, commit (linked), tags, verdict badge | ✓ Report header |
| 2 | **Assertions panel** | Table: assertion expression, expected, actual, status. Shown when assertions exist. Platform SLA results shown in a second, clearly separated group | ✓ Assertions |
| 3 | **Indicators** | Horizontal stacked bar + counts + percentages for four bands: `t < lower`, `lower ≤ t < upper`, `t ≥ upper`, `failed`. Bounds from project settings (defaults 800 / 1200 ms) | ✓ Ranges/Indicators |
| 4 | **Request counts** | Donut: OK vs KO with totals and percentage | ✓ Number of requests |
| 5 | **Statistics table** | Hierarchical (groups expandable to requests), virtualized, sortable on every column, filterable by name (substring + regex). Columns — **Requests:** Total, OK, KO, %KO, Cnt/s · **Response Time (ms):** Min, 50th, 75th, 95th, 99th, Max, Mean, Std Dev. Percentile columns configurable per project | ✓ Statistics table |
| 6 | **Errors table** | Distinct error message, count, percentage of total errors, affected endpoint count; expandable to per-endpoint breakdown | ✓ Errors |
| 7 | **Concurrent Users over Time** | Line per scenario plus total. Source badge: `sessions` or `in-flight proxy` | ✓ Number of concurrent users |
| 7ᵇ | **Users Started per Second** | User *arrival rate*, line per scenario. Distinct from concurrency: a constant arrival rate produces a rising concurrency curve when the service slows, and that divergence is the signal | ✓ Number of users started per second |
| 8 | **Response Time Distribution** | Histogram, log-spaced bins, OK and KO as distinct series | ✓ Response Time Distribution |
| 9 | **Response Time Percentiles over Time** | Stacked percentile bands (min, 25th, 50th, 75th, 80th, 85th, 90th, 95th, 98th, 99th, 99.9th, max), **log-scaled Y** so all bands stay legible; band selection toggleable | ✓ Response Time Percentiles over Time |
| 10 | **Requests per Second over Time** | All / OK / KO series. Active users is **not** overlaid on a second axis — it is the time-linked chart directly above, sharing one crosshair (§22.4) | ✓ Requests per Second |
| 11 | **Responses per Second over Time** | All / OK / KO series. **Plotted separately from requests/s** — their divergence reveals back-pressure | ✓ Responses per Second |

> **Deliberate encoding change from the Gatling report.** Gatling overlays active users on the requests/s chart using a secondary y-axis. This platform presents active users as its own time-linked chart in the same stack instead. A dual-axis chart lets two unrelated scales be positioned so the lines appear to track — the apparent correlation is an artifact of axis choice, not of the data. Every value Gatling shows is still present and still readable at the same instant through the shared crosshair, so this is **information parity with a corrected encoding**, and Appendix A records it as such rather than as a gap.

---

### 13.3 Request Detail page

Everything in §13.2 scoped to one request, plus the response-time/latency distinction and saturation correlation.

| # | Element | Notes | Gatling parity |
|---|---|---|---|
| 1 | Statistics row | Full statistic set for this request | ✓ |
| 2 | Indicators | Bands for this request | ✓ |
| 3 | Response Time Distribution | OK / KO series | ✓ |
| 5 | Response Time Percentiles over Time | Full band set | ✓ |
| 7 | Requests per Second over Time | This request | ✓ |
| 8 | Responses per Second over Time | This request | ✓ |
| 9 | **Response Time against Global RPS** | Scatter/density, X = global RPS, Y = response time. Exposes the saturation knee | ✓ |
| 11 | Errors for this request | Message, count, share | ✓ |
| 4·6·10 | *Latency distribution, latency percentiles, latency vs. global RPS* | **Beyond parity** — Gatling 3.15.1.2 reports no latency (§A.9 F-2). Rendered only when the plugin declares the `latency` capability; hidden entirely otherwise | — |
| 12 | *Trend strip* | **Beyond parity** — this endpoint's p95 across recent comparable runs, inline | — |

---

### 13.4 Group Detail page

| Element | Notes |
|---|---|
| **Cumulated Response Time** statistics and charts | Sum of child request durations — Gatling group semantics |
| **Duration** statistics and charts | Wall-clock time of the group |
| Full chart set | Distribution and percentiles over time, applied to both cumulated response time and duration. **No per-second charts** — §A.9 F-4 records that Gatling's group page has none |
| Group indicators / ranges | `RangesContainerId`, folded from the cumulated row (GR-09) |
| Nested groups | Rendered hierarchically to arbitrary depth |

---

### 13.5 Scenario Detail page — *beyond parity*

> Gatling 3.15.1.2 has **no scenario detail page** (§A.9 F-3); scenario identity appears only as a series in the global concurrent-users and user-start-rate charts. This page is a platform addition, not a parity obligation, and no parity test asserts it. It is retained because per-scenario analysis is genuinely useful and the canonical model already carries `scenario` on every request event.

| Element | Notes |
|---|---|
| Scenario statistics | Full statistic set across all requests in the scenario |
| Active users for this scenario | Isolated from the global curve |
| Request composition | Table of requests within the scenario, with share of volume and share of total time |
| Full chart set | Distribution, percentiles, requests/s, responses/s scoped to the scenario |

---

### 13.6 Error Dashboard

| Element | Specification |
|---|---|
| Error summary tiles | Total errors · distinct messages · error rate · most-affected endpoint |
| Error table | Message (truncated with expand), count, % of errors, % of total requests, affected endpoints, first and last occurrence |
| Error timeline | Stacked area of errors over time by message (top 10, remainder as `other`) |
| Endpoint × error matrix | Rows = endpoints, columns = error messages, cell = count |
| Filtering | By message substring, endpoint, time window |
| Drill-down | Selecting an error filters the timeline and matrix and cross-links to affected Request Detail pages |

---

### 13.7 Percentile Dashboard

| Element | Specification |
|---|---|
| Band selector | Toggle any subset of min, 25th, 50th, 75th, 80th, 85th, 90th, 95th, 98th, 99th, 99.9th, max |
| Y-axis | Log scale by default, linear toggle |
| Scope selector | Global, scenario, group, or request |
| Overlay | Optional baseline run's bands as a ghosted comparison |
| Reading aid | Hovering shows all selected bands at that instant in one tooltip, ordered |

---

### 13.8 Distribution Dashboard

| Element | Specification |
|---|---|
| Histogram | Log-spaced bins by default; bin count adjustable (20–200); linear binning toggle |
| Series | OK and KO, overlaid or stacked (toggle) |
| Metric | Response time or latency |
| Markers | Vertical lines at selected percentiles and at indicator bounds |
| Cumulative toggle | Switches to a CDF view for reading "what share completed under X ms" |

---

### 13.9 Timeline Dashboard

All time-series charts stacked on one shared axis: active users, requests/s, responses/s, percentile bands, error rate, and (when live) an in-flight counter. Shared crosshair, shared zoom, shared legend. Annotation and deployment markers render as vertical rules across every chart. This is the "what happened when" surface.

---

### 13.10 Comparison Dashboard

| Element | Specification |
|---|---|
| Run selectors | Two or more runs (up to 4). Guardrail: differing comparability fingerprints trigger a prominent warning; differing tools are refused outright |
| Delta table | Per endpoint: metric value in each run, absolute delta, percentage delta, significance indicator relative to that endpoint's historical variability. **Sorted by regression magnitude descending by default** |
| Visual encoding | Regressions and improvements visually distinct by colour **and** direction glyph |
| Metric selector | Any statistic; p95 default |
| Overlay charts | Percentile series, distribution, and requests/s overlaid across the compared runs |
| Filters | Only regressions · only improvements · only significant changes · endpoint name |
| Export | CSV of the delta table; PDF of the full comparison |

---

### 13.11 Trend Analysis

| Element | Specification |
|---|---|
| Selectors | Project, simulation, endpoint (or all), metric, branch, environment, last N runs or date range |
| Chart | Metric across runs, X = run ordered by build ordinal then start time |
| Tolerance band | Shaded band at trailing median ± k × variability, so a regression is visually obvious |
| Fingerprint breaks | Line **breaks** where comparability changed, with a marker explaining what changed |
| Markers | Annotations, deployment events, baseline pin |
| Multi-series | Up to 8 endpoints overlaid, or small-multiples grid |
| Drill-down | Clicking a point opens that Run Detail |

---

### 13.12 Endpoint × build heatmap

| Element | Specification |
|---|---|
| Layout | Rows = endpoints (sortable by drift), columns = recent runs (chronological) |
| Colour | Delta versus baseline, **each row normalized to its own baseline** so fast and slow endpoints are comparable by drift rather than absolute latency |
| Scale | Diverging, colour-blind-safe, with a legend and explicit numeric labels on hover |
| Interaction | Click a cell → that endpoint in that run; click a row header → that endpoint's trend |
| Density | Endpoint limit with pagination and a "top N by drift" mode |

---

### 13.13 Live Monitoring Dashboard

| Element | Specification |
|---|---|
| Status bar | Run state, elapsed time, events received, ingest lag, connection indicator |
| Live tiles | Active users · requests/s · responses/s · error rate · current p95 — each with a 60-second sparkline |
| Live charts | Active users, requests/s vs responses/s, percentile bands, error rate — all rolling-window with a "follow" toggle |
| Live error table | Streaming distinct messages with counts, newest first |
| SLA panel | Rules evaluated live with current status |
| Update cadence | 5 s default, configurable 1–60 s |
| Degradation | On WebSocket loss, falls back to polling with a visible banner |

---

### 13.14 Custom dashboards

Users compose a responsive grid from a widget catalogue (stat tile, trend line, sparkline table, heatmap, distribution, error table, SLA status, comparison delta). Each widget is bound to a query — project, simulation, endpoint, metric, time range. Dashboards are private by default, shareable to a team, and exportable as JSON for version control.

---

## 14. Feature Specifications

### 14.1 Statistics table

The single most-used surface in the product. It must match Gatling exactly and then exceed it.

| Aspect | Specification |
|---|---|
| Structure | Hierarchical: global row, then groups (expandable) containing requests. Nested groups to arbitrary depth |
| Columns | **Requests:** Total · OK · KO · %KO · Cnt/s — **Response Time (ms):** Min · 50th · 75th · 95th · 99th · Max · Mean · Std Dev |
| Configurability | Percentile columns configurable per project (matching Gatling's four configurable percentiles); additional percentiles addable |
| Latency columns | Optional column group for latency statistics, off by default, available when the plugin supports it |
| Sorting | Every column, ascending and descending, multi-column with modifier key, persisted in URL |
| Filtering | Substring by default; regex with a toggle; group-aware so filtering a group shows its children |
| Virtualization | Required — must remain smooth at 5,000 rows |
| Row interaction | Click selects and cross-filters; double-click navigates to detail |
| Conditional formatting | Optional heat shading per column; SLA-breaching cells marked with an icon and colour |
| Comparison mode | Optional delta columns versus baseline, showing absolute and percentage change |
| Export | CSV of the current visible, filtered, sorted state |
| Accessibility | Full keyboard navigation, `aria-sort` on headers, row selection announced |

### 14.2 Execution history

| Aspect | Specification |
|---|---|
| Scope | Global, folder, project, or simulation |
| Columns | Status · verdict · simulation · build · branch · commit · environment · tool · start time · duration · total requests · error rate · p95 · tags |
| Facets | Project, simulation, environment, tool, branch, tag, status, verdict, date range, build range |
| Sorting | Any column; default start time descending |
| Bulk actions | Compare selected (2–4) · tag · delete (Maintainer) · export |
| Density | Compact table default; card view optional |
| Pagination | Cursor-based, infinite scroll with an explicit "load more" fallback |
| Inline sparkline | Optional column showing this run's p95 relative to the trailing 20 |

### 14.3 Search

| Aspect | Specification |
|---|---|
| Invocation | `⌘K` / `Ctrl+K` command palette, or the header field |
| Scope | Projects · simulations · runs (by build, commit, tag) · endpoints · saved views · admin actions |
| Behaviour | Typeahead under 150 ms, grouped results, keyboard-navigable, recent searches |
| Ranking | Exact match, then prefix, then substring; recency and personal usage boost |
| Deep results | Endpoint results navigate directly to that endpoint within its run |
| Implementation | PostgreSQL full-text with trigram indexes; no external search dependency in V1 |

### 14.4 Baselines and regression detection

| Aspect | Specification |
|---|---|
| Baseline types | **Pinned** (a specific run) · **Rolling** (median of last N comparable runs) · **Branch** (latest default-branch run) |
| Selection | Baselines only ever consider runs sharing the comparability fingerprint |
| Detection | Flag when `metric > trailing_median + k × MAD`, where MAD is the median absolute deviation over the trailing window and `k` is configurable per project (default 3.0) |
| Rationale | Using each endpoint's **own** variability means noisy endpoints stop crying wolf while steady endpoints catch small real regressions — the alternative, one global percentage threshold, is wrong in both directions |
| Minimum history | No detection until the trailing window has at least 5 comparable runs; state is shown as `insufficient history`, never as `pass` |
| Directionality | Configurable per metric — latency and error rate flag on increase; throughput flags on decrease |
| Outputs | Regression record with metric, endpoint, baseline value, current value, delta, sigma multiple, commit range, status |

### 14.5 Annotations

Free-text notes attached to a run or to a timestamp within a run. Rendered as markers on trend and timeline charts. Support markdown, author attribution, and edit history. Typical uses: recording infrastructure conditions, marking an intentional baseline shift, explaining an acknowledged regression.

### 14.6 Share links

Expiring (1h/24h/7d/30d), revocable, optionally password-protected, read-only links to a run, comparison, or dashboard. Creation and access are audit-logged. Links carry no session and grant no other access. Organization policy may disable them entirely.

---

## 15. Module Breakdown

| # | Module | Responsibility | Key dependencies |
|---|---|---|---|
| **M1** | **Identity & Access** | Authentication (OIDC/SAML/local), sessions, RBAC resolution, API keys, service accounts, ingest tokens | Postgres, IdP, Redis |
| **M2** | **Organization** | Organizations, teams, folders, projects, simulations, environments, settings | Postgres |
| **M3** | **Ingestion** | Upload handling, bundle persistence, job enqueue, verdict negotiation, streaming ingest, idempotency | Object storage, Redis/BullMQ |
| **M4** | **Plugin Runtime** | Plugin registry, capability negotiation, detection, sandboxed parse execution, conformance validation | M3 |
| **M5** | **Statistics Engine** | Canonical event consumption, bucketing, sketch maintenance, warm-up handling, distributions, correlations, rollups | M4 |
| **M6** | **Metrics Store** | Persistence and query of runs, statistics, time series, errors, assertions; partition lifecycle | Postgres |
| **M7** | **Analytics** | Trends, comparison, baselines, regression detection, heatmaps, fingerprint logic | M6 |
| **M8** | **SLA & Assertions** | Rule storage, evaluation (absolute, relative, noise-aware), snapshots, verdicts | M5, M7 |
| **M9** | **Live** | Streaming aggregation, delta computation, WebSocket gateway, pub/sub fan-out, replay buffer | Redis, M5 |
| **M10** | **Notifications** | Channel configuration, templating, delivery, retries, digests, delivery history | Redis/BullMQ |
| **M11** | **Reporting** | PDF/HTML rendering, data export, scheduled report generation and delivery | Object storage, headless browser |
| **M12** | **Public API** | REST surface, OpenAPI generation, rate limiting, pagination, versioning | All |
| **M13** | **Web Application** | React SPA: dashboards, tables, charts, filtering, personalization, accessibility | M12 |
| **M14** | **Administration** | User/team management, plugin management, retention, quotas, system health | M1, M2 |
| **M15** | **Audit** | Immutable event capture, query, export | Postgres |
| **M16** | **Platform** | Configuration, observability, health, migrations, job orchestration | — |

### 15.1 Module dependency rules

```
M16 Platform ◄──────────────── everything
M5 Statistics Engine ────────► depends ONLY on the canonical model. No HTTP. No DB. No config.
M4 Plugin Runtime ───────────► depends ONLY on the canonical model + plugin contract.
M13 Web Application ─────────► depends ONLY on M12 Public API. No privileged access path.
```

**Three boundaries are enforced by lint rules, not convention, because they encode product guarantees:**

1. **The statistics engine and plugins are pure.** They take bytes and return metrics, with no I/O. This is what makes correctness testable in isolation and makes NFR-EX-1 true by construction.
2. **The web application consumes only the public API.** This is what makes FR-API completeness real rather than aspirational — if the UI can do it, the API can.
3. **No module outside the plugin runtime may reference a tool by name.** A `grep` for tool names outside `plugins/` failing CI is the mechanical enforcement of "the dashboard never knows which tool generated the data."

---

## 16. Technical Architecture Overview

### 16.1 Architectural style, and why

**A modular monolith for the API, with independently scalable asynchronous workers.**

This is a deliberate rejection of a microservice decomposition, and the reasoning should be explicit because it will be challenged:

- The modules in §15 share one transactional consistency domain. A run, its statistics, its assertions, and its audit record must commit together. Splitting them across services replaces a transaction with a distributed saga, which is a large and permanent cost paid for a scaling problem this system does not have.
- The genuine scaling asymmetry is **ingestion versus reading**, not module versus module. One multi-million-event parse is CPU- and memory-heavy for minutes; a dashboard read is milliseconds. That asymmetry is resolved by separating *workers* from the *API*, which this design does — and no finer split is needed.
- Node.js is single-threaded per process. The requirement that ingestion never degrade dashboard latency (NFR-PF-4, AC-ING-7) is satisfied by process separation, not service decomposition.
- NestJS modules with enforced dependency rules (§15.1) give the boundary discipline that motivates microservices, without the operational cost. If a module later needs independent deployment, its boundaries are already clean enough to extract.

### 16.2 Component view

```
                          ┌─────────────────────────────────────┐
   Browser ──── HTTPS ───►│  Web Application (React SPA, CDN)   │
                          └────────────────┬────────────────────┘
                                           │ REST + WebSocket
                          ┌────────────────▼────────────────────┐
   CI / CD ──── HTTPS ───►│  API Gateway (Ingress + TLS + WAF)  │
   Scripts                └────────────────┬────────────────────┘
                                           │
              ┌────────────────────────────┼────────────────────────────┐
              │                            │                            │
   ┌──────────▼──────────┐   ┌─────────────▼────────────┐   ┌───────────▼──────────┐
   │  api  (NestJS)      │   │  ws  (NestJS gateway)    │   │  scheduler           │
   │  ≥2 replicas        │   │  ≥2 replicas             │   │  1 replica (leader)  │
   │  ─────────────────  │   │  ────────────────────    │   │  ──────────────────  │
   │  auth · RBAC        │   │  live subscriptions      │   │  retention jobs      │
   │  read API           │   │  delta fan-out           │   │  scheduled reports   │
   │  ingest accept      │   │  replay buffer           │   │  partition rollover  │
   │  admin              │   │                          │   │  baseline refresh    │
   └──────────┬──────────┘   └─────────────┬────────────┘   └───────────┬──────────┘
              │                            │                            │
              └────────────────────────────┼────────────────────────────┘
                                           │
        ┌──────────────────┬───────────────┼───────────────┬──────────────────┐
        │                  │               │               │                  │
┌───────▼───────┐  ┌───────▼───────┐  ┌────▼─────┐  ┌──────▼──────┐  ┌────────▼────────┐
│ ingest-worker │  │ report-worker │  │  Redis   │  │ PostgreSQL  │  │ Object Storage  │
│ HPA 2–20      │  │ HPA 1–5       │  │ queue    │  │ primary +   │  │ (S3-compatible) │
│ ───────────── │  │ ───────────── │  │ cache    │  │ read replica│  │ ─────────────── │
│ plugin runtime│  │ headless      │  │ pub/sub  │  │             │  │ raw bundles     │
│ statistics    │  │ browser → PDF │  │          │  │             │  │ generated reports│
│ SLA eval      │  │ exports       │  │          │  │             │  │                 │
└───────────────┘  └───────────────┘  └──────────┘  └─────────────┘  └─────────────────┘
                                           ▲
                                  ┌────────┴────────┐
                                  │ notify-worker   │
                                  │ Slack · webhook │
                                  │ email · retries │
                                  └─────────────────┘
```

### 16.3 Runtime topology

| Deployable | Replicas | Scaling trigger | State |
|---|---|---|---|
| `web` (static SPA) | CDN | — | None |
| `api` | 2–10 | CPU + request rate | Stateless |
| `ws` | 2–8 | Connection count | Connection state in memory; subscriptions in Redis |
| `ingest-worker` | 2–20 | **Queue depth** | Stateless; job state in Redis + Postgres |
| `report-worker` | 1–5 | Queue depth | Stateless |
| `notify-worker` | 1–3 | Queue depth | Stateless |
| `scheduler` | 1 (leader-elected) | — | Leader lock in Redis |

`ingest-worker` is separated from `api` for the reason in §16.1 and is given the widest scaling range because it absorbs the burstiest load — CI pipelines finish in clusters.

### 16.4 Data flow — batch ingestion

```
CI ──POST multipart──► api
                        │ 1. authenticate ingest token → resolve project
                        │ 2. validate metadata
                        │ 3. stream body ──────────────────► Object Storage
                        │    (never buffered; SHA-256 computed inline; size-capped)
                        │ 4. INSERT run(pending) ──────────► PostgreSQL   ┐ one
                        │ 5. enqueue job ──────────────────► Redis/BullMQ ┘ transaction*
                        │ 6. await terminal state, bounded (default 25 s)
                        │
                        ▼
                  ingest-worker
                        │ a. claim job
                        │ b. open bundle from Object Storage
                        │ c. plugin.detect → select plugin
                        │ d. plugin.parse → AsyncIterable<CanonicalEvent>
                        │ e. statistics engine: bucket · sketch · coalesce · roll up
                        │ f. persist stats, time series, errors  ──► PostgreSQL
                        │ g. evaluate SLA rules → assertions + verdict
                        │ h. detect regressions vs. baseline
                        │ i. UPDATE run(complete) + publish ─────► Redis pub/sub
                        │ j. enqueue notifications
                        ▼
        api wakes on pub/sub ──► responds 200 / 422   (or 202 if the window expired)
```

\* The database insert and the queue enqueue span two systems and therefore cannot share a transaction. The order is chosen so the **only** possible inconsistency is a run row with no job — recoverable, and swept by the scheduler, which re-enqueues `pending` runs older than 60 seconds. The reverse order would produce a job referencing a non-existent run, which is not recoverable. **The bundle is durable before any row references it**, so no failure sequence loses data.

### 16.5 Data flow — live ingestion

```
injector ──POST /runs/{id}/events (batch, gzip NDJSON)──► api
                                                           │ validate + enqueue (priority)
                                                           ▼
                                                    ingest-worker
                                                           │ incremental aggregation:
                                                           │ merge into open sketches,
                                                           │ update open buckets
                                                           │ compute delta since last tick
                                                           ▼
                                                    Redis pub/sub (channel: run:{id})
                                                           │
                                              ┌────────────┴────────────┐
                                              ▼                         ▼
                                          ws pod A                  ws pod B
                                              │                         │
                                          subscribers              subscribers
```

Redis pub/sub is what makes WebSocket fan-out work across pods (FR-LIVE-7): any worker can publish, every `ws` pod delivers to its own subscribers. Each `ws` pod keeps a bounded replay buffer per run so a brief disconnect resumes without a gap (FR-LIVE-8); beyond the buffer the client requests a full snapshot.

### 16.6 Data flow — dashboard read

```
Browser ──GET /runs/{id}/stats──► api ──► Redis cache ──hit──► response  (~5 ms)
                                            │ miss
                                            ▼
                                     PostgreSQL (read replica for analytics)
                                            │
                                     serialize + cache
                                            ▼
                                        response
```

A completed run is immutable, so its metric responses carry a strong `ETag` and are cacheable indefinitely (§7.11). Only aggregate views — fleet, trends, heatmaps — require invalidation, and only for the project that received a new run.

### 16.7 Technology decisions

| Layer | Choice | Rationale |
|---|---|---|
| Frontend framework | React 18 + TypeScript | Ecosystem depth for data-dense UI; concurrent rendering helps large table interaction |
| Build | Vite | Fast dev loop; efficient code splitting for the route-level budgets in §20.3 |
| Styling | Tailwind CSS + design tokens | Token-driven theming makes dual-theme (§22.2) systematic rather than ad hoc |
| Charts | Apache ECharts | Canvas rendering handles the point counts here; supports linked axes, log scales, and large datasets that SVG libraries struggle with |
| Server state | TanStack Query | Query-key invalidation maps cleanly to the cache model in §7.11 |
| Backend framework | NestJS | Module system with DI enforces the §15.1 boundaries structurally; first-class OpenAPI generation and WebSocket gateway |
| ORM | Prisma — **CRUD and migrations only** | See §16.8 |
| Database | PostgreSQL 16+ | Declarative partitioning, JSONB, `bytea`, full-text + trigram search, mature replication |
| Queue | BullMQ on Redis | Priorities, retries with backoff, rate limiting, delayed jobs, and a mature dashboard — all needed by §6.3 and §6.9 |
| Cache / pub-sub | Redis 7+ | One dependency serving queue, cache, pub/sub, and leader election |
| Object storage | S3-compatible | Raw bundles and generated reports; keeps large artifacts out of the database |
| Sketches | DDSketch (`@datadog/sketches-js`) | Exact merges and 1% guaranteed relative error — see §24.2 |
| Container / orchestration | Docker + Kubernetes | Independent scaling of `api` and workers; HPA on queue depth |
| API contract | OpenAPI 3.1 | Generated from decorators; drift fails CI (NFR-MT-3) |

### 16.8 The Prisma boundary — a required architectural constraint

> **Prisma owns CRUD and migrations. The metrics read path uses raw, parameterized SQL.**

This is not a stylistic preference and must not be relaxed without an ADR. Prisma is excellent for the relational entities in §18.2 — organizations, teams, projects, rules, tokens, audit records — and its migration tooling is the right choice for schema evolution. It is a poor fit for exactly the queries this product's performance depends on:

| Requirement | Why Prisma is the wrong tool |
|---|---|
| Declaratively partitioned `run_timeseries` | Prisma does not model partitioned tables; partition DDL must be raw regardless |
| `bytea` sketch columns merged in bulk | Sketches are opaque binary; there is nothing for the ORM to map, and row-at-a-time hydration is the dominant cost |
| Trend queries across 100 runs (< 500 ms, NFR-PF-9) | Requires window functions and lateral joins that Prisma's query builder cannot express, and its N+1 relation loading is fatal here |
| Heatmap matrices | Pivot-shaped aggregation; the ORM round-trips thousands of rows the database should have collapsed |

**The rule in practice:** the `metrics-store` module (M6) exposes repository methods backed by hand-written SQL and returns typed DTOs. No other module writes SQL, and no module outside M6 touches metric tables through Prisma. Migrations remain Prisma-managed so there is a single schema history, with raw SQL escape hatches for partitioning DDL.

Left unstated, this is precisely where the implementation degrades slowly and irreversibly into unusable query performance.

### 16.9 Scaling model

| Dimension | Mechanism | Limit before redesign |
|---|---|---|
| Read traffic | Stateless `api` replicas + Redis cache + read replicas | ~50× the NFR-SC-3 target |
| Ingest volume | `ingest-worker` HPA on queue depth | Bounded by database write throughput; batch `COPY` used for time-series inserts |
| Time-series storage | Monthly partitions + retention drop | Effectively unbounded within retention |
| Statistics storage | Never expires, but small — one row per endpoint per run | ~10 GB at 500k runs × 100 endpoints |
| Live connections | `ws` replicas + Redis pub/sub fan-out | ~10k connections before a dedicated gateway is warranted |
| Tenants | Row-level scoping on `organization_id` with a mandatory query guard | Schema-per-tenant only if regulatory isolation is later required |

### 16.10 Failure modes and degradation

| Failure | Behaviour | User-visible effect |
|---|---|---|
| `ingest-worker` pod dies mid-parse | BullMQ lease expires; job retried; partial writes rolled back by run-scoped transaction | Ingest takes longer; nothing lost (AC-ING-4) |
| Redis unavailable | Queue stalls; cache bypassed; live monitoring falls back to polling | Ingestion delayed; dashboards slower but functional (NFR-AV-5) |
| Object storage unavailable | Ingest rejects with a clear error; existing runs unaffected | New runs fail; all history readable |
| Database primary fails | Failover to standby; workers retry with backoff | Brief write outage; RTO ≤ 1 hour worst case (NFR-DR-1) |
| Read replica lag | Analytics queries routed to primary above a lag threshold | Slightly higher primary load |
| Plugin throws or hangs | Sandboxed with a timeout and memory cap; run marked failed with an actionable error | One run fails; platform unaffected (§21.6) |
| Notification channel down | Retried with backoff, then dead-lettered and visible in delivery history | Alert delayed, never silently dropped (FR-NOTIF-6) |

---

## 17. API Requirements

### 17.1 Principles

| ID | Requirement |
|---|---|
| API-1 | **The web application consumes only the public API.** There is no privileged internal path. If the UI can do it, a customer's script can (§15.1). |
| API-2 | REST over HTTPS, JSON request and response bodies, resource-oriented paths, correct HTTP semantics. |
| API-3 | Every endpoint is described in a generated **OpenAPI 3.1** document; drift between code and specification fails CI. |
| API-4 | All list endpoints are **cursor-paginated**. Offset pagination is not offered — it is incorrect under concurrent writes and degrades at depth. |
| API-5 | Every response carries a correlation ID echoed in logs and error bodies. |
| API-6 | All timestamps are RFC 3339 in UTC. All durations are integer milliseconds. Field naming is `snake_case` consistently. |
| API-7 | No endpoint is unauthenticated, including ingestion (AC-SEC-1). |

### 17.2 Authentication and authorization

| Credential | Carried in | Used by | Scope |
|---|---|---|---|
| Session (JWT, httpOnly cookie) | Cookie | Browser | User's full role set |
| API key | `Authorization: Bearer pk_…` | Scripts, integrations | Subset of the owning user's permissions, explicitly selected at creation |
| Service account token | `Authorization: Bearer sa_…` | CI, automation | Roles assigned to the service account |
| Ingest token | `Authorization: Bearer it_…` | CI ingest only | **Write to exactly one project.** No read access |

An ingest token cannot read data, and cannot write to any project but its own — so a leaked CI token is a bounded incident (FR-ADMIN-7, AC-SEC-3).

### 17.3 Resource map

| Method | Path | Purpose |
|---|---|---|
| **Ingestion** | | |
| `POST` | `/api/v1/runs` | Ingest a results bundle; returns verdict (FR-ING-1, FR-ING-3) |
| `GET` | `/api/v1/runs/{id}/verdict` | Poll for verdict; same status codes as the POST |
| `POST` | `/api/v1/runs/live` | Open a live run |
| `POST` | `/api/v1/runs/{id}/events` | Append an event batch to a live run |
| `POST` | `/api/v1/runs/{id}/close` | Close a live run |
| `POST` | `/api/v1/runs/{id}/reprocess` | Recompute metrics from the retained bundle |
| **Runs and metrics** | | |
| `GET` | `/api/v1/runs` | List runs with facets and cursor pagination |
| `GET` | `/api/v1/runs/{id}` | Run header and metadata |
| `GET` | `/api/v1/runs/{id}/stats` | Statistics for all scopes, or filtered by `scope` and `name` |
| `GET` | `/api/v1/runs/{id}/series` | Time series; `scope`, `name`, `metric`, `from`, `to`, `resolution` |
| `GET` | `/api/v1/runs/{id}/distribution` | Distribution bins; `metric`, `bins`, `scale` |
| `GET` | `/api/v1/runs/{id}/percentiles` | Percentile bands over time |
| `GET` | `/api/v1/runs/{id}/correlation` | Response time or latency against global RPS |
| `GET` | `/api/v1/runs/{id}/errors` | Error rollup |
| `GET` | `/api/v1/runs/{id}/assertions` | Tool-native and platform assertion results |
| `PATCH` | `/api/v1/runs/{id}` | Edit metadata and tags |
| `DELETE` | `/api/v1/runs/{id}` | Delete a run |
| **Analytics** | | |
| `GET` | `/api/v1/analytics/overview` | Fleet health |
| `GET` | `/api/v1/analytics/trends` | Metric across runs with tolerance band |
| `GET` | `/api/v1/analytics/compare` | Run comparison deltas |
| `GET` | `/api/v1/analytics/heatmap` | Endpoint × run delta matrix |
| `GET` | `/api/v1/analytics/regressions` | Detected regressions, filterable |
| `POST` | `/api/v1/analytics/regressions/{id}/acknowledge` | Acknowledge with reason |
| **Organization** | | |
| `GET·POST·PATCH·DELETE` | `/api/v1/projects[/{slug}]` | Project CRUD |
| `GET·POST·PATCH` | `/api/v1/projects/{slug}/settings` | Warm-up, indicators, percentiles, retention, Git template |
| `GET·POST·DELETE` | `/api/v1/projects/{slug}/tokens` | Ingest tokens |
| `GET·PUT` | `/api/v1/projects/{slug}/sla-rules` | SLA rule set |
| `GET·POST·DELETE` | `/api/v1/projects/{slug}/baselines` | Baselines |
| `GET·POST` | `/api/v1/folders`, `/api/v1/teams`, `/api/v1/environments` | Structure |
| `GET·POST·DELETE` | `/api/v1/runs/{id}/annotations` | Annotations |
| **Reporting** | | |
| `POST` | `/api/v1/reports` | Generate a report; returns a job |
| `GET` | `/api/v1/reports/{id}` | Report status and download URL |
| `GET·POST·DELETE` | `/api/v1/report-schedules` | Scheduled reports |
| `POST` | `/api/v1/share-links` | Create an expiring share link |
| `GET` | `/api/v1/exports/{resource}` | CSV or JSON export |
| **Administration** | | |
| `GET·POST·PATCH·DELETE` | `/api/v1/admin/users`, `/teams`, `/service-accounts` | Identity management |
| `GET` | `/api/v1/admin/audit` | Audit log query |
| `GET·PATCH` | `/api/v1/admin/plugins` | Plugin registry and enablement |
| `GET` | `/api/v1/admin/health` | Queue depth, worker status, ingest lag |
| `GET·POST·DELETE` | `/api/v1/me/api-keys`, `/me/preferences`, `/me/favorites` | Self-service |

### 17.4 Conventions

**Pagination.** `?limit=50&cursor=<opaque>`; responses carry `{ data: [...], page: { next_cursor, has_more } }`. `limit` maximum 200.

**Filtering.** Repeated query parameters are OR within a facet and AND across facets: `?environment=staging&environment=perf&tool=gatling` means *(staging OR perf) AND gatling*. Time ranges use `from` and `to` as RFC 3339.

**Sorting.** `?sort=-p95,name` — leading `-` for descending, comma-separated for multi-column.

**Sparse fieldsets.** `?fields=name,p95,error_rate` on large collections, so a sparkline query does not transfer full statistics rows.

**Idempotency.** `Idempotency-Key` on all unsafe ingest operations (FR-ING-7).

**Conditional requests.** `ETag` and `If-None-Match` on immutable run resources; `304` responses are the common case for repeat dashboard loads.

### 17.5 Errors

A single error envelope everywhere:

```json
{
  "error": {
    "code": "ENDPOINT_CARDINALITY_EXCEEDED",
    "message": "Run contains 4,812 distinct request names, exceeding the project limit of 2,000.",
    "remediation": "Request names appear to contain dynamic values such as IDs. Parameterize them in the simulation, or raise the limit in project settings.",
    "detail": { "found": 4812, "limit": 2000, "samples": ["/user/8213", "/user/8214"] },
    "correlation_id": "01J9Z4K7QW3M8XN2"
  }
}
```

`remediation` is a **required** field on the error type. An error that cannot state a fix will not compile (FR-ING-4).

| Status | Meaning in this API |
|---|---|
| `200` | Success; for ingest, the SLA verdict passed |
| `202` | Accepted; processing continues — poll the `Location` URL |
| `400` | Malformed request, or an unparseable bundle |
| `401` | Missing or invalid credentials |
| `403` | Authenticated but not permitted, or a token used outside its project scope |
| `404` | Not found — **also returned for resources in another organization**, so existence is not disclosed (AC-SEC-2) |
| `409` | Conflict, e.g. a slug already in use |
| `413` | Bundle exceeds the configured size cap |
| `415` | Unsupported or unrecognised bundle format |
| `422` | **Ingested successfully; the performance gate failed.** Not an upload error |
| `429` | Rate limit exceeded; `Retry-After` provided |
| `5xx` | Server error; correlation ID always present |

> **On `422`.** This is a deliberate use of the code to satisfy FR-ING-3's requirement that CI gate on an exit code with no extra scripting. The run ingested perfectly; the *gate* failed. The response body and the documentation must both state this plainly, because the failure mode — a developer reading "422" as "my upload was malformed" — is the single most likely misinterpretation in the whole API.

### 17.6 Versioning and deprecation

Major version in the path (`/api/v1`). Additive changes — new fields, new optional parameters, new endpoints — are not breaking and ship within a version. Breaking changes require a new major, with the previous major supported for **12 months**. Deprecated endpoints return `Deprecation` and `Sunset` headers and a `Link` to migration guidance, and deprecation is surfaced in the admin UI with call counts, so an operator can see who still depends on it.

### 17.7 Rate limiting

| Credential class | Limit | Notes |
|---|---|---|
| Session (interactive) | 600 req/min per user | Generous; dashboards are chatty by design |
| API key | 300 req/min per key | Configurable per organization |
| Service account | 600 req/min | |
| Ingest token | 60 req/min, 10 concurrent uploads | Ingest is heavy; bursts are queued not rejected |
| Unauthenticated | 20 req/min per IP | Login and health only |

Responses carry `RateLimit-Limit`, `RateLimit-Remaining`, and `RateLimit-Reset`. Ingest **queues** rather than rejects under burst, up to a bounded per-organization depth (FR-ING-12) — a CI fleet finishing simultaneously must not lose runs.

### 17.8 WebSocket API

Endpoint `wss://…/api/v1/ws`, authenticated by the same session or token credentials as REST.

| Frame | Direction | Payload |
|---|---|---|
| `subscribe` | client → server | `{ channel: "run:{id}", since_seq?: number }` |
| `snapshot` | server → client | Full current aggregate state, with `seq` |
| `delta` | server → client | Incremental metric changes since the previous `seq` |
| `assertion` | server → client | Live SLA rule state change |
| `status` | server → client | Run state transition (`running` → `complete` / `incomplete`) |
| `unsubscribe` | client → server | `{ channel }` |
| `error` | server → client | Same error envelope as REST |
| `ping` / `pong` | both | 30-second heartbeat |

Every `delta` carries a monotonic `seq`. A reconnecting client sends `since_seq`; the server replays from its bounded buffer, or responds with a fresh `snapshot` when the gap exceeds the buffer (FR-LIVE-8, AC-LIVE-2). **Subscriptions are authorized per channel on every subscribe** — a WebSocket connection is not a permission grant.

### 17.9 Webhooks

Versioned JSON payload delivered by POST, signed with HMAC-SHA256 over the raw body using the channel's shared secret, in an `X-PerfPortal-Signature` header alongside `X-PerfPortal-Timestamp` and `X-PerfPortal-Event`. Consumers must verify the signature and reject timestamps older than five minutes to prevent replay.

Events: `run.completed`, `run.failed`, `sla.breached`, `regression.detected`, `regression.acknowledged`, `report.ready`.

Delivery retries at 1 s, 10 s, 60 s, 5 min, 30 min, then dead-letters into a per-channel delivery history visible in the UI (FR-NOTIF-6).

### 17.10 OpenAPI and client generation

The OpenAPI 3.1 document is generated from NestJS decorators and DTOs, published at `/api/v1/openapi.json`, and checked into the repository so any change appears in code review. Typed clients for TypeScript, Python, and Go are generated and published from it. The document is the contract; a hand-written client is never the reference.

---

## 18. Database Requirements

### 18.1 Principles

| ID | Requirement |
|---|---|
| DB-1 | **Statistics are permanent; detail is not.** Per-endpoint aggregates are tiny and are the trend history, so they never expire. High-resolution time series and raw bundles age out (§18.5). |
| DB-2 | **Percentiles are stored as mergeable sketches**, never as pre-averaged numbers. Any re-aggregation merges sketches (FR-STAT-4). |
| DB-3 | **Every tenant-scoped table carries `organization_id`**, and every query is guarded (§19.3). Isolation is enforced at the query layer, not by application discipline. |
| DB-4 | The only table growing with *run length* is `run_timeseries`; everything else grows with *run count*. |
| DB-5 | All schema changes are reviewed, reversible migrations following expand → migrate → contract, so rolling deploys never break (NFR-AV-4). |
| DB-6 | Soft deletion for user-facing entities with a 30-day window; hard deletion thereafter (FR-ORG-7). |

### 18.2 Schema

**Identity and access**

| Table | Key columns |
|---|---|
| `organizations` | `id · slug · name · settings jsonb · retention_policy jsonb · created_at` |
| `users` | `id · organization_id · email · display_name · idp_subject · status · last_login_at` |
| `teams` | `id · organization_id · name · slug` |
| `team_members` | `team_id · user_id · role · granted_at · granted_by` |
| `service_accounts` | `id · organization_id · team_id · name · status · created_by` |
| `api_keys` | `id · organization_id · owner_type · owner_id · name · key_hash · prefix · scopes jsonb · expires_at · last_used_at · revoked_at` |
| `ingest_tokens` | `id · project_id · name · token_hash · prefix · last_used_at · revoked_at` |
| `sessions` | `id · user_id · issued_at · expires_at · ip · user_agent · revoked_at` |

**Organization structure**

| Table | Key columns |
|---|---|
| `folders` | `id · organization_id · parent_id · name · path ltree · position` |
| `projects` | `id · organization_id · team_id · folder_id · slug · name · settings jsonb · archived_at · deleted_at` |
| `environments` | `id · project_id · name · display_name · color · position` |
| `simulations` | `id · project_id · name · display_name · archived_at · first_seen_at · last_run_at` |

**Runs and metrics**

| Table | Key columns |
|---|---|
| `runs` | `id · organization_id · project_id · simulation_id · environment_id · tool · tool_version · plugin_version · engine_version · build · build_ordinal · branch · commit_sha · commit_message · profile jsonb · fingerprint · fingerprint_components jsonb · started_at · ended_at · duration_ms · bucket_width_ms · endpoint_bucket_width_ms · warmup_ms · status · verdict · error_code · error_detail jsonb · bundle_key · bundle_sha256 · bundle_bytes · request_count · idempotency_key · created_at · completed_at` |
| `run_tags` | `run_id · key · value` |
| `run_metadata` | `run_id · key · value` (custom metadata, FR-META-7) |
| `run_stats` | **PK** `(run_id, scope, name, metric_family)` — `count · ok_count · ko_count · error_rate · min_ms · max_ms · mean_ms · stddev_ms · percentiles jsonb · throughput_rps · sketch bytea · sketch_kind` |
| `run_timeseries` | **PK** `(run_id, scope, name, metric_family, bucket_start_ms, month)` — `started_count · ended_count · ok_count · ko_count · active_users · active_users_source · sketch bytea` · **partitioned by `month`** |
| `run_distribution` | **PK** `(run_id, scope, name, metric_family, bin_index)` — `bin_lower_ms · bin_upper_ms · ok_count · ko_count` |
| `run_correlation` | **PK** `(run_id, scope, name, metric_family, rps_bucket)` — `sketch bytea · sample_count` |
| `run_errors` | **PK** `(run_id, scope, name, message_hash)` — `message · count · first_seen_ms · last_seen_ms` |
| `run_annotations` | `id · run_id · author_id · body · anchor_ms · created_at · updated_at` |

`metric_family` distinguishes `response_time`, `latency`, `group_cumulated`, and `group_duration` — this one column is what makes FR-STAT-3 and FR-STAT-13 expressible without duplicating every metric table.

**SLA, baselines, and detection**

| Table | Key columns |
|---|---|
| `sla_rules` | `id · project_id · scope · name_pattern · metric · metric_family · comparator · threshold · rule_type (absolute\|relative) · window_size · enabled` |
| `assertions` | `id · run_id · rule_id · source (tool\|platform) · expression · rule_snapshot jsonb · status (passed\|breached\|not_applicable) · actual · threshold · scope · name` |
| `baselines` | `id · project_id · type (pinned\|rolling\|branch) · run_id · window_size · branch · name · created_by` |
| `regressions` | `id · run_id · scope · name · metric · baseline_value · current_value · delta_pct · sigma_multiple · commit_range jsonb · status · acknowledged_by · acknowledged_reason · acknowledged_at` |

**Platform**

| Table | Key columns |
|---|---|
| `ingest_jobs` | `id · run_id · state · attempts · claimed_by · lease_expires_at · last_error jsonb` |
| `plugins` | `id · organization_id · tool · version · capabilities jsonb · enabled · installed_at` |
| `notification_channels` | `id · project_id · type · config jsonb · events jsonb · enabled` |
| `notification_deliveries` | `id · channel_id · event · payload jsonb · status · attempts · last_error · delivered_at` |
| `report_schedules` | `id · organization_id · scope jsonb · template · cron · recipients jsonb · timezone · enabled · last_run_at` |
| `reports` | `id · organization_id · type · params jsonb · status · storage_key · expires_at` |
| `share_links` | `id · resource_type · resource_id · token_hash · password_hash · expires_at · created_by · revoked_at` |
| `dashboards` | `id · organization_id · owner_id · team_id · name · layout jsonb · visibility` |
| `saved_views` | `id · owner_id · team_id · name · route · query jsonb · visibility` |
| `favorites` | `user_id · resource_type · resource_id · created_at` |
| `deployments` | `id · project_id · environment_id · version · commit_sha · deployed_at` |
| `audit_log` | `id · organization_id · actor_type · actor_id · action · resource_type · resource_id · before jsonb · after jsonb · ip · user_agent · correlation_id · created_at` · **partitioned by month** |

### 18.3 Partitioning

`run_timeseries` and `audit_log` are declaratively range-partitioned by month.

**Why, and the cost.** These are the only tables whose growth is unbounded and whose retention is time-based. Partitioning makes retention a `DROP TABLE` on a partition rather than a delete storm that bloats the heap and blocks autovacuum. Converting a large table to partitioned *after* the fact requires a full rewrite with downtime, so it must be declared at creation.

**The cost, stated plainly:** PostgreSQL requires the partition key inside every unique constraint, so `month` is carried in the primary key of both tables. The scheduler pre-creates the next two months' partitions and drops expired ones per policy.

### 18.4 Index plan

Indexes exist to serve specific budgets in §20; each is justified.

| Table | Index | Serves |
|---|---|---|
| `runs` | `(project_id, fingerprint, started_at DESC)` | Trailing-comparable-runs lookup for baselines, relative rules, and regression detection (§24.3) |
| `runs` | `(project_id, created_at DESC)` | Latest run per project — the fleet overview |
| `runs` | `(organization_id, created_at DESC)` | Global execution history |
| `runs` | `(project_id, simulation_id, build_ordinal DESC)` | Trend ordering by build |
| `runs` | unique `(project_id, idempotency_key)` where not null | FR-ING-7 |
| `runs` | GIN on `to_tsvector(build ‖ branch ‖ commit_sha)` | Search (§14.3) |
| `run_tags` | `(key, value, run_id)` | Tag faceting |
| `run_stats` | `(run_id, scope)` and `(name, run_id)` | Run detail; per-endpoint trends |
| `run_timeseries` | PK covers access; BRIN on `bucket_start_ms` per partition | Range scans within a run |
| `regressions` | `(project_id, status, created_at DESC)` | Regression inbox |
| `audit_log` | `(organization_id, created_at DESC)`, `(actor_id, created_at DESC)`, `(resource_type, resource_id)` | Audit queries |
| `notification_deliveries` | `(channel_id, created_at DESC)` where status ≠ delivered | Dead-letter view |

### 18.5 Retention tiers

| Data class | Default | Configurable | Rationale |
|---|---|---|---|
| `run_stats`, `runs`, `assertions`, `regressions` | **Indefinite** | No | This *is* the trend history; it is small and cannot be regenerated |
| `run_timeseries`, `run_distribution`, `run_correlation` | 90 days | Yes, per project | High-resolution detail; the dominant storage cost |
| Raw bundles | 30 days | Yes, per project | Needed only for reprocessing and native-report regeneration |
| `audit_log` | 400 days | Yes, per organization | Exceeds a 12-month compliance review cycle |
| `notification_deliveries` | 90 days | Yes | Operational troubleshooting only |
| Generated reports | 30 days | Yes | Regenerable on demand |
| Soft-deleted entities | 30 days | No | Restore window (FR-ORG-7) |

**Consequence worth stating:** a three-year-old run still contributes to every trend and comparison. Only its per-second detail and raw log are gone. Users must be told this clearly in the UI, because a run that renders trends but cannot render its timeline is otherwise confusing.

### 18.6 Migrations and operations

Prisma Migrate owns schema history, with raw SQL for partition DDL and index concurrency. All migrations are expand → migrate → contract so a rolling deploy never runs old code against a narrowed schema. Index creation uses `CONCURRENTLY`. Migrations run as an init job holding an advisory lock, so concurrent replicas cannot race. Every migration is tested against a production-shaped dataset for duration before release.

### 18.7 Scalability measures

Batch `COPY` for time-series inserts rather than row-at-a-time; connection pooling via PgBouncer in transaction mode; read replicas for analytics with automatic fallback to primary above a lag threshold; `run_stats` percentile values stored in JSONB so the configurable percentile set (FR-STAT-2) does not require a schema change per project.

---

## 19. Security Requirements

### 19.1 Threat model

| Threat (STRIDE) | Vector | Control |
|---|---|---|
| **Spoofing** | Stolen ingest token used to inject false data | Project-scoped tokens; revocable; last-used tracking; anomalous-source alerting |
| **Spoofing** | Session hijacking | httpOnly + Secure + SameSite cookies; short-lived JWTs with refresh rotation; IP and user-agent change detection |
| **Tampering** | Forged webhook consumed downstream | HMAC-SHA256 signature + timestamp (§17.9) |
| **Tampering** | Modified historical results hiding a regression | Immutable completed runs; all metadata edits audit-logged with before/after (FR-META-8) |
| **Repudiation** | Disputed configuration or approval | Immutable audit log with actor, IP, and correlation ID (FR-ADMIN-8) |
| **Information disclosure** | **Cross-tenant data access** | Mandatory `organization_id` predicate enforced in the repository layer (§19.3); `404` rather than `403` for foreign resources |
| **Information disclosure** | Reports leak endpoint names, infrastructure shape, failure modes | Authentication on every surface from first deployment; share links expiring and revocable; no public mode |
| **Information disclosure** | Secrets in logs | Structured logging with a deny-list; automated test asserting no credential pattern reaches a log sink |
| **Denial of service** | Oversized or zip-bomb bundle | Size cap, decompression ratio cap, streaming parse with bounded memory |
| **Denial of service** | Endpoint cardinality explosion exhausting a worker | Hard per-project cap (FR-ING-10) |
| **Denial of service** | One tenant's ingest burst starving others | Per-organization queue depth bounds and fair scheduling (FR-ING-12) |
| **Elevation of privilege** | Malicious plugin | Sandboxed execution, no network or filesystem access, resource limits (§21.6) |
| **Elevation of privilege** | API key exceeding its owner's rights | Keys grant a strict subset, re-resolved against current roles on every request |

### 19.2 Authentication

OIDC Authorization Code with PKCE in V1; SAML 2.0 in V1.1; local accounts as a fallback with argon2id hashing, mandatory complexity, and optional TOTP MFA. Sessions are 12 hours with 30-day refresh rotation and reuse detection. Failed-login throttling is per account and per IP. IdP group claims map to teams (FR-ADMIN-4), so deprovisioning in the IdP removes access here.

### 19.3 Authorization and tenant isolation

Role resolution happens per request and is cached at most 60 seconds, so a revocation takes effect within a minute (AC-SEC-5). Permission checks are declarative guards on every route — a route with no guard fails a CI check rather than defaulting to open.

**Tenant isolation is structural.** Every repository method for a tenant-scoped table requires an `organization_id` argument; the base repository injects the predicate and a lint rule forbids raw queries against tenant tables outside that layer. An integration test suite attempts cross-tenant access on every endpoint and asserts `404`. This is the single highest-severity failure class in a multi-tenant analytics product, so it is enforced by construction rather than by review.

### 19.4 Credential handling

| Credential | Storage | Notes |
|---|---|---|
| User passwords (local accounts only) | argon2id | Deliberately slow — defends low-entropy human secrets |
| API keys, service account tokens, ingest tokens | SHA-256 | These are 256-bit random values with nothing to brute-force. A slow KDF would add latency to every CI ingest and buy nothing |
| Share link tokens | SHA-256; password (if set) argon2id | |
| Webhook secrets | Encrypted at rest with an envelope key | Must be retrievable to sign |

Tokens are displayed exactly once at creation. Only the prefix is stored for display (`it_a1b2…`).

### 19.5 Data protection

TLS 1.3 minimum in transit, with HSTS. Encryption at rest for database, object storage, and backups. Object storage buckets are private with no public access path; downloads use short-lived pre-signed URLs. PII is limited to name, email, and IdP subject; a documented export and erasure path supports data-subject requests.

### 19.6 Application security

OWASP ASVS Level 2 as the conformance target. Content Security Policy with no `unsafe-inline`. All input validated by schema at the boundary. Parameterized queries only — string-concatenated SQL fails CI. Output encoding by default in React with a documented, reviewed exception path for any `dangerouslySetInnerHTML`. Rate limiting per §17.7. CSRF protection via SameSite plus a token on state-changing form posts.

### 19.7 Supply chain and operations

Dependency scanning and container image scanning on every build, with builds failing on high or critical findings. SBOM published per release. Signed container images. Pinned base images rebuilt weekly. Least-privilege service accounts; no long-lived cloud credentials in pods. Secrets from a secret manager, never from environment files in the image.

### 19.8 Vulnerability response

| Severity | Acknowledge | Fix or mitigation |
|---|---|---|
| Critical | 24 hours | 7 days |
| High | 48 hours | 30 days |
| Medium | 5 days | 90 days |
| Low | 10 days | Next scheduled release |

Published security contact and disclosure policy; annual third-party penetration test with remediation tracked to closure.

---

## 20. Performance Requirements

### 20.1 API latency budgets

Measured server-side at p95 and p99, excluding network, under the §7.3 scale targets with a representative data volume.

| Endpoint class | p95 | p99 | Technique |
|---|---|---|---|
| Run header and metadata | 80 ms | 200 ms | Single indexed row; cached |
| Run statistics (500 endpoints) | 200 ms | 500 ms | One indexed scan; JSONB percentiles; `ETag` cached |
| Time series (single scope) | 250 ms | 600 ms | Pre-bucketed; partition-pruned |
| Distribution and correlation | 150 ms | 400 ms | Precomputed at ingest |
| Execution list with facets | 250 ms | 700 ms | Cursor pagination; covering indexes |
| Trend across 100 runs | 500 ms | 1200 ms | `run_stats` only; never touches time series |
| Comparison, 2 × 500 endpoints | 700 ms | 1500 ms | Two indexed reads; delta computed in the database |
| Heatmap, 50 endpoints × 30 runs | 600 ms | 1500 ms | Single pivot query; Redis-cached per project |
| Fleet overview, 200 projects | 400 ms | 900 ms | Materialized per-project summary refreshed on ingest |
| Search typeahead | 150 ms | 400 ms | Trigram + full-text indexes |

### 20.2 Ingestion budget

**Target (NFR-PF-4):** 5,000,000 request events parsed, aggregated, and persisted in **≤ 3 minutes** on 4 vCPU / 8 GiB — approximately **28,000 events/second** sustained.

Techniques: streaming line-by-line parse with backpressure, never materializing the log; parsing isolated in a worker process so the API event loop is untouched; sketch updates are O(1) amortized; batch `COPY` for time-series persistence; no intermediate JSON serialization between parse and aggregation.

**Worked memory calculation** — this is the constraint that determines whether the design holds:

```
Per-endpoint time series : 300 buckets × ~2.1 KB sketch  = ~630 KB per endpoint
100 endpoints                                            = ~63 MB
Run-wide series          : 1200 buckets × ~2.1 KB        = ~2.5 MB
Per-endpoint summary sketches : 100 × ~2.1 KB            = ~0.21 MB
Distribution + correlation accumulators                  = ~5 MB
Parser and stream buffers                                = ~20 MB
                                                    Total ≈ 91 MB
```

**Sketch size is measured, not assumed:** `@datadog/sketches-js` v2.1.1 at `relativeAccuracy: 0.01` serializes to **~2.1 KB** on 200k realistic latency samples (an earlier estimate of 1.5 KB was ~40% low). Tightening to 0.005 doubles it to ~4.1 KB, which would push the worst case to ~150 MB — still viable, but the accuracy gain is not needed: measured error at 0.01 was 0.597% across p50–p99.9, comfortably inside the 1% guarantee.

Comfortably inside an 8 GiB worker with room for concurrency. The dominant term is per-endpoint time series, which is why endpoint cardinality is hard-capped (FR-ING-10) — an uncapped explosion is the one input that can exhaust a worker.

**Bucket count is bounded by in-place coalescing.** Aggregation begins at 1-second buckets and merges adjacent pairs whenever the cap is exceeded, doubling the width. Because DDSketch merges are exact, this is **lossless** — a property that would not hold with t-digest, and the reason for that choice (§24.2).

### 20.3 Frontend budgets

| Metric | Budget |
|---|---|
| Initial route JS, gzipped | < 300 KB |
| Largest Contentful Paint (broadband) | < 1.5 s |
| Interaction to Next Paint | < 200 ms |
| Cumulative Layout Shift | < 0.1 |
| Statistics table scroll, 5,000 rows | 60 fps sustained |
| Chart zoom, hover, crosshair | < 100 ms, **zero network requests** |
| Run Detail payload, 500 endpoints | < 2 MB total across all charts |

Achieved by route-level code splitting, virtualized tables, canvas chart rendering, pre-aggregated payloads, and loading all scope data once so interaction is purely client-side (NFR-PF-2).

### 20.4 Performance testing the platform

The platform's own performance is tested with the platform, which is both a correctness check and continuous dogfooding.

| Scenario | Asserts |
|---|---|
| Ingest 5M-event synthetic bundle | §20.2 wall-clock and peak RSS |
| 500 concurrent dashboard users | §20.1 budgets hold |
| Concurrent ingest + read | Read p95 unaffected (AC-ING-7) |
| 50 live runs × 2,000 subscribers | Delta latency < 2 s p95 (AC-LIVE-4) |
| 500k-run database | Trend, heatmap, and fleet budgets hold at scale |

These run nightly against a production-shaped dataset, and regressions in them are treated as product defects.

---

## 21. Plugin Architecture

### 21.1 Goal

> **Adding support for a load testing tool must require implementing a plugin and changing nothing else.** No schema change, no chart change, no alerting change, no access-control change, no API change.

This is testable, and §9.8 tests it. It is also the mechanism by which the product's claim of tool-agnosticism is true rather than aspirational.

### 21.2 The contract

```ts
/** A read-only view over the ingested bundle. Plugins never see a
 *  filesystem, an archive format, or a path — which is why the
 *  local-vs-S3 storage decision is invisible to them. */
interface BundleView {
  entries(): Promise<BundleEntry[]>;
  openStream(path: string): Promise<ReadableStream<Uint8Array>>;
  readSmall(path: string, maxBytes: number): Promise<Uint8Array>;
}

interface DetectResult {
  matched: boolean;
  version?: string;   // tool version, when the bundle reveals it
  reason: string;     // why it matched, or why it declined — surfaced in errors
}

interface PerfPortalPlugin {
  readonly tool: ToolId;
  readonly pluginVersion: string;
  readonly supportedToolVersions: string;   // semver range

  /** Cheap. May read small files only — must never scan the event log. */
  detect(bundle: BundleView): Promise<DetectResult>;

  /** Declares what this tool can express. Drives UI capability negotiation. */
  capabilities(): CapabilityDescriptor;

  /** The event normalizer. Streams canonical events; never materializes. */
  parse(bundle: BundleView): AsyncIterable<CanonicalEvent>;

  /** Extracts run-level metadata the tool records natively. */
  metadata(bundle: BundleView): Promise<ToolMetadata>;

  /** Converts tool-native assertions into platform assertion records. */
  assertions?(bundle: BundleView): Promise<NativeAssertion[]>;
}
```

The brief's six plugin responsibilities map onto this contract as follows: **Parser** is `parse`; **Event Normalizer** is the canonical event type it yields; **Statistics Adapter** and **Timeline Adapter** are *not* plugin concerns at all — the shared statistics engine derives both from canonical events, which is precisely what keeps tool-specific behaviour from leaking into metrics; **Threshold Adapter** is `assertions`; **Metadata Adapter** is `metadata`.

> **This is a deliberate simplification of the brief.** Giving each plugin its own statistics and timeline adapters would let two tools compute p95 differently, which would silently violate §6.4.6 and make cross-run comparison unsound. One statistics engine, fed by normalized events, is the only structure in which the correctness guarantees hold.

### 21.3 Capability negotiation

```ts
interface CapabilityDescriptor {
  latency: boolean;            // reports time-to-first-byte separately
  groups: boolean;             // supports request grouping
  scenarios: boolean;          // supports named scenarios
  sessionEvents: boolean;      // emits true user start/end records
  nativeAssertions: boolean;
  errorMessages: boolean;
  requestBodySize: boolean;
}
```

The UI reads capabilities and **hides** visualizations a tool cannot support rather than rendering empty charts (NFR-EX-3, AC-PLUG-2). A Locust run therefore shows no latency distribution, and shows no apology for it — the chart simply is not part of that tool's report.

Capability differences never change the *meaning* of a metric that two tools both support. Where they measure it differently, §6.4.6's prohibition on cross-tool numeric comparison applies.

### 21.4 Lifecycle

```
register → validate contract + capabilities → enabled per organization
                                                    │
ingest ──► detect (all enabled plugins) ──► exactly one match? ──no──► actionable error
                                                    │ yes
                                            metadata → parse → canonical events
                                                    │
                                            statistics engine (shared, tool-agnostic)
```

Plugin version and tool version are recorded on every run, so a parsing change is attributable and reprocessing is auditable.

### 21.5 Conformance harness

Published with the contract so a contributor can build and verify a plugin **with no platform running** (NFR-EX-2):

- **Contract validation** — interface shape, capability declaration consistency, version range parsing
- **Event stream validation** — ordering, timestamp monotonicity within tolerance, required fields, encoding
- **Golden-file tests** — fixture bundles in, expected canonical event stream out
- **Statistical conformance** — parsed output through the real statistics engine, compared against expected values
- **Error handling** — malformed, truncated, empty, and wrong-tool bundles must produce structured errors with remediation, never crashes
- **Synthetic data generator** — produces valid fixture bundles at arbitrary scale, for both correctness and throughput testing

### 21.6 Sandboxing and resource limits

Plugins execute in a worker thread with no network access, no filesystem access beyond the `BundleView`, a wall-clock timeout (default 10 minutes), a memory cap (default 1 GiB), and a decompression ratio cap. Breaching any limit fails that run with a structured error and never affects the worker's other jobs or the platform (§16.10).

Plugins are trusted code reviewed before distribution; the sandbox exists to contain **bugs and malicious bundles**, not to make arbitrary untrusted plugin code safe.

### 21.7 Versioning and distribution

Plugins are npm packages named `@perfportal/plugin-<tool>`, following semantic versioning against the plugin API version they target. The platform declares a supported plugin API range and refuses to load outside it. Breaking contract changes carry a deprecation window of two minor releases (NFR-EX-4). Plugins are enabled per organization (FR-ADMIN-12).

### 21.8 Plugin roadmap

| Tool | Release | Notes |
|---|---|---|
| **Gatling** | V1 GA | The reference implementation and parity target |
| **k6** | V2 | JSON and CSV output; no separate latency in some modes — capability-gated |
| **JMeter** | V2 | JTL CSV and XML; column layout varies by configuration, so parsing anchors on the header row |
| **Locust** | V2 | CSV history and stats output |
| **Artillery** | V2 | JSON report output |

> **Binary log formats are the norm, not the exception — verified.** Gatling 3.15.1.2 writes `simulation.log` as a length-prefixed **binary** format; there is no text option. **Decoding it is therefore the Gatling plugin's primary ingest path and core M1 scope**, not an error branch (§A.9 F-1). Expect the same of other modern tools and validate each before estimating its plugin.
>
> Because these formats carry no compatibility guarantee, every plugin reads the embedded version first and selects its record layout from it, and each supported major is pinned to a checked-in reference fixture.
>
> **Where decoding genuinely fails** — an unrecognised layout from a future version — the platform fails with an actionable error naming the detected version, and does **not** fall back to the tool's own aggregates. That fallback would produce runs indistinguishable from full-fidelity ones while carrying no sketches and no time series, breaking the §18.1 DB-2 guarantee for some rows and not others (§28, R-4). Verification also showed the fallback is weaker than assumed: `stats.json` and `global_stats.json` no longer exist, so it would mean scraping generated HTML.

---

## 22. UI/UX Requirements

### 22.1 Design principles

| # | Principle | Consequence |
|---|---|---|
| 1 | **Data first, chrome last** | Ink goes to data. Grid, axes, and borders recede. No decorative gradients or shadows on charts. |
| 2 | **Density is a setting, not a default** | Performance engineers want many rows visible; managers want breathing room. Comfortable and compact modes, persisted per user. |
| 3 | **Every view is a URL** | Filters, sort, zoom, selection, and time range are all URL-encoded. Sharing a finding means pasting a link. |
| 4 | **Progressive disclosure** | Overview → project → run → endpoint. Each level answers its own question completely before offering the next. |
| 5 | **Never a dead end** | Every empty state explains why it is empty and offers the next action. |
| 6 | **Honest uncertainty** | Insufficient history, estimated concurrency, and incomplete runs are labelled as such. The product never presents a weak number as a strong one. |

### 22.2 Design tokens

Two themes, both first-class. **Dark mode is a selected set of steps validated against the dark surface — never an automatic inversion of the light theme.**

| Token | Light | Dark |
|---|---|---|
| Chart surface | `#fcfcfb` | `#1a1a19` |
| Page plane | `#f9f9f7` | `#0d0d0d` |
| Primary ink | `#0b0b0b` | `#ffffff` |
| Secondary ink | `#52514e` | `#c3c2b7` |
| Muted ink (axis, labels) | `#898781` | `#898781` |
| Gridline (hairline) | `#e1e0d9` | `#2c2c2a` |
| Baseline / axis | `#c3c2b7` | `#383835` |

Implemented as CSS custom properties consumed by both Tailwind and the ECharts theme, so a single token change propagates to every surface and every chart.

### 22.3 Chart colour system

Colour is assigned by the **job it does**, and the categorical palette is validated by script rather than by eye.

**Categorical — series identity.** Assigned in fixed slot order and **never cycled**. A ninth series folds into `Other` or becomes small multiples; a generated hue is never invented.

| Slot | Hue | Light | Dark |
|:-:|---|---|---|
| 1 | blue | `#2a78d6` | `#3987e5` |
| 2 | orange | `#eb6834` | `#d95926` |
| 3 | aqua | `#1baf7a` | `#199e70` |
| 4 | yellow | `#eda100` | `#c98500` |
| 5 | magenta | `#e87ba4` | `#d55181` |
| 6 | green | `#008300` | `#008300` |

Validated against both surfaces: lightness band, chroma floor, colour-vision-deficiency separation, normal-vision separation, and contrast all pass. On the **light** surface three slots fall below 3:1 contrast, which obligates *relief* — visible direct labels or the table view (NFR-AC-4) — rather than colour alone. That obligation is already a requirement, which is why this palette is acceptable in both themes.

> **Colour follows the entity, never its rank.** Filtering a chart from eight endpoints to three must not repaint the survivors — an endpoint keeps its hue for the life of the view. Re-colouring on filter is the fastest way to make a user misread a comparison.

**Sequential — magnitude.** One hue, blue, light → dark, from a defined 100–700 ramp. Used for conditional shading in the statistics table and for density in correlation plots. Never a rainbow.

**Diverging — polarity.** Used by the heatmap (§13.12) and all delta encodings: **blue ↔ red with a neutral gray midpoint** (light `#f0efec`, dark `#383835`), equal step count per arm. The midpoint must read as *no change*, which is why it is gray and not a third hue.

**Status — reserved, never themed, never a series colour.**

| Role | Hex | Use |
|---|---|---|
| good | `#0ca30c` | SLA pass, improvement |
| warning | `#fab219` | Approaching threshold, insufficient history |
| serious | `#ec835a` | Regression detected, unacknowledged |
| critical | `#d03b3b` | SLA breach, run failed, errors |

Status colours always ship with an **icon and a label**. `warning` and `serious` sit below 3:1 on the light surface by design — a status colour never carries meaning alone, so it never needs to.

**Domain semantics**, applied consistently across every chart in the product: OK uses slot 3 (aqua); KO and failure use status `critical`, **and** a dashed stroke, **and** an explicit label; baseline is muted ink; the current run uses slot 1.

### 22.4 Chart construction rules

| Rule | Specification |
|---|---|
| **One axis** | **Dual-axis charts are prohibited.** Two measures of different scale become two time-linked charts sharing a crosshair, small multiples, or values indexed to a common base. This is why active users is its own chart rather than an overlay (§13.2). |
| Marks | 2px lines; markers ≥ 8px; 4px rounded data-ends anchored to the baseline; 2px surface gap between adjacent or stacked fills; 2px surface ring where marks overlap |
| Grid and axes | Hairline gridlines in the gridline token; axis labels in muted ink; no chart border |
| Legend | Always present for ≥ 2 series. With ≤ 4 series, also direct-labelled. A single series gets **no** legend — the title names it |
| Labels | Selective direct labels only. Never a number on every point |
| Text colour | Values, labels, and legend text wear **ink tokens, never the series colour**. A coloured mark beside the label carries identity |
| Scales | Percentile-over-time charts default to log Y so all bands stay legible; linear toggle available. Distribution bins are log-spaced by default |
| Empty and sparse | A chart with no data shows an explanation, not empty axes. Fewer than 5 comparable runs shows `insufficient history`, never a misleading trend line |

### 22.5 Interaction

Every chart ships a hover layer by default: crosshair with a shared tooltip on line and area charts, per-mark tooltip on bar, dot, and cell charts. Hit targets are larger than the marks. Filters sit in one row above the charts they control. Tooltips list all series at the hovered instant in value order, so ranking is readable without moving the pointer.

Linked behaviour across a page: one time axis, one crosshair, one zoom state, one legend selection (§12.4).

### 22.6 Layout and responsiveness

| Breakpoint | Behaviour |
|---|---|
| ≥ 1440px | Full layout; charts side by side; sidebar expanded |
| 1024–1439px | Charts stack to one column; sidebar collapses to icons |
| 768–1023px | Tablet: statistics table scrolls horizontally with a frozen name column |
| < 768px | Mobile: read-only summary — key tiles, sparklines, verdict, error summary. Deep analysis is explicitly a desktop task, and the mobile view says so rather than degrading badly |

### 22.7 States

Every data surface specifies four states: **loading** (skeletons matching final layout, never a spinner over a blank page), **empty** (explanation plus the next action — an ingest snippet, a filter reset), **error** (what failed, what to do, the correlation ID, and a retry), and **partial** (some data available, clearly marked, e.g. an incomplete live run).

### 22.8 Accessibility implementation

Beyond NFR-AC-1 through AC-7: charts expose an `aria-label` summarizing the trend and a keyboard-reachable data table; the statistics table implements `aria-sort` and announces row selection; focus is trapped correctly in dialogs and returned on close; live regions announce live-monitoring updates at a throttled cadence so a screen reader is not flooded; a texture fill (45° / 135° directional hatch) is available for CVD, print, and forced-colors modes so encoding survives without colour.

### 22.9 Internationalization implementation

All strings in ICU MessageFormat resource files with no sentence concatenation; `Intl` APIs for number, date, duration, and percentage formatting; a pseudo-locale in CI that lengthens strings by 40% and flips direction to catch truncation and RTL breakage before translation begins; all timestamps stored UTC and rendered in the user's timezone with the zone always visible on absolute times.

---

## 23. Reporting Requirements

### 23.1 Report types

| Type | Audience | Contents |
|---|---|---|
| **Run report** | Engineer | Full run detail: statistics table, all charts, errors, assertions, metadata |
| **Comparison report** | Engineer, release manager | Two or more runs, per-endpoint deltas, regression summary, commit range |
| **Executive summary** | Manager | Verdict, headline metrics, trend direction, SLA compliance, top regressions — one page, no chart requiring interpretation |
| **Engineering detail** | Engineer | Everything in the run report plus distribution, correlation, and per-endpoint drill-downs |
| **Release gate** | Release manager | Every service in a release tag with verdict, breaches, and acknowledgements |
| **Trend digest** | Manager, SRE | Metric trends over a period across a project set, with regressions and annotations |

### 23.2 Formats

**PDF** rendered server-side in `report-worker` via headless Chromium against a print stylesheet — page-size aware, with repeated table headers, vector charts, and a footer carrying run identity and generation timestamp. **Standalone HTML** as a single self-contained file with inlined assets for offline archival. **CSV and JSON** for any table and for time series at a chosen resolution.

A PDF is a rendering of a specific view at a specific time and carries a footer stating so, with a link back to the live view.

### 23.3 Scheduling

Cron-scheduled per organization with an explicit timezone, scoped to a project, folder, team, tag, or saved view, delivered to email addresses or a webhook. Failures retry and then surface in the schedule's history with the reason — a report that silently stopped arriving is a common and corrosive failure, so delivery state is visible rather than assumed.

### 23.4 Generation pipeline

```
request → validate scope + permissions → enqueue (report-worker)
   → resolve data via the same public API the UI uses
   → render (Chromium for PDF, template for HTML)
   → store in object storage with a 30-day expiry
   → notify requester with a pre-signed download URL
```

Reports resolve data through the public API rather than a privileged path, so a report can never contain data the requester could not otherwise access — permission checks are not duplicated, and therefore cannot diverge.

### 23.5 Share links

Per FR-REP-6: expiring (1h / 24h / 7d / 30d), revocable, optionally password-protected, read-only, scoped to a single resource. Creation and every access are audit-logged. A share link carries no session and grants no other access. Organization policy may disable share links entirely — a requirement for regulated deployments.

---

## 24. Analytics Requirements

### 24.1 Comparability fingerprint

The mechanism behind §6.4.6 and AC-STAT-5.

```
fingerprint = SHA-256(
    tool ‖ simulation ‖ environment ‖ normalize(injection_profile)
)
```

Branch, commit, and build are **excluded** — they are what varies between comparable runs. `normalize` sorts profile keys, rounds durations to the second, and drops presentation-only fields.

Components are stored in `fingerprint_components` alongside the hash so the algorithm can be revised and recomputed across history rather than orphaning it.

**Every baseline, trend, and regression query filters on fingerprint equality.** A trend chart spanning a fingerprint change renders a visible break with a marker naming what changed, rather than silently connecting across it (AC-STAT-5). This is what prevents a team from spending a day investigating a "regression" that was a load-profile edit.

### 24.2 Percentile aggregation

Percentiles are stored as **DDSketch** sketches, chosen over t-digest for three reasons specific to this workload:

1. **Merges are exact.** Two sketches sharing γ merge with zero added error. t-digest merges are approximate and order-dependent — and re-aggregation across buckets, endpoints, and runs is this system's single most frequent operation, so merge error would compound exactly where it hurts most.
2. **Relative error is guaranteed at 1% at every quantile** — the meaningful guarantee for latency, and one that can be published as a number rather than as "usually close."
3. Exact merges are what make **lossless bucket coalescing** (§20.2) valid. With an approximate merge, repeated coalescing would degrade the data.

`sketch_kind` is stored per row, so the choice is reversible.

> **Averaging percentiles anywhere in the system is a defect** (FR-STAT-4, AC-STAT-3). Static analysis enforces it in CI.

### 24.3 Regression detection

```
Given a metric M for endpoint E, over the trailing window W of runs
sharing E's project, fingerprint, and branch:

    median   = median(M over W)
    MAD      = median(|Mᵢ − median|  for Mᵢ in W)
    σ̂        = 1.4826 × MAD          # normal-consistent scale estimate
    regression  ⟺  M_current > median + k × σ̂

    default W = 7 runs · default k = 3.0 · both configurable per project
```

**Why MAD rather than standard deviation or a fixed percentage.** A fixed percentage threshold is wrong in both directions at once: on a noisy endpoint that routinely swings ±25% it fires constantly and teams learn to ignore it, while on a rock-steady endpoint a real 15% regression slips under it. Standard deviation is better but is itself distorted by the outliers we are trying to detect. MAD measures each endpoint against **its own** typical variability and is robust to the very spikes being detected — so noisy endpoints stop crying wolf and steady endpoints catch small real regressions (AC-SLA-3).

**Guardrails.** No detection runs until W contains at least 5 comparable runs; the state is reported as `insufficient history` and **never as `pass`**. Direction is per metric — latency and error rate flag on increase, throughput on decrease. A detected regression records baseline value, current value, percentage delta, sigma multiple, and commit range.

### 24.4 Baselines

| Type | Definition | Use |
|---|---|---|
| **Pinned** | A specific run chosen by a Maintainer | Release gates, known-good reference |
| **Rolling** | Median of the last N comparable runs | Default; adapts as a service evolves |
| **Branch** | Latest run on the default branch | Feature-branch comparison |

All three consider only fingerprint-matching runs.

### 24.5 Trend and heatmap semantics

**Trends** read `run_stats` exclusively — never time series — which is why a 100-run trend meets a 500 ms budget (§20.1) and why trends survive time-series expiry (§18.5). Runs are ordered by build ordinal, then start time. The tolerance band is `median ± k × σ̂` from §24.3, so the band a user sees is literally the rule that fires.

**Heatmap** cells encode `(current − baseline) / baseline` per endpoint, **each row normalized to its own baseline**. Without per-row normalization a 20 ms endpoint and a 2,000 ms endpoint cannot be compared at all, and the map degenerates into showing which endpoints are slow — which the statistics table already shows. Normalized, it shows which endpoints are *drifting*, which nothing else shows. Colour uses the diverging blue↔red scale with a gray midpoint (§22.3); cells carry numeric labels on hover.

### 24.6 Product analytics

The platform records its own usage — feature adoption, view frequency, time-to-insight funnels, search success rate — to serve §30. Collection is anonymized at the organization level by default, self-hosted-friendly, disclosed in the UI, and disableable with a single setting. Telemetry is never a condition of the product functioning.

---

## 25. AI Roadmap

Deliberately conservative and staged. Each phase is gated on a measurable precondition, because an AI feature that produces a plausible wrong answer about a performance regression costs more trust than it earns.

> **Governing constraint, all phases: no AI output ever gates a build, fails a run, or fires an alert on its own.** AI explains, ranks, and drafts. Deterministic statistics decide. This boundary does not move.

| Phase | Capability | Gate | Target |
|:-:|---|---|---|
| **1** | **Statistical anomaly detection** — multivariate change-point detection across metrics, seasonality-aware; catches gradual drift that per-run threshold rules miss | ≥ 20 comparable runs across ≥ 50 projects, to validate against known regressions | V2 |
| **2** | **Assisted root-cause ranking** — correlates a regression against endpoint co-movement, error-message shifts, commit-range diffs, and deployment events, producing a ranked list of candidate causes **with evidence and confidence** | Phase 1 precision ≥ 80% on a labelled set | V2.1 |
| **3** | **Natural-language query** — "show me endpoints that got slower than last release in staging" compiled to a platform query, with the generated query shown and editable | Stable public API and query grammar | V3 |
| **4** | **Narrative summaries** — draft written analysis of a run or trend for release notes and reviews, always labelled as generated and always editable | Phase 2 shipped and adopted | V3 |
| **5** | **Predictive capacity** — projecting saturation and headroom from historical load-versus-latency curves | Sufficient saturation-curve history | Exploratory |

**Data handling.** Self-hosted deployments must be able to run every AI feature against a self-hosted model or disable them entirely. No run data leaves the deployment without explicit, per-organization opt-in. Phase 1 requires no LLM at all — it is statistics, and it is deliberately first for that reason.

---

## 26. Milestones

Priorities in §6 mark **V1 program** membership. This section is the authoritative source for what lands at GA versus in a fast follow.

| # | Milestone | Delivers | Exit criterion | Release |
|:-:|---|---|---|---|
| **M0** | **Foundation** | Repo, CI, K8s manifests, Postgres schema core, auth skeleton, observability | A stranger deploys a running instance and authenticates | — |
| **M1** | **Ingest spine** | Ingest endpoint, Gatling plugin, plugin runtime, object storage, ingest tokens, job pipeline | One CI pipeline posts runs; nothing is lost; verdict contract works end to end | — |
| **M2** | **Statistics engine** | Canonical model, sketches, bucketing, coalescing, warm-up, distributions, correlations, error rollups, group and scenario scopes | AC-STAT-1 through AC-STAT-4 pass; throughput budget met | — |
| **M3** | **Parity UI** | Run, Request, Group, Scenario detail; statistics table; every chart in Appendix A; filtering, sorting, drill-down | **AC-PARITY-1 through AC-PARITY-4 pass.** A team retires the Gatling HTML report | Alpha |
| **M4** | **History & comparison** | Execution history, facets, search, comparison, trends, heatmap, baselines, annotations | Cross-build analysis usable without leaving the platform | Beta |
| **M5** | **Trust** | Absolute, relative, and noise-aware rules; regressions; commit attribution; Slack, webhook, email; digests | A real regression is caught, attributed, and announced automatically | Beta |
| **M6** | **Enterprise** | OIDC SSO, full RBAC, service accounts, API keys, audit log, retention, admin UI, public API + OpenAPI, data export | Passes a security review; an organization onboards multiple teams | **GA** |
| **M7** | **Live** | Streaming ingest, incremental aggregation, WebSocket API, live dashboard | AC-LIVE-1 through AC-LIVE-4 pass | **V1.1** |
| **M8** | **Reporting & personalization** | PDF/HTML reports, scheduled delivery, share links, custom dashboards, saved views, favorites, bookmarks | A manager receives a scheduled report without asking anyone | **V1.2** |
| **M9** | **Multi-tool** | k6, JMeter, Locust, Artillery plugins; SAML; environment comparison; release tracking | A contributor adds a tool without touching core (AC-PLUG-1) | **V2** |

**Sequencing rationale.** The hardest-to-reverse decisions — ingest contract, canonical model, schema — come first, because history cannot be backfilled, only forward-collected. Every day M1 is not running is trend data permanently lost. Parity (M3) precedes everything novel, because it is the adoption wedge and the honesty test. Enterprise (M6) gates GA because a performance platform without RBAC and audit cannot be deployed at an organization that needs one.

---

## 27. Release Plan

| Stage | Milestones | Audience | Exit gate |
|---|---|---|---|
| **Alpha** | M0–M3 | Internal team only | Parity matrix passes; one internal team uses it daily for two weeks |
| **Beta** | M4–M5 | 3–5 design partners | Partners ingest continuously for 30 days; a real regression is caught and attributed; no data loss incidents |
| **GA — V1** | M6 | General availability | Security review passed; documentation complete; all §20 budgets met at §7.3 scale; upgrade path documented |
| **V1.1** | M7 | GA customers | Live monitoring acceptance criteria pass |
| **V1.2** | M8 | GA customers | Scheduled reports delivering reliably for 30 days |
| **V2** | M9 | GA + new tool users | Two non-Gatling tools in production use |

**The parity gate blocks GA outright.** If AC-PARITY-3 fails, the release does not ship, regardless of what else is ready. Shipping a product that claims parity and does not have it would forfeit the central promise, and no other feature compensates.

**Release cadence after GA:** minor releases every 6 weeks, patches as needed, breaking API changes only at a major with 12 months' notice (§17.6). Every release ships migration notes, a changelog, and an SBOM.

---

## 28. Risks

| ID | Risk | Impact | Likelihood | Mitigation | Trigger to escalate |
|---|---|---|:-:|---|---|
| **R-1** | **Parity is larger than estimated** — the Gatling report has more surface than a walkthrough suggests | High | High | Appendix A enumerates it exhaustively before estimation; parity tests written before the UI; M3 explicitly scoped to nothing but parity | Appendix A rows incomplete at M2 exit |
| **R-2** | **Node.js throughput insufficient** for the ingest budget | High | Medium | Streaming parse with bounded memory; parsing isolated in workers; throughput benchmark as a CI test from M1, not a late discovery; worked memory model in §20.2 | Benchmark misses budget by > 25% at M2 |
| **R-3** | **Tool log formats change between versions**, and binary formats carry no compatibility guarantee | High | High | Version read first and driving the record layout; each supported major pinned to a checked-in reference fixture; raw bundles retained for reprocessing; loud, actionable failures. **Re-rated upward after verification** — the format is binary and unversioned in practice, so this is now the primary ongoing maintenance burden of the Gatling plugin | Any silent misparse reaching production; any new tool major |
| **R-4** | ~~Binary output makes event-level parsing impossible~~ → **Binary decoding is core scope, and a future layout change breaks ingest** | High | Medium | **Reclassified, not mitigated.** Verification showed binary is Gatling's default and only format, so decoding it is required M1 work, not an error path (§A.9 F-1). Residual risk is a future major changing the layout: mitigated by version-gated decoders, pinned fixtures, retained raw bundles enabling reprocess-after-fix, and failing loudly rather than falling back to aggregates | A tool major ships a layout the installed plugin cannot decode |
| **R-5** | **Noisy environments produce false regressions**, teams mute alerts | High | High | MAD-based detection against each endpoint's own variability (§24.3); comparability fingerprint; acknowledgement workflow; digest mode | Acknowledgement rate for `environmental` > 30% |
| **R-6** | **Users compare across tools** and draw wrong conclusions | High | Medium | Hard refusal to overlay tools (§6.4.6); tool in the fingerprint; explanatory message instead of a chart | Any UI path found that permits it |
| **R-7** | **Prisma used on the metrics read path**, degrading query performance | High | Medium | §16.8 constraint stated as architecture, not preference; lint rule confining metric-table access to M6's raw-SQL repositories; performance tests at 500k runs | Any metric query issued through Prisma |
| **R-8** | **Cross-tenant data leak** | Critical | Low | Mandatory `organization_id` predicate in the repository base; lint rule against raw tenant-table queries elsewhere; automated cross-tenant probe on every endpoint; `404` not `403` | Any finding, at any severity |
| **R-9** | **Scope creep toward test execution** | High | Medium | Execution is an explicit non-goal (§5.3); the ingest contract keeps it a separable future product | Any story assuming the platform runs a test |
| **R-10** | **Live monitoring destabilizes the core** | Medium | Medium | Deferred to V1.1 behind GA deliberately; separate `ws` deployable; degradation to polling; bounded replay buffers | Live work blocking a GA milestone |
| **R-11** | **Time-series storage growth** outpaces retention assumptions | Medium | Medium | Monthly partitions with drop-based retention; per-project overrides; storage visibility in admin; adaptive bucket caps | Storage growth > 2× forecast for two months |
| **R-12** | **Adoption friction** — teams do not wire CI | High | Medium | Three-line snippet; auto-detection; actionable errors; parity as the wedge; onboarding empty states with copyable snippets | < 50% of target pipelines wired 60 days post-onboarding |
| **R-13** | **Plugin contract proves insufficient** for a real second tool, forcing core changes | Medium | Medium | Contract validated against k6 and JMeter shapes during M1 design, not after; capability descriptor absorbs tool differences; conformance harness | Any core change required to add a plugin |

---

## 29. Future Enhancements

Beyond V2, listed with the reason each is deferred rather than dismissed.

| Enhancement | Rationale for deferral |
|---|---|
| **Distributed-run merging** | The data model already permits it — sketches merge and events carry timestamps — so it is additive. Deferred because single-injector runs cover the large majority of use and it adds ingest-contract complexity |
| **APM and tracing correlation** | High value: jumping from a slow endpoint to its traces closes the loop from *what* to *why*. Deferred because it requires per-vendor integrations and a shared correlation identifier that most CI-driven load tests do not yet emit |
| **Custom metric definitions** | Users defining derived metrics from stored data. Deferred until the built-in metric set has been exercised in production long enough to know what is actually missing |
| **Cost correlation** | Latency against infrastructure spend. Deferred pending cloud-billing integration |
| **Public plugin marketplace** | Requires review, signing, and trust infrastructure disproportionate to the current plugin count |
| **Multi-region active-active** | Meaningful operational complexity for an availability target that single-region with fast failover already meets |
| **Native mobile applications** | The mobile web summary (§22.6) covers the realistic mobile use case — checking a verdict. Deep analysis is a desktop task |
| **Test-script authoring or storage** | Scripts belong in the user's repository. Storing them here would blur the execution boundary that §5.3 protects |
| **Self-service tenant signup / SaaS billing** | The product is self-hosted first; a hosted offering would need billing, quota enforcement, and abuse handling that do not serve the primary deployment model |

---

## 30. Success Metrics

### 30.1 Product metrics against business goals

| Goal | Metric | Measurement | V1 target | Health floor |
|---|---|---|---|---|
| BG-1 | Teams that stopped publishing tool HTML artifacts | Onboarding survey + CI configuration audit | ≥ 70% within 60 days | 50% |
| BG-2 | Median time from regressing merge to acknowledged alert | Platform telemetry: commit time → acknowledgement | < 2 hours | < 8 hours |
| BG-3 | Median time from alert to identified endpoint and commit | Funnel: notification → comparison view → commit link click | < 10 minutes | < 30 minutes |
| BG-4 | Share of load-testing pipelines wired to the platform | Ingest source count vs. known pipeline inventory | ≥ 80% | 60% |
| BG-5 | Distinct tools ingesting into one deployment | Run metadata | ≥ 3 by V2 | 2 |
| BG-6 | Scale sustained without redesign | Production observation against §7.3 | All targets met | 80% of targets |
| BG-8 | Externally contributed plugins | Repository | ≥ 1 by V3 | 0 with a documented attempt |

### 30.2 Engagement metrics

Weekly active users by persona; runs ingested per week; comparison views per regression alert (a proxy for whether alerts are acted on); trend views per user per week; search success rate (searches followed by a result click); alert acknowledgement rate and reason distribution — a rising `environmental` share signals detection is mis-tuned (R-5).

### 30.3 Quality and reliability metrics

| Metric | Target |
|---|---|
| Ingest success rate | ≥ 99.5% of well-formed bundles |
| Runs lost | **Zero.** Any loss is a Sev-1 |
| Parity test pass rate | 100%, continuously |
| False-positive regression rate | < 10% of flagged regressions acknowledged as `environmental` or `expected` |
| API availability | ≥ 99.9% monthly |
| p95 dashboard latency | Within §20.1 budgets |
| Time to first successful ingest, from zero | < 30 minutes |
| Accessibility violations, automated scan | Zero critical or serious |
| Open critical or high vulnerabilities | Zero beyond the §19.8 SLA |

### 30.4 The leading indicator

> **Comparison views per regression alert.** If alerts fire and nobody opens the comparison, the alerts are not trusted — and every other metric in this document is measuring activity rather than value. This is the number to watch first, and the one most likely to reveal that the product is technically correct and practically ignored.

---

# Appendix A — Gatling OSS report parity matrix

**This appendix is the V1 gate.** AC-PARITY-1 through AC-PARITY-4 are asserted against it, and CI fails if any row regresses. It exists so "100% parity" is a checklist an engineer can complete rather than a claim a reviewer must trust.

### A.0 Version anchoring and verification record

> **VERIFIED — 2026-08-07 against Gatling 3.15.1.2, re-verified 2026-08-08 against the shipped implementation.**
> This matrix is no longer written from expectation. It was validated element by element against a real generated report, and **five rows were wrong**. Those corrections are recorded in §A.9. A second pass, run once the platform's own report-parity suite existed, found **six more** — recorded as F-7 through F-12. The fixture that produced the reference report is in [`fixtures/gatling-3.15.1.2/`](fixtures/gatling-3.15.1.2/).

The structure of Gatling's HTML report has changed materially across major versions — chart sets, the group model, the latency charts, and the log format itself have all moved or disappeared. Therefore:

1. The matrix is **pinned to Gatling 3.15.1.2**, with the fixture and generated report checked in.
2. Parity is **re-validated for each newly supported major**, and differences are recorded as new rows rather than silently absorbed.
3. Verification is **element-by-element against a generated report**, never against documentation or recollection. Where the report and this matrix disagree, **the report wins**.
4. Any element found in the reference report but absent here is a **defect in this appendix**, fixed before implementation proceeds.

**Reference fixture.** A two-scenario simulation (`Browse`, `Checkout`) with a nested group hierarchy, six endpoints of deliberately different latency shapes, two distinct failure modes, a ramp-then-steady injection profile, and three assertions — two passing, one failing. It targets a local seeded server, so the run is reproducible and no external service receives load. It exists specifically to make every row below observable in one report.

**Tolerances** (AC-PARITY-2, revised — see §A.9 F-6): counts, OK/KO counts, percentages, min, max, mean, standard deviation, indicator bands, and error counts are **exact against Gatling's displayed value** — all verified exact against the fixture. **Percentiles are the exception:** Gatling's are histogram estimates, so they are compared against the **true percentile from the decoded event set** within 1% relative, never against Gatling's printed figure. **Distribution bins are not counts** (§A.9 F-8): Gatling renders **percentages of the combined OK+KO count**, to 2 dp, over 100 **midpoint-labelled** bins — `floor(min + step·i + step/2 + 0.5)` with `step = (max−min)/100` — so the tolerance is bin labels exact, percentages exact to 2dp, never raw counts.

### A.1 Global report page

| # | Gatling element | Platform requirement | Location | Test | Tolerance |
|:-:|---|---|---|---|---|
| G-01 | Report header — simulation name | FR-META-1 | §13.2 ① | PT-G-01 | Last dot-segment exact — see §A.9 F-10 |
| G-02 | Report header — run description | FR-META-1 | §13.2 ① | PT-G-02 | Exact string |
| G-03 | Report header — run start date/time | FR-META-1 | §13.2 ① | PT-G-03 | Exact instant |
| G-04 | Report header — run duration | FR-META-1 | §13.2 ① | PT-G-04 | Exact to the displayed second — see §A.9 F-9 |
| G-05 | Assertions table — expression, expected, actual, status | FR-SLA-1 | §13.2 ② | PT-G-05 | Exact |
| G-06 | Ranges / indicators — band `t < lowerBound` count and % | FR-STAT-11 | §13.2 ③ | PT-G-06 | Exact |
| G-07 | Ranges / indicators — band `lowerBound ≤ t < higherBound` | FR-STAT-11 | §13.2 ③ | PT-G-07 | Exact |
| G-08 | Ranges / indicators — band `t ≥ higherBound` | FR-STAT-11 | §13.2 ③ | PT-G-08 | Exact |
| G-09 | Ranges / indicators — band `failed` | FR-STAT-11 | §13.2 ③ | PT-G-09 | Exact |
| G-10 | Number of requests — OK vs KO chart with totals | FR-STAT-2 | §13.2 ④ | PT-G-10 | Exact |
| G-11 | Statistics table — all rows, hierarchical with groups | FR-STAT-2, FR-STAT-13 | §13.2 ⑤, §14.1 | PT-G-11 | Row set exact |
| G-12 | Statistics table — every column (see §A.5) | FR-STAT-2 | §14.1 | PT-G-12…24 | Per §A.5 |
| G-13 | Statistics table — expandable/collapsible groups | FR-DASH-14, §14.1 | §14.1 | PT-G-25 | Behavioural |
| G-14 | Statistics table — name filter box | FR-FIND-3 | §14.1 | PT-G-26 | Behavioural |
| G-15 | Statistics table — sortable columns | FR-FIND-4 | §14.1 | PT-G-27 | Behavioural |
| G-16 | Statistics table — link from row to detail page | FR-DASH-3 | §12.4 | PT-G-28 | Behavioural |
| G-17 | Errors table — distinct message, count, % of errors | FR-STAT-12 | §13.2 ⑥ | PT-G-29 | Exact |
| G-18 | Active Users over Time — per scenario | FR-STAT-9, FR-DASH-1 | §13.2 ⑦ | PT-G-30 | Exact per bucket |
| G-19 | Active Users over Time — total series | FR-STAT-9 | §13.2 ⑦ | PT-G-31 | Exact per bucket |
| G-20 | Response Time Distribution — OK series | FR-STAT-10 | §13.2 ⑧ | PT-G-32 | Bin labels exact; percent of combined OK+KO exact to 2dp — see §A.9 F-8 |
| G-21 | Response Time Distribution — KO series | FR-STAT-10 | §13.2 ⑧ | PT-G-33 | Bin labels exact; percent of combined OK+KO exact to 2dp — see §A.9 F-8 |
| G-22 | Response Time Percentiles over Time — OK series only | FR-STAT-4, FR-DASH-5 | §13.2 ⑨ | PT-G-34 | 1% relative — OK-only, see §A.9 F-11 |
| G-23 | Requests per Second over Time — All / OK / KO | FR-STAT-7 | §13.2 ⑩ | PT-G-35 | Exact per bucket |
| G-24 | Responses per Second over Time — All / OK / KO | FR-STAT-7 | §13.2 ⑪ | PT-G-36 | Exact per bucket |
| G-25 | Active users shown alongside the per-second charts | FR-STAT-9 | §13.2 ⑦ + §22.4 | PT-G-37 | Information parity — see §A.7 |
| **G-26** | **Number of users started per second** — user *arrival rate*, distinct from concurrent users | FR-STAT-9 | §13.2 ⑦ᵇ | PT-G-38 | Exact per bucket |

> **G-26 was missing from this matrix until verification.** Gatling renders `UserStartRateContainerId` on the global page as a separate chart from `MaxConcurrentUsersContainerId`. Arrival rate and concurrency are different quantities — a constant arrival rate produces a *rising* concurrency curve when the service slows, and that divergence is exactly the signal an engineer looks for. Omitting it would have been a real parity gap.

### A.2 Request detail page

| # | Gatling element | Platform requirement | Location | Test | Tolerance |
|:-:|---|---|---|---|---|
| RQ-01 | Statistics for the request — full column set | FR-STAT-2 | §13.3 ① | PT-RQ-01 | Per §A.5 |
| RQ-02 | Ranges / indicators for the request | FR-STAT-11 | §13.3 ② | PT-RQ-02 | Exact |
| RQ-03 | Response Time Distribution — OK and KO | FR-STAT-10 | §13.3 ③ | PT-RQ-03 | Bin labels exact; percent of combined OK+KO exact to 2dp — same renderer as G-20/G-21, see §A.9 F-8 |
| RQ-05 | Response Time Percentiles over Time — OK series only | FR-STAT-4 | §13.3 ⑤ | PT-RQ-05 | 1% relative — OK-only, see §A.9 F-11 |
| RQ-07 | Requests per Second over Time | FR-STAT-7 | §13.3 ⑦ | PT-RQ-07 | Exact per bucket |
| RQ-08 | Responses per Second over Time | FR-STAT-7 | §13.3 ⑧ | PT-RQ-08 | Exact per bucket |
| RQ-09 | **Response Time against Global RPS** (`responseTimeScatterContainerId`) — one point per second; x = global requests/s, y = truncated p95, OK series floors observations into buckets (§A.9 F-12) | FR-STAT-14 | §13.3 ⑨ | PT-RQ-09 | 1% relative, against ground truth — see §A.9 F-7 and §A.7 D-03 |
| RQ-11 | Errors for this request | FR-STAT-12 | §13.3 ⑪ | PT-RQ-11 | Exact |

> **RQ-04, RQ-06, and RQ-10 were removed — they do not exist.** This matrix originally claimed a Latency Distribution, Latency Percentiles over Time, and Latency against Global RPS on the request page. A case-insensitive search of the entire generated report returns **zero occurrences of "latency"**: Gatling 3.15.1.2 reports response time only. Those charts existed in older Gatling versions and have since been removed.
>
> **Consequence:** latency as a separate metric family (FR-STAT-3) is **beyond parity**, not parity. It stays in the product for tools that do report it, gated by the `latency` plugin capability (§21.3), and is listed under §A.8 rather than counted toward the GA gate. Row RQ-09 survives — the response-time scatter is real.

### A.3 Group detail page

| # | Gatling element | Platform requirement | Location | Test | Tolerance |
|:-:|---|---|---|---|---|
| GR-01 | **Cumulated Response Time** — full statistic set | FR-STAT-13 | §13.4 | PT-GR-01 | Per §A.5 |
| GR-02 | **Group Duration** — full statistic set | FR-STAT-13 | §13.4 | PT-GR-02 | Per §A.5 |
| GR-03 | Cumulated response time — distribution | FR-STAT-10, FR-STAT-13 | §13.4 | PT-GR-03 | Bin labels exact; percent of combined OK+KO exact to 2dp — same renderer as G-20/G-21, see §A.9 F-8 |
| GR-04 | Cumulated response time — percentiles over time, OK series only | FR-STAT-4, FR-STAT-13 | §13.4 | PT-GR-04 | 1% relative — OK-only, see §A.9 F-11 |
| GR-05 | Duration — distribution | FR-STAT-13 | §13.4 | PT-GR-05 | Bin labels exact; percent of combined OK+KO exact to 2dp — same renderer as G-20/G-21, see §A.9 F-8 |
| GR-06 | Duration — percentiles over time, OK series only | FR-STAT-13 | §13.4 | PT-GR-06 | 1% relative — OK-only, see §A.9 F-11 |
| GR-08 | Nested groups rendered hierarchically | FR-STAT-13 | §13.4 | PT-GR-08 | Structure exact |
| GR-09 | Group indicators / ranges (`RangesContainerId`) | FR-STAT-11 | §13.4 | PT-GR-09 | Exact |

> **GR-07 was removed — it does not exist.** The group page in 3.15.1.2 carries exactly five containers: ranges, cumulated-response-time distribution and over-time, and duration distribution and over-time. There are no requests/responses-per-second charts at group scope. Verified against the nested `Catalog` → `Recommendations` group in the fixture.

**Cumulated response time and duration are different quantities** — the first sums the durations of the requests inside the group, the second measures the group's wall-clock span. Collapsing them into one metric is the most common group-parity error, and `metric_family` (§18.2) exists to keep them distinct end to end. Both were confirmed present as separate distribution and over-time chart pairs.

### A.4 Scenario scope — **not a parity surface**

> **Rows S-01 through S-04 were removed. Gatling 3.15.1.2 has no scenario detail page.** The report contains `index.html`, seven `req_*.html` pages, and three `group_*.html` pages — and nothing else. Scenario identity appears only as a series in the global concurrent-users and user-start-rate charts.
>
> The Scenario Detail page specified in §13.5 is therefore a **beyond-parity feature** (§A.8). It remains in the product — per-scenario analysis is genuinely useful and the canonical model already carries `scenario` on every event — but it does not count toward the GA parity gate, and no parity test asserts it.

| # | Gatling element | Platform requirement | Location | Test |
|:-:|---|---|---|---|
| S-01 | Scenario identity as a series in the concurrent-users chart | FR-STAT-9 | §13.2 ⑦ | PT-S-01 |
| S-02 | Scenario identity as a series in the user-start-rate chart | FR-STAT-9 | §13.2 ⑦ᵇ | PT-S-02 |

### A.5 Statistics table columns — exhaustive

| # | Column group | Column | Platform field | Tolerance |
|:-:|---|---|---|---|
| C-01 | Requests | Total | `count` | Exact |
| C-02 | Requests | OK | `ok_count` | Exact |
| C-03 | Requests | KO | `ko_count` | Exact |
| C-04 | Requests | % KO | `error_rate` | Exact |
| C-05 | Requests | Cnt/s | `throughput_rps` | Exact |
| C-06 | Response Time (ms) | Min | `min_ms` | Exact |
| C-07 | Response Time (ms) | 50th percentile | `percentiles.p50` | 1% relative |
| C-08 | Response Time (ms) | 75th percentile | `percentiles.p75` | 1% relative |
| C-09 | Response Time (ms) | 95th percentile | `percentiles.p95` | 1% relative |
| C-10 | Response Time (ms) | 99th percentile | `percentiles.p99` | 1% relative |
| C-11 | Response Time (ms) | Max | `max_ms` | Exact |
| C-12 | Response Time (ms) | Mean | `mean_ms` | Exact |
| C-13 | Response Time (ms) | Std Dev | `stddev_ms` | 0.1% |

Every column is available at every scope — global, scenario, group, and request — and for every applicable `metric_family`.

### A.6 Configurable behaviour that must also match

| # | Gatling configuration | Platform equivalent | Requirement |
|:-:|---|---|---|
| K-01 | Indicator lower bound (default 800 ms) | Project setting | FR-ORG-8, FR-STAT-11 |
| K-02 | Indicator higher bound (default 1200 ms) | Project setting | FR-ORG-8, FR-STAT-11 |
| K-03 | The four configurable statistics-table percentiles (default 50/75/95/99) | Project setting; stored in JSONB so no schema change is needed | FR-STAT-2, §18.7 |
| K-04 | Percentile bands rendered on the over-time chart | Band selector (§13.7) | FR-DASH-5 |

AC-PARITY-4 asserts a project configured with non-default bounds and non-default percentiles renders accordingly — parity includes Gatling's *configurability*, not just its defaults.

**K-03 governs the statistics-table columns only.** The four configurable percentiles apply to the C-07…C-10 columns of §A.5. The over-time band set (G-22, RQ-05, GR-04, GR-06) is **fixed**, not configurable through K-03: the buckets that back those charts store plain numbers (`percentilesOk`/`percentilesKo` per bucket, §A.9 F-11), not a re-queryable sketch, so the bands rendered are whatever was written at aggregation time. K-04's band selector controls which of those fixed bands are *displayed*, not which are *computed*.

### A.7 Deliberate deviations

Three, all recorded here so they are visible rather than discovered.

| # | Deviation | Rationale | Parity status |
|:-:|---|---|---|
| D-01 | **Active users is a separate time-linked chart rather than a secondary-axis overlay** on the per-second charts | A dual-axis chart lets two unrelated scales be positioned so lines appear to track; the correlation becomes an artifact of axis choice. Every value remains present and readable at the same instant via the shared crosshair (§22.4) | **Information parity, corrected encoding.** Not a gap |
| D-02 | **No fallback to tool-generated aggregates** when the binary log cannot be parsed for a given tool version | Aggregates yield no sketches and no time series; such runs would look identical to full-fidelity runs while lacking re-aggregation, zoom, and merge guarantees, breaking DB-2 for some rows only. **Materially revised after verification** — this is now a narrow last-resort rule, not the primary handling of binary logs. See §A.9 F-1 | **Intentional scope exclusion**, not a parity gap |
| D-03 | **Per-second bucketing floors the observation into its bucket; Gatling rounds to the nearest bucket** (`StatsHelper.timeToBucketNumber` uses `.round`) | Floor is scale-consistent — `floor(floor(t/w)/2) == floor(t/2w)` — so a coalesced 4s series equals one built directly at 4s (AC-STAT-2's lossless-coalescing invariant). Nearest-rounding was implemented, measured, and reverted because it makes coalescing history-dependent. The decisive argument: `BucketSeries` is a streaming builder whose width changes mid-run, so under nearest-bucket rounding an event's bucket depends on whether coalescing had already fired when it arrived — the same run yields different output under different arrival interleavings, and floor is the only rule that survives that. **Measured cost against the fixture:** the RQ-09 scatter's OK series differs by one point on two of seven request pages — `Add To Cart` 48 vs Gatling's 47, `Place Order` 53 vs 54; KO counts are exact (15 and 9) on both. See §A.9 F-12 | **Accepted deviation**, traded for a foundational engine invariant — not a defect |

### A.8 Beyond parity

Present in the platform, absent from the Gatling 3.15.1.2 report — listed to keep the parity claim and the improvement claim separate.

**Promoted here by verification** (previously miscounted as parity): **latency as a separate metric family** with its own distribution, percentile-over-time, and RPS-correlation charts (FR-STAT-3, capability-gated per §21.3) · **Scenario Detail page** (§13.5).

**Original beyond-parity set:** filtering, sorting, regex search, and drill-down on every table · cross-build history and trends · run comparison with deltas · endpoint × build heatmap · baselines and regression detection · SLA gating · live monitoring · annotations · commit attribution · saturation analysis across runs · export in multiple formats · a public API for everything visible.

### A.9 Verification findings — 2026-08-07 and 2026-08-08, Gatling 3.15.1.2

Twelve corrections across two verification passes. Recorded rather than quietly patched, because the size of the parity claim is what the GA gate rests on and it moved in both directions. The first pass (2026-08-07) validated the matrix against a generated report by eye; the second (2026-08-08) validated it against the shipped implementation and Gatling's own source, once the platform's report-parity suite existed to run the comparison mechanically.

| # | Finding | Severity | Resolution |
|:-:|---|---|---|
| **F-1** | **`simulation.log` is a binary format.** Not TSV. The file begins with a length-prefixed version string (`3.15.1`), the simulation class name, and the scenario name table, followed by binary records | **Critical — invalidates a prior design decision** | See below |
| **F-2** | **No latency charts exist.** A case-insensitive search of the entire report yields zero matches for "latency". Rows RQ-04, RQ-06, RQ-10 deleted | High — parity scope over-claimed | FR-STAT-3 moved to §A.8 |
| **F-3** | **No scenario detail page exists.** The report is `index.html` + 7 `req_*.html` + 3 `group_*.html`. Rows S-01…S-04 replaced with two chart-series rows | High — parity scope over-claimed | §13.5 moved to §A.8 |
| **F-4** | **Group pages have no per-second charts.** Exactly five containers: ranges, cumulated-RT distribution and over-time, duration distribution and over-time. Row GR-07 deleted | Medium | Removed |
| **F-5** | **"Number of users started per second" chart was missing** from this matrix (`UserStartRateContainerId`) | Medium — parity scope under-claimed | Added as G-26 |
| **F-6** | **Gatling's reported percentiles are histogram estimates, not observations.** Reported p99 = 2369 ms, a value that **does not occur in the data** (the sorted tail jumps 2287 → 2501). True p99 is 2501 — Gatling is 5.3% low | High — invalidates an acceptance criterion | AC-PARITY-2 split into exact vs. estimated quantities |
| **F-7** | **RQ-09 is not a per-request scatter — it's one point per second.** x = global requests/s (`getRequestsPerSecBuffer(None, None).counts`, `count.total`, both statuses combined); y = `digest.quantile(0.95).toInt` — truncated, not rounded (`LogFileData.scala:213`, tag `v3.15.1`). The fixture alone could not decide the truncation: p75 through max coincide on all seven request pages at ~3 requests/second | High — misdescribed the chart's unit of observation | RQ-09 description and tolerance corrected; compared against ground truth |
| **F-8** | **G-20/G-21 render percentages of the combined OK+KO count, not counts, over 100 midpoint-labelled bins.** Labels are `floor(min + step·i + step/2 + 0.5)`, `step = (max−min)/100`, reproduced exactly at min = 16, max = 2503. The `28` on the chart's first bin is a midpoint, not the fixture's minimum. `maxPlots` is the hardcoded literal `100` (`GlobalReportGenerator.scala:80`), not configuration | High — tolerance and units both wrong | §A.0 tolerance and G-20/G-21 rows corrected |
| **F-9** | **G-04's duration is whole seconds, not exact ms.** The header renders `Duration: 1m 2s`. "Exact ms" was unassertable from the report | Medium | Tolerance downgraded to "exact to the displayed second" |
| **F-10** | **G-01 renders only the last dot-segment of the simulation class name.** The platform stores the fully-qualified name (`example.ParitySimulation`); the report shows `ParitySimulation`. The platform deliberately keeps more information than the report displays | Low | Tolerance changed to "last dot-segment exact" |
| **F-11** | **G-22/RQ-05/GR-04/GR-06 are OK-only, not combined.** Gatling's percentiles-over-time chart is built from `responseTimePercentilesOverTime(OK, …)` and its rendered title is literally "Response Time Percentiles over Time (OK)"; its scatter is two independent status-filtered series. The platform now stores `percentilesOk`/`percentilesKo` per bucket alongside the combined set | High — a combined-series implementation would silently include KO responses Gatling excludes | Rows corrected to OK-only; consumers of the bucket rows must read the OK set |
| **F-12** | **RQ-09's bucketing floors an observation into its bucket; Gatling rounds to the nearest bucket** (`StatsHelper.timeToBucketNumber` uses `.round`). Nearest rounding was implemented, measured, and deliberately reverted — it breaks AC-STAT-2's lossless-coalescing invariant, since floor is scale-consistent (`floor(floor(t/w)/2) == floor(t/2w)`) and nearest is not | Medium — accepted, not fixed | Recorded as deliberate deviation D-03 (§A.7); measured cost below |
| — | Statistics table columns, indicator bands, error table, assertions table, ranges on request and group pages, and the response-time scatter **all verified present**; the binary format was **fully decoded and validated** (§A.10), confirming F-1 is tractable — every exact statistic reproduced from raw bytes, clean EOF, nested group hierarchy recovered | — | No change |

#### F-6 in detail — why parity tests must not chase Gatling's percentiles

The original AC-PARITY-2 required percentiles to match Gatling within 1% relative. Against the fixture that is **unachievable for p99 and undesirable in principle**:

| Statistic | Gatling reports | True value from decoded events | Divergence | Gatling's value occurs in the data? |
|---|---|---|---|---|
| p50 | 109 ms | 108 ms | −0.9% | **no** |
| p75 | 250 ms | 251 ms | +0.4% | **no** |
| p95 | 654 ms | 654 ms | 0.0% | yes |
| **p99** | **2369 ms** | **2501 ms** | **+5.6%** | **no** |

**Three of Gatling's four reported percentiles are values no request ever recorded.** They are artifacts of histogram bucketing, and the error is largest exactly where it matters most — in the tail, where p99 is 5.6% low. The sorted tail jumps straight from 2287 to 2501; nothing in the run took 2369 ms.

Requiring the platform to match it would mean **deliberately reproducing another tool's estimator error**, which contradicts FR-STAT-4 and the accuracy claim the whole product rests on. The rule is therefore: **exact quantities are compared to Gatling; percentiles are compared to ground truth.** The platform is permitted — and required — to be more accurate than the report it replaces.

This also gives the product a defensible, quantified claim: DDSketch guarantees 1% relative error at every quantile, where the static report it replaces is 5% off at p99 on a sample of this size.

#### F-12 in detail — the one-point cost of floor over nearest bucketing

Nearest-bucket rounding matches Gatling exactly on the RQ-09 scatter, but breaks the lossless-coalescing invariant AC-STAT-2 depends on: a series coalesced from finer buckets must equal a series built directly at the coarser width, and floor is the only rounding rule for which that holds in general. The measured, accepted cost of keeping floor is one scatter point on two of the fixture's seven request pages:

| Request page | Platform OK points | Gatling OK points | Platform KO points | Gatling KO points |
|---|---|---|---|---|
| Add To Cart | 48 | 47 | 15 | 15 |
| Place Order | 53 | 54 | 9 | 9 |
| All other request pages | exact | exact | exact | exact |

KO counts are exact on both affected pages — the divergence is confined to the OK series, where higher volume means more observations sit near a bucket boundary. This is a deliberate trade of one scatter point per affected page for a foundational engine invariant, not an unnoticed defect; it is why RQ-09's tolerance in §A.2 is compared against ground truth rather than Gatling's own bucketing.

### A.10 Binary format specification — verified by decoder

Recovered from the shipped jars (`io.gatling.core.stats.writer.{RecordHeader,*MessageSerializer,BufferedFileChannelWriter}`, `io.gatling.charts.stats.LogFileParser`) and **validated by a working decoder** ([`spikes/gatling-binary-log/`](spikes/gatling-binary-log/)) that reproduces every exact statistic in the report from raw bytes, consuming the file to a clean EOF.

**Primitives**

| Type | Encoding |
|---|---|
| `byte` / `boolean` | 1 byte; boolean is `0` = false, non-zero = true |
| `int` | 4 bytes, big-endian, signed |
| `long` | 8 bytes, big-endian, signed |
| `string` | `int len`; **if `len == 0` the string is empty and nothing follows**; else `len` bytes then **1 trailing coder byte** (`0` = LATIN1, `1` = UTF16) |
| `cachedString` | `int i`. **`i >= 0`: a new string follows inline**, cached under `i`. **`i < 0`: back-reference to `cache[-i]`.** The *sign* is the discriminator — index 0 can never be back-referenced since `-0 === 0` |
| `groups` | `int count`, then `count` × `cachedString`, outermost first |

**Record types** — `Run=0, Request=1, User=2, Group=3, Error=4`. Note Request and User are **not** in declaration order; assuming they were would silently corrupt every record.

**Header** (one `Run` record, first in file)

```
byte 0x00 · string gatlingVersion · string simulationClassName · long runStartEpochMs
string runDescription · int scenarioCount · string × scenarioCount
int assertionCount · (int len + bytes) × assertionCount     // see "Assertion payload"
```

**Assertion payload — NOT protobuf.** This was recorded as "protobuf, opaque" through two verification passes and both words were wrong. Decoding the bytes as protobuf yields a field-number-0 key, which protobuf forbids — the first sign the claim had never been tested. It is Gatling's own tagged encoding, and it is fully recovered below.

> **VERIFIED — 2026-08-17, Gatling 3.15.1.2, by corpus.** Derived by declaring one assertion per Path × Target × Condition in a single simulation, running it with `atOnceUsers(1)` (assertions are written to the header at start, so the traffic is irrelevant), and reading the emitted bytes back against known meanings. Every value below is observed, none inferred.

```
assertion  =  byte 0x00 · path · target · condition
path       =  0x01                                  global
              0x02                                  forAll
              0x03 · int16 partCount · part × N     details;  part = byte len · UTF-8 bytes
target     =  0x01 · int16 status                   count
              0x02 · int16 status                   percent      status: 1=all, 2=ok, 3=ko
              0x03 · int16 0x0001 · byte stat       response time
              0x04                                  requests/sec
              stat: 1=min 2=max 3=mean 4=stdDev 5=percentile · PAD · double rank
condition  =  0x01 · PAD · double                          lte
              0x02 · PAD · double                          gte
              0x03 · PAD · double                          lt
              0x04 · PAD · double                          gt
              0x05 · PAD · double                          is
              0x06 · PAD · double lo · double hi · bool     between (inclusive)
              0x07 · PAD · byte n · double × n              in
```

**`PAD` is a single `0x00` introducing a block of doubles** — once per block, not once per value, which is why `between` carries two doubles behind one pad. What it means is not known and this specification does not guess: every other small integer here is written `00 XX`, so it looks like the high half of a big-endian int16, but `lt` has no integer to carry and `in`'s count follows the pad rather than being it. Both readings fit the corpus and nothing in it separates them. The decoder consumes it and requires it to be zero, because reading one byte early does not fail — `30000.0` comes back as `2.4887944e-317`, a denormal that reads as an odd number rather than an error.

**All values are little-endian IEEE-754 doubles** — the one place in this format that is not big-endian, and the other half of the same trap.

**`around` and `deviatesAround` do not survive as distinct conditions.** Both are compiled to `between` with the bounds already evaluated: `around(36, 37)` is written as `between(-1.0, 73.0)`, and `deviatesAround(38, 0.5)` as `between(19.0, 57.0)`. A reader cannot recover which DSL call produced a `between`, and must not claim to.

**The log carries DEFINITIONS, never results.** There is no actual value and no pass/fail in the header — Gatling's report computes both at render time from the same log. So G-05 is not a decoding task alone: the verdict must be recomputed against this platform's own statistics, which is also what makes it *better* than the report, since those statistics are exact where Gatling's percentiles are estimates (F-6).

**Body** — records until EOF, each prefixed by its type byte:

```
Request (1)  groups · cachedString name · int startOffsetMs · int endOffsetMs
             · boolean ok · cachedString message
User    (2)  int scenarioIndex · boolean isStart · int timestampOffsetMs
Group   (3)  groups · int startOffsetMs · int endOffsetMs
             · int cumulatedResponseTimeMs · boolean ok
Error   (4)  cachedString message · int timestampOffsetMs
```

**All timestamps are `int` offsets in milliseconds from `runStartEpochMs`**, not absolute longs — which caps a single run at ~24.8 days and is worth asserting on at parse time.

**Note for the canonical model:** `Group` records carry `cumulatedResponseTimeMs` explicitly, separate from `endOffset − startOffset`. This confirms Appendix B's decision to model both rather than derive one from the other (Appendix A GR-01/GR-02).

#### F-1 in detail — why this reverses a decision

The earlier position (D-02, §21.8, R-4) was: *detect a binary log, fail loudly with an actionable error, and never fall back to tool aggregates.* That was reasoned on the assumption that binary logs are an **edge case** affecting some tool versions.

**They are not an edge case. Binary is Gatling's current default and only log format.** Applying the original rule to Gatling 3.15.1.2 produces a platform that cannot ingest Gatling **at all** — which would make the entire V1 parity commitment unachievable.

**Corrected position:**

1. **Parsing the binary `simulation.log` is the Gatling plugin's primary and required ingest path**, not an error branch. It is core M1 scope, and the plugin is version-aware because the format is unversioned in practice and may change between majors.
2. **`LOG_BINARY_FORMAT` is no longer an ingest error for Gatling.** It is retained in the error taxonomy for a genuinely unrecognised binary layout — a *future* format the installed plugin version does not understand.
3. **The no-aggregate-fallback rule survives, but narrowed.** It now applies only when the binary format cannot be decoded for a given version. It is a last resort, not the standard path. Verification also showed the fallback is *less* viable than assumed: `stats.json` and `global_stats.json` no longer exist, statistics are embedded directly in `index.html`, and chart series are inlined as JavaScript arrays — so a fallback would mean scraping generated HTML, which is far more brittle than the binary format it would be replacing.
4. **R-3 and R-4 in §28 are re-rated.** Binary-format handling moves from a *mitigated risk* to a *core implementation requirement with a version-compatibility risk attached*.

**This is the finding that justified validating the matrix before writing code rather than after.** Building M1 on the original assumption would have produced a Gatling plugin that rejects every real Gatling run, and the error would not have surfaced until first contact with an actual bundle.

---

# Appendix B — Canonical event and metric model

The contract referenced by §21 (plugins), §18 (schema), and §16.4 (ingest flow). Plugins produce the event stream; the statistics engine consumes it and produces the metric rollups; nothing downstream is tool-aware.

### B.1 Canonical events

```ts
type ToolId = 'gatling' | 'k6' | 'jmeter' | 'locust' | 'artillery' | string;

/** Emitted first, exactly once, so a plugin reads the bundle in one
 *  forward pass rather than needing a separate metadata method call. */
interface MetaEvent {
  type: 'meta';
  simulation: string;
  toolVersion: string;
  startedAtMs: number;
  description?: string;
}

interface RequestEvent {
  type: 'request';
  name: string;
  groups: string[];        // outermost → innermost; empty when ungrouped
  scenario?: string;
  userId: string;
  startMs: number;         // both edges retained — see note below
  endMs: number;
  firstByteMs?: number;    // enables latency; omitted when unsupported
  ok: boolean;
  message?: string;        // failure message when !ok
}

interface UserEvent {
  type: 'user';
  scenario: string;
  userId: string;
  kind: 'start' | 'end';
  tsMs: number;
}

interface GroupEvent {
  type: 'group';
  groups: string[];
  userId: string;
  startMs: number;
  endMs: number;
  cumulatedResponseTimeMs: number;   // distinct from (endMs − startMs)
  ok: boolean;
}

type CanonicalEvent = MetaEvent | RequestEvent | UserEvent | GroupEvent;
```

**Three modelling decisions carry weight:**

- **`startMs` and `endMs`, never a duration.** FR-STAT-7's separate started/ended counters and FR-STAT-9's requests-in-flight concurrency proxy both need each edge independently. A duration discards that irrecoverably, and no downstream computation can recover it.
- **`firstByteMs` is optional**, and its presence is what the `latency` capability declares. This is how a tool that cannot separate latency degrades to hiding those charts rather than fabricating them.
- **`GroupEvent` carries `cumulatedResponseTimeMs` explicitly** rather than letting the engine infer it, because cumulated response time and wall-clock duration diverge whenever requests within a group overlap — and Gatling reports both (Appendix A, GR-01/GR-02).

### B.2 Tool metadata and assertions

```ts
interface ToolMetadata {
  simulation: string;
  toolVersion: string;
  description?: string;
  injectionProfile?: Record<string, unknown>;  // normalized into the fingerprint
  configuredIndicatorBounds?: { lowerMs: number; higherMs: number };
  configuredPercentiles?: number[];
}

interface NativeAssertion {
  expression: string;
  scope: MetricScope;
  name: string;
  metric: string;
  expected: number;
  actual: number;
  passed: boolean;
}
```

### B.3 Metric rollups

```ts
type MetricScope  = 'run' | 'scenario' | 'group' | 'request';
type MetricFamily = 'response_time' | 'latency' | 'group_cumulated' | 'group_duration';

interface StatRollup {
  scope: MetricScope;
  name: string;                 // '' when scope === 'run'
  family: MetricFamily;
  count: number;
  okCount: number;
  koCount: number;
  errorRate: number;
  minMs: number;
  maxMs: number;
  meanMs: number;
  stddevMs: number;
  percentiles: Record<string, number>;   // key set is project-configurable
  throughputRps: number;
  sketch: Uint8Array;           // serialized DDSketch — the source of truth
  sketchKind: 'ddsketch';
}

interface TimeBucket {
  scope: MetricScope;
  name: string;
  family: MetricFamily;
  bucketStartMs: number;
  startedCount: number;         // requests begun in this bucket
  endedCount: number;           // requests completed in this bucket
  okCount: number;
  koCount: number;
  activeUsers?: number;         // run scope only
  activeUsersSource?: 'sessions' | 'in_flight';
  sketch: Uint8Array;
}
```

> **The invariant that governs every consumer:** `percentiles` is a convenience projection of `sketch`, exact at *that* scope and safe to read directly for display and run-granularity trends. **Any aggregation across buckets, endpoints, or runs merges `sketch` and never touches `percentiles`** (FR-STAT-4, AC-STAT-3). This is recorded as a comment on the schema columns, not left to be remembered.

### B.4 Errors

```ts
type IngestErrorCode =
  | 'BUNDLE_TOO_LARGE' | 'BUNDLE_NOT_ARCHIVE' | 'BUNDLE_EMPTY'
  | 'TOOL_AMBIGUOUS'   | 'TOOL_UNKNOWN'
  | 'LOG_NOT_FOUND'    | 'LOG_BINARY_FORMAT' | 'LOG_MALFORMED'
  | 'ENDPOINT_CARDINALITY_EXCEEDED' | 'NO_REQUESTS'
  | 'PROJECT_MISMATCH' | 'TOKEN_REVOKED'
  | 'PLUGIN_TIMEOUT'   | 'PLUGIN_MEMORY_EXCEEDED';

interface IngestError {
  code: IngestErrorCode;
  message: string;        // what happened
  remediation: string;    // what to do about it — REQUIRED
  detail?: Record<string, unknown>;
  correlationId: string;
}
```

`remediation` being a required field means an error that cannot state a fix **will not compile** — a structural guarantee for FR-ING-4 rather than a code-review convention.

---

# Appendix C — Glossary

| Term | Meaning in this document |
|---|---|
| **Comparability fingerprint** | A hash over tool, simulation, environment, and normalized injection profile, excluding build/branch/commit. Two runs are comparable only if their fingerprints match. Prevents trends silently connecting across configuration changes (§24.1) |
| **Cumulated response time** | For a group, the **sum** of its member requests' durations — distinct from the group's wall-clock duration, which they equal only when no requests overlap |
| **DDSketch** | The mergeable quantile sketch used for all percentiles. Merges are exact; relative error is bounded at 1% at every quantile (§24.2) |
| **Endpoint** | A named request as reported by the tool. Used interchangeably with "request name" |
| **Execution / Run** | One test execution ingested into the platform. Used interchangeably; `run` is the entity name |
| **Fast follow** | A release shipping within one quarter of GA, carrying V1-program scope that did not gate GA (§26) |
| **Indicator bands** | The four-way split of requests by response time — below the lower bound, between bounds, above the upper bound, and failed. Bounds are project-configurable (defaults 800 ms / 1200 ms) |
| **KO** | Gatling's term for a failed request, retained for parity |
| **Latency** | Time to first byte, distinct from response time (full request duration). Available only when the tool reports it |
| **MAD** | Median absolute deviation — a robust scale estimate, unlike standard deviation not distorted by the outliers being detected. The basis of noise-aware regression detection (§24.3) |
| **Metric family** | Which quantity a rollup measures: `response_time`, `latency`, `group_cumulated`, or `group_duration` |
| **Mergeable sketch** | A percentile data structure that can be combined without re-reading raw data. What makes re-aggregation at any zoom level correct |
| **Parity matrix** | Appendix A — the enumerated, tested checklist making "Gatling parity" verifiable |
| **Percentile stability** | The spread of p95 across recent runs, as opposed to its level. Rising variance can indicate degradation before the median moves (FR-STAT-15) |
| **Saturation knee** | The point on a response-time-versus-throughput curve where latency rises sharply — the practical capacity limit |
| **Scope** | The level a metric describes: run, scenario, group, or request |
| **Warm-up window** | The initial ramp period excluded from summary statistics but retained in time series, so headline numbers reflect steady state (§7.4 of the statistics engine, FR-STAT-8) |

---

*End of document.*

*This PRD describes an enterprise, self-hostable performance testing analytics platform. Version 1 is anchored on complete, verifiable parity with the Gatling OSS HTML report as enumerated in Appendix A; that parity gate blocks GA. Requirement priorities and open questions are expected to move as design partners weigh in.*
