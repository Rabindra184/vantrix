# Exact statistics, PR 5: retire the DDSketch — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Drop `run_stat.sketch` and `run_stat.sketch_kind`, delete the `Sketch` class and `@datadog/sketches-js`, and leave the remaining estimated runs readable from their frozen percentiles.

**Architecture:** PR 1 stopped writing sketches and PR 2 recomputed every run whose raw log existed. A sketch now serves only a run that is still `estimated`, that is, retired with a `recompute_error` or not yet recomputed. Its single use is answering a percentile set the project changed after that run was ingested.
- After this PR, such a run answers from its frozen `percentiles` column, clamped against its own `min_ms`/`max_ms`. A rank it never stored is omitted. Its ≈ marks stay.
- Nothing else moves. Exact rows were never read through a sketch, and series buckets never had one.

**Tech Stack:** TypeScript, Node 22, PostgreSQL (Prisma migrations, raw `pg`), NestJS, Vitest, pnpm.

**Spec:** `docs/superpowers/specs/2026-10-15-exact-statistics-design.md`, D7 ("The DDSketch is retired") and §9 row 5 ("Drop sketch columns"). PRs 1–4 (#277–#280) are merged.

## Global Constraints

- **Migration** `packages/persistence/prisma/migrations/20261022120000_drop_run_stat_sketch/migration.sql`: `ALTER TABLE run_stat DROP COLUMN sketch, DROP COLUMN sketch_kind;`. `schema.prisma` drops the two fields, and `bash infra/test/schema-matches-migrations.sh` must exit 0.
- **Selection by stored format survives the drop.** `CANDIDATE_PREDICATE_SQL` and `NOT_EXACT_RUN_SQL` keep identifying a legacy run by `stats_method = 'estimated'` OR `histogram_kind IS DISTINCT FROM 'sparse-ms-v2'`; only the `sketch IS NOT NULL` arm goes. This is PR 1's rule: never select by `stats_method` alone.
- **A legacy row's percentiles at any set:**
  - for each requested rank `p`, the stored value at key `` `p${p}` `` passed through `clampPercentile` against the row's `minMs`/`maxMs`;
  - a rank the row never stored is OMITTED, not zero and not interpolated;
  - an exact row (both histograms `sparse-ms-v2`) is unchanged;
  - an empty row (`count === 0`) answers its frozen column as before.
- **No live code path reads, writes, imports or names a DDSketch afterwards.** `@datadog/sketches-js` leaves `packages/statistics/package.json` and the lockfile. Prose that records history ("the retired sketch engine") may stay, and it stays past tense.
- **Repo rules:**
  - Node 22 via nvm; read each command's own exit code.
  - Use a scratch database and Redis index, never `perfportal`.
  - `git commit -F -`, name the paths, never `git add -A`.
  - No backticks in SQL comments; no `prisma format`.
  - Rebuild a workspace package before integration tests that import it: delete its `.tsbuildinfo`, run `tsc -b --force`, then grep dist.
  - New schema facts get a guard.

## Review Focus

1. **An estimated run, retired with a `recompute_error`, in a project whose percentile set has since gained p90.** `/stats` answers its stored ranks, clamped, and omits p90. The table shows "—" for p90 with the ≈ heading, and nothing 500s. *Pinned in Task 1.*
2. **A run still waiting to be recomputed when the migration runs** (recompute was deferred). It stays a recompute candidate after the drop. Recompute then rewrites it exactly from its raw log and verification can check it, because neither path ever read the sketch. *Pinned in Task 1.*
3. **A legacy frozen value above its row's max, the DDSketch's 1% overshoot.** It is answered clamped server-side, matching what the browser's clamp already showed. *Pinned in Task 1.*
4. **Trends and compare over a cohort that mixes exact and estimated runs.** Each point is read through the same rule, and an estimated point is still marked ≈. *Pinned in Task 1 (trends read) and unchanged web cases.*
5. **A deploy that migrates while an old API pod is still running** for the length of a rolling deploy. The old pod selects `s.sketch` and fails with "column does not exist". `DEPLOYMENT.md` states the order: worker and API first, then migrate. That reverses the usual migrate-first rule, and the guide argues it. *Pinned in Task 3.*

---

### Task 1: Stop reading and writing the sketch, and drop its columns

**Files:**
- Create: the migration above.
- Modify:
  - `packages/persistence/prisma/schema.prisma` (the `RunStat` model);
  - `packages/persistence/src/metrics/write.ts` (stop listing `sketch` and `sketch_kind`);
  - `packages/persistence/src/metrics/read.ts` (both readers stop selecting and deserializing it; the source type loses `sketch`);
  - `packages/persistence/src/metrics/trends.ts` (`TRENDS_SQL` stops selecting `sketch` in both the inner and outer query; `TrendSource` loses `sketch`);
  - `packages/persistence/src/repositories/recompute.ts` (drop the `s.sketch IS NOT NULL` arm);
  - `packages/statistics/src/stored-percentiles.ts` (the rule above; `StoredPercentileSource` loses `sketch`);
  - `apps/api/src/metrics/metrics.controller.ts` and `apps/api/src/openapi/document.ts`. The `/stats` description says an estimated run answers only the ranks it stored. Also update the comments that describe the sketch path.
- Test:
  - `packages/statistics/test/stored-percentiles.test.ts`;
  - `packages/persistence/test/metrics.integration.test.ts`;
  - `packages/persistence/test/recompute.integration.test.ts`;
  - `apps/api/test/read.integration.test.ts`;
  - `apps/api/test/trends.integration.test.ts`;
  - every existing test that seeds a `sketch` column. Grep `apps/*/test` and `packages/*/test` for `sketch`; each seed moves to a legacy row identified by `histogram_kind`.

**Interfaces:**
- Produces: `StoredPercentileSource = { count; minMs; maxMs; percentiles: Record<string, number>; histogramOk: Histogram | null; histogramKo: Histogram | null }`. It has no `sketch`. `storedPercentiles(row, set)` keeps its signature.

- [ ] **Step 1: Write the failing tests:**
  - **stored-percentiles:**
    - `'a legacy row answers its stored ranks, clamped'`: frozen `{p50: 100, p95: 2515}`, max 2503, set [50, 95] gives `{p50: 100, p95: 2503}`;
    - `'a legacy row omits a rank it never stored'`: set [50, 90] gives `{p50: 100}` and no `p90` key;
    - `'an exact row is unchanged'`;
    - `'an empty row answers its frozen column'`.
  - **persistence metrics:** a written row has no `sketch` property; reading a legacy row (`histogram_kind` `sparse-ms-v1`) gives its frozen values.
  - **recompute:** a run labelled `exact-v1` whose rows carry `histogram_kind` `sparse-ms-v1` is still a candidate. (This is the predicate without the sketch arm.)
  - **read.integration:**
    - `/stats` on a legacy run at a project set that gained p90 answers 200 with no p90 and a clamped p95;
    - `/stats` on an exact run is byte-identical to before.
  - **trends.integration:** a legacy point's percentiles come from the frozen column.
- [ ] **Step 2: Run them.** They fail to COMPILE or fail, because `sketch` is still in the types and the SQL.
- [ ] **Step 3: Implement.** Write the migration, run `prisma migrate deploy` on the scratch DB, then change the schema and code. Remove the obsolete sketch seeds from existing tests.
- [ ] **Step 4: Verify.**
  - Rebuild persistence and statistics, then grep their dist for `sketch`: no `.sketch` read, and no `Sketch` import.
  - Run the tests (PASS). `bash infra/test/schema-matches-migrations.sh` must exit 0.
  - Run `pnpm typecheck` and `pnpm lint` (each exit 0).
- [ ] **Step 5: Red-verify.** Each mutation must fail the case written for it:
  - a missing rank interpolated or zeroed fails the omit case;
  - the clamp dropped fails the clamped case;
  - the candidate predicate keyed on `stats_method` alone fails the recompute case.
- [ ] **Step 6: Commit.**

### Task 2: Delete the `Sketch` class and its dependency

**Files:**
- Delete: `packages/statistics/src/sketch.ts`, `packages/statistics/test/sketch.test.ts`.
- Modify:
  - `packages/statistics/src/index.ts`;
  - `packages/statistics/package.json` (remove `@datadog/sketches-js`) and `pnpm-lock.yaml` (`pnpm install`);
  - `packages/statistics/test/runtime-import.test.ts`, which imports a value export that still exists, such as `Histogram`;
  - `packages/statistics/test/clamped-quantiles.test.ts`, repurposed as below;
  - any comment under `packages/*/src` or `apps/*/src` that describes a sketch as present.
- Test: `packages/statistics/test/clamped-quantiles.test.ts` becomes `'no production code computes a sketch quantile, and nothing imports a DDSketch'`:
  - a comment-stripped scan of every production `.ts`/`.tsx` under `packages/*/src` and `apps/*/src` finds no `@datadog/sketches-js` specifier and no `.quantile(` call outside its named exemption (`window.ts`'s `Histogram#quantile`);
  - it keeps the existing vacuity floor on files scanned and fails naming the file and line.

**Interfaces:**
- Consumes: Task 1 (no reader of `Sketch` remains).
- Produces: `@perfportal/statistics` with no `Sketch` export.

- [ ] **Step 1: Rewrite the guard first** and see it fail while `sketch.ts` and its import still exist.
- [ ] **Step 2: Delete and edit.** Run `pnpm install`. `git diff pnpm-lock.yaml` must show `@datadog/sketches-js` and only its own transitive packages leaving. Name any other change in the report.
- [ ] **Step 3: Run checks.**
  - `pnpm build`, `pnpm typecheck` and `pnpm lint` each exit 0.
  - `pnpm audit --prod` exits 0.
  - The statistics package tests pass, and the guard passes.
  - `grep -rn "sketches-js" packages apps --include=*.ts --include=*.json` is empty, `node_modules` excluded.
- [ ] **Step 4: Red-verify.** Re-adding `import { DDSketch } from '@datadog/sketches-js'` to `percentile.ts` fails the guard, naming the file. Restore it afterwards.
- [ ] **Step 5: Commit.**

### Task 3: Upgrade order, a real check, docs, gates

- [ ] **Step 1: `DEPLOYMENT.md` Upgrading.**
  - **Let the backfill finish first.** Before this upgrade, let the exact-statistics backfill finish: Administration › Data integrity reads 0 remaining. A run still waiting answers only the percentile ranks it stored until it is recomputed, and recompute still works after the upgrade.
  - **Order for this release only.** Roll the API and worker first, then run `migrate`. An old pod still selects the dropped column, and the new code no longer reads it. Say plainly that this reverses the usual migrate-first order for this one release, and why.
- [ ] **Step 2: A real check on a COPY of the developer database, which is read only.**
  1. Run `pg_dump perfportal` into `perfportal_pr5_copy` and `prisma migrate deploy` up to the PR 4 head, without this migration. **The developer database predates PR 1** (37 migrations, no `stats_method`), so every run with statistics is `estimated` on the copy at this point (26 of 29 when PRs 2 and 3 measured it).
  2. **Estimated, before:** fingerprint the old API's `/stats` (at the project's own set AND at a set that adds p90) and `/trends` for every run, with this branch's parent API build against the copy. This is the sketch path's last answer.
  3. **Set one run aside** (record its id) by giving it a `recompute_error`, so it stays estimated and stands in for a retired run.
  4. **Recompute** with the parent build's `pnpm recompute` against the copy, reading the developer bucket through a read-only store (the worker process is never started on the copy). Then fingerprint again: this is the exact baseline.
  5. Apply this migration and start this branch's API against the copy. Fingerprint again. Every exact run must be byte-identical to step 4. The retired run must answer its stored ranks clamped, omit p90, and differ from step 2 only where step 2 used the sketch; record both answers.
  6. Drop the copy. Confirm the developer database is unchanged: run count, `run_stat` count, migration count, and an md5 over run id/status/verdict and every `run_stat` row's counts and percentiles.
- [ ] **Step 3: `CLAUDE.md` entry.** Cover what was removed, the legacy rule, the upgrade-order reversal, the measured fingerprint result, and the floors.
- [ ] **Step 4: Gates.** Predict the floors first: unit from per-file deltas, since `sketch.test.ts` leaves; integration from `vitest list`; e2e from `--list`. Then run every gate on Node 22 and the scratch stores, each read by its own exit code: build, typecheck after deleting `.tsbuildinfo`, lint, unit, integration, then e2e.
- [ ] **Step 5: Commit.** The controller pushes and opens the PR after the whole-branch review.

---

## Self-review notes

- D7 and §9 row 5: Task 1 removes every read and write and drops the columns; Task 2 removes the class and dependency. Task 3 covers the upgrade, the real check and the gates.
- PR 1's rule that PR 5 selects by stored format: kept in Task 1 (`histogram_kind`), with a test.
- The behaviour change is deliberate and stated. An estimated run at a reconfigured percentile set loses ranks it never stored. Only runs whose raw log was unrecoverable (retired) or not yet recomputed are affected, and both are already labelled ≈.
