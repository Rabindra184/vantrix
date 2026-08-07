# Perf Portal — Product Requirements Document

**Open-source performance reporting across builds, projects, and load-testing tools**

| | |
|---|---|
| **Document status** | Draft v1.0 — for review |
| **Product type** | Open-source, self-hosted web application |
| **Scope** | Reporting only (ingestion, aggregation, visualization, alerting) |
| **Supported tools (v1)** | Gatling, k6, JMeter — pluggable adapter interface for others |
| **Deployment model** | Single-tenant, multi-team, shared role-based access |
| **Last updated** | 2026-08-07 |

---

## Contents

1. [Summary](#1-summary)
2. [Users and roles](#2-users-and-roles)
3. [Scope](#3-scope)
4. [Functional requirements](#4-functional-requirements)
5. [Product principles and correctness rules](#5-product-principles-and-correctness-rules)
6. [Non-functional requirements](#6-non-functional-requirements)
7. [Architecture overview](#7-architecture-overview)
8. [Release plan](#8-release-plan)
9. [Risks and mitigations](#9-risks-and-mitigations)

---

## 1. Summary

Teams run load tests in CI on every build, but the results vanish into per-run HTML artifacts that no one keeps and nothing compares. The question that actually matters — *did this build get slower, and which endpoint caused it* — has no home. Perf Portal is the missing memory layer: CI posts each run's raw results, the portal parses them into durable metrics, and a web application shows every build for every project in one place, with regression detection that survives noise.

This is deliberately **reporting only**. The portal never drives load — CI already does that well. It ingests, aggregates, stores, visualizes, and alerts. That boundary is what keeps it simple enough to self-host in minutes and general enough to serve any tool that emits per-request results.

### 1.1 Why this exists

- **Per-run reports don't compare across builds.** A folder of HTML files can't answer whether p95 is trending up over the last month.
- **Commercial tools solve this but gate it.** Enterprise offerings do multi-project trends and comparison, but behind a licence and often bundled with execution features a reporting-focused team doesn't need.
- **No open, tool-agnostic option exists.** Gatling, k6, and JMeter each have their own report format; nothing gives one team using several tools a single dashboard.

### 1.2 What success looks like

Perf Portal succeeds if a team can, within one afternoon, stand up the portal, wire one CI pipeline to it, and — a few builds later — open a page that shows a performance regression, names the endpoint responsible, and links to the commits that likely caused it. Everything in this document serves that outcome.

> **NON-GOAL**
> Perf Portal does not run, schedule, or orchestrate load tests, and does not provision load injectors. It consumes results your existing CI produces. Execution may be a future project; it is explicitly out of scope here and no requirement in this document assumes it.

---

## 2. Users and roles

Perf Portal is single-tenant (one organization per deployment) but serves many teams and projects within that org, with role-based access so the right people see and change the right things.

### 2.1 Primary personas

| Persona | What they need | Primary surface |
|---|---|---|
| **Performance / QA engineer** | Deep analysis of a single run; compare two builds; explain a regression | Run detail, comparison |
| **Backend developer** | Did my change slow anything down? Which endpoint, which commit? | Project trends, regression alerts |
| **Engineering lead / EM** | Is any service across my teams degrading? Are SLAs holding? | Fleet overview |
| **Platform / DevOps** | Stand it up, wire CI, manage retention, tokens, and access | Admin, ingestion API |

### 2.2 Roles and permissions

Four roles, scoped by team. A user may hold different roles in different teams.

| Capability | Viewer | Member | Maintainer | Admin |
|---|:---:|:---:|:---:|:---:|
| View projects, runs, trends, comparisons | ✓ | ✓ | ✓ | ✓ |
| Annotate runs, acknowledge regressions | — | ✓ | ✓ | ✓ |
| Configure SLA rules, alert channels | — | — | ✓ | ✓ |
| Manage projects, ingest tokens, retention | — | — | ✓ | ✓ |
| Manage users, teams, roles, SSO, global settings | — | — | — | ✓ |

---

## 3. Scope

### 3.1 In scope for v1

- Ingestion of load-test results via a single authenticated HTTP endpoint, from any CI
- Adapters for Gatling, k6, and JMeter, plus a documented interface for adding more
- Parsing into durable per-endpoint statistics and pre-bucketed time series
- Full visual parity with the Gatling static report, plus cross-build views it lacks
- Multi-project, multi-team navigation with a fleet-level overview
- Noise-aware regression detection and SLA gating that can fail a CI build
- Alerting to Slack and generic webhooks
- Role-based access, SSO (OIDC), and per-project ingest tokens
- Configurable retention with sensible defaults

### 3.2 Explicitly out of scope for v1

- **Executing or scheduling load tests, or provisioning injectors** (may be a separate future product)
- **Distributed-run merging** (the data model is designed to allow it later; the feature is not built)
- **Multi-tenant isolation between separate organizations** (single-tenant per deployment)
- **APM / tracing / infrastructure-metric correlation** (integrations may come later)
- **Cross-tool numeric comparison** — tools measure differently and must not be overlaid; see §5.4

---

## 4. Functional requirements

Requirements are labelled **FR-n** and prioritized **P0** (v1 must ship with it), **P1** (v1 should), **P2** (later).

### 4.1 Ingestion

| ID | Requirement | Pri |
|---|---|:---:|
| **FR-1** | **One endpoint, every CI.** A single authenticated POST accepts a compressed results bundle plus a JSON metadata object (project, tool, build, branch, commit, environment, injection profile). The same three-line snippet works from Jenkins, GitHub Actions, GitLab, or a shell. | P0 |
| **FR-2** | **Tool auto-detection.** If the metadata omits the tool, the portal infers it from the bundle contents, and returns a clear error asking for it only when detection is ambiguous. | P0 |
| **FR-3** | **Synchronous verdict.** The response returns a run summary and the SLA pass/fail result. A failing verdict yields a non-2xx status so CI can gate on the exit code without extra scripting. | P0 |
| **FR-4** | **Actionable parse failures.** When a bundle can't be parsed, the error names the likely cause and the fix (e.g. a binary log format, or missing required columns) rather than failing opaquely. | P0 |
| **FR-5** | **Raw log retained.** The compressed raw result log is stored so metrics can be recomputed later — new metrics can be backfilled over history without re-running any test. | P1 |

### 4.2 Parsing and metrics

| ID | Requirement | Pri |
|---|---|:---:|
| **FR-6** | **Canonical event model.** Every adapter converts native output into a common request-event stream. All downstream logic is tool-agnostic; adding a tool means adding one adapter and nothing else. | P0 |
| **FR-7** | **Full statistics per endpoint.** For every request and run-wide: count, ok/ko, error rate, throughput, min, p50/p75/p95/p99, max, mean, and standard deviation — matching the Gatling report's table. | P0 |
| **FR-8** | **Pre-bucketed time series with mergeable sketches.** Percentiles are stored as t-digest sketches per time bucket, never as pre-averaged numbers, so they can be correctly re-aggregated at any zoom level. *Averaging percentiles is prohibited.* | P0 |
| **FR-9** | **Warm-up exclusion.** Ramp-period requests are detected and excluded from summary statistics while remaining visible in the time series, so cold-start latency doesn't pollute the numbers. | P1 |
| **FR-10** | **True concurrency when available.** Active-user curves are derived from the tool's session records where present, falling back to a requests-in-flight proxy, with the source clearly indicated. | P1 |

### 4.3 Visualization — single run

The run view must reach **full parity with the Gatling static HTML report**, so a team can retire that artifact entirely.

| ID | Chart / view | Pri |
|---|---|:---:|
| **FR-11** | Response-time percentiles over time (p50/p75/p95/p99), log-scaled so all bands stay legible | P0 |
| **FR-12** | Requests/sec and responses/sec over time, plotted separately (their divergence reveals back-pressure), with failures | P0 |
| **FR-13** | Active users over time | P0 |
| **FR-14** | Full statistics table, sortable, with per-endpoint drill-down that filters the other charts | P0 |
| **FR-15** | Response-time distribution histogram (log-spaced bins) | P0 |
| **FR-16** | Indicators bar (share of requests fast / medium / slow / failed, thresholds configurable per project) | P1 |
| **FR-17** | Error table — distinct failure messages with counts and shares | P0 |
| **FR-18** | Response time vs. concurrent users (saturation curve) — *beyond the static report*; exposes the capacity knee | P1 |
| **FR-19** | Linked crosshair and shared zoom across all time-series charts; interactions feel instant (see NFRs) | P1 |

### 4.4 Visualization — across builds and projects

This is where the portal surpasses per-run reporting and matches or beats commercial trend views.

| ID | View | Pri |
|---|---|:---:|
| **FR-20** | **Fleet overview.** Every project as a row: latest status, a p95 sparkline over recent builds, error rate, and time since last run. One screen answers "is anything degrading anywhere." | P0 |
| **FR-21** | **Project trends.** Any metric for any endpoint plotted across the last N builds, with a shaded tolerance band showing normal variation so regressions stand out visually. | P0 |
| **FR-22** | **Endpoint × build heatmap.** Rows are endpoints, columns are recent builds, colour is p95 delta vs. baseline — each row scaled to its own baseline so slow and fast endpoints are comparable by drift. | P0 |
| **FR-23** | **Build comparison.** Two runs side by side, per-endpoint deltas sorted by regression magnitude, improvements and regressions visually distinct. | P0 |

### 4.5 Regression detection and SLA gating

| ID | Requirement | Pri |
|---|---|:---:|
| **FR-24** | **Absolute SLA rules.** Per-project, per-endpoint thresholds (e.g. p95 ≤ 800ms), evaluated at ingest, changeable in the UI without a code commit. | P0 |
| **FR-25** | **Relative-to-history rules.** Thresholds expressed against the trailing median of comparable runs (e.g. p95 ≤ 120% of the 7-build median), so gates adapt as a service evolves. | P0 |
| **FR-26** | **Noise-aware detection.** A build is flagged only when a metric exceeds the trailing median by more than a configurable multiple of its own recent variability, so naturally noisy endpoints stop crying wolf and steady ones catch small real regressions. *This is the headline differentiator from threshold-only tools.* | P1 |
| **FR-27** | **Commit attribution.** When a regression fires, show the commit range between the last clean build and this one, linked to the configured Git host — turning a chart into a starting point for investigation. | P1 |
| **FR-28** | **Percentile-stability metric.** Track the spread of p95 across recent runs, not just its level; rising variance flags a service degrading before its median moves. | P2 |

### 4.6 Alerting and integration

| ID | Requirement | Pri |
|---|---|:---:|
| **FR-29** | Slack and generic-webhook notifications on SLA breach or detected regression, per project | P1 |
| **FR-30** | Read API mirroring every UI view (fleet, project, run, series, trend, compare) for scripting and embedding | P1 |
| **FR-31** | On-demand regeneration of the original tool's HTML report from the retained raw log, for deep dives | P2 |

### 4.7 Access, administration, and data lifecycle

| ID | Requirement | Pri |
|---|---|:---:|
| **FR-32** | **Authentication on everything.** Humans via SSO (OIDC); CI via per-project ingest tokens. No unauthenticated surface, including the ingest endpoint. | P0 |
| **FR-33** | Teams, projects, and role assignment manageable in the UI by Admins and Maintainers per §2.2 | P0 |
| **FR-34** | **Tiered retention.** Per-endpoint statistics kept indefinitely (they are tiny and are the trend history); high-resolution time series and raw logs aged out on a configurable schedule with a sensible default. | P1 |
| **FR-35** | Run annotations — notes on a run ("infra was noisy", "baseline after cache change") visible in trends | P2 |

---

## 5. Product principles and correctness rules

These are not style preferences — they are correctness constraints that separate a trustworthy performance tool from one that quietly misleads. Every implementation decision must respect them.

### 5.1 Percentiles never average

You cannot mean together bucket percentiles, or per-injector percentiles, and get a correct run percentile. The system stores a mergeable sketch per bucket and merges sketches whenever it re-aggregates. **Averaging p95 values anywhere in the codebase is a defect.**

> **WHY IT MATTERS**
> On representative data, merging sketches lands within a fraction of a percent of the true p95, while averaging bucket p95s can be off by several percent — and the gap widens sharply under uneven load, which is exactly when the number is being scrutinized.

### 5.2 Comparisons require a constant profile

A trend line is only meaningful if load profile, environment, and tool are held constant. Every run carries a comparability fingerprint; SLA baselines consider only runs that share it, and the UI visibly breaks a trend where the profile changed rather than silently connecting across it. This prevents teams chasing phantom regressions that are really configuration changes.

### 5.3 Warm-up is shown but not counted

Ramp-period requests hit cold caches and an unwarmed runtime. They remain visible on time-series charts (the ramp is real and worth seeing) but are excluded from summary statistics, so a run's headline p95 reflects steady state.

### 5.4 Tools are never numerically compared

Different tools measure different things — for example, some exclude connection setup from request duration by default. Absolute numbers across tools are not interchangeable. The portal stores the tool on every run and refuses to overlay runs from different tools on the same axis. **Valid comparison is always within one project and one tool.**

---

## 6. Non-functional requirements

### 6.1 Performance

- **Instant-feeling interaction.** Chart hover, zoom, and comparison must feel immediate; zoom must not refetch raw data. This is achieved by pre-aggregation, not by rendering tricks — it is most of what makes the product feel professional.
- **Bounded browser payloads.** The browser never receives raw per-request events; it receives pre-bucketed series. Read-path cost scales with build count, not with request volume.
- **Ingestion throughput.** A multi-million-request run must parse and aggregate within a small number of minutes on commodity hardware, and ingestion must not block the reporting UI.

### 6.2 Self-hosting and operability

- **Five-minute quickstart.** A single command brings up a working instance with no mandatory external services; object storage and a managed database are supported but optional.
- **Swappable storage.** The persistence layer is isolated behind one module so an operator can move from the embedded default to Postgres and object storage by changing that module alone.
- **Container-first, config via environment.** Standard container images; all configuration through environment variables or a single file.

### 6.3 Security

- No unauthenticated endpoints, including ingestion (per-project tokens) and reads (SSO)
- Ingest tokens are project-scoped and revocable; a leaked token can write to one project, not all
- Awareness that reports are sensitive: they expose endpoint names, infrastructure shape, and failure modes, and must sit behind auth from first deployment

### 6.4 Extensibility

- **Adapter interface as a first-class contract.** Adding a tool is implementing two methods (detect, parse) and returning canonical events; no schema, chart, alerting, or access-control code changes. This is the core of the "pluggable for others" requirement.
- **Documented and tested.** The interface ships with a reference adapter, a test harness, and a synthetic-data generator so a contributor can build and verify a new adapter without a live system.

### 6.5 Accessibility and quality floor

- Responsive to mobile widths; visible keyboard focus; reduced-motion respected
- Charts legible without relying on colour alone; failure always encoded consistently

---

## 7. Architecture overview

The design follows one rule: heavy artifacts stay out of the request path. Raw logs live in storage and are touched only at ingest or on explicit reprocess; everything the UI reads is small and pre-aggregated.

### 7.1 Components

| Component | Responsibility |
|---|---|
| **Ingestion service** | Receives bundles, dispatches to the right adapter, runs aggregation, evaluates SLAs, persists results, returns the verdict |
| **Adapters** | The only tool-aware code. Convert native output (Gatling / k6 / JMeter / …) to canonical events |
| **Aggregation engine** | Bucketing, mergeable percentile sketches, warm-up detection, distribution, saturation, error rollups |
| **Metadata store** | Projects, teams, roles, runs, per-endpoint stats, time series, SLA rules, assertions |
| **Object storage** | Compressed raw logs; optional cached generated reports |
| **Read API** | Small, indexed queries backing every UI view; also the public scripting surface |
| **Web application** | Fleet, project, run, and comparison views; tool-agnostic chart components |
| **Alerting worker** | Fans out breaches and regressions to Slack / webhooks |

### 7.2 Data model boundaries

- **`runs`** — one row per ingested run, with the comparability fingerprint and pointers to stored logs
- **`run_stats`** — per-endpoint aggregates including the sketch; kept indefinitely; the trend history
- **`run_timeseries`** — pre-bucketed points with per-bucket sketches; the only table that grows with run length; aged out on schedule
- **`sla_rules` / `assertions`** — centrally editable gates and their per-run results

> **DESIGN NOTE — FORWARD COMPATIBILITY**
> Distributed-run merging is out of scope for v1 but the model does not preclude it: because percentiles are stored as mergeable sketches and events carry timestamps, merging several injectors' logs into one run is additive later, requiring no change to the schema or the reporting layer.

---

## 8. Release plan

Sequenced so that value lands early and the hardest-to-reverse decisions (ingest contract, data model) come first. History accrues from day one, even before the UI is complete — because trend data cannot be backfilled, only forward-collected.

### 8.1 Milestones

| Milestone | Delivers | Exit criterion |
|---|---|---|
| **M0 — Ingest spine** | Ingest endpoint, Gatling adapter, aggregation, storage, tokens | One CI pipeline posts runs; nothing is lost |
| **M1 — Single-run parity** | All FR-11–19 charts and the statistics table | A team can retire the Gatling static report |
| **M2 — Multi-project** | Fleet overview, project trends, heatmap, comparison, read API | Leads see cross-project health in one place |
| **M3 — Trust** | Absolute + relative SLAs, noise-aware detection, commit attribution, alerting | A real regression is caught, attributed, and announced automatically |
| **M4 — Multi-tool** | k6 and JMeter adapters; adapter docs, harness, generator | A contributor adds a new tool without touching core |
| **M5 — Operability** | SSO, full RBAC, retention jobs, hardening, quickstart polish | A stranger self-hosts it in an afternoon |

### 8.2 What ships in the first usable release

M0 through M2 constitute the first genuinely useful release: ingest, full single-run reporting, and multi-project navigation. **M3 is what makes it worth adopting over clicking CI artifacts; M4–M5 are what make it worth open-sourcing.**

---

## 9. Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| **Tool log formats change between versions** | Parser breaks silently on upgrade | Anchor parsing on stable tokens, not column positions; retain raw logs to reprocess; fail loudly with actionable errors |
| **Binary log formats (some tool versions)** | Event-level parsing impossible | Detect and report clearly; fall back to the tool's own aggregate output; document the trade-off |
| **Noisy environments produce false regressions** | Teams mute alerts, tool loses trust | Noise-aware detection (FR-26); comparability fingerprint (5.2); run annotations (FR-35) |
| **Users compare across tools and draw wrong conclusions** | Misleading decisions | Hard refusal to overlay tools (5.4); store and surface tool on every run |
| **Scope creep toward execution** | Loses the simplicity that makes it self-hostable | Execution is an explicit non-goal; the ingest contract keeps it a separate future product |
| **Adoption friction for self-hosters** | Open-source project stalls | Five-minute quickstart, no mandatory external services, reference adapter and synthetic data for contributors |

### 9.1 Open questions

- Default retention windows for high-resolution series and raw logs — propose 90 days, confirm with early adopters
- Whether percentile-stability (FR-28) earns a place in v1 or waits — depends on early signal from noise-aware detection
- Minimum viable set of Git-host integrations for commit attribution (GitHub, GitLab first?)
- Exact default thresholds for the indicators bands, given they are tool- and domain-dependent

---

*End of document. This PRD describes scope and intent for an open-source, self-hosted, reporting-only performance portal. It is a draft for review; requirement priorities and open questions are expected to move as early adopters weigh in.*
