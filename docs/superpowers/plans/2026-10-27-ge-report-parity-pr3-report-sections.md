# GE Report Parity PR 3: Report Sections Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The run Report draws Gatling Enterprise's Connections, DNS and Load generators charts, plus Requests' "Responses per Second by Status", from the five `/v1/runs/:id/agent*` endpoints PR 2 shipped.

**Architecture:** Pure transforms in `apps/web/src/charts/transforms/agent*.ts` turn the agent responses into `ChartData`. Section components in `apps/web/src/routes/report/` own their queries, their three "nothing to show" states and their Remote / Hostname filters. `RunReport.tsx` mounts them inside its existing `CollapsibleSection`s. A run with no agent file keeps today's Go-agent telemetry charts (`RunTelemetry`), unchanged.

**Tech Stack:** React 19, TanStack Query, ECharts through `charts/Chart.tsx`, zod contracts from `@perfportal/contracts`, Vitest (node and jsdom projects), Playwright.

**Spec:** `docs/superpowers/specs/2026-10-22-ge-report-parity-design.md`, §2 (what GE shows), §5, §6 and §7.5 (the Report). The PR 2 plan (`docs/superpowers/plans/2026-10-23-ge-report-parity-pr2-agent-figures.md`) and `packages/contracts/src/agent.ts` define the wire. No API, contract or database change is in scope.

## Global Constraints

- Node 22 (`nvm use`) in every command. Gate order: `pnpm build && pnpm typecheck && pnpm lint && pnpm test:unit && pnpm test:integration && pnpm test:e2e`. Read each gate's exit code from a file, never through a pipe.
- Floors before this PR: unit **267 / 4367**, integration **252 / 3955**, e2e **207**. Record the new floors in CLAUDE.md, predicted first and then measured.
- Chart titles, legends and units are GE's, verbatim (spec §2):
  - Connections: "Connection Open and Close Rate" (Opened, Closed); "TCP Connection By State"; "TCP Connect Duration Percentiles"; "TCP Connect Duration Distribution"; "TCP Connection Percentiles Distribution"; "TLS Handshake Duration Percentiles"; "TLS Handshake Duration Distribution"; "TLS Handshake Duration Percentiles Distribution"; "Bandwidth Usage per second" (Sent, Received; Mbps).
  - DNS: "DNS Resolution per Second"; "DNS Resolution Duration Distribution"; "DNS Resolution Duration Percentiles Distribution"; "DNS Resolution Duration Percentiles".
  - Load generators: "GC Counts per Second"; "GC Time per Second"; "CPU usage in percent" (User, Sys); "Memory Usage in MB" (RAM total, RAM used, Heap max, Heap committed, Heap used, Netty direct, Netty heap); "TCP Connections Events per Second" (active openings, failed attempts, established, received resets, sent resets); "TCP Segment Events per Second" (received, sent, retransmitted, received bad).
  - Requests: "Responses per Second by Status", one series per status code.
- GE's 13 percentile rows, labelled `Min, 25%, 50%, 75%, 80%, 85%, 90%, 95%, 99%, 99.9%, 99.99%, Max, Mean`, in `AGENT_PERCENTILE_ROWS` order. Hidden by default: **25%, 80%, 85%, 99.9%, 99.99%** (spec §7.5).
- Rates are the reader's: a counter's per-second figure is `value / (bucketWidthMs / 1000)`. Gauges (TCP states, `established`, CPU %, memory bytes) are drawn as stored, never divided.
- Never a zero where nothing was measured (spec §5). A `null` stays a gap. An unavailable figure says why, using the response's `reason` / `detail` or `machine.reason`.
- New charts appear only once the run is terminal (spec §4). While a run streams, every new chart renders `LiveNotice kind="withheld"`.
- Section order, as GE has it: Requests, Groups, Virtual users, Connections, **DNS** (new, `id="dns"`), Load generators.
- No icon or decorative SVG inside a chart `<figure>`. No `uppercase` on anything queried by accessible name in jsdom. No conditional spread of an object literal (an eslint rule). No backticks inside SQL or shell-quoted strings.
- Every time chart: a value x-axis in ms, `tickUnit: 'ms-as-s'`, pair-shaped series, `pairValue="y"`, `group={RUN_TIME_GROUP}`, the shell's `domainMs`.

## Review Focus

1. **A `?remote=` or `?hostname=` the run does not have** (a stale shared link): the page must not send it to the API, which answers 400 `UNKNOWN_REMOTE`. It reads as all remotes (`*`) instead, and the control shows "All remotes". Pinned in Task 6.
2. **A run whose agent ran with `machine: false`** (every macOS generator): CPU, the RAM series and both TCP event charts say the agent's own reason. GC, heap and Netty still draw. Pinned in Task 7.
3. **A window over a quiet stretch** (`available: true`, no buckets): each chart's empty sentence names the window, not the run. Pinned in Tasks 2–4, through `windowSelected`.
4. **A coalesced run** (`bucketWidthMs` 2000 or more): counters divide by the real width, so a 2 s bucket holding 10 opens draws 5/s, not 10/s. Pinned in Task 2.
5. **A run with the agent file but `http_not_collected`**: Connections, DNS and status say the agent's reason, while Load generators still draws. Pinned in Tasks 6–8.

---

## Rulings (decided here, so implementers do not have to)

- **Charts with more series than the six-hue palette.** The palette never cycles (`assignPalette`). TCP states have nine series, Memory seven, and GC collectors and status codes are open-ended. Rule: a series with **no non-zero reading in the payload** is not plotted, and the chart's `limitation` names it ("Not drawn: every reading is zero — finWait2, closing."). The data table keeps every column. If more than six series are still left, the existing cap and its note apply. Cost if wrong: a reader wanting a flat zero line for a state sees it named in the note instead.
- **`established` in "TCP Connections Events per Second"** is a gauge on the wire (`tcp.established`). It is drawn as stored, not divided by width, and the chart's `limitation` says so in one sentence. The four counters are per second.
- **Outcome default** for the duration percentiles-over-time and percentiles-distribution charts is `'ok'`, as `PercentilesChart` already defaults.
- **Filter state lives in the URL** as `remote` and `hostname` (GE's own `?remote=`), written with `replace: true`, keeping every other parameter (the AC-DASH-4 shareable-view rule). `useWindowSuffix` is not changed, so tab links do not carry them.
- **A run with no agent file** keeps `RunTelemetry` in Connections and Load generators (spec §7.5). DNS has no Go-agent equivalent, so it shows the not-collected notice. When `reason` is `unreadable`, the sections show the unreadable notice and do **not** fall back to telemetry: there was an agent file, and hiding it would misstate the run.
- **The single-entry Load generator picker** is a read-only labelled field naming `injector.host` (or "Unknown host" when null). A one-option `<select>` is a control that does nothing, the rule `RunTelemetry` already follows. When `injector.sharedWithPerfPortal` is true, one sentence beside it says the machine is shared with PerfPortal's database, API and worker.

---

### Task 1: Agent paths, queries and a captured fixture

**Files:**
- Modify: `apps/web/src/api/metricPaths.ts`
- Create: `apps/web/src/api/agent.ts`
- Modify: `apps/web/test/metricPaths.test.ts` (probe table)
- Create: `scripts/capture-agent-fixture.mjs`, `apps/web/test/fixtures/agent-run.json`
- Test: `apps/web/test/agentApi.test.ts`

**Interfaces:**
- Produces, in `metricPaths.ts`:
  - `agentSummaryPath(id: string): string` → `/v1/runs/{id}/agent`
  - `agentConnectionsPath(id: string, remote: string, window: Window | null = null): string` → `/v1/runs/{id}/agent/connections?remote=<enc>`, plus `rangeSuffix(window, '&')`. `remote` is omitted entirely when it is `'*'`.
  - `agentDnsPath(id: string, hostname: string, window: Window | null = null): string`, the same shape with `hostname`.
  - `agentInjectorsPath(id: string, window: Window | null = null): string`
  - `agentStatusPath(id: string, window: Window | null = null): string`
- Produces, in `api/agent.ts`, each with `staleTime: Infinity` and the window and filter in its key:
  - `agentSummaryQuery(id)`
  - `agentConnectionsQuery(id, remote, window)`
  - `agentDnsQuery(id, hostname, window)`
  - `agentInjectorsQuery(id, window)`
  - `agentStatusQuery(id, window)`
  - Each parses with its contract schema (`AgentSummaryResponseSchema`, …).
- Produces: `apps/web/test/fixtures/agent-run.json`, `{ _capture, summary, connections, connectionsByRemote: { [remote]: … }, dns, injectors, status }`, captured from a real API over the paired fixture `fixtures/gatling-3.15.1.2/agent-run/`.

- [ ] **Step 1: Write the failing tests.** In `agentApi.test.ts`: `agentConnectionsPath('r', '*')` has no `remote=`; `agentConnectionsPath('r', 'a/1.2.3.4:443')` contains `remote=a%2F1.2.3.4%3A443`; with a window, the query string joins `&from=…&to=…` once, with no second `?`; two `agentConnectionsQuery` keys that differ only in remote are not equal. Add the four windowed builders and `agentSummaryPath` to `metricPaths.test.ts`'s probe table. Its completeness case fails until they are probed.
- [ ] **Step 2: Run** `pnpm exec vitest run apps/web/test/agentApi.test.ts apps/web/test/metricPaths.test.ts`. Expected: FAIL, the builders are undefined.
- [ ] **Step 3: Implement the builders and factories.** Mirror `telemetryPath` / `telemetryQuery`. `remote` and `hostname` go through `encodeURIComponent`.
- [ ] **Step 4: Run the same command.** Expected: PASS.
- [ ] **Step 5: Write `scripts/capture-agent-fixture.mjs` and run it once.** Model it on `capture-chart-fixture.mjs`:
  - Seed an org, project and ingest token.
  - Post a bundle of `run-1/simulation.log` plus `run-1/perfportal-agent.ndjson` from the paired fixture with `waitMs: 0`.
  - Poll `GET /v1/runs/:id` until it is terminal. The worker must be running.
  - Fetch the five endpoints, plus `/agent/connections?remote=` for every remote in the summary, and write the JSON.
  - Run it against a scratch database and Redis index, never the developer database.
  - Check the captured `summary.header.collects` reads `{ http: true, machine: true }` and `summary.remotes.length >= 2`.
- [ ] **Step 6: Commit** `metricPaths.ts`, `agent.ts`, both tests, the script and the fixture.

### Task 2: Rate and gauge transforms (Connections, DNS, status)

**Files:**
- Create: `apps/web/src/charts/transforms/agentRates.ts`
- Test: `apps/web/test/transforms.agentRates.test.ts`

**Interfaces:**
- Consumes: the `AgentConnectionsResponse`, `AgentDnsResponse` and `AgentStatusResponse` types; the fixture from Task 1.
- Produces, each `(…, opts: { readonly windowSelected: boolean }) => ChartData` with pair-shaped series `[startOffsetMs, value | null]` and `columns[0] = 'Elapsed (s)'`:
  - `toConnectionRate(c)`: series `Opened`, `Closed`, per second.
  - `toTcpStates(c)`: one series per `TCP_STATE_NAMES` entry, labelled as GE spells it (`synSent` … `close`). A bucket with `states: null` is a `null` y. The zero-series ruling applies. The `limitation` also says GE's `bound` and `idle` have no kernel state and are not measured.
  - `toBandwidth(c)`: series `Sent`, `Received`, in Mbps, `bits / (width/1000) / 1e6`.
  - `toDnsRate(d)`: series `Requests`, `OK`, `KO`, per second.
  - `toStatusRate(s)`: one series per `s.codes` entry, in that order, per second. A code absent from a bucket's `counts` is `0`. The zero-series ruling applies.
  - Roles: Opened/Closed take none, because closing is not a failure, so green and red would misread. `DNS_RATE_ROLES = ['neutral', 'passed', 'failed']` is exported for `toDnsRate`'s Requests, OK and KO.
- Empty sentences: `available: true` with no buckets reads "No connections fall in the selected window." when `windowSelected`, else "No connections were recorded for this run." Use the same shape for DNS ("lookups") and status ("responses").

- [ ] **Step 1: Write the failing tests.** Compute every expectation from the fixture, never by hand:
  - The `Opened` sum × width/1000 over the drawn points equals `connections.sums.opened`.
  - `Sent` equals `bitsOut / (w/1000) / 1e6` for the first non-empty bucket.
  - A synthetic 2000 ms-wide payload with `opened: 10` draws `5`.
  - A bucket with `states: null` yields a `null` y on every state series.
  - On the fixture, a state with only zeros is absent from `series` and named in `limitation`, and its column is still in `columns`.
  - Empty, windowed and unwindowed sentences differ.
  - `toStatusRate` series names equal `status.codes`.
- [ ] **Step 2: Run** `pnpm exec vitest run apps/web/test/transforms.agentRates.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `agentRates.ts`. A shared private helper `perSecond(value, widthMs)` and a shared `dropAllZero(series)` that returns the kept series plus the names it dropped.
- [ ] **Step 4: Run the same command.** Expected: PASS.
- [ ] **Step 5: Commit.**

### Task 3: Duration transforms (TCP connect, TLS, DNS resolution)

**Files:**
- Create: `apps/web/src/charts/transforms/agentDurations.ts`
- Test: `apps/web/test/transforms.agentDurations.test.ts`

**Interfaces:**
- Consumes: `DurationSection`, `AGENT_PERCENTILE_ROWS`, `AgentPercentileRow`.
- Produces:
  - `AGENT_ROW_LABEL: Record<AgentPercentileRow, string>` (`Min`, `25%`, … `99.99%`, `Max`, `Mean`).
  - `DEFAULT_AGENT_ROWS: readonly AgentPercentileRow[]`: every row except `p25`, `p80`, `p85`, `p99_9`, `p99_99`.
  - `toDurationOverTime(section, { outcome: Outcome; rows: readonly AgentPercentileRow[]; windowSelected: boolean; noun: string }): ChartData`:
    - One series per selected row, in `AGENT_PERCENTILE_ROWS` order, named by `AGENT_ROW_LABEL`.
    - A `null` population in a bucket is a `null` y.
    - `columns` carries all 13 rows whatever is selected, as `toPercentiles` does.
  - `toDurationDistribution(section, { windowSelected; noun }): ChartData`:
    - Category axis labels `offsetMs + i * stepMs`.
    - Series `OK` and `KO` as counts. Both always present, even all-zero: zero here genuinely means zero, the `toDistribution` rule.
    - `limitation` carries the mean when `meanMs !== null` ("Mean 4.2 ms").
  - `toDurationPercentiles(section, outcome, { windowSelected; noun }): ChartData`: pair series `[p, ms]` from `section.percentiles[outcome]`, with one series named for the outcome.
  - `noun` is "TCP connects", "TLS handshakes" or "DNS lookups", used in the empty sentences.

- [ ] **Step 1: Write the failing tests** against the fixture's `connections.tcpConnect` and `dns.resolution`:
  - `DEFAULT_AGENT_ROWS` has 8 entries and lacks the five hidden rows.
  - `toDurationOverTime` with `outcome: 'ok'` and all 13 rows gives the `Max` series y at bucket 0 equal to `overTime[0].ok[11]`.
  - A bucket with `ok: null` gives `null` ys.
  - The distribution has `totals.ok` equal to the sum of the `OK` series, and the `KO` series is present when `totals.ko === 0`.
  - The percentile curve's first point is `[0, min]` and its last is `[100, max]`.
  - Empty sections give the window and run sentences.
- [ ] **Step 2: Run** `pnpm exec vitest run apps/web/test/transforms.agentDurations.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `agentDurations.ts`. Reuse `Outcome` from `transforms/percentiles.ts`.
- [ ] **Step 4: Run the same command.** Expected: PASS.
- [ ] **Step 5: Commit.**

### Task 4: Load generator transforms

**Files:**
- Create: `apps/web/src/charts/transforms/agentInjectors.ts`
- Test: `apps/web/test/transforms.agentInjectors.test.ts`

**Interfaces:**
- Consumes: `AgentInjectorsResponse`, `TCP_EVENT_NAMES`, `TCP_SEGMENT_NAMES`.
- Produces, each `(inj, opts: { windowSelected: boolean }) => ChartData`:
  - `toGcCounts(inj)` and `toGcTime(inj)`: one series per collector name, the union over buckets sorted. Per second. A collector absent from a bucket is `0`.
  - `toCpu(inj)`: `User`, `Sys`, as stored.
  - `toMemory(inj)`: the seven GE series in GE's order, in MB with `BYTES_PER_MB = 1024 * 1024` (the constant `transforms/telemetry.ts` uses). A series that is `null` in every bucket is omitted, and `limitation` names it. That is how RAM disappears on a machine-off run.
  - `toTcpEvents(inj)`: GE's five labels. The four counters per second, `established` as stored. The established-is-a-gauge `limitation`. A `null` field is a `null` y.
  - `toTcpSegments(inj)`: GE's four labels, per second.
  - The zero-series ruling applies to GC, events and segments.
- When `inj.machine.available` is false, `toCpu`, `toTcpEvents` and `toTcpSegments` return `empty: inj.machine.reason ?? 'The agent did not collect machine figures.'` and no series.

- [ ] **Step 1: Write the failing tests** against the fixture's `injectors`:
  - GC series names equal the sorted collector union.
  - The first bucket's `Heap used` equals `heapUsedBytes / 1048576`.
  - A copy with `machine: { available: false, reason: 'macOS' }` makes `toCpu(...).empty === 'macOS'`, and `toMemory` omits RAM total and RAM used and names them.
  - A synthetic bucket with `tcpEvents.established: 7` and width 2000 draws `7` (not `3.5`), while `activeOpenings: 10` draws `5`.
- [ ] **Step 2: Run** `pnpm exec vitest run apps/web/test/transforms.agentInjectors.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `agentInjectors.ts`.
- [ ] **Step 4: Run the same command.** Expected: PASS.
- [ ] **Step 5: Commit.**

### Task 5: Percentile colours and a generic bands menu

**Files:**
- Modify: `apps/web/src/charts/theme.ts` (`PercentileRole`, `ROLE_TOKEN`, `PERCENTILE_RAMP`, `RAMP`)
- Modify: `apps/web/src/styles/tokens.css` (both themes, wherever `--chart-pct-*` is declared)
- Modify: `apps/web/src/charts/BandsMenu.tsx`, `apps/web/src/charts/PercentilesChart.tsx`
- Test: `apps/web/test/palette.test.ts` (existing), `apps/web/test/BandsMenu.test.tsx` (existing)

**Interfaces:**
- Produces:
  - `PercentileRole` gains `'pct-p99_9' | 'pct-p99_99' | 'pct-mean'`.
  - `PERCENTILE_RAMP` becomes the 12 ordered rows from min to max, with `pct-p99_9` and `pct-p99_99` between `pct-p99` and `pct-max`. `pct-mean` is outside the ramp.
  - `BandsMenu<B extends string>({ id, bands: readonly B[], labels: Record<B, string>, selected: readonly B[], onToggle: (b: B) => void })`. Swatches stay `var(--chart-pct-${band})` and testids stay `band-${band}-${id}`.
- Judgment: choose `#rrggbb` values that pass `palette.test.ts`'s existing hue-rotation and pairwise-separation gates, and keep `pct-mean` at 3:1 or better against the card in both themes, using the test's own contrast helper. Read that file's ramp comments first.

- [ ] **Step 1: Write the failing tests.**
  - In `palette.test.ts`, the existing ramp case now covers the 12-step ramp from `PERCENTILE_RAMP`. Add one case: `pct-mean` is at least 3:1 against the card in light and dark.
  - In `BandsMenu.test.tsx`, add a case rendering it with three custom bands and labels, asserting three checkbox items named by those labels.
- [ ] **Step 2: Run** `pnpm exec vitest run apps/web/test/palette.test.ts apps/web/test/BandsMenu.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement** the tokens, roles and generic menu. `PercentilesChart` passes `bands={BANDS} labels={BAND_LABEL}`.
- [ ] **Step 4: Run** the same command, plus `pnpm exec vitest run apps/web/test/PercentilesChart.identity.test.tsx apps/web/test/transforms.percentiles.test.ts`. Expected: PASS, and the response-time percentile chart is unchanged.
- [ ] **Step 5: Commit.**

### Task 6: Shared section plumbing and the Connections section

**Files:**
- Create: `apps/web/src/routes/report/useReportFilter.ts`
- Create: `apps/web/src/routes/report/AgentUnavailable.tsx`
- Create: `apps/web/src/charts/AgentDurationCharts.tsx`
- Create: `apps/web/src/routes/report/ConnectionsSection.tsx`
- Test: `apps/web/test/ConnectionsSection.test.tsx`, `apps/web/test/useReportFilter.test.tsx`

**Interfaces:**
- Produces:
  - `useReportFilter(param: 'remote' | 'hostname', known: readonly string[] | undefined): readonly [value: string, set: (v: string) => void]`. Returns `'*'` when the parameter is absent or not in `known`. `set('*')` deletes the parameter. It writes with `replace: true` and keeps every other parameter.
  - `AgentUnavailable({ reason, detail, subject }: { reason: AgentUnavailableReason; detail: string | null; subject: string })`: one `EmptyState`. Copy:
    - `not_collected`: "No agent data for this run". Body: the on-prem runner's Gatling agent collects {subject} for runs it starts; this run carries no agent file.
    - `unreadable`: "This run's agent file could not be read", with `detail` in the body.
    - `http_not_collected`: "The agent did not collect HTTP figures", with `detail`.
  - `AgentDurationCharts({ idPrefix, titles: { overTime, distribution, percentiles }, section, noun, domainMs, windowSelected })`: three `Chart`s.
    - The over-time chart has a `BandsMenu` over `AGENT_PERCENTILE_ROWS` (default `DEFAULT_AGENT_ROWS`), a `Segmented` outcome control and roles `pct-${row}`.
    - The percentiles-distribution chart has its own outcome control.
    - Chart ids: `${idPrefix}-percentiles`, `${idPrefix}-distribution`, `${idPrefix}-percentiles-distribution`.
  - `ConnectionsSection({ runId })`:
    - Reads `agentSummaryQuery`. When `reason === 'not_collected'`, it renders `<RunTelemetry only={CONNECTION_CHARTS} action="Open the connection charts" />`.
    - When `available` is false otherwise, it renders `AgentUnavailable`.
    - Otherwise: a labelled "Remote" `<select>` (`All remotes` = `*`, then `summary.remotes`), then the nine charts. Ids are `agent-connection-rate`, `agent-tcp-states`, `agent-tcp-connect-*`, `agent-tls-*`, `agent-bandwidth`.
    - Not terminal: one `LiveNotice kind="withheld"` per chart title.
    - Compact: `DesktopOnly` with `action="Open the connection charts"`.

- [ ] **Step 1: Write the failing tests** with mocked fetches from the Task 1 fixture:
  - Nine figures render, with the titles from Global Constraints.
  - Choosing the second remote puts `remote=<it>` in the location and requests `agentConnectionsPath(id, it)`.
  - A URL with `?remote=nope` requests the `*` path and the select reads "All remotes" (Review Focus 1).
  - `reason: 'not_collected'` renders RunTelemetry's empty state and no agent chart.
  - `reason: 'http_not_collected'` with `detail: 'gatling-http 3.14 not supported'` shows that detail (Review Focus 5).
  - Not terminal renders nine withheld notices and fires no `/agent/connections`.
  - In `useReportFilter.test.tsx`: setting a value keeps `from`/`to`, and `set('*')` deletes the parameter.
- [ ] **Step 2: Run** `pnpm exec vitest run apps/web/test/ConnectionsSection.test.tsx apps/web/test/useReportFilter.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement** the four files. Follow `RunTelemetry`'s `enabled: … && terminal` rule: a live run never asks.
- [ ] **Step 4: Run the same command.** Expected: PASS.
- [ ] **Step 5: Commit.**

### Task 7: DNS and Load generators sections

**Files:**
- Create: `apps/web/src/routes/report/DnsSection.tsx`, `apps/web/src/routes/report/LoadGeneratorsSection.tsx`
- Test: `apps/web/test/DnsSection.test.tsx`, `apps/web/test/LoadGeneratorsSection.test.tsx`

**Interfaces:**
- Consumes: Task 6's `useReportFilter`, `AgentUnavailable` and `AgentDurationCharts`; Tasks 2 and 4's transforms.
- Produces:
  - `DnsSection({ runId })`:
    - A "Hostname" select ("All hostnames" = `*`), "DNS Resolution per Second", and `AgentDurationCharts` with GE's three DNS titles.
    - `not_collected` renders `AgentUnavailable` (no telemetry fallback).
    - Chart ids: `agent-dns-rate`, `agent-dns-*`.
  - `LoadGeneratorsSection({ runId })`:
    - `not_collected` renders `<RunTelemetry only={LOAD_GENERATOR_CHARTS} action="Open the load-generator charts" />`.
    - Otherwise: a read-only "Load generator" field showing `injector.host ?? 'Unknown host'`, the shared-machine sentence when `sharedWithPerfPortal`, and the six charts.
    - Chart ids: `agent-gc-count`, `agent-gc-time`, `agent-cpu`, `agent-memory`, `agent-tcp-events`, `agent-tcp-segments`.
    - When `http_not_collected`, it still draws, because injectors are available.

- [ ] **Step 1: Write the failing tests:**
  - DNS renders four figures. Choosing the hostname writes `hostname=`. `not_collected` shows "No agent data for this run".
  - Load generators shows `loadgen-1`, the fixture's host, in the field.
  - `sharedWithPerfPortal: true` renders the sentence containing "shared".
  - A machine-off injectors payload shows the reason on CPU and both TCP charts while GC and Memory draw (Review Focus 2).
  - `not_collected` renders RunTelemetry.
- [ ] **Step 2: Run** `pnpm exec vitest run apps/web/test/DnsSection.test.tsx apps/web/test/LoadGeneratorsSection.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement** both sections.
- [ ] **Step 4: Run the same command.** Expected: PASS.
- [ ] **Step 5: Commit.**

### Task 8: Wire the Report, add Responses by Status, correct the record

**Files:**
- Modify: `apps/web/src/routes/RunReport.tsx` (sections, the status chart, the DNS and "not drawn" comments)
- Create: `apps/web/src/charts/ResponsesByStatusChart.tsx`
- Modify: `apps/web/src/routes/RunTelemetry.tsx` (empty-state body names both sources)
- Modify: `apps/web/test/RunReport.test.tsx`, `apps/web/e2e/run-charts.spec.ts:277` and `apps/web/e2e/run-summary-report.spec.ts:110` (the section lists gain DNS)
- Modify: `CLAUDE.md` (the "OMITTED" bullet near line 5054 gets a bracketed correction; new floors in the PR 3 entry, written in Task 9)

**Interfaces:**
- Produces:
  - `ResponsesByStatusChart({ runId, domainMs, windowSelected })`: reads `agentStatusQuery`, chart id `agent-status`.
    - `available: false` renders an `Undrawn` slot whose reason follows `AgentUnavailable`'s wording. On `not_collected` it says "This run carries no HTTP status codes: it has no agent file."
  - The RunReport section order is Requests, Groups, Virtual users, Connections, DNS (`id="dns"`), Load generators. Requests draws `ResponsesByStatusChart` after Errors per second while terminal, and a withheld notice while live.

- [ ] **Step 1: Write the failing tests.**
  - `RunReport.test.tsx`: the section headings equal the six above, in order.
  - Requests renders "Responses per Second by Status" for a run with the agent fixture, and its not-collected sentence without one.
  - Update the two e2e section lists to include `['dns', 'DNS', false]` / `'DNS'`.
- [ ] **Step 2: Run** `pnpm exec vitest run apps/web/test/RunReport.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Replace the RunReport sentence saying "Responses per Second by Status" is not drawn.
  - Replace the docstring saying "DNS is left out for now".
  - RunTelemetry's empty body adds that the on-prem runner's Gatling agent records these figures for runs it starts.
- [ ] **Step 4: Run** `pnpm exec vitest run apps/web/test` (the jsdom and node projects for web). Expected: PASS, with zero `Errors` lines.
- [ ] **Step 5: Commit.**

### Task 9: Browser proof, gates and the CLAUDE.md entry

**Files:**
- Modify: `apps/web/e2e/fixtures.ts`: add `seedRunWithAgent(orgId): Promise<string>`, which ingests a bundle of the paired fixture's `simulation.log` plus `perfportal-agent.ndjson` through `ingestAndProcess`'s path. Generalise `loadBundle` to take the file set, keeping its cache per set.
- Create: `apps/web/e2e/agent-report.spec.ts`
- Modify: `CLAUDE.md` (the PR 3 entry: floors, what was run, rulings)

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Write the e2e cases.** Each chart counts as drawn through `plot(figure)` having one SVG with a `path`:
  1. Report → open Connections. All nine `agent-*` figures draw. Choosing a remote updates the URL (`remote=`) and the Connection Open and Close Rate data table's total changes. Reload keeps the remote.
  2. Open DNS: four figures draw, and the Hostname select lists `summary.hostnames` plus All.
  3. Open Load generators: the field reads `loadgen-1`, six figures draw, and Memory's legend lists Heap used.
  4. Requests shows "Responses per Second by Status" with one legend entry per code, `200` and `404` in the fixture.
  5. A run with no agent file (`seedRunWithData`): DNS shows "No agent data for this run", and Connections shows RunTelemetry's "No generator telemetry recorded".
  6. A stale `?remote=nope` link opens Connections drawn for all remotes (Review Focus 1).
- [ ] **Step 2: Run** `PERFPORTAL_E2E_PORT=3797 pnpm test:e2e --workers=2 apps/web/e2e/agent-report.spec.ts` against a scratch database. Expected: 6 passed.
- [ ] **Step 3: Predict the new floors** from per-file case counts (unit: the new test files plus the added cases; integration: the new `.ts` test files only; e2e: 207 + 6). Then run the full gate in order. Each total must equal its prediction.
- [ ] **Step 4: The real run.**
  - Start the API, worker and runner from `dist` on a scratch database, Redis index and bucket, with `RUNNER_AGENT_JAR` set to the built jar.
  - Run `ParitySimulation` through the on-prem runner and open the Report in a browser.
  - Check every chart and filter against spec §2's checklist.
  - Record the result in the CLAUDE.md entry, and stop the processes by PID.
- [ ] **Step 5: Write the CLAUDE.md entry** in this file's established shape: floors, what was run with exit codes, rulings, and what is known and left. Add the bracketed correction to the OMITTED bullet. Commit.
