# Exact statistics, PR 4: show where Gatling's report differs — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** For every verified run, PerfPortal computes what Gatling's own report would say for each percentile. Where that differs from the exact value, the run's verification panel shows the difference, as a range when Gatling's method itself varies.

**Architecture:**
- **The Java tool.** A ~100-line tool, `tools/gatling-method`, replays response times into t-digest 3.3's `AVLTreeDigest(100)` exactly as Gatling's `GeneralStatsBuffer` does. It runs N seeded replays and prints each percentile's lowest and highest value.
- **The pure TypeScript half** lives in `packages/verify`. It builds the tool's input from the decoded events and turns the tool's output plus the exact values into difference rows.
- **The worker** runs the tool inside the verify job when the jar and t-digest are present, and stores the rows in `run_verification.gatling_differences`.
- **Delivery.** The API serves the rows, and the verification panel draws them. CI proves the tool against three real Gatling reports, inside the production image.

**Tech Stack:** Java 21 (javac at build time only; the runtime image has a JRE), t-digest 3.3 (already in the Gatling runtime at `$RUNNER_GATLING_HOME/lib/t-digest-3.3.jar`), TypeScript, Node 22, PostgreSQL, NestJS, React, Vitest, Playwright, Docker.

**Spec:** `docs/superpowers/specs/2026-10-15-exact-statistics-design.md` — §1, §3 (`gatling_differences`), §6 "Gatling's method", §7 (panel table), §8, §9 row 4. PRs 1–3 (#277, #278, #279) are merged.

## Spec amendments (measured 2026-10-21; Task 1 writes them into the spec)

1. **Gatling's report is not deterministic.** `AVLTreeDigest` breaks ties between equidistant centroids with an UNSEEDED `java.util.Random` (`gen.nextDouble()` in `add`). Two reports of one log can therefore differ.
   - Replaying the reference fixture 200 times with seeds 0..199, all-requests p99 took 7 values between 2349 and 2412. The report printed 2369.
   - On the 2026-10-15 BasicSimulation run, Session p95 ranged 2389–3410 and p99 10785–13295.
   - **Every one** of the 40 + 44 percentile cells of the two reports lies inside the replay's set.

   So the CI rule becomes: each report value is one the method produces across 200 seeds, and it is EQUAL to it wherever all 200 seeds agree. `gatling_differences` stores `gatlingLow` / `gatlingHigh`, not one value.
2. **Group percentiles use the cumulated response time.** This is measured: every group cell of both reports lies inside the cumulated replay, and outside the duration replay for Catalog and Cart.
3. **The assertion corpus is replaced in CI by the `group-assertions` run.** The corpus has no Gatling output committed. `group-assertions/gatling-report-assertions.txt` records `Search: 95th percentile … actual : 1853.0`.
4. **The method's population is every request record, warm-up included, at Gatling's default percentiles 50, 75, 95 and 99.** Gatling knows no warm-up, and the run's own `gatling.conf` is not recorded. The exact value a difference compares against is computed over the same population.

## Global Constraints

- The tool depends only on `com.tdunning:t-digest:3.3`. Per stats key, it adds every value in log order as `digest.add((double) v)` to `new AVLTreeDigest(100.0)`, with `gen` replaced by `new java.util.Random(seed)` through reflection. A percentile p is `Math.round(digest.quantile(p / 100.0))`.
- **Stats keys, in log order:**
  - every request record feeds `run` (all requests) and `request <groups…/name>`, each in population `all` and in its own status population (`ok` or `ko`);
  - every group record feeds `group <groups path>` with `cumulatedResponseTimeMs`, in `all` and its status.
  - Value = `endMs − startMs` for a request; `cumulatedResponseTimeMs` for a group.
- Request and group names use the stored identity: path segments joined with `/`, unspaced, which is how `run_stat.name` is written.
- **Tool I/O:**
  - stdin: lines of `<key>\t<integer ms>`;
  - args: `--seeds <N> --percentiles 50,75,95,99`;
  - stdout: one JSON line per key, in first-seen order: `{"key":"…","n":<count>,"p":{"50":[low,high],"75":[…],"95":[…],"99":[…]}}`;
  - seeds are `0..N−1`, so the output is reproducible.
- **Production seed count:** `GATLING_METHOD_SEEDS`, default 16. CI uses 200.
- **Differences:** one row per (scope, name, population, percentile) where `gatlingLow !== exact || gatlingHigh !== exact`. `exact` is the nearest-rank value (`nearestRankIndex`) over the same values.
- **Availability:**
  - `gatling_replays` (a new nullable integer column) is null when the method did not run and the seed count when it did;
  - `gatling_differences` stays `[]` when nothing differs, or the method did not run;
  - a tool failure never changes the verification status.
- `VERIFIER_VERSION` goes to 2, so the verify scan re-checks runs whose raw log still exists and fills their differences.
- **UI copy** (spec §7, amended for variance):
  - table header: "Differences from Gatling's report";
  - columns: Request · Figure · Gatling's report · PerfPortal;
  - a range renders `2,389–3,410`;
  - one ⓘ: "Gatling's report estimates percentiles with t-digest, and its estimate can change between two reports of the same run; PerfPortal reports the actual value at that rank."
  - The table is drawn only when the list is non-empty.
- **Repo rules:**
  - Node 22 via nvm; read each command's own exit code;
  - scratch database and Redis index for integration and e2e, never `perfportal`;
  - `git commit -F -`, name paths, never `git add -A`;
  - no backticks in SQL comments; no `prisma format`;
  - rebuild a workspace package (delete `.tsbuildinfo`, `tsc -b --force`, grep dist) before integration tests that import it;
  - contract fields `.optional()` for rolling deploys;
  - `packages/verify` stays pure: no `node:child_process` or `node:fs`, and no import of `@perfportal/statistics` or `@perfportal/persistence`.

## Review Focus

1. **The jar or t-digest is missing,** for example a developer machine without the image. Verification still ends verified or mismatch, `gatling_replays` is null, the panel draws no table, and one warn line is logged at worker start. *Pinned in Task 4.*
2. **The tool hangs, crashes, or prints malformed JSON.** A timeout (`GATLING_METHOD_TIMEOUT_MS`, default 300000) kills it, the verification is recorded without differences, and nothing is retried for ever. *Pinned in Task 4.*
3. **A run with warm-up configured.** Differences compare like for like: the exact value comes from every record, not from the warm-up-excluded `run_stat`. *Pinned in Task 2.*
4. **A KO-only request,** where every response failed. The `all` and `ko` populations get rows, `ok` gets none, and nothing is "n=0". *Pinned in Task 2.*
5. **A run with tens of thousands of distinct keys,** where the endpoint cap allows many requests. The input streams through stdin rather than one argv or one buffered string, and memory stays bounded. *Pinned in Task 4 (a 5,000-key case) and measured in Task 6.*

---

### Task 1: The Gatling-method tool, proven against three real reports

**Files:**
- Create: `tools/gatling-method/src/io/perfportal/gatlingmethod/GatlingMethod.java`, `tools/gatling-method/build.sh` (javac `--release 21` against the t-digest jar, then `jar` → `tools/gatling-method/build/gatling-method.jar`), `tools/gatling-method/README.md` (the I/O contract above).
- Create: `fixtures/gatling-3.15.1.2/basic-simulation-2026-10-15/`. Copy `simulation.log`, `index.html` and every `req_*.html` / `group_*.html` from `~/Downloads/gatling-gradle-plugin-demo-kotlin-main/build/reports/gatling/basicsimulation-20261015162147567/`; leave out `js/` and `style/`. Add a README row in `fixtures/gatling-3.15.1.2/README.md`.
- Create: `infra/test/gatling-method-fixtures.mjs`.
- Modify: `infra/Dockerfile`. Add a builder stage with `openjdk-21-jdk-headless` that compiles the tool, and copy the jar to `/opt/perfportal/gatling-method.jar`.
- Modify: `.github/workflows/ci.yml` (`compose` job). Add one step running the fixture check inside `perfportal:ci`, with `fixtures/` and `infra/test/` mounted read-only.
- Modify: the spec, writing the four amendments above into §3, §6, §7 and §8.

**Interfaces:**
- Produces: the jar at `/opt/perfportal/gatling-method.jar` in the image; main class `io.perfportal.gatlingmethod.GatlingMethod`; the I/O contract in Global Constraints.
- Produces, for Task 2: the fixture check's HTML parser. `parseReportPercentiles(html)` returns `{ name, percentiles: { total:[p50,p75,p95,p99], ok?: [...], ko?: [...] } }[]`.

- [ ] **Step 1: Write the fixture check first.** `infra/test/gatling-method-fixtures.mjs` takes `--jar`, `--tdigest` and `--fixtures` paths. For each of `reference-report`, `basic-simulation-2026-10-15` and `group-assertions`:
  - decode `simulation.log` with `packages/plugin-gatling/dist/src/records.js`;
  - write the key/value lines;
  - run the tool with `--seeds 200`.
  - For the two HTML fixtures, parse every row of `index.html` (total) and the OK/KO columns of each `req_*` / `group_*` page.
  - Assert every report cell ∈ [low, high], and `=== low` wherever `low === high`.
  - For `group-assertions`, assert 1853 ∈ the `request Search` all p95 range.
  - Exit 1 and name each failing cell. Exit 0 printing the cell count, which must be > 150.
- [ ] **Step 2: Run it before the tool exists** and see it fail (`jar not found`).
- [ ] **Step 3: Implement `GatlingMethod.java`** to the contract. Read stdin with a `BufferedReader` and keep `LinkedHashMap<String, int[]-backed list>`. Compute the seeds per key one digest at a time, so memory is the values, not N digests.
- [ ] **Step 4: Run** `bash tools/gatling-method/build.sh` (exit 0), then the fixture check against `~/.perfportal/gatling-home/lib/t-digest-3.3.jar`. Expected: exit 0, more than 150 cells, 0 failing.
- [ ] **Step 5: Red-verify** with three mutations, each failing the check:
  - compression 50 instead of 100;
  - `Math.floor` instead of `Math.round`;
  - groups fed their duration instead of their cumulated time.

  Restore each mutation afterwards.
- [ ] **Step 6: Wire the Dockerfile and the CI step.** `docker build -t perfportal:ci -f infra/Dockerfile .` then the CI step's command must exit 0 locally.
- [ ] **Step 7: Write the spec amendments.** Commit "Add the Gatling-method tool and prove it against three Gatling reports".

### Task 2: Pure input and difference builders in `packages/verify`

**Files:**
- Create: `packages/verify/src/gatling-method.ts`; export from `packages/verify/src/index.ts`.
- Test: `packages/verify/test/gatling-method.test.ts`.

**Interfaces:**
- Consumes: `CanonicalEvent` (`@perfportal/core`); `nearestRankIndex` (`./rank.js`).
- Produces:
  - `GATLING_PERCENTILES = [50, 75, 95, 99] as const`;
  - `type GatlingKey = { scope: 'run' | 'request' | 'group'; name: string; population: 'all' | 'ok' | 'ko' }`;
  - `gatlingMethodInput(events: Iterable<CanonicalEvent>): { keys: Map<string, GatlingKey>; lines: string[]; exact: Map<string, Record<string, number>> }`. The opaque key string is `${scope}\u0000${name}\u0000${population}`, and `exact` holds nearest-rank values at `GATLING_PERCENTILES` over the same values;
  - `type GatlingMethodOutput = { key: string; n: number; p: Record<string, [number, number]> }`;
  - `gatlingDifferences(input, output: GatlingMethodOutput[]): GatlingDifference[]`;
  - `type GatlingDifference = { scope; name; population; figure: 'p50' | 'p75' | 'p95' | 'p99'; gatlingLow: number; gatlingHigh: number; exact: number }`, sorted by scope (run, request, group), then name, population (all, ok, ko) and figure.
- `gatlingDifferences` THROWS on an output key the input never produced, and on a missing key. A tool answering for keys it was not asked about is a defect, never a silent drop.

- [ ] **Step 1: Write the failing tests:**
  - `'every request feeds run, its request key, all and its status, in log order'`: two OK requests and one KO request give exactly these keys — run/all, run/ok, run/ko, request X/all, request X/ok, request X/ko — and the line order follows the log;
  - `'a group feeds its cumulated time, never its duration'`;
  - `'warm-up is included'`: an event at 0 ms with engine warm-up 5000 is still a line, and the input takes no engine options at all;
  - `'a KO-only request has no ok key'`;
  - `'exact uses nearest rank over the same values'`: values 1..100 give p95 = 95 and p99 = 99;
  - `'a difference row only where low or high differs from exact'`: `[95,95]` with exact 95 gives no row; `[94,96]` gives one; `[96,96]` gives one;
  - `'throws on an unknown output key'`;
  - `'throws on a key the tool left out'`;
  - `'names are the stored identity'`: groups `['Cart']` plus name `Add To Cart` give `Cart/Add To Cart`.
- [ ] **Step 2: Run** `pnpm vitest run packages/verify/test/gatling-method.test.ts`. Expected: FAIL, the module is missing.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the test (PASS) and `packages/verify/test/independence.test.ts` (PASS).** The independence test proves no forbidden import crept in.
- [ ] **Step 5: Commit.**

### Task 3: Store and serve the differences

**Files:**
- Create: migration `packages/persistence/prisma/migrations/20261021120000_gatling_replays/migration.sql`, `ALTER TABLE run_verification ADD COLUMN gatling_replays integer`; update `schema.prisma` to match (`gatlingReplays Int? @map("gatling_replays")`).
- Modify: `packages/persistence/src/repositories/verification.ts`:
  - `record()` takes `gatlingDifferences: unknown[]` and `gatlingReplays: number | null`;
  - every reset path (`markPending`, `markUnverifiable`, `markRawLogDeleted`) also nulls `gatling_replays`;
  - the reader returns `gatlingReplays`.
- Modify: `packages/contracts/src/run.ts`:
  - `GatlingDifferenceSchema` with the shape from Task 2 (`gatlingLow <= gatlingHigh` refined);
  - `VerificationSchema` gains `gatlingDifferences: z.array(GatlingDifferenceSchema).optional()` and `gatlingReplays: z.number().int().positive().nullable().optional()`.
- Modify: `apps/api/src/runs/run-verification.controller.ts` (pass both fields through the contract parse); the OpenAPI document and its schema registry.
- Test:
  - `packages/persistence/test/verification.integration.test.ts`: record and read-back, and each reset path nulls the column;
  - `packages/contracts/test` (an absent field parses; low > high is refused);
  - `apps/api/test/read.integration.test.ts` (the endpoint returns the rows and `gatlingReplays`);
  - `apps/api/test/openapi.integration.test.ts` (the schema is in the document).

**Interfaces:**
- Produces: `GatlingDifference` (contracts, the same shape as Task 2); `VerificationRepository.record(runId, { …, gatlingDifferences, gatlingReplays })`.

- [ ] **Step 1: Write the failing tests above.**
- [ ] **Step 2: Run** them under `vitest.integration.config.ts` on the scratch stores. Expected: FAIL.
- [ ] **Step 3: Implement.** Add the migration, then `prisma migrate deploy` on the scratch DB; then the repository, contract and controller.
- [ ] **Step 4: Rebuild** persistence and contracts (grep dist for `gatling_replays` and `GatlingDifferenceSchema`), run the tests (PASS), then run `bash infra/test/schema-matches-migrations.sh`, which must exit 0.
- [ ] **Step 5: Commit.**

### Task 4: Run the method inside the verify job

**Files:**
- Create: `apps/worker/src/verify/gatling-method-runner.ts`.
- Modify: `apps/worker/src/config.ts`:
  - `gatlingMethodJar` from `GATLING_METHOD_JAR`, default `/opt/perfportal/gatling-method.jar`;
  - `gatlingMethodTdigestJar` from `GATLING_METHOD_TDIGEST_JAR`, default `${RUNNER_GATLING_HOME || '/opt/gatling'}/lib/t-digest-3.3.jar`;
  - `gatlingMethodSeeds` from `GATLING_METHOD_SEEDS`, default 16; an integer from 1 to 200, else the default;
  - `gatlingMethodTimeoutMs` from `GATLING_METHOD_TIMEOUT_MS`, default 300000, through `scanIntervalOr`'s at-least-1000 rule.
- Modify: `apps/worker/src/verify/verify.service.ts`. After `compare`, call the runner when available and pass its result to `record()`.
- Modify: `packages/verify/src/figures.ts` (`VERIFIER_VERSION = 2`) and `apps/worker/src/main.ts` (one startup line saying whether the method is available, and why not).
- Modify: `infra/docker-compose.yml`, `infra/.env.example` and `DEPLOYMENT.md`, giving the four variables. `node infra/test/env-example-covers-compose.mjs` must exit 0.
- Test:
  - `apps/worker/test/gatling-method-runner.test.ts`, with the command injected and a stub node script standing in for java;
  - `apps/worker/test/config.test.ts`;
  - `apps/worker/test/verify.integration.test.ts`.

**Interfaces:**
- Consumes: `gatlingMethodInput` and `gatlingDifferences` (Task 2); `record()` (Task 3).
- Produces:
  - `type GatlingMethodRunner = (lines: string[], seeds: number) => Promise<GatlingMethodOutput[]>`;
  - `createGatlingMethodRunner(config, spawnImpl = spawn): GatlingMethodRunner | null`. It returns null when either jar file is missing. It streams `lines` to stdin, rejects on a non-zero exit, a timeout (and kills the child), or a line that is not valid JSON;
  - `VerifyService` takes an optional `GatlingMethodRunner | null`.

- [ ] **Step 1: Write the failing runner tests.** Each uses a stub script that echoes a fixed answer:
  - `'streams every line to the tool and parses its JSON lines'` (5,000 keys);
  - `'rejects on a non-zero exit'`;
  - `'kills and rejects on timeout'` (a stub that sleeps, a 1000 ms timeout);
  - `'rejects on a malformed line'`;
  - `'null when the jar is missing'`.
- [ ] **Step 2: Write the failing verify cases:**
  - `'records the method\'s differences and the seed count'`: an injected runner returns a difference for run/all p99, and the row reads that difference and `gatlingReplays` 16;
  - `'a runner that throws leaves the status verified, gatlingReplays null, and logs one warn'`;
  - `'no runner: gatlingReplays null, differences []'`;
  - `'a mismatch run still gets its differences'`.
- [ ] **Step 3: Run.** Expected: FAIL.
- [ ] **Step 4: Implement.** `verify.service.ts` builds the input from the SAME `events` array the verifier decoded, never a second decode.
- [ ] **Step 5: Run** the touched unit and integration files (PASS), on a scratch DB and Redis index flushed first.
- [ ] **Step 6: Red-verify:**
  - runner errors propagated, so the verified case fails;
  - the timeout never armed, so the timeout case fails;
  - `VERIFIER_VERSION` left at 1, so a persistence `candidatePage` case selecting v1 rows fails. Add that case if none exists.
- [ ] **Step 7: Commit.**

### Task 5: The panel table

**Files:**
- Modify: `apps/web/src/routes/VerificationPanel.tsx`. Add a "Differences from Gatling's report" section with an `InfoTip` and the copy above, drawn only when non-empty. Each row:
  - Request: the scope's label, using the run page's request/group naming, and "All requests" for run;
  - Figure: `p95` plus `(OK)` or `(KO)` when the population is not all;
  - Gatling's report: one value, or a range;
  - PerfPortal: `exact`.

  Key the rows by content, not index, as PR 3's mismatch list does.
- Modify: `apps/web/src/routes/RunGlossary.tsx`, the estimate entry: a percentile can differ from Gatling's report because Gatling's estimate varies, and the panel lists where.
- Test: `apps/web/test/VerificationPanel.test.tsx` (or the existing panel cases in `VerificationMark.test.tsx`) and `RunGlossary.test.tsx`.
- E2E: `apps/web/e2e/run-verification.spec.ts`, or the existing verification spec. Seed a verified row with one difference by SQL in the fixture, open the mark, and assert the table header and the range text. A second case: an empty list draws no table.

- [ ] **Step 1: Write the failing unit tests:**
  - `'draws the table when there are differences'`;
  - `'no table when the list is empty or absent'`;
  - `'a range renders low–high with grouping'` (`2,389–3,410`);
  - `'a single value renders once'`;
  - `'OK/KO population is named'`;
  - `'the ⓘ carries the copy'`;
  - the glossary words guard stays green.
- [ ] **Step 2: Run** (FAIL), **implement, then run** (PASS) plus the e2e spec at `--workers=2`.
- [ ] **Step 3: Red-verify.** Make the table always drawn, which must fail the empty case. Make the range print only low, which must fail the range case. Then commit.

### Task 6: Gates, a real run, docs, PR

- [ ] **Step 1:** Predict the floors: unit from per-file deltas, integration from `vitest list --config vitest.integration.config.ts`, e2e from `--list`.
- [ ] **Step 2:** Run every gate on Node 22 and the scratch stores, each read by its own exit code: build, typecheck after deleting `.tsbuildinfo`, lint, unit, integration, then e2e.
- [ ] **Step 3: Real run.** Build the image, then start the stack with the worker, either from the image or locally with the two jar variables pointing at `tools/gatling-method/build/` and the local t-digest jar, against a SCRATCH database. Run one real Gatling run through the plugin and one through the on-prem runner. Each ends `verified` with `gatlingReplays` 16, and the differences shown in the panel are checked by hand against a run of the fixture script on that run's log.
- [ ] **Step 4: Measure** the method's wall time and peak memory on a soak-shaped log (≥ 1M requests, synthetic is fine) at 16 seeds, and record them.
- [ ] **Step 5: Docs.**
  - `DEPLOYMENT.md`: the four variables, and what a missing jar means.
  - `CLAUDE.md`: a PR 4 entry covering the non-determinism finding with its numbers, the tool, CI, the measured cost and the floors.
- [ ] **Step 6:** Commit; the controller pushes and opens the PR after the whole-branch review.

---

## Self-review notes

- Spec §6 "Gatling's method": Task 1 builds the tool and runs the CI comparison (amended for variance). Task 4 stores the results in `gatling_differences`.
- Spec §7 panel table and ⓘ: Task 5, with the copy amended. The API (§7) is extended in Task 3. The glossary (§7 "removed copy") is Task 5.
- Spec §8 "Gatling-method tool equals Gatling's HTML report on the three fixtures": Task 1, with the corpus replaced by group-assertions (amendment 3). §8 "Browser: … Gatling difference rows": Task 5. Real runs: Task 6.
- Deviations, each argued above: low/high instead of one value (amendment 1); group-assertions instead of the corpus (amendment 3); population and percentile set (amendment 4); the `gatling_replays` column is new and the spec's §3 table gains it.
