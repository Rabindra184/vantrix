# Group detail page (§13.4, GR-01…GR-09) — design

Piece 4 of the parity family, and the last of PRD §26 M3's rendering half.
Builds the page behind `/runs/:runId/groups/:name`, which the statistics table
has linked to since piece 2 and which `DetailPlaceholder` still answers.

---

## 1. Scope

Eight requirements survive in Appendix A. Six are built here; two are rendered
as stated gaps and filled by piece 5 (§4).

| | Built | Requirement |
|---|---|---|
| GR-01 | yes | Cumulated response time — full statistic set (§A.5) |
| GR-02 | yes | Group duration — full statistic set (§A.5) |
| GR-03 | yes | Cumulated response time — distribution |
| GR-05 | yes | Duration — distribution |
| GR-08 | yes | Nested groups rendered hierarchically |
| GR-09 | yes | Group indicators / ranges |
| GR-04 | **stated gap** | Cumulated response time — percentiles over time (OK only) |
| GR-06 | **stated gap** | Duration — percentiles over time (OK only) |

**GR-07 does not exist.** §A.9 F-4 records that the group page carries no
requests/responses-per-second charts, verified against the fixture's nested
`Catalog → Recommendations` group. Do not build them.

**Scenario detail is not in this piece.** §13.5 is a separate page and is
explicitly *beyond parity* — Gatling 3.15.1.2 has no scenario detail page
(§A.9 F-3) and no parity test asserts one. It is also not buildable today:
`MetricScope` declares `'scenario'` but `packages/statistics/src/engine.ts`
never emits it, so no scenario-scoped row or bucket exists.

---

## 2. What the reference report actually contains

Read from
`fixtures/gatling-3.15.1.2/reference-report/group_catalog--2074609671.html`:

```
RangesContainerId
groupCumulatedResponseTimeDistributionContainerId
groupCumulatedResponseTimeOverTimeContainerId
groupDurationDistributionContainerId
groupDurationOverTimeContainerId
container_errors
```

Five parity containers, matching F-4 exactly, plus an errors shell.

**`container_errors` is not in scope, for two independent reasons.** It has no
GR row, so it carries no parity obligation; and it is Gatling's standard
`sortable('#container_errors')` markup emitted on every page regardless of
content — `Catalog` has `failed: 0`, so it renders empty there. It would also
need engine work we are not doing: `errorsFor` is called for `'run'` and
`'request'` only, and the group branch at `engine.ts:128` `continue`s before
reaching it. Recorded so a later reader does not mistake its absence for an
oversight.

---

## 3. §13.4's prose is stale; Appendix A governs

The two disagree in three places. Appendix A wins — it is the corrected source,
where F-1…F-12 live, each written after checking the real report, and it is
what caught the non-existent latency charts and the scatter's true shape in
piece 3. §13.4 reads as written from expectation and never revised.

| | §13.4 prose | Appendix A | Built |
|---|---|---|---|
| Requests/s + responses/s | "applied to both cumulated and duration" | **GR-07 deleted** (F-4) | no |
| Child request breakdown | "member requests with contribution share" | no GR row | no |
| Group indicators / ranges | not mentioned | **GR-09**, "Exact" | yes |

**§13.4's prose is corrected in this piece's PR**, so the contradiction does not
outlive the decision. The child breakdown is dropped rather than deferred:
Gatling's group page has no such table, so building one would be beyond parity
in a piece whose entire purpose is parity.

---

## 4. Deviation D-14: GR-04 and GR-06 ship as stated gaps

**No group-scoped time series exist.** `seriesFor` is called exactly twice in
the engine — `engine.ts:172` for `'run'` and `:175` for `'request'`. The group
branch only calls `rollupFor` and `continue`s. There are no group buckets, so
there is nothing to draw percentiles over time from.

That is engine work: new buckets, persisted through `run_series_bucket`, and a
no-backfill story for every existing run. It is piece 5.

**Both charts still render, in their §13.4 positions, saying why they are
empty.** Piece 3 built exactly this mechanism —
`apps/web/src/routes/payload.tsx`'s `Payload` renders a chart's figure, heading
and data table with a stated reason in place of the drawing, because "a chart
whose fetch failed must not simply vanish… it removes that chart's data table,
which is the parity surface."

The same argument applies here and is stronger: §13.4's element order is itself
information, and a page silently missing two of five containers is
indistinguishable from a group whose percentiles were measured and found empty.
The wording must name the cause — the run has no group series recorded — not
merely report absence, which is the distinction `SPLIT_UNAVAILABLE` was written
to make for `started_ok_count`.

---

## 5. Everything on this page is doubled

A request carries one measure; a group carries two, and they diverge whenever
requests inside the group overlap. Measured on the fixture:

| Group | Cumulated mean | Duration mean |
|---|---|---|
| `Cart` | 141.1 ms | 224.7 ms |
| `Catalog` | 488.2 ms | 592.3 ms |
| `Catalog/Recommendations` | 241.8 ms | 242.5 ms |

So the page is two parallel families, each with a statistics row, a
distribution, and a percentiles-over-time. Nothing on the request page had this
shape, and it is the whole reason this piece is not a copy of piece 3.

`Catalog/Recommendations` is the near-degenerate case — its two families agree
to within 1 ms because its requests barely overlap. **Assertions that must
distinguish the families use `Cart` or `Catalog`, never `Recommendations`**, or
they pass against an implementation that fetched one family twice.

---

## 6. Reuse, and the one new thing

The data all exists. Histograms are stored per `(scope, name, family)` —
`packages/persistence/src/metrics/write.ts:53-69` persists `histogram_ok` and
`histogram_ko` on every stat row, and `RollupBuilder` builds them
unconditionally for every scope. The distribution endpoint already takes
`family` (`parity.controller.ts:30`). Every group row in the captured fixture
carries populated `indicators`.

- **GR-01/GR-02** — `RequestStatistics` (piece 3, Task 4) takes `{ row, rows }`
  and renders §A.5's set from `columnsFor`. A group row is a `StatRow`; this is
  that component called twice. It needs renaming, since it was never
  request-specific.
- **GR-03/GR-05** — two `distributionQuery` calls differing only in `family`.
  `DistributionChart` is unchanged.
- **GR-09** — `toRequestIndicators` folds a row's own `indicators` but finds
  that row itself, by a hardcoded `scope === 'request'`. **The lookup moves out
  of the transform**: it becomes `toRowIndicators(stats, row, label)`, taking an
  already-found row (or `undefined`) and the axis label to draw it against.
  Bounds and the fixed-bands caveat still come from the response, never the row.
  `toRequestIndicators` becomes a two-line caller, so the request page is
  unchanged. Chosen over widening the predicate to a `(scope, family)` pair
  because a group needs three fields to identify a row and a transform that
  grows a third argument to find something the caller already has is the wrong
  boundary.
- **GR-08** — the route already carries a nested path as one encoded segment
  (`Catalog%2FRecommendations`), decided in piece 2 and unchanged. A nested
  group's page needs no special handling; the requirement is satisfied by
  identity, not by rendering.

**The new thing is the two-family page and its lookup.**

---

## 7. The lookup must match on three fields, not two

`requestRow(stats, path)` matches `scope` and `name`. A group has two rows under
one name, so `groupRow(stats, path, family)` must match **scope, name and
family**.

Matching on two would return whichever row `find` reaches first and render
cumulated numbers under the duration heading — with a plausible count, a
plausible mean, and nothing about the output looking wrong. This is the same
class of error as `requestRow` needing `scope` so a group named `Catalog` could
not answer for a request named `Catalog`, and it is why §9's first checkpoint
swaps the two families.

---

## 8. Architecture

```
apps/web/src/routes/
  GroupDetail.tsx        the page: fetches, composes, owns no chart internals
apps/web/src/tables/
  ScopedStatistics.tsx   RequestStatistics, renamed — it was never request-specific
```

`GroupDetail` composes existing components against `useParams().name` and
changes no chart internals. `DetailPlaceholder` is deleted: its `request`
branch went unreachable when piece 3 shipped, and this piece takes its last
route.

`IndicatorsChart`'s `path?: string` prop becomes `row?: StatRow` plus a `label`,
matching §6's `toRowIndicators` boundary: the page finds the row it wants, the
chart folds it. The run-scope call site passes neither and is unchanged.

---

## 9. Testing

The same three layers as pieces 1–3: pure transform tests against the captured
fixture, the rendered page in jsdom, Playwright for what only exists in a
browser.

**The discriminating unit assertion is that the two families render different
values.** Against `Cart` that is 141 vs 225. An implementation that fetched one
family twice, or matched the lookup on two fields, passes every shape-only test
and fails this one. Write it first.

`pnpm test:integration` is in the verification set for this piece, per
`CLAUDE.md` — piece 3's final review found four failing API assertions and a
silently vacuous tenancy control precisely because it was never run.

---

## 10. Falsification checkpoints

| # | Break this | This must fail |
|---|---|---|
| 1 | swap the cumulated and duration rows | each family's statistics are its own |
| 2 | match `groupRow` on scope and name only | the two families are distinct rows |
| 3 | drop `family` from the distribution call | each distribution is its own family's |
| 4 | render GR-04/GR-06 as empty axes | a missing chart says why it is missing |
| 5 | point `groupRow` at a request row of the same name | scope is part of the match |
| 6 | build the per-second charts §13.4's prose lists | no per-second chart appears at group scope (F-4) |
| 7 | assert families differ using `Catalog/Recommendations` | the assertion discriminates (it must not pass on a 1 ms delta) |

Checkpoints 4 and 6 are the non-numeric ones. Checkpoint 7 is a test of the
tests: it must be run against a *correct* implementation and shown to be
insensitive, which is what makes checkpoints 1 and 2 meaningful.

---

## 11. Success criteria

A person clicks a group row in a run's statistics table and lands on that
group's page, showing its cumulated and duration statistics side by side, both
distributions, its response-time bands, and — in their §13.4 positions — the two
percentiles-over-time charts stating that this run has no group series recorded.
A nested group reaches its own page by pasted URL as well as by clicking.
`pnpm typecheck`, `pnpm lint`, `pnpm test:unit`, `pnpm test:integration` and
`pnpm test:e2e` are green, and every checkpoint in §10 has been run and shown to
fail as named.

`DetailPlaceholder` is deleted. §13.4's prose is corrected. D-14 is recorded,
and piece 5 — group series in the engine — is what closes it.
