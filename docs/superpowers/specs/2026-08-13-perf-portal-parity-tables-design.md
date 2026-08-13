# Parity tables: the statistics and errors tables — design

**Status:** approved 2026-08-13. Second of four sub-projects completing PRD
§26 M3's rendering half. Piece 1 (the eight overview charts) is PR #7.

**Goal.** Render §13.2 ⑤ the statistics table and ⑥ the errors table —
Appendix A **G-11…G-17** — so the run detail page carries the whole Gatling
overview, not just its charts.

---

## 1. Scope

**In:** the hierarchical statistics table with its full column set, expand and
collapse, sort on every column, filter by name, row links to detail; and the
errors table.

**Out, and belonging to later sub-projects:**

| Sub-project | Contents |
|---|---|
| 3 | Request detail page §13.3 (RQ-01…RQ-11), including the saturation scatter |
| 4 | Group and scenario detail §13.4 (GR-01…GR-09, S-01, S-02) |

**Out of scope entirely, and must not appear in any diff:** charts of any kind
(piece 1 owns them), the latency family, trend strips, comparison, regression
detection, live monitoring, saved views, custom dashboards, personalization,
i18n mechanics, self-registration, and any RBAC affordance — `org_member.role`
stays write-only until M6.

Row links point at `/runs/:runId/requests/:name` and
`/runs/:runId/groups/:name`, which piece 3 and piece 4 fill. This piece ships
those routes rendering an honest "not built yet" placeholder rather than
inventing a destination or omitting the links G-16 requires.

## 2. What the payloads actually carry

Measured against `apps/web/test/fixtures/reference-run.json`, not assumed.

`GET /v1/runs/:id/stats` returns 14 rows for the reference run: **1** `run`,
**6** `group`, **7** `request`. Each `StatRow` carries `scope`, `name`,
`family`, `count`, `okCount`, `koCount`, `errorRate`, `minMs`, `maxMs`,
`meanMs`, `stddevMs`, `throughputRps`, `percentiles`, `indicators`.

The percentile keys are **`p50, p75, p95, p99`** — exactly the four §13.2 ⑤
names, and project-configurable, so the columns are driven by the payload's
keys and never hard-coded.

`GET /v1/runs/:id/errors` returns `{ message, count }` per distinct error.

### 2a. The fixture has no errors payload

`reference-run.json` holds `stats`, `series`, `users`, `distribution` — piece
1's capture script never took `/errors`, because no chart needed it. **The
first task re-captures the fixture including errors.** A transform tested
against a hand-written payload is a transform tested against its author's
assumptions.

## 3. Hierarchy is encoded in the name, and nowhere else

Group rows are path-like — `Cart`, `Catalog`, `Catalog/Recommendations` —
and no row carries a parent id. The tree is derived by splitting `name` on
`/`, and that is the only signal available.

Consequences the implementation must handle rather than assume away:

- a group whose name contains no `/` is a root;
- `Catalog/Recommendations` implies a parent `Catalog`, which in this payload
  exists — but a payload where it does **not** must still render, with the
  orphan shown at root rather than dropped;
- request rows carry no group path at all in this payload, so requests are
  listed under the run, not nested inside groups. **Verify this against the
  payload before building nesting for it**: if request names turn out to be
  path-qualified in some runs and not others, the tree builder must cope with
  both, and the reference run is not sufficient evidence either way.

## 4. A group is two rows, and the global table shows one

Every group appears **twice** — once as `group_cumulated`, once as
`group_duration`. Three groups produce six rows.

Gatling's own global page distinguishes them not at all: `index.html` contains
**zero** occurrences of "Cumulated". Its group *detail* page contains both,
with labels like `Group Duration Distribution` and `Group Duration Ranges`. So
the two-family split is a **detail-page** concern and belongs to piece 4; the
global statistics table shows **one row per group**.

**Which family that row shows is measurable, not arguable.** Do not assert it:
compare the reference report's global statistics-table numbers for `Cart`
against both families' `StatRow`s and use whichever matches. Record the result
and the evidence. If neither matches, say so — that is a finding, not a
blocker, and the fallback is `group_cumulated` with the deviation recorded,
because it is the sum of child request durations and therefore the figure
comparable to the requests beneath it.

## 5. Deviation D-8: the errors table's affected-endpoint count

§13.2 ⑥ specifies "distinct error message, count, percentage of total errors,
**affected endpoint count**; expandable to per-endpoint breakdown".

`ErrorsResponse` carries `{ message, count }`. The percentage is derivable
from the total. **The affected-endpoint count is not** — nothing links a
message to the endpoints it occurred on, and `/errors` takes `scope` and
`name` parameters, so recovering it client-side means one request per endpoint
and then a reverse index.

**Not built in this piece.** The per-endpoint breakdown is better served by
the request detail page (RQ-11, "Errors for this request"), which piece 3
builds and which answers the same question from the other direction. This
piece renders message, count and percentage, and records the gap.

This is D-8, continuing the parity family's numbering (D-1…D-6 in the
parity-backend spec, D-7 in the parity-charts spec).

## 6. Deviation D-9: the statistics table is not virtualized

§13.2 ⑤ specifies "virtualized". The reference run produces 14 rows, and the
ingest spine enforces an endpoint cardinality cap, so the realistic ceiling is
hundreds rather than tens of thousands.

Virtualization is a dependency, a testing burden, and a permanent complication
of every row assertion — bought, today, for a table that fits on a screen.
**Not built.** The trigger for revisiting is explicit: **a run whose statistics
table exceeds 500 rows**, or a measured scroll jank complaint. Recorded here so
the decision is found rather than re-litigated.

## 6a. Deviation D-10: requests do not nest under their groups, and the data exists

Gatling's global statistics table is a full tree: every row carries a
`data-parent`, and **5 of the 7 requests nest under a group** (`Related Items`
under `Catalog/Recommendations`; `List Products` and `Product Detail` under
`Catalog`; `Add To Cart` and `View Cart` under `Cart`; only `Search` and
`Place Order` sit at root). Ours are flat.

**Not because the data was never there.** The group stack is read at
`packages/plugin-gatling/src/records.ts`, carried as `RequestEvent.groups` in
`packages/core/src/events.ts`, and used for groups at
`packages/statistics/src/engine.ts:133` — `e.groups.join('/')`. Eleven lines
later, `:171` rolls requests up under the bare `e.name` and the path is
discarded. Task 2 ran our own parser over the reference `simulation.log` and
reproduced Gatling's tree exactly, so nothing is missing upstream of the
engine.

**Deferred to piece 3, deliberately.** Fixing it changes request *metric
identity* across three rollups — series, stats and errors — plus the API's
`?name=` parameters and every test pinning a bare request name. That is not a
rendering concern. Piece 3 owns request identity because it builds
`/runs/:id/requests/:name` for real; this piece's links are placeholders, so
no compatibility surface exists yet.

`buildTree` already splits **any** row's name on `/`, so the day the engine
emits the joined name, requests nest with no change here — and there is a test
for that, driven by a renamed request.

## 6b. Deviation D-11: our Cnt/s disagrees with Gatling's

Measured while building the table: our run row reports **14.40** requests/s
where Gatling's reference report writes **14.21**. The *format* matches (two
decimals, as Gatling writes both `% KO` and `Cnt/s`); the *value* does not.

It is a duration-edge difference upstream — which end of the run's span the
rate divides by — and it was invisible until the number reached a screen. It
belongs to a backend pass, not to a rendering sub-project, and the table ships
showing our own figure rather than bending it toward Gatling's.

Recorded because D-8, D-9 and D-10 all have a written home and this one had
only a ledger entry, which a reader comparing the two reports would never
find.

## 7. Architecture

```
apps/web/src/tables/
  buildTree.ts      pure: StatRow[] -> a sortable, filterable row tree
  StatisticsTable.tsx
  ErrorsTable.tsx
apps/web/src/routes/
  RunDetail.tsx     mounts both, above the chart stack
```

`buildTree.ts` is pure TypeScript — no React — for the same reason piece 1's
transforms are: the tree, the sort and the filter are where the errors live,
and they are testable in the node environment against real captured bytes.

**Sorting keeps children with their parent.** Sorting a tree by p95 is not
sorting a flat list: siblings reorder within their parent, and a parent never
moves away from its children. A flat sort would produce a table that looks
sorted and reads as nonsense.

**Filtering by name keeps ancestors.** A filter matching
`Catalog/Recommendations` must still render `Catalog`, or the match appears at
root and its context is lost. Substring matching; regex is out of scope for
this piece and recorded as a gap against G-14 if the PRD's "substring +
regex" is read strictly.

## 8. Testing

Same three layers as piece 1: pure unit tests against the re-captured fixture;
the rendered table as its own parity surface; Playwright for the behaviours
that only exist in a browser — expand, collapse, sort, filter, and the row
link.

**At least two falsification checkpoints must name a NON-NUMERIC mutation.**
Piece 1 ran nine falsifications and caught eight tests that could not fail;
the ninth escaped precisely because every checkpoint named a numeric mutation
while the defect was an interactive default — a scale toggle whose default
could flip to linear with 459 tests staying green. Sort direction, a collapsed
default, and a filter that matches everything are this piece's equivalents.

## 9. Falsification checkpoints

| # | Break this | This must fail |
|---|---|---|
| 1 | flatten the tree — sort ignoring parentage | a sorted table keeps children with their parent |
| 2 | drop ancestors from a filtered result | filtering to a nested group still shows its parent |
| 3 | default the sort direction to ascending on a "worst first" column | the table opens worst-first |
| 4 | render groups expanded by default | groups start collapsed |
| 5 | compute the error percentage against its own row instead of the total | percentages sum to 100 |
| 6 | hard-code the percentile columns instead of reading the payload's keys | a payload with different percentile keys renders them |

Checkpoints 3 and 4 are the non-numeric ones §8 requires.

## 10. Success criteria

A person opens a completed run and sees, above the charts, every request and
group in a table they can sort, filter and expand, with each row linking to
its detail page; and beneath it the distinct errors with counts and shares.
`pnpm typecheck`, `pnpm lint`, the unit, integration and Playwright suites are
green, and every checkpoint in §9 has been run and shown to fail as named.
