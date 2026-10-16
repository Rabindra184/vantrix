# Gatling Enterprise parity matrix

Measured 2026-10-15 on cloud.gatling.io, org `demo-perf` (trial), read-only
except for one package, one test and one run created for the purpose:

- package `perfportal-parity-demo` (built with `gatlingEnterprisePackage` from
  `gatling-gradle-plugin-demo-kotlin-main`, Gatling 3.15.1)
- test `perfportal-parity-basic` → `example.BasicSimulation`, Europe - Paris,
  1 load generator
- Run 1: 1m 31s, "Assertions failed", 2 credits

The same simulation was run locally at the same time and ingested into
PerfPortal (project `ge-parity`) so the accuracy findings below compare one
run's raw `simulation.log` with what PerfPortal and Gatling's own report show.

This is the input to sub-project 1 (accuracy contract) and sub-project 4
(page parity). It records what Gatling Enterprise (GE) shows, what PerfPortal
shows, and — the column that decides the work — **where the data has to come
from**:

| Source tag | Meaning |
|---|---|
| `log` | Derivable from Gatling's open-source `simulation.log` — today's ingest path |
| `hook` | Needs our own stats engine via `io.gatling.app.Runner.newStatsEngine` (no fork); proven in a throwaway probe on 2026-10-15 |
| `fork` | Open-source Gatling never emits it; needs a patched `gatling-http` / core |
| `agent` | Host metrics from PerfPortal's Go telemetry agent, or the launcher's JVM |
| `platform` | A product feature with no measurement behind it |

Status: **have** / **partial** / **missing**.

## 1. Accuracy findings (the reason for standard D)

Same local run, 1,718 requests:

| Figure | Exact from raw log | PerfPortal | Gatling OSS report |
|---|---|---|---|
| Count / KO / min / max | 1718 / 307 / 132 / 21508 | identical | identical |
| Mean | 454.17 | 454.17 | 454 (rounded) |
| p50 | 205 | 206.46 | 205 |
| p95 | 671 | 671.94 | 712 |
| p99 | 10417 | 10407.25 | 7909 |
| Session p95 | 2458 | 2465.65 | 3320 |

- PerfPortal's counts, extremes and mean are exact; its percentiles are
  DDSketch estimates within ~1%, which does **not** meet standard D.
- Gatling's OSS report percentiles are not nearest-rank values of the data
  (p99 24% low, Session p95 35% high). Matching it would mean copying error.
- GE defines its p95 tile as "the response time of one of the requests, such
  that 95% of the requests were faster" — an observed value, i.e. nearest
  rank. Consistent with standard D.
- GE offers no raw-log download (run menu: share public link, create custom
  report, delete run), so GE numbers can be compared by **method**, never
  verified per run.
- GE's error ratio is failed requests ÷ requests (275 / 1732 = 15.88%);
  standalone session errors ("No attribute named 'sessionId'", 8) appear in
  the errors table but not in the ratio.

## 2. Architecture observed

GE's run log, in order: `Launching the stats aggregator (may take about a
minute)` → `Stats aggregator started` → `Deploying locations` → load generator
`deployed, starting gatling process` → `Gatling process started and ready to
inject traffic` → `Injecting` → `Run started`. A per-run stats aggregator
exists before any load generator, which confirms pre-aggregation on the load
generators with a central merge.

## 3. Navigation (organisation level)

| GE section | GE content | PerfPortal | Status | Source |
|---|---|---|---|---|
| Home | Campaign progress, tests needing attention (7 d), credits, credit use by team | Home: glance, needs attention, runs by project | partial | platform |
| Campaigns (preview) | Runs grouped into campaigns with targets; 0–100 score over time | — | missing | platform |
| Tests | List: name + copyable id, campaign, source, team, last run (status, time, duration), start/stop | Tests catalogue per project | partial | platform |
| Sources › Packages | Name + id, format, team, tests, filename (+ Gatling version badge), last update, upload | Packages | have | platform |
| Sources › Git repositories | Build from a Git repository | — | missing | platform |
| Organization › Settings | Org time zone; switches for public links and AI features | — | missing | platform |
| Organization › Users / Invitations / Teams | People, invites, teams | Administration › Users; project roles | partial (no teams, no invitations) | platform |
| Organization › Usage / Billing | Credits | — | not applicable (self-hosted) | platform |
| Organization › Notifications | Per-org notification settings | — | missing | platform |
| API tokens | Name, token, last used | Per-project API tokens | have | platform |
| Dedicated IPs | Purchased fixed IPs for managed generators | — | not applicable until we run a cloud | platform |
| Private locations | Customer-hosted load generators | On-prem runner (one runner, no locations) | partial | platform |
| Integrations | Maven/Gradle/sbt; ~15 CI tools; Datadog, Dynatrace, OpenTelemetry, InfluxDB, New Relic export; Slack, Teams, Jira; protocol list | Gradle plugin, CI upload | partial | platform / hook (metric export) |

Observed defect worth not copying: GE's Tests page spins on "Loading tests…"
for ever while the org has zero tests.

## 4. Creating a test

| GE step | PerfPortal | Status | Source |
|---|---|---|---|
| 1 Package + simulation dropdown (from the manifest) + optional load test type (Standard, Stress, Spike, Capacity, Soak, Smoke) | New on-prem run: package + simulation dropdown | partial (no type) | platform |
| 2 Locations: managed / private / dedicated IPs; several locations, generator count and weight each | One runner | missing | platform |
| 3 Override the injection profile at run time | — | missing | hook or fork (needs injection replaced at launch) |
| 4 Java system properties + environment variables; org-wide defaults | Java options + system properties per run | partial (no env vars, no defaults) | platform |
| 5 SLOs, which replace the simulation's assertions | SLA rules beside assertions | partial (different model) | platform |
| 6 Time window: ramp-up / ramp-down seconds excluded | Project warm-up setting | partial | log |
| 7 Stop criteria | — | missing | hook (stop the run from the engine) |
| Save / Save and launch; confirmation before start | Queue run | have | platform |

## 5. Run page — chrome

| GE element | PerfPortal | Status | Source |
|---|---|---|---|
| Runs rail with status, start, duration; Start/Stop | Run list; runner cancel | have | platform |
| Run title (editable) + description (editable) | Run note | partial (no title) | platform |
| Tabs: Summary · Report · Logs · Compare runs | Summary · Report · Logs · Trends · Compare | have | — |
| Trends (last N runs) in the rail | Trends tab | have | log |
| Run menu: share public link, custom report, delete | — | missing | platform |
| Triggered by, location, credits used, Gatling version, injection profile, view properties | Header chips | partial (no trigger, no properties view) | platform |
| AI run analysis card | — | missing (backlog #11) | platform |
| Lifecycle strip with timestamps: Build → Deployed (13 s) → Assertions failed (1m 31s) | Lifecycle strip | have | platform |

## 6. Summary tab

| GE element | PerfPortal | Status | Source |
|---|---|---|---|
| Tiles: error ratio, total requests, max concurrent users, p95, each with a definition | Same four tiles | have | log |
| Assertions bar ("1 failed, 2 successful"), expandable, value per assertion | Simulation assertions bar | have | log |
| Requests and responses per second (total, OK, KO) | Rates chart | have | log |
| Response time percentiles over time, with band settings | Percentiles chart + bands menu | have | log |
| Errors table: label, occurrences, error ratio | Errors table | have | log |
| Live: tiles show "–" until the run ends | Live tiles while running | PerfPortal ahead | — |

## 7. Report tab

Header: absolute date range with duration, **Offset** toggle, request
timeline navigator (resolution, duration, zoom/step/fast-step controls).
PerfPortal: have (time window, offset toggle, navigator).

### Requests (filters: Scenario, Group, Request; Charts / Table)

| GE chart or column | PerfPortal | Status | Source |
|---|---|---|---|
| Requests and responses per second | have | have | log |
| **Responses per second by HTTP status** (200, 401, 403, 404) | — | missing | **hook** (OK responses' status is not in `simulation.log`) |
| Response time percentiles over time | have | have | log |
| Response time distribution (linear / log toggle) | have | partial (no toggle) | log |
| Response time percentiles distribution (90 / 99 / 99.9 %) | have | have | log |
| Errors per second | have | have | log |
| Table: **Outgoing** total and /s vs **Incoming** total, OK, KO, %KO, /s | Total, OK, KO, %KO, /s | partial (no outgoing) | **fork** (a request-sent event) |
| Table: min, 50, 75, 90, 95, 99, 99.9, 99.99 %, max, mean, std dev | Configurable percentiles | have | log |
| Table: Flat / Hierarchy toggle | Tree with expand | partial | — |
| Download CSV | CSV export | have | — |
| Scenario / Group / Request pickers on charts | Request filter on errors only | missing (backlog #7 note) | log |

### Groups

Charts per selected group ("Please select a group to display data") with the
same filters. PerfPortal: Groups section. Status: have; picker missing.

### Virtual users

| GE chart | PerfPortal | Status | Source |
|---|---|---|---|
| Users arrival rate (total + per scenario) | Users started per second | have | log |
| Users termination rate | Users ended per second | have | log |
| Concurrent users (total + per scenario) | Concurrent users over time | have | log |

### Connections (filter: remote host)

| GE chart | PerfPortal | Status | Source |
|---|---|---|---|
| Connection open and close rate | TCP connection events (host-level) | partial | **fork** for per-request; agent today |
| TCP connection by state | Connections by state (host-level) | partial | fork / agent |
| TCP connect duration percentiles over time | — | missing | **fork** |
| TCP connect duration distribution | — | missing | **fork** |
| TCP connection percentiles distribution | — | missing | **fork** |
| TLS handshake duration percentiles over time | — | missing | **fork** |
| TLS handshake duration distribution | — | missing | **fork** |
| TLS handshake percentiles distribution | — | missing | **fork** |
| Bandwidth usage per second (sent / received) | Bandwidth (host-level) | partial | fork for per-request; agent today |

### DNS (filter: hostname)

| GE chart | PerfPortal | Status | Source |
|---|---|---|---|
| DNS resolutions per second (OK / KO) | — | missing | **fork** |
| DNS resolution duration distribution | — | missing | **fork** |
| DNS resolution percentiles distribution | — | missing | **fork** |
| DNS resolution duration percentiles over time | — | missing | **fork** |

### Load generators (filter: generator)

| GE chart | PerfPortal | Status | Source |
|---|---|---|---|
| GC counts per second | — | missing (GE showed no data) | agent (launcher JVM MXBeans) |
| GC time per second | — | missing (GE showed no data) | agent |
| CPU usage (total / user / sys) | CPU usage | have | agent |
| Memory usage | Memory usage | have | agent |
| TCP connection events per second | TCP connection events | have | agent |
| TCP segment events (received, sent, retransmitted, received bad) | TCP segment events | have | agent |

## 8. Logs

GE: lifecycle events with phases (Deploying, Injecting, Ending) and sources
(`gatling-enterprise`, `stats-aggregator`, `control-plane`, the generator's
IP), including a deprecation warning when the package's Gatling version is
behind. PerfPortal: Logs tab for on-prem runner runs only. Status: partial
(no logs for Gradle-plugin or upload runs; no per-generator source).

## 9. Not measured this session

- Trends and Compare with two or more runs (the test has one run; both were
  measured on an earlier account — backlog items #1–#8).
- Public link page and custom report builder (both write to the account).
- Campaign creation (preview feature; writes).
- GE's run data stopped loading ~20 minutes after the run ("No data
  fetched" on Summary, empty Logs) — GE-side; re-check before relying on it.

## 10. What this means for the sub-projects

1. **Accuracy contract:** exact 1 ms histograms and nearest-rank percentiles;
   a parity suite against raw logs, with Gatling's report differences
   documented.
2. **Pipeline:** the `hook` rows (status codes, stop criteria, metric export)
   need our own stats engine; the `fork` rows (outgoing counts, TCP connect,
   TLS, DNS, per-request bandwidth) need a patched Gatling HTTP module — 13
   charts and one table column depend on it. That decides hook vs fork in
   favour of a maintained fork for full parity.
3. **Execution:** locations, generator counts and weights, injection
   override, stop criteria, environment variables.
4. **Platform parity:** campaigns, Git sources, teams and invitations, org
   time zone, public links, custom reports, notifications, observability
   export, AI analysis, run titles, load test type.
