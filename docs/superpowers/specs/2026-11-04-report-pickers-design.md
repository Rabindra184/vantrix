# Report pickers — design

Gap #1 of `docs/superpowers/research/2026-11-03-ge-page-parity/README.md`. Gatling
Enterprise's Report narrows a section's charts to one scenario, group or request
(`page-notes.md`, "Report pickers"). This brings the part of that the stored data
can answer to PerfPortal's Report, exactly, and says plainly where it cannot.

Agreed with the user on 2026-11-04: scope A, a picked group with no request shows
the group's requests merged, and approach 1 (merge stored histograms when the
Report reads them). The write-up rated this gap bounded; measuring the data made
it architectural, for the reasons in section 2.

## 1. What a reader gets

A reader looking into a spike narrows the Report to the part of the simulation
they suspect, and a copied link reopens exactly that view.

- **Requests section: Group, then Request.** With a request picked, six of the
  section's eight charts and the Table view narrow to it. With a group picked and
  no request, the same charts narrow to that group's requests together.
- **Virtual users section: Scenario.** The three charts narrow to one scenario.
- **Errors per second and Responses by status** stay whole-run and say so while a
  pick is applied (section 6).
- Connections and DNS keep their Remote and Hostname filters. Groups (a table,
  not charts), Connections, DNS and Load generators gain nothing.

Success: the narrowed figures equal an independent oracle computed from the run's
own `simulation.log` (section 9), and a shared link reproduces the pick, the
window and the open section.

## 2. What the stored data can and cannot answer

Measured on 2026-11-04 against the code, not assumed:

| Question | Answer from stored data |
| --- | --- |
| One request's series, distribution, stats row | Yes: `run_series_bucket` and `run_stat` rows per request, with exact `sparse-ms-v2` OK/KO histograms. |
| A group's requests together | Yes, by merging those rows' histograms: exact, because a histogram merge is exact. No stored row holds it today. |
| One scenario's users | Yes: `/users` already returns per-scenario buckets. |
| One scenario's requests | **No.** A Gatling request record carries no scenario (`record-decoder.ts` reads groups, name, times, status, message), so no request chart can ever narrow by scenario from the log. |
| One request's errors per second | **No.** `run_error_bucket` has no scope column; error buckets are run-wide. |
| One request's status codes | **No.** The agent file records `req` on every status line, but `buildAgentFigures` files status counts under `*` only. |

The last two are the follow-up branch (scope B, declined for now): per-request
error buckets and per-request status counts, with an engine change, a migration,
a verifier version bump and a recompute.

## 3. Group membership

A request's identity is its joined name, `[...groups, name].join('/')`
(`engine.ts`), and a group's is `groups.join('/')`. Membership is decided by one
pure function in `@perfportal/contracts`, imported by the API and the web, so the
picker's list and the server's merge cannot disagree:

```ts
/** `group === ''` means the requests that sit in no group. */
export function requestsInGroup(
  requestNames: readonly string[],
  groupNames: readonly string[],
  group: string,
): string[];
```

- A request is in group `G` when its name starts with `G + '/'` and `G` is one of
  the run's own group names. **Subgroups are included**: `Catalog` takes
  `Catalog/Recommendations/Related Items` too, as Gatling's own group figures do.
- "(no group)" is every request in no known group. A top-level request named
  `/login` is in no group: its leading `/` does not name a group the run has.
- **Known limit, recorded rather than fixed:** a top-level request whose name
  happens to begin with an existing group's path and `/` (a request literally
  named `Cart/x` beside a group `Cart`) is counted in that group. The joined name
  has already lost the distinction, and every other surface keyed on it (the
  request drill-down, G-05's path matching) shares the limit.
- An unknown group, or a group with no requests, has no members.

## 4. API: `group` on `/series` and `/distribution`

`GET /v1/runs/{id}/series` and `GET /v1/runs/{id}/distribution` take an optional
`group` query parameter, with `scope=request` and **no** `name`:

```
/v1/runs/{id}/series?scope=request&group=Cart&family=response_time
/v1/runs/{id}/series?scope=request&group=&family=response_time   # (no group)
```

- `group` present (even empty) means "merge every member's rows". Read through
  `singleValue`, so a repeated `group` is 400 `INVALID_QUERY` like every other
  parameter.
- `group` with `name`, or with a scope other than `request`: 400
  `INVALID_QUERY`, naming the conflict.
- A group with no members answers as an unknown `name` does today on each
  endpoint: `/distribution` 404 (remediation pointing at `/stats`), `/series` an
  empty bucket list.
- A member row with no histogram (a legacy run retired with a
  `recompute_error`): 409 `GROUP_NOT_MERGEABLE`. Exact merging needs histograms
  and nothing is guessed.
- `from`/`to` work as they do today: the windowed path already merges bucket
  histograms, and it now merges them across members as well.
- Both responses gain `group: string | null`, `.nullable().optional()` in the
  contract (the rolling-deploy rule). `null` for an ordinary read; for a group
  read, `scope: 'request'`, `name: ''` and `group` the path asked for. **The web
  refuses a group read whose response does not echo its group**: an API pod
  older than this ignores the unknown parameter and answers the run's own data
  with a 200, which would draw whole-run figures under a group pick. The chart
  says the server cannot narrow by group, rather than drawing them.

`/stats` does not change. Everything the Report draws from it under a pick is
additive and is computed in the browser from the members' own rows: request
counts, OK/KO counts, and the indicator bands (`under`, `between`, `over`,
`failed` are counts, so a group's bands are the sum of its members').

### Merging series

A request's series coalesces on its own (`maxBucketsEndpoint`), so two members
can carry different bucket widths. Every width is `1000 × 2^k` from offset 0, so
each finer bucket falls in exactly one coarser one. The merge:

1. reads every member's buckets and their histograms (`series` plus
   `seriesHistograms`, one round trip each, all members in one query);
2. takes the coarsest member width (`inferBucketWidthMs` per member, with that
   function's existing limits);
3. re-buckets each member's buckets to it by `floor(offset / width) * width`,
   summing the started and ended OK/KO counts and merging the OK and KO
   histograms;
4. answers each merged bucket's min, max, mean and band maps through
   `bucketLatency`, the function the engine writes them with, plus any
   `?percentiles=` ranks, which `/series` already adds from histograms.

A pure function in `packages/statistics` does steps 2-4, so it is unit-tested
apart from the database. Distribution is simpler: merge the members' run-wide
histograms (or windowed bucket histograms) and answer the existing shape.

The OpenAPI document gains the parameter, the 409 and the echo field. The route
and status guards in `openapi.integration.test.ts` hold it to the handlers.

## 5. Web: pickers and URL state

### Where they sit

- **Requests:** Group, then Request, in the section bar beside Charts | Table.
  The Request picker is enabled once a group is chosen; a group with one request
  selects it; a run with no groups shows "(no group)" read-only and the Request
  picker straight away. Nested groups are listed by their path
  (`Catalog / Recommendations`). No Scenario picker here (section 2), a stated
  deviation from Gatling Enterprise.
- **Virtual users:** Scenario.

Both follow `ReportFilterControl`'s 0 / 1 / many rule: no control when there is
nothing to choose, a read-only field for one value, a select with "All …" first
for two or more. The lists come from the run's own `/stats` rows (request and
group names) and `/users` scenarios, both already fetched by these sections.

### In the URL

Gatling Enterprise's per-section spelling:

```
?requests-group=Cart&requests-request=Cart%2FAdd%20To%20Cart
?requests-group=                     # (no group)
?users-scenario=Browse
```

`users-scenario` is a guess: the write-up did not record Gatling Enterprise's
Virtual users picker. `useReportFilter` generalises to these keys and keeps its
rules: written with `replace: true`, every other parameter kept (the window above
all), the section's `#hash` carried and marked `FRAGMENT_IN_PLACE`, "All" deletes
the key, and a value the run does not have reads as "All" with one line beside
the control naming what the link asked for. A request picked without a group in
the URL takes its innermost known group from its name ("(no group)" when it has
none); a request outside the named group is unknown and reads as no request.

### What each chart reads under a pick

| Chart | Request picked | Group picked |
| --- | --- | --- |
| Requests and responses per second | `/series?scope=request&name=` | `/series?scope=request&group=` |
| Response time percentiles | the same series | the same series |
| Response time distribution | `/distribution?scope=request&name=` | `/distribution?scope=request&group=` |
| Response time percentiles distribution | the same distribution | the same distribution |
| Response time ranges | that request's row's bands | the members' bands summed |
| Number of requests | that request alone | the members |
| Errors per second | whole run, with the note | whole run, with the note |
| Responses by status | whole run, with the note | whole run, with the note |
| Table view | that request's row | the group's subtree |

The chart titles do not change; the section bar states the pick, and each
chart's data table and accessible description carry it, so a figure copied out
of the page still says what it was narrowed to. A narrowed empty chart says
"for this request" or "for this group", never "for this run" (the scoped-empty
rule recorded in `CLAUDE.md`), and combined with a window it names both.

### When the pickers are withheld

- While a run streams: the live wire carries run-scope series only, so there is
  nothing to narrow. The section shows no pickers, as it shows no Table view.
- On a phone, behind the same `DesktopOnly` gate as the charts they drive.

## 6. The two charts that stay whole-run

Errors per second and Responses by status keep drawing the whole run under a
pick, with one line in the chart naming it: "Shows the whole run: errors are not
recorded per request." (and the status-code equivalent). Visible, not behind an
ⓘ, because it changes how the figure must be read beside six narrowed ones —
the clean-UI rule's own exception. The line goes when the follow-up branch makes
the chart narrow.

## 7. Error handling

- A failed group read is named in that chart's own error state; the other charts
  keep drawing.
- 409 `GROUP_NOT_MERGEABLE` draws "This run's group figures cannot be merged:
  it predates exact statistics." in the affected charts.
- A missing echo (an older API pod) draws "This server cannot narrow by group
  yet." and no figures.
- The pickers never fire a figure request until `/stats` has answered and the
  pick has been checked against the run's own names, the rule `useReportFilter`
  already follows for remotes.

## 8. What is deliberately not done

- Per-request errors per second and status codes: the follow-up branch.
- A Scenario picker on Requests: the log cannot support one.
- Pickers on Groups, Connections, DNS or Load generators.
- Gatling Enterprise's 13 percentile rows on these charts: still parked.

## 9. Testing and verification

- **Unit:** `requestsInGroup` (subgroups, "(no group)", leading-slash names, the
  known-limit case pinned as behaviour); the series merge (equal widths, mixed
  widths, a member absent from a bucket, histograms merged, exactness against a
  single series built from the union of events); the 0 / 1 / many controls; the
  generalised URL hook (unknown values, the hash, "All" deleting the key, a
  request without its group); each chart's narrowed source and its whole-run
  note; the missing-echo refusal.
- **Integration:** `/series` and `/distribution` with `group`, against an oracle
  built from the same ingested log: equal per bucket and per bin, windowed and
  not; the 400s, the 404, the 409; the echo; the OpenAPI document.
- **e2e:** pick a group, then a request; the URL, a reload and a shared link
  reproduce it; the narrowed charts' data tables equal what the API answers;
  Virtual users narrows by scenario; Errors per second shows its note; the pickers
  are withheld while a run streams.
- **Red-verify** every guard from a committed checkpoint, replacement counts
  asserted, the repository's standing rule.
- **The real check:** `ParitySimulation` (groups `Cart`, `Catalog`,
  `Catalog/Recommendations`; scenarios `Browse`, `Checkout`) through the Gradle
  plugin, then every figure the pickers draw for `Cart`, `Catalog` (with its
  subgroup), "(no group)", one request and one scenario compared with an
  independent decode of the local `simulation.log`, whole-run and in one window.
  The signed-in browser half is the user's, as before.
