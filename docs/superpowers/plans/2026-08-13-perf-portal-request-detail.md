# Request detail page — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the request detail page behind `/runs/:runId/requests/:name`
(§13.3, RQ-01…RQ-11), opening by resolving deviation D-10 so a request's metric
identity is its full group path.

**Architecture:** Task 1 changes request identity in the statistics engine
(`[...e.groups, e.name].join('/')`), which is what makes the already-shipped
statistics tree nest requests under their groups. Task 2 recaptures the payload
fixture every web test reads. Tasks 3–8 build the page itself, reusing piece 1's
chart components and piece 2's tables at request scope — every chart takes an
already-validated payload as a prop and never fetches. Only RQ-09, the
saturation scatter, is genuinely new, and it is last because it needs a new
`Chart` kind.

**Tech Stack:** TypeScript, React 19, React Router 7, TanStack Query, ECharts,
Zod contracts, Vitest (jsdom + node), Playwright, pnpm workspaces.

## Global Constraints

- Node >= 22. Run `. "$HOME/.nvm/nvm.sh" && nvm use` before any pnpm command.
- **Charts never fetch.** A chart component takes an already-validated payload
  as a prop. Only route components call query factories (design §6).
- **Transforms are pure and DOM-free.** Everything in `charts/transforms/*` is
  unit-tested in the node environment against `apps/web/test/fixtures/reference-run.json`.
- **Expectations are computed from the payload, never written down.** A
  re-captured fixture must move the expectation with it.
- Colours come from tokens (`theme.ts`), never literals. Text never wears a
  palette colour.
- **RQ-04, RQ-06 and RQ-10 do not exist.** Gatling 3.15.1.2 reports no latency.
  Do not add latency charts (§A.9 F-2).
- Both `scope` **and** `name` on every scoped metrics call. `?name=X` without
  `scope` is silently ignored and answers with the run's totals.
- Verify with `pnpm typecheck && pnpm lint && pnpm test:unit`; e2e with
  `pnpm test:e2e`.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/statistics/src/engine.ts` | **Modify.** Request rollups key on the group path (4 sites). |
| `packages/statistics/test/scopes.test.ts` | **Modify.** Joined-name expectations; new grouped cardinality-cap test (D-12). |
| `packages/statistics/test/engine.test.ts` | **Modify.** `buy` gains a group so `errorsFor` is guarded. |
| `apps/web/e2e/run-tables.spec.ts` | **Modify.** `openingPaths` mirrors the nesting rule. |
| `scripts/capture-chart-fixture.mjs` | **Modify.** Capture `/scatter` alongside the existing five. |
| `apps/web/test/fixtures/reference-run.json` | **Regenerate.** |
| `apps/web/test/reference-run.fixture.test.ts` | **Modify.** Assert the scatter payload is fit for purpose. |
| `apps/web/test/buildTree.test.ts` | **Modify.** Assertions naming bare request names. |
| `apps/web/src/api/metrics.ts` | **Modify.** Add `scatterQuery`. |
| `apps/web/src/routes/RequestDetail.tsx` | **Create.** The page: fetches, composes, owns no chart internals. |
| `apps/web/src/tables/StatisticsTable.tsx` | **Modify.** Export `Column` and `columnsFor` so both tables share one column set. |
| `apps/web/src/tables/RequestStatistics.tsx` | **Create.** RQ-01 — one row, §A.5's full column set. |
| `apps/web/src/charts/transforms/indicators.ts` | **Modify.** Extract the band core; add `toRequestIndicators`. |
| `apps/web/src/charts/transforms/scatter.ts` | **Create.** Pure `ScatterResponse -> ChartData`. |
| `apps/web/src/charts/ScatterChart.tsx` | **Create.** RQ-09. |
| `apps/web/src/charts/Chart.tsx` | **Modify.** A `scatter` kind with a numeric x axis. |
| `apps/web/src/App.tsx` | **Modify.** Request route renders `RequestDetail`. |
| `apps/web/e2e/request-detail.spec.ts` | **Create.** Mount, hard-load, and the parity surfaces. |

---

## Task 1: D-10 — a request's identity is its group path

**Files:**
- Modify: `packages/statistics/src/engine.ts:147,164,171,178`
- Modify: `packages/statistics/test/scopes.test.ts:23-24`, `:27-38`
- Modify: `packages/statistics/test/engine.test.ts:11`, `:35`
- Modify: `apps/web/e2e/run-tables.spec.ts:98-110`, `:179`

**Interfaces:**
- Consumes: nothing.
- Produces: `EngineResult.stats`, `.series` and `.errors` entries whose
  `scope === 'request'` carry `name` = `[...groups, name].join('/')`. Every
  later task and every downstream reader depends on this string.

**Why this is first:** `apps/web/src/tables/buildTree.ts:164` parents a row by
`/`-prefix against the groups. A bare request name has no separator, so all
seven reference-run requests fall to the root via the orphan rule at `:174` —
5 of them in the wrong place. This is a visible defect in shipped UI, not
preparation.

> **`apps/web`'s unit suite stays GREEN through this task, and that is not a
> reassurance.** No web unit test calls `runEngine`; they all read the static
> `reference-run.json`, which this task does not touch. The coupling is to the
> FIXTURE, not to the engine — so the web tests go red in Task 2, at the
> recapture, and Task 2 is where they are fixed. A green web suite here means
> only that nothing under those tests has changed yet.

- [ ] **Step 1: Write the failing test**

In `packages/statistics/test/scopes.test.ts`, replace the assertion at `:23-24`
inside `it('produces a run scope plus one scope per request name', …)`:

```ts
    const names = r.stats.filter((s) => s.scope === 'request').map((s) => s.name).sort();
    expect(names).toEqual(['C', 'G1/A', 'G1/B']);
```

`C` carries `groups: []` and correctly stays bare — that is the root case still
behaving, and it is why this assertion is not simply "everything has a slash".

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm vitest run packages/statistics/test/scopes.test.ts -t 'one scope per request name'
```

Expected: FAIL — `expected [ 'A', 'B', 'C' ] to deeply equal [ 'C', 'G1/A', 'G1/B' ]`.

- [ ] **Step 3: Add the grouped cardinality-cap test (D-12)**

The existing cap test at `:27` uses `groups: []` throughout, so it cannot see
this change. Add beneath it:

```ts
  it('counts endpoints by path, so one name under many groups is many endpoints', () => {
    // D-12. The cap exists to bound STORED ROLLUPS. One bare name under twelve
    // groups is twelve rollups; a cap counting bare names would see one and
    // let a run through that the engine then materialises twelve times over.
    const many: CanonicalEvent[] = [{ type: 'meta', simulation: 'S', toolVersion: 'v', startedAtMs: base }];
    for (let i = 0; i < 12; i++) many.push(req('same', [`G${i}`], i, 10));
    expect(() => runEngine(many, { maxEndpoints: 10 })).toThrow(IngestError);
  });
```

- [ ] **Step 4: Run it and watch it fail**

```bash
pnpm vitest run packages/statistics/test/scopes.test.ts -t 'counts endpoints by path'
```

Expected: FAIL — no error is thrown, because `endpoints` holds the single
string `'same'`.

- [ ] **Step 5: Strengthen the error-rollup test so site 3 is guarded**

`packages/statistics/test/engine.test.ts` gives both its requests `groups: []`,
so its error assertion passes untouched — it would not have caught this
regression. Give `buy` a group. At `:11`:

```ts
    { type: 'request', name: 'buy', groups: ['Checkout'], scenario: 'Checkout', userId: '2', startMs: 1_500, endMs: 2_400, ok: false, message: 'boom' },
```

and at `:35`:

```ts
    expect(r.errors).toContainEqual({ scope: 'request', name: 'Checkout/buy', message: 'boom', count: 1 });
```

- [ ] **Step 6: Run it and watch it fail**

```bash
pnpm vitest run packages/statistics/test/engine.test.ts -t 'scopes errors'
```

Expected: FAIL — the rollup is still named `buy`.

- [ ] **Step 7: Change the four sites in the engine**

In `packages/statistics/src/engine.ts`, inside the request branch (after the
`if (e.type !== 'request') continue;` at `:145`), introduce the joined name and
use it at all four sites. Replace `:147`:

```ts
    // D-10. A request's identity is its FULL PATH, joined exactly as :133 joins
    // a group's — `Catalog/Recommendations/List Products`. Without this the
    // statistics tree cannot nest requests under their groups: `buildTree`
    // parents by '/'-prefix, and a bare name has no prefix to parent by.
    //
    // COUNTED HERE TOO, not just rolled up (D-12). The cap bounds STORED
    // ROLLUPS, and after this change one bare name under four groups is four
    // rollups. A cap still counting bare names would stop bounding the thing
    // it exists for.
    const name = [...e.groups, e.name].join('/');

    endpoints.add(name);
```

Then replace the three rollup sites, which now read `name` rather than `e.name`:

```ts
    const epSeries = seriesFor('request', name, maxBucketsEndpoint);
```

```ts
    rollupFor('request', name, 'response_time').add(duration, e.ok);
```

```ts
      errorsFor('request', name).add(message);
```

Leave `:133`'s group join, the `run`-scope rollups, and the `samples` detail on
the cardinality error untouched — `samples: [...endpoints].slice(0, 5)` now
naturally reports paths, which is what an operator needs to see.

- [ ] **Step 8: Run the statistics suite**

```bash
pnpm vitest run packages/statistics
```

Expected: PASS, all files.

- [ ] **Step 9: Update the e2e assertions that encode the flat behaviour**

`apps/web/e2e/run-tables.spec.ts` deliberately asserts D-10's flat rows. When
D-10 lands this file fails **because the fix worked**, so it changes in this
commit. Replace `openingPaths` at `:103`:

```ts
/**
 * THE ROWS THE TABLE MUST OPEN WITH, derived from the payload.
 *
 * A row opens at root when its immediate parent path is not itself a group in
 * the payload — the same rule `buildTree` applies, deliberately restated from
 * the payload rather than imported, so a change to the tree's parenting has to
 * disagree with this file to pass.
 *
 * Post-D-10 the reference run opens with 2 root groups (`Catalog`, `Cart`) and
 * the 2 genuinely-rootless requests (`Search`, `Place Order`).
 * `Catalog/Recommendations` is a CHILD group and starts collapsed.
 */
function openingPaths(json: StatsJson): string[] {
  const groups = new Set(
    json.stats.filter((r) => r.scope === 'group').map((r) => r.name),
  );
  const paths = new Set<string>();
  for (const row of json.stats) {
    if (row.scope !== 'request' && row.scope !== 'group') continue;
    const cut = row.name.lastIndexOf('/');
    const parent = cut <= 0 ? null : row.name.slice(0, cut);
    if (parent === null || !groups.has(parent)) paths.add(row.name);
  }
  return [...paths];
}
```

and the count at `:179`:

```ts
  expect(expected.length, 'the reference run should open with 2 root groups + 2 root requests').toBe(4);
```

**Leave the `data-depth` assertion at `:182-186` exactly as it is.** Children
start collapsed, so every *rendered* row is still depth `'0'` — the assertion
stays true for a different and better reason. Update only the comment above it:

```ts
  // Every OPENING row is a root row: children exist now (D-10 nests five of the
  // seven requests) and start collapsed, so none of them is on screen yet.
```

Then update the file's header comment at `:27-31`, which currently explains
that the flat rows are D-10 and not a bug here — that paragraph is now false.
Replace it with:

```ts
 * DEVIATION D-10 IS RESOLVED AND THESE ASSERTIONS PIN THE RESOLUTION. The
 * engine joins a request's group path onto its name, so `List Products` is
 * `Catalog/List Products` and nests under `Catalog` exactly as Gatling's own
 * report nests it. `openingPaths` below derives the root set from the payload
 * rather than listing it, so the expectation moves with a re-captured fixture.
```

- [ ] **Step 10: Typecheck and commit**

```bash
pnpm typecheck && pnpm lint
```

```bash
git add packages/statistics/src/engine.ts packages/statistics/test/scopes.test.ts packages/statistics/test/engine.test.ts apps/web/e2e/run-tables.spec.ts
git commit -m "fix(statistics): D-10, a request rolls up under its group path"
```

---

## Task 2: Recapture the fixture, and capture the scatter while the stack is up

**Files:**
- Modify: `scripts/capture-chart-fixture.mjs:106-118`
- Regenerate: `apps/web/test/fixtures/reference-run.json`
- Modify: `apps/web/test/reference-run.fixture.test.ts`
- Modify: `apps/web/test/buildTree.test.ts:231`, `:354`, `:368`

**Interfaces:**
- Consumes: Task 1's joined request names.
- Produces: a fixture whose `stats`/`series`/`errors` carry joined request
  names, plus a new `scatter` key holding a `ScatterResponse` for one request.
  Task 8's transform tests read that key.

**Why the scatter is captured here:** the capture needs a full local stack and
a re-ingest. Doing it once for both reasons avoids standing the stack up twice.

- [ ] **Step 1: Add the scatter endpoint to the capture list**

In `scripts/capture-chart-fixture.mjs`, append to the `ENDPOINTS` array:

```js
  {
    key: 'scatter',
    // RQ-09 is inherently request-scoped, so this endpoint takes `name` and NO
    // `scope` — it cannot fall into the `?name=` trap the errors URL above
    // documents, because there is no scope parameter to omit.
    //
    // `Catalog/List Products` is the post-D-10 identity of a request Gatling
    // nests, so this capture also proves the joined name survives a URL.
    path: (id) => `/v1/runs/${id}/scatter?name=${encodeURIComponent('Catalog/List Products')}`,
  },
```

- [ ] **Step 2: Bring up the stack and recapture**

```bash
docker compose -f infra/docker-compose.yml up -d
```

```bash
export DATABASE_URL=postgresql://perfportal:perfportal@localhost:5433/perfportal REDIS_URL=redis://localhost:6380 S3_ENDPOINT=http://localhost:9000 S3_ACCESS_KEY=perfportal S3_SECRET_KEY=perfportal123
```

Build, then start the API and leave it running in a second shell:

```bash
. "$HOME/.nvm/nvm.sh" && nvm use && pnpm build && pnpm --filter @perfportal/api start
```

In the first shell:

```bash
node --experimental-strip-types scripts/capture-chart-fixture.mjs
```

**Never run this while `pnpm test:integration` is running against the same
`DATABASE_URL`** — that suite TRUNCATEs every table on each `createTestApp()`
and will delete the seeded org mid-capture.

- [ ] **Step 3: Verify the recapture actually moved the names**

```bash
node -e "const f=require('./apps/web/test/fixtures/reference-run.json');console.log(f.stats.stats.filter(r=>r.scope==='request').map(r=>r.name).sort().join('\n'))"
```

Expected: seven names, five of them containing `/` —
`Cart/Add To Cart`, `Cart/View Cart`, `Catalog/List Products`,
`Catalog/Product Detail`, `Catalog/Recommendations/Related Items`,
`Place Order`, `Search`.

If they are all bare, the API you captured from is running pre-Task-1 code:
rebuild and restart it.

- [ ] **Step 4: Assert the scatter payload is fit for purpose**

In `apps/web/test/reference-run.fixture.test.ts`, add to the existing describe:

```ts
  it('carries a scatter payload with points to draw', () => {
    const scatter = ScatterResponseSchema.parse(fixture.scatter);
    expect(scatter.name).toBe('Catalog/List Products');
    // Both axes are counts/milliseconds, never null: a transform that has to
    // defend against a null here is defending against a shape the API cannot
    // produce.
    expect(scatter.ok.length).toBeGreaterThan(0);
    for (const [x, y] of scatter.ok) {
      expect(Number.isInteger(x)).toBe(true);
      expect(Number.isInteger(y)).toBe(true);
    }
  });
```

Add `ScatterResponseSchema` to the existing import from `@perfportal/contracts`
at the top of the file.

- [ ] **Step 5: Rewrite the test that asserts the pre-D-10 behaviour**

`apps/web/test/buildTree.test.ts:148` — `it('puts every request at the root,
because request names carry no group path')` — is **entirely** a pre-D-10
assertion, and every line of it inverts once the fixture is recaptured:

```ts
    expect(requestNames.filter((n) => n.includes('/'))).toEqual([]);  // 5 now do
    expect(requests.every((r) => r.depth === 0)).toBe(true);          // 5 are now nested
    expect(paths(tree.filter((r) => r.scope === 'request')).sort()).toEqual(requestNames.sort());
```

That last line does not survive despite deriving its expectation from the
payload: it compares the tree's ROOT-level requests against ALL request names,
and post-D-10 only two requests are at root. Deriving an expectation protects
against a value changing, not against the structure it describes changing.

Replace the whole test, and the doc comment above it that explains why requests
are flat:

```ts
  /**
   * D-10, resolved: the engine joins a request's group path onto its name, so
   * the tree nests requests under their groups exactly as Gatling's own report
   * does. Five of the reference run's seven requests nest; `Search` and
   * `Place Order` genuinely have no group and stay at the root.
   */
  it('nests a request under its group, and leaves a groupless one at the root', () => {
    const requestNames = stats.stats.filter((r) => r.scope === 'request').map((r) => r.name);
    expect(requestNames.length).toBe(7);

    const tree = buildTree(stats, 'group_cumulated');
    const requests = flat(tree).filter((r) => r.scope === 'request');
    expect(requests.length).toBe(7);

    // Derived from the payload, not listed: a request is at root exactly when
    // its own name has no group prefix.
    const rootNames = requestNames.filter((n) => !n.includes('/'));
    expect(paths(tree.filter((r) => r.scope === 'request')).sort()).toEqual(rootNames.sort());
    expect(requests.filter((r) => r.depth > 0).length).toBe(requestNames.length - rootNames.length);
  });
```

- [ ] **Step 5b: Update the remaining tests that name bare requests**

In the same file, `:231`, `:354` and `:368` name `'Related Items'` and
`'Search'`. `Search` is genuinely at root and needs no change; `'Related Items'`
becomes `'Catalog/Recommendations/Related Items'`. Derive it rather than
hard-coding:

```ts
  const relatedItems = stats.stats.find(
    (r) => r.scope === 'request' && r.name.endsWith('/Related Items'),
  )!;
```

Then run the whole file — there may be further assertions that depend on the
flat shape, and the run is how you find them:

```bash
pnpm vitest run apps/web/test/buildTree.test.ts
```

- [ ] **Step 6: Run the full unit suite**

```bash
pnpm test:unit
```

Expected: PASS. This is the first green `apps/web` run since Task 1.

- [ ] **Step 7: Run the e2e suite against the running stack**

```bash
pnpm test:e2e
```

Expected: PASS, including `run-tables.spec.ts` with Task 1's edits.

- [ ] **Step 8: Commit**

```bash
git add scripts/capture-chart-fixture.mjs apps/web/test/fixtures/reference-run.json apps/web/test/reference-run.fixture.test.ts apps/web/test/buildTree.test.ts
git commit -m "test(web): recapture the reference fixture under D-10, and capture the scatter"
```

---

## Task 2b: D-13 — an SLA rule targeting a bare request name keeps working

**Files:**
- Modify: `packages/sla/src/evaluate.ts:41-57`
- Modify: `packages/sla/test/evaluate.test.ts`

**Interfaces:**
- Consumes: Task 1's joined request names.
- Produces: no signature change. `evaluateRules` gains a fallback in its
  stat lookup.

**Why this task exists and is not in the original plan:** review of Tasks 1–2
found it. `evaluate.ts:44` matches a rule's target by exact string —
`s.name === (rule.targetName ?? '')`. After D-10 a request-scoped rule whose
`targetName` is `List Products` matches nothing, falls into the `!stat` branch
at `:48`, and emits `outcome: 'not_applicable'` with the message "…so the rule
was not checked."

**That is the worst available failure mode: an SLA gate that stops enforcing
and reads as benign.** It is made sharper by the spec's no-backfill decision —
pre-D-10 runs keep bare names, so the rule keeps passing on old runs and
silently stops on new ones. Nothing in the product would look broken.

**The fix is lenient matching, not a data migration.** A migration would fix
new runs and break the same rules against old ones, which keep bare names by
design; a rule spanning the boundary would be wrong on one side either way.

**One matching rule for every scope, deliberately.** Groups have always carried
paths, so a group rule with a bare name never matched either — this fallback
fixes that too. Making the rule differ by scope would mean a reader debugging a
rule has to know that requests changed identity in one release and groups never
did. One behaviour, documented once.

**Ambiguity must not be resolved by picking.** Two requests can share a leaf
name under different groups (`Cart/View`, `Catalog/View`). Silently choosing
one would be worse than the bug being fixed. The three outcomes are fixed in
the contract (`packages/contracts/src/run.ts:9`) and adding a fourth would
ripple into the API, so an ambiguous target stays `not_applicable` — but with a
message that names the ambiguity and lists the candidates, which is a different
sentence from "there were no statistics".

- [ ] **Step 1: Write the failing tests**

In `packages/sla/test/evaluate.test.ts`:

```ts
  it('matches a rule authored against a bare request name (D-13)', () => {
    // D-10 joined the group path onto a request's identity. A rule written
    // before that names the leaf, and must keep being CHECKED — a rule that
    // silently stops enforcing is worse than one that fails.
    const stats = [
      { scope: 'request', name: 'Catalog/List Products', family: 'response_time', p95: 120 },
    ] as unknown as EvaluableStat[];
    const rules = [
      { id: 'r1', scope: 'request', targetName: 'List Products', family: 'response_time',
        metric: 'p95', comparator: 'lte', threshold: 200 },
    ] as EvaluableRule[];

    const { assertions, verdict } = evaluateRules(rules, stats);
    expect(assertions[0]?.outcome).toBe('passed');
    expect(verdict).toBe('passed');
  });

  it('prefers an exact match over a leaf match', () => {
    // A run holding BOTH `View` at root and `Cart/View` must not have the
    // rule quietly repointed at the nested one.
    const stats = [
      { scope: 'request', name: 'Cart/View', family: 'response_time', p95: 900 },
      { scope: 'request', name: 'View', family: 'response_time', p95: 10 },
    ] as unknown as EvaluableStat[];
    const rules = [
      { id: 'r1', scope: 'request', targetName: 'View', family: 'response_time',
        metric: 'p95', comparator: 'lte', threshold: 100 },
    ] as EvaluableRule[];

    expect(evaluateRules(rules, stats).assertions[0]?.outcome).toBe('passed');
  });

  it('refuses to choose when a bare name is ambiguous, and says so', () => {
    const stats = [
      { scope: 'request', name: 'Cart/View', family: 'response_time', p95: 900 },
      { scope: 'request', name: 'Catalog/View', family: 'response_time', p95: 10 },
    ] as unknown as EvaluableStat[];
    const rules = [
      { id: 'r1', scope: 'request', targetName: 'View', family: 'response_time',
        metric: 'p95', comparator: 'lte', threshold: 100 },
    ] as EvaluableRule[];

    const { assertions } = evaluateRules(rules, stats);
    expect(assertions[0]?.outcome).toBe('not_applicable');
    // The message must name the ambiguity — "no statistics" would be a lie,
    // and is the sentence a reader would otherwise act on.
    expect(assertions[0]?.message).toMatch(/ambiguous/i);
    expect(assertions[0]?.message).toContain('Cart/View');
    expect(assertions[0]?.message).toContain('Catalog/View');
  });

  it('evaluates a run-scope rule against the run row', () => {
    // A plain regression guard on run-scope evaluation. It does NOT pin the
    // `target !== ''` guard: the exact match finds `name: ''` first, so this
    // test passes with the guard deleted. The test below is the one that
    // pins it.
    const stats = [
      { scope: 'run', name: '', family: 'response_time', p95: 10 },
    ] as unknown as EvaluableStat[];
    const rules = [
      { id: 'r1', scope: 'run', targetName: null, family: 'response_time',
        metric: 'p95', comparator: 'lte', threshold: 100 },
    ] as EvaluableRule[];

    expect(evaluateRules(rules, stats).assertions[0]?.outcome).toBe('passed');
  });

  it('does not let a run-scope rule bind to a name ending in the separator', () => {
    // THIS is what the `target !== ''` guard is for. `endsWith('/')` matches
    // nothing in general — but it DOES match `Cart/`, the join of a group with
    // an empty request leaf, which a malformed simulation log can produce.
    // Without the guard, a run rule could bind to that row instead of the run.
    //
    // The run row is listed SECOND on purpose: with the guard removed, a
    // fallback that ran before the exact match would take `Cart/` and report
    // failed (900 > 100).
    const stats = [
      { scope: 'run', name: 'Cart/', family: 'response_time', p95: 900 },
      { scope: 'run', name: '', family: 'response_time', p95: 10 },
    ] as unknown as EvaluableStat[];
    const rules = [
      { id: 'r1', scope: 'run', targetName: null, family: 'response_time',
        metric: 'p95', comparator: 'lte', threshold: 100 },
    ] as EvaluableRule[];

    expect(evaluateRules(rules, stats).assertions[0]?.outcome).toBe('passed');
  });
```

Match the file's existing helpers and import style — if it already has a stat
or rule builder, use it rather than the inline literals above.

- [ ] **Step 2: Run them and watch them fail**

```bash
pnpm vitest run packages/sla
```

Expected: the first test FAILS with `expected 'not_applicable' to be 'passed'`
— which is the bug. The ambiguity test also fails. The exact-match and
run-scope tests should already PASS; they are the regression guard on
behaviour that must not change.

- [ ] **Step 3: Implement the fallback**

Replace the lookup at `evaluate.ts:41-47`:

```ts
    const target = rule.targetName ?? '';
    const candidates = stats.filter((s) => s.scope === rule.scope && s.family === rule.family);

    /**
     * D-13. EXACT MATCH FIRST, then the leaf.
     *
     * D-10 made a request's identity its full group path, so a rule authored
     * before that names the leaf (`List Products`, not
     * `Catalog/List Products`). Matching only exactly would drop such a rule
     * into the `!stat` branch below and report it "not checked" — an SLA gate
     * that stops enforcing while looking healthy. A data migration cannot fix
     * it either way round: runs ingested before D-10 keep their bare names, so
     * a rewritten target would break against exactly the runs it still matches.
     *
     * The same rule applies at group scope, where names have ALWAYS been paths
     * and a bare target has therefore never matched. One matching behaviour for
     * every scope: a reader debugging a rule should not have to know which
     * scope changed identity when.
     *
     * Never for run scope: `targetName` is null there, so `target` is `''`.
     * The guard is NOT because `endsWith('/')` would match everything — it
     * matches nothing (`'Catalog/View'.endsWith('/')` is false). It is because
     * it matches a name ending in the separator: a group whose request leaf is
     * empty joins to `Cart/`, and `'Cart/'.endsWith('/')` IS true. Without the
     * guard a run-scope rule could bind to that degenerate row instead of to
     * the run. The exact match at `:63` finds the run stat first in practice,
     * so this is belt and braces — but it is cheap and the degenerate row is
     * reachable from a malformed simulation log.
     */
    let stat = candidates.find((s) => s.name === target);
    let ambiguous: readonly EvaluableStat[] = [];
    if (stat === undefined && target !== '') {
      const byLeaf = candidates.filter((s) => s.name.endsWith(`/${target}`));
      // AMBIGUITY IS NOT RESOLVED BY PICKING. Two requests can share a leaf
      // under different groups; choosing one silently would be a worse bug
      // than the one this fallback fixes.
      if (byLeaf.length === 1) stat = byLeaf[0];
      else ambiguous = byLeaf;
    }

    if (ambiguous.length > 1) {
      assertions.push({
        ruleId: rule.id,
        outcome: 'not_applicable',
        actualValue: null,
        message:
          `"${target}" is ambiguous in this run — it matches ${ambiguous.map((s) => s.name).join(', ')} — ` +
          `so ${describe(rule)} was not checked. Target one of those names exactly.`,
        ruleSnapshot: snapshot,
      });
      continue;
    }
```

Leave the existing `if (!stat)` branch below it unchanged — it still handles
the genuine "this run has no such target" case.

- [ ] **Step 4: Run the tests**

```bash
pnpm vitest run packages/sla
```

Expected: PASS, all four new tests plus the pre-existing suite.

- [ ] **Step 5: Verify and commit**

```bash
pnpm typecheck && pnpm lint && pnpm test:unit
```

```bash
git add packages/sla/src/evaluate.ts packages/sla/test/evaluate.test.ts
git commit -m "fix(sla): D-13, a rule targeting a bare request name still matches after D-10"
```

---

## Task 3: The page shell — routed, named, and finding its row

**Files:**
- Create: `apps/web/src/routes/RequestDetail.tsx`
- Modify: `apps/web/src/App.tsx:42-45`
- Create: `apps/web/test/RequestDetail.test.tsx`

**Interfaces:**
- Consumes: `statsQuery(runId)` from `apps/web/src/api/metrics.ts:57` —
  deliberately UNFILTERED, returning every row plus response-level
  `indicators`/`bounds`/`configurable`.
- Produces: `export default function RequestDetail()`, and
  `export function requestRow(stats: StatsResponse, path: string): StatRow | undefined`
  used by Tasks 4 and 5.

**The key fact:** RQ-01 and RQ-02 need **no new fetch and no new endpoint**. Every row in
`StatsResponse.stats` already carries its own `indicators`
(`StatRowSchema:34`), computed per row by `MetricsController` at `:116`. Pick
the row; do not add a scoped stats query, which would be a second cache entry
that can disagree with the table's.

- [ ] **Step 1: Write the failing test**

Create `apps/web/test/RequestDetail.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import RequestDetail, { requestRow } from '../src/routes/RequestDetail';
import fixture from './fixtures/reference-run.json';

const stats = fixture.stats as Parameters<typeof requestRow>[0];

describe('requestRow', () => {
  it('finds a nested request by its full path', () => {
    const row = requestRow(stats, 'Catalog/List Products');
    expect(row?.name).toBe('Catalog/List Products');
    expect(row?.scope).toBe('request');
  });

  it('does not match a group of the same name', () => {
    // `Catalog` is a GROUP. A request lookup that fell back to a group row
    // would render group_cumulated numbers under a request heading.
    expect(requestRow(stats, 'Catalog')).toBeUndefined();
  });

  it('is undefined for a name the run never recorded', () => {
    expect(requestRow(stats, 'Nope/Not Here')).toBeUndefined();
  });
});

describe('RequestDetail', () => {
  it('heads the page with the request name from the URL', () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter initialEntries={['/runs/r1/requests/Catalog%2FList%20Products']}>
          <Routes>
            <Route path="/runs/:runId/requests/:name" element={<RequestDetail />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Catalog/List Products');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm vitest run apps/web/test/RequestDetail.test.tsx
```

Expected: FAIL — `Failed to resolve import "../src/routes/RequestDetail"`.

- [ ] **Step 3: Create the page**

Create `apps/web/src/routes/RequestDetail.tsx`:

```tsx
import type { StatRow, StatsResponse } from '@perfportal/contracts';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { statsQuery } from '../api/metrics';

/**
 * §13.3 — one request's own page.
 *
 * THE NAME IS A FULL PATH, arriving as ONE encoded segment. `detailPathFor`
 * encodes it (`tables/StatisticsTable.tsx:822`), the route spells it as a
 * single `:name` (`App.tsx:42`), and `useParams` decodes it — so
 * `Catalog%2FList%20Products` reaches here as `Catalog/List Products`, which
 * is exactly the identity the engine rolls the request up under (D-10).
 */

/**
 * The row this page is about.
 *
 * SCOPE IS PART OF THE MATCH, not an afterthought. `Catalog` is a group AND a
 * name a request could plausibly have; matching on name alone would render a
 * group's cumulated numbers under a request heading and look entirely normal.
 */
export function requestRow(stats: StatsResponse, path: string): StatRow | undefined {
  return stats.stats.find((r) => r.scope === 'request' && r.name === path);
}

export default function RequestDetail() {
  const { runId, name } = useParams<{ runId: string; name: string }>();
  const stats = useQuery({ ...statsQuery(runId ?? ''), enabled: runId !== undefined });

  // Not reachable through the router — the route cannot match without both.
  if (runId === undefined || name === undefined) {
    return (
      <Link to="/runs" className="underline">
        Back to all runs
      </Link>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      {/* The name the reader clicked, so the page is recognisably the one they
          asked for. Rendered as text through React, which escapes it: this is a
          request name out of an uploaded simulation log, i.e. a string an
          ingesting client controls. */}
      <h1 className="text-2xl font-semibold">{name}</h1>
      <Link to={`/runs/${encodeURIComponent(runId)}`} className="underline">
        Back to this run
      </Link>
    </div>
  );
}
```

- [ ] **Step 4: Run the test**

```bash
pnpm vitest run apps/web/test/RequestDetail.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Point the route at the page**

In `apps/web/src/App.tsx`, add the import and replace the request route element:

```tsx
import RequestDetail from './routes/RequestDetail';
```

```tsx
          <Route path="/runs/:runId/requests/:name" element={<RequestDetail />} />
```

Leave the `/groups/:name` route on `DetailPlaceholder` — piece 4 replaces it —
and leave the block comment above them intact: it explains the single-segment
encoding both routes still rely on.

- [ ] **Step 6: Verify and commit**

```bash
pnpm typecheck && pnpm lint && pnpm test:unit
```

```bash
git add apps/web/src/routes/RequestDetail.tsx apps/web/src/App.tsx apps/web/test/RequestDetail.test.tsx
git commit -m "feat(web): the request detail page shell, routed and named"
```

---

## Task 4: RQ-01 — the request's statistics, full column set

**Files:**
- Modify: `apps/web/src/tables/StatisticsTable.tsx:100`, `:402-411`
- Create: `apps/web/src/tables/RequestStatistics.tsx`
- Modify: `apps/web/src/routes/RequestDetail.tsx`
- Create: `apps/web/test/RequestStatistics.test.tsx`

**Interfaces:**
- Consumes: `requestRow` (Task 3).
- Produces: from `StatisticsTable.tsx`, `export type { Column }` and
  `export function columnsFor(rows: readonly StatRow[]): { executions: readonly Column[]; responseTime: readonly Column[] }`;
  and `RequestStatistics`, taking `{ row: StatRow; rows: readonly StatRow[] }`.

**Why a shared column model rather than a second one:** §A.5's column set is the
same on both pages, and the percentile columns are *derived from the payload*
(`percentileColumnsOf`), not hard-coded — a project configured with different
percentiles must move both tables together. Two independent definitions is how a
table comes to render Mean under the Std Dev heading, which is the exact failure
the `Column` interface's own comment at `:96` was written to prevent.

**Why not reuse `Row`:** it renders a `<tr>` that expects tree context — a
depth, an expand toggle, a link to itself. One row has no children to expand and
is already on the page it would link to.

- [ ] **Step 1: Write the failing test**

Create `apps/web/test/RequestStatistics.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import RequestStatistics from '../src/tables/RequestStatistics';
import fixture from './fixtures/reference-run.json';

const stats = fixture.stats as { stats: Parameters<typeof RequestStatistics>[0]['rows'] };
const row = stats.stats.find((r) => r.scope === 'request' && r.name === 'Catalog/List Products')!;

describe('RequestStatistics', () => {
  it('renders the payload’s own percentile columns, not a hard-coded set', () => {
    render(<RequestStatistics row={row} rows={stats.stats} />);
    // Derived from the payload: a project configured with different
    // percentiles must move this table with it.
    for (const key of Object.keys(row.percentiles)) {
      expect(screen.getByRole('columnheader', { name: new RegExp(key, 'i') })).toBeInTheDocument();
    }
  });

  it('renders counts against their own headings', () => {
    render(<RequestStatistics row={row} rows={stats.stats} />);
    const total = screen.getByTestId('request-stat-count');
    expect(total).toHaveAttribute('data-value', String(row.count));
  });

  it('carries the unrounded value beside the rounded display', () => {
    render(<RequestStatistics row={row} rows={stats.stats} />);
    // Rounding is a DISPLAY decision; the payload's value stays assertable.
    const mean = screen.getByTestId('request-stat-meanMs');
    expect(mean).toHaveAttribute('data-value', String(row.meanMs));
    expect(mean).toHaveTextContent(String(Math.round(row.meanMs)));
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm vitest run apps/web/test/RequestStatistics.test.tsx
```

Expected: FAIL — cannot resolve `../src/tables/RequestStatistics`.

- [ ] **Step 3: Export the column model**

In `apps/web/src/tables/StatisticsTable.tsx`, export the interface at `:100`:

```ts
export interface Column {
```

and add, immediately after the `TRAILING_TIME_COLUMNS` declaration, a builder
the table and the request page share:

```ts
/**
 * §A.5's column set, with the percentile columns DERIVED FROM THE ROWS rather
 * than declared — `percentileColumnsOf` reads the keys the payload actually
 * carries, so a project configured with a different `K-03` set moves every
 * table that calls this.
 *
 * Shared with the request detail page (RQ-01), which shows one row with these
 * same columns. Two independent definitions of "the column set" is how a table
 * comes to render Mean under the Std Dev heading.
 */
export function columnsFor(rows: readonly StatRow[]): {
  readonly executions: readonly Column[];
  readonly responseTime: readonly Column[];
} {
  const percentiles = percentileColumnsOf(rows);
  return {
    executions: EXECUTION_COLUMNS,
    responseTime: [MIN_COLUMN, ...percentiles, ...TRAILING_TIME_COLUMNS],
  };
}
```

Then rewrite the `useMemo` at `:402` to use it, so there is one definition:

```ts
  const columns = useMemo(() => {
    const rendered = [...(total === null ? [] : [total]), ...flatten(tree).map((r) => r.row)];
    const { executions, responseTime } = columnsFor(rendered);
    return {
      executions,
      responseTime,
      worstFirst: worstFirstColumn(percentileColumnsOf(rendered)),
    };
  }, [tree, total]);
```

- [ ] **Step 4: Write the component**

Create `apps/web/src/tables/RequestStatistics.tsx`:

```tsx
import type { StatRow } from '@perfportal/contracts';
import { useId, useMemo } from 'react';
import { columnsFor, type Column } from './StatisticsTable';

/**
 * §13.3 ① — one request's statistics, in §A.5's full column set (RQ-01).
 *
 * ONE ROW, SAME COLUMNS. The columns come from `columnsFor` rather than from a
 * list here, so the percentile columns are the ones the payload carries and
 * this page cannot drift from the run's own table.
 *
 * `rows` is the WHOLE payload's rows, not just this one: the percentile column
 * set is a property of the run, and deriving it from a single row would hide a
 * column that row happens to have no value for.
 */
export default function RequestStatistics({
  row,
  rows,
}: {
  readonly row: StatRow;
  readonly rows: readonly StatRow[];
}) {
  const headingId = useId();
  const { executions, responseTime } = useMemo(() => columnsFor(rows), [rows]);
  const columns: readonly Column[] = [...executions, ...responseTime];

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <h2 id={headingId} className="text-xl font-semibold">
        Statistics
      </h2>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c.column} scope="col" title={c.hint} className="text-left font-medium">
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              {columns.map((c) => {
                const value = c.value(row);
                return (
                  <td
                    key={c.column}
                    data-column={c.column}
                    data-testid={`request-stat-${c.column}`}
                    // The UNROUNDED value, beside the rounded display — so
                    // rounding stays a display decision and every cell is
                    // assertable against the payload.
                    data-value={value === undefined ? undefined : String(value)}
                  >
                    {/* undefined is not zero: this row HAS no value here. */}
                    {value === undefined ? '—' : c.format(value)}
                  </td>
                );
              })}
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  );
}
```

- [ ] **Step 5: Run the test**

```bash
pnpm vitest run apps/web/test/RequestStatistics.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Mount it, and say so when the request is not in the run**

In `apps/web/src/routes/RequestDetail.tsx`, beneath the heading:

```tsx
      {stats.data !== undefined ? (
        (() => {
          const row = requestRow(stats.data, name);
          // A name that is not in the run is a link from a stale tab or a
          // hand-edited URL. Saying so is the whole deliverable — an empty
          // page would read as a request that ran and recorded nothing.
          return row === undefined ? (
            <p role="status">This run recorded no request named {name}.</p>
          ) : (
            <RequestStatistics row={row} rows={stats.data.stats} />
          );
        })()
      ) : null}
```

- [ ] **Step 7: Verify and commit**

```bash
pnpm typecheck && pnpm lint && pnpm test:unit
```

```bash
git add apps/web/src/tables/StatisticsTable.tsx apps/web/src/tables/RequestStatistics.tsx apps/web/src/routes/RequestDetail.tsx apps/web/test/RequestStatistics.test.tsx
git commit -m "feat(web): RQ-01, one request's statistics in the full column set"
```

---

## Task 5: RQ-02 — indicator bands for one request

**Files:**
- Modify: `apps/web/src/charts/transforms/indicators.ts:111-155`
- Modify: `apps/web/src/charts/IndicatorsChart.tsx:23`
- Modify: `apps/web/src/routes/RequestDetail.tsx`
- Modify: `apps/web/test/transforms.indicators.test.ts`

**Interfaces:**
- Consumes: `requestRow` from Task 3; `StatRow.indicators` (`StatRowSchema:34`).
- Produces: `toRequestIndicators(stats: StatsResponse, path: string): ChartData`,
  and `IndicatorsChart` gaining an optional `path?: string` prop.

**The key fact:** `toIndicators` currently reads `stats.indicators`, which is
the response-level field and is the **run** row's bands
(`MetricsController:132`). Per-row bands already exist on every row, so this is
a transform refactor, not backend work.

- [ ] **Step 1: Write the failing test**

Append to `apps/web/test/transforms.indicators.test.ts`:

```ts
describe('toRequestIndicators', () => {
  it('folds one request’s own bands, not the run’s', () => {
    const data = toRequestIndicators(stats, 'Catalog/List Products');
    const row = stats.stats.find(
      (r) => r.scope === 'request' && r.name === 'Catalog/List Products',
    )!;
    const total =
      row.indicators.under + row.indicators.between + row.indicators.over + row.indicators.failed;

    // The counts are the ROW's. Against the run's they would be larger, which
    // is the whole failure this test exists to catch.
    expect(data.rows.map((r) => r.values[0])).toEqual([
      row.indicators.under,
      row.indicators.between,
      row.indicators.over,
      row.indicators.failed,
    ]);
    expect(total).toBeLessThan(
      stats.indicators.under +
        stats.indicators.between +
        stats.indicators.over +
        stats.indicators.failed,
    );
  });

  it('labels the axis with the request, not "All requests"', () => {
    const data = toRequestIndicators(stats, 'Catalog/List Products');
    expect(data.axisLabels).toEqual(['Catalog/List Products']);
  });

  it('keeps the bounds and the fixed-bands caveat, which are the response’s', () => {
    const data = toRequestIndicators(stats, 'Catalog/List Products');
    // Bounds are a PROJECT setting on the response, not a property of a row —
    // a per-request transform that stopped reading them would silently label
    // the bands with defaults.
    expect(data.rows[0]?.label).toContain(String(stats.bounds.lowerMs));
  });

  it('is empty, with a reason, for a request the run never recorded', () => {
    const data = toRequestIndicators(stats, 'Nope/Not Here');
    expect(data.series).toEqual([]);
    expect(data.empty).toContain('Nope/Not Here');
  });
});
```

Add `toRequestIndicators` to the existing import at the top of the file.

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm vitest run apps/web/test/transforms.indicators.test.ts -t toRequestIndicators
```

Expected: FAIL — `toRequestIndicators is not a function`.

- [ ] **Step 3: Extract the band core and add the request-scoped caller**

In `apps/web/src/charts/transforms/indicators.ts`, replace the body of
`toIndicators` (`:111-155`) with a shared core plus two callers. Keep the whole
existing doc comment on `toIndicators` — it explains the bounds rule and the
percentage denominator, and both still apply.

```ts
/**
 * The bands, for whichever subject the caller names.
 *
 * `bands` is a row's or the response's `IndicatorBands`; `axisLabel` is the one
 * category the stacked bar is drawn against; `empty` is what to say when there
 * is nothing to fold. The BOUNDS and the fixed-bands caveat always come from
 * the RESPONSE — they are a project setting and a property of the run's
 * storage, never of a row.
 */
function bandChart(
  bands: StatsResponse['indicators'],
  stats: StatsResponse,
  axisLabel: string,
  empty: string,
): ChartData {
  const counts = BANDS.map((band) => bands[band.key]);
  const labels = BANDS.map((band) => band.label(stats.bounds));
  const total = counts.reduce((sum, count) => sum + count, 0);

  const limitation = stats.configurable
    ? undefined
    : `These bands are fixed at ${stats.bounds.lowerMs} ms and ${stats.bounds.higherMs} ms. ` +
      'This run was recorded before response times were stored as a histogram, so its bands ' +
      'were folded once and will not change if the project’s indicator bounds change.';

  if (total <= 0) {
    return {
      series: [],
      axisLabels: [],
      columns: [...BAND_COLUMNS],
      rows: [],
      empty,
      limitation,
    };
  }

  const rows: ChartTableRow[] = labels.map((label, i) => ({
    label,
    values: [counts[i]!, percent(counts[i]!, total)],
  }));

  return {
    series: labels.map((name, i) => ({ name, data: [counts[i]!] })),
    axisLabels: [axisLabel],
    columns: [...BAND_COLUMNS],
    rows,
    limitation,
  };
}

export function toIndicators(stats: StatsResponse): ChartData {
  return bandChart(
    stats.indicators,
    stats,
    ALL_REQUESTS,
    'No requests were recorded for this run, so there are no response-time bands to show.',
  );
}

/**
 * §13.3 ② — the same bands, folded for ONE request.
 *
 * Reads the ROW's own `indicators`, which the API computes per row
 * (`MetricsController:116`). Reading `stats.indicators` here instead would draw
 * the whole run's bands under a request's heading — a mistake nothing on the
 * chart would look wrong for, which is why the unit test compares the two
 * totals rather than merely checking the shape.
 */
export function toRequestIndicators(stats: StatsResponse, path: string): ChartData {
  const row = stats.stats.find((r) => r.scope === 'request' && r.name === path);
  if (row === undefined) {
    return bandChart(
      { under: 0, between: 0, over: 0, failed: 0 },
      stats,
      path,
      `This run recorded no request named ${path}, so there are no response-time bands to show.`,
    );
  }
  return bandChart(
    row.indicators,
    stats,
    path,
    `No requests were recorded for ${path}, so there are no response-time bands to show.`,
  );
}
```

- [ ] **Step 4: Run the test**

```bash
pnpm vitest run apps/web/test/transforms.indicators.test.ts
```

Expected: PASS, including the pre-existing run-scope tests — `toIndicators`
behaviour is unchanged.

- [ ] **Step 5: Let the chart component take a path**

In `apps/web/src/charts/IndicatorsChart.tsx`, replace the signature at `:23`:

```tsx
export default function IndicatorsChart({
  stats,
  path,
}: {
  readonly stats: StatsResponse;
  /** Present on the request detail page; absent on the run's own overview. */
  readonly path?: string;
}) {
  const data = useMemo(
    () => (path === undefined ? toIndicators(stats) : toRequestIndicators(stats, path)),
    [stats, path],
  );
```

Add `toRequestIndicators` to the import from `./transforms/indicators`. Leave
the `title` as `Response time ranges` — the request page's heading already names
the request, and a title repeating it would be read twice by a screen reader.

- [ ] **Step 6: Mount it on the page**

In `apps/web/src/routes/RequestDetail.tsx`, add the import and render it under
the heading, inside the existing `<div className="flex flex-col gap-8">`:

```tsx
      {stats.data !== undefined ? <IndicatorsChart stats={stats.data} path={name} /> : null}
```

- [ ] **Step 7: Verify and commit**

```bash
pnpm typecheck && pnpm lint && pnpm test:unit
```

```bash
git add apps/web/src/charts/transforms/indicators.ts apps/web/src/charts/IndicatorsChart.tsx apps/web/src/routes/RequestDetail.tsx apps/web/test/transforms.indicators.test.ts
git commit -m "feat(web): RQ-02, indicator bands folded for one request"
```

---

## Task 6: RQ-03, RQ-05, RQ-07, RQ-08 — the reused charts at request scope

**Files:**
- Modify: `apps/web/src/charts/RatesChart.tsx:59-80`
- Modify: `apps/web/src/routes/RequestDetail.tsx`
- Modify: `apps/web/test/RequestDetail.test.tsx`

**Interfaces:**
- Consumes: `seriesQuery(id, scope, name)` (`metrics.ts:75`) and
  `distributionQuery(id, scope, name, family)` (`metrics.ts:116`), both already
  taking scope and name.
- Produces: `RequestRateChart` and `ResponseRateChart` gain an optional
  `title?: string`. `DistributionChart` and `PercentilesChart` are unchanged.

**The key fact:** the transforms take a payload, not a scope. `toDistribution`,
`toPercentiles`, `toRequestRate` and `toResponseRate` are correct at request
scope with no change. If one of them appears to need a request-scope branch,
that is a signal the transform boundary is wrong — raise it, do not add a prop.

**The one thing that is NOT pure reuse: the two rate charts are titled
differently on this page.** Verified against the reference report
(`fixtures/gatling-3.15.1.2/reference-report/req_search--1822469688.html`),
which titles them **`Number of requests`** and **`Number of responses`** where
the global page says "Requests per second over time" and "Responses per second
over time". Same data, same transform, different heading — so the title becomes
a prop rather than the components being forked.

- [ ] **Step 1: Write the failing test**

Append to `apps/web/test/RequestDetail.test.tsx`:

```tsx
  it('asks for series and distribution at REQUEST scope, with the name', () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', (input: RequestInfo) => {
      urls.push(String(input));
      return Promise.resolve(new Response('{}', { status: 500 }));
    });

    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter initialEntries={['/runs/r1/requests/Catalog%2FList%20Products']}>
          <Routes>
            <Route path="/runs/:runId/requests/:name" element={<RequestDetail />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    // BOTH parameters on every scoped call. `?name=X` without `scope` is
    // silently ignored and answers with the RUN's totals — a 200 carrying the
    // wrong subject, which no status check would catch.
    const scoped = urls.filter((u) => u.includes('/series') || u.includes('/distribution'));
    expect(scoped.length).toBeGreaterThan(0);
    for (const url of scoped) {
      expect(url).toContain('scope=request');
      expect(url).toContain(`name=${encodeURIComponent('Catalog/List Products')}`);
    }
  });
```

Add `vi` to the vitest import.

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm vitest run apps/web/test/RequestDetail.test.tsx -t 'REQUEST scope'
```

Expected: FAIL — `expected 0 to be greater than 0`; the page issues no scoped
calls yet.

- [ ] **Step 3: Let the two rate charts be titled by their caller**

In `apps/web/src/charts/RatesChart.tsx`, give each wrapper an optional title.
The run detail page passes nothing and keeps its current heading:

```tsx
/**
 * `title` is a prop because the REQUEST detail page titles this chart
 * differently — Gatling's own request pages head it "Number of requests" where
 * the global page says "Requests per second over time" (§13.3 ⑦). The data,
 * the transform and the axis are identical; only the heading differs, so this
 * is one component with two names rather than two components.
 */
export function RequestRateChart({
  series,
  title = 'Requests per second over time',
}: {
  readonly series: SeriesResponse;
  readonly title?: string;
}) {
```

with `title={title}` replacing the hard-coded string at `:64`. Do the same for
`ResponseRateChart`, defaulting to `'Responses per second over time'`.

- [ ] **Step 4: Add the queries and the charts**

In `apps/web/src/routes/RequestDetail.tsx`, add the queries beside the existing
`stats` query:

```tsx
  const series = useQuery({
    ...seriesQuery(runId ?? '', 'request', name ?? ''),
    enabled: runId !== undefined && name !== undefined,
  });
  const distribution = useQuery({
    ...distributionQuery(runId ?? '', 'request', name ?? '', 'response_time'),
    enabled: runId !== undefined && name !== undefined,
  });
```

and render the four charts beneath `IndicatorsChart`:

```tsx
      {distribution.data !== undefined ? (
        <DistributionChart distribution={distribution.data} />
      ) : null}
      {series.data !== undefined ? (
        <>
          <PercentilesChart series={series.data} />
          {/* Gatling's own titles for these two on a request page. */}
          <RequestRateChart series={series.data} title="Number of requests" />
          <ResponseRateChart series={series.data} title="Number of responses" />
        </>
      ) : null}
```

Import the four components and the two query factories.

- [ ] **Step 5: Run the test**

```bash
pnpm vitest run apps/web/test/RequestDetail.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Verify and commit**

```bash
pnpm typecheck && pnpm lint && pnpm test:unit
```

```bash
git add apps/web/src/charts/RatesChart.tsx apps/web/src/routes/RequestDetail.tsx apps/web/test/RequestDetail.test.tsx
git commit -m "feat(web): RQ-03/05/07/08, the reused charts at request scope"
```

---

## Task 7: RQ-11 — errors for this request

**Files:**
- Modify: `apps/web/src/routes/RequestDetail.tsx`
- Modify: `apps/web/test/RequestDetail.test.tsx`

**Interfaces:**
- Consumes: `errorsQuery(id, scope, name)` (`metrics.ts:175`), `ErrorsTable`
  (`tables/ErrorsTable.tsx:71`, prop `errors: ErrorsResponse`).
- Produces: nothing new.

**The trap, restated because this page is its first real caller:**
`?name=Search` **without** `scope` is silently ignored — `MetricsController`
forces `name` to `''` when `scope` is absent, so the call returns the whole
run's errors with a 200 and no signal that the filter was dropped. Both
parameters, always. The test below asserts the omission fails, not merely that
the correct call works.

- [ ] **Step 1: Write the failing test**

Append to `apps/web/test/RequestDetail.test.tsx`:

```tsx
  it('asks for errors at request scope, so the table is this request’s', () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', (input: RequestInfo) => {
      urls.push(String(input));
      return Promise.resolve(new Response('{}', { status: 500 }));
    });

    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter initialEntries={['/runs/r1/requests/Catalog%2FList%20Products']}>
          <Routes>
            <Route path="/runs/:runId/requests/:name" element={<RequestDetail />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    const errors = urls.filter((u) => u.includes('/errors'));
    expect(errors).toHaveLength(1);
    // Asserting BOTH is the point. `name` alone is the silently-ignored form:
    // it answers 200 with the run's totals, which looks like a working page
    // showing a request with implausibly many errors.
    expect(errors[0]).toContain('scope=request');
    expect(errors[0]).toContain(`name=${encodeURIComponent('Catalog/List Products')}`);
  });
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm vitest run apps/web/test/RequestDetail.test.tsx -t 'errors at request scope'
```

Expected: FAIL — `expected [] to have a length of 1`.

- [ ] **Step 3: Add the query and the table**

In `apps/web/src/routes/RequestDetail.tsx`:

```tsx
  const errors = useQuery({
    ...errorsQuery(runId ?? '', 'request', name ?? ''),
    enabled: runId !== undefined && name !== undefined,
  });
```

and beneath the charts:

```tsx
      {errors.data !== undefined ? <ErrorsTable errors={errors.data} /> : null}
```

- [ ] **Step 4: Run the test**

```bash
pnpm vitest run apps/web/test/RequestDetail.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Verify and commit**

```bash
pnpm typecheck && pnpm lint && pnpm test:unit
```

```bash
git add apps/web/src/routes/RequestDetail.tsx apps/web/test/RequestDetail.test.tsx
git commit -m "feat(web): RQ-11, errors scoped to this request"
```

---

## Task 8: RQ-09 — the saturation scatter

**Files:**
- Create: `apps/web/src/charts/transforms/scatter.ts`
- Create: `apps/web/src/charts/ScatterChart.tsx`
- Modify: `apps/web/src/charts/Chart.tsx:51`, `:311-326`, `:344-356`
- Modify: `apps/web/src/api/metrics.ts`
- Modify: `apps/web/src/routes/RequestDetail.tsx`
- Create: `apps/web/test/transforms.scatter.test.ts`

**Interfaces:**
- Consumes: `ScatterResponse` (`packages/contracts/src/metrics.ts:161`) — `ok`
  and `ko`, each `[x, y][]` where x is global requests/s and y is the truncated
  p95. `GET /v1/runs/:id/scatter?name=X` (`ParityController:94`) — **`name`
  only, no `scope`**.
- Produces: `scatterQuery(id, name)`, `toScatter(s: ScatterResponse): ChartData`,
  `ScatterChart`.

**Three facts that decide the implementation:**

1. **It is one point per second, not one per request.** x is the *global*
   requests/s across the whole run, both statuses combined; y is that bucket's
   truncated p95 for this request. The two series are independent status
   filters, not a split of one.
2. **`ChartSeries.data` already supports `[x, y]` pairs** — `types.ts:32`
   provides for "charts whose x is a measured quantity rather than a category".
   Only the renderer needs extending.
3. **Two points will disagree with Gatling. Do not fix them.** Deviation D-03:
   our bucketing floors, Gatling rounds to nearest, because floor is
   scale-consistent and nearest breaks AC-STAT-2's lossless-coalescing
   invariant. Measured: `Add To Cart` 48 points vs 47, `Place Order` 53 vs 54;
   KO exact on both. A test that "corrects" this reintroduces a reverted change.

- [ ] **Step 1: Write the failing transform test**

Create `apps/web/test/transforms.scatter.test.ts`:

```ts
import { ScatterResponseSchema } from '@perfportal/contracts';
import { describe, expect, it } from 'vitest';
import { toScatter } from '../src/charts/transforms/scatter';
import fixture from './fixtures/reference-run.json';

const scatter = ScatterResponseSchema.parse(fixture.scatter);

describe('toScatter', () => {
  it('plots one point per bucket as an [x, y] pair', () => {
    const data = toScatter(scatter);
    const ok = data.series.find((s) => s.name === 'OK')!;
    expect(ok.data).toEqual(scatter.ok);
  });

  it('keeps OK and KO as independent series, not a split of one', () => {
    const data = toScatter(scatter);
    expect(data.series.map((s) => s.name)).toEqual(['OK', 'KO']);
  });

  it('tables every point, because the table is the parity surface', () => {
    const data = toScatter(scatter);
    expect(data.rows).toHaveLength(scatter.ok.length + scatter.ko.length);
    expect(data.columns).toEqual(['Series', 'Requests per second', 'p95 (ms)']);
  });

  it('says why it is empty rather than drawing empty axes', () => {
    const data = toScatter({ ...scatter, ok: [], ko: [] });
    expect(data.series).toEqual([]);
    expect(data.empty).toBeDefined();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm vitest run apps/web/test/transforms.scatter.test.ts
```

Expected: FAIL — cannot resolve `../src/charts/transforms/scatter`.

- [ ] **Step 3: Write the transform**

Create `apps/web/src/charts/transforms/scatter.ts`:

```ts
import type { ScatterResponse } from '@perfportal/contracts';
import type { StatusRole } from '../theme';
import type { ChartData, ChartTableRow } from '../types';

/**
 * §13.3 ⑨ — response time against global requests/s (Appendix A RQ-09).
 *
 * ONE POINT PER SECOND, NOT ONE PER REQUEST. x is the GLOBAL requests/s across
 * the whole run with both statuses combined; y is this request's truncated p95
 * within that bucket. §A.9 F-7 records the earlier misreading — a per-request
 * scatter — which the fixture alone could not falsify, because p75 through max
 * coincide on all seven request pages at ~3 requests/second.
 *
 * OK AND KO ARE INDEPENDENT STATUS FILTERS, not a decomposition of one series,
 * so they are never stacked and their points do not pair up by index.
 *
 * TWO POINTS DISAGREE WITH GATLING ON THE REFERENCE RUN AND THAT IS DELIBERATE
 * (deviation D-03): our bucketing floors an observation into its bucket where
 * Gatling rounds to nearest. Floor is scale-consistent, and nearest breaks the
 * lossless-coalescing invariant AC-STAT-2 depends on. Measured cost: `Add To
 * Cart` 48 points against Gatling's 47, `Place Order` 53 against 54; KO counts
 * exact on both.
 */
export const SCATTER_ROLES: readonly StatusRole[] = ['passed', 'failed'];

const SCATTER_COLUMNS = ['Series', 'Requests per second', 'p95 (ms)'] as const;

export function toScatter(s: ScatterResponse): ChartData {
  const rows: ChartTableRow[] = [
    ...s.ok.map(([x, y]): ChartTableRow => ({ label: 'OK', values: [x, y] })),
    ...s.ko.map(([x, y]): ChartTableRow => ({ label: 'KO', values: [x, y] })),
  ];

  if (rows.length === 0) {
    return {
      series: [],
      // No axis labels: x is a measured quantity, so the axis is numeric and
      // has no categories to name.
      axisLabels: [],
      columns: [...SCATTER_COLUMNS],
      rows: [],
      empty:
        'No response times were recorded for this request, so there is nothing to plot against ' +
        'the run’s throughput.',
    };
  }

  return {
    series: [
      { name: 'OK', data: s.ok },
      { name: 'KO', data: s.ko },
    ],
    axisLabels: [],
    columns: [...SCATTER_COLUMNS],
    rows,
  };
}
```

- [ ] **Step 4: Run the transform test**

```bash
pnpm vitest run apps/web/test/transforms.scatter.test.ts
```

Expected: PASS.

- [ ] **Step 5: Teach `Chart` a scatter kind**

In `apps/web/src/charts/Chart.tsx`, widen the union at `:51`:

```ts
  readonly kind?: 'line' | 'bar' | 'pie' | 'scatter';
```

Add a numeric x axis beside `categoryAxis` and `valueAxis` (after `:255`):

```ts
    /**
     * A scatter's x is a MEASURED QUANTITY, not a category — its series carry
     * explicit [x, y] pairs rather than one value per label, so a category axis
     * would index them by position and draw the run's throughput as 0, 1, 2…
     */
    const numericAxis = {
      type: 'value' as const,
      name: xAxisName,
      nameLocation: 'middle' as const,
      nameGap: 28,
      nameTextStyle: axisText,
      axisLabel: axisText,
      axisLine: { lineStyle: { color: theme.gridline } },
      splitLine: { show: false },
    };
```

In the grid/axis block at `:311`, use it when the kind is `scatter`:

```ts
              ...(horizontal
                ? { xAxis: valueAxis, yAxis: categoryAxis }
                : { xAxis: kind === 'scatter' ? numericAxis : categoryAxis, yAxis: valueAxis }),
```

And in the series builder at `:344`, show the symbols — a scatter with
`showSymbol: false` draws nothing at all:

```ts
          return {
            type: kind,
            name,
            stack: stacked ? 'total' : undefined,
            data: [...source.data],
            lineStyle: { width: 2 },
            symbolSize: 8,
            // A scatter IS its symbols. `showSymbol: false` — right for a
            // 600-bucket line — draws an empty grid here.
            showSymbol: kind === 'scatter' ? true : false,
          };
```

- [ ] **Step 6: Add the query factory**

In `apps/web/src/api/metrics.ts`, after the errors block:

```ts
/* -------------------------------------------------------------------- *
 * scatter — response time against global throughput ⑨ (RQ-09)
 * -------------------------------------------------------------------- */

export const scatterQueryKey = (id: string, name: string) =>
  ['run', id, 'scatter', name] as const;

/**
 * REQUEST-SCOPED BY CONSTRUCTION. Unlike `/errors` and `/series`, this endpoint
 * takes `name` and no `scope` — a run-wide saturation scatter is not a thing
 * §13.3 defines — so the `?name=` trap documented above cannot arise here:
 * there is no scope parameter to omit.
 */
export const scatterQuery = (id: string, name: string) => ({
  queryKey: scatterQueryKey(id, name),
  queryFn: () =>
    apiFetch(
      ScatterResponseSchema,
      `${runPath(id)}/scatter?name=${encodeURIComponent(name)}`,
    ),
});
```

Add `ScatterResponseSchema` to the existing `@perfportal/contracts` import.

- [ ] **Step 7: Write the chart component**

Create `apps/web/src/charts/ScatterChart.tsx`:

```tsx
import type { ScatterResponse } from '@perfportal/contracts';
import { useMemo } from 'react';
import Chart from './Chart';
import { SCATTER_ROLES, toScatter } from './transforms/scatter';

/**
 * §13.3 ⑨ — a transform and a title, like every other chart component.
 *
 * TAKES THE PAYLOAD, DOES NOT FETCH IT (design §6). `RequestDetail` runs the
 * one `scatterQuery` and hands the response here.
 */
export default function ScatterChart({ scatter }: { readonly scatter: ScatterResponse }) {
  const data = useMemo(() => toScatter(scatter), [scatter]);

  return (
    <Chart
      id="scatter"
      title="Response time against global requests per second"
      data={data}
      kind="scatter"
      // OK and KO mean an outcome, so they wear the status tokens rather than
      // the categorical palette — the same rule DistributionChart follows.
      roles={SCATTER_ROLES}
      xAxis={{ name: 'Requests per second (all requests)' }}
      yAxis={{ name: 'p95 response time (ms)' }}
    />
  );
}
```

Both props are `{ name?: string }` (`ChartYAxis` at `Chart.tsx:13` also takes a
`type`, defaulted here). One doc comment needs widening: `ChartXAxis` at `:41`
says it "names the CATEGORY axis — `axisLabels`", which a scatter has none of.
Append to it:

```ts
 * A `scatter` has no categories: its x is a measured quantity and its series
 * carry explicit [x, y] pairs, so this names the numeric horizontal axis
 * instead. Same prop, same position on screen, different axis type underneath.
```

- [ ] **Step 8: Mount it on the page**

In `apps/web/src/routes/RequestDetail.tsx`:

```tsx
  const scatter = useQuery({
    ...scatterQuery(runId ?? '', name ?? ''),
    enabled: runId !== undefined && name !== undefined,
  });
```

```tsx
      {scatter.data !== undefined ? <ScatterChart scatter={scatter.data} /> : null}
```

- [ ] **Step 9: Verify and commit**

```bash
pnpm typecheck && pnpm lint && pnpm test:unit
```

```bash
git add apps/web/src/charts/transforms/scatter.ts apps/web/src/charts/ScatterChart.tsx apps/web/src/charts/Chart.tsx apps/web/src/api/metrics.ts apps/web/src/routes/RequestDetail.tsx apps/web/test/transforms.scatter.test.ts
git commit -m "feat(web): RQ-09, the saturation scatter"
```

---

## Task 9: e2e — the page mounts, and an encoded URL survives a hard load

**Files:**
- Create: `apps/web/e2e/request-detail.spec.ts`

**Interfaces:**
- Consumes: `seedAdmin`, `seedRunWithData` (`apps/web/e2e/fixtures.ts:184`,
  `:214`), `signIn` (`apps/web/e2e/helpers.ts:17`).
- Produces: nothing.

**The one that matters most:** `%2F` survives client-side navigation because
`pushState` never touches it, so a click-through test passes whatever the
server does. Only `page.goto()` on an encoded URL exercises the server path —
`mountSpa` (`apps/api/src/spa.ts:42`) reads a `req.path` Express does not
percent-decode, `express.static` misses, and the fallback serves `index.html`.
That is two dependencies' behaviour, not ours, and a proxy in front can undo
it. If this test is skipped, the failure mode in production is a reader
clicking a nested request and landing silently on `/runs`.

- [ ] **Step 1: Write the spec**

Create `apps/web/e2e/request-detail.spec.ts`:

```ts
import { expect, test } from '@playwright/test';
import { seedAdmin, seedRunWithData } from './fixtures.js';
import { signIn } from './helpers.js';

/**
 * §13.3 in a real browser.
 *
 * WHAT ONLY EXISTS HERE. The unit suites pin the transforms and the scoped
 * URLs in jsdom. What they cannot reach is the MOUNT — that the page fetches
 * all five payloads, that the charts draw, and above all that an ENCODED
 * request path survives a hard load through the real server.
 */

const NESTED = 'Catalog/List Products';

test('a nested request page loads from a pasted URL, not just a click', async ({ page }) => {
  const admin = await seedAdmin();
  const runId = await seedRunWithData(admin.orgId);
  await signIn(page, admin);

  // goto, NOT a click. A click is pushState and never reaches the server, so it
  // passes whether or not the server preserves %2F. This is the assertion.
  await page.goto(`/runs/${runId}/requests/${encodeURIComponent(NESTED)}`);

  await expect(page.getByRole('heading', { level: 1 })).toHaveText(NESTED);
  // The catch-all redirects an unmatched path to /runs, so a normalised %2F
  // shows up precisely here.
  expect(new URL(page.url()).pathname).not.toBe('/runs');
});

test('the row link from the statistics table reaches the same page', async ({ page }) => {
  const admin = await seedAdmin();
  const runId = await seedRunWithData(admin.orgId);
  await signIn(page, admin);
  await page.goto(`/runs/${runId}`);

  // D-10: this request nests, so its row is a CHILD and starts collapsed.
  await page.getByTestId('stat-row').filter({ hasText: 'Catalog' }).first().click();
  await page.getByRole('link', { name: 'List Products' }).click();

  await expect(page.getByRole('heading', { level: 1 })).toHaveText(NESTED);
});

test('every §13.3 element is on the page', async ({ page }) => {
  const admin = await seedAdmin();
  const runId = await seedRunWithData(admin.orgId);
  await signIn(page, admin);
  await page.goto(`/runs/${runId}/requests/${encodeURIComponent(NESTED)}`);

  // Located by the same `figure[data-testid^="chart-"]` convention
  // `run-charts.spec.ts:53` uses, and asserted by chart ID — the ids each
  // component passes to `Chart`, which are stable where titles are prose.
  for (const id of ['indicators', 'distribution', 'percentiles', 'scatter']) {
    await expect(page.getByTestId(`chart-${id}`)).toBeVisible();
    // The data table is the parity surface and must be present on every chart.
    await expect(page.getByTestId(`chart-data-${id}`)).toHaveCount(1);
  }

  // The request page titles its rate charts DIFFERENTLY from the global page,
  // as Gatling's own request pages do.
  await expect(page.getByText('Number of requests')).toBeVisible();
  await expect(page.getByText('Number of responses')).toBeVisible();
  await expect(page.getByText('Requests per second over time')).toHaveCount(0);

  // RQ-04, RQ-06 and RQ-10 do not exist: Gatling 3.15.1.2 reports no latency
  // (§A.9 F-2). A page that grew one would be beyond parity, not parity.
  await expect(page.getByText(/latency/i)).toHaveCount(0);
});
```

If the chart figures are not exposed with `role="figure"`, read
`apps/web/e2e/run-charts.spec.ts` and match the locator it already uses.

- [ ] **Step 2: Run the spec**

```bash
pnpm test:e2e apps/web/e2e/request-detail.spec.ts
```

Expected: PASS, 3 tests.

- [ ] **Step 3: Run the whole suite and commit**

```bash
pnpm typecheck && pnpm lint && pnpm test:unit && pnpm test:e2e
```

```bash
git add apps/web/e2e/request-detail.spec.ts
git commit -m "test(web): the request detail page in a browser, including a hard-loaded encoded URL"
```

---

## Falsification checkpoints

Run each one after Task 9. Break the code as named, confirm the named test
fails, then revert. A checkpoint that stays green is a test that is not
testing what it claims.

| # | Break this | This must fail |
|---|---|---|
| 1 | revert `engine.ts:171` to the bare `e.name` | requests nest under their groups in the statistics table |
| 2 | leave `engine.ts:147` counting bare names | the cap counts what is stored, not what is displayed |
| 3 | round RQ-09's p95 instead of truncating | the scatter matches ground truth |
| 4 | drop `scope` from the RQ-11 errors call, keeping `name` | request errors are a strict subset of the run's |
| 5 | render RQ-02 from `stats.indicators` instead of the row's | the bands are this request's, not the run's |
| 6 | serve an encoded request URL through a `%2F`-normalising proxy | a hard-loaded encoded URL reaches the page, not `/runs` |
| 7 | render the latency elements when the capability is absent | no latency chart appears for a Gatling run |
| 8 | drop the `title` props from the two rate charts, taking the defaults | the request page uses Gatling's request-page titles, not the global page's |
| 9 | render RQ-01 from a hard-coded percentile column list | the columns are the ones the payload carries |
| 10 | remove the D-13 leaf fallback from `evaluate.ts` | a rule targeting a bare request name is still checked |
| 11 | make the D-13 fallback pick the first ambiguous match | an ambiguous target is reported, not silently resolved |

Checkpoints 5, 6 and 8 are non-numeric — the spec's §8 requires at least two.
Checkpoint 6 is the one most likely to be waved through as environmental; it is
the one that loses a reader's run in production.

---

## Done when

A person clicks a request row in a run's statistics table and lands on a page
showing that request's own statistics, indicator bands, distribution,
percentiles over time, request and response rates, saturation scatter and
errors — reachable by pasting the URL as well as by clicking. Requests nest
under their groups for every newly ingested run. `pnpm typecheck`, `pnpm lint`,
`pnpm test:unit`, `pnpm test:integration` and `pnpm test:e2e` are green, and
every checkpoint above has been run and shown to fail as named.

D-10 moves from deferred to resolved in the ledger; D-12 is recorded.
