# GE Report Parity, PR 2: agent figures — processing, storage, API and verifier — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A run that carries a Gatling agent file (`perfportal-agent/1`) has every figure GE's Connections, DNS, Load generators and "Responses per Second by Status" charts need computed at finalize, stored per bucket, served by five read endpoints, and re-checked by the verifier against the raw file.

**Architecture:** A pure decoder (`@perfportal/plugin-gatling`) turns the NDJSON file into typed records. A pure builder (`@perfportal/statistics`) folds them onto the run's OWN series width into duration buckets (exact 1 ms histograms, OK/KO) and counter/gauge buckets, keyed by remote or hostname with a stored `*` total. The pipeline does this inside the run's existing finalize transaction; two new partitioned, FK-free tables and one per-run summary table hold the result. `/v1/runs/:id/agent*` endpoints read them, windowed like `/telemetry`. `packages/verify` recomputes every stored figure from the raw file with code that shares nothing with the builder.

**Tech Stack:** TypeScript (plugin-gatling, statistics, persistence, contracts, worker, API, verify), Prisma migration (raw SQL partitions), Java 11 for one agent header field.

**Spec:** `docs/superpowers/specs/2026-10-22-ge-report-parity-design.md` (§2, §5, §7.3 third bullet, §7.4, §8, §9.2). PR 1's plan: `docs/superpowers/plans/2026-10-23-ge-report-parity-pr1-agent-and-runner.md`. GE's JSON: `docs/superpowers/research/2026-10-22-ge-report-captures/`.

**PR boundaries (spec §10, the builder's call):** PR 2 is this plan (backend, testable through its API). PR 3 is the Report sections (§7.5). PR 4 is the Gradle-plugin path (§7.2/§7.3). PR 5 is the side-by-side proof (§9.3). Branch: `feat/ge-report-figures`, cut from `main` at `6a56c8e4`.

## Global Constraints

- **The agent file format is PR 1's, shipped.** Lines (`at` epoch ms, `us` µs): `header`; `dns {at,us,host,ok[,warmup]}`; `connect {at,us,remote,ok,ch[,warmup]}`; `tls {at,us,remote,ok[,ch][,warmup]}`; `close {at,ch,remote}`; `status {at,req,code}`; `s {at,gc:{name:[count,timeMs]},heap:[used,committed,max],netty:[direct,heap]|null,cpu?:[8 jiffies],mem?:[totalKb,availableKb],tcp?:{<snmp Tcp field>:n},bytes:{remote:[out,in]},states:{remote:{"<kernel state code>":n}}[,final:true]}`; `error {at,where,message}`; `capped {at}`. `ch` is a JSON number. Counters in `s` are CUMULATIVE; gauges are as read. The authoritative text is `Collector`'s and `Sampler`'s class Javadoc in `clients/gatling-agent`.
- **Time origin:** an offset is `at − runStartedAtMs` (the engine's `EngineResult.runStartedAtMs`, from the `simulation.log` header). A record is used when `0 ≤ offset ≤ durationMs` (`EngineResult.durationMs`); a sample before 0 is used ONLY as the predecessor a delta is taken from.
- **Bucket width is the run's own:** the run-scope `response_time` series' `bucketWidthMs` from `EngineResult.series` (1000 when the run has none). Bucket start = `floor(offset / width) * width`. No independent coalescing.
- **Warm-up is excluded from every figure.** A `connect` with `warmup:true` makes its `ch` a warm-up channel; that channel's `tls` and `close` are dropped. A remote with no non-warm-up channel is dropped from `bytes`, `states` and the remotes list. A `dns` with `warmup:true` is dropped.
- **Durations:** ms = `Math.max(0, Math.round(us / 1000))` — the rule `Histogram.accept` applies to `us / 1000`. Families: `dns_resolution` (dimension = hostname), `tcp_connect` and `tls_handshake` (dimension = remote). `ok:false` goes to the KO histogram.
- **Dimension `*` is the all-remotes / all-hostnames total**, stored as its own rows (spec §7.4: "available without summing on read"). A remote or hostname is never `*`.
- **Counters sum within a bucket; gauges take the MAX of the samples in the bucket.** For a `*` gauge, sum across dimensions per sample first, then take the max.
- **A counter delta** is `current − previous` where previous is the most recent EARLIER sample carrying that field (a remote first seen has previous 0 for `bytes`); a negative delta is 0.
- **Metric names and labels** (stored `metric`, `label`): `conn.opened`, `conn.closed` (label `''`); `bw.bits` (labels `out`, `in`; bytes × 8); `tcp.state` gauge (labels `synSent`, `established`, `finWait1`, `finWait2`, `closeWait`, `closing`, `lastAck`, `timeWait`, `close` from kernel codes 2, 1, 4, 5, 8, 11, 9, 6, 7 — codes 3, 10, 12 and anything else are not stored; GE's `bound` and `idle` have no kernel state and are never stored); `dns.count` (labels `req`, `ok`, `ko`); `status` (label = the HTTP code); `gc.count`, `gc.timeMs` (label = collector name); `heap` gauge (labels `used`, `committed`, `max`); `netty` gauge (labels `direct`, `heap`); `cpu.jiffies` (labels `user` = Δ(user+nice), `sys` = Δ(system+irq+softirq), `total` = Δ sum of all 8); `ram` gauge (labels `total` = totalKb×1024, `used` = (totalKb−availableKb)×1024); `tcp.evt` (labels `activeOpenings` = ΔActiveOpens, `failedAttempts` = ΔAttemptFails, `receivedResets` = ΔEstabResets, `sentResets` = ΔOutRsts); `tcp.established` gauge (label `''`, from `CurrEstab` — GE's "established" sums to 471 over a 91 s run with 480 connects, so it is the gauge, not an event); `tcp.seg` (labels `received` = ΔInSegs, `sent` = ΔOutSegs, `retransmitted` = ΔRetransSegs, `receivedBad` = ΔInErrs). `conn.*`, `bw.bits`, `tcp.state` carry the remote dimension; `dns.count` the hostname; the rest `*` only.
- **GE's 13 percentile rows** (spec §6), in this order: Min, 25, 50, 75, 80, 85, 90, 95, 99, 99.9, 99.99, Max, Mean. Percentiles are nearest rank (`nearestRankIndex`); Min/Max are the histogram's extremes; Mean is `sum / count`.
- **An agent figure never fails a run.** A missing, unreadable, checksum-mismatched or undecodable agent file leaves the run's own ingest exactly as it is today, and records why on `run_agent`.
- New tables carry `org_id` with NO foreign key, are partitioned by `run_started_on` monthly with partitions through `2027-12` (the `20260925120000_partitions_2027` horizon), are bound with `partitionDay`, and join `infra/clean-test-residue.sql`.
- Node 22 for every gate (`nvm use` in every bash call). Read each gate's own exit code, never a pipeline's. Merge with `--merge`.

## Review Focus

1. **A truncated last line** (a SIGKILLed JVM) — the run completes and every whole line counts; the fragment is counted in `malformedLines`, never fatal. Test in Task 2.
2. **An agent object whose bytes do not match `agent_log_sha256`, or that has vanished** — the run still completes with its `simulation.log` figures; `run_agent.status = 'unreadable'` with the reason; no agent rows. Test in Task 5.
3. **A coalesced run (width 2000 or 4000)** — counters sum and gauges max across the seconds folded into one bucket; the API reports the width so a per-second rate is `value / (width/1000)`. Test in Task 3 (builder) and Task 6 (endpoint).
4. **A window over a quiet stretch of a run that WAS collected** — `available: true` with no buckets, never `available: false`. Test in Task 6.
5. **A `?remote=` value containing `/` and `:`, URL-encoded, and one the run never saw** — the first narrows, the second is 400 `UNKNOWN_REMOTE` naming `GET /v1/runs/{id}/agent`. Test in Task 6.

---

### Task 1: Agent header names its host; the paired real fixture

**Files:**
- Modify: `clients/gatling-agent/src/main/java/io/perfportal/agent/AgentMain.java` (`header`), its Javadoc and `EventWriterTest`/header test
- Create: `fixtures/gatling-3.15.1.2/agent-run/simulation.log`, `fixtures/gatling-3.15.1.2/agent-run/agent.ndjson`, `fixtures/gatling-3.15.1.2/agent-run/README.md`
- Modify: `fixtures/gatling-3.15.1.2/README.md` (one line naming the new directory)

**Interfaces:**
- Produces: header field `"host":<string>|null` — `InetAddress.getLocalHost().getHostName()`, null on any exception. Additive: format stays `perfportal-agent/1`.
- Produces: a real paired fixture — one Gatling 3.15.1 run's `simulation.log` and the agent file of the SAME JVM, recorded on Linux (so machine figures are present), with at least one failed connect or DNS lookup if the harness's target allows it.

- [ ] **Step 1: Write the failing test** — in the header test, `assertTrue(header.contains("\"host\":"))` and that the header still parses as one JSON object.
- [ ] **Step 2: Run** `cd clients/gatling-agent && ./gradlew test --no-daemon` → FAIL on the new assertion.
- [ ] **Step 3: Add the field** after `"os"`, quoted via `EventWriter.quote`, `null` unquoted when unknown. Update the header line in `Collector`/`AgentMain` Javadoc.
- [ ] **Step 4: Run** the same command → PASS (62+1 tests).
- [ ] **Step 5: Record the fixture.** Run `GatlingRunE2ETest`'s real-Gatling case inside `eclipse-temurin:21-jdk` (as the PR 1 fix wave did), with the test's temp directory kept (a `-DkeepDir=<path>` system property read by the test, or a one-off copy step), and copy the run's `simulation.log` and agent file into `fixtures/gatling-3.15.1.2/agent-run/`. The README states: Gatling version, the simulation, Linux/JDK, the date, the request count, and that the two files are from ONE JVM so their clocks agree. Check the agent file's header reads `"machine":true`.
- [ ] **Step 6: Commit** `git add clients/gatling-agent fixtures/gatling-3.15.1.2 && git commit -m "Agent: name the host in the header; record a paired agent fixture"`.

### Task 2: Decode the agent file

**Files:**
- Create: `packages/plugin-gatling/src/agent-file.ts`
- Modify: `packages/plugin-gatling/src/index.ts` (export), `packages/core/src/index.ts` (+ new `packages/core/src/agent.ts`)
- Test: `packages/plugin-gatling/test/agent-file.test.ts`

**Interfaces:**
- Produces in `@perfportal/core` (`agent.ts`): `export const AGENT_FILE_FORMAT = 'perfportal-agent/1'`; `export const AGENT_BUNDLE_FILE = 'perfportal-agent.ndjson'` (the name an uploaded bundle carries the file under, beside `simulation.log`).
- Produces in `@perfportal/plugin-gatling`:
  ```ts
  export interface AgentHeader { format: string; agentVersion: string; gatlingHttpClient: string | null; gatlingHttp: string | null; java: string; os: string; host: string | null; startedAt: number; collects: { http: boolean; machine: boolean }; reasons: { http?: string; machine?: string } }
  export interface AgentDns { at: number; us: number; host: string; ok: boolean; warmup: boolean }
  export interface AgentConnect { at: number; us: number; remote: string; ok: boolean; ch: number; warmup: boolean }
  export interface AgentTls { at: number; us: number; remote: string; ok: boolean; ch: number | null; warmup: boolean }
  export interface AgentClose { at: number; ch: number; remote: string }
  export interface AgentStatus { at: number; req: string; code: number }
  export interface AgentSample { at: number; final: boolean; gc: Record<string, [number, number]>; heap: [number, number, number]; netty: [number, number] | null; cpu: number[] | null; mem: [number, number] | null; tcp: Record<string, number> | null; bytes: Record<string, [number, number]>; states: Record<string, Record<string, number>> }
  export interface AgentFile { header: AgentHeader; dns: AgentDns[]; connects: AgentConnect[]; tls: AgentTls[]; closes: AgentClose[]; statuses: AgentStatus[]; samples: AgentSample[]; error: { at: number; where: string; message: string } | null; capped: boolean; malformedLines: number }
  export class AgentFileError extends Error {}
  export function decodeAgentFile(bytes: Uint8Array): AgentFile
  ```
- Rules: line 1 must be a `header` whose `format` equals `AGENT_FILE_FORMAT`, else `AgentFileError`. Any later line that is not valid JSON, or lacks a field its type requires, increments `malformedLines` and is skipped. An unknown `t` is skipped silently (forward compatibility, not counted). Records keep file order.

- [ ] **Step 1: Write the failing tests:**
  - `decodes the paired real fixture` — `fixtures/gatling-3.15.1.2/agent-run/agent.ndjson`: `header.format === 'perfportal-agent/1'`, `header.collects.machine === true`, `statuses.length` equals the fixture README's request count, every `connects[i].ch` is a number, `malformedLines === 0`, `samples.at(-1)!.final === true`.
  - `skips a truncated last line and counts it` — the fixture's bytes minus its last 10 bytes → `malformedLines === 1`, everything before decoded.
  - `refuses a file without a header` and `refuses another format` → `AgentFileError`.
  - `skips an unknown record type without counting it` — append `{"t":"future","at":1}` → `malformedLines === 0`.
  - `reads tls without ch as null`, `reads a capped line`, `reads the error line`.
- [ ] **Step 2: Run** `pnpm vitest run packages/plugin-gatling/test/agent-file.test.ts` → FAIL (module missing).
- [ ] **Step 3: Implement** with `TextDecoder('utf-8', { fatal: false })`, split on `\n`, `JSON.parse` per line in a try. No dependency.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `git commit -m "Decode the Gatling agent's NDJSON file"` (naming the four paths).

### Task 3: Build agent figures

**Files:**
- Create: `packages/statistics/src/agent.ts`
- Modify: `packages/statistics/src/index.ts`
- Test: `packages/statistics/test/agent.test.ts`

**Interfaces:**
- Consumes: `AgentFile` (Task 2), `Histogram`.
- Produces:
  ```ts
  export type AgentDurationFamily = 'dns_resolution' | 'tcp_connect' | 'tls_handshake';
  export interface AgentDurationBucket { family: AgentDurationFamily; dim: string; startOffsetMs: number; okCount: number; koCount: number; histogramOk: Histogram; histogramKo: Histogram }
  export interface AgentMetricBucket { metric: string; dim: string; label: string; startOffsetMs: number; value: number }
  export interface AgentFigures { bucketWidthMs: number; durations: AgentDurationBucket[]; metrics: AgentMetricBucket[]; remotes: string[]; hostnames: string[] }
  export function buildAgentFigures(file: AgentFile, opts: { runStartMs: number; durationMs: number; bucketWidthMs: number }): AgentFigures
  export function runSeriesWidthMs(result: EngineResult): number   // the run-scope response_time series' width, 1000 when absent
  export const AGENT_GAUGE_METRICS: readonly string[]   // ['tcp.state','heap','netty','ram','tcp.established']
  ```
  `remotes`/`hostnames` are sorted, warm-up-only ones excluded. Every rule is in Global Constraints; this task implements them and no others.

- [ ] **Step 1: Write the failing tests** (hand-built `AgentFile`s, `runStartMs = 1_000_000`, width 1000 unless stated):
  - `files a connect's duration under its remote and under *` — one ok connect `us: 1499` at offset 2300 → `tcp_connect` buckets at 2000 for the remote and `*`, ok histogram holds `1`; a `us: 1500` one holds `2`.
  - `drops warm-up channels everywhere` — a warm-up connect `ch: 1` to `gatling.io/1.2.3.4:443`, its close, and samples with bytes/states for that remote → no rows mention it and `remotes` excludes it.
  - `drops records before the run and after its duration` (offset −1 and `durationMs + 1`).
  - `differences cumulative counters against the previous sample, the first in-run sample against a pre-run one` — samples at offsets −500, 400, 1400 with `gc.G1 [1,5] → [3,9] → [4,10]` → `gc.count` label `G1`: bucket 0 value 2, bucket 1000 value 1; `gc.timeMs` 4 and 1.
  - `sums counters and maxes gauges in a coalesced bucket` — width 2000, two samples in bucket 0 with heap used 10 then 7 and bytes deltas 100, 50 → `heap/used = 10`, `bw.bits/out = 1200`.
  - `sums a * gauge across remotes before taking the max` — two remotes, states `{"6":2}` and `{"6":3}` in one sample, `{"6":4}`,`{"6":0}` absent in the next → `tcp.state/*/timeWait = 5`.
  - `maps kernel state codes to GE's names and drops the rest` — codes `"1"`,`"6"`,`"10"` → `established`, `timeWait`, nothing for 10.
  - `treats a negative delta as 0`.
  - `computes cpu jiffies, ram bytes and the snmp counters` — two samples with known arrays → `cpu.jiffies` user/sys/total, `ram` total/used, `tcp.evt`, `tcp.seg`, `tcp.established` per the constraint's mapping.
  - `counts statuses by code` and `counts dns req/ok/ko by hostname and *`.
  - `matches the paired real fixture` — with the fixture's `simulation.log` run through `runEngineAsync` for `runStartMs`, `durationMs` and the width: the `status` sum equals the run's request count, `conn.opened/*` sum equals the non-warm-up ok connect count, `conn.closed/*` sum equals the non-warm-up close count, and the `tcp_connect/*` OK histogram total equals `conn.opened/*`.
- [ ] **Step 2: Run** `pnpm vitest run packages/statistics/test/agent.test.ts` → FAIL.
- [ ] **Step 3: Implement** `buildAgentFigures` and `runSeriesWidthMs`. Keep the metric-name strings in one exported table (`AGENT_METRICS`), not inline literals, so Task 7's verifier test can assert the two sides name the same set.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `git commit -m "Build agent figures on the run's own series width"`.

### Task 4: Tables, writer and reader

**Files:**
- Create: `packages/persistence/prisma/migrations/20261024120000_run_agent_figures/migration.sql`
- Modify: `packages/persistence/prisma/schema.prisma` (three models)
- Create: `packages/persistence/src/metrics/agent-write.ts`, `packages/persistence/src/metrics/agent-read.ts`
- Modify: `packages/persistence/src/index.ts`, `infra/clean-test-residue.sql`
- Test: `packages/persistence/test/agent-figures.integration.test.ts`

**Interfaces:**
- Produces tables:
  - `run_agent` — `run_id uuid PK REFERENCES run(id) ON DELETE CASCADE`, `org_id uuid`, `project_id uuid`, `status text CHECK (status IN ('collected','unreadable'))`, `reason text NULL` (why unreadable), `header jsonb NULL`, `capped boolean NOT NULL DEFAULT false`, `agent_error jsonb NULL`, `malformed_lines int NOT NULL DEFAULT 0`, `bucket_width_ms int NULL`, `remotes text[] NOT NULL DEFAULT '{}'`, `hostnames text[] NOT NULL DEFAULT '{}'`, `processed_at timestamptz NOT NULL DEFAULT now()`. (Cascades from `run`, so it is NOT FK-free.)
  - `run_agent_duration_bucket` — `run_started_on date`, `run_id uuid`, `org_id uuid`, `project_id uuid`, `family text`, `dim text`, `start_offset_ms int`, `ok_count int`, `ko_count int`, `histogram_ok bytea`, `histogram_ko bytea`; PK `(run_started_on, run_id, family, dim, start_offset_ms)`; `PARTITION BY RANGE (run_started_on)`, monthly partitions `run_agent_duration_bucket_YYYY_MM` from `2026_01` to `2027_12`.
  - `run_agent_metric_bucket` — `run_started_on date`, `run_id`, `org_id`, `project_id`, `metric text`, `dim text`, `label text`, `start_offset_ms int`, `value double precision`; PK `(run_started_on, run_id, metric, dim, label, start_offset_ms)`; same partitioning.
- Produces:
  ```ts
  export interface AgentSummaryRow { status: 'collected' | 'unreadable'; reason: string | null; header: AgentHeader | null; capped: boolean; agentError: { at: number; where: string; message: string } | null; malformedLines: number; bucketWidthMs: number | null; remotes: string[]; hostnames: string[] }
  export class AgentMetricWriter {
    persist(client: pg.PoolClient, ctx: MetricContext, figures: AgentFigures, file: AgentFile): Promise<void>   // run_agent 'collected' + both bucket tables
    persistUnreadable(client: pg.PoolClient, ctx: MetricContext, reason: string): Promise<void>
  }
  export interface StoredAgentDurationBucket { family: AgentDurationFamily; dim: string; startOffsetMs: number; okCount: number; koCount: number; histogramOk: Histogram; histogramKo: Histogram }
  export class AgentReader {
    constructor(pool: pg.Pool)
    summary(scope: ProjectScope, runId: string): Promise<AgentSummaryRow | null>
    durations(scope: ProjectScope, runId: string, startedOn: Date, q: { families: AgentDurationFamily[]; dim: string }): Promise<StoredAgentDurationBucket[]>
    metrics(scope: ProjectScope, runId: string, startedOn: Date, q: { metrics: string[]; dim: string }): Promise<AgentMetricBucket[]>
  }
  ```
  `ProjectScope`/`MetricContext` are the existing types. Histograms are stored with `serialize()` and read with `Histogram.deserialize`. Every query binds the day with `partitionDay` and filters `org_id` and `project_id`.

- [ ] **Step 1: Write the failing integration tests:** writes figures from Task 3's fixture then reads them back equal (histogram totals, every metric row); `summary` returns `null` for a run with no row; `persistUnreadable` writes `status 'unreadable'` with the reason and no bucket rows; a row for org A is invisible to org B's scope; deleting the run row removes `run_agent` (cascade) and leaves the bucket rows (FK-free, by design).
- [ ] **Step 2: Run** `pnpm vitest run --config vitest.integration.config.ts packages/persistence/test/agent-figures.integration.test.ts` → FAIL.
- [ ] **Step 3: Write the migration** (copy `20260925120000_partitions_2027`'s partition shape) and the Prisma models (`@@map`, `@@id`, no relation on the two bucket models; `RunAgent` has the relation to `Run` with `onDelete: Cascade`). `prisma generate`, then `infra/test/schema-matches-migrations.sh` must exit 0. Add both bucket tables to `infra/clean-test-residue.sql` beside `run_user_bucket`, deleted by the captured residue org ids.
- [ ] **Step 4: Implement** writer (batched INSERT like `MetricWriter`) and reader.
- [ ] **Step 5: Run** the test → PASS; `pnpm vitest run --config vitest.integration.config.ts packages/persistence/test/partition-runway.integration.test.ts` → PASS (the new parents carry the horizon).
- [ ] **Step 6: Run CI's residue checks locally** — `infra/test/fk-free-tables.sql` must now list the two bucket tables and the residue assertion must pass (the `test-residue` job's commands, in its order).
- [ ] **Step 7: Commit** `git commit -m "Store agent figures in two partitioned bucket tables and a per-run summary"`.

### Task 5: Process the agent file at finalize

**Files:**
- Create: `apps/worker/src/pipeline/agent-source.ts`
- Modify: `apps/worker/src/pipeline/pipeline.service.ts` (`#ingest`)
- Test: `apps/worker/test/agent-source.test.ts`, `apps/worker/test/agent-pipeline.integration.test.ts`

**Interfaces:**
- Consumes: `decodeAgentFile`, `buildAgentFigures`, `runSeriesWidthMs`, `AgentMetricWriter`, `AGENT_BUNDLE_FILE`.
- Produces:
  ```ts
  export type AgentSource = { kind: 'none' } | { kind: 'bytes'; bytes: Uint8Array } | { kind: 'unreadable'; reason: string };
  export async function openAgentSource(run: Pick<RunRecord, 'agentLogKey' | 'agentLogSha256' | 'rawLogDeletedAt'>, deps: { blobs: BlobStore }, bundle: BundleSource): Promise<AgentSource>
  ```
  Order: `agentLogKey` set and `rawLogDeletedAt` null → read the object; sha256 must equal `agentLogSha256` else `unreadable 'checksum_mismatch'`; a missing object → `unreadable 'missing'`; a transport error is RETHROWN (transient, the run retries). Else a bundle entry whose basename is `AGENT_BUNDLE_FILE` in the same directory as the log the plugin selected → its bytes. Else `none`. Used by the verifier too (Task 7).
- In `#ingest`: after `runEngineAsync`, `openAgentSource`; `bytes` → `decodeAgentFile` (an `AgentFileError` becomes `unreadable 'undecodable: <message>'`) → `buildAgentFigures(file, { runStartMs: result.runStartedAtMs, durationMs: result.durationMs, bucketWidthMs: runSeriesWidthMs(result) })`; a null `runStartedAtMs` → `unreadable 'no run start'`. Inside the existing transaction, after `MetricWriter.persist`: `persist` or `persistUnreadable`; `none` writes nothing. Nothing on this path can make the run fail.

- [ ] **Step 1: Write the failing tests.** Unit (`agent-source.test.ts`, a fake `BlobStore`): key present → bytes; sha mismatch → `unreadable 'checksum_mismatch'`; object missing → `unreadable 'missing'`; transport error → rethrown; `rawLogDeletedAt` set → falls to the bundle; bundle entry beside `simulation.log` → bytes; an entry of that name in ANOTHER directory → `none`. Integration (`agent-pipeline.integration.test.ts`, real Postgres/MinIO, the paired fixture): a run whose `agent_log_*` point at the stored fixture object completes with `run_agent.status 'collected'`, its `status` metric sum equal to the run's request count; the same run with a wrong `agent_log_sha256` completes `complete` with `run_agent.status 'unreadable'` and zero bucket rows; an uploaded `.tgz` holding `simulation.log` and `perfportal-agent.ndjson` side by side completes `collected`; a run with neither completes with no `run_agent` row.
- [ ] **Step 2: Run** both → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** both → PASS, and `pnpm vitest run --config vitest.integration.config.ts apps/worker/test/pipeline.integration.test.ts` still passes.
- [ ] **Step 5: Commit** `git commit -m "Process the agent file at finalize, never failing the run over it"`.

### Task 6: Contracts and the five read endpoints

**Files:**
- Create: `packages/contracts/src/agent.ts`, `packages/statistics/src/agent-read.ts`, `apps/api/src/metrics/agent.controller.ts`
- Modify: `packages/contracts/src/index.ts`, `packages/statistics/src/index.ts`, `apps/api/src/metrics/metrics.module.ts`, `apps/api/src/openapi/document.ts` (+ the schema registry), `apps/api/test/access-routes.integration.test.ts` (`ACCESS_BY_ROUTE`), `apps/api/test/session-auth.integration.test.ts` (cross-org list)
- Test: `packages/statistics/test/agent-read.test.ts`, `packages/contracts/test/agent.test.ts`, `apps/api/test/agent.integration.test.ts`

**Interfaces:**
- Produces in `@perfportal/contracts`:
  - `AGENT_PERCENTILE_ROWS = ['min','p25','p50','p75','p80','p85','p90','p95','p99','p99_9','p99_99','max','mean'] as const`
  - `AgentUnavailableReason = 'not_collected' | 'unreadable' | 'http_not_collected' | 'machine_not_collected'`
  - `DurationSection = { overTime: { startOffsetMs: number; ok: number[] | null; ko: number[] | null; all: number[] | null }[]; distribution: { offsetMs: number; stepMs: number; ok: number[]; ko: number[]; meanMs: number | null }; percentiles: { ok: [number, number][]; ko: [number, number][]; all: [number, number][]; meanMs: { ok: number | null; ko: number | null; all: number | null } }; totals: { ok: number; ko: number } }` — each `overTime` array follows `AGENT_PERCENTILE_ROWS`; null when that population is empty in the bucket.
  - `GET /v1/runs/{id}/agent` → `AgentSummaryResponse { runId; available: boolean; reason: AgentUnavailableReason | null; detail: string | null; header: {agentVersion; gatlingHttpClient; gatlingHttp; java; os; host; collects; reasons} | null; capped; agentError; malformedLines; bucketWidthMs: number | null; remotes: string[]; hostnames: string[]; injector: { host: string | null; sharedWithPerfPortal: boolean } }` — `sharedWithPerfPortal` is true when the run came from the on-prem runner (`run.runnerJobId` resolves, `lifecycleOf`'s field).
  - `GET /v1/runs/{id}/agent/connections?remote=&from=&to=` → `{ runId; available; reason; bucketWidthMs; window; remote: string; buckets: { startOffsetMs; opened; closed; bitsOut; bitsIn; states: Record<TcpStateName, number> }[]; tcpConnect: DurationSection; tlsHandshake: DurationSection; sums: { opened; closed; bitsOut; bitsIn } }`
  - `GET /v1/runs/{id}/agent/dns?hostname=&from=&to=` → `{ runId; available; reason; bucketWidthMs; window; hostname; buckets: { startOffsetMs; requests; ok; ko }[]; resolution: DurationSection; sums: { requests; ok; ko } }`
  - `GET /v1/runs/{id}/agent/injectors?from=&to=` → `{ runId; available; reason; bucketWidthMs; window; machine: { available: boolean; reason: string | null }; buckets: { startOffsetMs; gcCount: Record<string, number>; gcTimeMs: Record<string, number>; cpuUserPct: number | null; cpuSysPct: number | null; ramTotalBytes; ramUsedBytes; heapMaxBytes; heapCommittedBytes; heapUsedBytes; nettyDirectBytes; nettyHeapBytes; tcpEvents: Record<'activeOpenings'|'failedAttempts'|'established'|'receivedResets'|'sentResets', number> | null; tcpSegments: Record<'received'|'sent'|'retransmitted'|'receivedBad', number> | null }[] }` — byte gauges are `number | null`; CPU % is `100 × Δuser / Δtotal` rounded to 2 dp, null when Δtotal is 0 or absent.
  - `GET /v1/runs/{id}/agent/status?from=&to=` → `{ runId; available; reason; bucketWidthMs; window; codes: string[]; buckets: { startOffsetMs; counts: Record<string, number> }[] }`
- Produces in `@perfportal/statistics` (`agent-read.ts`): `durationSection(buckets: { okCount; koCount; histogramOk: Histogram; histogramKo: Histogram; startOffsetMs }[]): DurationSection` — distribution via `distribution(okMerged, koMerged)` mapped to `{offsetMs: labels[0] ?? 0, stepMs, ok, ko, meanMs}`; percentile curve at p = 0, 2.5, 5, …, 97.5, 99, 99.9, 99.99, 100 (nearest rank; 0 and 100 are min and max).
- Endpoint rules: `@Requires('project:read')`, `@Scopes('read')`, `uuidParam('id')`, `singleValue` on every query param, `resolveRange`/`inRange`/`snapWindow` exactly as `/telemetry`. `available:false` with `reason 'not_collected'` when there is no `run_agent` row, `'unreadable'` (detail = stored reason) for that status, `'http_not_collected'` (detail = `header.reasons.http`) on connections/dns/status when `header.collects.http` is false. `available` is decided BEFORE the window filter. An unknown `remote`/`hostname` → 400 `UNKNOWN_REMOTE` / `UNKNOWN_HOSTNAME` with remediation `List the run's remotes and hostnames with GET /v1/runs/{id}/agent.`; absent → `*`.

- [ ] **Step 1: Write the failing tests.** `agent-read.test.ts`: the 13 rows of a known histogram (values 1..100 → p25 25, p99_99 100, mean 50.5); empty population → null; percentile curve endpoints equal min/max. `contracts/agent.test.ts`: each response schema parses a valid body and rejects a missing `bucketWidthMs`. `agent.integration.test.ts` (seed through Task 5's pipeline with the paired fixture): `/agent` lists remotes and hostnames and `available: true`; `/agent/connections` sums equal the stored `*` rows and `?remote=<encodeURIComponent(remote)>` narrows `opened`; unknown remote → 400 `UNKNOWN_REMOTE`; `?from&to` over a quiet stretch → `available: true`, `buckets: []`; a run with no agent file → every endpoint `available: false, reason 'not_collected'`; another org's run → 404; `/agent/status` code counts sum to the run's request count; `/agent/injectors` on the Linux fixture has non-null `cpuUserPct` on a bucket; a width-2000 run (`maxBucketsRun` small) reports `bucketWidthMs: 2000`.
- [ ] **Step 2: Run** them → FAIL.
- [ ] **Step 3: Implement** contracts, `agent-read.ts`, the controller (one `@Controller('/v1/runs/:id')` class, so the derived session-auth and route-coverage guards collect it), the OpenAPI operations (each with 200/400/401/403/404, `BadRequest` for the 400), five `ACCESS_BY_ROUTE` rows (`'GET /v1/runs/:id/agent': 'project:read'`, …), and the cross-org cases.
- [ ] **Step 4: Run** the three files plus `openapi.integration.test.ts`, `access-routes.integration.test.ts`, `session-auth.integration.test.ts` → PASS.
- [ ] **Step 5: Commit** `git commit -m "Serve agent figures: summary, connections, DNS, load generators, status"`.

### Task 7: The verifier re-checks every agent figure

**Files:**
- Create: `packages/verify/src/agent.ts`
- Modify: `packages/verify/src/figures.ts` (`VERIFIER_VERSION = 3`, table names), `packages/verify/src/compare.ts` (two comparators), `packages/verify/src/index.ts`, `packages/contracts/src/run.ts` (`FigureMismatch.table` enum), `packages/persistence/src/metrics/stored-figures.ts` (`readStoredAgentFigures`), `apps/worker/src/verify/verify.service.ts`
- Test: `packages/verify/test/agent.test.ts`, `apps/worker/test/agent-metric-names.test.ts`, `apps/worker/test/verify-agent.integration.test.ts`

**Interfaces:**
- Consumes: `AgentFile` (decoder is shared, as `simulation.log`'s is), `openAgentSource` (Task 5).
- Produces:
  ```ts
  export interface ExpectedAgentDuration { family: string; dim: string; startOffsetMs: number; okCount: number; koCount: number; ok: AgentPopulationFigures | null; ko: AgentPopulationFigures | null }
  export interface AgentPopulationFigures { count: number; min: number; max: number; sum: number; percentiles: number[] }   // the 10 GE percentiles, in AGENT_PERCENTILE_ROWS order
  export interface ExpectedAgent { durations: ExpectedAgentDuration[]; metrics: { metric: string; dim: string; label: string; startOffsetMs: number; value: number }[] }
  export function expectedAgent(file: AgentFile, opts: { runStartMs: number; durationMs: number; bucketWidthMs: number }): ExpectedAgent
  ```
  `readStoredAgentFigures(pool, runId, startedOn)` returns the same shapes from the stored rows (histograms decoded in persistence, which may import statistics). Tables: `'run_agent_duration_bucket' | 'run_agent_metric_bucket'`; comparisons are EXACT for every figure (counts, extremes, percentiles, sums of integers, metric values — all integers). `VERIFIER_VERSION` 3: stored runs are re-checked; those without a `run_agent` row verify on `simulation.log` alone, unchanged.
- In `verify.service.ts`, after the `simulation.log` comparison and inside the same lock: a `run_agent` row with status `collected` → `openAgentSource`; `bytes` → decode → `expectedAgent` with `optionsFrom`'s run start, `run.durationMs` and the stored `bucket_width_ms` → compare into the SAME ledger; `unreadable`/`none` for a collected run → `unverifiable('raw_log_missing')`. A run whose `run_agent` is `unreadable` is verified on `simulation.log` alone.
- **Independence:** `packages/verify/src/agent.ts` implements every Global-Constraints rule itself — no import from `@perfportal/statistics` (the lint rule and `independence.test.ts` enforce it). `eslint.config.js` bars `@perfportal/statistics` from verify's TESTS too, so the check that both sides name the same metrics lives in `apps/worker/test/agent-metric-names.test.ts` (the worker may import both): the set of `metric/label` pairs `expectedAgent` produces on the paired fixture equals the set `buildAgentFigures` produces.

- [ ] **Step 1: Write the failing tests.** `verify/test/agent.test.ts`: `expectedAgent` on hand-built files reproduces each Task 3 rule (warm-up, offsets, deltas, coalesced sum/max, `*` gauge, kernel-code mapping, ms rounding at 1499/1500 µs). `verify-agent.integration.test.ts` (Task 5's seeding): a collected run verifies `verified` with `figuresChecked` greater than the same run without agent rows; corrupting ONE stored `run_agent_metric_bucket.value` → `mismatch` naming that table, metric and bucket; corrupting one stored histogram → a mismatch on that bucket's count or percentile; deleting the agent object (raw log kept) → `unverifiable raw_log_missing`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** Red-verify each comparator by breaking one rule in `packages/statistics/src/agent.ts` (e.g. drop the warm-up exclusion) and seeing the integration case report `mismatch`, then restore.
- [ ] **Step 4: Run** the two files plus `packages/verify/test/independence.test.ts` and `pnpm lint` → PASS.
- [ ] **Step 5: Commit** `git commit -m "Verify agent figures against the raw agent file (verifier v3)"`.

### Task 8: A real run, the gates, and the record

**Files:**
- Modify: `CLAUDE.md` (new top entry in Verification and the floors), `DEPLOYMENT.md` (the "Gatling agent" section: where the figures appear, `VERIFIER_VERSION` 3 re-checks), `apps/web/src/routes/RunReport.tsx` comment and `CLAUDE.md`'s "OMITTED" sentence ONLY if their claim is now false for the API (the charts themselves are PR 3 — say so rather than claiming them).

- [ ] **Step 1: Real run.** Scratch database, Redis index and bucket; this branch's API, worker and runner from `dist`; Java 21; `RUNNER_AGENT_JAR` set; queue `ParitySimulation` through the on-prem runner (memory `verify-with-real-gatling-runs`). Record: `/agent` lists the remotes and hostnames; `/agent/status` counts sum to the run's request count (895); `/agent/connections` `sums.opened` equals the agent file's non-warm-up ok connects; `/agent/injectors` buckets cover the run; the run verifies `verified` with `figuresChecked` higher than a `agentEnabled: false` run of the same simulation, which reports `/agent` `available: false, reason 'not_collected'`.
- [ ] **Step 2: Gates,** each total predicted first, each exit code read from a file: `pnpm build`, `typecheck` (every `.tsbuildinfo` deleted), `lint`, `test:unit`, `test:integration` (scratch database, Redis db flushed), `test:e2e --workers=2`; `cd clients/gatling-agent && ./gradlew build --no-daemon`; `infra/test/schema-matches-migrations.sh`; the `test-residue` job's steps.
- [ ] **Step 3: Write the CLAUDE.md entry** (what was built, the rulings in Global Constraints that were decisions, red-verify results, the real run's figures, new floors) and commit `git commit -m "CLAUDE.md: record PR 2 of GE report parity and its floors"`.
