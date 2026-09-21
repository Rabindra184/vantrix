# Working in this repository

## Branching and publishing

**Branch from `main`, work, open one PR back to `main`.** That is the whole
workflow. Merge with a merge commit (`--merge`), never squash: the commit
messages here carry reasoning, and collapsing them loses it.

**Do not create a `publish/*` branch.** Sub-projects M0 through M3-piece-3 used
one: each `feat/*` branch was cherry-picked onto `main` commit by commit with
`docs/` and `PerfPortal_Enterprise_PRD.md` stripped, leak-checked, and verified
from a clean install before its PR. That existed for one reason — keeping the
internal specs and the PRD off a public repository.

**That reason is gone.** On 2026-08-14 the four `feat/*` branches and the
`internal/pre-publish` tag were pushed to `origin`, deliberately. The PRD and
`docs/superpowers/` are public. Stripping them from `main` now protects
nothing, and the machinery costs real time — the last sub-project lost most of
an afternoon to a stacked-PR retarget trap and repeated base-branch confusion,
all of it in service of a boundary that no longer exists.

The `publish/*` branches and PRs #1–#9 are kept as history. Do not extend the
pattern.

### Deleting merged branches, and the stacked-PR trap

**Delete a `feat/*` or `fix/*` branch once its PR has merged**, locally and on
`origin`. Nothing is lost: the merge commit keeps every commit reachable from
`main`, which is what `git merge-base --is-ancestor <tip> main` proves before
you delete. Deleting is also what makes GitHub **auto-retarget** any PR still
stacked on it, which removes the trap below rather than leaving it armed.

This reverses the older convention, and the reversal is the point. Branches
used to be kept, and PR #8 sat pointing at `publish/parity-charts` after that
branch had merged — merging it would have landed the work on a side branch,
with no error. Its own description claimed the retarget would happen
automatically; it was wrong, precisely because the base branch still existed.

The `publish/*` branches and PRs #1–#9 stay as history — they record the
stripped-publication era described above, and nothing points at them. Keeping
those is not the same as keeping every merged branch.

So: if you somehow have a PR stacked on a branch that has already merged and
still exists, retarget it explicitly before merging:

```
gh pr edit <N> --base main
```

Either way, **verify against the server** (`git ls-remote origin refs/heads/main`)
rather than trusting a PR body or a merge click.

**AND `git checkout -b` BRANCHES FROM WHERE YOU ARE STANDING, WHICH IS USUALLY
THE BRANCH YOU JUST PUSHED.** Two findings in a row were taken this way —
`fix/review-m11-onetitle` was cut from `fix/review-m09-labels` rather than from
`main`, because the working copy was still on it after the push. Nothing warns
you: the branch builds, CI passes, and the PR opens against `main` looking
ordinary, while carrying the previous finding's commits.

It was harmless only because the earlier PR merged FIRST — after that,
`git log origin/main..HEAD` showed one commit and the three-dot diff showed
three files. Merged in the other order it would have landed two findings under
one title, which is precisely the stacked trap above wearing different clothes.

`git checkout main && git pull --ff-only` before every `-b`, and check it
afterwards rather than assuming:

```
git log --oneline origin/main..HEAD     # should be YOUR commits and nothing else
```

Note that `gh pr view <N> --json files` can keep showing the stacked files after
the base merges — that listing is cached. `git diff --stat origin/main...HEAD`
is the one to believe.

## Verification

**Use the Node in `.nvmrc` (22). On Node 20 the unit suite silently skips every
DOM-environment file.** jsdom 30 pulls an undici whose
`webidl.util.markAsUncloneable` does not exist on 20, so every component test —
i.e. exactly the ones a UI change needs — throws while LOADING. Vitest reports
those as `Errors` on a separate line from `Test Files`, and prints a confident
`Test Files N passed (N) | Tests M passed (M)` above them, counting only the
files that did load. A green-looking local run then fails in CI, which is on 22.

Only the RATIO matters, and it is roughly two thirds of the suite vanishing: on
Node 20 this was once measured at 47 of 67 files, 534 tests. Do not calibrate
against those absolutes — they were true of a smaller suite and are recorded
only to show the scale of what disappears.

**AND THE SUITE NOW RUNS AS TWO PROJECTS, WHICH IS WHY THAT NODE-20 TRAP READS
DIFFERENTLY.** `vitest.config.ts` used to say `environmentMatchGlobs` — one
include list, node by default, jsdom for `.tsx`. Vitest 4 removed that option,
so a `.tsx` suite silently ran in `node` and threw `ReferenceError: document is
not defined` at every `render`: 410 tests across 42 files, all at once, all
loud. It is now two `projects` (`node` and `jsdom`) with their own include
lists. `pnpm test:unit` still reports one combined total, so the floors below
read exactly as they always did.

`nvm use` first, and if a run reports fewer than **151 files / 1855 tests**, it
did not run everything. (Update those two numbers when a sub-project adds
suites, or the next reader calibrates against a stale floor and a
silently-skipped run looks like a pass. The release-readiness branch added
FOUR unit files — `apps/api/test/config.test.ts` (6),
`apps/api/test/security-headers.test.ts` (18),
`apps/web/test/ThemeToggle.test.tsx` (9) and
`packages/persistence/test/auth-cookies.test.ts` (17) — from a floor of
133 / 1483. Its integration floor is **130 files / 1609 tests** (the three
new `.ts` files run there too) and its **e2e rises to 102**
(`smoke.spec.ts` gained the CSP case).

**AND ITS e2e IS THE FIRST THAT RUNS ON THREE ENGINES.** `pnpm test:e2e` is
still Chromium and still 102; `pnpm test:e2e:cross` is 306 (102 × chromium,
firefox, webkit) and is what the `e2e-cross-browser` CI job runs on `main` and
on demand. The WebKit third of that is worth its wall-clock all by itself —
see the eighth lesson below.

The trends-break-on-changed-conditions branch added no unit FILE and 12
cases — 6 to `apps/web/test/comparability.test.ts`, 5 to
`transforms.trends.test.ts` and 1 to `packages/contracts/test/contracts.test.ts`
— from **155 / 1974 to 155 / 1986**. Integration moves with all twelve (every
one is a `.ts` file integration runs) plus 1 case in
`apps/api/test/trends.integration.test.ts`, at **138 / 1797**, and **e2e stays
149**. It is the first branch taken from the PRD rather than from a review or a
verification run: **AC-STAT-5**, which no test and no code had ever referenced.

**THE TREND LINE WAS CONNECTING PRODUCTION TO STAGING, IN THIS DATABASE,
TODAY.** AC-STAT-5: "given two runs with different comparability fingerprints,
when a trend chart spans them, then the line is visibly broken with an
explanatory marker, never silently connected." Measured on the nine real runs
before anything changed, in the trend's own order:

```
  example-paritysimulation   production -> staging -> staging     ONE break
  checkout-demo              staging -> staging -> staging -> (null)   none
```

So the p95 trend for `example-paritysimulation` was drawn as one continuous
line across production and staging runs.

**AND THE SECOND COHORT IS THE RESTRAINT RULE PAYING FOR ITSELF ON REAL DATA,
WHICH IS WHY BOTH ROWS ARE HERE.** Both cohorts MIX — a naive "the values
differ" rule breaks both. `checkout-demo`'s mix is three `staging` runs
followed by one that recorded no environment at all, and a break there would
tell a reader that the load moved when all that happened is that a field went
unreported. One of two candidate cohorts in this database is a false positive,
so known-to-known is not a corner case: **it is half the real transitions
here.**

**THE COMPARE TAB HAS WARNED ABOUT EXACTLY THIS SINCE THE review-criticals
BRANCH.** `comparability.ts` was written for it, and this file's own entry
says "A COHORT IS NOT A CONTROLLED EXPERIMENT" — and the trend line, which is
the OTHER surface built on the same cohort, never asked. Seventh time this file records the one-caller-short shape,
and the first found by reading the specification rather than the code.

**THE FINGERPRINT HAS FOUR COMPONENTS AND THIS PRODUCT CAN COMPUTE THREE.**
§24.1 is `tool ‖ simulation ‖ environment ‖ normalize(injection_profile)`.
Gatling's `simulation.log` carries no declaration of the injection profile —
the reference run's "60 ramp + 4/s over 60 s" was read out of the simulation
SOURCE, not the log — so the fourth is unavailable.

**AND THE TEMPTING SUBSTITUTE WOULD BE WORSE THAN THE OMISSION.** Peak users
and request count are both to hand and both MEASURED. A fingerprint has to be
derived from DECLARED intent: two runs of the same profile differ in peak
concurrency by a user or two, so a measured proxy fragments the line on noise
— breaking it where nothing changed, which is this feature's own failure mode
inverted. Carrying the profile needs the client to declare it, the way
`declaredTestSlug` is declared. Recorded as the gap it is rather than papered
over, which is also what §24.1's "components stored alongside the hash so the
algorithm can be revised" exists for.

**BRANCH AND COMMIT ARE EXCLUDED, AND THAT IS THE HALF THAT KEEPS IT USABLE.**
§24.1 says of them that they are "what varies between comparable runs". A
trend that broke on every commit would be nothing but breaks, and watching the
effect of commits is what a reader opens a trend FOR. `comparability()` still
REPORTS them, because a reader comparing two runs by hand wants them named —
so the two functions have deliberately different axis lists rather than one
being a subset by accident, and each says so.

**KNOWN-TO-KNOWN ONLY.** A break is a POSITIVE claim that two runs sit on
different footing, and `undefined`/`null` is not evidence for it any more than
it is evidence of sameness — the rule this module already applies to its
findings. It also keeps the line whole for every run predating these fields,
which is what `nullable().optional()` exists for.

**A SPACER CATEGORY, NOT ONE SERIES PER SEGMENT, AND THE REASON IS THE
PALETTE.** The obvious shape is a series per comparable stretch. `Chart`
assigns colour by series index from a six-hue palette that NEVER CYCLES
(`assignPalette` leaves a seventh undrawn and says so), so four percentiles
across two segments would be eight series and two would go undrawn — the chart
would lose data to show a break, which is the wrong trade. A spacer category
with `null` in every series breaks the line, keeps one series per percentile,
keeps its colour, and keeps every measured point. The spacer's LABEL is the
transition (`production → staging`), so the break names itself on the axis as
well as in the note.

**AND THE DATA TABLE IS DELIBERATELY NOT SLOTTED.** `rows` lists runs; a
spacer is not a run. That makes `rows` and `axisLabels` no longer
index-aligned, which is why `slotted` returns the slots rather than letting
three callers re-derive them — the alignment was implicit before and would
have rotted silently.

**THE NOTE JOINS RATHER THAN PICKS.** A cohort can be both truncated and
broken, and a reader told only the newer of the two facts is told the chart is
trustworthy in a way it is not. One case asserts both sentences survive
together.

**FIVE MUTATIONS, FIVE DISTINCT LANDINGS, AND THE TWO RESTRAINT RULES EACH GET
THEIR OWN:**

```
  never breaks at all            7 cases across both files
  branch joins the axes          the do-not-break-on-branch case ALONE
  breaks on unknown too          the unknown case ALONE
  no spacer emitted              the two transform cases
  the SQL stops sending `tool`   the integration wire case ALONE
```

**THE FIFTH IS THE ONE WORTH HAVING.** `transforms.trends.test.ts` builds its
own `TrendRun`s, so every case there passes against a server that sends
neither `tool` nor `simulation`: the rule would read `undefined` on both
sides, decline to break (known-to-known), and the line would stay silently
connected exactly as before — a green suite over the unfixed defect. That is
"a test that supplies both sides of a join proves neither" with the wire on
the other side, and the integration case is the half no unit test can supply.

**NO BROWSER TEST CAN SEE THIS, AND THAT IS STATED RATHER THAN IMPLIED.**
`seedTestWithRuns` writes `tool: 'gatling'` and the same `simulation` to every
run in its cohort and no environment at all, so the seeded cohort is
HOMOGENEOUS — no break, no spacer, and `run-trends.spec.ts` is untouched at
149. Seeding a heterogeneous cohort would be a new fixture arm for one
assertion, and what it would prove is the RENDERER rather than this change.

**SO THE RENDERER WAS READ INSTEAD OF ASSUMED, WHICH IS WHERE THE ONE REAL
HAZARD WAS.** A spacer is only a break if a `null` actually interrupts the
line, and `connectNulls: true` anywhere would have made this whole feature
draw nothing while every unit case stayed green. Traced:

```
  connectNulls          set NOWHERE in apps/web/src -> ECharts default false
  Chart.tsx:531         data: [...data.axisLabels]   the spacer reaches the axis
  Chart.tsx:804         data: [...source.data]       the null reaches the series
  Chart.tsx:788         the ONLY branch that rewrites data is `kind === 'pie'`
```

No trend chart is a pie, so all three take the pass-through path. **A feature
whose visible effect is an ABSENCE needs the absence traced to the renderer**
— a green transform suite cannot distinguish "emits a null" from "draws a
gap", and those are two claims.

**AND THE DATA TABLE'S ROW COUNT IS ALREADY PINNED IN A BROWSER, WHICH IS WHY
LEAVING `rows` UNSLOTTED IS MORE THAN TIDINESS.** `run-trends.spec.ts` asserts
`tbody tr` is exactly one row per run, under a comment saying "a row per run
is the claim being" made. Slotting the rows would have put a spacer row in
that table and failed it at 3 against 2 — the existing assertion is the guard
for a decision taken two layers away, and it was read before the decision
rather than discovered by a red run.

**WHAT IS NOT DONE, AND IS A SEPARATE CHANGE RATHER THAN AN OMISSION.**
FR-META-9 says each run CARRIES the fingerprint — a stored hash plus
`fingerprint_components` — so that baselines and regression queries can filter
on equality and the algorithm can be recomputed over history. This branch
derives the comparison at read time from fields the wire already carries,
which is what AC-STAT-5 needs and needs no migration. The stored column is
worth having when there is a second consumer (§24.3's regression detection is
the obvious one), and the PRD's components-alongside design is precisely what
makes adding it later a recomputation rather than a rewrite.

**WHAT WAS RUN.** `typecheck` and `lint` green by their own exit codes;
`test:unit` **155 / 1986**; `test:integration` **138 / 1797, exit 0, zero
failures** against a SCRATCH DATABASE (`perfportal_fp`) and a scratch Redis
INDEX (db 10). Both floors are the recorded ones plus exactly this branch's
cases, and the integration arithmetic closes at 1784 + 13 — twelve unit cases
in `.ts` files that suite also runs, plus its one integration case. **e2e was
not re-run**: every file this branch touches is a `.ts`, and the seeded cohort
is homogeneous, so no spec can reach the change.

**AND IT PASSED CLEAN ON A MACHINE THAT SHOULD NOT HAVE BEEN TRUSTED.** The
run started at load **10.83 with 3,895 free pages** — below the 4,390 this
file already calls untrustworthy — and took **945s against a usual ~480s**.
It still came back 138/138 with nothing red. **A slow run that passes is a
pass**: pressure inflates duration and manufactures flakes, and neither makes
a green result false. The rule this file records is to distrust a FAILURE on
a loaded machine, not to discard a success — and the distinction is worth
stating, because the branch before this one re-ran a clean suite twice for
want of it.

The windowed-row-survives-the-overflow-bin branch added no unit FILE and 2
cases to `packages/statistics/test/window.test.ts`, from **155 / 1972 to
155 / 1974**. Integration moves with both (that file is a `.ts` integration
runs) plus 1 case in `apps/api/test/window.integration.test.ts`, at
**138 / 1784**, and **e2e stays 149**. Found by checking a claim this file's
own previous entry made and had not measured.

**BRUSHING A TIME WINDOW RETURNED 500 ON A RUN WHOSE UNBRUSHED PAGE RENDERED
FINE.** `Histogram` folds anything past a 120 s cap into one overflow bin, and
`quantile` REFUSES a rank that lands there — deliberately, and its docstring
argues the case well ("a percentile that silently guesses is the defect this
class exists to avoid"). That reasoning is about the histogram. Nothing said
what a READ HANDLER should do with the refusal, and the answer was: let it out.
`rollupFromHistograms` did not catch it, `metrics.controller` does not wrap it,
and `ProblemFilter` turned it into

```
  {"status":500,"code":"INTERNAL","detail":"The request could not be completed.",
   "remediation":"Retry the request. If it keeps failing, report trace 2dfe7ea8-…"}
```

**REMEDIATION THAT CAN NEVER WORK**, because the run's stored buckets overflow
on every retry. Meanwhile the UNWINDOWED read of the same run answers 200 —
that path reads the sketch, which has no cap.

**AND THE CAP'S OWN COMMENT IS WHY NOBODY LOOKED.** It read "120s is above any
realistic HTTP timeout, so the loss is theoretical". True of REQUESTS, and
false of the `group_duration` rows the same histograms hold: a group's
duration is its WALL-CLOCK SPAN, so `group("Browse") { during(5.minutes) { … } }`
— ordinary Gatling, not a pathology — produces 300 s observations. Measured on
exactly that shape through the real engine:

```
  the slowest REQUEST in the run      400 ms
  the group's wall-clock duration     300,700 ms
  unwindowed  (sketch, uncapped)      p50 300700 — answers
  windowed    (histogram, capped)     THREW AT p50 — every rank in the bin
```

**IT THROWS AT p50, NOT JUST THE TAIL.** With every observation past the cap
`counted` is 0, so the FIRST percentile asked for lands in the bin and the
whole row dies — the reader loses the entire windowed statistics table, not
one column. **SIXTH TIME THIS FILE RECORDS A COMMENT JUSTIFYING SOMETHING WITH
A CLAIM THAT HOLDS FOR ONE FAMILY AND NOT ANOTHER THE SAME STRUCTURE SERVES**,
and the tell was in the word: "HTTP timeout" is a claim about requests, in a
structure whose rows are not all requests.

**OMITTED, NOT GUESSED, AND NOT ZERO — WHICH IS THIS REPO'S OWN EXISTING
RULE.** `bucketLatency`'s `percentilesOf` already answers `{}` rather than a
band of zeros for an empty sketch, because "a p95 of 0 is a fabricated
observation", and `StatisticsTable` already renders a missing percentile as a
dash. So an unrecoverable percentile is simply ABSENT and the row is answered.

**AND THE ROW THAT SURVIVES IS EXACT, WHICH IS WHAT MAKES THAT ACCEPTABLE.**
`Histogram#accept` updates `#min`, `#max` and `#sum` BEFORE it folds an
observation into the bin, and `merge` carries all three — so count, min, max,
mean and standard deviation are the real figures even when every observation
overflowed. The reader loses the ESTIMATED columns and keeps the MEASURED
ones, and still sees the tail in Max. Checked rather than assumed: the case
asserts `maxMs` is 300700 on a row whose percentiles are `{}`.

**FOUR MUTATIONS, AND THE SECOND EARNS THE SECOND CASE:**

```
  the throw escapes again        both unit cases
  all-or-nothing on any overflow the partial case ALONE
  guesses 0 instead of omitting  both unit cases
  the throw reaches the endpoint the integration case ALONE — a real 500
```

Dropping every percentile whenever ANY observation overflows satisfies the
first case perfectly while throwing away answers the histogram still holds —
nine fast observations and one past the cap has a recoverable p50 and an
unrecoverable p99. That is why the pair exists.

**THE INTEGRATION CASE IS THE ONE THAT PROVES THE CLAIM**, because the claim
is about an ENDPOINT and no unit case can reach it: the unit cases call
`rollupFromHistograms` directly and would pass against a handler that caught
the throw and returned a 422, or against one that never called it. It writes
an over-cap histogram straight onto the stored buckets rather than ingesting
one — producing it through the fixture would mean a five-minute simulation,
and the subject is what the endpoint does with a bucket it has to merge. Its
red-verify is the 500 body quoted above.

**THE PRODUCT ALREADY HANDLED THIS ONE SURFACE OVER.** `distribution.ts` and
`percentileDistribution.ts` both read `overflowCount` and render a limitation
note; the browser has known about the bin for as long as it has existed. Only
the windowed statistics path treated the refusal as impossible. **When a
structure has a documented degenerate state, grep for who ALREADY handles it
before assuming nobody has to.**

**WHAT WAS RUN, AND FOR ONCE THE MACHINE COULD ANSWER.** `typecheck` and
`lint` green by their own exit codes; `test:unit` **155 / 1974**;
`test:integration` **138 / 1784 CLEAN, exit 0, no flakes**; `pnpm test:e2e`
**149 / 149** at `--workers=2`. Every floor is the recorded one plus exactly
this branch's cases, and the integration run is the first clean local one in
several branches — at **43,722 free pages and load 5.56**, against the 3,825
pages the branch before it was measured on. That contrast is the whole reason
this file records machine state beside a result: the same suite produced six
disjoint flakes yesterday and none today, with the product unchanged between
them. Scratch databases and scratch Redis indexes throughout; the nine real
Gatling runs confirmed intact afterwards.

**AND PORT 3000 WAS STILL HELD BY THE SAME UNRELATED `remotion` CHECKOUT**, so
`PERFPORTAL_E2E_PORT=3100` again. Third occurrence; it is a standing fact
about this machine rather than an incident.

**AND IT CORRECTS A DOCSTRING THIS FILE'S PREVIOUS ENTRY SHIPPED THE DAY
BEFORE.** `percentile.ts` said `window.ts` "reports the merged RELOADED
sketch's own extremes" — describing a mechanism it does not have, because a
windowed row is built from `Histogram`, not `Sketch`. The CONCLUSION survived
and is stronger than the argument given for it (a histogram is exact, so its
quantile is inside its own range by construction rather than by estimate), but
the reason was false. **That is the exact class the previous entry's headline
is about, committed by the branch criticising it**, and it was found by going
back to measure a claim rather than re-reading it. The rule that catches this
is the cheap one: a docstring asserting what ANOTHER module does is a claim
about that module, so open that module.

The percentiles-clamped-at-the-source branch added ONE source file —
`packages/statistics/src/percentile.ts` — and 5 cases: 2 to
`packages/statistics/test/rollup.test.ts`, 1 to `bucket-latency.test.ts`, 1 to
`parity.test.ts` and 1 to `packages/sla/test/evaluate.test.ts`, from
**155 / 1967 to 155 / 1972**. No unit FILE: that new file is source, and the
two cases first written against `sketch.test.ts` MOVED rather than being added
(see below). Integration moves with all five (each is a `.ts` file integration
runs) at **138 / 1781**, plus assertions INSIDE an existing case in
`apps/api/test/read.integration.test.ts`, which moves no count. **e2e stays
149.** Found by asking which consumers the clamp branch's own deferral had
never reached.

**A PLATFORM GATE JUDGED A RUN AGAINST A NUMBER THE PRODUCT REFUSES TO
DISPLAY.** `clampPercentile` corrected four BROWSER surfaces and nothing
server-side did, so the raw estimate was what got stored, served and JUDGED.
Driven end to end through the product's own modules over the reference
fixture — `parseSimulationLog` → `runEngineAsync` → `toEvaluableStats` →
`evaluateRules`, which is `pipeline.service.ts`'s own call sequence:

```
  the run                count 895   min 16   max 2503    both EXACT
  p99, raw               2515.4601126102525               12.46 ms ABOVE the max
  gate p99 ≤ 2510        FAILED — actual 2515.4601126102525
  the statistics table   p99 2503, Max 2503 in the next column
```

**THE RUN PASSED. THE PRODUCT SAID IT FAILED, AND NO NUMBER ON THE PAGE
EXPLAINS THE VERDICT** — a reader whose gate failed at 2515 opens the table
one section below, reads a 99th percentile of 2503 beside a maximum of 2503,
and concludes the gate is broken. `parity.test.ts` computes the true p99 from
the sorted durations and it is **2501**, so the gate really was satisfied.
After: `passed`, actual **2503**, the same number the table shows.

**IT IS A BETTER ESTIMATE, NOT A PRETTIER ONE**, which is worth measuring
rather than asserting:

```
  raw      2515.4601126102525    0.578% from the truth
  clamped  2503                  0.080% from the truth      7x closer
```

**BOTH BOUNDS ARE REACHABLE, AND THE LOWER ONE HAD NEVER FIRED ON REAL DATA.**
Across five distribution families × five sample sizes × ten quantiles: **49 of
250 above the sample's own max** (worst +0.68%) and **12 of 250 below its own
min** (worst -1.00%). On the nine real Gatling runs in the developer database
it is **24 of 436 values, every one above the maximum**, worst +12.46 ms —
and **none below the minimum**, because those runs' p50 sits nowhere near
their min. So an upper-bound-only clamp would look complete against every run
this project has ever ingested. The shape that reaches the floor is a PLATEAU
— 90% of requests on one fast path, an ordinary load test — and it puts p5 at
**49.903 on a sample whose fastest observation is 50**.

═══ THE FIRST FIX WAS IN THE OBVIOUS PLACE AND WAS WRONG, AND AN EXISTING
TEST IS WHAT SAID SO ═══

**IT WENT IN `Sketch.quantile`, THREE LINES BELOW WHERE THAT FUNCTION ALREADY
RETURNS `#inner.min` FOR RANK 0 AND `#inner.max` FOR RANK n-1.** That reads as
airtight: an interior rank answering outside the pair those two branches
already trust is the function disagreeing with itself, it is one line, and it
covers every consumer of a sketch at once. Every new case passed, `typecheck`
and `lint` were green, and the four mutations all landed.

`packages/persistence/test/metrics.integration.test.ts` failed — "answers a
percentile that was never stored in the JSONB", which compares a LIVE sketch's
quantiles against the same sketch PERSISTED AND RELOADED. Measured on the
plateau fixture:

```
  true      min 100                 max 2503
  live      min 100                 max 2503
  reloaded  min 100.494567708565    max 2515.4601126101625
```

**A RELOADED SKETCH'S MAXIMUM IS THE IMPOSSIBLE VALUE.** The extremes are
exact only until serialization — the `min` getter says so in one line that had
been sitting there the whole time — after which they are reconstructed from
the bucket store and land OUTSIDE the true range. So clamping against them
achieves exactly nothing on every reloaded path, while looking complete. The
API's own `/stats` recomputes percentiles from that reloaded sketch and
reports them beside `min_ms`/`max_ms` read from the row, so the first fix left
the public endpoint serving a percentile above the maximum printed next to it.

**THAT IS THE SHAPE THIS ENTRY WAS WRITTEN TO CRITICISE, COMMITTED BY THE
BRANCH CRITICISING IT.** The draft already said "a deferral that reached TWO
and stopped"; the first fix reached the live paths and stopped, and read as
total because the mechanism was one line in the lowest-level module. **Depth
is not coverage.** A clamp installed at the bottom is only as good as the
bottom's own inputs, and here those inputs are lossy in exactly the direction
being corrected.

**AND THE TEST THAT CAUGHT IT WAS NOT LOOKING FOR THIS.** It exists to prove
the sketch column survives a round trip; it caught a design error three
packages away because it is the only case in the repository that compares a
live sketch against a reloaded one. Worth remembering before writing off an
integration failure in a file a diff "cannot reach" — this diff genuinely
could reach it, and the honest reading was the expensive one.

═══ THE RULE THAT REPLACED IT ═══

**A PERCENTILE IS CLAMPED AGAINST THE SAME MIN AND MAX REPORTED BESIDE IT.**
That is checkable by a reader on the page, it is true on every path whether
the underlying extremes are exact or bucket-approximate, and it names its own
call sites — whoever assembles the triple:

```
  RollupBuilder.finish        run/request/group rows, the evaluator, the live summary
  bucketLatency               series buckets, and the charts drawn from them
  resolveMetric               the evaluator's fallback for an unstored metric
  metrics.controller          /stats recomputed at a reconfigured percentile set
  window.ts                   NO CALL — see below
```

`window.ts` reports the merged RELOADED sketch's own extremes, so its
estimates are bucket representatives lying between two bucket representatives
and cannot escape by construction. Recorded rather than clamped: an
unfalsifiable line is worse than a written argument.

**AND THE BUCKET SPLITS CLAMP AGAINST THEIR OWN SKETCHES, NOT THE REPORTED
PAIR.** A bucket reports one `minMs`/`maxMs` — the all-outcomes sketch's — and
the OK and KO populations are subsets of it, so projecting each onto its own
range is tighter AND still inside what is reported.

**THE HELPER MOVED INTO `packages/statistics`, WHICH IS WHERE ITS OWN
DOCSTRING SAID IT BELONGED** — "where the exact extremes and the estimated
percentiles are produced together". **The browser copy STAYS**, and not by
oversight: `apps/web` does not depend on `@perfportal/statistics`, so reaching
it would pull the engine, the sketch and the histograms into the bundle for a
`Math.min`; and rows already stored hold the raw value and are not rewritten,
so those four surfaces still have raw input to correct.
`apps/web/test/fixtures/reference-run.json` is a captured payload carrying
2515.46, which is what keeps the browser cases exercising it.

**FIVE MUTATIONS, AND THREE LAND ON EXACTLY ONE CASE:**

```
  rollup unclamped          both rollup cases + the parity whole-set
  bucket unclamped          the bucket case ALONE
  sla fallback unclamped    the SLA case ALONE
  lower bound dropped       the below-min case ALONE
  controller unclamped      the read.integration assertions ALONE
```

The lower-bound mutation is why the floor case exists at all: real data cannot
reach that bound, so nothing else in the repository can see a half-written
clamp. And each site having its own case is not tidiness — the first design
failed precisely because one mechanism was assumed to cover four consumers.

**THE PARITY CASE ASSERTS THE WHOLE SET, NOT THE FOUR PERCENTILES NAMED ABOVE
IT.** It flat-maps every rollup's percentiles and expects the out-of-range
list to be empty, so a scope or family added later joins the check by being
PRODUCED rather than by somebody remembering a new `expect` — the shape the
runner-retry case settled on. On the reference run that list went from **8
entries to 0**, and the failure text carries the row and the number.

**AND THE DEFERRAL'S OWN LIST WAS THE LEAD.** `percentile.ts` named the
consumers still waiting — "the API, the charts, any future export" — and **not
the EVALUATOR**, the one consumer that makes a judgement rather than a
display. The transferable version is sharper than "do the bigger thing":
**read a deferral's list of who would benefit as a list of who was
ENUMERATED, and check it against who actually calls.** `resolveMetric` is two
greps away and appears on no list.

**IT ALSO CLOSES A FIFTH SURFACE NOBODY HAD COUNTED: THE LIVE TILES.**
`livePercentileValue` printed `summary.percentiles` straight off the wire, so
the same p99 read **2515 while a run streamed and 2503 once it finished** —
one run, one quantity, two answers split by nothing but whether the run was
still going, which is the sentence the live-banner entry below uses for its
own defect. Its comment said this needed no clamp because "a live summary
carries neither" `minMs` nor `maxMs`: **accurate about `LiveSummary` and the
wrong reason**, because the value was already wrong before it reached the
wire. **A comment that is true about the type can still be the wrong answer to
the question it stands in front of.**

**WHAT WAS RUN, AND WHAT THE MACHINE WOULD NOT ANSWER.** `typecheck` and
`lint` green by their own exit codes; `test:unit` **155 / 1972**, the recorded
floor plus exactly this branch's five cases; `pnpm test:e2e` **149 / 149** at
`--workers=2`. Everything ran against SCRATCH stores — two scratch databases
and two scratch Redis INDEXES (db 6 and db 7), because `bull:ingest:wait` held
three stale jobs on db 0 and the developer database holds the nine real
Gatling runs this branch measured against. Confirmed afterwards: 9 runs, 109
stat rows, and **their 24 out-of-range values still there** — history is not
rewritten, which is exactly what keeps the browser clamp load-bearing.

**`test:integration` REACHED 138 / 1781 AND NEVER CAME BACK CLEAN, ACROSS TWO
FULL RUNS WITH DISJOINT FAILURE SETS.** The arithmetic closes (1776 + 5) and
one REAL failure was found and fixed — the hand-rolled `bucketLatency` copy
above. The other five were infrastructure, and the tell is that **no test
failed twice**:

```
  run 1   tests.integration     sign-up answered 503
          fold-owner            snapshotOf(...) came back null
          metrics.integration   THE REAL ONE — the hand-rolled copy
  run 2   error-series          Parse Error: Expected HTTP/, RTSP/ or ICE/
          openapi               GET /v1/openapi.json -> 501
          window-bench          1088ms against a 500ms budget
```

All six pass in isolation (102/102 and 31/31). Two are shapes this file
already names by signature — a socket receiving non-HTTP bytes "cannot be
produced by any application-level diff", and a wall-clock budget missed by 2x
at load 15-27 is timing.

**AND CI ANSWERED IT, SO THAT GATE IS A MEASUREMENT RATHER THAN A DEFERRAL.**
This paragraph first ended "a clean local integration run is NOT claimed here;
CI's containers are the arbiter", which was honest and is no longer true — the
`build` job passed on clean containers and printed all three totals:

```
  pnpm test:unit         Test Files 155 passed (155)   Tests 1972 passed (1972)
  pnpm test:integration  Test Files 138 passed (138)   Tests 1781 passed (1781)
  pnpm test:e2e          Running 149 tests using 2 workers
```

Every one matches the local measurement exactly, and 1776 + 5 closes. **A floor
recorded as unknown once it is known is the same staleness this whole section
exists to prevent** — the abandoned-runs entry already says to go back and DO
this rather than only cite it, and six flakes across two local runs is exactly
the case where it is worth the two minutes.

**AND `openapi.integration.test.ts` HAS NOW FLAKED THREE TIMES, ON THREE
DIFFERENT STATUS CODES.** 401 (the openapi-public entry), 400 (the live-banner
entry) and **501** here. Three codes, one endpoint, every occurrence transient
and under memory pressure — which retires the "mechanism undiagnosed" wording
those two entries carry. A document defect does not change its status code per
run, and the file passes 23/23 alone every time; this is the API failing to
serve while the machine is contended. Check `vm_stat` before opening it.

**AND PORT 3000 WAS HELD BY THE SAME UNRELATED CHECKOUT AS LAST TIME.**
`pnpm test:e2e` refused before a single spec; the holder was a `remotion`
process from `~/claude-certification`, which this file already records as "not
a thing to kill". `PERFPORTAL_E2E_PORT=3100` and the run was 149/149. Second
occurrence, same neighbour — check the cwd, then move the port.

**THE `git checkout --` TRAP DID NOT BITE, WITH THE GUARD APPLIED PROPERLY FOR
ONCE.** This file records it six times. The checkpoint was committed before
the first mutation and **amended to hold the tests too**, then amended AGAIN
when the design changed — so every `git checkout HEAD -- <path>` restored the
finished shape rather than a half-settled one, including across a redesign
that replaced the entire mechanism. `git status --short` reporting zero
modified files after the last mutation is what makes that claim worth
anything.

**AND THE BARE-SPECIFIER TRAP BIT AGAIN, FROM THE SCRATCHPAD THIS TIME.** A
probe written outside the workspace cannot `import '@perfportal/plugin-gatling'`
however it is invoked — Node resolves a bare specifier relative to the
IMPORTING FILE, which this file already records for `infra/`. And
`createRequire` against `packages/statistics/package.json` is not enough
either: that package does not depend on `@perfportal/sla`. `apps/worker` is
the one that depends on all three, because it is the process that uses all
three.

The live-banner-reads-its-schema branch added no unit FILE and 5 cases — 3 to
`apps/web/test/SlaBanner.test.tsx`, 1 to `packages/contracts/test/live-delta.test.ts`
and 1 to `apps/worker/test/live-delta.test.ts` — from **155 / 1962 to
155 / 1967**. Integration moves with TWO of those (the `.tsx` never runs
there) at **138 / 1776**, and its **e2e rises to 149**. It is the third and
last surface of `review.md`'s copy row 1, which the review-copy-rows entry
below recorded as deliberately left.

**THE LIVE BANNER READ THE STORED SCHEMA ALOUD, AND THE COMMENT ON THE FIELD
SAID IT DID NOT.** `LiveBreachSchema.description` was documented as "the
evaluator's own message — one sentence, already human-readable". Traced end
to end, it is not:

```
  evaluate.ts:187   `${describe(rule)} — actual ${actual}`
  evaluate.ts:33    `${metric} of ${target} (${family}) ${≤} ${threshold}`
  live/delta.ts     description: a.message
  SlaBanner.tsx     {rule.description}
```

So a reader watching a run stream saw
`error_rate of the run (response_time) ≤ 0.01 — actual 0.0223463687150838`,
and the same run's gates table — once it finished — said
`Whole-run error rate 2.2346% exceeds the 1% limit.` One product, two
vocabularies, split by whether the run was still running.

**FOURTH TIME THIS FILE RECORDS A DOCSTRING ASSERTING A BEHAVIOUR THE PRODUCT
DOES NOT HAVE**, and the first where the false sentence is the plausible
reason nobody re-checked the surface: "already human-readable" is exactly
what a reader auditing this field would have taken at face value.

**AND THE DEFERRAL'S REASON WAS TRUE AND MUCH SMALLER THAN IT READ.** That
note says re-rendering means "changing what the worker streams and what every
delta already recorded says — a data change with a migration question
attached". There is no history to migrate: `SNAPSHOT_TTL_SECONDS` and
`REPLAY_TTL_SECONDS` are both **3600**, so every delta and every snapshot
expires within the hour. What remains is exactly the ROLLING-DEPLOY question,
and `live-delta.ts` already answers it four screens above where this change
lands — the `sla` field's own `.default()` argues it at length, because the
browser drops a whole frame that fails `safeParse` and the gateway forwards
stored bodies without validating them.

**SO THE ANSWER WAS WRITTEN DOWN BEFORE THE QUESTION WAS ASKED.** `rule` is
OPTIONAL, the banner falls back to the stored message, and a delta from an
older worker degrades instead of blanking the page. **Check whether a
deferral's stated cost is still the cost** — the review-copy-rows entry
records the same shape one surface over, where one sentence in a note kept
two renderable surfaces closed for four branches.

**ONE DEFINITION OF THE SIX FIELDS, NOT TWO.** `AssertionSchema.rule` was an
inline `z.object` and is `AssertionRuleSchema` now, referenced by the batch
assertion AND the live breach. Two inline copies agree today; the day one
gains a family the other does not, the banner and the gates table describe
one rule differently with nothing failing. `describeSlaOutcome` already took
exactly that shape, so the browser needed no new renderer — this is a second
CALLER of a decision made once, which is the shape this file keeps asking for
rather than the one it keeps recording.

**NESTED, BECAUSE SIX SIBLING OPTIONALS CAN ARRIVE HALF-PRESENT.** Five
fields and no comparator describes nothing, and every consumer would have to
check all six to discover it. One optional object cannot be partially there.

**THE WORKER NARROWS BY CHECKING, AND A CAST WOULD HAVE BEEN THE SILENT
VERSION.** `packages/sla` is a PURE package that does not depend on
`@perfportal/contracts`, so `EvaluableRule` types `scope` and `family` as bare
strings while the wire types them as enums. `wireRule` bridges that with a
lookup and answers `undefined` on a miss — which puts such a rule on the same
path a pre-deploy delta takes. **ONE fallback, two causes, both honest.** A
cast would have published a frame the browser rejects, taking the whole live
view down for as long as that rule kept breaching.

**AND IT SENDS THE SNAPSHOT, NEVER A RE-READ.** `ruleSnapshot` is the rule as
it read when the breach was judged, and its own comment says why ("editing a
threshold later must never rewrite the history of what passed"). A banner
describing a breach against a threshold edited since would state a comparison
nobody made.

**THE LINE IS BUILT IN ONE FUNCTION BECAUSE THE TWO DESCRIPTIONS ARE
DIFFERENT PARTS OF SPEECH.** `describeSlaOutcome` returns a finished sentence
ending in a full stop; the evaluator's raw message is a fragment. Joining
both in the JSX gives one join for two shapes, and the fallback then reads
`… actual 900 Breaching since 1m 2s into the run` — two fragments run
together. The fragment path keeps its em dash and is byte-identical to what
shipped.

**THE TENSE IS DELIBERATELY NOT REPEATED PER LINE.** A first draft flipped
each line on `frozen`; the headline above the list already makes that
statement once ("breaching when streaming stopped" against "currently
breaching"), so a per-line tense would have been a second answer to a
decision one element up — and scope nobody asked for.

**FOUR MUTATIONS, FOUR DISTINCT FAILURES**, each anchored by asserting the
replacement COUNT before running:

```
  banner ignores `rule`              the 2 new vocabulary cases; fallback stays GREEN
  worker stops sending it            the worker's whole-object envelope case
  wireRule casts instead of checking the degrade case ALONE
  `rule` never reaches the schema    the contracts back-compat case ALONE
```

The fourth is the one worth having: **zod STRIPS unknown keys**, so removing
the field throws nothing — the value simply never arrives and the banner
falls back for ever. And the contracts case is a PAIR for the same reason:
"a breach without `rule` parses" is satisfied perfectly by a schema that
never gained the field, which is the before-state.

**THE FIXTURE THAT HID THIS WAS A STRING THE EVALUATOR NEVER WRITES.**
`SlaBanner.test.tsx`'s breach carried `description: 'p95 ≤ 100 — actual 900'`
— already readable, already short, and produced by nothing in this product.
A fixture that cannot tell the two vocabularies apart is how a banner comes
to print the schema for four branches. It is the evaluator's real output now.

**AND THE e2e IS WHAT PROVES THE SEAM, WHICH NO UNIT CASE CAN REACH.**
`SlaBanner.test.tsx` builds the `LiveBreach` it renders, so it says nothing
about whether a `rule` on the wire ever arrives — three layers sit between
the worker and that render (the schema, the gateway that does not validate,
and `parseFrame`, which drops a failing frame), each tested alone. The new
case in `run-live.spec.ts` seeds a real delta into real Redis and asserts the
sentence on screen, with the absence of `response_time` beside it — because
`toContainText('p95')`, which the case before it checks, passes just as
happily against the schema read aloud.

**WHAT WAS RUN, AND AGAINST WHAT.** `typecheck` and `lint` green by their own
exit codes; `test:unit` **155 / 1967** and `pnpm test:e2e` **149 / 149** at
`--workers=2`, which are the recorded floors plus exactly this branch's five
cases and one spec — the arithmetic closing is what makes that
number worth trusting on a machine at 3,978 free pages. `test:integration`
ran against a SCRATCH DATABASE (`perfportal_slabanner`) **and a scratch Redis
INDEX** (`redis://localhost:6380/3`): the developer database held nine real
Gatling runs, and `bull:ingest:wait` held three stale jobs on db 0. **A
separate database is not isolation when the suite asserts on a queue** —
this file already records a leftover worker draining shared Redis failing
four cases that had nothing wrong with them, and the same contamination is
available with no worker running at all.

**AND ONE e2e CASE FAILED THAT THIS DIFF CANNOT REACH — THE INVESTIGATION IS
THE ENTRY.** `acceptance.spec.ts:281` ("a keyboard alone can open a chart's
data table and get back out") failed on `expect(locator).toBeFocused()`. It
drives `ChartActions`, a Radix menu; this branch changes a shell banner, a
wire schema and a worker. So the first instinct was to call it unreachable —
which this file rightly forbids, because "my diff cannot reach it" is an
argument and the suites are evidence.

**THE MEASUREMENT THAT LOOKED DECISIVE WAS TWO COIN FLIPS.** Backing the four
source files out to `origin/main` and running that one file gave a PASS in
3.0s, against a FAIL in 7.4s on the branch — and the built bundle hashes
genuinely differ (`RunDetail-tSVBWn4e` against `RunDetail-BiLctx4A`), because
`SlaBanner` now carries a VALUE import of `describeSlaOutcome` where it
previously imported a type alone. Everything lined up, and I reported that it
overturned my reasoning.

**IT DID NOT. THE RATE IS WHAT SETTLES AN INTERMITTENT FAILURE, AND ONE RUN
PER SIDE IS NOT A RATE.** Measured on the branch:

```
  whole file, run A     FAIL      the original observation
  whole file, runs 1-3  PASS      3 of 3
  that case alone       PASS      4.3s
  whole suite, re-run   149/149   PASS
```

One failure in four whole-file runs, and green when the case runs alone —
which also rules the cause out of the case itself and into what the six tests
before it leave behind. The clean-`main` pass was one sample of the same
distribution, not a control.

**THIS FILE ALREADY PRESCRIBES BACKING THE CHANGE OUT AND RE-RUNNING, AND
THAT IS NECESSARY RATHER THAN SUFFICIENT.** The abandoned-runs entry uses it
correctly — there the same four cases failed on both trees, so one run each
was enough to ACQUIT. Acquitting needs one matching failure; CONVICTING needs
a rate, because a single differing pair is exactly what a coin produces. **Do
not let a bundle hash change turn a coincidence into a mechanism**: it was
true that the bundle differed and true that the two runs disagreed, and
neither fact bore on the question.

**AND REVERTING SOURCE WITHOUT ITS TESTS DOES NOT BUILD.** The first attempt
at the `origin/main` comparison reverted the four source files alone and the
webServer died before a single spec — `packages/contracts/test/live-delta.test.ts`
still referenced `rule`, `tsc -b` covers the test projects, and Playwright
reports that as `Process from config.webServer was not able to start. Exit
code: 1` with the TypeScript errors buried above it. Revert the tests with
the source, and read the build output before concluding anything about the
run.

**AND `openapi.integration.test.ts` FLAKED A SECOND TIME, WHICH UPGRADES WHAT
THIS FILE SAYS ABOUT IT.** The openapi-public entry records one occurrence of
`expected 401 to be 200`, never reproduced, and calls the mechanism
undiagnosed. Here the same file failed one case with
`GET /v1/openapi.json -> 400: {}` — a 400 with an EMPTY BODY on the document
endpoint itself, not an assertion about the document's content.

**THE OTHER CASES IN THAT FILE ARE WHAT ACQUIT THE CHANGE.** Every one of its
23 cases calls the same `fetchDoc`, and 22 got their 200 in the same run — so
the document generated fine and this was not the zod-to-OpenAPI conversion
choking on the newly-named `AssertionRuleSchema`, which is the hazard that
file exists to catch and the one worth ruling out before anything else. In
isolation it is **23/23, three times**, and the full suite re-ran **138 /
1776 clean**.

**THE TELL IS THE DURATION.** That run took **876s against a usual ~480s** on
a machine whose load had been in the teens all session. Two different status
codes across two occurrences, both on the same endpoint, both transient,
both on a loaded machine — so it is the resource-exhaustion shape this file
already documents rather than anything about the document.

The refusals-nobody-asserts branch added no unit FILE, no unit case and no
spec — unit stays **155 / 1962** and **e2e stays 148** — and 4 cases to
`apps/api/test/live.integration.test.ts`, from **138 / 1770 to 138 / 1774**.
It is TESTS ONLY: every refusal it covers was already correct. Found by
executing each one against a real API rather than by reading for one.

**SEVEN REFUSALS WERE EXERCISED LIVE AND ALL SEVEN WERE RIGHT.**

```
  TOOL_UNKNOWN            400 at upload, names the supported tools
  BUNDLE_NOT_ARCHIVE      failed by the WORKER: "not a gzipped tar archive"
  BUNDLE_EMPTY            reachable only via a VALID archive with no entries
  INVALID_STREAM_OFFSET   400, names the x-stream-offset header
  STREAM_BODY_CONSUMED    400 in 0s
  STREAM_OFFSET_REJECTED  409 on a run that has closed
  RUN_NOT_RUNNING         409 on a SECOND close
```

**FOUR OF THEM WERE ASSERTED BY NOTHING**, which is the whole branch:
`TOOL_UNKNOWN`, `RUN_NOT_RUNNING`, `INVALID_STREAM_OFFSET` and
`STREAM_BODY_CONSUMED` matched zero files across every suite.

**AND ONE OF THOSE GUARDS A HANG, WHICH IS WHY IT CANNOT SIMPLY BE ASSERTED.**
Nest registers Express's global `json()`, which DRAINS a body whose
Content-Type matches before any handler runs; `readRawBody` then waits on an
`'end'` that has already fired. This file already records the consequence —
"no response written, and the socket plus the promise leaked, per request,
with no timeout anywhere on this path" — and `req.readableEnded` is the guard.

**REMOVE IT AND THE TEST DOES NOT GO RED. IT HANGS.** Measured by neutralising
the condition:

```
  without .timeout()   the case waits out the file's whole testTimeout and
                       reports as a timeout — which reads as a slow machine
  with .timeout()      × refuses a chunk whose body a parser already drained
                       Error: Timeout of 5000ms exceeded        5,593ms
```

**A DEADLINE IS PART OF THE ASSERTION WHEN THE DEFECT IS A HANG**, not a
nicety — this file already says "test the wrong Content-Type with a request
DEADLINE", and this is what that costs to skip. The case carries
`.timeout({ deadline: 5_000, response: 5_000 })` and says why in place.

**AND THE ZERO-BYTE CHUNK IS PINNED BESIDE IT, BECAUSE THE OBVIOUS GUARD
BREAKS IT.** A legitimate empty chunk — the shape a real agent sends at the
very start of a run — has an `'end'` that fires once the listener attaches, so
`readableEnded` is still false. A guard written as "no body" rather than "body
already consumed" would refuse it, and nothing else in the file would notice.

**`BUNDLE_EMPTY` IS NOT WHAT AN EMPTY FILE PRODUCES**, which is worth knowing
before writing a fixture for it: a zero-byte upload fails `BUNDLE_NOT_ARCHIVE`,
because it is not a gzip stream at all. `BUNDLE_EMPTY` needs a VALID archive
containing no entries (`tar -czf x.tgz -T /dev/null`, 29 bytes). Two codes,
two genuinely different mistakes, and the obvious fixture reaches the other
one.

**AND `RUN_NOT_RUNNING` BELONGS TO `close`, NOT TO `stream`.** Streaming to a
closed run answers `STREAM_OFFSET_REJECTED` — correctly, and its message names
both conditions ("a gap, or the run is no longer accepting chunks"). The first
probe here aimed at the wrong endpoint and briefly read as a dead error code.
**Grep for who RAISES a code before concluding nothing does**; the answer was
one file away.

**WHAT WAS RUN.** `typecheck` and `lint` green by their own exit codes;
`test:unit` **155 / 1962** (unchanged — these are `.integration.test.ts`
cases, which the unit config excludes); `test:integration` **138 / 1774**
against a SCRATCH DATABASE, with every hand-started process stopped FIRST.

**THE FIRST INTEGRATION RUN FAILED TWO, AT LOAD 16.50.** `tokens` and
`parity.e2e`, neither of which this diff can reach — it adds cases to ONE
file — and both passing 42/42 in isolation. `vm_stat` said **3,709 free
pages**, which is worse than the 4,390 this file already calls untrustworthy.
The second full run was **138 / 1774 clean**. The order here is the cheap
part: isolate the failures, check what the diff can reach, then re-run.

**AND `git add -A` COMMITTED THE THREE UNTRACKED FILES A THIRD TIME.**
`docs/ui-review-2026-09-13/`, `review.md` and `scripts/seed-manual-test.mjs`,
into a two-file change, for the third time in one session — and the second
time AFTER this file gained a paragraph naming them. Caught all three times by
reading `git diff --cached --stat` before committing, and prevented zero times
by having written it down. **The rule is therefore mechanical, not
attentional: never `git add -A` in this repository — name the paths.**

The clock-skew-is-the-minimum branch added no unit FILE and 1 case to
`packages/statistics/test/telemetry.test.ts`, from **155 / 1961 to
155 / 1962**. Integration moves with it (that file is a `.ts` integration runs
too) at **138 / 1770**, and **e2e stays 148**. Found by running the real Go
agent against a real instance, which nothing in this repository had ever done.

**IT TOLD AN OPERATOR A SYNCHRONISED GENERATOR'S CLOCK WAS ELEVEN SECONDS
OUT.** `clockSkewMs` was the WIDEST `receivedAt - sampledAt` a host showed.
Measured on a machine where the skew is provably ZERO — the agent and the API
were the same process tree sharing one clock — across 155 real samples:

```
  min 1,027 ms      median 6,031 ms      max 11,069 ms
```

**A SPREAD IS DELAY; A CONSTANT IS SKEW.** A clock offset does not vary
between samples. That fan-out is the signature of BATCHING: the oldest sample
in a flush has waited the whole interval and the newest almost none. The rule
took the maximum, so it reported the worst-case buffering as the clock, tripped
`CLOCK_SKEW_WARN_MS` (5,000), and printed "gen-01's clock reports samples
roughly 11s behind the server's".

**AND THE CONSEQUENCE IT WARNED ABOUT CANNOT FOLLOW FROM DELAY.** The sentence
continues "so its points on these charts may be misaligned by about that
much". A point is placed at `sampledAt - toolStartedAt` — the AGENT's own
clock — so however long a sample waits in a buffer it lands in the same
bucket. Only a genuine offset moves it. The number is therefore wrong AND the
harm it predicts is unreachable by the thing it actually measures.

**THE MINIMUM IS THE TIGHTEST BOUND, AND IT IS WHY THIS IS A ONE-LINE FIX.**
Transport delay is never negative, so the smallest gap a host ever shows is
the closest any sample gets to the true offset — the same minimum-filter NTP
uses. Real data after: **1,033 ms**, under the threshold, no warning, which is
correct.

**AND IT STILL CATCHES THE CASE THE OLD RULE EXISTED FOR.** An agent thirty
seconds FAST makes every gap about -30,000, and the minimum is the most
negative of them — so the existing "a generator thirty seconds fast" case
passes UNCHANGED. The two rules only disagree for an agent that is not skewed
at all, which is exactly where the old answer was wrong. That case was
re-pointed at the claim it is really making (report the sample that shows it,
not the last one seen) rather than at the rule it was named for.

**TWO MUTATIONS, ONE CASE, AND THAT IS STATED RATHER THAN DRESSED UP.**
Restoring the widest-gap rule and initialising the accumulator at `0` instead
of the first sample BOTH fail the new case and nothing else. They are two ways
to get the floor wrong, so one case covering both is honest coverage — but
the second mutation demonstrated nothing the first had not, which this file
asks to be said out loud rather than counted twice.

═══ WHAT ELSE RUNNING THE AGENT ESTABLISHED, ALL OF IT CLEAN ═══

**THE GO GATE NO `pnpm` COMMAND RUNS.** `cd agent && go vet ./... && go test
./... -race` — exit 0 on both, four packages. Worth running when `agent/`
changes, and worth knowing nobody had.

**THE THREE-STATE DISTINCTION IS REAL, AND NOW WITNESSED ON REAL DATA.**
`available` is computed BEFORE the range filter, so:

```
  no agent ever reported          available false  hosts 0
  recorded, window is quiet       available true   hosts 0     <- the one that matters
  recorded, window has samples    available true   hosts 1
```

The middle row is the claim `RunTelemetry`'s docstring rests on and which
M16's entry called "reachable, correct, and unwitnessed". Produced here by
asking for `?from=1&to=999` on a run sampled every 2s.

**AND THE SAMPLES RECONCILE EXACTLY.** 108 sent, **54 inside the run's own
window, 54 drawn** — offsets 0..106,000 at the agent's 2,000 ms interval,
monotonic, unique, no negative offsets (the lookback is dropped as documented),
every `cpuTotalPct` inside [0,100], no `memUsedBytes` above `memTotalBytes`.

**THE AGENT REPORTS A PLATFORM LIMIT INSTEAD OF SILENTLY ZEROING.** On macOS:
"TCP protocol counters are not available on this platform; segment and
connection-event series will be empty (spec §10)". Named, with the spec
section. The zeros in those columns are honest and the log says why.

**WHAT WAS RUN.** `typecheck` and `lint` green by their own exit codes;
`test:unit` **155 / 1962**; `test:integration` **138 / 1770** against a
SCRATCH DATABASE, with every hand-started process stopped FIRST — the lesson
from the branch below, where a leftover worker draining the shared `ingest`
queue failed four cases that had nothing wrong with them.

The runner-retry-keeps-declared-test branch added no unit FILE and no unit
case — unit stays **155 / 1961** — and 2 cases to
`packages/persistence/test/runner.integration.test.ts`, from **138 / 1767 to
138 / 1769**. **e2e stays 148.** Found by submitting a real job to a real
on-prem runner, failing it, and retrying it.

**`retry` IS AN `INSERT..SELECT`, AND `test_slug` WAS IN NEITHER HALF.** Every
other per-job field is carried forward — environment, branch, commit sha, java
options, system properties — and the declared test is the one that was
omitted. Measured on a live runner, the same artifact three times:

```
  3adc74fb  test_slug onprem-demo   the original
  7d9b8c85  test_slug NULL          a retry
  231caed1  test_slug NULL          a retry
```

**AND IT CHANGES WHAT THE RUN MEANS, NOT HOW IT EXECUTES.** The job still
runs, still streams, still completes. What moves is the RUN's test:

```
  5d5df0f1   declared NULL          resolved example-basicsimulation
  0972bf5c   declared onprem-demo   resolved onprem-demo          (after)
```

`declaredTestSlug` exists precisely so `checkout-smoke` and `checkout-soak`
can share one simulation class, so a retry that loses it files the run under
the auto-created test named after the CLASS — which is the exact grouping
declaring a test exists to replace. Silently: the cohort a reader is watching
simply does not contain the retried run, and the trends line it feeds is short
by one with nothing anywhere saying so.

**NO TEST IN THIS REPOSITORY CALLED `retry`.** Not one — the whole path was
uncovered, which is why an omission in a column list survived. This file
already records "grep for components with no test file before looking for
untested BEHAVIOUR"; the repository-method version of that is cheaper still.

**THE NEW CASE ASSERTS THE WHOLE SET, NOT THE FIELD.** A case pinning
`testSlug` alone would leave the identical hole open for the next column
anybody adds — which is exactly how this one got in. It selects every carried
field for both rows and compares them as OBJECTS, so a new column joins the
assertion by being selected rather than by anybody remembering a new `expect`.
A second case pins what is deliberately NOT carried — status and requester —
because "equals its source" would otherwise be satisfied by cloning the row
wholesale.

**AND THE FIRST RED-VERIFY WAS VACUOUS, CAUGHT BY THE ANCHOR ASSERTION.** The
mutation's two anchors did not match (the SQL had been reformatted by the fix
itself) and the suite came back **9 passed** — indistinguishable from a guard
that works. Asserting the replacement count before running is what turned that
into an error instead of a false pass, which this file records as the rule and
which earns its keep again here. Re-aimed by LINE, it fails exactly the new
case and nothing else.

**AND THE BACKTICK TRAP BIT AGAIN, IN A `$executeRaw` THIS TIME.** The SQL
comment explaining the fix quoted `test_slug` in backticks; the statement is a
Prisma template literal, so the first one ended the string and produced
`TS1005: ',' expected` two lines down. This file already records that for
`TRENDS_SQL` and then for two more SQL comments an hour later. **Third file,
same trap** — the rule is no backticks inside any SQL comment in this
repository, and the comment now says so where the next reader will be.

═══ WHAT RUNNING THE REAL RUNNER ALSO ESTABLISHED ═══

**THE UID GUARD WORKS AND REFUSES WELL.** Outside compose the first job failed
`RUNNER_UID_ISOLATION_REQUIRED` — "Refusing to execute an uploaded simulation
as the runner's own user; uploaded code would share the control-plane process
credentials and network reach" — naming `RUNNER_CHILD_UID` and the
`RUNNER_ALLOW_SAME_UID` escape. `infra/docker-compose.yml` sets
`RUNNER_CHILD_UID: 20001` with `user: root` and `cap_add: [SETUID, SETGID]`,
so the shipped deployment is configured and the guard fires exactly where it
should. Not a defect; recorded because a reader meeting that error outside
compose should know it is the product working.

**AND `RUNNER_ARTIFACT_DIR` DEFAULTS TO A RELATIVE PATH, WHICH TWO PROCESSES
RESOLVE DIFFERENTLY.** `.perfportal/runner-artifacts` is resolved against each
process's own cwd, so an API started with `pnpm --filter @perfportal/api` and
a runner started the same way disagree by two directories, and the job fails
`ARTIFACT_NOT_FOUND` after creating its run. Compose gives both the same
absolute volume, so this cannot happen there — but anyone running the two by
hand meets it, and the error names the artifact rather than the directory.
Recorded rather than changed: the default is right for the container and the
harness is what was unusual.

**WHAT WAS RUN.** `typecheck` and `lint` green by their own exit codes;
`test:unit` **155 / 1961** and `test:integration` **138 / 1769** against a
SCRATCH DATABASE. The end-to-end proof is the table above — the same artifact
retried before and after the fix, on a real runner executing real Gatling
against a real target, 1,728 requests and 99,955 ms of load per run.

**AND THE FIRST INTEGRATION RUN FAILED FOUR WAYS BECAUSE OF THE HAND-RUN
STACK, WHICH IS THE TRAP THIS FILE ALREADY RECORDS FROM THE OTHER SIDE.** The
entry above about a stray worker is about the DATABASE; this is REDIS. A
worker left running from the verification was consuming the `ingest` queue the
suite enqueues into, so three of the four failures were a job list the test
had just written coming back EMPTY:

```
  expected [] to include 'd82e5e3c…'          commits the run row before enqueuing
  expected [] to have a length of 1           two sweeps dedupe to one job
  Test timed out in 120000ms                  re-queues a job in the failed set
```

**A SEPARATE DATABASE IS NOT ISOLATION.** The suite was pointed at its own
scratch database and still failed, because `REDIS_URL` was shared and the
queue is the thing being asserted on. Re-run with nothing of ours running:
**138 / 1769, clean.** `pgrep -f dist/main.js` before believing an integration
result, and check the queue depth too — `LLEN bull:ingest:wait` was 3 when
this started.

The abandoned-runs-keep-their-data branch added ONE unit file —
`packages/plugin-gatling/test/truncate.test.ts` (3) — from **154 / 1958 to
155 / 1961**, and 2 cases to `apps/worker/test/pipeline.integration.test.ts`.
Integration moves with BOTH (that new file is a `.ts` integration runs too),
from 137 / 1762 to **138 / 1767**. **e2e stays 148.** All three READ OFF CI's
own `build` log rather than this machine — see the closing paragraph, which
is why. It is the arm the branch below recorded as NOT taken, and
it is a FEATURE rather than a correction: an abandoned run now keeps what it
measured.

**MEASURED BEFORE AND AFTER, ON THE SAME SCENARIO.** A live run opened, handed
18,884 bytes of a real `simulation.log`, producer killed:

```
                 before                     after
  status         incomplete                 incomplete
  simulation     null                       example.ParitySimulation
  durationMs     null                       36028
  stat rows      0                          14   (1 run, 7 request, 6 group)
  run totals     —                          count 440 / ok 428 / ko 12
```

Those totals are EXACTLY the live delta the fold owner had already published
and a reader had already watched. The data was never missing; nothing
assembled it.

**THE PULL PARSER REFUSES A PARTIAL LOG, AND THAT IS WHY THIS NEEDED A NEW
FUNCTION.** `parseSimulationLog` reads a FINISHED buffer —
`TruncatedError: needed 4 bytes at 18884, have 0`. `StreamingLogDecoder`
already rewinds to the last whole record for the live feed and reports it as
`consumedBytes`. `truncateToWholeRecords` cuts there: 18,884 in, 882 events,
**18,883 out**, one byte dropped. A complete log comes back byte-identical, so
the normal close path pays nothing. **ONE DECODER STILL** — this asks the
module that owns record framing rather than re-deriving it.

**CLAIMED IN THE TRANSACTION, ASSEMBLED OUTSIDE IT.** The sweep holds its rows
under `FOR UPDATE`, and this file already records that reaching for a second
connection there self-deadlocks. Reading every chunk out of S3 under those
locks would be the same mistake wearing network latency. So the transaction
does a CAS off `running` to `parsing` — stamping `stream_abandoned_at` in the
SAME statement — and the assembly happens after `COMMIT`, exactly as
`LiveService.close` claims first and assembles after.

**AND THE FIRST ATTEMPT LEFT EVERY ABANDONED RUN STUCK AT `parsing` FOR
EVER.** Assembly worked — 18,883 bytes, sha written — and the pipeline then
failed with `RunLockedError: … is locked by the live fold owner; will retry`,
exhausted its attempts, and stopped. `close()` publishes `live:closed` AT ITS
CLAIM precisely so the owner drops the advisory lock before the pipeline wants
it, and this file says so in that method's own comment. The sweeper published
nothing. **The owner's own tick does release a run that has left `running`, so
this is a race the job can LOSE rather than a deadlock** — which is worse to
diagnose, not better, because the lock is gone by the time you look.

**A NEW COLUMN, BECAUSE THE PIPELINE COMMITS STATISTICS AND THE STATUS
TOGETHER.** That terminal `UPDATE` wrote `'complete'` as a literal, and an
abandoned run must end `incomplete` — the state the run list's filter, the
needs-attention tally and the decision band all read. It is a `CASE` on
`stream_abandoned_at` now, so the two still commit in one transaction. NULL
for every existing run and every healthy close, and exactly one writer ever
sets it, so the expression is `'complete'` byte-for-byte on every path that
existed. Regression-verified end to end: a full log closed normally still
reads `complete`, 895 / 871 / 24.

**FAILURE LEAVES TODAY'S OUTCOME AND SAYS SO.** If the bucket is unreachable
or nothing decodable arrived, the run is finalized `incomplete` with no
statistics — precisely what it got before this existed — so the change cannot
strand a run at `parsing`. The catch **logs**: the first version swallowed it
silently and cost an hour, because `expected Run record (0) at byte 0, got 31`
was invisible until the handler was made to print.

**THAT ERROR WAS THE FIXTURE, NOT THE PRODUCT, AND 31 IS GZIP'S MAGIC BYTE.**
`seedRun` uploads a tarball to `bundleKey` for the upload path's sake, and
`LiveChunkStore.finalize` SKIPS re-assembly when the key already exists — so
the sweeper handed the pipeline a `.tgz`. A run that is still `running` has
never had a bundle assembled; the fixture now clears it. **A seeder written
for one path is a claim about the other**, and the guard that made it visible
was reading the error rather than the status.

**WHAT WAS RUN, AND WHAT THE MACHINE WOULD NOT ANSWER.** `typecheck` and
`lint` green by their own exit codes; `test:unit` **155 / 1961**. The two new
integration cases pass in isolation (2 passed, 24 skipped). The FULL
`pipeline.integration.test.ts` reported **4 failed** — and the same file on
clean `origin/main`, with this change entirely backed out, reported **4 failed
too**, the same sweeper cases plus the same 120-second timeout. `vm_stat` said
**3,888 free pages** with 17,235 MB of 18,432 MB of swap gone, which is worse
than the 4,390 this file already calls untrustworthy. **Backing the change out
and re-running the same file is what separates "I broke this" from "this
machine cannot answer"**, and it is cheaper than either guess.

**AND CI ANSWERED IT, SO THE FLOORS ABOVE ARE MEASUREMENTS RATHER THAN A
DEFERRAL.** The `build` job passed `pipeline.integration.test.ts` on clean
containers and printed all three totals:

```
  pnpm test:unit         Test Files 155 passed (155)   Tests 1961 passed (1961)
  pnpm test:integration  Test Files 138 passed (138)   Tests 1767 passed (1767)
  pnpm test:e2e          Running 148 tests using 2 workers
```

The integration arithmetic closes exactly — 137 + 1 file, 1762 + 3 unit cases
+ 2 integration cases — which is the check that makes those numbers worth
writing down. **This entry first said the integration floor was unmeasurable
and pointed at CI, which was honest and is no longer true**; the
read-the-floors-off-the-runner rule this file already records for the
allow-insecure-cookies branch is a thing to go back and DO, not only to cite.
A floor recorded as unknown once it is known is the same staleness the whole
section exists to prevent.

**AND `git add -A` STAGED THREE FILES THAT PREDATE THE SESSION** —
`docs/ui-review-2026-09-13/`, `review.md` and `scripts/seed-manual-test.mjs`,
1,264 lines of unrelated documentation into a nine-file change. This file
already records those three by name as what `git stash -u` sweeps up; `-A`
is the same trap with a different verb. Caught by reading `--cached --stat`
before committing, which is the habit worth keeping.

The incomplete-run-discards-data branch added no unit FILE and 3 cases to
`apps/web/test/StatisticsTable.test.tsx`, from **154 / 1955 to 154 / 1958**,
and its **e2e rises to 148**. Integration is UNCHANGED (every file it touches
is a `.tsx`, a fixture or a spec). Found by producing a real incomplete run
end to end rather than by reading about one.

**A RUN THAT MEASURED 440 REQUESTS REPORTED THAT NONE HAD BEEN RECORDED.**
Opened live against a real stack, handed **18,884 bytes** of a real
`simulation.log`, producer then killed. Observed, in order:

```
  POST /v1/runs/live          202   run opened
  POST /v1/runs/:id/stream    202   {"nextOffset":18884}
  live:<run>:snapshot               count 440 / ok 428 / ko 12
  t+8s, the sweeper                 status incomplete
  GET  /v1/runs/:id/stats           0 rows
  GET  /v1/runs/:id                 simulation null, durationMs null
```

The fold owner DID process it — the delta is in Redis and a reader watching
the live page saw those 440 requests. The chunks are still in the object store
(`live/<run>/0000000000000000.bin`). **Nothing assembles them**, because
`finalizeLive` runs only under `close()` and the sweeper must never re-enqueue
— which this file already explains, correctly, as a LIMITATION. What nobody
had checked is what the product then SAYS.

**IT SAID "No statistics were recorded for this run".** To a reader who had
just watched 440 requests stream past. They were recorded; they are not
RETAINED, and those are different claims. The sentence is now conditional on
the run's own status, and `RunDetail` passes it — the `scopeLabel` shape
`ErrorsTable` already uses, for the same reason: the payload carries a runId
and nothing about the run's fate, so an empty row set reads identically for a
run that measured nothing and one whose measurements were discarded.

**AND THE e2e FIXTURE ASSERTED THE OPPOSITE OF THE SYSTEM, IN A DOCSTRING
WRITTEN TO TELL THE NEXT READER WHAT THE SYSTEM DOES.** `seedIncompleteRun`
said "a real incomplete run usually carries PARTIAL data — whatever arrived
before the producer died" and called its own emptiness "a simplification".
Measured, the fixture is FAITHFUL and the note was wrong: there is no partial
data to carry, and a case wanting partial evidence cannot get it by seeding
harder — it would be seeding a row the product does not produce. **Third time
this session a docstring asserted a behaviour the product does not have**
(after "the CSV export is unchanged" and "equal by construction"), and the
first where the note was specifically written to describe reality.

**THE UNIT CASES PROVE THE COMPONENT AND THE e2e PROVES THE WIRING, AND THE
DIFFERENCE WAS MEASURED.** Removing `runStatus` from `RunDetail`'s call site,
leaving the component untouched:

```
  StatisticsTable.test.tsx   70 passed   blind — it hands itself the status
  run-tables.spec.ts          1 failed   it drives the real page
```

That is "a test that supplies both sides of a join proves neither" with a
number attached, and it is why the browser case is not redundant with the
three unit ones.

**ASSERTED AS A PAIR IN BOTH LAYERS, AND BOTH DIRECTIONS RED-VERIFY
DISTINCTLY.** Restoring the unconditional sentence fails the `retained` case
alone; showing the NARROWER sentence for every empty run fails the two
`recorded` cases — one of which is a completed run that genuinely measured
nothing, the state the new wording must not claim. A third case pins the
fallback for a caller that passes nothing.

**WHAT IS NOT DONE, AND IS A PRODUCT DECISION RATHER THAN A CORRECTION.**
Whether an abandoned run should KEEP what it measured. The machinery exists —
the chunks are stored, `close()` already assembles and parses them, and
`StreamingLogDecoder` handles a truncated tail by design (`TruncatedError`,
rewind) — so a sweeper that assembled the partial bundle before finalizing is
buildable. It changes what an abandoned run IS, so it is recorded here rather
than taken in passing.

**WHAT WAS RUN.** `typecheck` and `lint` green by their own exit codes;
`test:unit` **154 / 1958**; `pnpm test:e2e` **148 passed**. Both suites, and
the live-run exercise that found this, ran against a SCRATCH DATABASE
(`perfportal_fail`, created, migrated, dropped) with
`RUNNING_STALE_AFTER_MS=5000` and `SWEEP_INTERVAL_MS=2000` so the sweeper
could act inside a session rather than in ten minutes — **both are env-tunable
and that is what makes this path reachable by hand at all.** The nine real
Gatling runs were confirmed untouched afterwards.

**AND TWO TRAPS THIS FILE ALREADY RECORDS BIT AGAIN.** An inserted block used
`toBeInTheDocument` — `StatisticsTable.test.tsx` does not import
`@testing-library/jest-dom/vitest`, so it is an "Invalid Chai property" rather
than a failed assertion, exactly as recorded for `NewRunnerRun.test.tsx`; read
the file's existing matchers before writing new ones. And the first insertion
anchored on a docstring line that did not match, which reported an
ASSERTION ERROR and left the suite at its old count — caught because the count
did not move, which is the tell this file keeps naming.

The browser-downloads branch added ONE e2e file —
`apps/web/e2e/downloads.spec.ts` (2) — so **e2e rises to 147** from 145. Unit
stays **154 / 1955** and integration **137 / 1762**, both UNCHANGED BY
CONSTRUCTION: the unit config includes `apps/*/test/**` and the integration
config `apps/*/test/**/*.test.ts`, and this is `apps/web/e2e/*.spec.ts`, which
neither matches. It closes a gap the export-every-column branch RECORDED
rather than fixed.

**NOTHING IN ANY SUITE HAD EVER DOWNLOADED A FILE.** `downloadBlob`
(`src/download.ts`) is six lines and was exercised by nothing at all. jsdom
implements neither `URL.createObjectURL` nor `URL.revokeObjectURL`, so
`StatisticsTable.test.tsx` and `RunDecisionBand.test.tsx` both STUB THE PAIR
and assert the `Blob` they capture — which proves what a component BUILDS and
says nothing about whether a browser writes it anywhere.

**AND THE CLAIM THAT LEFT UNTESTED IS A RACE, WRITTEN DOWN AS SAFE.**
`downloadBlob` revokes the object URL on the line AFTER `anchor.click()`,
under a comment asserting "the click has already been dispatched
synchronously, so the browser has what it needs". Red-verified by swapping
those two lines:

```
  URL.revokeObjectURL(url);      BOTH cases fail
  anchor.click();                Error: download.createReadStream: canceled
```

**THE EVENT STILL FIRES AND THE BYTES ARE CANCELLED**, which is the whole
argument for reading the SAVED FILE rather than awaiting the event. A spec
that asserted only `waitForEvent('download')` resolving would have passed
against a product that downloads nothing — and the stub in the unit suite
never revokes anything, so no amount of jsdom could reach it. The ordering is
load-bearing, it was only ever asserted in prose, and now it is measured.

**TWO MUTATIONS, LANDING DIFFERENTLY, AND THE SECOND PINS A DIVISION OF
LABOUR.** Moving the BOM into the SHARED helper fails the JSON case ALONE —
the CSV already expects one, and `JSON.parse` on a BOM-prefixed body throws.
That is what keeps `\uFEFF` the property of `downloadCsv` rather than of
handing a file over, which `download.ts`'s own docstring argues at length and
nothing checked.

**ASSERT NON-EMPTY BEFORE ASSERTING CONTENT.** A revoked-too-early blob
delivers a started download carrying zero bytes, so `byteLength > 0` comes
first in both cases; a `toContain` on an empty string fails for a reason that
does not name the cause.

**THE WAIT IS ARMED BEFORE THE CLICK**, because a local download can complete
faster than the next statement runs and a wait attached afterwards misses it —
the same shape as this file's note that `page.on('domcontentloaded')` must be
attached before navigating.

**WHAT WAS RUN.** `typecheck` and `lint` green by their own exit codes;
`test:unit` **154 / 1955**; `pnpm test:e2e` **147 passed** at `--workers=2`
against a SCRATCH DATABASE (`perfportal_e2e`, created, migrated, dropped) —
that suite seeds through the real API and this machine was holding the nine
real Gatling runs the last five branches were verified against. Confirmed
untouched. Chromium only, as `test:e2e` always is; whether a WebKit download
behaves the same is NOT claimed here and `e2e-cross-browser` is the arbiter.

The clamp-percentiles-everywhere branch added ONE source file —
`apps/web/src/percentile.ts` — and 4 cases, 2 to
`apps/web/test/transforms.trends.test.ts` and 2 to `transforms.compare.test.ts`,
from **154 / 1951 to 154 / 1955**. Integration moves with it (both are `.ts`
files integration runs) at **137 / 1762**, and **e2e stays 145** —
`run-trends.spec.ts` names the chart `trend-percentiles` by id and asserts no
value. Found by auditing Trends against the runs it draws.

**TWO OF FOUR SURFACES CLAMPED, SO ONE RUN'S p99 HAD TWO ANSWERS.** A
percentile of a sample cannot lie outside that sample's own range, and
DDSketch's 1% error means the estimate sometimes does. `clampPercentile`
projects it back — and only the statistics table and the run totals tiles
called it. The trend line and the compare overlay plotted the raw value:

```
  the run page      p99  2503        (clamped to its own max)
  the trend line    p99  2515.4601…  (raw)        one run, one quantity
```

**MEASURED BEFORE FIXING, ACROSS NINE REAL RUNS: 30 of 384 percentile values
(7.8%) SIT ABOVE THEIR OWN MAXIMUM**, worst overshoot **+0.59%** — which is
the advertised bound behaving exactly as advertised, and precisely what the
clamp exists to absorb. So it bites often and by little; the defect is that
two surfaces disagreed, not that either number was wildly wrong.

**AND THE HELPER'S OWN DOCSTRING NAMED THE CALLER THAT NEVER CALLED IT.**
`PercentileRange` is documented as "narrower than `StatRow` on purpose, so
**`TrendRun`** (which carries the same pair, from the same rollup) can be
clamped by the same function". The type was narrowed FOR trends. Sixth time
this file records the one-caller-short shape, and the second where the helper
says out loud who else should be reaching for it — `compareLabels` was the
first. **When a helper exists to correct something, grep its own docstring for
who it names.**

**THE BARRIER WAS LAYERING, NOT INTENT, WHICH IS WHY THE FIX IS A MOVE.**
`clampPercentile` lived in `StatisticsTable.tsx`; `charts/transforms/*.ts` are
pure, and importing a React component into one to reach a `Math.min` is not
something to do. So the decision moved to `apps/web/src/percentile.ts`, which
every surface can reach — the same move `isChangeGood` made when the matrix
needed the direction rule `compareSummary` owned. No re-export left behind: a
second name for one decision is how two callers come to disagree about it.

**THE DEFERRAL IN THAT DOCSTRING IS KEPT AND ITS SCOPE CORRECTED.** It said
the right long-term home is `packages/statistics` — still true, still
follow-up, because the API, any export and every future consumer would benefit
— and it ended "doing it in the browser fixes one surface, which is this one".
It reached TWO and stopped. **A deferral's reason is an argument for also
doing the bigger thing; it is not an argument for two browser surfaces to
disagree with each other**, and two-of-four is the worst available state:
neither consistently raw nor consistently projected. Same discipline as
"check whether a deferral's reason covers every surface it was applied to".

**A FIXTURE DESCRIBED DATA THAT CANNOT EXIST, AND THE CLAMP IS WHAT REVEALED
IT.** `transforms.trends.test.ts`'s gap case built a run with `p50: 4, p95: 9`
while inheriting `REFERENCE`'s `minMs` of 16 — a p95 below the minimum. The
moment the series honoured the run's own range the clamp correctly lifted 9 to
16 and the case failed, reading `expected 16 to be 9`. The values were
scaffolding for a claim about a MISSING percentile; they are inside the range
now. **Scaffolding should still be possible**, and a synthetic fixture is
where impossible numbers survive longest.

**THE DATA TABLE IS ASSERTED SEPARATELY FROM THE PLOTTED SERIES.** Both are
built from the same read in `toPercentileTrend`, and a fix applied to the line
alone would leave the table under it contradicting the chart — which is the
whole failure mode this branch is about, one level down. The case pins 2503
present and 2515.46 absent.

**AND EACH SURFACE HAS A MUTATION THAT LANDS ON IT ALONE:**

```
  trends returns the raw value     "projects a percentile back onto the run…"
  compare returns the raw value    "…onto the bucket it was taken from"
  clamp drops its lower bound      the existing pure case, both ends
```

The third failing the OLD test rather than either new one is the right result:
the lower bound was already covered, and the new cases are about the two
callers, not about `Math.min`. A paired "inside its range, untouched" case sits
beside each, because "clamped" must not come to mean "pinned to the maximum",
which would flatten every series the chart draws.

**WHAT WAS RUN, AND WHAT THE MACHINE WAS DOING.** `typecheck` and `lint` green
by their own exit codes; `test:unit` **154 / 1955**. `test:integration` against
a SCRATCH DATABASE (`perfportal_clamp`) reported **137 / 1762 with 2 failed** —
and those two are the documented pressure flake, not this change:

```
  auth.integration.test.ts     last_used_at  expected null not to be null
  window.integration.test.ts   Parse Error: Expected HTTP/, RTSP/ or ICE/
```

The second is a socket receiving non-HTTP bytes, which this file already
records **cannot be produced by any application-level diff** — and this diff is
eight files, every one of them under `apps/web`, so it cannot reach either
suite. `vm_stat` said **4,856 free pages** with 17,007 MB of 18,432 MB of swap
gone, which is worse than the 4,390 this file already calls untrustworthy, at
a load average of 6.18 — the low-load-high-swap combination this file warns
reads as health. Re-run alone, the two files pass **29 / 29**. CI's clean
containers are the arbiter.

The conditional-spread-sweep branch added no unit FILE, no unit case and no
spec — unit stays **154 / 1951**, integration **137 / 1758** and **e2e stays
145**. Its diff is 36 converted expressions, one re-pointed assertion and one
new lint rule. It executes an instruction this file has carried unexecuted
since the runner branch: "**Grep for `...(x ? { … } : {})` before trusting
that a field reaches its repository.**"

**THE HOLE, MEASURED BOTH WAYS, ON THE TYPE THE ORIGINAL DEFECT WAS ABOUT.**
One typo, two spellings, against `CreateLiveRunInput`:

```
  declaredTestSlugTYPO: cond ? v : undefined      TS2561, "Did you mean…"  exit 2
  ...(cond ? { declaredTestSlugTYPO: v } : {})    no errors                exit 0
```

That is the `live-sink.ts` defect reproduced on demand — excess-property
checking applies to a LITERAL assigned to a typed target and not to one spread
into it. **Every green gate this repo runs is blind to it**, which is why that
branch shipped a feature that had never once worked.

**GREP FOUND 31 SITES. THE AST FOUND 40.** The nine grep missed were
multi-line spreads and shapes the regex could not express — and one of them is
the reason this branch exists at all. **A pattern worth banning is worth
banning with a parser**, not a `grep` written to find it once.

**ALL 36 CONVERTED SITES WERE ALREADY CORRECT.** `typecheck` is green after
the conversion, so no key was mistyped anywhere. The result is not a bug fix:
it is 36 expressions moving from unfalsifiable to compiler-checked, and the
red-verify above is what makes "green" mean something rather than nothing.

**AND ONE FIX THIS FILE CLAIMS TO HAVE MADE WAS NEVER MADE.** The
token-lifecycle entry says the mint payload was "Written as a named `expiresAt:
… ? undefined : …` instead … Verified by making it and watching `tsc` reject
it." `ProjectAccess.tsx` still held the spread. `git log -S` settles it: the
named form **has never existed in that file**, and the spread was introduced by
`19efaad` — **the same commit that added the paragraph claiming it was
converted.**

**SO THE RED-VERIFY'S RESTORE TOOK THE FIX WITH IT, AND ONLY THE WRITE-UP
SURVIVED.** That is the `git checkout --` trap this file records SIX times,
in its worst form yet: the previous five cost a re-run, this one shipped a
documented-as-fixed defect and left a paragraph asserting a verification the
tree contradicts. **A lesson written down is not a lesson applied, and an
entry asserting a specific verification is a claim like any other** — check
it against the code, which is what this sweep did.

**THE GUARD IS AN eslint SELECTOR, BECAUSE THE ALTERNATIVE IS THIS AGAIN IN
SIX MONTHS.** `SpreadElement > ConditionalExpression > ObjectExpression[properties.length>0]`
— a conditional spread carrying an object LITERAL. `...(cond ? typedValue : {})`
is deliberately allowed: the value carries its own type, so there is nothing
to lose. Red-verified by putting one spread back, which fails `pnpm lint` with
the file and line.

**`Chart.tsx` IS EXEMPT, AND THE REASON IS A MEASUREMENT RATHER THAN A
PREFERENCE.** Its six spreads assemble the ECharts option bag, and the rule's
premise — that a typed target would otherwise check the literal — does not
hold there. Measured, by putting a bogus key in that literal as a plain
property:

```
  bogusKeyThatCannotExist: 1,      pnpm typecheck -> exit 0
```

`EChartsOption` carries index signatures, so there is no check to lose.
Converting six multi-line spreads in the most delicate rendering file in the
app would have bought exactly nothing. **An exemption gets its evidence
attached**, and the block says to delete it if ECharts ever tightens that type.

**WHERE A BRANCH IS A WHOLE OBJECT RATHER THAN A KEY, ANNOTATE INSTEAD.**
`rule.ts` had two `where` spreads whose branches differ in SHAPE
(`{ testId: null }` against `{ OR: [...] }`), so no single named key exists.
`const testScope: Prisma.SlaRuleWhereInput = …` gives BOTH branches a
contextual type and the spread of a typed value is checked. Red-verified:
`testId` to `testID` in one branch is `TS2322`. Worth closing rather than
exempting — a `where` that silently stops narrowing is the silent-gate class
this file already records, a test-scoped rule reading as protection and
judging nothing.

**ONE CONVERSION CHANGED BEHAVIOUR, AND A REAL TEST CAUGHT IT.**
`NewRunnerRun.test.tsx`'s "omits the test entirely when the default grouping
is kept" asserted `expect(metadata).not.toHaveProperty('test')` — and a named
key holding `undefined` IS present. **The object changed; the WIRE did not:**

```
  'test' in obj     spread false   named true
  JSON.stringify    {"name":"soak"}   {"name":"soak"}    identical
```

`startRunnerRun` sends `JSON.stringify(metadata)` and nothing in that module
ever inspects the keys, so the server receives the same bytes either way. The
assertion was a claim about the object AS A STAND-IN for the payload; it
serialises now and asserts what is actually sent. **Re-pointed, not
weakened** — red-verified by making the payload always carry `test`, which
fails it.

**AND THAT RED-VERIFY WAS VACUOUS ON THE FIRST ATTEMPT.** A regex for
`test: <anything>,` matched the FORM'S INITIAL STATE (`test: ''` at line 80)
rather than the payload expression at 207, so the mutation changed a default
nobody asserts and the suite came back **13 passed** — indistinguishable from
a guard that works. The tell was the count, again. **Anchor a mutation on the
whole expression, not on a key that appears in three places.**

**WHAT WAS RUN, AND AGAINST WHAT.** `typecheck` and `lint` green by their own
exit codes; `test:unit` **154 / 1951**; `test:integration` **137 / 1758**
against a SCRATCH DATABASE (`perfportal_sweep`, created, migrated, dropped) —
that suite truncates every table and this machine was holding the nine real
Gatling runs the last three branches were verified against. Confirmed
untouched afterwards. Integration matters here because four persistence
repositories changed, and Prisma's reading of `undefined` as "not provided" is
the property the whole conversion rests on.

The errors-tally-counts-errors branch added no unit FILE and 1 case to
`apps/web/test/ErrorsTable.test.tsx`. Cut from **154 / 1948**, it measured
154 / 1949 on its own; export-every-column merged FIRST and took `main` to
154 / 1950, so after merging `main` back in this branch measures
**154 / 1951** — RE-MEASURED, not inferred.
Integration is UNCHANGED (every file it touches is a `.tsx`) and **e2e stays
145** — `run-detail.spec.ts`'s errors case asserts the ROW COUNT against the
KO column and never reads the tally, so the wording its NAME carries is a test
name rather than an assertion. **CUT FROM THE SAME `main` AS
export-every-column**, and this paragraph is the reconciliation that predicted
itself: both branches inserted an entry at the same point in this file, so the
second to merge resolved the conflict by keeping both. The arithmetic — 1 case
onto whatever it sits on — is what survived.

**THE ERRORS TAB SAID "310 FAILED REQUESTS" ON A RUN WITH 294.** The tally
line under the heading renders `{rows.length} error types · {total} failed
requests`, and `total` is the sum of the error counts. Measured on a real
1,724-request Gatling run: 6 error types, `total` **310**, and the run's own
KO tile one tab over reading **294**.

**THE RAW LOG ADJUDICATES, AND BOTH NUMBERS ARE RIGHT.** Decoded with
`parseSimulationLog`: `{"meta":1,"user":960,"request":1724,"group":780,
"error":16}` — **1,724 request records of which 294 KO, plus SIXTEEN
STANDALONE `error` RECORDS**. Gatling emits a session or EL failure as its own
record type, carrying a message and a timestamp and NO request name:

```
  {"type":"error","message":"Add To Cart: No attribute named 'sessionId' is defined ",…}
```

294 + 16 = 310. So `total` is every recorded error and `koCount` is failed
requests, and the label named the one thing `total` is not.

**THE COMPONENT'S OWN CAPTION HAD IT RIGHT ALL ALONG.** Three lines below the
tally: "share of the 310 errors this run recorded — **not of the requests it
made**". One component, one number, two nouns, and the correct one was already
written down. **When two expressions in one file describe one value, the seam
is inside the file** — this repo usually records that shape across components.

**AND THE DENOMINATOR'S COMMENT ASSERTED THE BUG AS AN INVARIANT.** It read
"the two are equal by construction anyway (measured in task 1: 15 + 9 = 24 =
the run row's `koCount`)". That measurement is CORRECT about the reference run
and false in general — `ParitySimulation` emits no standalone `error` record
at all, so on that fixture `total` and `koCount` genuinely coincide. **A
FIXTURE THAT CANNOT DISTINGUISH TWO QUANTITIES IS THE PLACE A FALSE INVARIANT
GETS WRITTEN DOWN**, and this file already records the same shape for a
geometry bound measured against a 24-character simulation name.

**THE THREE EXISTING CASES PINNED THE FIXTURE'S NUMBERS VERBATIM** — `/24
failed requests/i` — so they were green throughout and would have been the
reason the label survived. Re-pointed at the claim, which is this file's
standing rule for prose, met for the fourth time.

**THE NEW CASE ASSERTS THE AGREEMENT, NOT EITHER WORDING.** Two mutations,
landing distinctly: restoring `failed requests` fails all three tally cases,
while deleting the caption's "not of the requests it made" fails ONLY the new
one. That asymmetry is the argument for it — the two old cases cannot see the
caption at all, which is the half that was already correct.

**AND THE GLOSSARY GUARD CAUGHT WHAT THE CHANGE ORPHANED, WHICH IS THE SYSTEM
WORKING.** `RunGlossary.test.tsx` asserts every word the glossary DEFINES is a
word the product RENDERS, per-word and per-file. Renaming the tally left
`failed requests` defined and rendered nowhere, and the full unit run failed
on exactly that — one case, naming the word and the file. The entry is
`Errors, recorded errors` now, and `WORDS` is derived from the glossary's own
`term` field, so the guard's map moved with it rather than being re-listed.

**AND THAT ENTRY WAS BUILT ON THE SAME FALSE PREMISE.** It read "the Errors
tab counts distinct error messages; the run totals count failed requests …
this run's 2 and 24 are both right" — the reference run's coincidence again,
explaining TWO numbers where the product shows THREE. It now names all three
(distinct messages, recorded errors, KO) and says why the second can exceed
the third. Same shape as the glossary-percentile-parity branch: **the glossary
is where this product records the exception to a promise it makes elsewhere.**

**A SOURCE FILE HELD A LITERAL NUL BYTE, AND `grep` SILENTLY SKIPPED IT.**
`ErrorsTable.tsx` keyed its folded-remainder row on a string beginning with a
RAW NUL. `file` reports the whole file as `data`, so every `grep` over it
returns nothing at all — which is how the caption/tally disagreement survived
a grep-based audit of exactly that file, and is why this one-character change
rides with this branch rather than waiting for its own. It is the `\u0000`
escape now: verified byte-identical by evaluating the literal straight out of
the source (`codePointAt(0) === 0`, length 6), so the React key is unchanged.

**THIS FILE ALREADY RECORDS THE SAME BYTE IN `tool-assertions.ts`** and
already prescribes the fix ("same bytes"). Second occurrence, in
`apps/web/src` this time. **AND THE COST IS NARROWER THAN IT LOOKS — MEASURED
RATHER THAN ASSUMED**: `git diff` renders it as ordinary text (`--numstat`
gives real counts, not `-  -`), and Node's `readFileSync` reads it fine, so
every suite and every source-scanning guard was unaffected. What breaks is
`grep`, `file`, and any CLI text tool — in a repo whose conventions are full
of "grep for X before doing Y", which is the whole cost.

**WHAT WAS RUN.** `typecheck` and `lint` green by their own exit codes,
`test:unit` **154 / 1951** on the merged tree. Integration and e2e are untouched by construction
and were not re-run. Found by reconciling the drill-down against the main
table on a real run — and the drill-down itself came out CLEAN: 12 rows
compared against their own scoped series, **36 of 36** exact on count, min and
max, and `RequestDetail` cannot drift by construction because it reads the
run's own payload rather than a scoped one.

**AND THE FIRST TWO ATTEMPTS AT THAT RECONCILIATION BOTH CRIED WOLF.** A
series bucket with an empty sketch reports **0** for min/max/mean and `{}` for
percentiles — `bucketLatency`'s documented asymmetry — so an unfiltered
`min over buckets` reads 0 and accuses the product. Filtering on
`endedCount > 0` is WRONG IN THE OTHER DIRECTION: the sketch is keyed on
START, so a bucket that ended nothing still carries real latencies, and that
filter silently dropped a real maximum (4219 read as 4166). The honest
emptiness test is the documented one — empty `percentiles` — and with it the
36 comparisons are exact. **Third false alarm of this verification, and the
product was right all three times.**
The export-every-column branch added no unit FILE and 2 cases to
`apps/web/test/StatisticsTable.test.tsx`, from **154 / 1948 to 154 / 1950**.
Integration is UNCHANGED (both files it touches are `.tsx`, which that config
never runs) and **e2e stays 145** — no spec has ever downloaded a CSV. Found
by asking whether the export agrees with the screen it came from, which is
the seam the two findings before it also lived on.

**A VARIABLE CALLED `allColumns` HELD THE VISIBLE ONES, FOR 237 COMMITS.**
Review M11 opened the statistics table on eight of the thirteen columns the
payload carries, and argued — correctly — that fifteen columns is an archive
rather than a table. It said in the same breath that "the rest are one
disclosure away, **the CSV export is unchanged**". Then it changed the export's
own line from `[...columns...]` to `[...shown...]`, KEPT THE NAME, and wrote a
comment above it reading "the CSV export below deliberately still uses every
column — a download is an archive".

**THREE WRITTEN CLAIMS, ALL FALSE, AND EACH ONE MADE THE NEXT LESS LIKELY TO
BE CHECKED.** The constant's docstring, the expression's own comment, and the
test file's M11 describe all state the invariant. A reader arriving at that
line met an identifier asserting it, a comment restating it, and an expression
breaking it. **A NAME IS NOT A CHECK**, and this one was doing a check's job.

**MEASURED, ON THE REFERENCE PAYLOAD, BOTH WAYS IN ONE RUN:**

```
  on screen at rest   9   Requests Total KO %KO Cnt/s 50th 95th 99th Max
  the CSV header      9   Requests Total KO %KO Cnt/s 50th 95th 99th Max
  every column       14   … + OK, Min, 75th, Mean, Std Dev
```

`inCsvButNotOnScreen` was the empty list. The file was exactly the screen.

**AND IT LANDED ON THE SENTENCE THIS FILE SHIPPED TWO BRANCHES EARLIER.**
`RunGlossary`'s `estimate` entry — the glossary-percentile-parity branch —
tells a reader that "Total, OK, KO, Min, Max and Mean are exact, and are what
to diff the two reports on". **Three of those six — OK, Min and Mean — are off
by default.** So the product sent a reader to the download to diff against
Gatling and handed them a file missing half the columns it had just named,
with nothing on screen saying so. The advice was right and the artifact could
not support it.

**THE EXISTING HEADER CASE COULD NOT SEE IT, AND ITS NAME SAYS WHY.** "heads
the file with the columns **the table is rendering**" asserts every VISIBLE
header appears in the file — which an export of exactly the visible columns
satisfies perfectly. It pins the INTERSECTION; the claim is about the
SUPERSET. This is the windowed-scope lesson one file over and one branch
later: **an assertion that takes its expectation from the thing under test
proves the consumer, never the default.** There, a case passed `?scope=request`
on both sides; here, a case reads the headers off the very table it is
checking.

**ASSERTED AS A PAIR, AND THE VACUITY GUARD IS THE HALF THAT EARNS ITS
LINES.** "the file carries Std Dev" alone passes against a table that has
stopped hiding anything — M11 undone, the export merely agreeing with a screen
that now shows everything. So the case first requires that the default really
is narrower than the payload, and only then that the hidden columns are in the
file. Two mutations, landing on DIFFERENT ASSERTIONS INSIDE ONE CASE:

```
  export takes the visible set   "OK is off by default and must still be in the file"
  the picker hides nothing       "the default column set no longer hides anything"
```

The second also fails M11's own two cases, which is right — it is M11 being
undone — and does NOT fail the glossary case, because every column is then
present. That asymmetry is what proves the pair is exclusive rather than
redundant.

**THE GLOSSARY CASE SPELLS THE SIX LABELS RATHER THAN IMPORTING THEM.** The
coupling is a claim that TWO SURFACES AGREE, and a shared constant would move
both sides together and assert nothing — the same reason this file already
gives for asserting a claim rather than pinning prose.

**AND THE PROBE RAN ON NODE 20 FIRST AND REPORTED NOTHING AT ALL.**
`webidl.util.markAsUncloneable is not a function`, `Test Files no tests` — the
trap at the top of this section, met while measuring rather than while
gating, and it costs a round trip in exactly the same way. `nvm use` first,
even for a throwaway probe.

**TWO SMALLER THINGS, BOTH CAUGHT BY GUARDS RATHER THAN CARE.** A
`\ballColumns\b` rename matched SIX times as intended and a seventh inside
the new comment quoting the old name — the "an anchor matched inside my own
new comment" shape this file already records, caught because the replacement
count was asserted before the file was written rather than after. And
vitest SWALLOWS `console.log` in this configuration, so the first probe passed
and printed nothing; forcing the values into a deliberately failing
`toEqual` is what made them readable.

**WHAT WAS RUN.** `typecheck` and `lint` green by their own exit codes.
`test:unit` **154 / 1950**, which is the recorded floor plus exactly this
branch's two cases. Integration and e2e are untouched by construction and
were not re-run. The machine was at 44,311 free pages and load 4.07 — the
first branch in a while where the suite was worth believing.

**WHAT IS STILL NOT COVERED, STATED RATHER THAN IMPLIED.** No test in any
suite has ever downloaded a file in a BROWSER: jsdom implements neither
`URL.createObjectURL` nor `revokeObjectURL`, so `StatisticsTable.test.tsx`
stubs both and asserts the Blob it captures. `downloadBlob` itself — six
lines, unchanged here — is therefore exercised by nothing, and the same is
true of the run-summary JSON export beside it.

The windowed-stats-all-scopes branch added no unit FILE and no unit case —
unit stays **154 / 1948** — and 2 INTEGRATION cases to
`apps/api/test/window.integration.test.ts`, from **137 / 1756 to 137 / 1758**.
**e2e stays 145.** Found by brushing a time window on a real run while
verifying the product against Gatling, not by any suite.

**ONE QUERY PARAMETER MEANT TWO THINGS ON ONE ENDPOINT.** `GET
/v1/runs/:id/stats` treats `scope` as a FILTER when no window is applied —
`rows.filter((s) => (scope ? s.scope === scope : true))` — and the windowed
branch read `scope ?? 'run'`. So brushing a window dropped every per-request
and per-group row and collapsed the statistics table to the run's own totals,
**at precisely the moment a reader narrows to a spike to find out WHICH
request it belongs to**. That is the one question brushing exists to answer.

**THE ROWS WERE NEVER MISSING. NOTHING ASKED FOR THEM.** `windowedBuckets`
selects by (scope, family) and returns every NAME within it, so the data was
one parameter away the whole time — proven against the live instance before
any code changed:

```
  ?from=30000&to=60000&scope=request&name=Session       186 requests, p95 2046
  ?from=30000&to=60000&scope=request&name=Place Order    65 requests, p95 455
  ?from=30000&to=60000&scope=group&name=Cart             67 groups,   p95 589
```

**AND A CASE NAMED FOR THIS EXACT BEHAVIOUR COULD NOT SEE IT.** `window.integration.test.ts`
has had "windows the per-request rows too, not only the run" since the feature
shipped — and it passes `?scope=request` on BOTH sides. It proves the explicit
path and says nothing about the DEFAULT, which is the only thing the
statistics table ever sends. **A test that supplies the parameter it is
checking proves the consumer, never the default** — the same shape this file
records for `resolveTestId` being handed the slug it then verified.

**THE FIRST FIX WAS WRONG AND THE BENCHMARK IS WHAT SAID SO.** It derived the
(scope, family) pairs from `run_stat` and issued one `windowedBuckets` call
per pair. Every window case passed. `window-bench.integration.test.ts` then
failed on `expected [] to have a length of 50` — because that fixture seeds
BUCKETS DIRECTLY and writes no `run_stat` row at all, so the pair discovery
found nothing and the endpoint returned zero rows. **The buckets are the
source of truth for a windowed read**, and a run can carry buckets with no
matching stats row. The benchmark exists for cost and caught a correctness
defect; it was the only test in the repo that could, because it is the only
one that builds its fixture from the bottom.

**SO THE PREDICATES BECAME OPTIONAL INSTEAD, WHICH IS ALSO FEWER QUERIES.**
`WINDOWED_BUCKETS_SQL` takes `($5::text IS NULL OR scope = $5)` and the same
for family, and carries `scope`/`family` on each row so one pass can be
grouped back into the table. A caller naming both still gets the narrow
predicate it always did; an unscoped read now costs a wider result set rather
than N round trips.

**AND `git checkout --` DESTROYED THE FIX. SIXTH TIME IN THIS FILE, AND THE
SECOND WHERE THE CHECKPOINT WAS THE TRAP.** The checkpoint was committed
against the FIRST (pairs) implementation; the rewrite that replaced it was
never committed, so restoring after the first red-verify silently reverted to
the version the benchmark had already rejected. The tell was the next
mutation reporting `ANCHOR MISSED` — the string it was looking for existed
only in the lost rewrite. `read.ts` survived only because it was never the
mutation target.

The entry two above this one prescribes the guard — "commit again after any
material change, before the next mutation" — and it was written in this same
session. **A checkpoint is only a checkpoint if it holds the shape you are
verifying**, and the cheap mechanical version is `git commit --amend` the
moment an implementation is replaced, not when it is first drafted.

**TWO MUTATIONS, EACH LANDING ON ITS OWN CASE.** Restoring `scope ?? 'run'`
fails ONLY the new unscoped case; passing `{scope: null, family: null}`
regardless of the caller fails "still narrows to a named scope under a
window". The second guard is why the fix is a FILTER rather than "return
everything" — widening without keeping narrowing true would trade one wrong
answer for another, and every chart caller that names a scope would start
paying for rows it never reads.

**AND TWO MUTATIONS THAT NEVER APPLIED BOTH REPORTED GREEN.** One anchor
matched three times — twice as code and once inside the new comment quoting
it — and one died on nested quotes in the shell. Both runs came back
16/16 passed, which is indistinguishable from a mutation that changed nothing
important. **Assert the replacement COUNT before running, never the result**;
this file already records that a red-verify which passes means the mutation
missed.

**WHAT WAS RUN, AND AGAINST WHAT.** `typecheck` and `lint` green by their own
exit codes. The six integration suites that read `/stats` — window,
window-bench, read, parity-endpoints, trends and parity.e2e — pass **101 /
101**. They were run against a SCRATCH DATABASE (`perfportal_verify`), not
the developer one: `test:integration` truncates every table, and this machine
was holding real runs somebody was mid-way through reading. The unit suite is
untouched by this change and was not re-run.

The glossary-percentile-parity branch added no unit FILE and 2 cases to
`apps/web/test/RunGlossary.test.tsx`, from **154 / 1946 to 154 / 1948**.
Integration is UNCHANGED (that file is a `.tsx`, which that config never runs)
and **e2e stays 145** — no spec changed. It comes out of verifying the product
against four real Gatling runs, and it is a defect in a CLAIM rather than in a
number.

**THE GLOSSARY PROMISED COLUMN-BY-COLUMN PARITY AND PERCENTILES ARE THE
EXCEPTION.** `RunGlossary`'s `OK, KO` entry tells a reader the statistics table
"can be read beside Gatling's own report column by column — its headings are
the same words in the same order", and the module docstring explains the
headings are byte-identical FOR THAT PURPOSE. Every exactly-tracked quantity
honours it. The percentile columns do not, and nothing said so.

**MEASURED, ON A REAL 1,718-REQUEST RUN.** `List Products` p99 reads **809**
here and **1368** in Gatling's own report. Sorted, that request's tail is
`… 435, 809, 1368, 1492, 1654` over 300 samples — so the two answers are **one
order statistic apart**, which in a heavy tail is a 69% gap. The whole-run p99
diverges the other way: 10617 here, 7904 in Gatling, against a true
nearest-rank value of **10513**.

**AND THE SKETCH IS NOT WHAT DIVERGES, WHICH IS THE PART WORTH WRITING DOWN.**
Compared naively against Gatling, **14 of 40 percentiles fell outside the 1%
the caption advertises, worst 41%** — which reads as a serious defect in the
product's most scrutinised number. Re-measured against exact nearest-rank
values computed from the raw log, it is **28 of 28 INSIDE 1%, worst 0.99%**,
and where the two products differ PerfPortal is the closer of the pair. The
DDSketch bound holds exactly as `sketch.ts` claims for itself ("up to ~1.000%
max relative error … not slack we have to spare").

**A COMPARISON IS ONLY AS GOOD AS ITS ORACLE.** Gatling's report is the right
oracle for counts and extremes and the WRONG one for percentiles, because the
question "what is p99" has two defensible answers at small N. Trusting the
first table would have raised a false alarm; the raw log is what adjudicates.
This file already records the inverse — a red result that is a build claim
before it is a code claim — and this is the same shape from the other side: a
red result that is an ORACLE claim before it is a product claim.

**THE FIX IS IN THE GLOSSARY, BECAUSE THAT IS ALREADY THE PAGE'S ANSWER TO
"WHY DOES THIS WORD NOT MEAN WHAT I EXPECTED".** The `estimate` entry now says
percentiles are taken at the nearest rank, that one here can differ from
Gatling's own column by a whole measurement, that both numbers are right, and
**which figures ARE exact** — Total, OK, KO, Min, Max and Mean, i.e. what to
diff the two reports on. The caption's "accurate to within 1%" is untouched
and was never the problem: it is a claim about the sketch, not about Gatling.

**THE CLAIM IS ASSERTED AS A PAIR AND NEITHER HALF IS SUFFICIENT.** A warning
with no exception list reads as "trust none of this table"; an exception list
with no warning is the promise that caused the defect. Two mutations, each
landing on its own case and reporting differently — keeping the Gatling
mention while deleting the disagreement fails the first alone, and deleting
the exact-columns sentence fails the second alone. Asserted as a CLAIM rather
than as wording, because this file records twice what pinning prose verbatim
costs: a sentence that was right when written becomes the reason a correction
cannot land.

**AND NO SUITE COULD HAVE FOUND IT — IT TOOK EXECUTING GATLING.** Every gate
was green throughout, because nothing in the repo compares this product's
percentiles against Gatling's own REPORT; `parity.test.ts` deliberately binds
"exact quantities only — never its percentiles". That is the right test and it
is why the gap in the PROSE survived. Same lesson as `declaredTestSlug`: when
a claim is about agreement with another product, only running that product
checks it.

**WHAT WAS RUN, AND WHAT WAS NOT.** `typecheck` and `lint` are green by their
own exit codes; `RunGlossary.test.tsx` passes 24/24. The full unit suite was
NOT measured — the machine was at **4,691 free pages with 17,103 MB of 18,432
MB of swap gone**, which this file already calls a tree not worth measuring.
The arithmetic is 2 cases onto whatever it sits on, and CI's clean containers
are the arbiter.

The allow-insecure-cookies branch added no unit FILE and 6 cases to
`packages/persistence/test/auth-cookies.test.ts`, from **154 / 1940 to
154 / 1946**. Integration moves with it (that file is a `.ts` integration runs
too) at **137 / 1756**, and **e2e stays 145** — no spec changed. It SHIPPED WITHOUT AN ENTRY
HERE, which is the gap this paragraph closes: the two entries below it record
the deployment work on either side of it and neither mentions the flag that
makes a deployment reachable by hostname work at all.

**THE FLOORS ABOVE ARE CI's, NOT THIS MACHINE'S, AND THAT IS WHAT MAKES THEM
MEASUREMENTS.** `vm_stat` here reported **3,609 free pages — about 56 MB** with
16,999 MB of 18,432 MB of swap gone, at a load average of 3.03. That is worse
than the 4,390 free pages the review20-one-primary entry already calls
untrustworthy, and the low load is not evidence to the contrary — this file
records that a machine waiting on swap looks idle. So no local suite was run.
The one FILE was (**23 passed** = the 17 release-readiness added plus this
branch's 6), and the totals came off the `build` job's own log:

```
  pnpm test:unit         Test Files 154 passed (154)   Tests 1946 passed (1946)
  pnpm test:integration  Test Files 137 passed (137)   Tests 1756 passed (1756)
  pnpm test:e2e          Running 145 tests using 2 workers
```

**AND THIS ENTRY FIRST RECORDED 1946 AS ARITHMETIC, WHICH WAS HONEST AND
WEAKER THAN IT NEEDED TO BE.** "A floor nobody measured has to say so" is the
rule, and the corollary nobody had written down is that **CI is somewhere to
measure it**: a green `build` prints all three totals from clean containers,
which is a better arbiter than this machine on its best day. When the machine
cannot be trusted, read the floors off the runner that can — the numbers are
already there, in a log that has been produced for every branch in this file.

**A DEPLOYMENT REACHED BY HOSTNAME FAILED SILENTLY, WHICH IS THE WORST SHAPE A
REFUSAL CAN TAKE.** `cookiesAreSecure` exempted loopback and nothing else, so
an instance at `http://perfportal.internal:3000` served its login page,
accepted correct credentials and answered **200** — and the browser then
discarded the `Secure` cookie it had been handed over plain HTTP, leaving
every later request signed out with nothing on screen saying why. No amount of
configuration fixed it, and a DNS name behaves exactly like an IP: the SCHEME
is what decides, so "it works if I use the hostname" was never available.

**AND IT WAS STRICTER THAN EVERY COMPARABLE PRODUCT, WHICH IS WHY THE
EXPECTATION WAS RIGHT AND THIS APP WAS THE OUTLIER.** Grafana, Jenkins, Nexus
and GitLab all serve a session over plain HTTP on an internal network. "It is
an HTTP app, I can reach it by hostname" is therefore correct everywhere a
deployer has been before — which is how it was reported here, from having used
the application — and the answer was to build the switch those products have
rather than to defend the restriction with the security argument that
justified it.

**OFF BY DEFAULT, AND READ WITH `=== 'true'` RATHER THAN TRUTHINESS.**
`allowInsecure` defaults to false so every existing caller behaves to the byte
as before, and `config.ts` compares the string exactly: under a truthiness
test `ALLOW_INSECURE_COOKIES=false` would switch it ON, which is the one value
an operator is most likely to write while meaning the opposite. The variable
is `PERFPORTAL_ALLOW_INSECURE_COOKIES` in `.env` and `ALLOW_INSECURE_COOKIES`
in the process — the compose file maps one to the other — and it is in
`.env.example` because `infra/test/env-example-covers-compose.mjs` fails the
`compose` job otherwise, which is the whole reason that guard exists.

**IT CANNOT DOWNGRADE TLS, AND THAT IS THE PROPERTY THAT MAKES IT SHIPPABLE AT
ALL.** `cookiesAreSecure` returns on `url.protocol === 'https:'` BEFORE the
flag is consulted, so an operator who turns it on for an internal host and
later puts the same compose file behind the `tls` profile does not silently go
on sending cookies in the clear. Two of the six cases pin exactly that, and
they are the pair worth having: the flag asserted OPT-IN (a default that
flipped would be INVISIBLE, because everything would simply keep working) and
the flag IGNORED over HTTPS.

**API TOKENS WERE NEVER AFFECTED, SO CI OVER PLAIN HTTP NEEDS NO FLAG.**
`Secure` is a property of a COOKIE; a bearer token is a header a client sends
wherever it is pointed. Worth writing in the deployment guide because the
natural reading of "sessions do not work over HTTP" is that ingest does not
either, and a deployer who believes that will go looking for a TLS termination
their pipeline never needed.

**`PERFPORTAL_HTTP_PORT` MOVES THE HOST SIDE ONLY, AND BOTH OF ITS TRAPS ARE
SILENT.** The container still listens on 3000, so nothing in the image and
nothing in `BETTER_AUTH_URL`'s default has to know the published port changed.
But `PERFPORTAL_PUBLIC_URL` must then be written WITHOUT `:80` — a browser
omits a default port from the `Origin` header, so `http://host:80` never
matches what arrives and sign-in is refused as an invalid origin, which is the
same failure the trusted-origin note in `.env.example` already warns about,
reached from a new direction. And it conflicts with the `tls` profile, whose
caddy publishes `80:80` and `443:443`: two containers cannot publish one host
port, and behind TLS the api needs no published port at all.

**AND THE FIRST LIVE CHECK REPORTED THE FEATURE BROKEN WHEN THE HARNESS HAD
DONE NOTHING.** The verification rewrote a scratch `fresh.env` with a
`re.sub` — and that file predated `PERFPORTAL_ALLOW_INSECURE_COOKIES`, so the
pattern matched nothing, the stack came up with the flag unset, the cookie came
back `Secure` exactly as before, and I briefly reported the feature broken on
that evidence. **The tell was a grep printing ONE line where TWO were
expected** — a count in a status line, which this file already records as the
tell for a mutation that missed its anchor, met here as a fixture that missed
its file. The fix is to stop reading the file you wrote and read the
CONTAINER's own `printenv`: what the process actually holds is the only thing
the claim was ever about.

The stronger-default-password branch added no unit FILE, no unit case and no
spec — unit stays **154 / 1940**, integration is unchanged and **e2e stays
145**. One CI step, in `test-residue`.

**THE DEFAULT IS `PerfPortal-Setup-2026` NOW, AND THE REASON IS NARROWER THAN
"STRONGER".** `perfportal` sat squarely in the class an undiscriminating sweep
tries against every host it finds — `admin`, `password`, `changeme`, and the
product's own name. This is not. **It buys nothing against anyone who knows
what they are looking at**: the value is published in four places, so it is
looked up rather than guessed, and entropy is irrelevant to that. Recorded in
the constant's own docstring so the next reader does not mistake length for
safety. The two things that actually help are unchanged — set
`PERFPORTAL_ADMIN_PASSWORD`, or change it after first sign-in, which sticks
because bootstrap never re-passwords an account that exists.

**FOUR COPIES OF ONE STRING, SO IT GETS A GUARD.** It appears in
`bootstrap.ts`, `DEPLOYMENT.md`, the README and `.env.example`. This file
already records two documents that named something the product had renamed —
the `Cnt/s` hint for a deleted label, "Mint one under Access" for a renamed
page — and a deployment guide is the worst place for it: the reader tries the
password, it fails, and they cannot tell whether the deployment broke or the
document lied. The CI step reads the constant out of the SOURCE and requires
all three documents to carry it, **extracting non-empty first** so a regex
that stopped matching cannot make `grep -qF ""` succeed against everything.
Red-verified both ways.

**AND `git checkout --` DESTROYED THE FIX. FIFTH TIME IN THIS FILE, AND THE
FIRST WHERE THE LESSON WAS FRESH IN THE SAME SESSION.** The red-verify
mutated `bootstrap.ts` — the file being fixed — and restoring it from HEAD
took the new constant and its docstring with it. The entries below record
this four times and prescribe the guard: **one `git commit -q` before the
first mutation.** I had read those entries hours earlier, written about them,
and still skipped it.

The tell was not a failure. It was the ACCIDENTAL PASS: after the revert the
code said `perfportal` and the documents said `PerfPortal-Setup-2026`, which
is exactly the drift the new guard exists to detect — so the guard was
briefly right about a mistake I had just made to myself. **Writing the lesson
down is not the same as having it**, which the entry below already says; what
is new is that reading it in the same session is not either. The mechanical
guard is the only part that works.

The turnkey-deployment branch added no unit FILE, no unit case and no spec —
unit stays **154 / 1940**, integration is unchanged and **e2e stays 145**. It
is guarded by TWO new steps in CI's `test-residue` job, which no `pnpm` gate
runs.

**A FRESH DEPLOYMENT STILL HAD NOBODY WHO COULD SIGN IN.** The
onprem-deploy-gaps entry below found that and fixed the DOCUMENTATION —
`docker compose run --rm migrate pnpm bootstrap …`. That is still a command
the deployer has to know to run, and the first thing anybody saw after a
successful `up` was a login page that refused every address. There is a
`bootstrap` SERVICE now: it runs after `migrate`, `api` waits on IT rather
than on migrate, and the first page a browser is served already has an
account behind it.

**THE DEFAULT PASSWORD IS A KNOWN VULNERABILITY CLASS AND IS SHIPPED
ANYWAY.** Scanners try published defaults within hours of a host appearing.
It exists because the alternative was measurably worse — a healthy platform
nobody could log in to — and it is the trade ReportPortal, Grafana and GitLab
all make. What makes it defensible is the scoping, and all three parts are
load-bearing:

```
  only when PERFPORTAL_ADMIN_PASSWORD is unset   an operator who sets one is never exposed
  only SEEDED, never re-applied                  changing it in the UI survives every later `up`
  warns on every bootstrap that uses it          naming the variable that removes it
```

**AND THE IDEMPOTENCY FIX WAS NOT IDEMPOTENT, WHICH RUNNING IT TWICE FOUND.**
The service re-runs on every `up`, so bootstrap had to stop throwing on a
duplicate email — it reuses the account instead. The first version then
called `OrgMemberRepository.add` unconditionally to re-attach that account to
the org, and `add` is a plain `create` against a table unique on
`(user_id, org_id)`: the SECOND run died with `Unique constraint failed`. A
deployer restarting their stack would have got a failed deployment.

Nothing about reading the code would have shown it. **Run the thing twice —
it is the one check a human stops doing the moment it works once**, and it is
exactly what the compose service does forever.

**THE CHECK THAT THE PASSWORD SURVIVES WAS VACUOUS AT FIRST, AND SAID SO
PASSED.** The hand-run fingerprint compared `md5(account.password)` joined on
`a.user_id` — the column is `"userId"`, camelCase and quoted, so both sides
were empty strings and the comparison reported UNCHANGED against nothing.
Better Auth's tables are not snake_cased the way this repo's own are. The CI
step asserts the fingerprint is **non-empty before comparing it**, which is
the same guard `fk-free-tables.sql` already applies to its own query.

**TWO STEPS, AND THE SECOND IS THE ONE THAT KEEPS THE FIRST HONEST.** One
runs bootstrap twice and requires exit 0, the reuse message, an unchanged
credential and exactly one membership. The other sets
`PERFPORTAL_ADMIN_PASSWORD` and requires that it is used AND that no default
warning is printed — because a warning about a default nobody seeded trains
the reader to ignore it, which is the overstated-warning lesson M08 already
records for the empty-threshold help.

**AND THE "TARGETED BUILD" WAS A CLAIM ABOUT MY MACHINE, WHICH CI KILLED.**
That job has never built anything — it installs and migrates, because
everything it ran until now (`orphans-fixture.mjs`, `buckets-fixture.mjs`)
talks to `pg` and the S3 SDK directly. `bootstrap` is
`node dist/scripts/bootstrap.js`, so it needs one, and the first version used
`npx tsc -b packages/persistence` on the reasoning that it would build
persistence plus its references in seconds rather than adding minutes.

It succeeded locally and **failed twelve ways on a clean runner**:
`Cannot find module '@perfportal/core'` and `'@perfportal/statistics'`,
because workspace packages resolve through node_modules symlinks to a `dist`
that only a full build produces and persistence's tsconfig does not reference
them as projects; and `has no exported member 'PrismaClient'`, because
nothing had run `prisma generate`. It worked here only because the tree was
already built from earlier work.

**A CROSS-PACKAGE SUCCESS ON A DIRTY TREE PROVES NOTHING ABOUT A CLEAN ONE.**
This file already records the other direction — "a red integration result
that crosses a package boundary is a build claim before it is a code claim",
from the branch where `packages/contracts/dist` had been built on a different
branch. The inverse is the same fact and is easier to miss, because green
looks like evidence. It is `prisma generate` plus `pnpm build` now.

**AND THE GUIDE IS ITS OWN FILE, LINKED FROM THE README RATHER THAN BURIED IN
IT.** `DEPLOYMENT.md` is the quick start, the first sign-in, the configuration
reference, the pre-exposure checklist, upgrades, backup and the failure modes
this file has accumulated — the runner's correct `Exited (1)` on a first boot,
`Invalid origin`, the `Secure` cookie over plain HTTP, and `df -i` rather than
`df -h`. README's "Deploying it" keeps its three non-optional things as the
WHY and opens with the link.

The rules-enabled-column branch added no unit FILE and 1 case to
`apps/web/test/ProjectRules.test.tsx`, from **154 / 1939** to **154 / 1940**.
Integration is UNCHANGED (that file is a `.tsx`) and **e2e stays 145** — no
spec changed.

**A TABLE HAD BORROWED THE RUN VOCABULARY, AND N01 HAD ALREADY FORBIDDEN IT.**
That branch reserved `Status` for a RUN's execution state — the run list gives
it a column (Project, Simulation, Status, Verdict) and the status filter its
vocabulary — and renamed the simulation assertions table's `Status` to
`Outcome` on exactly that ground ("a check has a result, not a state"). The
SLA rules table was the caller that rename did not reach: its last column was
headed `Status` over cells reading `Enabled`/`Disabled`, **a header one
abstraction level off its own data**.

A rule has neither a state nor a result — it is in force or it is not, which
is the contract's own `enabled` field. So the column is named after the field
it renders, which is also how `review.md`'s rule-management wireframe heads
it. Found by auditing that wireframes section, which is the one part of
`review.md` the earlier sweeps never enumerated.

**THE CELLS KEEP `Enabled`/`Disabled` RATHER THAN THE WIREFRAME'S `Yes`.**
Mildly redundant under this header and worth it: "Disabled" states what is
true of a rule that judges nothing, where "No" leaves the reader to infer it —
and this file's own case asserts that a disabled rule SAYS so, which is a
claim about that word rather than about the column.

**THE EXCLUSIVE PAIR IS WHAT THE SECOND MUTATION EARNS.** Reverting the header
fails both halves; ADDING an `Enabled` column while keeping `Status` beside it
fails only the absence — and that second shape is the drift rather than the
fix, so a positive-only assertion would wave it through. Same shape the
token-mint-copy branch used for its own retired jargon, and kept as ONE case
because these are two halves of one exclusivity claim about one column, not
two claims.

**AND THE e2e SELECTORS WERE READ THIS TIME, WHICH IS THE LESSON FROM THE
BRANCH BELOW.** That one failed CI because a geometry bound was anchored on a
tile the change moved, and the reasoning had checked a different tile. So
before concluding no spec could reach this rename: no spec selects a
`columnheader` named `Status` or `Enabled` anywhere, and
`run-list.spec.ts:186` — which scans **every** columnheader on the page
UNSCOPED to find the Status column's index — runs on `/runs`, which does not
render the rules table.

**THAT UNSCOPED SCAN IS WORTH KNOWING ABOUT, BECAUSE THIS RENAME MAKES IT
SAFER RATHER THAN RISKIER.** `TestRuns` renders `ProjectRules` and `RunList` as
SIBLINGS, so on a test's page that query would have seen TWO `Status` headers
and `findIndex` would have taken whichever came first — silently picking a
rules column and then reading a run row's cell at that index. One `Status`
header exists in the product now. Left as it is rather than scoped: it is
correct where it runs, and narrowing it is a change to a passing test in a
file this branch otherwise does not touch.

**AND `git commit -m "… \`enabled\` …"` RAN THE BACKTICKS AS A COMMAND.** The
message went in reading "the contract's own  field" — `enabled` eaten by
command substitution inside a double-quoted shell string, with
`bash: enabled: command not found` printed among the test output where it was
easy to miss. This file already records "A SQL COMMENT CANNOT CONTAIN A
BACKTICK" for a template literal; a shell double-quoted string is the same
trap, and these commit messages are full of backticked identifiers. **Use
`git commit -F -` with a quoted heredoc** (`<<'MSG'`), which interprets
nothing — amended here, and it is what every long message in this session
should have used.

The target-layout-tile-order branch added no unit FILE and 2 cases to
`apps/web/test/RunStats.test.tsx`. Cut from **153 / 1932**, it measured
153 / 1934 on its own; compare-matrix-units merged FIRST and took `main` to
154 / 1937, so after merging `main` back in this branch measures
**154 / 1939**. Integration is UNCHANGED (that file is a `.tsx`) and **e2e
stays 145**. Third floor reconciliation in this run of branches — the
arithmetic (2 cases onto whatever it sits on) is what survives.

**THE 09-13 REVIEW HAS A SECTION NOBODY HAD AUDITED, AND IT IS NOT THE ONE THE
RE-AUDIT CLOSED.** That entry further down records the copy table (11 of 12
rows) and the acceptance list (14 items) and says the document is closed. It
never enumerated `## Target layout for a performance engineer`, which sits
between them — six numbered items specifying the run overview top to bottom,
plus a line per other page. **Five of the six check out. Item 3 did not.**

**THE TRIAGE NUMBER SAT FOURTH.** The finding: "p95 response time, error rate,
throughput, total requests; p99 and mean can follow at lower emphasis." The
row read **Requests, Error rate, Requests/s, Mean, p95, p99** — so a reader
arriving to ask whether the latency was acceptable met a count and a mean
first.

**NOTHING ARGUED THE ORDER AND NOTHING PINNED IT, WHICH IS THE SAME FACT
TWICE.** `RunStats.tsx` argues every other layout decision in a comment —
the six-across threshold, the container query, the three short labels — and
had no comment about sequence at all: it was the order the tiles happened to
be written in. And no assertion could see it. Every unit case and every spec
reaches these by `data-testid`, and `run-tables.spec.ts`'s M01 bound checks
that three of them sit inside the first 900px — **a claim about POSITION,
satisfied by any sequence.** The new case asserts the whole list with
`toEqual`, the shape `run-charts.spec.ts` already uses for `CHART_IDS` so a
reorder cannot pass silently.

**WHAT IT COSTS IS STATED RATHER THAN GLOSSED.** Mean/p95/p99 used to sit
adjacent in ascending order, which is a real and coherent grouping, and
promoting p95 breaks it. The review's reading wins because a reader arrives
asking whether the latency is acceptable, not to be walked up the
distribution — and the three still share one vocabulary with
`StatisticsTable`'s columns, which is what N01 was about.

**AND THE EMPHASIS ARM IS DECLINED, WITH THE COMPONENT'S OWN REASONS.** The
finding says p99 and mean "CAN follow at lower emphasis" — permission, not
requirement — and in `StatTile` both spellings of emphasis are already spoken
for. **Colour is reserved for SLA `tone`**, which that file's docstring argues
at length ("colouring a number red is a JUDGEMENT, and the platform has only
made one where a rule exists"), so a muted value would either collide with
that vocabulary or invent a second one. **Size is worse**: `mt-auto` on the
hint exists specifically to keep six values on a common baseline, and the grid
comment above it records that defect being fixed twice. Position is the
emphasis this grid has.

**AND THE "NO e2e CHANGE" CLAIM WAS WRONG — CI CAUGHT IT.** This entry first
read: "at 1440 the grid is `@5xl:grid-cols-6`, so all six tiles share ONE row
and their sequence changes no vertical position; on a phone the two-column
grid moves p95 from the third row to the FIRST, i.e. UP, so every
`toBeLessThan` bound in `mobile.spec.ts` passes more easily." Both halves of
that are true and the conclusion does not follow. `mobile.spec.ts`'s M02 bound
is anchored on **`stat-total-requests`**, and this reorder moves Requests from
first to FOURTH — which in a two-column grid is the second ROW, past a bound
with ten pixels of headroom. **I checked the tile I had promoted and not the
tile the assertion names.** `build` failed on it; the four other jobs passed.

**THE FIX IS TO DERIVE THE ANCHOR, NOT TO MOVE THE BOUND.** 812 is the
viewport and M02 took three branches to earn it, so raising it would undo that
work to accommodate a reorder that made nothing worse: the section's top and
its first row are exactly where they were. The assertion's own comment says it
is about where the numbers START, and it named one tile as a proxy for "the
first one" — so it asks the DOM instead (`section[aria-label="Run totals"]
dd[data-testid^="stat-"]`, `.first()`), which is `run-list.spec.ts`'s `.nth(3)`
lesson one file over. `dd[...]` rather than the bare prefix because the
empty-window branch names its own section `stats-empty-window`, which
`^="stat-"` also matches.

**THE GENERAL SHAPE: A GEOMETRY BOUND IS ANCHORED ON AN ELEMENT, AND THE
ELEMENT IS NOT THE CLAIM.** Before concluding a layout change cannot reach a
geometry assertion, read what that assertion SELECTS — not what the change
moved.

**A SECOND GUARD FOR THE HALF jsdom CANNOT SEE.** DOM order is the reading
order only while these are grid items in source order; an `order-*` utility
would move a tile visually with the markup untouched, satisfying the list
assertion while misleading every sighted reader. That case scans the source
with comments STRIPPED — the trap this file already records twice, where a
source-scanning assertion matched the paragraph documenting the defect.

**AND TWO PROCESS SLIPS, BOTH CAUGHT BY GUARDS RATHER THAN BY CARE.** The
first red-verify mutation was malformed — a perl substitution injected
`order-last` as a bare token before `label="p95"`, which is a syntax error and
not a mutation of anything — and was spotted by checking the replacement
before running the suite, not by reading the result. Then an `Edit` anchor was
built from `sed 's/^/  /'` output and failed to match on the two added spaces:
**the display-filter trap, for the third time in this session**, and the good
failure mode — the edit refused rather than corrupting the file. Read the
target with the Read tool, never from anything that has been through a
formatter.

The compare-matrix-units branch added ONE unit file —
`apps/web/test/CompareMatrix.test.tsx` (5) — from **153 / 1932** to
**154 / 1937**. Integration is UNCHANGED (that file is a `.tsx`, which that
config never runs) and **e2e stays 145**. It closes `review.md`'s copy row 7,
which the entry below recorded as measured-and-open — and with it **that
document's copy table is fully worked.**

**BOTH CLAUSES WERE ONE MISTAKE MADE TWICE.** "Put unit in the table header;
missing-data definition in help" — and the only statement of the UNIT and the
only definition of the DASH both lived in one caption paragraph above the
numbers, met on every visit by a reader who needed either of them once.

**THE UNIT RIDES WITH THE COLUMN, AND THE REASON IS THE READER THIS TABLE IS
HARDEST ON.** A cell's announced context IS its own column header, so
`09-13 11:31 (ms)` gives a screen-reader user the unit with every value
instead of asking them to carry a sentence from above the table. That is why
it is repeated per run rather than stated once somewhere tidier: any single
placement is a sentence again.

**AND `compareUnit` ALREADY OWNED THE DECISION.** Its docstring says "for the
axis and the tooltip"; this table draws the same numbers as both and was the
caller that never reached for it. The mildest form of the one-caller-short
shape this file keeps recording — nothing was wrong, one consumer just had
its own answer, which here was no answer at all.

**AND IT TOOK C06's SECOND HALF, WHICH `StatisticsTable` COULD NOT.** The
table's accessible NAME was the whole paragraph, so a screen reader announced
the dash definition before the first number, every visit — exactly what C06
objects to. `TableFrame`'s docstring records that fixing it for the statistics
table "changes what `getByRole('table', { name })` matches in six specs, so it
is a separate change". Nothing finds THIS table by name — checked against
`apps/web/test` and `apps/web/e2e` before changing it — so the short name went
in beside the disclosure. **Whether a deferral applies is a property of the
call site, not of the finding**: the same fix was cheap one table over.

**THE COMPONENT HAD NO TEST FILE AT ALL.** `buildCompareMatrix.test.ts` covers
the transform, which is pure and well pinned; nothing ever RENDERED the table,
so neither half of row 7 could have been noticed by the suite. Third time this
file records it: grep for components with no test file before looking for
untested behaviour.

**FOUR MUTATIONS, AND THE SECOND CASE IS THE ONE THAT EARNS ITS PLACE:**

```
  unit dropped from the headers     both unit cases fail
  unit HARD-CODED to `(ms)`         only the metric-derived case fails
  prose restored as the name        the accessible-name case fails
  definition deleted, not moved     only the available-in-help case fails
```

A header pinned to `ms` satisfies "carries the unit" perfectly and mislabels
every throughput and error-rate comparison in the product — the same class of
defect review.md 1 found in the SLA actuals, one table over.

**AND A BUNDLED CASE WAS SPLIT AFTER THE RED-VERIFY SHOWED WHY.** The name and
the availability were asserted in one case, and mutations three and four both
failed it on different assertions under one test name — coverage right, report
wrong. review9 earned that lesson and this is its second outing. Apart, each
mutation fails the case that describes it.

**ONE COUPLING IS RECORDED RATHER THAN ENGINEERED AWAY.** Mutation three still
trips the availability case as well, because making the prose the name puts
that text on screen TWICE and `getByText` is singular. That is the trap this
file already documents, and it is left: the duplication really is a defect —
`TableFrame` `aria-hidden`s its visible copy precisely so the words are not
announced twice — so a case that fails on it is failing honestly.

The review-copy-rows branch added no unit FILE and 7 cases — 6 to
`packages/contracts/test/rules.test.ts` and 1 to
`apps/web/test/RunDecisionBand.test.tsx` — from a MEASURED floor of
**153 / 1925** to **153 / 1932**. Integration moves with it (that
`rules.test.ts` is a `.ts` file integration runs too) and **e2e stays 145**.

**AND THE RECORDED FLOOR WAS STALE BY ONE, WHICH IS THE ONLY REASON THAT IS
WRITTEN DOWN.** Two entries above say "unit stays 153 / 1924". The
review20-one-primary entry says it added 1 case FROM a floor of 1924 — so it
finished at 1925 — and the 09-13 re-audit entry, written afterwards, restated
1924. Counted exactly (`git show origin/main:<file> | grep -c`), this branch
adds 6 + 1 + 0 and no `it.each`, so 1925 + 7 = 1932 is the measured run and
the arithmetic closes. **A floor one ABOVE prediction is as much a
discrepancy as one below**, and chasing it is what found the drift.

**review.md's TWENTY-TWO FINDINGS ARE CLOSED AND ITS COPY TABLE WAS NOT.**
This is the 09-13 re-audit's lesson repeating exactly: the numbered findings
had all been worked, and the document has FIVE sections after them. The
`## Copy guidance` table holds eight rows, of which six are genuinely done
(two survive only in past-tense comments), **one was open and is this
branch**, and one was satisfied by something other than what it proposed.

**ROW 1 WAS THE PRODUCT READING ITS OWN SCHEMA ALOUD, IN THE LARGEST TEXT ON
THE PAGE.** `packages/sla`'s `describe` writes every assertion's message at
evaluation time as `${metric} of ${target} (${family}) ≤ ${threshold} —
actual ${raw}`, and the copy table names that exact string as the pattern to
replace. Three surfaces rendered it:

```
  RunDecisionBand  failed.message          the page's largest sentence   FIXED
  RunDetail        assertion.message       the gates table's LAST column FIXED
  SlaBanner        rule.description        the live banner               left
```

The gates table is the one worth seeing: review.md 1, 3 and 15 corrected its
first three cells to `Whole-run error rate` / `≤ 1%` / `2.23%`, and the
fourth column sat beside them printing `error_rate of the run (response_time)
≤ 0.01 — actual 0.0223463687150838`. One row, one fact, two vocabularies.

**AND THE RECORD WAS WRONG ABOUT WHY THIS WAS DEFERRED.** The
rule-language-human entry files this surface under "a data change with a
migration question attached". That is true of the LIVE banner and only of it
— `LiveSlaRuleSchema` carries `description: z.string()` and no structured
fields, so re-rendering it changes what the worker streams and what every
delta already recorded says. The BATCH path was never that:
`AssertionSchema` has always carried scope, targetName, family, metric,
comparator, threshold and actualValue BESIDE the message, so every assertion
already stored renders correctly from fields that were always on the wire.
**Check whether a deferral's reason covers every surface it was applied to**
— one sentence in a note kept two renderable surfaces closed for four
branches.

**THE COMPARATOR PICKS THE NOUN, NOT JUST THE VERB.** A breached `lte` is
over a LIMIT and a breached `gte` is under a MINIMUM, and calling both a
limit would misdescribe every throughput and count rule in the product. The
case that pins it asserts the absence of "limit" beside the presence of the
sentence.

**PRECISION FOLLOWS THE COLUMN BESIDE IT, NOT THE REVIEW'S EXAMPLE.**
`fractionToPercent` rounds to 4dp, so the sentence reads `2.2346%` where the
copy table illustrates `2.23%`. Agreeing with the Actual cell one column over
— the same `formatSlaValue` — beats matching an example that elides its own
digits with an ellipsis. Recorded as a deviation with its reason, which is
the discipline the N01 tiles entry set.

**A CASE THAT CANNOT REACH ITS BRANCH IS NOT A KEEPER, AND THIS FILE NOW
RECORDS IT THREE TIMES.** A second band case was written to pin the
`?? failed.message` fallback, seeding a lone `not_applicable` assertion. The
band reads only the FAILED assertion, so with none present it fell through to
`decisionDetail` and the case failed reporting "One or more SLA rules
failed…". The fallback is unreachable there by construction —
`AssertionSchema` documents `actualValue` as null for `not_applicable` alone
— so the case was deleted and the reason written where it was. The null
answer is pinned at the contracts level instead.

**AND `decision-detail` APPEARED IN NO ASSERTION IN ITS OWN TEST FILE**,
which is how the band's wording survived three corrections to the table
underneath it. `RunDetail.live.test.tsx` DID pin the gates column — verbatim,
to the retired string — so it went red and was re-pointed at the claim rather
than the words, the benign form of the verbatim-prose trap this file records
for the M18 caveat.

**ROW 7 IS OPEN AND MEASURED, NOT MISSED.** "Every request… a dash means…" →
"Put unit in the table header; missing-data definition in help". Both clauses
still fail in `tables/CompareMatrix.tsx`: the caption reads `{metricLabel}
for every request, in each selected run. A dash means the request did not run
in that one — not that it took no time.`, so the UNIT lives only in prose
while the column headers carry bare run labels, and the dash definition sits
in the caption — which `TableFrame` also renders as the table's accessible
NAME, so a screen-reader user meets it unavoidably. Left because putting a
shared unit into per-run headers is a layout decision (repeat it per column,
or hoist it) rather than a correction, and it wants its own branch.

**ROW 8 IS SATISFIED BY SOMETHING OTHER THAN WHAT IT PROPOSED, DELIBERATELY.**
The table asks for `Vs previous` → `Vs [identified baseline]`, i.e. the tile
LABEL naming the run. Finding 4's own prose asks instead to "identify the
actual baseline near the metric comparison, link to it, and surface material
environment/build differences next to deltas" — which is exactly what
`BaselineNote` does. And the label could not carry it: the N01 tiles entry
measured `Mean response time` already wrapping in a 147px tile at 1280, so a
timestamp there would break the baseline the grid's own comment records
fixing twice. **The finding's prose outranks the table's shorthand**, the
same way the 09-13 row 6 was answered by checking what the proposed
replacement would PRODUCE.

The orphan-sweep-force branch added no unit FILE, no unit case and no spec —
its diff is one `infra/` script, its fixture and three CI steps — so unit
stays **153 / 1924**, integration is unchanged and e2e stays **145**. It is
guarded by CI's `test-residue` job, which no `pnpm` gate runs.

**A CLEANUP SCRIPT REFUSED TO CLEAN THE ONE DATABASE THAT MOST NEEDED IT, FOR
EVER.** `clean-orphaned-objects.mjs` declines `--delete` when the run table is
empty — right, and the entry further down argues why. What nobody had noticed
is that **the refusal is not time-based**: a dev database emptied on purpose
never acquires a run, so the sweep never becomes available. Measured after a
deliberate residue sweep this session: **80,247 objects / 63.2 MB**, every one
genuinely orphaned, permanently unreachable by the tool written to remove it.

**`--force` LIFTS ONE CHECK, AND THE AGE GUARD IS DELIBERATELY NOT IT.** The
two guards answer different questions, and only one of them is answerable from
outside the process:

```
  age guard        might this object belong to a run that has not
                   recorded its row yet?                        NOT overridable
  empty-table      did this keep-list come from the database
                   I meant?                                     the operator knows
```

So a `--force` that also skipped the age guard would delete an in-flight run's
chunks on a live instance, and being sure of your `DATABASE_URL` does nothing
to make that safe. **The step that pins the separation is the one worth
keeping** — without it, a later tidy-up collapsing the two flags passes every
other assertion.

**AND BOTH MESSAGES NAME THE DATABASE NOW, HOST AND PATH ONLY.** The refusal
exists BECAUSE `DATABASE_URL` is the likely culprit, so `(currently set)` was
the least useful thing it could report — and `--force` moves that from
something the script catches to something the operator has to be right about.
`${u.username}:${u.password}@` must never reach a CI log, so it is
`${u.host}${u.pathname}` and a `try`/`catch` for an unparseable URL.

**FOUR MUTATIONS, FOUR DISTINCT FAILURES**, the property this file keeps asking
for:

```
  --force parsed but never consulted   assert-forced : the bundle survived
  --force lifts the age guard          assert-guard  : deleted inside the guard
  --force stops honouring bundle_key   assert        : a live bundle went too
  the refusal removed entirely         the existing refusal step
```

The pair is bidirectional the way `buckets-fixture.mjs` is — with `--force` all
four objects go, without it none do — so this half needs no
deliberately-broken script.

**A RED-VERIFY THAT PASSES MEANS YOUR MUTATION DID NOT DO WHAT YOU THOUGHT.**
The first attempt at the age-guard mutation set `cutoff` to `new Date(0)`,
reasoning that an epoch cutoff disables the guard. It does the opposite: the
test is `LastModified > cutoff`, so an epoch cutoff makes EVERYTHING "too new"
and nothing is ever deleted. The step passed, and for a moment that read as
"the guard survives the mutation" rather than "the mutation tightened the
guard". The tell was in the output — `too new 4` where the mutation was
supposed to produce `too new 0`. **This file already records reading WHICH
assertion failed; the mirror is reading which NUMBER moved when nothing
failed.** `new Date(Date.now() + 86_400_000)` is the mutation that lifts it.

**AND THE VERIFICATION RAN AGAINST A SCRATCH BUCKET, WHICH IS WHY THE REAL
RESIDUE IS STILL THERE.** Both the script and the fixture honour `S3_BUCKET`,
so the whole local replay of the CI steps ran in `pp-force-verify` and
`perfportal` stayed at its 80,247 objects throughout. **Testing the flag and
using the flag are two different jobs**, and conflating them would have swept
63 MB as a side effect of a test run rather than as a decision.

**WHAT WAS AND WAS NOT RUN, BECAUSE `infra/` IS IN NO `pnpm` GATE.**
`typecheck` and `lint` are green by their own exit codes; `test:unit`,
`test:integration` and `test:e2e` cannot see any file in this diff and are not
claimed. The machine was also at **16,392 MB of 17,408 MB swap with ~5,076 free
pages**, which is worse than the 8,973-page case this file records producing
eight spurious failures — so a suite run would have been unreadable either way.
CI's `test-residue` job is the arbiter, and its four steps were replayed
locally step-for-step first.

THE 09-13 REVIEW WAS RE-AUDITED END TO END AND IS CLOSED. No code, no floor
movement — unit stays **153 / 1924**, integration is unchanged and e2e stays
**145**. This entry exists for the reason the M12 one does: "nothing to do" and
"nobody checked" look identical in a review ledger a month later, and this
session found real work behind three verdicts nobody had re-derived.

**ITS FINDINGS WERE ALREADY RECORDED CLOSED. WHAT NOBODY HAD RE-CHECKED WERE
THE TWO SECTIONS AFTER THEM** — the "Copy changes to make immediately" table
and the acceptance list in the final paragraph.

**THE COPY TABLE: 11 OF 12 ROWS FULLY DONE, AND THE TWO THAT LOOK OPEN ARE
COMMENTS.** Grepping the retired strings finds `No runner seen yet` and `No
telemetry was recorded` still in the tree — both inside PAST-TENSE comments
explaining what they replaced. That is the shape the review-copy-batch entry
warns about, met from the other direction: **a grep that finds the old string
is not evidence the defect survived, and a grep that misses it is not evidence
the replacement arrived.** Only reading decides, both ways.

**ROW 6 IS DELIBERATELY NOT "FIXED", AND THE REASON IS THE REVIEW'S OWN.** It
proposes replacing "Every build posts its own report, so the trend line keeps
itself up to date" with `Send reports from your CI pipeline.` The card reads
"Send reports from your CI pipeline, so the trend line keeps itself up to
date." — the proposal ADOPTED, with the trailing clause kept. Taking it
literally would leave a card TITLED `Configure CI` whose description says
"Send reports from your CI pipeline", which is a description restating its
title — the thing this same document objects to two sections down ("remove …
repeated titles where the content already establishes context"). The tail is
the only part carrying information the title does not. **A prescribed
replacement is a claim like any other; check what it would PRODUCE before
applying it** — the N04 lesson from the other side.

**THE ACCEPTANCE LIST IS GENUINELY COVERED, AND THE TWO LEAST LIKELY ITEMS WERE
READ RATHER THAN GREPPED.** Fourteen items, every one with a spec — and a
keyword match is not coverage, so the two that looked weakest were opened:

```
  invalid uploads    project-tests.spec.ts sets a .zip and an EMPTY .tgz through
                     the real picker and asserts each refusal by its own wording,
                     over uploadBundle.test.ts's 13 cases
  permission-denied  run-detail.spec.ts opens another org's run and asserts the
                     API's OWN 404 detail, id included; auth.spec.ts covers a
                     signed-in user who belongs to no org
```

Both are real, and so are the rest: pagination at the `PAGE_SIZE + 1` boundary,
live regions asserted across four specs, 200% zoom at four pages, three
engines, six viewports.

**NOTHING CHANGED, WHICH IS THE RESULT.** The alternative — trusting "all
findings closed" — is what left `review.md` unworked for 116 commits while
sitting untracked in the repo root, and what left that document's own copy
table reading as done while five of its rows were open, because every retired
phrase had a comment quoting it.

The review20-one-primary branch added no unit FILE and 1 case to
`apps/web/test/ProjectRules.test.tsx`, from a floor of **153 / 1924**.
Integration is UNCHANGED and **e2e stays 145** — no spec changed. It takes the
two clauses of `review.md` 20 the heading-ladder branch measured and left, and
**one of them needed no code at all.**

**"FEWER NESTED PANELS" IS ALREADY TRUE — MEASURED, NOT ASSUMED.** Twelve card
surfaces exist, one per component, and the nesting candidates were checked
individually rather than inferred from the count: `LiveNotice` renders as a
SIBLING of `LiveStatusStrip`'s card, not inside it; `TableFrame` draws no
surface at all; `payload.tsx` has no card. The finding was true of its baseline
116 commits ago and the intervening work removed the nesting — review9's
deletion of the evidence panel among it. **A count of card CLASSES is not a
count of nested PANELS**, and the first was what the earlier measurement
reported.

**"ONE PRIMARY ACTION PER TASK" WAS REAL, AND THE CODE HAD ALREADY WRITTEN THE
RULE DOWN.** `Button.tsx`'s docstring states "exactly ONE `primary` per screen"
and then explains why there is no `danger` variant: "nothing in this app
destroys anything yet". **That premise expired.** A token can be revoked, a rule
deleted, a test removed — and all THREE confirms reached for `primary`, so
arming any confirmation made the destructive button the most prominent control
on screen, breaking the rule stated two paragraphs above it.

**THE DAY THAT COMMENT ANTICIPATED ARRIVED, AND THE ANSWER WAS THE CHEAPER
HALF.** It says a `danger` variant is "worth adding on the day something needs
it, with the token question answered then" — and the fix turned out to be to
STOP REACHING FOR `primary` rather than to add one. A destructive confirm lives
inside a block the reader armed deliberately, under a sentence saying what it
does, beside a Cancel; it does not need the weight that says "this is what the
page is for". The token argument against a red variant stands untouched.

**AND IT WAS ENFORCED BY NOTHING: THERE IS NO `Button.test.tsx`.** A rule in a
docstring is a rule three callers can break without a single test going red.
The new case asserts one primary WHILE A DELETE IS ARMED — the only state where
the second one exists, so a count taken before the confirmation opens proves
nothing — and reads `.bg-accent`, the variant's own definition, because a
`variant` prop cannot be read off the DOM.

**A FULL UNIT RUN ON THIS BRANCH IS NOT TRUSTWORTHY AND IS NOT CLAIMED.** It
reported **141 files / 1659 tests** — twelve files and 265 tests BELOW the
floor — with three package tests at ~1,013,000ms each, on a machine at
**726 MB of 17,408 MB swap free and 4,390 free pages**. That is worse than the
thrashing this file already documents at 8,973 pages. `typecheck` and `lint`
are deterministic and stayed green; the three files this branch can actually
reach pass 104/104 on their own; CI's clean containers are the arbiter for the
rest. **A run below the floor is not a failure and not a pass — it is a
measurement of the wrong tree**, which is the whole reason those two numbers
are written down.

The review22-one-word-per-thing branch added no unit FILE and no unit case —
unit stays **153 / 1924** — and its **e2e rises to 145**. Integration is
UNCHANGED. `review.md`'s finding 22.

**RE-MEASURED AFTER review13 LANDED**, which took the unit floor 1922 to 1924
underneath this branch. The two did not collide — this one adds a SPEC and no
unit case — so only the number it quotes moved, not the arithmetic.

**ONE SCREEN CALLED ONE THING TWO NAMES, EIGHT HUNDRED PIXELS APART.**
`RunDecisionBand`'s row read `Simulation checks` and its link `See the failed
simulation check`, while the anchor that link targets —
`#simulation-assertions` — is headed **Simulation assertions**. A reader
followed a link about a CHECK and landed on a section about ASSERTIONS.

**N01 SETTLED THE WORD AND THIS WAS THE CALLER IT DID NOT REACH.** That branch
renamed the SECTION and every spec asserting the Overview's heading outline;
the band's own wording is pinned only by `RunDecisionBand.test.tsx`, a file that
never renders the section and therefore cannot see the two disagree. Fifth time
this file records the one-call-site-short shape.

**AND THE FINDING'S OWN SUGGESTION IS DECLINED, WITH THE EVIDENCE.** review.md
22 asks for "Simulation check" as the standard term. N01 examined that exact
rename and found the PRD pointing the other way — G-05 gives "Assertions table
— expression, expected, actual, status" to the TOOL's own feature, so Gatling's
assertions really are assertions, and it was the PLATFORM's rules that had
borrowed the word. Those are `Platform gates` one row up. **When two reviews
disagree, follow the one with the evidence and say so** — the M09 precedent,
met again from the other direction.

**NOTHING WATCHED THE SEAM, WHICH IS HOW IT DRIFTED.** No spec anywhere
followed that link: `grep` for `simulation-assertions` across `apps/web/e2e`
returned nothing. Unit tests pin the band's words and other unit tests pin the
section's heading, and neither layer can see that the two describe one journey.
The new e2e clicks the link and asserts the heading it LANDS ON shares the
band's noun — **read off the control rather than written down**, so the case
survives the vocabulary changing again provided both ends change together.

**RED-VERIFIED BY PUTTING THE OLD WORD BACK**, which fails on
`toBeVisible()` for a heading named "check" that does not exist. That is the
drift that actually happened, caught by the one case that can see it.

**AND `{/* … */}` IS NOT VALID BETWEEN JSX ATTRIBUTES.** The reasoning above was
first written as a JSX child comment in the attribute list and the file stopped
parsing — `Transform failed … \`...\` expected`, reported by vitest as
`Tests no tests` rather than as a syntax error in the component. A plain
`/* … */` IS valid there, and this file already used one twelve lines down.
**When a suite reports no tests, read the transform error before the test.**
The review13-rule-form-groups branch added no unit FILE and 2 cases to
`apps/web/test/ProjectRules.test.tsx`, from **153 / 1922 to 153 / 1924**.
Integration is UNCHANGED and **e2e stays 144**. `review.md`'s finding 13.
(Cut from 1921 alongside review8, which landed first — RE-MEASURED after
merging `main` rather than inferred, the fourth time in this run of branches.)

**THREE OF THE FINDING'S FOUR CLAUSES WERE ALREADY DONE, AND CHECKING SAID SO.**
M09 renamed Family/Metric/Threshold to Measurement/Statistic/Limit; the target
field already renders only for a scope that needs one ("show Target only when
required"); and "placeholders are not labels" was never violated — every field
has a real `<label>` and the placeholders are EXAMPLES beside them, with the
unit deliberately IN the label because `error_rate` earned that the hard way.

**WHAT WAS OPEN WAS THE ORDER, AND IT IS THE ONE THING NOBODY HAD LOOKED AT.**
`Name (optional)` sat SECOND — between the test scoping and the measurement,
sharing a two-column grid with Scope — so an author met an OPTIONAL field
before either decision that actually makes a rule. The finding puts it last:
"one readable preview, optional name, Save".

**AND IT READS BETTER THERE FOR A REASON BEYOND THE ORDER**: the preview
directly above states the rule as a sentence, which is exactly the moment an
author knows what they would call it.

**`<fieldset>`/`<legend>`, NOT NUMBERED.** The grouping has to reach a screen
reader or it is a visual convention only — a fieldset carries an implicit
`group` role named by its legend, the device `NewRunnerRun` already uses. M11
stripped the ORDINALS from that form because "1 ·" promises a flow that gates
step 2 behind step 1, and this form submits in one go exactly as that one does,
so the legends read `Measure` and `Limit` and nothing else.

**PRESETS ARE DECLINED WITH EVIDENCE, NOT SKIPPED.** The finding asks for
"common presets such as response-time p95 and error rate". The form ALREADY
OPENS on `run` / `response_time` / `p95` — the first of those two, reached by
typing nothing — so a preset row would duplicate the default state and save one
`<select>` change on the second. That is chrome of exactly the kind review.md
20 objects to, bought for one interaction. Recorded as an arm not taken.

**AND SIXTY-THREE EXISTING CASES SURVIVED THE REGROUPING UNTOUCHED**, which is
the payoff for a file that queries by LABEL rather than by position: moving a
field between parents changes nothing `getByLabelText` can see. The two new
cases assert what those cannot — that the groups exist and are NAMED, and that
the name field now FOLLOWS the preview.

**TWO MUTATIONS FAILED ONE BUNDLED CASE AGAIN — SECOND BRANCH RUNNING.** As in
review9, the grouping and the ordering were asserted together, so stripping a
legend and moving the name back both failed the same case and the second proved
nothing. Split per claim, each lands on its own. **The habit is to write one
case per claim from the start**, rather than discovering the bundling from a
red-verify — it has now cost two branches an extra cycle.

The review8-filter-toolbar branch added no unit FILE and 1 case to
`apps/web/test/RunList.test.tsx`, from **153 / 1921 to 153 / 1922**.
Integration is UNCHANGED and **e2e stays 144**. `review.md`'s finding 8.
(Measured after merging `main`: review9 landed underneath it, so its first
floor of 1920 to 1921 described a tree that no longer exists.)

**THE COMPACT VIEWPORT HAD THE FIX AND THE DESKTOP DID NOT.** Below 768px the
run list's filters are `CompactFilters` — a disclosure, folded until something
is filtering, carrying its own summary. On a desktop the same controls were a
CARD: `rounded-xl border border-default bg-surface p-4 shadow-panel`, with a
`Filter runs` header row above them. That is the finding's "over-framed" in one
line, and it is **M02's lesson exactly — A FIX APPLIED AT ONE BREAKPOINT IS NOT
APPLIED**, which this file already records costing the run-health caveat its
correction.

**THE FRAME IS THE WEIGHT.** Border + surface fill + shadow is how this app
says "this is a thing to read" — `Card`, the statistics table and the decision
band all wear it. Spending it on the controls ABOVE the data gave a routine
filter the same weight as the run it exists to help you find, which is the
finding's own "give routine filters less visual weight than the data".

**AND THE HEADER ROW WAS ALREADY KNOWN TO BE REDUNDANT.** `showHeader={false}`
existed solely so the compact path would not print `Filter runs` eight pixels
under a `<summary>` reading `Filter runs` — the comment there says so and names
`ProjectRules.showTitle` as the same problem one page over. The desktop kept
it. The prop is gone rather than defaulted: with both callers wanting the same
answer it was a flag with one value, and the `<form>`'s own
`aria-label="Run filters"` is what names the region (and what
`RunList.test.tsx` has always found it by).

**BEHAVIOUR IS DELIBERATELY UNTOUCHED.** The finding says "retain a deliberate
Apply interaction if querying is expensive; do not change search behavior
merely for appearance" — so Apply still submits and Clear still appears only
when something is filtering. The new case asserts the controls are all still
present and labelled BESIDE asserting the frame is gone, because a form that
failed to render satisfies the absence perfectly.

**AND THE BRANCH WAS NEVER CUT, WHICH THE FLOOR COUNT CAUGHT.** This work was
done on top of `fix/review9-one-evidence-surface` — PR #172's branch — because
`git checkout -b` was never run after that PR was pushed. **Fourth occurrence
of the trap this file records, and the SECOND where `-b` was skipped entirely
rather than run from the wrong place.**

**THE TELL WAS `1922` WHERE `1921` WAS DUE.** One case added to a floor of 1920
cannot be 1922, and nothing else about the run looked wrong — every gate was
green, on a tree carrying two findings at once. Recovered before pushing:
`git show --stat` confirmed the stray commit touched only this finding's two
files, a branch was cut from `main` and the commit cherry-picked onto it, and
`git branch -f` put the other branch back on its pushed head (verified against
`git ls-remote` and the PR's own `headRefOid`). **The floors in this file are
worth the trouble precisely because they are what catches a green run measuring
the wrong tree.**
The review9-one-evidence-surface branch added no unit FILE and 1 case to
`apps/web/test/RunDetail.live.test.tsx` — one existing case was re-pointed and
SPLIT in two — from **153 / 1920 to 153 / 1921**. Integration is UNCHANGED and
**e2e stays 144**. `review.md`'s finding 9, the largest one left.

**MOST OF THAT FINDING WAS ALREADY DONE, AND MEASURING SAID WHICH PART WAS
NOT.** It names four presentations — "the decision band, an evidence summary,
individual assertion cards, and a full table". The cards are long gone and the
two tables are already explicitly grouped under their own headings (N01's
work). What survived is the SUMMARY, and it was a summary of the table directly
beneath it.

**THE COUNTS WERE ON ONE SCREEN THREE TIMES.** `RunDecisionBand` spells them as
a sentence (`3 passed · 1 failed · 0 not applicable`) AND as three
`DecisionCount` tiles; `AssertionEvidencePanel` then rendered the same three as
`AssertionCount` tiles. C01's entry above records removing exactly this
duplication from the band's own spellings — and left the panel standing, which
is how one screen comes to state one fact three times.

**MEASURED BEFORE DELETING, because a summary carrying one unique fact would be
worth keeping.** It carried none: the counts are the band's, the first
failure's message is the band's `detail` AND the table's own column, and the
rule description is the table's `Rule` column through the same describer. The
panel, `AssertionCount` and `AssertionEvidenceRow` are gone, and
`assertionProgress` and `assertionBarColour` went with them — **a helper dies
with the one call site it was written for**, which `lint` says and `tsc` does
not.

**THE BAND AND THE TABLE BOTH STATE THE FAILURE, AND THAT STAYS.** The band is
the CONCLUSION and the table is the EVIDENCE for it; M02 already argues that
`detail` is the failing gate's own message rather than a summary of the rows.
Two surfaces, two jobs. The panel was a third copy between them with no job at
all.

**AND THE SECOND HALF WAS AN ASYMMETRY BETWEEN TWO TABLES ON ONE TAB.**
`ToolAssertions` has split its rows into failed-and-the-rest since it was
written; the platform gates table rendered every gate, always. So a project
with twelve rules put twelve rows on the Overview whatever they said — the
"length without equivalent additional information" the finding names — and the
two evidence tables disagreed about whether a passing check is worth a row. The
rule is COPIED, not re-invented: same threshold, same wording, same control.

**TWO MUTATIONS FAILED THE SAME CASE, WHICH IS THE LESSON THIS FILE ALREADY
RECORDS AND THE REASON THE CASE IS NOW TWO.** Restoring the panel and pinning
the table open both failed one bundled case, so the second demonstrated nothing
the first had not. Split per claim, each mutation lands on its own.

**AND SPLITTING THEM EXPOSED A HIDDEN COUPLING.** The first case reached the
failure's row with `getByTestId('assertion-row')` — the SINGULAR form, which
throws on more than one match — so it silently depended on the collapse being
in force, a claim it does not make. Pinning the table open failed BOTH cases,
which is how the coupling surfaced. It is `getAllByTestId(...)[0]` now.
**A `getBy*` that happens to match once is an assertion about the count as
well as the content**, and it will fail for the wrong reason the day the count
changes.

The review20-heading-ladder branch added no unit FILE and 1 case to
`apps/web/test/Card.test.tsx`, from **153 / 1919 to 153 / 1920**. Integration is
UNCHANGED and **e2e stays 144**. `review.md`'s finding 20 — and the entry is
mostly about what it did NOT change.

**ITS FIRST FLOOR WAS 153 / 1916 to 1917, AND review19 LANDED UNDERNEATH IT.**
Third reconciliation in a row, which is the point at which it stops being an
accident: cutting a branch while another is open means its floor is true only
of the tree it was cut from. RE-MEASURED after merging `main` in — the
arithmetic (1 unit case, no spec) is what survives. **Finish and merge one
branch before cutting the next, or budget the re-measure.**

**FINDING 20 IS A DESIGN ASSESSMENT, AND THIS FILE ALREADY RECORDS LEAVING THAT
CLASS ALONE** — the other review's m01/m02 were left as "a direction to be
chosen, not a defect to be corrected". So the finding was MEASURED first, and
exactly one of its clauses turned out to be the code failing a rule it had
already written down for itself.

**`<h2>` RENDERED AT THREE SIZES:**

```
  16px  SectionHeading                          the section rung
  15px  Card at headingLevel={2} — 8 call sites  the CARD rung, drawn for a section
  15px  ProjectSetup's own entry-card <h2>
  13px  Login's "Sign in to your organisation"   a subtitle, argued in place
```

`SectionHeading`'s docstring states the ladder as **20/24 → 16 → 15px** in as
many words. So this is not a taste question: `Card` sized its title by
COMPONENT while its level was the CALLER's to choose, and the eight sites
asking for an `<h2>` got a section heading at the card rung.

**A SIZE CHOSEN PER COMPONENT IS A LADDER ONLY WHILE NO COMPONENT IS REUSED AT
TWO DEPTHS.** `Card` grew `headingLevel` precisely so a card following an `<h1>`
directly would not skip a rung in the outline — and that same flexibility is
what broke the visual ladder, silently, because nothing renders a size
assertion. The size follows the level now.

**AND LOGIN'S 13px `<h2>` STAYS**, deliberately: it is a subtitle under the
brand, its own comment argues why it is a heading at all, and promoting it to
16px would make the sign-in page read as two competing titles.

**WHAT WAS MEASURED AND LEFT, WITH THE NUMBERS**, so the next reader
re-measures rather than re-investigates:

  - **"one primary action per task"** — `variant="primary"` counts per route:
    RunList 3, ProjectAccess 2, ProjectRules 2, TestRuns 2, the rest 1. The
    three in RunList are the filter's Apply plus TWO MUTUALLY EXCLUSIVE
    empty-state actions (First page, Clear filters), so no screen ever shows
    three. Counting per FILE answers a different question from the one the
    finding asks; per screen, nothing is clearly violated.
  - **"fewer nested panels"** — 11 `<Card>` call sites against **15 hand-rolled
    `rounded-xl border border-default bg-surface` surfaces**. That IS a real
    consistency gap, and converting them is a per-site judgement (several are
    SECTIONS rather than cards on purpose, including the comparability panel),
    which is a different change from making one heading obey its own ladder.

**THE GENERAL SHAPE IS WORTH KEEPING.** A finding labelled "design assessment"
is not automatically nothing — it is a claim to be measured. Measuring this one
separated a defect the code's own docstring condemns from three clauses that
need a product decision, and the numbers above are what make the difference
checkable rather than arguable.
The review19-concise-comparability branch added no unit FILE and 3 cases to
`apps/web/test/RunCompare.test.tsx`, from **153 / 1916 to 153 / 1919**.
Integration is UNCHANGED and **e2e stays 144** — its browser assertions went
inside an existing `test(` block. `review.md`'s finding 19.

**THE PANEL OPENED WITH A SENTENCE TRUE OF EVERY SELECTION IT COULD APPEAR
OVER.** "These runs differ in ways that change what a comparison means" is
correct for any non-matching cohort and actionable for none of them, and it sat
above six facts rendered whether or not they said anything. The headline names
the dimensions now — `Different environment, branch and build` — and the facts
are a disclosure, which is the finding's own "concise notice with details
available".

**AND THE SENTENCE MOVED TO WHERE THE FINDINGS LIVE.** `summariseConditions`
was written for the run overview's baseline note two branches ago and is
`comparability.ts`'s now, because a reader moves between those two pages and
two copies would drift into describing the same six findings two different
ways. **The module that defines a fact should own how it is said.**

**THE FACTS THAT MATCH SURVIVE, AND THAT IS THE HALF WORTH ARGUING.** The
instinct is to file only what differs. A reader concluding a comparison is
SOUND needs the matches — "un-flagged" and "checked and equal" are different
claims, and only the second justifies trusting a delta. So all six stay, one
disclosure away.

**IT IS OPEN WHEN EVERYTHING MATCHES AND SHUT WHEN SOMETHING DIFFERS**, which
reads backwards until you see what each headline carries. A differing headline
already names the actionable part, so the detail is optional; a matching one is
six words with no detail in it at all, and shutting the evidence away would
hide the answer exactly when it IS the answer.

**THE COUNT TILE IS GONE.** "Summary cards then repeat the active selection and
metric" — it read `2` over "p95 across the active selection", a number the
reader gets by counting the pressed chips directly above and a metric every
other tile's unit already carries. It spent a third of the row restating the
controls, which is why the principal delta was not the first thing there.
`metricLabel` died with it, and `lint` is what said so: `tsc` is perfectly
happy with a prop nobody reads.

**AND THE TILE'S ABSENCE IS ASSERTED IN THE BROWSER, NOT IN jsdom, FOR A
REASON.** `CompareSummary` renders only once the runs' statistics arrive, and
the unit harness answers `/stats` with a body that fails its schema — so a
jsdom `queryByText('Selected runs')` would return null against a summary that
never rendered at all. **A negative assertion in a harness that cannot reach
the positive state proves nothing**, which is the `toBeHidden()` lesson this
file already records, met from a second direction.

**TWO CLAUSES ARE DELIBERATELY NOT DONE, AND SAYING WHICH IS THE POINT.** "Keep
the warning near the conclusion it qualifies" was already satisfied — the panel
sits immediately above the summary tiles, and the comment there has argued that
placement since the review-criticals branch ("whether a delta MEANS anything
has to be settled before the delta is read"). "Put metric and baseline controls
together" is a layout restructure: the metric selector belongs to `CompareChart`
and hoisting it above the summary is a different change from making this notice
concise. Recorded as checked-and-already-true and as left, rather than quietly
skipped.

**AND THE BRANCH WAS CUT FROM A `main` THAT WENT STALE UNDER IT — RECOVERED BY
STASHING BY PATHSPEC.** review17 and review15 both landed while this was in
progress, so the working tree was editing a `RunCompare.tsx` that predated
review17's picker chips. `git stash push <three paths>`, `git merge
origin/main`, `git stash pop` three-way merged cleanly and kept BOTH — the
chips and this panel — which is the SAFE form of the manoeuvre this file
already warns about: **`--include-untracked` is what sweeps
`docs/ui-review-2026-09-13/`, `review.md` and `scripts/seed-manual-test.mjs`
into a stash; naming paths never touches them.** Verified by grepping for one
marker from each change before trusting the result.

The review15-scannable-rules branch added no unit FILE and 2 cases to
`apps/web/test/ProjectRules.test.tsx`, from **153 / 1914 to 153 / 1916**.
Integration is UNCHANGED and **e2e stays 144** — no spec changed.
`review.md`'s finding 15.

**ITS FIRST FLOOR WAS 153 / 1912 to 1914, AND review17 LANDED UNDERNEATH IT.**
That is the second reconciliation in a row, so the habit is worth stating
plainly rather than rediscovering: when several branches are cut from one
`main`, the floor each records is true only of the tree it was cut from.
RE-MEASURED after merging `main` in — never inferred — and the arithmetic (2
unit cases, no spec) is the part that survives.

**THE RULE WAS ONE MONOSPACE SENTENCE IN ONE CELL**, so comparing six rules
meant reading six sentences and diffing them by eye — "the threshold itself is
written as a long technical sentence". It is two columns now, `Measurement` and
`Limit`, which is the split the review's own wireframe draws.

**AND THE SEAM WAS ALREADY IN THE CONTRACT.** `describeSlaMeasurement` is WHAT
is measured and `formatSlaValue` is the bound; the sentence `describeSlaRule`
builds for the authoring preview is those two joined. Neither is new — the run
page's gates table has rendered the first since `review.md` 3 — so this is one
more caller of a decision already made once, not a second opinion about how a
rule reads. **The preview keeps the sentence deliberately**: it is read once,
where a table row is scanned against five others.

**THE FREQUENT CONTROL STAYS AND THE DESTRUCTIVE ONE MOVED.** Every row ended
with Disable AND Delete, which is what made the surface "emphasize management
actions" rather than list rules. Enable/Disable is the ordinary maintenance a
reader comes for; Delete is rare and cannot be undone, and it is behind a row
menu now — **the trigger moved, the confirmation did not**. Selecting it opens
the same two-step block in the same cell, which is what the finding's "existing
confirmation behavior" asks for.

**THE MENU TRIGGER IS NAMED AFTER ITS ROW.** Six rules means six triggers in
one table, and six controls sharing the name "More" is the duplicate-name
defect this repo has paid for three times. An unnamed rule falls back to its
MEASUREMENT, which is what its first column shows anyway.

**EIGHT EXISTING CASES WENT RED, AND EVERY ONE OF THEM WAS RIGHT TO.** Three
looked for `Whole-run p95 response time ≤ 800 ms` as one string and three
clicked a `Delete` button — both the old shape, asserted verbatim. They were
re-pointed at the CLAIM rather than deleted: the describers still agree with
the run page, and the confirmation still arms before deleting.

**AND THE NEW CASE ASSERTS THE CELLS, NOT THE STRINGS.** A single cell still
holding the whole sentence satisfies any assertion that merely finds both
substrings — that IS the before-state — so it asserts the two live in
DIFFERENT `<td>`s and that the measurement cell carries no comparator.
Red-verified by joining them back into one cell.

**`describe` BECAME TWO FUNCTIONS AND `lint` FOUND THE LEFTOVERS.** Replacing
the cell left `describe`, `describeAssertionRuleForReader` and the `Assertion`
type unused — three errors `tsc` is happy to ignore and `eslint` is not. A
widening helper usually dies with the one call site it was written for.

**AND THE INDENTATION TRAP BIT TWICE MORE IN ONE SESSION.** Two anchored edits
failed because the literal was copied off a `sed 's/^/  /'` display, which adds
two spaces to every line. This file already records the fix, and it is worth
restating as a habit rather than a lesson: **print the target lines with
`repr()` and build the anchor from that**, never from anything that has been
through a display filter.

The review17-recognisable-runs branch added no unit FILE and 2 cases to
`apps/web/test/RunCompare.test.tsx`, and its e2e gains one spec. Integration is
UNCHANGED. `review.md`'s finding 17.

**IT WAS CUT FROM THE SAME `main` AS review6-test-identity, SO ITS FIRST FLOOR
WAS WRONG BEFORE IT MERGED.** Both branches measured 153 / 1911 and e2e 142,
and both were right about the tree they were cut from; review6 landed first, so
this one was describing a tree that no longer existed. RE-MEASURED after
merging `main` in rather than inferred:

```
  cut from      153 / 1911   e2e 142
  review6 lands 153 / 1912   e2e 143
  this branch   153 / 1914   e2e 144     <- measured on the merged tree
```

The arithmetic is what survived the reconciliation — 2 unit cases and 1 spec
onto whatever it sits on — which is the M18/M05 pair's lesson met a second
time. **A FLOOR IS A PROPERTY OF A TREE, NOT OF A BRANCH**, and two branches
cut from one `main` cannot both be right once either merges.

**THE PICKER LABELLED EVERY CANDIDATE WITH A BARE TIMESTAMP.** `09-13 11:31`,
and `08-07 11:00 · e0b6ec` where two runs collided in one minute — which
"distinguishes records mechanically but does not tell an engineer which build
or environment they are choosing". A chip now carries the outcome glyph, the
time, its role, and the conditions the run recorded.

**THE TIME STAYS THE PRIMARY LINE, AND THAT IS NOT DECORATION.** `labelFor` is
also what names the overlay's SERIES and the matrix's COLUMNS — `compareLabels`
is documented as owning that shape because a series name is a string equality
key — so a chip that dropped it would leave the reader matching a picker
against a legend by eye.

**BASELINE IS THE SUMMARY'S OWN EXPRESSION, NOT A SECOND ANSWER.**
`compareSummary` defines it as the first OTHER selected run and the tiles divide
by it, so the picker computes `selected.find((id) => id !== runId)`. A chip
labelled Baseline that is not the run the tiles used would be worse than no
label, because it reads as evidence — the same reason the run overview's
baseline note links the run the deltas were actually computed against.

**AND A RUN THAT RECORDED NOTHING GETS NO LINE, rather than a dash or
"unknown".** The comparability panel below already states missing evidence in
the one place where it changes what a comparison MEANS; a chip repeating it
would spend its one spare line on a non-fact. Asserted as a pair — the
omission and the presence — because either alone passes against a picker that
always prints conditions or never does.

**THE VERDICT GLYPH COMES FROM `marks.tsx`.** That module is the one place
deciding what a verdict looks like, and a picker inventing its own dot would be
a second answer to a question already settled — including the `none`-is-not-
`not_evaluated` distinction that file argues at length.

**THE WHOLE CHIP IS NAMED IN ONE `aria-label`.** Four nodes — a glyph, a time,
a role badge, a conditions line — otherwise reach a screen reader as whatever
order they happen to sit in, led by a decorative character. The glyph is
`aria-hidden` and the label spells the outcome as a word.

**AND THE CONTENT WAS FREE TO CHANGE BECAUSE EVERY SPEC SELECTS THESE BY
ATTRIBUTE.** `run-compare.spec.ts` reaches them as
`[data-testid^="compare-run-"][aria-pressed="false"]:not([disabled])` — not one
query by accessible name — which is the compare-cap branch's own lesson paying
off two findings later: it moved to attribute selectors because `filter()`
matches DESCENDANTS, and the by-product is a picker whose markup can be
rebuilt without touching a single assertion.

**FILTERING IS DELIBERATELY LEFT.** The finding asks for it "when history
grows", and the cohort is bounded by the trends endpoint's own default limit of
twenty — so a filter would be built for a list that cannot currently reach a
size needing one. Recorded as an arm not taken rather than a clause missed.
The review6-test-identity branch added no unit FILE and 1 NET unit case — one
case in `apps/web/test/RunHeader.test.tsx` was replaced by two — from
**153 / 1911 to 153 / 1912**, and its **e2e rises to 143**. Integration is
UNCHANGED. `review.md`'s finding 6.

**THE HEADING NAMED THE CLASS, AND THIS REVERSES A COMMENT THAT ARGUED FOR IT.**
`RunHeader` said "the simulation is the run's identity to the person who ran it,
so it is the heading". That is true of whoever WROTE the simulation and false of
whoever is reading a run of it: `declaredTestSlug` exists precisely so
`checkout-smoke` and `checkout-soak` can share one class, and with the class as
the heading those two run pages are identical above the fold. The finding names
it exactly — "repeating the class as the main identity makes different user
tasks look the same".

**AND THE CHANGE ONLY DELIVERS BECAUSE A DECLARED TEST IS NAMED DIFFERENTLY,
WHICH WAS READ OUT OF THE SQL RATHER THAN ASSUMED.** `test-resolver.ts` has two
arms and they name a test differently:

```
  declared    VALUES (…, $3, $3, $4, …)   slug, name FROM THE SLUG, class beside it
  auto        SELECT …, c.slug, $4, $4    slug from the class, name AND class = the class
```

So a declared test carries the name its author chose and an auto-created one is
named after its class. **Had both been named after the class this whole finding
would have been a no-op on every page in the product** — the heading would have
rendered the same string before and after — and nothing in the unit layer could
have told me, because a unit fixture hands the component whatever name it likes.

**SO THE CLASS CHIP KEEPS QUIET WHEN THE HEADING IS ALREADY SAYING IT.** On the
majority of runs — every auto-created test — the heading IS the class, and a
chip repeating it would print the same string twice on almost every run page.
`headingSubject` is computed once and read by both, because two copies of that
expression drift into either printing the class twice or dropping it entirely,
and both failures are silent.

**THE WIREFRAME'S `Checkout smoke — run c2a7c145` IS DELIBERATELY NOT COPIED,
AND THE REASON IS A MEASUREMENT.** Putting the id in the heading too wraps to a
second line at 375px and pushed the run's own totals to **830px against
`mobile.spec.ts`'s 812 bound** — the one number in that file that is the GOAL
rather than the measurement, which M02 took three branches to reach with ten
pixels to spare. The id is one line up, in the breadcrumb's current-page rung,
where it has always been. Recorded as a deviation with its number rather than
rounded up to compliance.

**`git checkout -- <file>` DESTROYED THE FIX AGAIN. FOURTH TIME IN THIS FILE**,
and the first where the CHECKPOINT ITSELF was the trap: the checkpoint commit
was taken before the shape was settled, so `git checkout --` between two
red-verify mutations restored HEAD — the pre-settle version — and both mutations
then ran against source that was not under test.

**THE TELL WAS A MUTATION FAILING MORE CASES THAN IT SHOULD.** Mutation B was
aimed at one case and failed three, two of them breadcrumb cases it cannot
reach. That is the shape to distrust: this file already says to read WHICH
assertion failed, and the corollary is that a mutation failing cases it has no
business touching means you are not running the code you think you are. Dumping
the rendered breadcrumb showed `Run` where the settled source renders the short
id, which named the cause in one line. Re-applied, **committed immediately**,
and re-verified: each mutation then failed exactly one case, and different ones.

**A CHECKPOINT IS ONLY A CHECKPOINT IF IT HOLDS THE FINISHED SHAPE.** Commit
again after any material change, before the next mutation — an out-of-date
checkpoint is worse than none, because `git checkout --` reports success while
silently rewinding the work.

**AND THE e2e IS WHAT PROVES THE SEAM THE UNIT CASES CANNOT.** They hand
`RunHeader` a `test: { name: 'Checkout smoke' }` of their own making.
`seedTestWithRuns` writes a real test whose name differs from its class, and the
browser case reads the heading off the real payload — the "a test that supplies
both sides of a join proves neither" rule, one page over.

**`/v1/projects/:slug/runs` REFUSES A SESSION, AND ITS OWN REMEDIATION NAMED THE
FIX.** That GET is bearer-only by design — the pair of overrides on that path
gives each credential exactly one way in — so the first draft of the e2e got
`400 PROJECT_REQUIRED` carrying "Use GET /v1/runs with a session". Worth knowing
before reaching for the project-scoped list from a browser context.

The review4-name-the-baseline branch added no unit FILE and 3 cases — 2 to
`apps/web/test/RunStats.test.tsx` and 1 to `RunOverviewTab.baseline.test.tsx` —
from **153 / 1908 to 153 / 1911**. Integration is UNCHANGED at 137 / 1744 (both
are `.tsx`) and **e2e stays 142**. `review.md`'s finding 4, the last open
Priority 1.

**SIX TILES SAID "vs previous" AND NOTHING SAID WHICH RUN THAT WAS.**
`baselineRun` picks it with real care — strictly the run before this one in the
cohort's own total order, ties broken the way the run list breaks them — and
the reader was told none of it. So a -12% could be against last night's
identical nightly or against a different branch, in a different environment, at
half the offered load, and the two render identically. The finding puts it
exactly right: this "does not establish that the selected baseline is wrong. It
establishes that the overview's shorthand hides information needed to judge
relevance."

**THE MACHINERY WAS ALREADY BUILT, ONE PAGE OVER.** `comparability` has
answered this on Compare since the review-criticals branch, over the same
`TrendRun` fields, with `LOAD_TOLERANCE` and an explicit "unknown is not
compatible" rule. Nothing new was needed but a second caller. **Fourth time
this file records that shape** — `ErrorsTable`'s `windowSelected` passed at two
call sites of three, `compareLabels` named by its own docstring and called bare
by the trends axis, `formatSlaValue` reached by the authoring form and not the
evidence table.

**AND THE API WAS ALREADY SENDING THE FIELDS**, checked rather than assumed:
`packages/persistence/src/metrics/read.ts` maps `environment`, `branch` and
`commit_sha` onto every cohort row. Had it not, the note would have read
"not recorded" for ever and looked like a product that never records
provenance — so this was worth the thirty seconds before writing a test that
supplies both sides of the join.

**IT SAYS NOTHING WHEN THE TWO RUNS MATCH.** The IDENTIFICATION is
unconditional — a reader must always be able to see what "previous" means — and
the CONDITIONS earn a line only when there is something to act on. A permanent
"these runs are comparable" is the undifferentiated chrome `review.md` 20
objects to. That makes absence meaningful, which is only honest because the
summary, when it appears, distinguishes a real difference from missing evidence:
"Different environment and branch" is a fact about two runs, "build not
recorded" is a fact about what CI captured, and only the second tells the reader
to go fix their pipeline.

**THE FINDING'S "OFFER AN EXPLICIT BASELINE SELECTION" IS ANSWERED BY THE
COMPARE TAB, NOT BY A SECOND PICKER** — recorded as an arm taken rather than a
clause skipped. Compare already selects any two to five cohort runs and names
current and baseline; building a second selector onto the overview would put two
pickers for one question on one run.

**`<Link>` OUTSIDE A ROUTER BREAKS EVERY TEST THAT MOUNTS THE COMPONENT, AND
THE ERROR NAMES REACT-ROUTER RATHER THAN THE HARNESS.** `Cannot destructure
property 'basename' of React.useContext(...) as it is null` — which points at
`LinkWithRef`, not at the missing provider. **TWO PRE-EXISTING CASES WENT RED**,
which is what made it obvious rather than mysterious: a failure confined to the
new cases would have read as a mistake in them. All 19 mounts in
`RunStats.test.tsx` route through one `renderStats` helper now, so the next
baseline case cannot rediscover it. A plain `<a href>` would have "fixed" the
tests and shipped a full page load in a single-page app.

**AND THE PROSE WAS READ ONCE BEFORE IT SHIPPED, WHICH IS WHY IT CHANGED.** The
first wording — "Changes above read “vs previous”, which is the run of … — the
one immediately before this one in this test" — buried the definition inside a
relative clause and said "this one" twice. It is `“vs previous” is <link> — the
one immediately before this in this test`, which defines the phrase the tiles
use rather than describing it. Rendering the note and reading its `textContent`
whole costs one run; this file records three separate defects found only by
looking at the words on screen.

**RED-VERIFIED WITH TWO MUTATIONS THAT LAND ON DIFFERENT CASES**, which is the
rule the M05 entry earns: pointing the link at THIS run instead of its baseline
fails the seam case alone, and rendering the conditions unconditionally fails
the silence case alone. The first is the one worth having — a note naming the
wrong member of the cohort renders identically and reads as evidence.

The rules-form-survives-first-save branch added no unit FILE and 1 case to
`apps/web/test/ProjectRules.test.tsx`, from **153 / 1907 to 153 / 1908**.
Integration is UNCHANGED at 137 / 1744 (a `.tsx`), and **e2e stays 142** — no
source file changed at all. It pins one behaviour the branch below shipped
correct and unwitnessed.

**THE TWO CASES THAT BRANCH ADDED ARE SATISFIED BY THE DEFECT THEY DESCRIBE.**
"opens the form when there are no rules" and "keeps it closed when rules exist"
both pass perfectly against a plain `open={settled && empty}` — which is a
CONTROLLER, not a default, and shuts the form the instant a reader's first rule
lands and the list stops being empty. The entry below argues that defect at
length and then tested neither half of it.

**AND THE MECHANISM IS NOT THE ONE THAT ENTRY IMPLIES.** It says the reader's
choice wins "once they have touched it" — true, and not what saves this case,
because the reader who fills in a form that was already open has touched
nothing. What saves it is that **React's own write of the `open` attribute
fires a `toggle` event**, so `formOpen` latches `true` the moment the settled
empty query opens the form — long before the list becomes non-empty — and the
`??` fallback never applies again. Measured, over a real save: `open` is
`false` while the query is in flight, and `true` after the first rule appears.

**THE MUTATION IS INVISIBLE TO ALL SIXTY OTHER CASES**, which is the whole
argument for the case existing. Deleting the `onToggle` fails this one and
nothing else in the file.

**AND THE WAIT FOR THE SAVED RULE IS WHAT STOPS IT BEING VACUOUS.** A form still
open because nothing ever refetched proves nothing, so the non-empty list has to
be a fact on screen before `open` is read. The red-verify confirms the assertion
that fails is the one AFTER that wait — line-checked rather than inferred, since
this file records twice that a red-verify failing on the wrong assertion reads
exactly like one that worked.

**THE CASE NAMES WHICH DISCLOSURE IT MEANS.** `button.closest('details')` is the
file's idiom, and there are TWO disclosures on this form — the lifecycle policy
sits in its own, beside Save. It happens to be a sibling rather than an
ancestor, so `closest` resolves the right one; asserting the summary reads
`New rule` is what keeps that true rather than assumed.

The rules-page-trio branch added no unit FILE and 5 cases to
`apps/web/test/ProjectRules.test.tsx`, from a floor of 153 / 1902 to
**153 / 1907**. Integration is UNCHANGED at **137 files / 1744 tests** — that
file is a `.tsx`, which that config never runs — and **e2e stays 142**, with no
spec changed. `review.md`'s findings 12, 14 and 21 — one page, three findings that
turn out to be one edit region.

**THE LIST LEADS AND THE FORM IS A CHOICE (12).** A fully expanded creation
form sat above the existing rules, so a project with six of them opened on the
one task its reader had probably not come to do. `RulesPanel` renders first now
and the form sits behind a `New rule` disclosure — OPEN when there is nothing
to list, which the finding asks for in as many words.

**`open` IS A DEFAULT, NOT A CONTROLLER, AND THE DIFFERENCE IS A REAL BUG.**
`open={rules.length === 0}` recomputes on every render, so the form would slam
shut under a reader the moment their first rule saved. It is
`formOpen ?? (settled && empty)` with an `onToggle`: once they have touched it,
their choice wins for ever. And the default is CLOSED while the query is in
flight — `rules.data` is undefined then, and defaulting to open would flash the
whole form onto the screen and collapse it when six rules arrived. **An empty
state is a fact about a SETTLED query.**

**THE CONTROL IS NAMED, NOT LECTURED (21).** The helper sentence lived INSIDE
the `<label>` wrapping the Applies-to select, so its accessible name was
"Applies to A rule for one test judges only that test's runs. A live run is
matched to its test as soon as the log header names the simulation…" — the
whole policy, before the first option. It is a sibling `<p>` with an id and
`aria-describedby` now: a name identifies, a description explains, and the
description is announced after the name and the value rather than in place of
them. `helpId(field)` keys off the same field name `fieldId` and
`FIELD_GUIDANCE` use, so there is one spelling of "which field" — M08's rule,
and the reason a description pointing at nothing would be silent.

**POLICY IS AVAILABLE, NOT UNAVOIDABLE (14).** Both lifecycle paragraphs are
behind one `When does this rule apply?` disclosure beside Save, stated once
instead of split across the form. The wording is the backend's, which the
finding insists on ("do not replace a complicated policy with an inaccurate
promise").

**AND THE THIRD CLAUSE OF 12 WAS ALREADY DONE** — "distinguish project-wide and
test-specific rules" is M17's separate tables, with its reasoning in
`RulesPanel`'s own docstring. Checked rather than re-implemented.

**jsdom KEPT EVERY EXISTING TEST GREEN, WHICH IS WHY THIS WAS CHEAP.** 27 form
interactions across 55 cases, and not one needed touching: a closed `<details>`
keeps its children queryable there, the property this file already records for
`ProjectSetup`. The unit cases therefore assert the `open` ATTRIBUTE, never
visibility.

**AND THE ONE e2e I "FIXED" DID NOT NEED FIXING, WHICH `toBeHidden()` HID.**
`project-tests.spec.ts` authors a rule on a TEST's page, where the test's own
rules are empty — so the form is open by default and the original assertions
were already right. The edit added a summary click that CLOSED it, and the
failure surfaced two lines later as "Add rule not found".

**`toBeHidden()` PASSES FOR AN ELEMENT THAT DOES NOT EXIST**, which is what let
the wrong assumption look confirmed: the new "the form starts closed" assertion
went green against a page that was still loading. **A negative visibility
assertion is not evidence the thing exists and is hidden** — pair it with a
positive, or assert the attribute. Reverted; that spec is unchanged on this
branch.

The compare-request-delta branch added no unit FILE and 6 cases to
`apps/web/test/buildCompareMatrix.test.ts`, from a floor of 153 / 1896 to
**153 / 1902**. Integration moves with it (that file is a `.ts` integration
runs); **e2e stays 142** — one existing case was rewritten, not added to.
`review.md`'s finding 18.

**THE TABLE THAT ATTRIBUTES WAS ASKING THE READER TO DO THE ARITHMETIC.** The
per-request matrix put one number per run per row and nothing else, so
`146.95` beside `2515.46` was homework — and, worse, the rows that had NOT
moved looked exactly like the rows that had. That is the one job this table
has: the overlay above it already shows THAT a run got slower.

**THE SUBJECT IS PASSED, NEVER INFERRED FROM COLUMN ORDER.** `runs[0]` is the
obvious shortcut and is wrong in a way nothing would report: selection order
does put the current run first, but `RunCompare` DROPS a run whose statistics
failed to load before the matrix is built — so on exactly the day one request
errors, `runs[0]` is a different run and every change in the table silently
changes meaning. `currentRunId` is a required parameter with no default, the
rule this file already records for `listEnabled`'s `testId`, and `tsc` then
named the single call site.

**THE PAIR IS THE SUMMARY'S PAIR, DELIBERATELY.** `buildCompareSummary` defines
the subject as the run the reader came from and the baseline as the first other
selected run. A table that chose its own pair would put two different
comparisons on one screen under one metric selector.

**ONE DIRECTION RULE, MOVED BEFORE IT ACQUIRED A SECOND COPY.** `isDeltaGood`
lived in `compareSummary`; the matrix needed the identical judgement. It is
`isChangeGood` in `charts/transforms/compare.ts` now, beside the `CompareMetric`
it is about, so neither consumer owns a decision the other depends on — and it
takes a SIGNED CHANGE rather than a percentage, because the matrix has a case
the tiles do not (below).

**A ZERO BASELINE HAS NO PERCENTAGE AND STILL HAS A CHANGE.** Errors rising
from 0 to 2/s is the regression an engineer most needs to see and the one a
percentage cannot describe — the distinction `compareSummary`'s
`deltaUnavailable` already draws. `percent` is `null` there, the ABSOLUTE is
shown alone, and `good` is still decided, which is only possible because the
direction rule reads a sign rather than a ratio.

**BOTH NUMBERS, BECAUSE EACH ALONE MISLEADS.** A percentage cannot say whether
40% is four milliseconds or four seconds, and on a fast request it turns noise
into a headline; an absolute hides that +60 ms doubled a 60 ms request while
barely moving a 3 s one.

**AND THE HALF OF THE FINDING THAT WAS ALREADY DONE IS WORTH RECORDING.**
"Treat missing measurements as unavailable, never zero" was already true, with
the reasoning in the builder's own comment — a zero "would sort to the top of a
column of durations as though it were the fastest thing in the comparison". The
new column inherits it: a request only one run made has a DASH, not a zero
change.

**PORT 3000 WAS HELD BY SOMEBODY ELSE'S PROJECT, AND THAT IS NOT A THING TO
KILL.** `pnpm test:e2e` failed before a single spec with `http://localhost:3000
is already used` — `reuseExistingServer` is false on purpose. The process was a
`remotion render` from an unrelated checkout. `PERFPORTAL_E2E_PORT=3100` is the
lever, and it moves all four things the harness needs moved (this file records
that it is four, not three). **Check the cwd of whatever holds the port before
reaching for `kill`**; the answer here was that it belonged to another repo
entirely.

The rule-language-human branch added no unit FILE and 5 cases to
`packages/contracts/test/rules.test.ts`, from a floor of 153 / 1891 to
**153 / 1896**. Integration moves with it (that file is a `.ts` integration
runs); e2e is unchanged at 142. `review.md`'s finding 3.

**THE STORED SCHEMA WAS BEING READ ALOUD TO PEOPLE.** The run page's gates
table, its evidence cards and the rules table all rendered
`metric of target (family)` — `error_rate of the run (response_time)`,
`p95 of Cart (group_cumulated)`. Half of that is unreadable and half is FALSE:
an error rate is not a kind of response time, so the parenthesis states
something untrue about the quantity it qualifies.

**THE FAMILY IS NOISE FOR SOME METRICS AND MEANING FOR OTHERS, WHICH IS WHY IT
COULD NOT SIMPLY BE DROPPED.** The finding's own three examples are the
specification and they encode the rule:

```
  run,     error_rate, response_time    ->  Whole-run error rate
  request, p95,        response_time    ->  Search p95 response time
  group,   p95,        group_cumulated  ->  Cart p95 cumulative response time
```

`family` is the statistics family a row is filed under and `metric` is the
statistic taken over it, so the family qualifies a TIME statistic and says
nothing about an error rate, a throughput or a count.
`slaMetricUnit(metric) === 'ms'` is exactly that test — data this file already
owns rather than a second list to keep in step. `group_cumulated` against
`group_duration` is the pair that proves the family had to survive: a group's
summed request time against its wall-clock span, and they differ by nothing
else.

**`p95`, NOT "95th percentile", AND THE TWO DESCRIBERS ARE BOTH RIGHT.**
`slaMetricLabel` renders the long form for the authoring PREVIEW, a sentence
where "95th percentile response time must be at most 800 ms" reads as a claim.
A table cell is not a sentence, and the other review's N01 spent four branches
making `p95` mean one thing across the statistics table, the run totals tile
and the rules form — so the word in the cell is the word the reader will look
for on the run page afterwards.

**THE PRECISE FORM IS KEPT AND NOW HAS EXACTLY ONE CALLER: THE CSV.**
`describeAssertionRule` still writes the export, which is the artifact somebody
attaches to a review or diffs against another run — where a field the UI folds
away is precisely what they went looking for. That is the finding's own "put
the raw expression in Details", with the export as the details, and it is why
this is two functions rather than one rewritten one.

**TWO TESTS PINNED THE OLD WORDING AND WERE RE-POINTED AT THE CLAIM.**
`ProjectRules.test.tsx` asserted `p95 of the run (response_time) ≤ 800 ms`
verbatim. That is the verbatim-prose trap this file records for the M18 caveat
and C06's caption, in its benign form: the strings were right when written and
the product deliberately changed underneath them, so they move rather than the
product bending to suit them.

**AND A FOURTH SURFACE IS DELIBERATELY LEFT.** The LIVE SLA banner prints the
`description` the WORKER wrote into each delta (`packages/sla`'s own
`describe`), in the same raw vocabulary. Changing that changes what the worker
stores and streams — and what every delta already recorded says — rather than
how a page renders. That is a data change with a migration question attached,
not a rendering one, and it belongs in its own branch.

The sla-actual-units branch added no unit FILE and 1 case to
`apps/web/test/ToolAssertions.test.tsx`, from a floor of 153 / 1890 to
**153 / 1891** — `packages/contracts/test/rules.test.ts` gained assertions
INSIDE an existing block and so moved no count. Integration is unchanged at
137 / 1733 and e2e at 142.

**THERE IS A SECOND 13 SEPTEMBER REVIEW, AND IT HAD NEVER BEEN WORKED.**
`review.md` at the repo root — untracked, so invisible to every grep of `docs/`
— is a different reviewer's pass at baseline `d7cafc1`, 22 numbered findings,
written the same day as `docs/ui-review-2026-09-13/REVIEW.md`. `main` is **116
commits** past that baseline, so most of it landed as a side effect of the
other review; this is the first branch taken from it deliberately.

**ITS FINDING 1 IS A CORRECTNESS DEFECT, NOT A PRESENTATION ONE.** A failed
error-rate rule displayed `Actual 0.02` under `Limit ≤ 1%`. `error_rate` is
stored as a fraction and shown as a percentage everywhere else, so the number
that BREACHED the gate rendered as roughly a fifth of it. The evidence TABLE
printed the raw field — `0.0223463687150838` — in a column whose only job is to
be compared with the limit in the cell before it.

**THE FIX ALREADY EXISTED AND THE NAME IS WHY IT WAS NOT USED.**
`formatSlaThreshold(metric, value)` is metric-aware and was already the single
place that decision lives — for the THRESHOLD. An actual is the same quantity in
the same unit, and a function called `…Threshold` does not look like the thing
to format it with. It is `formatSlaValue` now, and both sides of the one
comparison a reader has to make go through it.

**THE SAME "ONE CALLER SHORT" SHAPE THIS FILE KEEPS RECORDING.** The
sla-threshold-unit branch fixed the authoring side and the rules table; the
run page's evidence card and table were the callers it did not reach. Same as
`ErrorsTable`'s `windowSelected` (two call sites of three), `compareLabels`
(named in its own docstring by the caller that ignored it), and the evidence
sections one branch ago.

**AND `tsc` CAUGHT THE FIXTURE, WHICH TAUGHT ME THE DATA SHAPE.** The new case
built a rule with `family: 'error_rate'` and was rejected: the family union is
`response_time | latency | group_cumulated | group_duration`. A real error-rate
rule carries `family: 'response_time'` with `metric: 'error_rate'` — the family
is the statistics family the row comes from, not the quantity. **That pairing
is review.md's finding 3**, which shows readers `error_rate of the run
(response_time)` verbatim, and it is left for its own branch: the expression
feeds four surfaces including the CSV export, and `describeSlaRule` — which
already renders the human sentence the finding asks for — has exactly one
caller today, the authoring preview.

**WHAT IS STILL OPEN IN THAT DOCUMENT**, audited against the code rather than
assumed: findings 1 (this branch) and 3 are confirmed; 2, 5, 7, 10, 11 and 16
are closed by the other review's work; 4, 6, 8, 9, 12, 13, 14, 15, 17, 18, 19,
20, 21 and 22 were not verified in this pass and must be re-derived before any
of them is called done — the heuristic that "the other review probably covered
it" is exactly the one that gave four false positives earlier in this session.

The evidence-verdict-scope branch added no unit FILE and 3 cases to
`apps/web/test/ToolAssertions.test.tsx`, from a floor of 153 / 1887 to
**153 / 1890**, and its **e2e rises to 142**. Integration is UNCHANGED (that
file is a `.tsx`).

**THE EVIDENCE CLUSTER'S ONE MISTAKE, MADE A FOURTH TIME.** The
evidence-window-scope branch found a number the window narrowed under wording
that still described the whole run, and fixed it in three places — the run
totals, the percentile note, and the SLA tint. That last fix is the one that
names this branch's defect in its own reasoning: the tint is WITHHELD under a
window because "an assertion is evaluated once at finalize against the run",
and recolouring it per window would invent a verdict nobody configured.

**THE TWO EVIDENCE SECTIONS ARE THAT SAME FACT AND SAID NOTHING.** Platform
gates and simulation assertions are decided when the run finishes, over the
whole run; the statistics directly above them are re-read per window
(`statsQuery(runId, window)`). So a reader who narrows to a healthy ten seconds
sees a windowed p95 beside a whole-run FAILED gate whose `actual` appears
nowhere on their screen — two true numbers in different scopes, one of them
labelled.

**A SECOND COMPONENT RATHER THAN A PROP ON `WholeRunNotice`, AND THE REASON IS
THE CLAIM.** That one is about an ENDPOINT: the drill-downs carry `from`/`to`
and their endpoints take none, so the figures CANNOT narrow. This one is about
WHEN a decision was made. Its closing sentence has to differ too —
`WholeRunNotice` ends "The run page's own figures still honour it", which is
help for a reader who has LEFT the run page, and here the windowed figures are
on screen directly above. Reusing that wording would answer a question nobody
on this page is asking.

**AND THE NOTICE FOLLOWS THE EVIDENCE, NOT THE WINDOW.** A project with no SLA
rule takes the gates section's empty branch — "not configured", a statement
about the PROJECT — and a scope notice over it would disclaim a verdict that
does not exist. One case pins exactly that: a window, no gates, one notice.

**A KEEPER CASE THAT CANNOT REACH THE MUTATED BRANCH IS NOT A KEEPER.** The
"says nothing without a window" case was written with no platform gates, so the
gates section early-returned and the notice was never reached — and rendering it
UNCONDITIONALLY left all fifteen cases green. The mutation was unreachable from
the assertion meant to catch it. Seeding a gate into that case makes it fail.

**Second time in two branches**: the residue fixture could not tell its two arms
apart because every seeded user satisfied both. The shape generalises — **check
that the keeper exercises the same branch the mutation lands on**, not merely
that it describes the opposite state.

**AND THE BROWSER HALF PROVES THE SEAM THE UNIT HALF SUPPLIES.**
`ToolAssertions.test.tsx` hands the tab a window through a stand-in for
`RunShell`'s `<Outlet context>`, so it can only show the section renders what it
is given; whether the real shell's brush delivers one to this tab is the other
side of the join. `run-tables.spec.ts` drives the real control and asserts both
states.

The incomplete-run-unwitnessed branch added no unit FILE and 3 cases — 2 to
`apps/web/test/RunDecisionBand.test.tsx` and 1 to `RunList.test.tsx` — from a
floor of 153 / 1884 to **153 / 1887**, and its **e2e rises to 141**.
Integration is UNCHANGED at 137 / 1733 (both files are `.tsx`, and the other
two it touches are e2e).

**EVERY FINDING IN THE 09-13 REVIEW IS CLOSED. THE ACCEPTANCE LIST IS NOT, AND
THAT IS A DIFFERENT DOCUMENT.** C01-C06, M01-M18 and N01-N04 are all done —
M05, M18 and M12 last. What remains is the final paragraph's exercise list
("live/disconnected/failed/incomplete runs; … invalid uploads; permission-denied
states; …"), which earlier branches took in clusters. Re-derived by reading the
SUITE rather than the notes, three of those four run states are exercised and
one is not.

**`incomplete` APPEARED IN NO SPEC AT ALL, IN A PRODUCT THAT GIVES IT FOUR
SURFACES.** A status filter option, its own glyph in `marks.tsx`, its own
sentence in the decision band, and a place in the run list's "Needs attention"
tally. `RunDecisionBand.test.tsx` and `RunList.test.tsx` each matched it ZERO
times, and no e2e ever rendered one. This is the M16 shape again — reachable,
correct, and unwitnessed.

**REACHABILITY WAS READ OUT OF THE SYSTEM, NOT ASSUMED.** The sweeper's
`running` arm finalizes a live run whose producer stopped via
`RunRepository.markIncomplete`, and `RunsService.statusFor` answers **200** for
it with a comment saying why it must not be 202: an aborted live run has no
worker left to move it past one, so a poller would retry it for ever. Verdict is
always `not_evaluated`, so nothing but the STATUS can put such a run in the
attention tally.

**AND THE TWO SENTENCES SEND A READER TO DIFFERENT WORK.** "could not be
processed" is an ingest that rejected the bundle — nothing was measured, so
re-upload. "incomplete — the stream stopped early" is a producer that died
mid-run — what arrived IS real data, so re-run the test. Both cases assert the
pair exclusively, because "says incomplete" alone passes against a band that
says every run is.

**THE FILTER IS A `<form>`, AND THE FIRST VERSION OF THE e2e READ AS A PRODUCT
DEFECT BECAUSE OF IT.** Selecting `Status = Incomplete` sets the form's own
state and nothing else; the narrowing is a SUBMIT. So the list still showed a
complete run, for five seconds and fourteen polls, with the option reported
`[selected]` in the snapshot — which looks exactly like a filter the API
ignores. **Before believing a filter is broken, check whether applying it is an
event you have not fired.** The case presses Apply and asserts `status=incomplete`
reaches the URL, so the next reader sees which half failed.

**A COUNT AND ITS LABEL ARE SIBLINGS, SO THE LABEL'S PARENT IS NOT A HANDLE.**
`HealthTile` renders value, label and detail as three unlabelled spans, and
`getByText('Needs attention').locator('..')` resolves to two elements under
strict mode. It carries a derived `data-testid` now — `health-${label}`, the
shape `EntryCard` already uses and the same reason `health-scope` beside it
exists. Grep for the derived value, not only the label.

**AND THE `git checkout --` TRAP DID NOT BITE THIS TIME, BECAUSE THE CHECKPOINT
WENT IN FIRST.** The entry above records it as the third occurrence; the
mechanical guard it prescribes — one `git commit -q` before the first mutation —
was followed here, and a mutation whose anchor silently missed (the same
two-space indentation slip, twice) cost a re-run instead of the work. **The
anchor-count assertion is what catches that**: a mutation that changed nothing
reported 19 passed and looked exactly like a vacuous guard.

The residue-orphan-users branch added no unit FILE, no unit case and no spec —
its diff is one SQL script and its two fixtures — so unit stays 153 / 1884,
integration 137 / 1733 and e2e 140. It is guarded by CI's `test-residue` job,
which no `pnpm` gate runs.

**A CLEANUP SCRIPT LEFT ONE ROW BEHIND EVERY TIME, FOR EVER.** `residue_user`
found users by walking `org_member` from the residue orgs — which cannot see a
user that never had a membership at all, and `seedUserWithoutOrg`
(`apps/web/e2e/fixtures.ts`) creates exactly that on purpose for the
403-after-login case. Such a user has no org, no project and no rows anywhere
else, so nothing else in the file reaches it either: one leaked login per
`pnpm test:e2e` run, invisible, permanent.

**FOUND BY READING THE RESULT OF A SWEEP RATHER THAN BY TRUSTING IT.** A full
clean took the database to 0 orgs and 0 runs — and one row in `user`,
`orphan-f8110219@example.test`. A cleanup that reports success and leaves
something is the shape nobody checks, because the number that matters (the
database is 9 MB now) is right.

**THE SECOND ARM MATCHES THE EMAIL SHAPE, AND THE SHAPE IS THE CONTRACT.**
Every fixture user in that file comes from ONE helper — `unique(prefix)` =
`${prefix}-${randomUUID().slice(0, 8)}` — at the RFC 2606 reserved
`example.test` domain, so `^[a-z][a-z-]*-[0-9a-f]{8}@example\.test$` cannot
collide with a human address. Matching the SHAPE rather than today's three
prefixes is deliberate: the org patterns above it are hand-written slugs that
each need adding by hand, and this file admits "nothing can detect a new SLUG
shape for you" — for users, one helper's output means a fourth fixture is
covered the day it is written.

**AND THE `NOT EXISTS (org_member)` GUARD IS WHAT MAKES A PATTERN MATCH SAFE.**
A user matching either arm is still spared if it holds any surviving
membership, so a fixture-named account somebody added to a real org is never
removed. Pattern to FIND, membership to DECIDE.

**THE FIXTURES SEEDED NO USERS AT ALL, SO BOTH ARMS WERE UNGUARDED** — the new
one and the one that had been there all along. Five users now, each making one
outcome falsifiable, and the two keepers are the ones that matter: a real
person who has signed up and not yet joined an org (which a rule keyed on
membership alone would delete), and a fixture-SHAPED user who belongs to the
keeper org (which a rule keyed on the email alone would delete).

**A GUARD WHOSE CASES SATISFY TWO RULES AT ONCE CANNOT TELL YOU WHICH RULE IS
WORKING.** Deleting the OLD arm entirely left the fixture GREEN, because every
seeded fixture user matched the new email shape as well as its membership. The
membership walk is not redundant in production — the API fixtures sign up fixed
strings like `minter@example.test`, which no shape matches — so the fixture
grew a residue member with a plain address, and that mutation now fails naming
it. **When two rules both cover every case in your fixture, the fixture is
testing their union and nothing else.**

**FOUR MUTATIONS, FOUR DISTINCT FAILURES**, which is the property worth having:

```
  the new arm removed        the org-less fixture user survived
  the old arm removed        a residue member with a non-fixture email survived
  NOT EXISTS dropped         a fixture-shaped user in a REAL org was deleted
  arm widened to "no org"    a real user with no org was deleted
```

**AND CI CAUGHT WHAT EVERY LOCAL RUN COULD NOT, BECAUSE MY RESET WAS KINDER
THAN THE JOB'S.** The `test-residue` job failed on the one step this branch
should have been safest for: its red-verify, `residue-assert.sql passed against
residue-broken.sql — it has stopped testing anything`.

**`TRUNCATE org CASCADE` DOES NOT REACH `"user"`.** CASCADE follows tables that
REFERENCE the truncated one; `user` is referenced BY `org_member` and
references nothing, so every login survives a reset of the orgs. The job seeds
a SECOND time for its red-verify, so the keeper users were already there and
the new `INSERT INTO "user"` hit `duplicate key value violates unique
constraint "user_pkey"`.

**AND THE SEED IS ONE TRANSACTION, SO A DUPLICATE USER ROLLED BACK THE ORGS
TOO.** Not "the users were skipped": nothing was seeded at all, the broken
script then had nothing to orphan, and the assertion that exists to catch a
vacuous assertion passed against an empty database. **A fixture that rolls back
silently is indistinguishable from a product that cleaned up perfectly** — both
leave zero rows, which is what every "residue is gone" assertion checks for.

The seed clears the six user ids it owns before inserting them. **A fixture
that a caller may run twice has to own its rows rather than assume the reset
around it reaches them** — and which tables a truncate reaches is a fact about
FK direction, not about what feels related.

**MY LOCAL RESET DELETED USERS AND THE JOB'S DOES NOT, WHICH IS THE WHOLE
REASON THIS SURVIVED FOUR MUTATIONS AND A BASELINE.** Every local run was green,
including all four red-verifies, because the helper I wrote to reset between
them was more thorough than the thing it stood in for. **A guard rehearsed with
your own harness is not rehearsed** — replay the CI step's exact commands, in
its order, including the parts that look like housekeeping.

**AND `git checkout -- <file>` DESTROYED THE UNCOMMITTED FIX. THIRD TIME IN
THIS FILE.** The zoom-reflow entry records it, the attribute-navigation-stalls
entry records it AGAIN with "writing a lesson down is not the same as having
it" — and it happened here anyway, restoring the script from an INDEX that
never held the fix, between mutation one and mutation two.

**THE TELL WAS A RED-VERIFY FAILING ON THE WRONG ASSERTION.** Mutation two
reported "the org-less fixture user survived" when it should have reported the
keeper being deleted — because the file it ran against was not the file under
test. A red-verify that fails is not automatically a red-verify that worked:
**read WHICH assertion failed, not merely that one did.** Committing the
checkpoint first — which this file already prescribes, twice — is the whole
fix, and it is now cheap enough that there is no excuse: one `git commit -q`
before the first mutation.

M12 IS CLOSED AND NEEDED NO CODE, WHICH IS ITSELF THE RECORD. No branch, no
floor movement: unit stays 153 / 1884, integration 137 / 1733, e2e 140. This
paragraph exists because "nothing to do" and "nobody checked" look identical in
a review ledger a month later.

**THE FINDING OFFERS TWO ARMS AND THE PRODUCT ALREADY TOOK THE SECOND.** M12:
"Add heartbeat-backed availability with last-seen time, OR accurately show
`Runner availability unknown` with a connection-check/setup action. Do not
imply job history proves current connectivity." Read against the code rather
than against memory, all three clauses hold:

```
  headline      'Runner availability unknown'            runnerReadiness.ts
  no oracle     "Queue one to find out whether a node
                 is connected" is gone                   (killed by M12 itself)
  an action     deploy the runner beside this instance,
                with a token carrying On-prem runner     ProjectSetup.tsx
  honest        "until one claims a job, this page
                cannot tell whether any are connected"   runnerReadiness.ts
```

**THE HEARTBEAT ARM IS DECLINED WITH A REASON, NOT DEFERRED WITH A SHRUG.**
There is no runner-health endpoint and `runner_job` has no heartbeat column,
because the on-prem runner POLLS — nothing in the API is told when one connects
or leaves. Building that arm is a backend feature and a product decision; the
finding explicitly allows the other arm, and the other arm is what an operator
can act on today.

**AND THE SCOPE OF THE ACTION IS THE PART WORTH RE-READING.** `needsSetup` is
true for `unknown` ALONE. `idle` and `stalled` mean a runner HAS been seen, so
telling that reader to go deploy one is wrong advice confidently given — the
same class of error the finding objects to, one state over.

**THE GENERAL RULE: A FINDING CLOSED BY EVIDENCE STILL GETS AN ENTRY.** Three
sweeps in this review found real work behind an apparently-closed finding, and
the cost each time was a reader trusting a verdict nobody had re-derived. The
cheap defence is to write down WHICH arm was taken, WHERE the code says so, and
WHY the other was refused — so the next reader re-checks a claim instead of
re-doing an investigation.

The review-m18-token-lifecycle branch (M18 — the finding is closed) added no
unit FILE and 11 cases — 5 to `packages/contracts/test/tokens.test.ts` and 6 to
`apps/web/test/ProjectAccess.test.tsx` — and its **e2e is UNCHANGED** (it
touches no spec).

**ITS FLOORS WERE MEASURED TWICE, AND BOTH NUMBERS ARE HERE ON PURPOSE.** Cut
from `main` at 152 / 1860, it measured **152 / 1871** unit and 135 / 1711
integration on its own. M05 then merged FIRST, and `main` moved to 153 / 1873
and 137 / 1721 underneath it — so after merging `main` back in, this branch
measures:

```
  unit         153 / 1884      (153 / 1873 + this branch's 11)
  integration  137 / 1733      (137 / 1721 + 12: the contracts file is a
                               `.ts` integration runs too, plus 6 cases in
                               `tokens.integration.test.ts` and 1 in
                               `openapi.integration.test.ts`)
  e2e          140             unchanged
```

**A FLOOR IS A PROPERTY OF A TREE, NOT OF A BRANCH**, and two branches cut from
one `main` cannot both record "from a floor of X" and stay true — whichever
merges second is describing a tree that no longer exists. The arithmetic is
what survives: this branch adds 11 unit cases and 12 integration cases to
WHATEVER it sits on. Re-measure after merging `main` in, and say which order
the two landed.

**AN API TOKEN COULD ONLY EVER BE KILLED, NEVER SCHEDULED TO DIE.** `api_token`
had `revoked_at` and nothing else, so the only lifecycle a credential had was
somebody remembering it. `expires_at` is nullable and checked in
`authenticateRequest` BESIDE the revoked check and BEFORE the hash — a
credential that must not be accepted should not have its secret verified, and
the cheap rejection keeps an expired token from costing an Argon2 verification
per request.

**TWO REASONS A CREDENTIAL STOPS WORKING, AND THE READER IS TOLD WHICH.** Both
answer 401, because the credential is not usable and that is what 401 means —
but the SENTENCES differ ("has been revoked" against "has expired") and so does
the status column, because the fixes differ: one is rotated, the other was
deliberately killed. `tokenStatus` puts Revoked ahead of Expired for that
reason, and the case that pins it is a row satisfying BOTH at once: revoked
last month, expiry passed since. "Expired" there is true and misleading.

**NO DEFAULT TTL, DELIBERATELY.** The finding asks for expiry to be ASSESSED as
a product requirement, not for one to be invented. A default lifetime on
`MintTokenRequestSchema` would expire credentials CI has been using for a year,
at the moment this deploys. The author chooses Never / 30 / 90 / 365, and Never
is the default the form opens on. A past instant IS refused — a token that
expires at mint can never be used, which is a typo rather than an intention.

**THE INTEGRATION SUITE READS WORKSPACE PACKAGES FROM `dist`, AND SWITCHING
BRANCHES DOES NOT REBUILD IT.** The new OpenAPI guard went red on its first run
reporting that `MintTokenRequest` carried only `name` and `scopes` — exactly
what a `.refine()` swallowing its own object looks like. It was not: a
Playwright run on ANOTHER branch had rebuilt `packages/contracts/dist` from
THAT branch's source, and `git checkout` does not rebuild. `@perfportal/contracts`
resolves to `dist/src/index.js`, so the field simply did not exist in the code
the API under test was importing.

```
  ls -la packages/contracts/dist/src/tokens.js   # 20:27 — built on the other branch
  ls -la packages/contracts/src/tokens.ts        # 21:25 — this branch's source
```

`pnpm build` and the same run was 22/22. **A red integration result that
crosses a package boundary is a build claim before it is a code claim** — and
the tell is that the failure describes the OLD code perfectly, which is what
makes it so convincing.

**AND THE GUARD IS WORTH KEEPING EVEN THOUGH ITS FIRST RED WAS THE WRONG
CAUSE.** `components.schemas` is DERIVED from these zod schemas, so a
conversion that does not see through a refinement emits an object with no
properties while every runtime test stays green — the server still validates
correctly, and only the DOCUMENT lies. The case asserts `expiresAt` beside
`name` and `scopes`: the two that were always there prove the conversion
produced a real object, and the new one proves the refinement did not cost it.

**A CONDITIONAL SPREAD IS STILL A HOLE IN TYPE CHECKING, AND THIS ONE WAS
MEASURED BOTH WAYS.** The mint payload built its optional field as
`...(expiresInDays === null ? {} : { expiresAt })` — the spelling this file
already records for `live-sink.ts`, where a mistyped key inside a spread
compiled and silently never reached the repository. Written as a named
`expiresAt: … ? undefined : …` instead (legal here: `exactOptionalPropertyTypes`
is off, and `JSON.stringify` drops an undefined value, so nothing is sent), the
same typo is `TS2561: Object literal may only specify known properties`.
Verified by making it and watching `tsc` reject it.

**AND THE `undefined` BRANCH ON THE EXPIRES CELL IS NOT COSMETIC — IT IS WHAT
KEEPS A ROLLING DEPLOY FROM BLANKING THE PAGE.** `.nullable().optional()` on
the contract stops the browser dropping a body from a pod that predates the
field; the CELL then has to handle the `undefined` that arrives. Narrowed to
`=== null`, `formatInstant(undefined)` throws `RangeError: Invalid time value`
and takes the whole token table down — **11 of that file's 15 cases fail, not
one**. The mutation that was expected to mislabel a column crashed the page
instead, which is a stronger reason for the branch than the one it was written
with.
The review-m05-browser-upload branch (M05 — the finding is CLOSED) added ONE
unit file — `apps/web/test/uploadBundle.test.ts` (13) — from a floor of
152 / 1860 to **153 / 1873**, and its **e2e rises to 140**. Its integration
floor is **137 files / 1721 tests**: that unit file is a `.ts` integration runs
too, plus a new `apps/api/test/project-ingest.integration.test.ts` (8) and one
case in `openapi.integration.test.ts`. `ProjectSetup.test.tsx` moved NEITHER
number — one case was inverted and one rewritten, 16 either side.

**THE INTERIM'S OWN TEST SAID HOW IT SHOULD DIE, AND IT DIED THAT WAY.** The
M05 interim (entry further down this file) named the card "Import via API" and
pinned the pair: that heading, AND `document.querySelector('input[type="file"]')`
being null anywhere on the page. Its docstring said "when the picker is built,
that second assertion is what should fail — which is the right way for this case
to die." It failed exactly there, on the first full unit run of this branch.

**THAT IS THE OPPOSITE OF THE TRAP THIS FILE RECORDS TWICE** — the M18 caveat
and C06's caption, both pins that were right when written and became the reason
a defect survived. The difference is not care, it is that this one named its
SUCCESSOR: a pin that says what should break it is a pin the next reader can
retire on purpose. Both halves invert rather than being deleted, and the pair
survives for the reason the interim gave — a file input under "via API" is a
card describing the wrong thing, and a title promising an import over a page
with no picker is the defect the interim existed to prevent.

**ONE PATH, TWO OPPOSITE SECURITY OVERRIDES, AND THAT IS THE DESIGN.**
`/v1/projects/{slug}/runs` now carries a bearer-only GET and a cookieAuth-only
POST. A session names no project, so it can never reach `POST /v1/runs` (400
PROJECT_REQUIRED); a project-scoped token names exactly one and needs nothing
here. Each credential has precisely one way to ingest. The OpenAPI case asserts
the PAIR, because either half alone passes against the collapse that matters:
add `bearerAuth` to the POST and this becomes a second, redundant ingest path
for tokens while the GET assertion stays green.

**AND THE INTEGRATION CASE THAT JUSTIFIES THE ROUTE ASSERTS THE BLOCKER, NOT
THE FEATURE.** "exists because POST /v1/runs refuses a session" posts a real
bundle with a real session and requires 400 PROJECT_REQUIRED. If that ever
starts working, this route is duplicate surface and somebody is told — which a
comment saying the same thing would not do.

**202 IS A DIFFERENT SHAPE FROM 200, AND `waitMs: 0` MAKES IT THE ONLY ONE THE
BROWSER EVER SEES.** `respondWithRun` answers 202 with a PROCESSING run and
200/422 with a complete one; `run.ts` has branched on exactly that for its whole
life and says so in a comment. `uploadBundle` parsed every 2xx with
`RunResponseSchema` and reported "the server accepted the upload but returned a
run this page could not read" over a perfectly good 202 — on the status this
endpoint almost always returns, because the picker asks for `waitMs: 0`
deliberately rather than holding the request open for 25 seconds. **A "2xx path"
is not one shape; count them before writing one parse.**

**NOTHING IN THE e2e HARNESS PARSES A RUN THE BROWSER POSTS, AND THE FIRST
FAILURE READ AS A PRODUCT DEFECT.** No worker PROCESS runs anywhere in that
stack — compose brings up Postgres, Redis and MinIO, and `playwright.config.ts`'s
webServer starts the API alone — so every seed in `fixtures.ts` drives
`PipelineService` in-process, and `ingestAndProcess`'s own comment says why. A
run the BROWSER posts has no such caller: it sits at `pending` for ever while
the page goes on truthfully reporting that it is being parsed, and the report is
`bundle-done` never appearing. `parseUploadedRun` stands in exactly where the
seeds already stand in. The page is NOT told — it discovers the run finished
through its own polling, which is the transition the case exists to prove.

**A RED-VERIFY WHOSE ANCHOR ALSO MATCHES THE DOCSTRING MUTATES NOTHING AND
REPORTS A PASS.** Removing `@UseGuards(SessionOnlyGuard)` from the new
controller matched TWICE — the class docstring quotes the decorator to explain
why it is there — so the first attempt changed nothing and the suite came back
8/8 green. Third shape of "a red-verify that never reached the code reported a
pass" in this file; the other two were a mutation driven through a test that
does not call the helper, and a `git checkout` that restored the fix before the
run. What caught it was asserting the REPLACEMENT COUNT before writing, not the
result — the green suite was indistinguishable from a real pass.

**AND TWO MUTATIONS THAT FAIL THE SAME ASSERTION PROVE ONE THING, NOT TWO.**
Breaking the 202 parse and deleting the processing state both failed on
`bundle-processing` being visible, because it is asserted first — so the second
mutation demonstrated nothing the first had not. The one that pulls its weight
keeps processing and ALSO claims done at 202, which fails
`expect(bundle-done).toHaveCount(0)` with `Received: 1`. **A mutation that lands
on an assertion an earlier mutation already failed has not exercised the
assertion you were aiming at.**

**AND A NESTED `<details>` MADE A PASSING WEBKIT ASSERTION IMPOSSIBLE, WHICH
ONLY THE DISPATCHED CROSS-BROWSER RUN COULD SEE.** `gh workflow run ci.yml --ref
<branch>` before merging is recorded in this file as worth its fifteen minutes,
and this is the branch that proves it: the PR's own build was green and the
dispatch failed, deterministically, on both attempts, in a test this branch
changed — `project-tests.spec.ts`'s accordion case, WebKit only.

The card's curl moved behind its own `<details>`, so `upload-command` acquired
TWO disclosure ancestors: the nested one still open, the card's own closed by
the accordion. Measured after the click, identical DOM in all three engines:

```
  ancestors, innermost first   {name: null, open: true}, {name: add-results, open: false}
  element.checkVisibility()    false      false      false      <- the ENGINE's own answer
  playwright isVisible()       false      false      TRUE       <- chromium, firefox, WEBKIT
```

**WEBKIT ITSELF AGREES THE READER CANNOT SEE IT.** What disagrees is
playwright-core's `browserNameForWorkarounds === 'webkit'` branch, which
substitutes "has a closed `<details>` ancestor" for `checkVisibility()` and
reads only the NEAREST one — so an open nested disclosure masks the closed
ancestor above it. This file already records that substitution from the other
side (a `<details>` forced open by CSS reports hidden); this is the same branch
met through nesting, and it means `toBeHidden()` cannot be made to pass on
WebKit for an element behind two disclosures, however correct the page is.

The case asserts `toHaveJSProperty('open', false)` on the card AND polls the
element's own `checkVisibility()`. Both, because they are different claims: the
property is what the ACCORDION did, and `checkVisibility()` is what the reader
gets in the engine's own words rather than through the harness. The attribute
alone would pass against a stylesheet that kept a closed card's content on
screen. Red-verified by deleting the shared `name`, which fails both halves on
chromium and webkit alike — where the old spelling could not even pass on
WebKit when the product was right.

**AND THE STATUS PALETTE IS STILL NOT A UTILITY, WHICH ONLY THE TOKEN GUARD
SAW.** `BundleUpload` reached for `text-[var(--color-status-failed)]` and
`bg-[var(--color-accent)]`; `tokens.test.ts` fails any `[var(--…)]` utility
outside four named exemptions, and its own docstring argues the list should
SHRINK. The accent has a real published utility (`bg-accent`); the status
colours deliberately have none, and the sanctioned spelling is an inline
`style={{ color: 'var(--color-status-failed)' }}` with the reason attached —
`TimeBrush`'s window error reaches the same token the same way. Neither would
have been visible on screen: `bg-accent` and the arbitrary form paint
identically, and a `text-status-failed` utility would have emitted nothing at
all.

The review-m15-error-request-filter branch (M15's remainder — the finding is
closed) added ONE unit file — `apps/web/test/errorRequestFilter.test.ts` (5) —
from a floor of 151 / 1855 to **152 / 1860**, and its **e2e rises to 139**. Its
integration floor moves with it (that file is a `.ts` integration runs too).

**"WHEN MAPPINGS ARE AVAILABLE" — THEY ALWAYS WERE, AND THE WHOLE STACK ALREADY
CARRIED THEM.** M15's remainder was left on that conditional. Measured, every
layer but the caller already supported it:

```
  run_error           scope + name columns, unique on (runId, scope, name, …)
  the engine          writes a row per (scope, name)
  GET …/errors        takes ?scope= & ?name=, defaulting to run
  errorsQuery(id,…)   already has the (scope, name) signature and cache key
  RunErrorsTab        asked for run scope, always
```

Confirmed against real rows rather than inferred: the same failure is stored
twice, once as `run | (empty)` and once as `request | Cart/Add To Cart`. **This
is the run list's lesson exactly — "the list was already fetching what it
needed and throwing it away" — one tab over**, and it is why a finding parked
on a data dependency was worth re-checking rather than trusting the note.

**ONLY THE REQUESTS THAT FAILED ARE OFFERED, AND THAT IS THE DESIGN DECISION.**
The obvious list is every request the run made; on the reference run that is
seven, five of which have no errors. Choosing one of those spends the reader's
decision to land them on an empty table. Filtered to `koCount > 0` the list is
two — and the LIST ITSELF answers "which request do I investigate" before
anything is selected, which is more than a filter usually manages.

**IN THE URL, FOR THE REASON `RunCompare` RECORDS.** A link to "the errors for
Place Order" that opens showing every request's errors has dropped the question
and kept only the page. `replace: true`, because narrowing refines a view
rather than being somewhere to go Back to.

**AND THE OPTION LIST IS WHOLE-RUN WHILE A WINDOW IS SELECTED, DELIBERATELY.**
`statsQuery(runId, null)`, not `window`: `/v1/runs/:id/errors` takes no
`from`/`to` — that handler's own comment says so and `ErrorsTable` carries a
notice about it — so the rows this filter narrows are always whole-run. A
windowed option list would pick requests on one basis and filter rows on
another, and a request could vanish from the list while its errors were still
in the table.

**`scopeLabel` WAS ALREADY WAITING FOR A SECOND CALLER.** The drilldown-window
branch added it so `RequestDetail` could not say "no errors were recorded for
this run" over a request-scoped empty result. A filtered Errors tab is exactly
that shape again, and the prop needed nothing new.

**RED-VERIFIED AT BOTH LAYERS, AND THEY CATCH DIFFERENT THINGS.** Pinning the
query to run scope while the control still rewrites the URL fails the e2e on
ROW COUNT — a filter that changes the address bar and returns the same rows is
the failure worth catching, and "the select has options" would miss it.
Dropping the `koCount` guard fails 2 of the 5 unit cases AND the e2e's option
list. **The unit file proves the rule from a payload it writes itself, so it
proves nothing about the seam** — that is what the browser case is for, which
is the "a test that supplies both sides of a join proves neither" lesson this
file already records for M13.

The review-m17-chart-groups branch (M17, PART TWO — the finding is closed)
added no unit FILE and no unit case — unit stays 151 / 1855 — and its **e2e
rises to 138**. Integration is unchanged. It takes the half the M17 entry below
recorded as deliberately left.

**THE GROUPS WERE ALREADY IN THE ORDER, WHICH IS WHY THIS WAS CHEAP.** The
run-page reading-order branch established the sequence as WHAT WAS APPLIED,
WHAT GOT THROUGH, WHAT IT COST, and wrote that in a comment. Those are the
first three headings. The reading order is unchanged and the headings only name
what was already true — which is why "it is a layout decision rather than a
correction" turned out to overstate the cost.

**AND THE NAMES ARE THE CHARTS' OWN.** All four response-time figures literally
begin "Response time" — percentiles over time, ranges, distribution,
percentiles distribution. A grouping whose labels are lifted from the titles
under them is a fact about the page, not a taxonomy imposed on it.

**ONE FIGURE MOVED, AND THE GUARD IS WHAT MADE THAT SAFE.** `request-counts`
sat seventh, between `indicators` and `distribution`, which split the
response-time run in two. It is last now, under `Outcomes`. `CHART_IDS` is
asserted as a whole list precisely so a reorder cannot pass silently — updating
it deliberately IS that guard working rather than being worked around.

**THE TWO PROPERTIES THE OLD ORDER DEFENDED BOTH SURVIVE**, and they are why
`request-counts` moved rather than `percentiles`: the five charts sharing
`RUN_TIME`'s crosshair stay adjacent at 1-5, and the distribution pair stays
adjacent at 7-8.

**`<h3>` WAS TRIED FIRST AND THE PAGE SAID NO.** `Chart` renders every figure's
title as an `<h3>` at 15px, so a group heading at that level is a SIBLING of the
charts it contains — and at that size does not read as their parent either. The
failing assertion listed all nine chart titles beside the four group names,
which is how the collision was found. **A heading level is a containment claim,
and the only way to check it is to ask the rendered page.**

**SO THE GROUPS ARE `SectionHeading`'s `<h2>`, AND THEY REPLACE THE `sr-only`
<h2>Charts</h2>.** That heading existed for one stated reason —
`run-charts.spec.ts` records that `aria-label` alone never let a screen-reader
user navigating by heading reach the section. Four named, visible groups do
that job better than one invisible word, so keeping both would have left a
heading whose only purpose had been taken over. The section keeps `aria-label`
for its own name. **Only ONE assertion depended on it**, checked before
changing it; the tab names in `RunTabs.test.tsx` are tabs, not headings.

**THE TEST ASSERTS CONTAINMENT, NOT PRESENCE, AND THE RED-VERIFY IS WHY THAT
DISTINCTION IS IN IT.** Four headings above one undifferentiated grid is the
BEFORE state wearing labels, and a `toEqual` over heading text passes against
it. Two mutations, both red: flattening to one group fails on the heading list,
and SWAPPING two charts between groups — all four headings intact, all four
groups populated — fails on containment, naming the figure that went missing
from `Offered load`.

**AND AN EMPTY GROUP CANNOT BE BUILT, WHICH THE RED-VERIFY DISCOVERED BY
ACCIDENT.** The first attempt at that second mutation emptied `Outcomes`, and
`tsc` refused: `ChartGroup`'s `children` is required. A heading with nothing
under it is unrepresentable, so the swap is the only shape that mutation can
take.

**`[data-testid^="chart-"]` MATCHES THE DATA TABLES TOO.** Each chart renders a
`chart-data-<id>` table under the same prefix, so the loose selector returned
every figure followed by its own table. `figures()` in that file has guarded
the identical thing for years; the group-scoped query needed the same
`figure[...]` narrowing.

**AND THREE TESTS FAILED AT FIVE WORKERS AND PASSED AT TWO**, on a machine at
load 35 — the contention signature this file already documents. The tell was
`chart-data-concurrent-users` resolving to ZERO while the same test passed
alone in 3.8s. Re-run constrained before believing an e2e failure that looks
like missing data.

The runner-cannot-write-its-volumes branch added no unit FILE, no unit case and
no spec — its diff is one `install -d` line, one CI step and a README note — so
unit stays 151 / 1855, e2e stays 137 and integration is unchanged. It is the
FIRST product defect this deployment review found, and it took executing a real
Gatling job to find it.

**THE ON-PREM RUNNER COULD NEVER EXECUTE A SINGLE JOB.** It starts,
authenticates, polls, CLAIMS the job and OPENS a live run — then dies on

```
EACCES: permission denied, mkdir '/var/lib/perfportal/runner-work/<jobId>'
```

so the platform records a run that can never produce a byte.

**TWO DEFENSIBLE HALVES THAT CONTRADICT EACH OTHER.** `infra/Dockerfile` created
those directories `-o perfportal` and set `USER perfportal`. `docker-compose.yml`
overrides that service with `user: root` — it has to, because it spawns
simulations under uid 20001 and a non-root process cannot reliably carry
CAP_SETUID under `no-new-privileges` — and then `cap_drop: ['ALL']` with only
SETUID/SETGID added. **CAP_DAC_OVERRIDE is among the dropped**, and that is the
capability that lets root ignore file permissions. So root here is emphatically
not all-powerful: against `drwxr-xr-x perfportal perfportal` it gets the same
EACCES as anyone else.

**NOTHING IN ANY GATE COULD SEE IT.** The image builds, the container starts,
the runner authenticates and polls happily — the failure needs a job to exist.
The `compose` job built and ran the image and proved java and the Gatling
runtime are present, which is exactly the check that passes here. This is the
"every gate green and the feature never worked" shape this file already records
for `declaredTestSlug`, and it was found the same way: by running the real
thing end to end.

**WHO OWNS WHAT IS DECIDED BY WHO WRITES IT.** `runner-artifacts` is written by
the API, which runs as `perfportal`, and mounted `:ro` by the runner — it stays
`perfportal`. `runner-work` and `runner-logs` are the runner's own and are
`root` now. The `gatling` child still gets in the way it always did:
`makeChildWritable()` chmods the tree, and chmod is available to the OWNER
without DAC_OVERRIDE.

**AND DOCKER SEEDS A VOLUME'S OWNERSHIP ONCE, AT CREATION.** So an existing
deployment keeps the broken ownership through any number of image rebuilds and
goes on failing every job. Both volumes hold only per-job scratch, so the
upgrade note says to remove them — and says explicitly NOT to remove
`runner-artifacts`, which holds the uploaded jars.

**PROVEN BOTH WAYS BEFORE AND AFTER.** Reproduced deterministically (`mkdir` as
root inside the container → Permission denied), then the live volume was
chowned to root and the IDENTICAL job ran to completion: 62,691ms of real load,
895 requests / 872 ok / 23 ko, mean 228.4ms, p95 645.6ms, 14 rows across
run/request/group, and all three declared Gatling assertions decoded —
including the one the fixture makes fail on purpose (`Search: 95th percentile
… less than 100.0`, actual 1939.5ms).

**THE GUARD RUNS THE IMAGE UNDER THE RUNNER'S REAL CAPABILITY SET.** Asserting
ownership alone would pass against a future image that is root-owned for some
other reason; the second half does `--cap-drop ALL --cap-add SETUID --cap-add
SETGID` and writes both directories, which is the property that actually
matters.

**AND `docker cp` INTO THAT CONTAINER SILENTLY DOES NOTHING.** `/tmp` is a
`tmpfs` mount, and `docker cp` writes the container's layered filesystem, not
the mount — it reports success and the file is not there. Pipe through the
container's own shell (`docker exec -i … sh -c 'cat > /path'`) instead.

The onprem-deploy-gaps branch added no unit FILE, no unit case and no spec —
its diff is two READMEs and one new `infra/.env.example` — so unit stays
151 / 1855, e2e stays 137 and integration is unchanged. It comes out of
deploying the `onprem` profile from scratch as a newcomer would, and then
exercising the running platform.

**A FRESH ONPREM DEPLOYMENT HAD NOBODY WHO COULD SIGN IN, AND NOTHING SAID
SO.** `docker compose --profile onprem up --build` brings up a correct,
healthy platform with **no org, no project, no API token and no account**. The
migrations create the schema and stop; there is no admin API and no seed data,
so the login page refuses every address. Every bootstrap instruction in
`infra/README.md` is a HOST `pnpm` command requiring `pnpm install` and
`pnpm build` on the machine — which a deployer who has only ever run
`docker compose` does not have — and the root README's "Deploying it" section
never mentioned creating a first user at all.

The capability was always there: `infra/Dockerfile` runs `pnpm build`, so the
image already contains `dist/scripts/bootstrap.js`. Only the instruction was
missing. `docker compose run --rm migrate pnpm bootstrap …` is the vehicle —
that service carries the same image and the same `&app_env` anchor, and does
not need the API up. **Verified by running it against a real containerised
stack**: org, project, token and admin created, exit 0.

**AND THERE WAS NO `.env.example`**, so eight `PERFPORTAL_*` variables had to
be derived from prose across two files. Compose reads `infra/.env`
automatically for `-f infra/docker-compose.yml` — the project directory is the
one holding the compose file, NOT the repo root — which was **measured** with
every variable unset rather than assumed, because that distinction is exactly
the kind that is wrong half the time.

**THE RUNNER EXITING 1 ON A FIRST BOOT IS CORRECT, AND READS AS A FAILURE.**
`PERFPORTAL_RUNNER_ORG_ID` and `PERFPORTAL_RUNNER_PROJECT_ID` are UUIDs that do
not exist until bootstrap has run, so on the first `up` the runner is the one
service in `Exited (1)`, with `Missing required environment variable
RUNNER_ORG_ID`. Both docs now say to expect it. The ids are in bootstrap's own
output — an earlier draft of this entry sent the reader to `psql` for them,
which is two commands and a join for something already on screen.

**WHAT THE DEPLOYMENT AND THE PLATFORM WERE MEASURED AGAINST.** 25/25
deployment checks on the containerised stack (all seven services, the
public/protected split, all eight security headers, CSP carrying a script hash
and no `unsafe-inline`), 18/18 UI routes with ten plots drawn and zero console
errors, and the reference bundle's own numbers reproduced through the real
ingest path: **count 895, ko 24, mean 227.9ms, p95 658.6ms, error rate 2.68%**.
The LIVE streaming path produced the identical five numbers — two decoders, no
drift, which is the failure that entry further down calls the worst this
product can produce.

**AND EVERY FAILURE THE SWEEP REPORTED WAS THE HARNESS, NOT THE PRODUCT.**
`/statistics` for `/stats`; a rules POST missing the required `targetName`; a
telemetry batch carrying `runId`, which that endpoint rejects by design because
org and project come from the token; and a `422` on a healthy `close` that is
`statusFor`'s documented "complete, verdict failed" — the run had breached the
p95 gate authored two steps earlier. Four wrong claims, each killed by reading
the OpenAPI document or the source. **A gap report is a claim about the
system, so it has to be made by reading the system.**

**AND THE EXAMPLE GOT A GUARD, BECAUSE THIS DIRECTORY'S RULE IS THAT NOTHING
GOES IN WITHOUT ONE.** `.env.example` is the whole configuration surface a
deployer sees and is exactly the kind of file that rots: add a variable to the
compose file, forget the example, and the next deployer is back to deriving
settings from prose — the defect it was added to fix, returning silently.
Nothing else can see it, because a MISSING variable interpolates to empty and
`config --quiet` parses perfectly. `infra/test/env-example-covers-compose.mjs`
runs in the `compose` job against a fixture that is the real example with one
variable removed, so the guard is proven able to fail rather than assumed to
be. **The first version of its regex used `[A-Z_]` and truncated
`PERFPORTAL_S3_ACCESS_KEY` to `PERFPORTAL_S`** — reporting a variable that does
not exist while missing the two that do.

**`docker compose -f a -f b` APPENDS LIST VALUES.** An override file remapping
published ports ADDED them: postgres tried to bind 5433 and 55433, and failed
on the one already taken. `ports: !override [...]` replaces instead. Worth
knowing before concluding an override "did not apply".

The stall-evidence-both branch added no unit FILE, no unit case and no spec —
it changed one e2e helper and one config line — so unit stays 151 / 1855, e2e
stays 137 and integration is unchanged. It finishes the two things the entry
below left open, and both were red-verified side by side.

**THE `waitForURL` NOW REPORTS THE SAME FOUR CELLS AS THE `goto`.** That entry
argued "one phenomenon, two call sites" from a matching signature — a WebKit
timeout under Playwright's own `waiting for navigation until "load"`, 21.7s
failing against 5.1s on retry — while the counters wrapped only the first call.
It was an inference, and this makes it a measurement. Red-verified at the new
site, both cells reporting distinctly:

```
  the POST answers 401     EVERY REQUEST COMPLETED AND `load` NEVER ARRIVED.
                           issued 1, settled 1, outstanding 0; 10/10 probes
  the POST never answers   A REQUEST WAS STILL IN FLIGHT: …/auth/sign-in/email
                           (20004ms). issued 1, settled 0, outstanding 1
```

**THE TRACKER STARTS BEFORE THE CLICK, AND THAT IS NOT A STYLE CHOICE.** The
click is what issues the sign-in POST and whatever navigation follows, so
attaching after it races the exact requests the report is about — `click()`
resolves when the click is dispatched, not when its request completes. The
click sits inside the `try` only so the `finally` always reaches `stop()`; the
inner block re-throws a click failure untouched, so "after clicking Sign in" is
never printed over a failure where no click landed.

**AND `report()` IS READ BEFORE THE BODY TEXT.** Reading `body.innerText()` is a
round trip that can itself take seconds, and every one of those ages the
probe's "last answered" figure and lets more probes fire — a snapshot taken
after it describes the wrong moment.

**`trace: 'on-first-retry'` TRACED THE ATTEMPT THAT RECOVERED.** It records a
test RUNNING AS a retry, so for a flake whose retry passes it captures
precisely the run with nothing wrong in it. Proven by toggling the two settings
over one deliberately-failing test:

```
  on-first-retry           trace.zip under …-chromium-retry1   (the retry)
  retain-on-first-failure  trace.zip under …-chromium          (the failure)
```

Two cross-browser runs' worth of evidence for the navigation stall was
collected and discarded that way — an upload that worked, carrying a recording
of the wrong attempt.

**AND IT IS NOT FREE. MEASURED RATHER THAN WAVED AT**, interleaved A/B/A/B
against the Chromium suite on one machine so drift cancels:

```
  on-first-retry           55.2s, 52.3s   mean 53.8s
  retain-on-first-failure  66.0s, 72.0s   mean 69.0s
```

**~28%**, because every test is now recorded and most are then discarded. On
`e2e-cross-browser` (411 tests at `--workers=1`, 13.9-15.4 min) that is roughly
four minutes a run. There is no cheap version of this: capturing a first
failure means recording before you know it will fail. The trade is taken
deliberately, and the number is here so the next reader can re-take it rather
than rediscover the cost.

**THE STILL-OPEN QUESTION IS WHY `load` DOES NOT FIRE**, and there is a free
diagnostic left on the table that a trace is currently being paid for:
`page.on('domcontentloaded')` would say whether the document PARSED, which
splits "the response never finished being consumed" from "it parsed and `load`
alone went missing". Recorded as not done rather than done quietly.

The stall-started-counter branch added no unit FILE, no unit case and no spec
— it changed one e2e helper — so unit stays 151 / 1855, e2e stays 137 and
integration is unchanged. It is the SECOND diagnostic on the same stall,
because the first one's answer landed on the one branch it could not split.

**SIX STALLS IN ONE RUN, EVERY ONE OF THEM `(nothing)`.** The cross-browser run
dispatched on the branch below reported 408 passed / 3 skipped / 0 failed and
tripped the stall six times. All six printed `Still in flight at the stall:
(nothing)` — which RULES OUT both hung-request causes that probe was built to
separate.

```
             tests   stalls
  chromium     137      0
  firefox      137      6
  webkit       137      0
```

**AND THAT CORRECTS THE ENTRY BELOW.** It says the stall is "Firefox and WebKit
only ... though Chromium always runs first, so engine and elapsed time are
confounded by project order". WebKit ran a full 137 tests LAST — the latest
elapsed position in the run — and stalled zero times. So elapsed position is
not the driver, and the WebKit half of that claim now has a clean
counter-observation. Firefox alone, 6 of 137.

**`inFlight() === []` IS TWO CAUSES, AND THE MAP CANNOT TELL THEM APART.** It is
keyed by URL and deletes on completion, so a request that was issued and
FINISHED leaves no trace in it — byte-identical to one that was never issued at
all. A count of requests STARTED is what splits those, and the first version
kept none.

**AND A COUNT ALONE STILL LEAVES TWO CAUSES IN ONE CELL.** `issued === 0` is
true both when Firefox accepted the navigation and never acted on it, and when
the driver's connection to the browser was wedged — a wedged transport delivers
no `request` events either. Those accuse the product and the harness
respectively, so the branch also asks the BROWSER, on a path that has nothing
to do with the stuck page.

**`context.cookies()` IS THAT PATH, AND THE ROUND TRIP WAS MEASURED RATHER THAN
ASSUMED.** A cookie written by `document.cookie` INSIDE the page comes back
from it — which a driver-side cache could not know about — so it genuinely
queries the browser, at 15ms. It touches no execution context, which
`evaluate()` would, and a navigation destroys those. At one probe every two
seconds against a navigation that healthily takes ~60ms, the ordinary case
fires ZERO probes and pays nothing.

**THE FOUR CELLS ARE DISJOINT AND EACH ACCUSES SOMETHING DIFFERENT:**

```
  browser stopped answering     → the harness or the browser process
  a request still in flight     → the network or the server
  issued > 0, none outstanding  → everything arrived, `load` did not fire
  issued === 0, browser alive   → the navigation never left Firefox
```

**TWO CELLS RED-VERIFIED, TWO NOT MANUFACTURABLE — STATED RATHER THAN IMPLIED.**
A never-answering stylesheet gives `A REQUEST WAS STILL IN FLIGHT … issued 3,
settled 2, still outstanding 1; browser answered 9/9 probes`. A **204** on the
top-level navigation gives `EVERY REQUEST COMPLETED AND load NEVER ARRIVED …
issued 1, settled 1, still outstanding 0` — a 204 means "stay where you are",
so the request settles and no navigation ever commits. The other two cannot be
staged: a wedged transport would have to be manufactured, and `issued === 0`
against a live browser IS the hypothesis under investigation. **If it could be
produced on demand the cause would already be known.**

What that `9/9` does prove is the machinery BOTH unreachable cells depend on:
the probe fires every two seconds through a real 20-second stall, round-trips,
and is counted.

**AND THE ANSWER CAME BACK ON THE FIRST RUN THAT CARRIED IT.** Two stalls, both
identical, and it is the one sentence nothing before could express:

```
  EVERY REQUEST COMPLETED AND `load` NEVER ARRIVED.
  requests issued 5, settled 5, still outstanding 0;
  browser answered 9/9 probes, last 1982ms ago.
```

Five issued, five settled, none outstanding, and the browser answering a probe
every two seconds throughout. **Nothing hung, nothing was dropped, and the
browser was never wedged.** `page.goto` resolves on `load`, so it sat out the
full twenty seconds on a page that was, by every network measure available,
already finished. The remaining question is much narrower than the one this
started with: not "what is stuck" but "why does `load` not fire on a document
whose every request has completed".

**AND THE `waitForURL` FAILURE IS THE SAME THING, WHICH MEANS THESE WERE NEVER
TWO BUGS.** The same run's one flaky test — `[webkit] run-charts.spec.ts:905`
— failed at `signIn`'s NEXT line with `page.waitForURL: Timeout 20000ms
exceeded` under Playwright's own `waiting for navigation until "load"`. Same
wait, same twenty seconds, same instant recovery (21.7s failing, 5.1s on
retry). The entry below separates "seven in this navigation, one in the
`waitForURL` below" as if the second were a curiosity. One phenomenon, two call
sites — **and the counters wrap only the `goto`, so that is MEASURED on one
side and INFERRED on the other.** Wrapping the second is the next thing to do.

**WHICH ALSO MEANS "FIREFOX ALONE", WRITTEN FOUR PARAGRAPHS UP, IS TOO STRONG.**
What is Firefox-only is this `goto` — 8 occurrences across two runs, zero on
Chromium or WebKit in 137 tests each. The waitForURL variety landed on WebKit.
If they are one phenomenon the engine split is about which CALL absorbs it, not
about which engine has the defect.

**AND THE ARTIFACT UPLOAD BELOW DOES EARN ITS KEEP — THE OPPOSITE OF WHAT THIS
ENTRY FIRST CLAIMED.** It was written up as contributing nothing and being
structurally unable to, on the evidence of a run where it reported `No files
were found with the provided path: test-results/`. That was true of a run in
which NOTHING retried. The moment something did, it uploaded 471,774 bytes and
a real trace. **A step that finds nothing when there is nothing to find has not
been shown to be useless**, and one clean run is not evidence about it.

**BUT `trace: 'on-first-retry'` CAPTURES THE WRONG ATTEMPT.** The archive holds
exactly one `trace.zip` and it is under `…-webkit-retry1/` — the attempt that
PASSED. The attempt that failed left only an `error-context.md`. That option
traces a test that is RUNNING AS a retry, which for a flake whose retry
succeeds is precisely the run with nothing in it. `retain-on-failure` is what
keeps the failing attempt's trace. So the evidence path has been half-built
twice now: first an upload with no traces to carry, and now a trace of the
wrong attempt.

**AND `playwright.config.ts` IS AT THE REPO ROOT, SO A FILTERED EXEC LOADS NO
CONFIG.** `pnpm --filter @perfportal/web exec playwright test` answers
`Project(s) "chromium" not found. Available projects: ""` — not a missing
`PERFPORTAL_E2E_BROWSERS` (the trap recorded further down) but no config file
at all. Run it from the root, the way `test:e2e` does.

The diagnose-navigation-stall branch added no unit FILE, no unit case and no
spec — it changed one e2e helper and one CI step — so unit stays 151 / 1855,
e2e stays 137 and integration is unchanged. **It does not fix the stall. It
gives the stall the evidence it has never had.**

**CI HAS BEEN PRODUCING A FULL TRACE OF EVERY ONE OF THESE AND DELETING IT.**
`playwright.config.ts` sets `trace: 'on-first-retry'`, so each retried test
writes a network waterfall, console log and DOM snapshots into
`test-results/`. The `e2e-cross-browser` job uploaded NO artifacts — the only
one in those runs is `perfportal-agent`, the Go binary — so the runner threw
every trace away with the job.

That is the whole reason this went undiagnosed: it reproduces on no developer
machine here (180 real-app navigations with idle gaps, 0 failures; 75 against a
bare server at Node's default `keepAliveTimeout`, 0 failures), and the one
place it DOES reproduce was discarding the evidence every time. **Before
concluding a CI-only failure is unreproducible, check whether CI is keeping
what it already collects.**

**AND `if: failure()` WOULD HAVE BEEN THE WRONG CONDITION.** A retried test
does not fail the job — that is the entire point of the mitigation merged
before this — so the upload is `if: always()`. An artifact step gated on
failure would keep traces for exactly the runs that no longer happen.

**`page.goto` RESOLVES ON `load`, AND THAT CONFLATES THREE CAUSES.** `load`
waits for the document AND every subresource it references — for `/login`, one
JS bundle, one stylesheet, and the faces that stylesheet pulls. So a timeout
can mean:

```
  the DOCUMENT still in flight   → the connection never answered
  a SUBRESOURCE still in flight  → that one file hung, and `load` waited
  NOTHING in flight              → never issued, or all finished and no `load`
```

Playwright's error names none of them. `trackRequests` in `helpers.ts` now
reports what was outstanding at the moment the navigation gave up, so the next
stall says which of the three it is. Red-verified by stalling the stylesheet
past `navigationTimeout`, which printed exactly:

```
  Still in flight at the stall: http://localhost:3000/assets/index-Dm1AiGCk.css (19844ms)
```

**WHAT IS STILL NOT KNOWN.** The cause. It is Firefox and WebKit only, never
Chromium in any run sampled, and Chromium always runs FIRST so engine and
elapsed time are confounded by project order — though the first Firefox
occurrence four tests into its own block rules out "late in a long run". It hit
4 of 6 sampled runs. The mitigation merged earlier absorbs it (405 passed, 0
flaky, two stalls absorbed), so the cost is now seconds rather than a minute
charged to an innocent spec — but nothing here explains it, and this entry
should not be read as though it did.

The skeleton-column-counts branch added no unit FILE and 1 case to
`apps/web/test/payload.test.tsx`, from a floor of 151 / 1854. Integration and
**e2e are UNCHANGED** (e2e stays 137). It closes the last item the
resilience-first-pass entry left open: "FIVE `SkeletonTable` call sites; only
the run list's has been measured against its real table."

**MEASURED, ALL FIVE:**

```
  call site        declares   the table it stands in for
  RunList            9 : 8    9 / 8      correct (derived, already fixed)
  ProjectTests         4      4 <th>     CORRECT
  TestRuns             6      8          wrong by two
  RunDetail (page)     6      9          wrong by three
  TableSection         6      3 OR 9     wrong, and not by a number
```

**`TableSection` IS THE FINDING, AND IT IS STRUCTURAL.** One hard-coded `6`
inside that component was shared by SIX sections — the run's statistics, three
separate errors tables, and the request and group drill-downs. `ErrorsTable`
has THREE columns and says so in its own docstring, so the placeholder was
DOUBLE the width of what replaced it on three of the six. **A number that has
to be right for six different tables is not a number, it is a caller's
question.**

**`columns` IS REQUIRED AND HAS NO DEFAULT, AND THAT PAID OFF IMMEDIATELY.**
This file already records the rule — a parameter whose wrong value is silent
must not have a default — and here `tsc` became the thing that found every call
site, including one in `payload.test.tsx` that nobody would have thought to
grep for. A default would have let the next section inherit a number wrong for
it, silently, which is precisely how the shared `6` survived.

**AND ONE OF THEM IS GENUINELY UNKNOWABLE, WHICH IS RECORDED RATHER THAN
FAKED.** `ScopedStatistics` builds its response-time columns with `columnsFor`
from the PAYLOAD's own percentile keys — the mechanism that lets a run carrying
p90 or p99.9 head its own columns — so the real count does not exist until the
request the skeleton is waiting for comes back, and the reader's own column
picker moves it again afterwards. `STATISTICS_SKELETON_COLUMNS` is the default
view's width (the eight default statistics plus the name column), named as an
ESTIMATE with its reasoning attached. Wrong for a customised reader; far closer
than a `6` that was wrong for everyone. **Where an exact answer cannot exist,
say so at the constant rather than picking a number that looks exact.**

**ONE ROW WAS OVERTURNED: `ProjectTests`' four is CORRECT.** Four `<th>`, four
declared. The gap list said four call sites were unmeasured, and measuring them
is what distinguishes the three that were wrong from the one that was already
right — which is the whole reason the sweep says "unmeasured" rather than
"wrong".

**AND THE FIRST INSTRUMENT WAS THE WRONG ONE, WHICH COST TEN MINUTES.** A
browser probe was written to count both the skeleton and the real table. It
queried `thead th` on the SKELETON — which is built from `div`s, as
`resilience.spec.ts`'s existing guard already knew (`locator('> div')`) — and
its table locator was unscoped, so it answered `real=9` for a four-column table
by matching the org-wide run list on the same page. **A column count is DOM
STRUCTURE, not geometry**, so jsdom answers it exactly and in seconds; a
browser is for what jsdom cannot see, and this was not that. The run list's own
guard is in e2e for a different reason — it also has to prove WHICH page draws
the skeleton.

The telemetry-window-empty branch added no unit FILE and 2 cases to
`apps/web/test/RunTelemetry.test.tsx`, from a floor of 151 / 1852, plus 1 e2e
case — so **e2e rises to 137**. Integration is UNCHANGED (a `.tsx` and a
`.spec.ts`, and `vitest.integration.config.ts` includes neither).

**M16's THIRD CLAUSE WAS ALREADY IMPLEMENTED, AND THE GAP WAS THAT NOTHING HAD
EVER RENDERED IT.** The finding asks to "keep selected-window emptiness
distinct from telemetry never recorded", and `RunTelemetry` already
distinguishes THREE states with a docstring arguing all three: `available:
false` gets the `EmptyState` and no figure; `available: true` with an empty
`hosts` is a narrower window and gets six `Undrawn` charts explaining
themselves; a host with points gets the real charts.

Every `hosts: []` fixture in that file pairs with `available: false`, so the
MIDDLE state had never been rendered by any test — and the e2e brush case
stays out of it deliberately, asserting the narrowed row count is `> 0`. **A
branch whose whole purpose is to prevent a false claim, reachable, correct,
and unwitnessed.**

**REACHABLE WAS MEASURED, NOT ASSUMED.** Against the real endpoint with a
seeded telemetry run, samples are 3s apart:

```
  whole run     available true   hosts 2   points 22
  ?from=0&to=4000    true        hosts 2   points 2
  ?from=1000&to=2000 true        hosts 0   points 0   <- the middle state
  ?from=500&to=900   true        hosts 0   points 0
```

`MetricsController.telemetry` computes `available` from the unfiltered series
and filters `hosts` afterwards, exactly as `RunTelemetry`'s docstring claims —
so the two really can disagree, and the claim was checked rather than trusted.

**THE e2e HALF IS THE ONE THAT PROVES THE SEAM.** A unit fixture supplies BOTH
`available: true` and `hosts: []`, so it can only prove the component renders
what it is handed. Whether the API ever produces that pair is a different
question, and the one the three-state design rests on — the "a test that writes
both sides of a join proves neither" lesson this file already records for M13's
Target link.

**AND BOTH WRONG ANSWERS ARE ASSERTED AGAINST, NOT JUST THE RIGHT ONE.** Six
drawn-but-empty charts would read as "measured and found idle", which is the
one claim `available` exists to rule out; the `EmptyState` would say the agent
never reported, which is false for a run that recorded plenty outside this
window. Red-verified by collapsing the branch (`if (hosts.length === 0)` to
`if (false)`), which fails both unit cases and the e2e.

**AND `findAllByRole('figure')` RESOLVED ON THE LOADING CHARTS.** `Payload`'s
own loading branch renders `Undrawn` too — this file says so eighty lines
further up — so six figures exist from first paint reading "Loading…", and the
query had not settled when the assertion ran. Await the SETTLED text, not the
container. Fourth time this session: `findByRole('main')` on a page whose two
states both render one, the skeleton locator that picked up another route's
table, and `.nth(3)` before them.

The trends-colliding-labels branch added no unit FILE and 2 cases to
`apps/web/test/transforms.trends.test.ts`, from a floor of 151 / 1850. Its
integration floor rises by the same 2 (that file is a `.ts` file integration
runs too) and **e2e stays 136**.

**THE FINDING WAS NOT THE ONE LOOKED FOR, AND THE ONE FOUND IS WORSE BECAUSE
IT LOOKS FINE.** The gap was recorded as "Trends legend label collisions".
Measured in a browser with twenty runs of one test — the endpoint's own default
`limit` — there is NO collision: ECharts hides alternate x-axis labels rather
than overprinting them, so ten of twenty were drawn and `overlaps` was zero.
Every one of those ten read **`08-07 11:00`**. A reader could not tell any run
from any other, and nothing on screen looked wrong.

**AND THE FIX ALREADY EXISTED, IN A FUNCTION WHOSE DOCSTRING NAMES THIS
CALLER.** `compareLabels` disambiguates colliding run labels with a short id
suffix, and says so: "`runMinuteLabel` owns the shape and the zone, and **the
trends axis draws its ticks with the same function**". So the module that
solved the problem knew this consumer existed, and this consumer called the
bare helper per run. Same shape as `ErrorsTable`'s `windowSelected`, passed at
two call sites of three. **When a helper exists to correct something, grep its
own docstring for who else it names.**

**THE FIXTURE MAKES IT TOTAL AND PRODUCTION MAKES IT PARTIAL — STATED RATHER
THAN ROUNDED UP.** `toolStartedAt` is when the LOAD TEST ran, read from the
simulation.log header, so re-ingesting one bundle gives every run the same
instant and that is what a seeded cohort does. A real cohort collides more
narrowly: runs sharing a minute — a nightly on a fixed schedule, a retried
pipeline, parallel shards. The fix is the same and costs the ordinary case
nothing, because `compareLabels` suffixes ONLY a label that collides.

**IT BUYS LEGIBILITY WITH TICKS, AND THAT IS A REAL COST.** Measured before and
after on the same cohort: 10 labels drawn at 63px each, all identical -> 5
drawn at 113px each, all distinct. Wider labels mean ECharts hides more of
them. Five ticks that identify a run beat ten that identify nothing, and a
non-colliding cohort keeps all ten — but the trade is recorded rather than
hidden.

**AND THE SECOND CASE IS THE ONE THAT KEEPS THE FIRST HONEST.** A cohort whose
runs are minutes apart must stay clean timestamps. Without it, "disambiguate"
could have meant putting an id on every tick of every trend in the product,
and the collision case alone would not have noticed.

**AND A PROCESS ERROR THAT DESTROYED THE WHOLE BRANCH — A NEW SHAPE OF ONE
THIS FILE ALREADY RECORDS.** The entry above says `git checkout -b` branches
from where you are standing. This was the version where **`-b` was never run at
all**: the investigation and both edits were made on the PREVIOUS finding's
branch, and `gh pr merge --delete-branch` on that PR then deleted the branch,
moved the working copy to `main`, and took the work with it.

**THE FLOOR COUNT WAS THE ONLY TELL.** The gate that followed reported
`151 / 1850` — green, and two tests short of the 1852 two new cases require. A
pass that is two below the floor reads exactly like a pass. It was recoverable
only because the checkpoint commit was still in the reflog
(`git checkout <sha> -- <paths>`). **Cut the branch before the first edit, not
before the first commit** — and the reason the floors in this file are worth
the trouble is that they are what catches a green run measuring the wrong tree.

The attribute-navigation-stalls branch added no unit FILE, no unit case and no
spec — it changed one config line and one e2e helper — so unit stays
151 / 1850, e2e stays 136 and integration is unchanged. It does NOT fix the
cross-browser flake; it makes the flake name itself.

**AND IT WAS EXERCISED ON `main` THE SAME DAY, WHICH IS THE EVIDENCE A CLEAN
RUN COULD NOT GIVE.** The first cross-browser run after it merged reported
**405 passed, 3 skipped, 0 failed, 0 flaky** — while absorbing TWO stalls:

```
  signIn: navigating to /login stalled (TimeoutError: page.goto: Timeout 20000ms exceeded.); retrying once.
  signIn: navigating to /login stalled (TimeoutError: page.goto: Timeout 20000ms exceeded.); retrying once.
```

Under the old behaviour those two would have surfaced as "2 flaky" naming
`run-charts.spec.ts` and `run-detail.spec.ts` — neither of which is involved —
and cost a minute each. The stall is therefore REAL and RECURRING, and only
the attribution was ever wrong. The cause is still unknown.

**8 OF 8 RETRIED TESTS ACROSS SIX `e2e-cross-browser` RUNS FAILED INSIDE
`signIn`** — seven in `page.goto('/login')`, one in the `waitForURL` after it.
Not one failed an assertion. The test NAME was simply whoever was running, so
six runs produced eight occurrences under eight DIFFERENT spec names, spread
across `auth`, `run-charts`, `run-detail`, `run-tables` and `run-telemetry`.

**THAT MISATTRIBUTION IS THE DEFECT THIS BRANCH FIXES.** CI reports
"[firefox] run-telemetry.spec.ts flaky" and the next reader opens a telemetry
chart that was never involved. It cost exactly that here — the whole
investigation was spent getting past the name before anyone read the logs, and
the thing was called "the Firefox flake" for a day on the strength of it.
**When one shared helper can fail, the report blames its callers**, and a
suite with eighteen callers of one `signIn` will name eighteen innocent specs.

**AND THE SIGNATURE IS WORTH RECOGNISING, BECAUSE IT IS NOT THE ONE THIS FILE
ALREADY RECORDS.** The integration flake documented above is "one test fails,
in a file the branch cannot reach, passing alone". This is different and has
its own tell:

```
  15:38:51  ✓ 232  run-detail.spec.ts:640              (1.1s)
  15:39:51  ✘ 233  run-detail.spec.ts:693 @1024x900    (1.0m)   <- stall
  15:39:56  ✓ 234  run-detail.spec.ts:693 @1024x900 retry (2.9s)
  15:39:58  ✓ 235  run-detail.spec.ts:693 @1280x800    (1.5s)
```

An isolated 1.0m against neighbours at 1-3s, and a retry four seconds later
that takes two. **The server was never unhealthy** — which is what rules out
the everything-is-broken shapes this file documents elsewhere.

**`navigationTimeout` IS 0 UNLESS YOU SET IT.** So a navigation that never
completes is bounded only by `timeout`, and burns the whole sixty seconds
before reporting. It is 20s now — measured against 180 navigations of this
app's own `/login` in Firefox and WebKit (median 58-68ms, p95 74-85ms, worst
374ms), so nothing legitimate is within fifty times of it.

**THE CAUSE IS NOT KNOWN, AND THE ENTRY SAYS SO RATHER THAN IMPLYING A FIX
FOUND IT.** Two experiments failed to reproduce it:

  - 180 navigations of the real `/login` in Firefox and WebKit, each after a
    deliberate idle gap of the shape a test's seeding creates: **0 failures**,
    worst 374ms.
  - 75 navigations against a bare `http.Server` left at Node's DEFAULT 5s
    `keepAliveTimeout`, idling 5.2s between each to provoke the classic
    HTTP/1.1 keep-alive race: **0 failures**, worst 51ms. That was the leading
    hypothesis — the API never sets `keepAliveTimeout` — and the probe killed
    it.

**AND THE FIRST READING OF THE DATA WAS WRONG IN A WAY WORTH RECORDING.** It
looked like "only after ~140 tests", which suggested accumulation in the
long-lived server. It is not: Chromium runs tests 1-136 and has never flaked,
and the first Firefox occurrence is **four tests into that engine's block**.
Chromium always runs FIRST, so "engine" and "elapsed time" are confounded by
the project order — and the test index is what separates them. **Check whether
the thing you are calling a trend is just the running order.**

**RETRYING A FAILED NAVIGATION IMMEDIATELY DOES NOT WORK, AND THE RED-VERIFY
IS THE ONLY REASON THAT IS KNOWN.** A navigation that has just failed is still
unwinding, and the second `goto` is rejected outright with `Navigation to
.../login is interrupted by another navigation to chrome-error://chromewebdata/`
— so the helper reported two stalls where there was one, and the case meant to
prove the retry works instead proved it did not. Half a second of settle fixes
it.

**AND A RED-VERIFY THAT NEVER REACHED THE CODE REPORTED A PASS, TWICE OVER.**
The mutation was driven through `auth.spec.ts`'s "signing in lands on the run
list" — which is the test OF signing in, and drives the form itself rather
than calling the `signIn` helper. So both mutations executed nothing and both
runs went green. **Pick the exercising test by grepping for the call, not by
its name**: the spec whose subject is X is the likeliest one not to use the
helper for X.

**AND `git checkout -- <file>` DESTROYED AN UNCOMMITTED FIX AGAIN — THE SAME
DAY THE LESSON WAS WRITTEN DOWN, IN THE ENTRY TWO ABOVE THIS ONE.** The
zoom-reflow branch recorded "commit the fix before mutating it, or restore
from a stash rather than from HEAD". This branch then red-verified an
uncommitted `reachLogin`, restored by checkout, and ran the mutation against a
helper that no longer contained the fix. The tell was the same both times: a
count in a status line, not a failure. **Writing a lesson down is not the same
as having it** — the cheap mechanical guard is to commit a checkpoint before
the first mutation, every time, and this file now records it twice for a
reason.

The zoom-reflow branch added no unit FILE, no unit case and no spec — it
WIDENED one existing e2e case from two pages to four — so unit stays
151 / 1850, e2e stays 136 and integration is unchanged. It closes what the
branch below recorded as measured-and-left.

**FOUR CAUSES, ONE SHAPE: A LENGTH THAT DOES NOT SCALE WITH THE READER'S TEXT,
OR A BREAKPOINT THAT ASKS THE VIEWPORT A QUESTION ONLY THE CONTENT CAN
ANSWER.** Measured at 1280 with a 32px root, document scrollWidth:

```
                   before   after
  SLA rules form     1280    1280
  Add results        1280    1280
  run list           1421    1280
  run page           1574    1280
```

  - the run list's filter grid held `<select>`s in FIXED **180px** tracks,
    behind `md:`
  - `HealthTile` laid value, label and detail in a flex row that could not wrap
  - the statistics toolbar put a 14rem input, its label and a button in one row
    behind `sm:`
  - `StatTile` put a `text-2xl` value beside its unit in an unwrapped row, six
    across, behind `xl:`

**AND NONE OF IT SHOWS AT 100%, WHICH IS THE WHOLE REASON IT SURVIVED.** A
fixed track and an unwrapped flex row do not CLIP when their content outgrows
them — they SPILL, and every ancestor with `overflow: visible` passes it up
until it reaches the document. So the page gains a horizontal scrollbar and the
component that caused it looks untouched.

**THE TYPE-SCALE BRANCH DID HALF OF THIS AND THE OTHER HALF WAS NEVER OBVIOUS.**
That one converted 223 absolute-px type utilities to rem so text would answer
to the reader's own font size. **The boxes around the text had to follow**, and
nothing said so: a rem string inside a px track is exactly as broken as a px
string was, one layer out.

**`@container` ASKS THE ONLY QUESTION THAT SURVIVES A FONT CHANGE.** Tailwind's
container thresholds are in rem, so `@2xl` is 672px at a 16px root and 1344px
at 32px — the switch point scales with the text it is gating. A viewport
breakpoint cannot: `md:` is 768px whatever size the reader has chosen. This is
`RunDecisionBand`'s lesson (it went three-up at `lg:`, which is also where the
rail appears, so it took its widest layout at the moment it lost ~270px) with
the second reason attached.

**AND A CONTAINER QUERY CANNOT QUERY THE ELEMENT THAT DECLARES THE CONTEXT.**
`@container` and `@5xl:grid-cols-6` were put on the same `<dl>` first. The
variant then never matches — silently, with no warning and no error — so the
tiles fell to two columns at EVERY width. What caught it was not the zoom test
but `run-tables.spec.ts`'s M01 geometry bound: two columns made the block tall
enough to push the run totals past 900px. **A layout guard written for one
finding caught a different one three branches later**, which is the argument
for bounds over snapshots.

**THE FIRST DIAGNOSIS WAS WRONG AND THE PROBE THAT PRODUCED IT IS THE REASON.**
Listing every element whose `getBoundingClientRect().right` exceeds the
viewport names `RunTabs` first — and `RunTabs` already carries
`overflow-x-auto`. **Content inside a working scroller legitimately reports a
rect past the viewport.** The probe that actually works skips an element when
any ancestor establishes a horizontal scroll context whose OWN right edge is
inside the viewport, and reports only the outermost remaining offenders. Even
then it keeps a false positive — the time brush's ECharts container still
reports a wide rect while the document measures 1280 — so
`documentElement.scrollWidth` stays the arbiter and the element list is a lead,
never a verdict.

**AND `git checkout -- <file>` DESTROYS AN UNCOMMITTED FIX WHEN THE RED-VERIFY
MUTATES THE FILE YOU ARE FIXING.** Every earlier red-verify in this review
mutated a SOURCE file while the change under test was in a TEST file, so
restoring by checkout was safe and became a habit. Here the mutation target was
the fix itself: two of the four fixes were silently reverted to HEAD, and the
tell was a stray count in a status line rather than any failure. **Commit the
fix before mutating it**, or restore from a stash rather than from HEAD.

The a11y-untested-promises branch added FOUR unit files —
`apps/web/test/States.test.tsx` (5), `AuthGate.test.tsx` (5),
`SignOutButton.test.tsx` (4) and `Login.test.tsx` (4) — plus 2 cases each to
`ChartActions.test.tsx` and `ProjectRail.test.tsx`, from a floor of 147 / 1828.
Integration is UNCHANGED (every new file is a `.tsx`, which that config never
runs) and its **e2e rises to 136** (`acceptance.spec.ts`).

**FOUR COMPONENTS ON EVERY PAGE HAD NO TEST FILE AT ALL**, which is the
`TableFrame` precedent exactly — a component six tables shared acquired an
`aria-hidden` over an interactive `<summary>` and kept it through two reviews,
because nothing was reading it. `States` is imported by SEVENTEEN modules,
`AuthGate` renders on the way into every authenticated route, `Login` is the
one page a signed-out visitor sees and `SignOutButton` is in the header of all
of them. **Grep for components with no test file before looking for untested
BEHAVIOUR** — the second search is harder and the first one found more.

**AND EVERY CLAIM WORTH PINNING IN THEM TURNED OUT TO BE AN ACCESSIBILITY
CLAIM, WHICH IS NOT A COINCIDENCE.** What these components decide is how a page
INTERRUPTS somebody — alert against status, what a live region wraps, when a
label is announced — and that is invisible to every assertion about the words
on screen. Some examples, each argued at length in its own docstring and
checked by nothing:

  - **`ErrorState` is an alert and `EmptyState` is not.** "This project has no
    runs" is the ANSWER, not a failure, and announcing it as an interruption is
    wrong. Asserted as an exclusive pair: a file that made every state an alert
    satisfies "the error is an alert" perfectly.
  - **An assertive live region must never wrap a heading or a landmark.**
    `AuthGate`'s outage page states this as a general rule. An explicit role
    OVERRIDES an element's implicit one, so `<main role="alert">` is a page
    with no main landmark at all, on the page where a reader has the least
    other structure to navigate by. Red-verified: that one mutation fails three
    cases.
  - **`ProjectRail`'s live region is mounted before it has anything to say.** A
    screen reader announces a region's CHANGES; one that arrives already
    holding its message has not changed, it was inserted. The refactor that
    breaks this is the tidier-looking one — hoist `message != null` onto the
    wrapper, delete an always-empty div, change nothing on screen, and silence
    every projects-failed announcement for ever. The guard is asserted in the
    state with NOTHING to announce, because that is the only state that can
    tell the two spellings apart.

**M17 CLAIMED A KEYBOARD PROMISE AND ONLY THE OLDER MENU WAS EVER CHECKED.**
That branch chose `role="menu"` on the argument that `AccountMenu` is a real
one and `ThemeToggle` earned this repo the lesson that half-keeping a role is
worse than not claiming it. `AccountMenu.test.tsx` checks arrow keys and focus
return; `ChartActions.test.tsx` checked neither, on the menu that was ADDED to
satisfy the finding. Both are pinned now, in jsdom and in a browser, and both
were red-verified — Radix's own `onCloseAutoFocus={(e) => e.preventDefault()}`
is the exact opt-out that breaks focus return, which makes it the cleanest
mutation available for that class of claim.

**200% TEXT ZOOM: TWO PAGES OF FOUR PUSH THE DOCUMENT SIDEWAYS, MEASURED AND
DELIBERATELY NOT ASSERTED — AND FIXED BY THE BRANCH ABOVE, which also shows the
diagnosis below to have been looking at the wrong element.** At 1280 with a 32px root:

```
  SLA rules form      1280 of 1280   fits
  Add results         1280 of 1280   fits
  run list            1421 of 1280   OVERFLOWS
  run page            1574 of 1280   OVERFLOWS
```

The two that pass are pinned; the two that fail are recorded. A threshold set
to the goal rather than the measurement is a failing test describing work
nobody has agreed to do — the discipline M01's geometry bound already set.

**AND THE OBVIOUS DIAGNOSIS OF THAT OVERFLOW IS WRONG, WHICH IS WORTH THE
WARNING.** Listing every element whose `getBoundingClientRect().right` exceeds
the viewport names `RunTabs`' links first — and `RunTabs` already carries
`overflow-x-auto`. **Content inside a working scroller legitimately reports a
rect past the viewport**, so "which element sticks out" and "which element
widens the document" are different questions and the first one's answer
misleads. Left undiagnosed rather than guessed at.

**TWO MOCK TRAPS, BOTH OF WHICH REPORTED THE WRONG THING.** A partial
`vi.mock` of `api/session` left `AuthError` undefined, so `Login`'s
`err instanceof AuthError` threw INSIDE its own catch block, the error state
was never set, and two cases failed with "unable to find role=alert" —
pointing at markup that was fine. `importOriginal` is the fix, the same
spelling `ChartActions.test.tsx` already uses to keep `toCsv` real. And
`AuthError` takes `(code, message)`: passing the message first left the alert
rendering an empty string, which reads as a broken component rather than a
broken fixture. **A partial module mock is the malformed-fixture trap one layer
up — it removes an export the component needs, silently.**

**AND `exact: true` IS NOT A `getByRole` OPTION, WHICH ONLY `tsc` SAW.**
`getByRole(role, { name })` is already EXACT in Testing Library and a
case-insensitive SUBSTRING in Playwright — this file records that distinction
two sections down, and the way it bites is copying the e2e spelling into a
jsdom test, where `exact` is not a `ByRoleOptions` member at all. The suite
passed 4 of 4; `tsc` answered TS2769. **Fifth time this file records that the
gate's FIRST command is the only thing that sees a test built wrong**, and the
first time it was a query option rather than a constructed prop.

**AND A `findBy` THAT NAMES SOMETHING BOTH STATES RENDER RESOLVES ON THE WRONG
ONE.** `AuthGate`'s outage cases awaited `findByRole('main')` — and
`Bootstrapping` renders a `<main>` too, so the wait returned on the page BEFORE
the one under test and the alert had not been drawn. Await the element unique
to the state you mean. Third time this session: the skeleton locator that
picked up another route's table, and the `.nth(3)` status cell before it.

The compare-cap-race branch added no unit FILE, no unit case and no spec — it
rewrote ONE existing e2e case — so unit stays 147 / 1828, e2e stays 134 and
integration is unchanged.

**`count()`, `getAttribute()` AND `isDisabled()` ARE IMMEDIATE READS WITH NO
AUTO-WAITING.** Only `expect()` and an action's own actionability check retry.
`run-compare.spec.ts`'s cap case used all three to decide its next move:

```
for (let i = 0; (await pressed().count()) < 5 && i < 6; i += 1) {
  const chip = chips.nth(i);
  if ((await chip.getAttribute('aria-pressed')) === 'true') continue;
  if (await chip.isDisabled()) continue;
  await chip.click();
}
```

Every one of those can answer from a DOM React has not committed yet — and the
state being raced is the one this test exists to reach. At the cap EVERY
unselected chip takes `disabled` (`RunCompare`: `atCap = !on && selected.length
>= MAX_COMPARE`), so a stale-low count sends the loop to click a chip that is
already refusing, and `click()` then waits out the test's entire 60s deadline.
**The report therefore names a timeout and no assertion**, which is the same
shape this file already teaches you to read as infrastructure — and this time
it was a real defect in the test. Three times in one day: `main`'s
cross-browser run, #139's build, #140's build, all chromium.

**A LOAD-DEPENDENT FLAKE CAN BE MADE DETERMINISTIC, AND THAT IS WORTH THE TEN
MINUTES.** Throttling the renderer through CDP —
`newCDPSession(page)` then `Emulation.setCPUThrottlingRate` at 12x — widens the
uncommitted window until the race is certain. The original loop then failed on
the FIRST attempt with CI's exact signature (`element is not enabled`, at
`chip.click()`); the rewrite passed 3 of 3 under the identical throttle, at
5.5-6.5s. **Reach for that before concluding a timeout with no failing
assertion is the machine** — it turns "I reasoned about the race" into "I
watched it".

**AND ASSERTING THE STARTING STATE FOUND A FALSE COMMENT THAT HAD OUTLIVED THE
TEST.** That loop ran until the count reached five from WHATEVER it found, so
it was indifferent to where it started; the comment above it said "the run the
page was opened from is always in and always disabled, so four more reach
five". The rewrite asserts the starting count and failed 9 of 9: it is **TWO**,
not one. `parseCompareSelection` prepends the current run to
`defaultSelection`, which answers with its NEAREST NEIGHBOUR — deliberately, so
Compare never opens having answered nothing (that function's own docstring
argues it at length). Only the run you came from is `disabled`; the neighbour
is selected and can be dropped. **A test indifferent to its own starting state
cannot notice when that state stops matching the sentence above it**, and this
one had been wrong since it was written.

Both selectors are attribute selectors on the chip ITSELF
(`[aria-pressed="false"]:not([disabled])`), never `filter()`, for the reason
the compare-cap entry already records: `filter` matches DESCENDANTS.

The webkit-chart-table-budget branch added no unit FILE, no unit case and no
spec — it rewrote ONE existing e2e case — so unit stays 147 / 1828, e2e stays
134 and integration is unchanged. It takes a failure that had been red on
`main` for eight consecutive merges.

**`e2e-cross-browser` RUNS ON `main` AND ON DEMAND, SO A PULL REQUEST'S GREEN
IS STRUCTURALLY BLIND TO IT.** `ci.yml` gates that job on
`github.event_name == 'push' || workflow_dispatch`, and `push` is restricted to
`main` — deliberately, to stop every PR paying 15 minutes for three engines.
The consequence is the part nobody had written down: the signal read before
each merge is `pnpm test:e2e`, which is **Chromium alone**, so a WebKit defect
lands and then fails on the merge commit, where nothing is watching. It went
red at #126 and was merged over seven more times — #127, #128, #129, #133,
#135, #136, #138 — each PR green, each merge run red on the same single case.

**THE GREEN MERGES IN BETWEEN ARE NOT EVIDENCE EITHER.** #130, #131, #132, #134
and #137 passed with the same defect present; three engines at `--workers=1`
simply finished that case inside its budget those days. **A job that only runs
after the merge needs somebody to read it after the merge** — or a
`workflow_dispatch` before it:

```
gh workflow run ci.yml --ref <branch>      # the cross-browser run, on demand
```

**THE CASE WAS ALREADY THE WORST IN ITS FILE ON WEBKIT, AND NOBODY HAD
LOOKED.** Measured on the last green run, WebKit against Chromium for the same
test, all 23 cases of `run-charts.spec.ts`:

```
  10.4x   every chart's data table is reachable by its own toggle
   5.5x   deselecting every band explains itself
   5.0x   the selected window survives moving between run tabs
   ...
   1.8x   brushing recomputes the statistics
```

Everything else sits near 2x. This one was **15.6s against Chromium's 1.5s**,
and it is the only case in the file that hides and shows a chart canvas
repeatedly — nine charts, two toggles each. `Chart` swaps the plot for the
table with `hidden` rather than unmounting (its own comment says why, and the
reasoning is good), so **every toggle is a full ECharts re-layout**: the 0x0
box a `display: none` canvas reports is answered by the instance's own
ResizeObserver, twice per chart.

**SO IT WAS ALREADY AT THE EDGE AND THREE THINGS PUSHED IT OVER.** M17's
overflow menu added a portalled open per toggle, CI's runners got **~1.65x
slower** across the board (measured as the median slowdown of the 22 sibling
cases in the same file, chromium 1.59x / firefox 1.75x), and the case stopped
finishing inside the 60s test budget at all. It is a BUDGET OVERRUN rather than
a broken product: the menu works, and the failure lands on a different chart
each run, because what expires is the test's deadline and not any one click.

**THE FIX IS TO STOP ASSERTING A SHARED MECHANISM NINE TIMES, AND THE LICENCE
FOR THAT IS IN THE SOURCE.** `Chart` holds the only `<ChartActions>` call site
in the app, and builds that item's `aria-controls` from the same `id` the
figure is named after, beside an `onToggleTable` that flips a boolean and takes
no id at all. A chart whose menu item
names the right table therefore CANNOT toggle a different one. So the
relationship stays per chart (nine menus opened, nine `aria-controls` read,
nothing toggled) and the round trip runs once. Measured after, locally, on a
machine at 94% swap: chromium 2.2s, firefox 3.2s, webkit 4.0s.

**AND CI THEN CORRECTED TWO THINGS ABOUT THAT, WHICH IS WHY THE DISPATCH IS
WORTH ITS FIFTEEN MINUTES.** The dispatched cross-browser run (397 passed)
measured **webkit 18.9s against chromium 2.0s**, and the last green `main` run
before the fix measured **35.9s against 3.5s**. So:

  - **WEBKIT ON THE LINUX RUNNER IS NOT WEBKIT ON THIS MAC.** Chromium and
    Firefox agreed within about 10% across the two machines; WebKit did not, at
    4.0s here against 18.9s there. A local WebKit timing is not evidence about
    CI, and the first draft of this entry read "back to 1.8x Chromium, which is
    the pack" on the strength of one.
  - **THE RATIO DID NOT MOVE — 10.4x before the menu, 10.3x on the last green
    `main`, 9.5x now.** What halved is the absolute time, because the test does
    about half the interactions. So the re-layout was A cost and not THE cause:
    WebKit is roughly ten times Chromium at BOTH things this test does many
    times over, an ECharts re-layout AND a Radix portal open. Backed out of the
    three runs, on WebKit: ~0.76s per re-layout, ~1.4s per menu open.

The honest statement is the plain one: **this is the most interaction-dense
case in the file, WebKit charges about 10x per interaction, and the only lever
is doing fewer of them.** 35.9s to 18.9s against a 60s budget, ratio untouched.

**AND IT WAS NEVER DETERMINISTIC, WHICH THE FIRST DRAFT ALSO IMPLIED.** There
is no race — nothing in the product or the test logic is nondeterministic — but
35.9s of a 60s budget is a MARGINAL one, and which side of the line a run lands
on is a property of the runner that day. That is the whole reason eight merges
were red and five were green with the identical defect present.

**AND THE RED-VERIFY THAT MATTERS IS THE ONE ON A NON-FIRST CHART.** Breaking
`aria-controls` for `distribution` alone — `CHART_IDS[7]`, not the chart the
round trip uses — fails the loop naming that chart, which is what proves the
shortened loop has no blind spot. Two more pin the round trip and report
differently: a no-op `onToggleTable` fails `toBeVisible()` on the table, and
`<div hidden={tableShown}>` opened to `<div>` fails `toBeHidden()` on the
canvas.

**A COUNT IN A COMMENT HAD DRIFTED WHILE THE LIST GREW.** `CHART_IDS` holds
NINE ids; the comment above the loop said "all eight have drawn" and the next
line said "eight always-announced tables". Corrected in this case only — the
other spellings of "eight" in this file are test NAMES, and renaming those is
a wider change than this branch.

The route-error-boundary branch added ONE source file —
`apps/web/src/components/RouteErrorBoundary.tsx` — and 1 e2e case, so unit
stays 147 / 1828 and **e2e rises to 134**. Integration unchanged.

**SEVENTEEN `lazy()` ROUTES AND NOTHING CAUGHT WHAT THEY THREW.** MEASURED
against the built bundle: block one chunk, navigate to its route, and `#root`
held **ZERO children** — empty body, no header, no rail, the whole tree
unmounted with `Failed to fetch dynamically imported module` on the console and
nothing on screen. That is what every reader with the app open gets the moment
a deploy replaces the assets they loaded.

**THE BOUNDARY SITS OUTSIDE `Suspense`, AND THAT IS THE POINT.** Suspense
handles a chunk that has NOT ARRIVED; a chunk that will NEVER arrive throws.
One boundary per existing Suspense site — `RunShell` (a failed tab chunk keeps
the run header and the tab strip), `AppShell` (a failed page chunk keeps the
header and rail), `App` (last resort) — so the failure costs as little as
possible.

**`key={pathname}` IS THE OBVIOUS RESET AND IT IS WRONG HERE.** A changed key
REMOUNTS the subtree, and these boundaries wrap `<Outlet/>`s inside LAYOUT
routes — `AppShell` and `RunShell` exist precisely so the shell survives a
navigation within it. Keyed, every tab click destroyed `RunHeader` and built a
fresh one. `run-detail.spec.ts`'s "switching tabs does not remount the shell"
went red on the full suite, AFTER the branch's own four cases were green.

That case is worth reading for HOW it catches this: comparing the heading's
TEXT would not, because React Query serves the same warm entry either way and a
freshly mounted `RunHeader` renders an identical string. It tags the live DOM
node with an attribute React does not manage — **the only thing that can tell a
remount from a re-render.**

The reset is a STATE CHANGE now, guarded on an error actually being shown, so a
healthy subtree never notices the boundary exists. **A boundary that never
resets turns one failed chunk into a dead application; one that resets by
remounting breaks every layout route it wraps.**

**AND THE WORDING SPLITS ON CAUSE WHILE THE ACTION DOES NOT.** A stale chunk is
genuinely fixed by reloading (the new `index.html` names the new files); a
render bug is not. The message keys off the browser's own module-load wording,
which differs per engine and is matched loosely; the reload button is offered
either way, because it is the only thing a reader can do from there.
`componentDidCatch` keeps its `console.error` deliberately — this app ships no
error reporter, and swallowing the stack would make a caught error harder to
diagnose than the blank page it replaces.

**A LOCATOR THAT DOES NOT SAY WHICH PAGE IT MEANS IS ANSWERED BY WHICHEVER PAGE
IS MOUNTED.** The skeleton case read "the first `skeleton-table` on the page"
and picked up `ProjectTests`' four-column one on the way through. It waits for
the route first now — the same lesson as the `.nth(3)` status cell, one spec
over. **There are FIVE `SkeletonTable` call sites** (columns 4, 6, 6, 6 and the
run list's); only the run list's has been measured against its real table.

The resilience-first-pass branch added ONE e2e file —
`apps/web/e2e/resilience.spec.ts` (3) — and no unit case, so unit stays
147 / 1828 and **e2e rises to 133**. Integration unchanged.

**THE SUITE HAD NEVER SEEN A SLOW OR FAILING RESPONSE.** No `page.route`,
`abort` or `fulfill` existed in 19 spec files until the acceptance pass added
one for an expired session — so every response these specs had ever met was a
real, fast, local answer, and no skeleton, bootstrap screen or error panel had
ever been drawn in a browser. `helpers.ts` has `stall(page, glob, ms)` and
`failWith(page, glob, problem)` now. **Both take a GLOB so a case can slow ONE
endpoint**: a page whose every request hangs tells you less than one whose
table is waiting while its header has arrived.

**A SKELETON DECLARED SIX COLUMNS FOR A TABLE OF NINE, AND FINDING WHERE IT WAS
EVEN VISIBLE TOOK THREE MEASUREMENTS.**

  - A COLD load of `/runs` never draws it: `AuthGate` waits on the session AND
    on the first runs page, so stalling `/v1/runs` leaves the screen reading
    "Checking your session…" and the list never reaches its pending state.
  - An IN-APP navigation to `/runs` never draws it either — that query is
    already cached from the bootstrap, so there is no pending state to show.
  - A PROJECT-SCOPED list does: its query key carries the slug, nothing has
    fetched it, and the bootstrap only awaits the org-wide page.

So the placeholder was wrong by three on a page where it is unreachable, and
the one place it does appear needs a different count again (8 — no Project
column). **A loading state on a path that is always cached is dead code that
still ships**, and it had survived two column changes for exactly that reason.
Derived from the same `projectSlug === null` the header uses now, so the two
cannot drift.

**AND `aria-hidden` IS NOT A HANDLE.** The skeleton's only selector was
`[aria-hidden="true"]`, and the first such element in this document is an icon.
It carries a `data-testid` now — furniture a reader never queries by role is
exactly what a testid is for.

**TWO THINGS FOUND AND DELIBERATELY NOT CHANGED**, because both are product
decisions rather than corrections, and this file records them so the next
reader does not have to rediscover them:

  - `main.tsx` sets **`retry: false` for every query**, with a comment
    reasoning only about 401/403 ("a deliberate verdict the server will
    repeat") — true of those two and NOT of a 502, a timeout or a dropped
    connection, which are the failures a retry exists for.
  - **There is no error boundary anywhere in `apps/web/src`** against
    SEVENTEEN `lazy()` routes. A chunk that fails to load has nothing to catch
    it.

The drilldown-window-scope branch added ONE source file —
`apps/web/src/routes/WholeRunNotice.tsx` — no unit case (unit stays
147 / 1828) and 1 e2e case, so **e2e rises to 130**. Integration unchanged.

**ONE CALL SITE OUT OF THREE NEVER PASSED THE PROP, AND THAT WAS THE WHOLE
DEFECT.** `ErrorsTable` has had a `windowSelected` prop and an
`errors-window-note` saying "these totals cover the whole run" since C-class.
`RunDetail` passes it TWICE; `RequestDetail` never did. So the identical table,
under the identical window, explained itself on the run page and said nothing
on the drill-down. **When a component grows a prop that corrects a lie, grep
every call site — the one that was not updated is where the lie survives.**

**AND THE PAGES THEMSELVES CARRIED A WINDOW THEY CANNOT HONOUR.** Both
drill-downs keep `from`/`to` deliberately — a reader arrives from a windowed
table and sending them back un-narrowed would discard the selection they were
investigating with — but their endpoints take no `from`/`to`, and each page's
own comment says so. So the window was visible in the address bar, visible on
the page they came from, and silently did not apply. `WholeRunNotice` is shared
by both and rendered ONLY under a window: a permanent "these are whole-run
figures" on a page whose figures are always whole-run is the over-explanation
review N04 spent four rows removing.

**A SHARED COMPONENT GUARANTEES THE WORDING, NOT THE WIRING.** The case covers
the GROUP page as well as the request one for exactly that reason, and the
third red-verify proves it was worth doing: deleting the notice from
`GroupDetail` alone fails, and nothing else would have caught it. Three
independent mutations, three distinct failures — the page notice, the
`windowSelected` prop, and the group page's own mount.

The compare-cap-and-cohort branch added no unit FILE and no unit case — unit
stays 147 / 1828 — and its **e2e rises to 129**. Integration unchanged. It
takes the `multiple comparisons` half of the acceptance list's evidence
cluster.

**THE CAP REFUSED IN SILENCE.** `MAX_COMPARE` is 5, and at it every unselected
chip took `disabled` and `opacity-50` with NOTHING anywhere explaining why —
the picker's only `title` belongs to the run the page was opened from. A reader
with six eligible runs and five picked met three greyed buttons and no reason,
and the only way to learn the rule was to guess that deselecting one would free
another.

**THE SAME LESSON `ChartActions` EARNED THIS SESSION, ONE COMPONENT OVER.** A
`title` is invisible on touch and unreachable by keyboard, so it cannot be the
SOLE carrier of a refusal. The reason is visible text now and the disabled
chips point at it with `aria-describedby` — rendered only AT the cap, so the
attribute never points at nothing, which is the rule that file already follows
for its own export refusal.

**AND THE EXERCISE FOUND NOTHING ELSE BROKEN, WHICH IS ALSO A RESULT.** Every
existing case in `run-compare.spec.ts` went through `cohortOfTwo`, and the cap
was proven only against a synthetic array in `compareSelection.test.ts` — so
three, four and five overlaid runs had never existed in a browser. They work:
five distinct series, six columns in the data table, the comparability panel and
the summary tiles all render. **Pinned now rather than assumed**, which is the
difference between "we think it scales" and "it does".

**`filter({ hasNot })` MATCHES DESCENDANTS, AND `aria-pressed` IS ON THE CHIP
ITSELF.** Reaching for it to find an UNSELECTED chip quietly matched every chip
including the five selected ones, and the case failed on `toBeDisabled` against
a chip that was legitimately enabled. An attribute selector
(`[aria-pressed="false"]`) is the tool; `filter` is for containment.

The evidence-window-scope branch added no unit FILE and 1 case
(`RunStats.test.tsx`), from 147 / 1827 to **147 / 1828**, and **e2e rises to
128** (two cases in `run-charts.spec.ts`). Integration unchanged. It takes the
`evidence` cluster of the 09-13 acceptance list — the largest, at 14 gaps —
and the three it fixes are ONE mistake made three times.

**THE WINDOW CHANGED A NUMBER AND NOT THE THING DESCRIBING IT.**

  - **An empty window DELETED the run's totals.** `RunStats` returned `null`
    whenever the payload carried no run-scope row, and `?from=62000&to=63000`
    — a real, in-range second of the 62s reference run that happens to hold no
    requests — made the whole section vanish with nothing saying why.
  - **The percentile note said "a sketch of the whole run" unconditionally.**
    Under a window the sketch is rebuilt from the buckets that window selects,
    so the sentence was false exactly when a reader opens it: when the number
    surprised them.
  - **A tile's VALUE was windowed and its SLA TINT was whole-run.** An
    assertion is evaluated once at finalize against the run, so a p95 tile
    could show a healthy ten seconds coloured as a breach because a DIFFERENT
    ten seconds broke the gate.

**THE OLD COMMENT DEFENDING `return null` WAS HALF RIGHT, AND THE HALF THAT WAS
WRONG IS THE INTERESTING ONE.** It argued that "a statistics table with nothing
to show already renders its own 'no statistics were recorded' message, and six
tiles reading 0/0.00%/— above that sentence would assert measurements nobody
took". MEASURED, the table prints no such message for an empty WINDOW — that
message is for a run with no statistics, which is a different fact. The second
half stands and is why the fix is a SENTENCE rather than zeroed tiles:
`0 requests` is a true claim about the window that reads as a false claim about
the run. **When a comment justifies an absence by pointing at something else on
screen, go and look at the screen.**

**THE TINT IS WITHHELD, NOT RECOMPUTED.** Recomputing would invent a verdict
nobody configured — the same line this repo already draws between a platform
gate (the organisation's policy) and a simulation's own checks. `baseline` had
followed exactly this rule one line up since C02 ("a trend against a windowed
number compares two different things"); the rest of the component had not.

**AND THE UNIT CASE IS PAIRED WITH THE ONE ABOVE IT ON PURPOSE**: that proves
the tint APPEARS, this proves what silences it. Either alone passes against a
component that never tints, or against one that always does.

**ONE FALSE ALARM, CLEARED BY MEASURING.** A window past the end of the run
(`?from=100000&to=200000`) shows whole-run numbers, which looks like a window
being silently ignored. It is `parseWindow` clamping to the run's duration,
correctly and by design — a case built on it would have proved nothing.

The acceptance-first-four branch added ONE e2e file —
`apps/web/e2e/acceptance.spec.ts` (5) — plus 1 case to `run-list.spec.ts`, so
**e2e rises to 126** from 120. Unit stays 147 / 1827 and integration is
unchanged. It takes the first four items of the 09-13 review's
production-readiness list, and **four of them found a real defect.**

**A COVERAGE SWEEP OF THAT LIST FOUND 45 GAPS IN 91 ITEMS, AND VERIFICATION
OVERTURNED A ROW IN EVERY ONE OF ITS SIX GROUPS.** The pattern in the wrong
rows is worth more than the count: readers reasoned from a SOURCE file and
never grepped the suite named after it. "Not one `ErrorState` call site passes
an `action`" — two do, one of them four lines below a line the reader quoted.
"No spec has ever reached a control by Tab" — `project-rail.spec.ts` is a
complete keyboard journey, and the same row named that file two lines earlier.
**A gap report is a claim about the suite, so it has to be made by reading the
suite.**

**THE LONG-NAME DEFECTS WERE ALL ONE SHAPE: A BREAK RULE ON ONE OF TWO
SURFACES THAT DRAW THE SAME VALUE.**

  - The desktop run list's simulation cell had no `break-all`; the MOBILE CARD
    for the same value has had it since it was written. A 56-character class
    pushed the Errors column's right edge to **885px of 726px visible** at 768
    — silently undoing the column reorder shipped the day before.
  - `RunCard`'s project name had no break rule at all: a 120-character unbroken
    name took the document's scrollWidth to **815px against a 320px viewport**.
  - `ProjectShell`'s `<h1>` had `min-w-0` and no break rule, so
    `/projects/:slug` scrolled sideways at 320 — on all five sections.

**UAX#14 GIVES NO BREAK AFTER A FULL STOP FOLLOWED BY A LETTER**, so
`com.acme.checkout.simulations.CheckoutPeakLoadSimulation` is ONE unbreakable
56-character word — the widest string this product renders. Every geometry case
in the suite had been measured against the reference bundle's
`example.ParitySimulation`, 24 characters, which is why a guard written
yesterday passed while the product it guards would fail for every real project.
**A fixture's shortest plausible value is the one a geometry assertion is
weakest against.** `renameSimulation` exists now so a case can ask for a real
one.

**AND `truncate` CONSTRAINS NOTHING.** It is `overflow:hidden` +
`text-overflow:ellipsis` + `white-space:nowrap` — three rules about what to do
once a box is too small, and none about making it so. Below `lg` the rail's row
is `shrink-0` inside a horizontal scroller, so the box simply grew: measured at
320px, one chip was **913px wide with a 869px "truncate" span**. It scrolled
rather than breaking the page, so no assertion could see it and no reader would
report it — they would just drag past that project for ever. `min-w-0` plus a
`max-w` is what lets the rule act.

**TWO OF THE FOUR PASSED CLEAN, WHICH IS ALSO A RESULT.** 320px and 414px
scroll nowhere on the run list, a run page or the tests table; and a session
that expires MID-READ already refuses to show stale data — `apiFetch`
deliberately does not redirect on a 401 (its own docstring argues the decision
belongs to a component), and the component does the right thing.

**THE SEEDED ORG ALREADY HAS A PROJECT.** The twenty-project case first failed
on `toHaveCount(21)` against 22: `seedAdmin` creates `checkout` before any loop
adds to it. Count what the fixture makes, not what your loop makes.

The type-scale-rem branch added no unit FILE and 1 case
(`apps/web/test/tokens.test.ts`), from 147 / 1826 to **147 / 1827**, and its
**e2e rises to 120**. Integration unchanged. 232 sites across 49 files, one
mechanical rule.

**THE APP'S TYPE IGNORED THE READER'S FONT SIZE, AND ONLY THE HEADINGS DID
NOT.** Measured against the built app by doubling the root font size:

```
                      root 16   root 32 BEFORE   root 32 AFTER
  h1 (text-xl)          20px         40px            40px
  table header          12px         12px            24px
  run row cell          13px         13px            26px
  rail link             13px         13px            26px
  muted prose           12px         12px            24px
```

Headings use Tailwind's rem-based `text-xl`; everything else used
`text-[13px]`, which a root font size cannot reach. **223 absolute-px type
utilities against 42 relative ones** — so a reader who asks for larger text got
bigger titles over unchanged 12px data, which is the part they came for.

**A UNITS CHANGE, NOT A DESIGN ONE, AND THAT IS WHY IT IS ONE RULE.**
`text-[13px]` -> `text-[0.8125rem]`, which IS 13px at a 16px root: nothing
moves for a reader who changes nothing. No named tokens were invented — naming
a type scale is a design decision and this is not one — and nothing else was
px-typographic (no `leading-[…px]`, no `tracking-[…px]`, no `[font-size:…]`).
**Tailwind's spacing scale was already rem**, so the boxes around the text
were never the problem; only the text was.

**THE SOURCE GUARD WAS WORTHLESS UNTIL RED-VERIFIED, AND THE HOLE IS ONE THIS
FILE HAS NOT RECORDED BEFORE.** The new rule scans for `text-[Npx]` and it
borrowed `tokens.test.ts`'s existing `tsxFiles` collector — which takes `.tsx`
ONLY. Putting a px size back in `components/tableStyles.ts` left it GREEN: that
file is a `.ts`, and it holds `TH`, `TD` and `ROW`, i.e. every table cell in
the app. **A source-scanning guard is only as wide as its file collector, and
the highest-leverage style file in this repo is not a component.** It collects
`.ts` as well now, and fails naming the file and the string.

**TWO GUARDS, BECAUSE NEITHER IS SUFFICIENT.** The unit rule catches a
regression where it would be WRITTEN; the e2e case (`run-list.spec.ts`) doubles
the root and asserts the heading, the header and a data cell all double, which
catches a stylesheet overriding the utility and is the only layer that can —
**jsdom computes no font size at all**. The e2e half asserts DOUBLED rather
than merely larger: "bigger than before" passes against a scale that moved by a
point, which is not what a reader who doubled their font asked for. It went red
first try with `header: 12px -> 12px`.

**NOT A CLEAN WCAG 1.4.4 FAILURE, AND THE ENTRY SHOULD SAY SO.** Browser PAGE
zoom scales px text like everything else, so the criterion was arguably met
before. What was ignored is a reader's own default font size — and 12px is
small to start from.

The run-list-midwidth branch added no unit FILE and no unit case — unit stays
147 / 1826 — and its **e2e rises to 119**. Integration unchanged.

**THE RUN LIST'S TABLE HAS NEVER FITTED ITS CONTAINER BELOW ~1400px, AND THE
SCROLL WAS NOT THE DEFECT.** Measured on the org-wide list: the table wants
**1078px** and the content column gives it 726 at 768, 858 at 900, **694 at
1024**, 770 at 1100, 950 at 1280, 1110 at 1440.

**1024 IS THE WORST WIDTH, NOT THE BEST, AND THAT IS THE COUNTER-INTUITIVE
BIT.** `ProjectRail` opens at exactly `lg:` and takes ~270px, so a 1024 screen
has LESS room for the table than a 900 one. Any measurement of this table has
to include that breakpoint or it will report the band backwards.

**WHAT WAS WRONG WAS WHICH COLUMNS FELL OFF THE END.** The review allows the
scroll — "table-local horizontal scroll is acceptable when row identity,
headers, and controls remain usable" — and `Started` was **239px, 22% of the
table**, for a timestamp carrying a year and a zone (`INSTANT_FORMAT`). So p95
and Errors sat at 823 and 889px cumulative and were off every screen narrower
than 1440. Those two are what triage turns on, which `mobile.spec.ts` already
says in as many words one breakpoint down.

**THE FIX IS COLUMN ORDER, NOT COLUMN COUNT.** Identity, outcome, the two
measurements and the suggested action first; WHEN and WHERE — context rather
than triage — in the scroll tail. Nothing hidden, nothing dropped, no new
breakpoint. Measured after: p95 ends at **587px** and Errors at **652px** at
every width from 768 to 1280, inside even the 694px box at 1024. That is better
than predicted — moving `Started` to the tail stops it forcing the earlier
columns wide, and they compress into what is left.

**AND THE FIRST RED-VERIFY PASSED AGAINST A DELIBERATELY BROKEN LAYOUT.** It
ran at the default 1280 viewport ALONE, where Errors ended at 889 in a 950 box
and was already fine — so the mutation changed nothing the assertion could
see. **A geometry guard has to run at the width the defect lives at, and the
default viewport is rarely that width.** It runs at all six now, and against
the original order it fails at the first: p95 826, Errors 892, visible 726.

**`.nth(3)` ROTTED EXACTLY AS THIS FILE PREDICTS.** `run-list.spec.ts` picked
the status cell by index under a comment reciting the column order
("Started/Project/Simulation/Status/Verdict… so index 3"). The reorder made
that the SIMULATION cell, where `toHaveAccessibleName('complete')` would have
failed for a reason that is not the rule under test. It derives the index from
the `Status` header now — the same relationship the assertion is about, which
is the lesson `run-charts.spec.ts` already records twice.

**AND `allTextContents()` IS AN IMMEDIATE READ WITH NO AUTO-WAITING.** Swapping
a locator chain for it returned `[]` on a table that had not rendered yet, and
the failure read as "there is no Status column". Await something on the table
before any `allTextContents()` / `evaluate()` that measures it.

The review-copy-batch branch (the 09-13 review's "Copy changes to make
immediately" table, plus C06's remainder) added no unit FILE and 5 cases, from
147 / 1821 to **147 / 1826**. Integration is UNCHANGED and **e2e stays 118** —
no spec gained a case. SIX changes in one branch, deliberately: CI's `build`
job is ~15 minutes and these are one document's worth of copy.

**A SWEEP OF THAT TABLE'S 12 ROWS FOUND 5 OPEN, AND ONE VERDICT OVERTURNED.**
Every critical, major and minor finding was already addressed, so most rows
were satisfied as a side effect — but "the old string is gone" is not "the
proposed replacement is there", and a grep found all of them surviving only in
past-tense comments. That is the third sweep in a row to find real work behind
an apparently-closed finding.

**WHAT WAS ACTUALLY WRONG, AND THE PATTERN ACROSS THEM.** Four of the five were
a correction that stopped one step short of the reader:

  - `ProjectSetup` opened with "Three ways to get a run into this project" — a
    sentence that COUNTED the cards below it. M04 built the choices; the
    paragraph outlived its own job.
  - The telemetry empty state said what had not happened and offered nothing.
  - The runner's `unknown` state got M12's honest headline and no action.
  - The run-health caveat became a disclosure BELOW 768px only. On the
    1440x900 viewport the review was written against it was still 67 words of
    prose above the tally — and the correctness fix that landed since made it
    LONGER, 45 words to 67. **A fix applied at one breakpoint is not applied.**

**"Not configured" IS NOT "Not evaluated", AND THE BAND HAD ALREADY SAID SO.**
The 48px word read `Not evaluated` both for a project with NO RULE and for
rules that all came back not applicable. `gatesText` three lines up has drawn
that distinction since C01 — "not configured — no SLA rule judged this run" —
and the word above it contradicted it. Third time this component has taught
**grep for the siblings of a comment that argues a distinction**. Keyed on
`assertions !== undefined && assertions.length === 0`, never on `judged`, which
is also false for an ABSENT list — a run whose gates have not been reported is
not a project without rules.

**C06's REMAINDER WAS HELD OPEN BY A TEST THAT PINNED THE DEFECT.** The
statistics table's `<caption>` — its accessible NAME — was 94 words of
methodology, met on arrival with no way to skip it, which C06 names explicitly
("Avoid duplicating the full prose as the accessible name"). A case called
"keeps the full caption as the table's accessible name" asserted it stayed,
arguing a short name "would tell a screen-reader user less than a sighted one".

**THAT ARGUMENT WAS TRUE WHEN WRITTEN AND FALSE BY THE TIME IT MATTERED.** It
held while the caption was the ONLY copy of the prose; C06's own first half
removed the `aria-hidden` from `TableFrame`'s disclosure, so the methodology is
exposed to the accessibility tree for everyone. Both readers now get the same
short name and the same opt-in detail. This is the verbatim-prose trap recorded
for the M18 caveat, met from the other side: **the pin was right when written
and became the reason the defect survived.**

**AND THE SHORT NAME KEEPS ITS DISTINCTIVE WORD ON PURPOSE.** Six specs find
that table by `getByRole('table', { name: /statistics/i })`, and the visible
`summary` prop does not contain "statistics". A shorter name that dropped it
would have been a rename smuggled in behind an accessibility fix.

**TWO LINKS, ONE HONEST DESTINATION, AND THE TEMPTING ONE WAS WRONG.** The
telemetry and runner actions both point at API TOKENS, because that page names
the permission each needs (`Generator telemetry`, `On-prem runner`) and nothing
else in the app does. Add results was the obvious link for telemetry and says
nothing about it; pointing there would be the false affordance M12 is about.
The runner action fires for `unknown` ALONE — `idle` and `stalled` mean a
runner HAS been seen, and telling that reader to go deploy one is wrong advice
confidently given.

**`pnpm typecheck` CAUGHT WHAT A GREEN SUITE DID NOT, AGAIN.** A new
`RunDecisionBand` fixture used a `name` field the `Assertion` type does not
have; vitest passed 22/22 and `tsc` rejected it. Fourth time this file records
it: **vitest does not typecheck, so a test constructing a prop by hand is seen
by the gate's first command and by nothing else.**

The review-n03-omit-rail-badge branch (N03's third clause — the finding is
closed) DELETED 5 unit cases from `apps/web/test/ProjectRail.test.tsx`, so unit
FALLS to 147 / 1821 from 147 / 1826, and **e2e falls to 118** from 120
(`project-rail.spec.ts` loses two of its three badge cases). Integration is
unchanged. **A floor going DOWN is as much a measurement as one going up** —
record it, or the next reader reads a silently-skipped run as a pass.

**THE REVIEW OFFERED TWO REMEDIES AND THE FIRST ONE WAS ALREADY IN THE CODE.**
N03: "identify what the project's `not evaluated` badge summarizes — or omit
that ambiguous badge." A previous branch took the identify arm:
`latestRunSummary` put `Latest run: …` into an `aria-label` and a `title`,
because the span sits inside the `NavLink` and this file pins every row's exact
textContent. That reaches a screen reader and a mouse hover, and leaves a
SIGHTED TOUCH OR KEYBOARD reader meeting a bare `not evaluated` beside a project
name — which is the reading the finding objects to. **Half the readers is not
identified.** The badge is omitted now.

**IT COST MORE THAN A SPAN, AND THE WORKAROUND RETIRED WITH IT.**
`markFor`, `badgeFor`, `latestRunSummary` and `RAIL_INGEST_FAILED` all go.
That last one existed ONLY because this row has one badge and no column header,
so it had to tell `STATUS.failed` ("could not be ingested") apart from
`VERDICT.failed` ("ingested, failed its SLA") where the run list's two columns
and `RunHeader`'s two named groups do it for free. With no badge there is
nothing left to disambiguate — **a workaround is allowed to die with the thing
it worked around**, and its test dies with it rather than being kept alive
around a deleted feature.

**THIS SUPERSEDES A SPEC SECTION, DELIBERATELY.**
`docs/superpowers/specs/2026-08-15-perf-portal-project-sidebar-design.md` §4.3
("The badge reads status first, verdict second") specifies the badge and its
four branches, and §8 claims unit coverage of all four. The 09-13 review is the
later document and names this row specifically. Recorded in the component, the
commit and here, so a reader meeting §4.3 knows it was overruled rather than
forgotten. **When a review overrules a spec, say which document won and where.**

**AND ONE SURVIVING e2e CASE WAS RE-POINTED RATHER THAN DELETED.** "a status
badge does not clip the project name beside it" measured `scrollWidth` against
`clientWidth` on a 14-character name — the only assertion in the suite that can
see a `truncate` defect at all, since `textContent` is identical clipped or
not. Its CAUSE is gone; its CLAIM is not, because the rail still truncates and
the next `shrink-0` sibling pinned to the end of that row reintroduces the same
defect in the same way. It is "a project name is not clipped in the rail" now.
**Delete a test when its claim dies, not when its cause does.**

The stale-accountmenu-crossref branch moved NO floor — its diff is comments
only, in five source files and one test — so unit stays 147 / 1826, integration
is unchanged and e2e stays 120.

**A MODULE CHANGED WHAT IT *IS*, AND SIX COMMENTS WENT ON DESCRIBING WHAT IT
WAS.** `7cda62c` rebuilt the account menu on Radix and DELETED `ThemeToggle`.
What survived it:

  - `AppShell.tsx` still said "see `AccountMenu` for why it is a disclosure and
    not a `role="menu"`" — pointing a reader at reasoning `AccountMenu`'s own
    docstring had already reversed in the same commit ("right about the
    promise and wrong about the conclusion: the answer is to KEEP the
    promise"). Following the pointer told you the opposite of the truth.
  - five pointers at a file that no longer exists: `ProjectRail` twice for the
    storage-read pattern and a segment style, once for an "active = raised"
    comparison, `Chart.tsx` for "clicking Dark in `ThemeToggle`", `tokens.css`
    for a PATH (`components/ThemeToggle.tsx`) the component never even had, and
    `ProjectRail.test.tsx` for the same initialiser idiom.

**THE DISTINCTION THAT DECIDES EACH ONE IS TENSE, NOT THE NAME.** A comment
saying `ThemeToggle` ONCE shipped `role="radio"` with no arrow handling is a
record of a lesson and is still true — those stay, in `ChartActions`,
`dropdown-menu.tsx` and `AccountMenu.test.tsx`. A comment saying "the same way
`ThemeToggle` reads its choice" is a POINTER, and it points at nothing. **Grep
finds both; only reading decides.**

**AND THIS IS THE THIRD SHAPE OF THE SAME ROT THIS REVIEW HAS PAID FOR** — the
`Cnt/s` hint naming a run-totals label the tiles had just deleted, "Mint one
under Access" naming a page renamed three branches earlier, and now a
cross-reference to another module's DESIGN. The first two named a LABEL and a
PAGE; this one named a decision. **When a module changes what it is, grep for
whoever says what it is** — and note that a rename-driven grep would not have
found this one, because nothing was renamed.

The review-n04-pagination branch (N04, item 1 — the finding is closed) added no
unit FILE and no unit case, so unit stays 147 / 1826; integration is UNCHANGED
and **e2e stays 120** — its assertions went inside an existing `test(` block.

**A SHORTER VERSION OF A SENTENCE THE FINDING ASKS YOU TO DELETE IS NOT THE
CORRECTION.** N04 item 1 reads: remove "You have reached the end of the list",
use disabled pagination. The first pass cut it to "No more runs." — three words
instead of eight — and argued in a comment that `disabled` is silent for a
sighted reader and that `aria-describedby` pointing at an empty node would say
less than the disabled state alone.

**BOTH HALVES OF THAT WERE WRONG, AND `git log -S` SETTLED THE FIRST.**
`disabled={nextCursor === null}` dates to **87d36fa, 2026-08-15 — a month
before the review**. So the reviewer was already looking at a disabled Next
button WITH the sentence beside it, and "use disabled pagination" cannot have
meant "disable the button"; it can only have meant "let the disabled state
carry it". The second half is simpler: dropping the sentence means dropping the
`aria-describedby` WITH it, not aiming it at an empty node, and a disabled
button is announced as disabled without being told. **When a finding prescribes
a mechanism the code already has, it is not asking for the mechanism — it is
asking you to stop compensating for it.**

**THE CASE THAT NOW GUARDS IT WAS ALREADY STANDING IN THE RIGHT PLACE.**
`run-list.spec.ts`'s "follows the cursor to the next page" seeds `PAGE_SIZE + 1`
runs, so its second page IS the last one — it simply never looked at the
end-of-list state. Both halves are asserted, because either alone passes against
the wrong product: a bare absence is satisfied by a page whose controls failed
to render, and a bare `toBeDisabled` is satisfied by the sentence coming back
beside it. `toHaveCount(0)` rather than a visibility check, because this node is
not rendered at all — the opposite of M02's band prose, where `textContent`
found what nobody could see. Red-verified both ways.

**AND THE SWEEP THAT FOUND IT IS THE TRANSFERABLE PART.** Six prescribed
corrections across N02 and N04 were checked, then each verdict attacked by a
second reader made to re-read the code. Five were genuinely done; a grep had
found all five retired phrases surviving only in past-tense comments, **which
proves the old wording is gone and says nothing about whether the prescribed
REPLACEMENT is there** — this one is exactly the case where it was not.

**ONE VERDICT WAS OVERTURNED, BY A READER CHARGING ONE FINDING WITH ANOTHER'S
DEBT.** N02 was reported PARTIAL because `StatisticsTable`'s caption still says
"estimates, accurate to within 1%" — a real second restatement, and the table's
accessible name, so a screen-reader user meets it unavoidably. It is **C06's**
open remainder, recorded as knowingly deferred in `TableFrame.tsx` with its
reason (changing it changes what `getByRole('table', { name })` matches in six
specs), and it predates the review. **Before charging a finding with a defect,
check whether a different finding already owns it.**

The review-m02-metadata branch (M02, the REMAINDER — the finding is closed)
added no unit FILE and 4 cases to `apps/web/test/RunHeader.test.tsx`, from a
floor of 147 / 1822. Integration is UNCHANGED (every file it touches is a
`.tsx` or a `.spec.ts`, and `vitest.integration.config.ts` includes neither)
and its **e2e rises to 120**.

**A CLASS CAN CHANGE HOW A THING LOOKS; IT CANNOT CHANGE A CONTROL'S STATE.**
M02's first half WAS a class — `max-sm:hidden` on the band's prose — and
`RunDecisionBand` argues at length that this app has one JS breakpoint because
a class can only HIDE what a phone has already paid to mount. Nothing in the
header is expensive to mount (seven `<span>`s), so by that rule this should
have been a class too. It could not be: the metadata must not be hidden on a
phone, it must be ONE TAP AWAY, and `open` is a DOM ATTRIBUTE that no media
query writes. So `compact` is a PROP, off the `useIsCompact()` call `RunShell`
already makes for the brush — a second CONSUMER of the one breakpoint, not a
second breakpoint, the shape `DesktopOnly` already uses ("passed in rather than
read here so a caller can test both paths").

**AND THE CSS-OVERRIDE ALTERNATIVE IS REAL — ITS COST IS THE HARNESS, NOT THE
ENGINE.** The first draft of that comment said a media query forcing
`::details-content { content-visibility: visible }` was "engine-specific". That
is FALSE, and it was measured false on Playwright 1.62.1's own browsers: it
paints in chromium, firefox AND webkit. What actually breaks is the SUITE.
`computeElementStyleVisibilityVisible` in playwright-core skips
`Element.checkVisibility()` when `browserNameForWorkarounds === 'webkit'` and
substitutes "has a closed `<details>` ancestor" — reading the ATTRIBUTE and
never the CSS. So a forced-open chip reports `isVisible: false` and disappears
from `getByRole` and `ariaSnapshot` on WebKit, while WebKit itself paints it
and answers `checkVisibility(): true`; force a `<details open>` shut with CSS
and Playwright's verdicts invert the other way. **That is a harness fact, not
an accessibility fact**, and this file already records what it costs to promote
one into a design prohibition — see the `text-transform` correction, which cost
the redesign its uppercase headings on a constraint that no longer existed. The
reason that survives is the plain one: a media query cannot write an attribute.

**A JS BREAKPOINT AND A CSS BREAKPOINT DESCRIBING ONE DECISION HAVE TO BE THE
SAME NUMBER.** `useIsCompact` is `max-width: 767px`; the strip was
`grid grid-cols-2 … sm:flex … sm:divide-x`, and `sm:` is 640. Between 640 and
767 a viewport is compact to the hook and wide to the stylesheet, so a
component reading BOTH would have taken the phone's structure with the
desktop's spacing. The fix is not to pick a winner: `STRIP` and
`COMPACT_STRIP` are separate constants with no responsive variant at all, each
rendered on one side of the one boundary, and `Chip`'s cell padding moved
`sm:` → `md:` to match the row it belongs to. **When a JS breakpoint and a CSS
breakpoint describe the same decision, either they are the same number or one
of them stops existing.**

**A CLOSED `<details>` KEEPS ITS CHILDREN QUERYABLE, SO THE GUARD ASSERTS
CONTAINMENT.** jsdom applies no CSS, so `getByTestId('run-branch')` resolves
identically whether that chip is inside the disclosure, beside it, or in the
desktop strip — the M04 lesson, met again. Every unit case asks WHERE a chip is
(`toContainElement` / `not.toContainElement`), not whether it exists.
Red-verified four ways, each landing on the right case: folding Environment in
too (1 fails), never taking the compact branch (3 fail), shipping the
disclosure `open` (1 fails), and drawing BOTH strips so every value appears
twice in the accessibility tree (2 fail). The browser half — that a reader
cannot SEE the folded chips — is `mobile.spec.ts`'s, with `toBeHidden()` and
never `toHaveCount(0)`, for the reason M02's own first half had to be corrected
for.

**MEASURED, BEFORE AND AFTER, ON THE SAME SEEDED RUN AT 375x812:**

```
                              before   after
  metadata strip height        118      44
  run totals top               876     802     (the viewport is 812)
  p95 tile top                1146    1072
```

So `mobile.spec.ts`'s bound is **812** now — the first in that file that is the
GOAL rather than the measurement, because for once they met. Ten pixels of
headroom, and it is honest about what it does not cover: `seedRunWithData`
posts no provenance, so that run draws four chips. A run carrying environment,
branch and commit draws seven, and its metadata box measures **96px against
this one's 44** — measured, not inferred — putting its totals near 854. The
placement case seeds `seedRunWithProvenance` for exactly that reason, and
asserts placement rather than height because that fixture attaches no metrics.

**THE 191px IN THE OLD COMMENT WAS NEVER WRONG AND WAS NEVER UNIVERSAL.** It is
a provenanced run's strip; the e2e fixture's is 118. Both are real, and a
figure like that needs the run it was measured on attached to it.

**AND A SUBAGENT WROTE A TEST FILE INTO THE REPO, WHICH MOVED THE FLOOR.** A
verification agent created `apps/web/test/ZZRefute.test.tsx` to probe the
change — reasonable of it, and it left behind a real idea (assert containment,
not presence). It also put the unit suite at 148 / 1823 and made a
"did my change move the floor?" check read wrong in both directions, since one
of its own cases failed. **Run `git status` before believing a floor
measured while agents are working**, and delete what they leave.

**AND `git stash --include-untracked` IS STILL THE WRONG TOOL HERE.** This tree
holds `docs/ui-review-2026-09-13/`, `review.md` and `scripts/seed-manual-test.mjs`
untracked; `-u` sweeps all three into the stash, which is how they were
destroyed once already. To measure `main` while holding a change, stash BY
PATHSPEC — `git stash push apps/web/src/routes/RunHeader.tsx …` — which leaves
untracked files alone entirely.

The review-m17-chart-menu branch (M17, PART ONE) added no unit FILE and no
unit case — it rewrote thirteen existing ones in `ChartActions.test.tsx` — so
unit stays 147 / 1822, and e2e stays 119.

**FORTY CONTROLS FOR ONE FIGURE.** Every chart carried table, JSON, CSV and
full screen, and the Charts tab draws ten. Full screen stays a button because
it acts on the thing being looked at; the other three moved behind one trigger,
which is what the finding asks for ("keep fullscreen and an accessible overflow
menu").

**A REAL MENU, FOR THE REASON `AccountMenu` IS ONE.** A role is a promise about
arrow keys, Home/End, typeahead and focus return, and `ThemeToggle` earned this
repo the lesson that half-keeping one is worse than not claiming it. Radix's
dropdown keeps it, `modal={false}` for the same reason the account menu sets it,
and the content is portalled — mounted only while open, which is what keeps the
"ten charts must not contribute ten live regions" reasoning in that file true.

**THE TRIGGER IS NAMED AFTER ITS CHART** (`${title}: data and exports`). Ten
identical "Chart actions" buttons in one document is the duplicate-name defect
this repo has paid for three times; `aria-controls` already solves the same
problem for the table.

**"Export", NOT "Download", AND THE FINDING SAYS DOWNLOAD.** One of the two
items is a CLIPBOARD COPY — with a clipboard-absent path and the live-region
feedback that file argues for at length. A section headed Download over an item
that downloads nothing would mislabel it. The grouping is what the finding is
about; the heading is one word off it.

**A DISABLED MENU ITEM MUST SAY WHY IN TEXT.** As buttons these two carried
their reason in a `title`: invisible on touch, unreachable by keyboard, and now
hidden behind a menu as well. The reason is a line inside the menu now. The
same argument the run-page glossary records against `<abbr title>` as a SOLE
mechanism.

**AND `toBeDisabled()` ASKS FOR AN ATTRIBUTE A MENU ITEM CANNOT HAVE.** Radix
renders `role="menuitem"` on a `div` with `aria-disabled`, so the old assertion
failed against a control that refuses correctly. The promise is unchanged; the
spelling that carries it to assistive technology is not.

**THE e2e SURVIVED BY ASKING FOR THE RELATIONSHIP, NOT THE ELEMENT.**
`run-charts.spec.ts` finds each table's control by `aria-controls`, with a
comment saying index-based selection "would assert nothing about which table it
opens". That query has now outlived the control being a text button, an icon
button, and a menu item — only the type changed, and the claim never did. **A
locator written as the relationship is the one that does not rot.**

**WHAT IS NOT DONE: the finding's second half** — "organize charts into
investigation groups such as Load, Latency, and Errors". The run-page
reading-order branch already ordered these deliberately (the four time series
adjacent, in the order the question is asked) and `run-charts.spec.ts` asserts
`CHART_IDS` as a LIST so a reorder cannot pass silently. Grouping them adds
headings to a tab whose outline other specs pin, and it is a layout decision
rather than a correction. Left, and recorded as left.

The review-m05-honest-label branch (M05, the INTERIM the finding itself
specifies) added no unit FILE and 1 case to `apps/web/test/ProjectSetup.test.tsx`,
from a floor of 147 / 1821. Integration is UNCHANGED and e2e stays 119.

**THE BROWSER CANNOT POST A BUNDLE, AND THAT IS AN API FACT RATHER THAN A
SCOPE OPINION.** M05 asks for "a real file picker with accepted formats,
validation, progress, and processing state" — and `POST /v1/runs` is the ONLY
route that accepts a bundle (`ingest.controller.ts`, `@Controller('/v1/runs')`;
the other three POSTs are the live protocol). It refuses a session by design:
the handler reads `tenant.projectId` and answers `PROJECT_REQUIRED` — "Ingest
requires a project-scoped credential" — because a session is ORG-scoped and
names no project, while a token is minted against exactly one
(`auth.middleware.ts` sets `scopes: ['read','ingest','runner']` and no
`projectId`).

So a picker needs a project-scoped ingest route that does not exist, plus its
contract, its OpenAPI entry and its own integration tests. **CHECK WHETHER THE
ENDPOINT EXISTS BEFORE ESTIMATING A FRONTEND FEATURE** — the session already
carrying `ingest` makes this look like a pure UI job, and the missing piece is
one line further in.

**SO THE CARD IS NAMED "Import via API", WHICH IS WHAT THE FINDING ASKS FOR
UNTIL THE PICKER EXISTS.** It was headed "Import results" and then told the
reader there is no browser upload: the one thing its title offered was the one
thing it could not do. A label that lies is worse than one that is plain while
the feature is built.

**THE TESTID IS DERIVED FROM THE TITLE**, so renaming the card renamed
`entry-import-results` to `entry-import-via-api` and broke an e2e query in a
file the change otherwise never touches. `EntryCard` builds it as
`entry-${title.toLowerCase().replace(/\s+/g,'-')}` — convenient, and it means a
copy change moves a selector. Grep for the derived value, not just the label.

**AND THE GUARD IS THE PAIR, NOT THE WORDS.** A title saying "via API" over a
file input would be a different lie, so the case asserts BOTH the heading and
that no `input[type="file"]` exists anywhere on the page. When the picker is
built, that second assertion is what should fail — which is the right way for
this case to die.

The review-m11-onetitle branch (M11) added no unit FILE and 4 cases to
`apps/web/test/NewRunnerRun.test.tsx`, from a floor of 147 / 1817. Integration
is UNCHANGED and e2e stays 119.

**THE TASK WAS NAMED FOUR TIMES BEFORE A READER REACHED A FIELD.** "New on-prem
run" (`<h1>`), "Queue a run" (the card), "Three steps: what to run, how to run
it, and what will be sent" (its description), then "1 · Artifact / 2 · Execution
/ 3 · Review". The heading stays and the card now carries the form and says
nothing — which also removes an `<h2>` that repeated the `<h1>` one level down,
so a screen-reader user stops meeting the page twice. `Card` draws no heading
without a `title`, so deleting the title was the whole change.

**AN ORDINAL PROMISES A FLOW THAT GATES STEP 2 BEHIND STEP 1.** This form has
always shown all three groups at once and submitted in one go, which is exactly
"staged labels without staged interaction". The numbers go; the GROUPING stays,
because `<fieldset>`/`<legend>` is what tells a screen reader these eleven
controls come in three parts and M16 ordered them by when the decisions are
made. The case asserts the legends SURVIVE without their numbers rather than
asserting they are gone — the difference between correcting a claim and
deleting a structure.

**AN EMPTY REVIEW IS NOT A REVIEW.** Untouched, the summary listed all eight
fields, four of them as em dashes. A dash there is not a fact about the run; it
is an optional value nobody has chosen to set. Unset optional rows are omitted
now — and the REQUIRED ones are not optional rows: Artifact, Simulation and Run
name stay whether filled or not, drawn as missing, because showing the gap
before the button is pressed is the panel's entire purpose. Hiding those too
would blank the card exactly when it is most useful, so both halves are
asserted; either alone passes against the wrong design.

**AND THREE THINGS ABOUT APPENDING A CASE TO AN UNFAMILIAR SUITE, ALL OF WHICH
COST A ROUND TRIP HERE.** A block appended after the file's last `});` lands
OUTSIDE the describe that owns the render helper — and a naive "strip the last
`});` and re-add it" slices into whatever closed last, which here was
`function mount`'s body, producing `TS1005` forty lines later. Insert before
the final line instead. `NewRunnerRun.test.tsx` does NOT import
`@testing-library/jest-dom/vitest`, so `toBeInTheDocument` is an "Invalid Chai
property" rather than a failed assertion — read the file's existing matchers
before writing new ones. And `Field`'s optional marker renders inside the
`<label>`, so the accessible name is "Branch (optional)" and `/^branch$/i`
matches nothing.

The review-m09-labels branch (M09) added no unit FILE and 4 cases to
`apps/web/test/ProjectRules.test.tsx`, from a floor of 147 / 1813. Integration
is UNCHANGED and e2e stays 119.

**A FORM CAN AUTHOR A GATE THE EVALUATOR CAN NEVER RESOLVE, AND THIS ONE DID.**
`family` and `scope` are independent enums, so the schema accepts
`group_cumulated` on a whole-run rule — and `engine.ts` files a group's timings
ONLY under `group_cumulated`/`group_duration` and ONLY with `scope === 'group'`
(which is why `tool-assertions.ts` selects them as
`family === 'group_cumulated' && s.scope === 'group'`). Such a rule reports
`not_applicable` on every run for ever while reading as configured protection.

That is the silent-gate class this file already records for the error-rate
fraction: legal, resolvable-looking, never firing. **A SCHEMA CANNOT REFUSE
IT** — both halves are valid on their own — so the FORM is the only place it
can be prevented, and `FAMILIES_FOR_SCOPE` is that place. M09 reads as a
labelling finding and this was underneath it.

**AND A `<select>` WHOSE VALUE IS NOT AMONG ITS OPTIONS RENDERS BLANK.** It
does not correct itself and it does not clear the state, so narrowing the
options without moving the value would have submitted the stale family while
showing an empty control. Handled in the scope handler rather than an effect:
it is a consequence of one event, not a synchronisation between two states.

**THE LABELS MOVED AND THE VALUES DID NOT, AND THAT IS A DELIBERATE REFUSAL OF
HALF THE FINDING.** M09 asks for `Measurement`, `Statistic`, `Limit` in place of
`Family`, `Metric`, `Threshold` — those are the QUESTIONS and they move. It also
lists "raw `p95`" as requiring implementation knowledge; that half is declined
on the evidence of review N01, which spent four branches making `p95` mean one
thing across the statistics table, the run-totals tile, `formatSlaThreshold`
and this form's own preview sentence. A reader who gates `p95` has to be able
to find `p95` on the run page afterwards. **When two findings conflict, say
which one you are following and why** — the alternative is renaming in one
place and re-opening drift somewhere else.

**RENAMING A FIELD MOVES ITS ERROR MESSAGE TOO**, because `FIELD_GUIDANCE` is
the one place a field's name lives (M08). `Threshold: enter a number in ms.`
became `Limit: …` with no code change, and the case pinning it was rewritten to
follow — its claim is that the error NAMES the field, not that it says
"Threshold".

**SIXTEEN TEST QUERIES SELECTED THOSE FIELDS BY LABEL**, in four spellings
(`/threshold/i`, `/limit \(ms\)/i` after the dynamic unit, `/^metric$/i`,
`/metric/i`). Renaming a `<label>` breaks every `getByLabelText` that names it,
and the anchored and unanchored forms have to be found separately — `grep` for
the bare word misses `/^metric$/i` if you search for `metric/i` with a leading
slash.

The review-m04-choices branch (M04) added no unit FILE and 4 cases to
`apps/web/test/ProjectSetup.test.tsx`, from a floor of 147 / 1809. Integration
is UNCHANGED and its **e2e rises to 119** (`project-tests.spec.ts`).

**`<details name>` IS AN ACCORDION WITH NO JAVASCRIPT, AND IT IS THE WHOLE
CHANGE.** M04 asks Add results to stop "presenting documentation as task UI" —
all three paths showed their explanations, prerequisites, code and caveats at
once — and to "expand only the chosen workflow". Browsers close the other
`<details>` sharing a `name`; where that is unsupported they open
independently, which is exactly the behaviour being replaced, so the
degradation costs nothing.

**THE `<h2>` STAYS OUTSIDE THE `<summary>`, AND THAT IS NOT A STYLE CHOICE.**
Putting the card's heading inside the summary row is valid HTML and would have
been tidier. A `<summary>`'s descendants are PRESENTATIONAL in the
accessibility tree, so every one of these headings would have vanished from the
outline — and `project-tests.spec.ts` and `ProjectSetup.test.tsx` both query
the three by `level: 2`. Same shape as the `aria-hidden` `TableFrame` defect
this file already records: markup that looks tidier and silently removes
something only a screen reader uses. The title, the status badge and the
one-sentence description stay on screen; only the commands and caveats move.

**AND ONE CARD DELIBERATELY HAS NO DISCLOSURE.** "Run a test" is a sentence and
the button that starts a run — that IS the choice, not documentation about it.
Collapsing everything is the tidier-looking change and the wrong one: it would
bury an action rather than shorten a document. `steps` is optional for that
reason and a case pins the absence.

**ASSERTED ON `open`, NOT ON ABSENCE.** jsdom applies no CSS and a closed
`<details>` keeps its children in the DOM, so `queryByTestId` finds the curl
command either way — the same reason the `truncate` and `max-sm:hidden` claims
in this file need a browser or an attribute. The unit cases read the attribute
and pin the shared `name`; the EXCLUSION is the browser's own behaviour, which
no test short of an engine can prove, so `project-tests.spec.ts` proves it
there. Removing the `name` fails both, which is how it was verified.

**THE 2-UP GRID WENT WITH IT.** `xl:grid-cols-2` left the CI path alone in a
row of its own at every width that fits two — "the third card below the first
two", which the finding names. Collapsed, three choices are short enough that
one column is the right shape: a list of things to choose between.

The review-m02-prose branch (M02, PARTIAL) added no unit FILE and no unit case;
unit stays 147 / 1809. Its **e2e rises to 118** (`mobile.spec.ts`).

**M02's BAR IS NOT CLEARED, AND THIS ENTRY IS THE RECORD OF HOW CLOSE.**
Measured at 375x812, the run-totals top:

```
  1485  as found
  1110  once the brush stopped mounting on a phone (M18)
   928  after C01 shortened the decision band
   876  after this branch withheld the band's prose restatement
   812  the viewport — the bar M02 asks for
```

Sixty-four pixels. The `mobile.spec.ts` bound is 950 — the measurement, not the
goal, the same way `run-tables.spec.ts` carried 1100 for three branches until
M01 could honestly clear 900.

**THE BAND STATED THREE OUTCOMES AS ROWS AND THEN RESTATED THEM AS PROSE.** At
375 the band was 424px of the 812 available: verdict 91px, explanation 219px (a
42px paragraph over a 134px `<dl>`), actions 112px. On a run with no rules the
paragraph read "This run completed, but no SLA rule produced a release verdict"
directly above a row reading "Platform gates — not configured". One fact twice,
in the screen a phone reader has instead of a page. That is exactly the
"stacked repeated status prose" M02 names, and the labelled rows it asks for
were already there — C02 built them.

**WITHHELD ONLY WHERE IT IS A RESTATEMENT.** When a gate has failed, `detail`
is that gate's OWN message — it names a rule, and is never a summary of the
rows — so it survives at every width. A blanket `max-sm:hidden` would have
silently dropped the one sentence that says why a run failed.

**A CLASS, NOT `useIsCompact`.** This app's one JS breakpoint exists because a
class can only HIDE the charts while the real cost is MOUNTING them; nothing
here is mounted that a phone pays for, and the rows carry the same facts at
every width. `max-sm:hidden` is the whole decision.

**AND THE FIRST VERSION OF THE GUARD FAILED AGAINST A PRODUCT THAT WAS ALREADY
CORRECT.** It asserted `not.toContainText('produced a release verdict')` — and
`toContainText` reads `textContent`, which includes text `display: none` has
hidden. The band had already measured 424px -> 372px, so the paragraph WAS
hidden; the test simply could not see it. Same shape as the `truncate` lesson
this file records: `textContent` is identical whether a string is clipped,
hidden or shown. **Only a visibility check can assert a visibility claim** —
it is `toBeHidden()` on a testid now, and red-verified.

**WHAT IS LEFT IS THE 191px CHIP STRIP**, and M02 names it: "keep run name,
environment, outcome, and primary metrics BEFORE secondary metadata". Version,
branch, started, duration and peak users are that metadata, in a `grid-cols-2`
strip between the `<h1>` and the band. Deferring them on a phone alone needs
either a second consumer of `useIsCompact` or a duplicated chip row that would
put two copies of every value in the accessibility tree — CSS cannot toggle a
`<details>`'s open state responsively. Neither is a change to make in passing.

The review-m01-window branch (M01) added no unit FILE and 4 cases to
`apps/web/test/TimeBrush.test.tsx`, from a floor of 147 / 1805. Integration is
UNCHANGED and **e2e stays 117** — three specs changed inside existing `test(`
blocks and one geometry bound tightened.

**M01's BAR IS CLEARED, AFTER THREE BRANCHES OF RECORDING THAT IT WAS NOT.**
The review asks for failure, p95, error rate and throughput inside the first
1440x900 screen. Measured, in order:

```
        run totals top   what changed
  1570                   (as found)
  1001                   the Overview reordered, the brush cut to a navigator
   937                   C01 took the decision band from 316px to 246px
   649                   M01 collapsed the time window, 332px -> 44px
```

The bound in `run-tables.spec.ts` was 1100 for three branches — deliberately
the MEASUREMENT rather than the goal, because a threshold set to an unmet bar
is a failing test describing work nobody agreed to do. It is 900 now, and it
checks the TILES as well as the section: a totals block starting at 880 with
its values at 980 would satisfy a bound on the section alone.

**THE 332px WAS MOSTLY NOT THE CHART.** Broken down: a 242px `<figure>` (the
160px navigator plus its own card, title and axis) and a 52px input row, inside
a section's padding. Shortening the plot again would have bought little and
cost the drag affordance the earlier branch already refused to trade away.

**SO IT COLLAPSED, AND THE SAFETY PROPERTY IS WHAT MAKES THAT ALLOWED.** M01's
literal instruction is "key metrics BEFORE the time navigator", which is not
available: the control lives in `RunShell` above the `<Outlet/>` because the
window belongs to the run and every tab reads it, and moving it below the
outlet buries it under the charts on the tab where dragging matters most. A
`<details>` gets the same result — but a reader looking at a tenth of a run
with nothing on screen admitting it is the one failure this control must never
cause, which is why `CompactWindowNotice` exists one viewport down. **It opens
itself whenever a window is applied**, and names the window from the outside
when shut.

**THE EFFECT IS THE HALF THAT IS EASY TO MISS.** `RunShell` does not remount
between tabs, so a window arriving from a URL, or a reader clearing and
re-applying one, reaches a component already mounted and already closed.
Seeding state from the prop covers only the first render. Both are kept and
they are NOT interchangeable — but only the effect is separately testable, and
that was measured rather than assumed: deleting either one leaves the
"arrives already narrowed" case green, because the effect also runs on mount.
The case says so instead of implying it pins a mechanism it cannot see.

**A CLOSED `<details>` DOES NOT RENDER ITS CHILDREN, WHICH BREAKS `fill()` AND
A RAW-MOUSE DRAG DIFFERENTLY.** Three specs type into From/To and one drags the
scrubber with `page.mouse`. The typing ones fail on visibility; the drag one is
worse — `plot()` reports zero elements, so the strip is not below the fold, it
does not exist to be measured, and the drag lands on empty page exactly the way
the scroll note in that test already describes for a different cause.
`openTimeWindow` in `helpers.ts` opens it only when closed, because a spec that
arrives at a narrowed URL finds it open already and a blind toggle would SHUT
the control the product had deliberately opened.

**AND `pnpm typecheck` CAUGHT WHAT THE GREEN SUITE DID NOT, AGAIN.** The new
transition case builds a `Window` by hand — `renderBrush` hides the shape
behind an `as never` — and omitted the required `bucketWidthMs`. 15 of 15
passing, `tsc` exit 2. The gate's first command is still the only thing that
sees a test constructing a prop wrong.

The compare-axis-unit branch added no unit FILE and 1 case to
`apps/web/test/timeAxis.test.ts`, from a floor of 147 / 1804 — REBASED: it was
cut against 146 / 1782 and the glossary branch landed underneath it. Integration is
UNCHANGED and **e2e stays 117**. It fixes a defect the N01 review pass found
and deliberately did not fix, because it is a units bug rather than a
vocabulary one.

**ONE SCREEN SHOWED ONE QUANTITY IN TWO UNITS.** `toCompare` plots
`[bucket.startOffsetMs, value]` — raw milliseconds, because a value axis
carries x per point — and the DATA TABLE beneath the same chart writes
`offset / 1000` under a column headed `Elapsed (s)`. `CompareChart` passed no
`tickUnit`, so a bucket at 42 seconds was drawn at 42000, tabulated at 42, and
announced by the axis pointer as 42000.

**THE TABLE WAS RIGHT AND THE CHART WAS WRONG**, which is worth stating because
the first report of this had it the other way round. `users.ts` and `rates.ts`
head the identical column `Elapsed (s)` and also write `offset / 1000`; the
compare transform agrees with both. Only the axis dissented, and it dissented
HONESTLY — naming itself `Elapsed (ms)` described its own ticks correctly while
saying nothing about the table under it. **A label that is locally true can
still be the defect**; check what the value is next to, not only what it is.

**THE INVARIANT WAS ALREADY PERFECT EVERYWHERE ELSE, WHICH IS WHAT MADE IT
CHEAP TO PIN.** Measured across `apps/web/src/charts/*.tsx`: twelve
`name: 'Elapsed (s)'` and twelve `tickUnit: 'ms-as-s'`, matched file by file —
`RatesChart` 1/1, `UsersChart` 2/2, `TelemetryCharts` 6/6, `ErrorsChart`,
`PercentilesChart` and `TimeBrush` 1/1 each. `CompareChart` was 0/0 only
because it spelled its axis in the other unit. The new case counts the pair PER
FILE (a global total would let one file lose an axis while another gained a
spare `tickUnit`) and refuses `Elapsed (ms)` on a chart axis outright, since
the plotted value is always milliseconds — a chart that wants to say so is a
chart that forgot to convert. Both failure modes were red-verified and report
differently: `names an axis in milliseconds` against `1 axes, 0 tickUnit`.

**AND A STASH ACROSS A STALE `main` COST A CONFLICT THAT DID NOT NEED TO
EXIST.** The branch was cut from a local `main` three merges behind the server,
so the file it appended to lacked the guard that had just landed in it.
`git pull` before `git checkout -b`, every time — `git ls-remote origin
refs/heads/main` is the check this file already recommends for merges and it is
just as useful before a branch.

The review-n01-glossary branch (N01, step 4 of 4 — the finding is closed) added
ONE unit file, `apps/web/test/RunGlossary.test.tsx` (22), from a floor of
146 / 1782. Integration is UNCHANGED (both new files are `.tsx`) and **e2e
stays 117**.

**THE GLOSSARY EXISTS BECAUSE THREE STEPS STANDARDISED WHAT COULD BE AND THIS
ONE EXPLAINS WHAT COULD NOT.** N01 asks for parity spellings to be retained
"only when explicitly needed… with a glossary", and step 3 established the
retention is needed: the statistics table is byte-identical to Gatling's own
report headers. A reader can only exploit that if somebody tells them it is
true, which is what a glossary is for.

**A `<details>`, FOR THE REASON N02's DISCLOSURE IS ONE.** A `<summary>`
contributes an ARIA group and NOT a heading, so the Overview tab's outline —
`run-tables.spec.ts` pins it as the exact list `['Platform gates', 'Simulation
assertions', 'Statistics']` — is untouched. The rejected placements are worth
recording because each is the obvious one: a ROUTE is read by nobody at the
moment of confusion and would need a rail entry whose vocabulary is reserved; a
DIALOG buys nothing a disclosure does not and costs the `m-auto`-under-preflight
trap `ChartActions` already paid for; and `RunShell` would follow the reader
onto Trends and Compare, which use almost none of these words.

It mounts on a phone deliberately — not behind `DesktopOnly`. That rule exists
to stop a phone paying for ten ECharts instances to draw none of them; this is
static text with no query, and it sits below everything `mobile.spec.ts`
measures. A phone is where a reader has the LEAST room for explanation in place.

**EVERY ENTRY IS A CROSS-REFERENCE, WHICH IS THE SHAPE THAT WENT WRONG TWICE
DURING THIS REVIEW** — the `Cnt/s` hint named a run-totals label the tiles had
just deleted, and "Mint one under Access" named a page renamed three branches
earlier. Prose naming another surface has no compiler and no type. So the
load-bearing case is not that the glossary renders: it is that every word it
defines is still a word the product says, checked by reading the source that
renders it.

**AND THE RED-VERIFY IS WHAT MADE THAT GUARD REAL.** The first version mapped
an ENTRY to a list of files and searched their concatenation. Restoring the
defect — renaming `Requests/s` off the tile — left it GREEN, because the word
still appeared in `StatisticsTable`'s hint, which exists only to point at that
tile and would have been stale in the same instant. **A guard against stale
cross-references that is satisfied by a stale cross-reference is worth
nothing**, and nothing but running it red could have shown that. It is per-word
and per-file now, and fails with the word and the file named.

**ONE DEFINED WORD IS NOT A LITERAL ANYWHERE.** `95th` is built by
`percentileColumnLabel` from the payload's own digits, which is what lets a run
carrying p90 or p99.9 head its own columns — so it is genuinely on screen and
genuinely absent from the source, and a naive grep calls the glossary a liar
about a term it is right about. Those name the PRODUCER instead: "something
still builds this word" fails just as loudly when the derivation is renamed.

**AND COMMENTS ARE STRIPPED BEFORE SCANNING, FOR THE THIRD TIME IN ONE
REVIEW.** `RunStats.test.tsx`'s bridge regex matched the paragraph documenting
the defect; `timeAxis.test.ts` failed against the file it had just corrected;
this one would have too. **A source-scanning assertion reads CODE — prose about
a rule is not a violation of it**, and the rule is cheap: strip `/* */` and
`//` first, or anchor to syntax only code can produce.

The review-n01-axes branch (N01, step 3 of 4) added no unit FILE and 1 case to
`apps/web/test/timeAxis.test.ts`, from a floor of 146 / 1781. Integration and
e2e are UNCHANGED (**e2e stays 117**).

**STEP 3 WAS PLANNED AS THE BIG ONE AND IS THE SMALL ONE, BECAUSE THE EVIDENCE
REFUSED IT.** The plan was to rename the statistics table — `OK` to Successful,
`KO` to Failed, `Cnt/s` to Requests/s, ~17 test references. An adversarial pass
killed all of it on two grounds, both checkable:

  - **THE TABLE IS A BYTE-FOR-BYTE MIRROR OF GATLING'S OWN REPORT.**
    `fixtures/gatling-3.15.1.2/reference-report/index.html` carries
    `<span>Requests</span>`, `Total`, `OK`, `KO`, `Min`, `Max`, `Mean`,
    `Count`, `Error` — the same column headers, in the same order. N01 allows
    these "when explicitly needed for Gatling parity", and this is what that
    looks like with evidence rather than assertion: a reader diffing the two
    reports column by column is doing something the fixture proves is possible.
    The step-1 entry above is right that no TEST binds a label; this is the
    other half of the argument and it survives.

  - **`Cnt/s` IS NOT REQUESTS ON EVERY ROW.** `throughputRps` is
    `count / windowMs * 1000` (`rollup.ts:91`), and on a GROUP row `count` is
    group executions. Renaming the column `Requests/s` would put a false label
    on six of the reference run's fourteen rows. The tile may say Requests/s
    because the run scope really is requests; the column may not.

**SO THE FINDING IS ANSWERED BY LEAVING IT ALONE, AND THAT IS A RESULT.** What
actually changed is five AXIS names, where nothing mirrors anything:
`Time (s)` to `Elapsed (s)` (the users charts were the only ones disagreeing,
on the chart a reader correlates the others against), `Series` to `Outcome` in
the scatter CSV (the column holds OK/KO — an outcome, not a chart-internal
structure), and three `Requests per second` / `Responses per second` axis names
to `Requests/s` / `Responses/s`. Chart TITLES keep the long form: a title is
prose, an axis is a unit.

**A SOURCE-SCANNING GUARD MUST STRIP COMMENTS, AND THIS IS THE SECOND TIME.**
The new case greps `apps/web/src/charts` for any other spelling of the time
axis — and failed against the very file it had just corrected, because the
comment explaining the rename quotes `"Time (s)"` to say what it replaced.
`RunStats.test.tsx`'s bridge regex had done the identical thing an hour
earlier, matching the paragraph documenting the defect instead of the product.
**Prose about a rule is not a violation of it**; strip `/* */` and `//` before
matching, or anchor to the syntax that can only be code.

**AND A HAND-BUILT COPY OF ANOTHER MODULE'S CONSTANT GOES STALE, NOT RED.**
`Chart.test.tsx`'s scatter fixture restates `SCATTER_COLUMNS` by hand; renaming
the real constant leaves that copy describing nothing, with every assertion
still passing. It is the mirror of the vacuous `not.toContain` from step 2:
both are tests that survive the change they exist to notice.

The review-n01-gates branch (N01, step 2 of 4) added no unit FILE and 1 case to
`apps/web/test/ToolAssertions.test.tsx`, from a floor of 146 / 1780.
Integration is UNCHANGED (the files it touches are `.tsx` and `.spec.ts`, and
`vitest.integration.config.ts` includes neither) and **e2e stays 117** — three
specs changed inside existing `test(` blocks.

**TWO SYSTEMS JUDGED A RUN AND BOTH WERE CALLED "ASSERTIONS".** The
organisation's SLA rules and the assertions a simulation declares for ITSELF,
one `<h2>` apart, on the tab where a reader decides whether a release is safe.
That is the mixing N01's second sentence names.

**ONLY THE PLATFORM'S MOVED, AND THAT IS THE NON-OBVIOUS HALF.** The instinct
is to rename the simulation's — "Simulation checks" reads well. It is wrong:
`PerfPortal_Enterprise_PRD.md:2480` gives "Assertions table — expression,
expected, actual, status" to G-05, which is the TOOL's own feature, and §13.2 ②
calls the platform's "a second, clearly separated group". Gatling's assertions
really are assertions; the platform's had borrowed the word. **When two
surfaces share a name, ask which one owns it before renaming either.**

And the replacement was already on the page: `RunDecisionBand` has labelled its
outcome row `Platform gates` since C02. The heading moves onto that anchor
rather than adding a third noun — an invented "SLA gates" would have been the
same drift one word further on.

**A NEGATIVE ASSERTION OVER A RENAMEABLE VALUE IS GREEN IN EXACTLY THE CASE IT
GUARDS.** `run-charts.spec.ts` asserted `expect(headings).not.toContain('Assertions')`
to prove the Charts tab draws no Overview heading. After this rename it passes
against a string the product no longer contains — still green, guarding
nothing, forever. Its sibling in `run-tables.spec.ts` has the opposite shape
and fails loudly: `headings.find((h) => h.textContent?.trim() === 'Assertions')`
returns undefined, the guard returns null, and `expect(null).toBe(true)` reports
the stale string. **Prefer the shape that goes RED on a rename**, and when a
`not.toContain` is the right assertion anyway, keep a positive beside it.

**BOTH HEADING BRANCHES CARRY THE SAME WORDS.** An empty run renders that `<h2>`
from one branch of `AssertionEvidence` and a populated run from another;
renaming one makes the Overview tab's heading outline differ BY RUN, which
`run-tables.spec.ts` asserts as an exact list — so the e2e fixture's run would
pass while an unevaluated one silently did not.

**`Status` ON THE SIMULATION TABLE BECAME `Outcome`.** `Status` is this
product's word for a RUN's execution state — the run list gives it a column,
the decision band a row. A check has a result, not a state, and the platform
table one section up has spelled that column `Outcome` all along.

**THE NEW CASE ASSERTS EXCLUSIVITY, NOT TWO STRINGS** — that no single word
names both systems (`h2s.filter(/assertion/i)` is exactly the simulation's,
`/gate/i` exactly the platform's). The e2e outline already pins the literal
list; what this adds is the property that survives the next rename.

**AND THE WHOLE PLAN CAME FROM AN ADVERSARIAL PASS THAT CORRECTED IT TWICE.**
The first table said "SLA gates" and "Simulation checks"; a verifier reading
the PRD and the decision band produced both corrections above, plus the vacuous
`not.toContain`. It also found two defects in the branch BELOW this one after
that branch's CI had already gone green — see the tiles entry. A second reader
that is required to name the test it would break is worth more than a careful
first draft.

The review-n01-tiles branch (N01, step 1 of 4) added no unit FILE and 3 cases
to `apps/web/test/RunStats.test.tsx`, from a floor of 146 / 1775. Integration is
UNCHANGED (that file is a `.tsx`) and **e2e stays 117** — the geometry below was
measured with a THROWAWAY spec, deleted after reading, because what it proves is
a one-off design decision rather than an invariant worth 20s on every run.

**PARITY BINDS QUANTITIES, NOT LABELS, AND THIS FILE IMPLIED OTHERWISE.** The
minors entry above says `Cnt/s` STAYS because "the statistics table is the
parity surface". Measured, that is not a constraint anything enforces:
`PerfPortal_Enterprise_PRD.md:708` binds total count, OK/KO counts, % KO,
count/second, min, max, mean, standard deviation, indicator bands, error counts
and the distribution bin midpoints — all VALUES; the one entry reading "labels"
means the numeric midpoints `floor(min + step*i + step/2 + 0.5)`. And
`apps/api/test/parity.e2e.test.ts` and `packages/statistics/test/parity.test.ts`
compare only numbers: **zero assertions against the strings `OK`, `KO`, `% KO`
or `Cnt/s` in either file.**

The argument for keeping Gatling's words in the STATISTICS TABLE survives, and
it is worth keeping — a reader may be diffing that table against Gatling's own
HTML report column by column. But it is a USABILITY argument, and it had been
inherited as a parity one. A totals tile is not that surface, so this branch
changes the tiles and leaves the table for step 3. **Check whether a constraint
you are honouring is one anything actually enforces.**

**AND THE LABEL THE REVIEW ASKED FOR DOES NOT FIT THE GRID.** N01 names `p95
response time` as the standard spelling. Measured at four viewports with the
real fixture run:

```
                       1440   1280   1024    390
tile width             174px  147px  221px  173px
"Mean response time"     ok   WRAP     ok     ok
```

At 1280 the six-across grid gives each tile 147px and the label box 113px,
where that string wraps to two lines (36px against 18) and pushes its value
18px below its five neighbours — the exact baseline defect the grid's own
comment in `RunStats.tsx` records fixing once already, from the other
direction (a wrapping VALUE). The tiles read `Mean`, `p95`, `p99` instead,
which match `StatisticsTable`'s columns AND `SLA_METRIC_SCALARS`' own names —
so the word on the tile is the word a reader types into the gate that judges
it. That is a stronger answer to "one word per quantity" than the review's
phrasing and it fits; the long form belongs in prose, where `ProjectRules`
already writes it out. **Recorded as a deviation with its measurement, not
rounded up to compliance** — the discipline M01's geometry bound already set.

**THE NEW CASES PIN THE JOIN, NOT THE STRINGS.** A tile label asserted
verbatim passes while the table beneath it drifts, which IS the finding. They
assert instead that each response-time tile's label is a member of the
contract's own metric vocabulary (`isResolvableSlaMetric`), that throughput's
label and `slaMetricUnit('throughput_rps')` do not both spell the unit, and
that the section says "successful"/"failed" and not `\bOK\b`/`\bKO\b`. All
three were red-verified by restoring one old label at a time.

**AND AN EXISTING CASE PINNED THE HINT'S WORDS.** `RunStats.test.tsx`'s
four-digit-count case asserted `` `${bigOk} OK, ${bigKo} KO` `` — a claim about
DIGIT GROUPING that had taken the surrounding vocabulary hostage, so renaming
the hint failed a test about commas. It matches the two numbers with a loose
separator now. Third time this file records that shape; grep a test for the
words around the value before renaming one.

The token-mint-copy branch added no unit FILE and 3 cases to
`apps/web/test/ProjectAccess.test.tsx`, from a floor of 146 / 1772. Integration
and e2e are UNCHANGED at their `main` values and **e2e stays 117**: the diff is
five user-facing strings and three assertions, all in `.tsx` files, and
`grep -rniE "scoped?s?\b|mint|Completed reports" apps/web/e2e/*.ts` matches
only comments and fixture code (`mintToken`, a seeded `scopes:` array) — no
spec asserts any sentence this branch touches.

**M18 RENAMED THE CONTROLS AND FOUR SENTENCES AROUND THEM SURVIVED, FOR THREE
BRANCHES.** The review's finding was that "Mint" and "Scopes" are avoidable
jargon. The visible CONTROLS were corrected — "Create a token", "Create token",
"Permissions", a table cell printing `Completed reports` instead of `ingest` —
and the PROSE was not:

```
ProjectAccess  intro       "Scoped API tokens for CI, load generators…"
ProjectAccess  card        "Issue scoped credentials for CI, agents, and runners."
ProjectAccess  empty state "Mint a scoped project token when…"
ProjectAccess  caption     "…never listed after minting."
ProjectSetup   prose       "Needs a token with the Completed reports scope."
```

That last one is the worst of the five: it is a CROSS-PAGE reference, and the
branch that fixed the link beside it ("Mint one under Access" → "Create one
under API tokens") left the clause carrying it alone — because the assertion it
added reads `link.textContent`, which stops at the anchor.

**NOTHING COULD HAVE CAUGHT ANY OF IT.** Every case in both files queries a
CONTROL by accessible name; no test in any of the three suites reads the
sentences a page says about itself. Found by opening the page in a browser
after the branch above had already merged — the same way the `Filter runs
"undefined"` defect and the M15 label split were found. **When a rename lands,
grep the PROSE, not just the controls** — and scope a prose assertion to the
block, not to the element you happened to fix.

**THE GUARD IS AN ABSENCE, WITH A PAIRED POSITIVE, AND IT IS RED-VERIFIED
PER-STRING.** Asserting the new sentences verbatim is the trap this file
already records costing a false caveat its correction: the words must stay
rewritable, the jargon must not come back. So the cases assert
`not.toMatch(/\bmint/i)` and `not.toMatch(/\bscoped?s?\b/i)` over
`document.body.textContent`, in BOTH list states — the caption needs a token
and the empty state needs none, so neither branch can see the other — beside a
positive that "Permissions" really is on screen, because an absence assertion
passes just as happily against a page that failed to render. Each retired
string was put back one at a time and failed its own case.

**AND THE FIRST REPLACEMENT SENTENCE WAS FALSE, WHICH IS THE REAL LESSON.**
The empty state was going to read "Without a token, nothing can post results to
this project from outside PerfPortal." `auth.middleware.ts:44` gives a browser
SESSION `['read', 'ingest', 'runner']`, so a signed-in human can post a run
with a cookie and no token at all — the claim would have been a new wrong
sentence replacing an old jargon one. It says what a token is FOR instead ("how
a machine reaches this project without a browser session"), which is the fact
that survives checking. **Verify the replacement, not only the thing being
replaced**; a copy fix is a claim like any other.

**`TableFrame` DRAWS ITS CAPTION TWICE, SO A CAPTION QUERY NEEDS `findAllBy`.**
A visible `aria-hidden` copy sits outside the scroll box and the real `sr-only`
`<caption>` inside it — deliberately, so the sentence wraps at the viewport
instead of scrolling sideways with the columns. `findByText` over a caption
therefore fails with "Found multiple elements" and reads like a duplicate-render
bug.

The project-shell branch (M10) added ONE unit file —
`apps/web/test/ProjectShell.test.tsx` (11) — and 1 NET case to
`ProjectTests.test.tsx` (one removed with the link it pinned, two added), from
a MEASURED floor of 145 / 1760. Its **e2e rises to 117** from a measured 115
(`apps/web/e2e/project-shell.spec.ts`, 2). Its integration floor is UNCHANGED:
every file it touches is a `.tsx` or a `.spec.ts`, and
`vitest.integration.config.ts` includes neither — so that suite runs exactly
what it ran on `main`. **NOT RE-MEASURED LOCALLY, AND THAT IS A DELIBERATE
GAP**: `test:integration` truncates every table, and this machine was holding a
hand-seeded org somebody was mid-way through testing against. CI's own
integration job is the arbiter for this branch. Say which of the five gates you
actually ran; a floor nobody measured is the drift this section exists to
catch.

**AND BOTH RECORDED FLOORS HAD DRIFTED, IN OPPOSITE FILES.** The headline said
145 / 1756 and clean `main` measures 145 / **1760**; the last recorded e2e was
114 and `playwright test --list` on `main` says **115**. Four unit cases and one
spec merged without moving the numbers here. Both were re-measured by checking
out `origin/main` and running the tools, which is the only way to get these
without inferring them.

**FIVE SECTIONS MADE TWO LINKS SHARE A NAME, AND THAT WAS CORRECT.** The new
strip carries "New on-prem run" beside the heading on every project page, and
Add results' own "Run a test" card already linked to that form under the same
label — so `project-shell.spec.ts` failed strict mode on
`getByRole('link', { name: 'New on-prem run', exact: true })` resolving two
elements. The instinct is to rename one. **The anti-pattern this file records
is the OPPOSITE one**: two labels for ONE destination, which M15 shipped
(`ProjectTests` said "Add results", `ProjectRuns` said "Setup") and a later
branch had to correct. WCAG asks for identical text where the destination is
identical; the failures recorded here for "All runs" and "New project" are both
one name over two DIFFERENT destinations. So the shell's action took a
`data-testid` and the assertion narrowed to the element it is about, rather
than the product changing to suit a test. **Before renaming to satisfy a
strict-mode violation, check whether the two elements go to the same place.**

**A SHELL THAT BLOCKS ON ITS LOOKUP IS A SPINNER OVER CONTENT THAT IS READY.**
`ProjectConfigPage` returned a `LoadingState` until `GET /v1/projects`
resolved, which was tolerable on three configuration screens and is not on
`/projects/:slug`. Every destination in the strip is derivable from the SLUG
alone — only the display name needs that query — so the shell draws
immediately and the name arrives later. `ProjectTests` had documented exactly
that ("the slug is a real name for the project, not a placeholder") and its
own case went red the moment the shell swallowed the behaviour. Two branches
of the null check are needed for it: `project === null` means "not there" only
once the query has SUCCEEDED, or "not found" renders over every cold load.

**AND A SECOND `useDocumentTitle` CALLER IS A RACE THAT LOOKS LIKE A RULE.**
`RunList` titles the document from `heading`, which is right for the org-wide
list and for a test's page; under the shell it is a second writer, and effects
run child-first so the parent's write happening to land last is an accident,
not a contract. `titlesDocument` is separate from `showHeading` because
`TestRuns` suppresses the heading and still wants the title from there — one
flag would have forced whichever page came second to take a title it does not
want. It passes `null`, which the hook already treats as "not yet known", so
the opt-out is two lines rather than a branch around a hook.

**THE SECTION NAME AS `<h1>` READS RIGHT ON ONE PAGE AND STOPS BEING TRUE AT
FIVE.** Add results, SLA rules and API tokens each took their own name as the
page's `<h1>` with the project demoted to a breadcrumb. With five sections the
thing the reader is looking at is the PROJECT, so the shell owns the `<h1>` and
no section repeats its own name as a heading — `RunShell`'s shape one rung up,
where the Overview tab's outline is `Assertions / Simulation assertions /
Statistics` and never `Overview`. The practical payoff is that every section's
existing `<h2>`s kept their level: naming the section at `<h2>` instead would
have pushed `ProjectSetup`'s three entry cards to `<h3>` and `ProjectAccess`'s
"Create a token" with them.

The group-assertions branch added ONE unit file —
`packages/statistics/test/group-assertions.test.ts` (8) — and 1 case to
`apps/web/test/ToolAssertions.test.tsx`, from a floor of 144 / 1747. Its
integration floor is **134 files / 1689 tests** (that new file is a `.ts` file
integration runs too) and e2e stays **114**.

**A GATLING ASSERTION ON A GROUP HAD NEVER BEEN EVALUABLE.**
`evaluateToolAssertions` filtered to `family === 'response_time'` before
building `byKey`, and `engine.ts` files a group's timings only under
`group_cumulated` and `group_duration` — so `rowFor`'s `group` branch was
unreachable and every group-scoped assertion reported `not_applicable`, on
every run, while reading as configured protection. The comment above that
filter asserted the opposite ("a different measure that no Gatling assertion
can name"), which is true of `group_duration` and false of `group_cumulated`.

**NOTHING IN THE REPO COULD HAVE CAUGHT IT, AND EACH FIXTURE MISSES IT
DIFFERENTLY.** `assertion-corpus/` covers every Path x Target x Condition the
DSL offers and declares NO group — its only non-request path is
`details("A","B")`, which names nothing by design. `reference-report/` has
three groups and asserts on `details("Search")`, a request. Every hand-built
event in `tool-assertions.test.ts` sets `groups: []`.

**MEASURED WITH A REAL RUN, AND THE FIRST QUESTION WAS WHETHER THERE WAS A BUG
AT ALL.** The fixture project regenerates standalone — Java 21 plus
`target-server.js`, no database, API or worker, so it races no suite. Gatling
RESOLVES the path (`Cart: max of response time is less than 150.0 : false
(actual : 193.0)`) rather than reporting "Could not find stats matching
assertion path List(Cart)"; had it been the latter, `not_applicable` was
correct and there was no defect. Brackets at 150/200/250/300 put the value at
193, the group page reports Max 193, and that is this repo's `group_cumulated`
row to the millisecond — `group_duration` sits ~80ms higher throughout, the
Cart group's own pause between its two requests. PRD GR-01 and GR-02.

**`forAll()` DOES NOT RANGE OVER GROUPS, AND ONLY A RUN WITH GROUPS COULD SAY
SO.** 7 requests and 3 groups in, exactly 7 rows out. The corpus answered that
question from a run with one request and NO groups, which cannot distinguish
"requests only" from "requests and groups" — so a fix here could have widened
it silently.

**AND THE SAME PROBE FOUND A SECOND DEFECT.** Gatling renders a request inside
groups as `Cart / Add To Cart`; the `forAll` branch labelled its row
`row.name`, which is `Cart/Add To Cart`. The `details` branch already spaced
it. G-05's tolerance is exact WORDING, and the corpus has nothing to space.

**THE SEPARATOR IN `tool-assertions.ts` WAS A LITERAL NUL BYTE.** All four
sites — `byKey.get('run\0')`, both `rowFor` lookups, and the map builder —
consistently, so it worked, and invisible in an editor, a diff and a review. A
string-replace edit against that file fails to match, and retyping the line as
a space silently stops every lookup matching while the types stay happy. It is
written `\0` now: same bytes, and the choice is good — a NUL cannot occur in a
name, so the scope prefix can never collide with one. **When an edit to a file
will not match a string you can see, read the bytes.**

**AND A LOCAL INTEGRATION STREAK THAT IS RECORDED RATHER THAN EXPLAINED.** This
branch failed `test:integration` FIVE times running on this machine, each time
ONE different test — six distinct tests across the five runs, every one
infrastructure-shaped: a 503, a `RangeError: Invalid time value`, a pg
`Connection terminated due to connection timeout`, a 404 on sign-up, a 404 on
`/v1/ping`, and a 404 where a 400 was expected. Never an assertion about a
value, and never in a file this branch's diff can reach.

Everything that could explain it was checked and did not: `main` passed
1681/1681 **three times** in the same window, once at a HIGHER starting load
(7.19) than the branch's failures (4.66, 3.65, 5.86, 7.22), so the load gate is
not it. Docker inodes 35%, database 14 MB, Redis 17 MB, all three containers up
22 hours with zero restarts, no stray worker or API (`pgrep -f dist/main.js`
empty, `pg_stat_activity` clean), and no overlapping suite. Holding the new test
file aside left the source change alone and it failed again with yet another
test, so it is not the added file perturbing order either. The change itself is
three extra `Map` entries in a pure function and cannot make `/v1/ping` 404.

**AND CI PASSED THE SAME SUITE FIRST TRY** — `build` green in 14m37s on a clean
runner with fresh service containers, which is the controlled version of the
same experiment.

**THE CAUSE WAS FOUND ON THE NEXT BRANCH, AND IT WAS MEMORY.** This entry first
recorded the streak as unexplained. It was not: `sysctl vm.swapusage` showed
**18,872 MB of 20,480 MB of swap in use (92%)**, `vm_stat` 241 million swapouts
against 210 million swapins, and **8,973 free pages — about 35 MB**. The
machine was thrashing, which is the everything-is-broken shape this file
already documents one section down.

**AND THE LOAD GATE CANNOT SEE IT, WHICH IS THE WHOLE LESSON.** That earlier
entry met thrashing at load 174 and 278, so load was the tell. Here load was
**4.39** while swap was 92% gone — a gate of `1-min < 8 AND 5-min < 10` passed
every single time and the suite failed anyway. Low load is not evidence of a
healthy machine; it is evidence of a machine that is not computing, which is
also what a machine waiting on swap looks like. **Check `sysctl vm.swapusage`
and `vm_stat` alongside `uptime` before believing OR disbelieving an
integration result.**

The branch/main asymmetry that made this look like a code defect was luck:
`main`'s three passes and the branches' six failures fell either side of the
pressure, not either side of a change. The tell that should have redirected the
search sooner is the ERROR CLASS — among them a
`Parse Error: Expected HTTP/, RTSP/ or ICE/`, which is a socket receiving
non-HTTP bytes and cannot be produced by any application-level diff, let alone
one touching only `apps/web`.

The review-0913-majors branch added ONE unit file —
`apps/web/test/ToolAssertions.test.tsx` (9) — and 14 cases (12 to
`ProjectRules.test.tsx`, 2 to `RunList.test.tsx`), from a floor of 143 / 1724
MEASURED on `origin/main` rather than inferred by subtraction. Its integration
floor is UNCHANGED at **133 files / 1681 tests** — the only `.ts` file it
touches, `runnerReadiness.test.ts`, gained no case — and its **e2e rises to
114**. Ten of the 09-13 review's eighteen majors; the other eight want product
decisions rather than a correct answer and are left.

**A `<label>` THAT WRAPS ITS CONTROL LEAVES THAT CONTROL WITH NO id, AND THREE
THINGS NEED ONE.** Every field on the SLA form associates perfectly and was
unreachable: `aria-describedby` needs an id on the message, `aria-invalid` has
to sit on the control, and moving the caret needs a handle. So a refusal named
the field in a sentence and left focus on the submit button. M08 adds
`fieldId(...)` keyed by the same request property name `FIELD_GUIDANCE` uses,
so there is one spelling of "which field".

**AND THE FOCUS HAS TO MOVE IN AN EFFECT, NOT IN THE HANDLER.** Focusing inside
`onSubmit` runs BEFORE React commits the render carrying `aria-invalid` and
`aria-describedby`, so a screen reader announces the field in its old,
valid-looking state and never reads the message. `setFormError` is called with
a fresh object on every refusal, which is what makes a second identical submit
pull the caret back rather than sit still.

**A SCHEMA MESSAGE DESCRIBES THE WHOLE REFINEMENT; A FORM KNOWS WHICH HALF.**
`targetMatchesScope` reads "a run-scoped rule takes no target name; a scenario,
group or request rule needs one" — right for an API consumer, who can send
either, and half-irrelevant to an author who picked Request and left the box
empty. The form cannot even produce the other mistake: a run rule renders no
target field.

**AND A WARNING THAT OVERSTATES ITS CASE TEACHES THE READER TO DISCOUNT IT.**
The empty-threshold help said a blank box authors "a gate of ≤ 0, which every
run breaches". True for `lte` on a response time; false the moment either half
moves — `p95 ≥ 0` passes on every run there will ever be, and `count ≤ 0`
passes on a run that recorded nothing. It names the field's own unit now, which
is a fact the form already computes and can always defend.

**A TEST THAT WRITES BOTH SIDES OF A JOIN PROVES NEITHER.** M13's Target link
resolves a decoded assertion path against the run's statistics.
`ToolAssertions.test.tsx` supplies BOTH — a path spelling `Search` and a stats
fixture holding a request called `Search` — so it can only prove the component
links what it is told to. The e2e case added to `run-tables.spec.ts` takes the
path from a real decoded `simulation.log` and the name from the statistics
engine that read the same file, then FOLLOWS the link and asserts the heading:
a link built from the displayed label (`Cart / Add To Cart`) rather than the
identity (`Cart/Add To Cart`) satisfies `toHaveURL(/\/requests\//)` perfectly
and lands on a page saying no such request exists.

**AND TWO e2e ASSERTIONS THIS BRANCH'S OWN RENAMES BROKE, WHICH THE UNIT SUITE
COULD NOT SEE.** The component tests moved with the rename and the browser
assertions did not — `Percentage` → `Share of errors`, and the telemetry empty
state. The second was asking the wrong question before this branch touched it:
it matched `/no telemetry was recorded/i` and a comment called that exact
phrase load-bearing, when the load-bearing thing is the DISTINCTION between
"never measured" and "measured and found idle". Rewording that state to say
what to do about it then read as a regression. It asserts the claim now. This
is the verbatim-prose trap recorded for the review-criticals branch, met again
one suite over.

**AND A GATLING ASSERTION ON A GROUP HAS NEVER BEEN EVALUABLE — RECORDED, NOT
FIXED HERE.** `evaluateToolAssertions` filters to `family === 'response_time'`
before building `byKey`, and `engine.ts` files a group's timings ONLY under
`group_cumulated` and `group_duration` — so `rowFor`'s `byKey.get(\`group
${name}\`)` is unreachable and every group-scoped assertion reports
`not_applicable`. Nothing in the repo exercised it: the assertion corpus
declares no group at all, the reference simulation has three groups but asserts
only on `details("Search")`, and every event fixture in
`tool-assertions.test.ts` sets `groups: []`.

Measured with a real Gatling run (the fixture project regenerates standalone —
Java 21 plus `target-server.js`, no database, API or worker, so it races no
suite). Gatling RESOLVES the path rather than reporting "Could not find stats":
`Cart: max of response time is less than 150.0 : false (actual : 193.0)`
against a group page reporting Max 193 — and that page's stats table is this
repo's `group_cumulated` to the millisecond (reference run: 106/141/179 against
`group_duration`'s 188/225/264, the ~80ms being the group's own inter-request
pause). Counts resolve too (85 group instances), and so do nested paths
(`Catalog / Recommendations`).

**`forAll()` DOES NOT RANGE OVER GROUPS, AND ONLY A RUN WITH GROUPS COULD SAY
SO.** The corpus answered "one row per request" from a run with one request and
NO groups, which cannot distinguish the two. The probe run has 7 requests and 3
groups and expands to exactly 7 rows, all requests. So a fix belongs in the
path lookup alone.

**AND THE SAME PROBE FOUND A SECOND DEFECT NOBODY WAS LOOKING FOR.** Gatling
renders a request inside groups as `Cart / Add To Cart`, spaced. The `details`
branch matches that (`parts.join(' / ')`); the `forAll` branch labels its row
`row.name`, which is `Cart/Add To Cart`, unspaced. G-05's tolerance is exact
WORDING, and the corpus could not catch it because a run with one request and
no groups has nothing to space.

The review-0913-c01 branch added no unit FILE and 1 net case (one INVERTED,
one added) to `RunDecisionBand.test.tsx`, from a floor of 143 / 1723.
Integration and e2e are unchanged at **133 / 1681** and **113**.

**A COMPONENT DREW ONE DISTINCTION CORRECTLY AND THEN IGNORED IT THREE TIMES.**
`evaluated` is `assertions !== undefined`, so an EMPTY array counts as
evaluated. `gatesText` already knew better and says so in its own comment — "an
empty list means nothing judged the run, which is not the same as nothing
failing" — and fixed it for that row ALONE. The counts sentence, the tick strip
and the count tiles kept reading `evaluated`, so a run with no SLA rules and
one FAILED simulation check stated the same non-fact four times (the 48px word,
a badge repeating it, "0 passed · 0 failed · 0 not applicable", and "Passed 0
Failed 0 N/A 0") while the failure appeared once in 12px underneath.

**WHEN A COMMENT ARGUES A DISTINCTION, GREP FOR ITS SIBLINGS.** The reasoning
was already written down and already right; what was missing was applying it to
the other three readers of the same flag.

**AND REMOVING A DUPLICATE IS ONLY SAFE WHERE IT REALLY IS ONE.** Dropping the
badge looked obviously correct — same state, same colour, beside a 48px word.
It is correct for `passed`, `failed` and `not_evaluated` and WRONG for `none`:
`decisionWord` has no branch for `none` and falls through to "Pending", while
the badge reads "no verdict yet", and a run that FINISHED with no verdict is
not pending. The existing test went red and was right to. That is the
`unevaluated` IS NOT `none` distinction the component's own type comment opens
with, met from a third direction.

Measured at 1440x900, the viewport the review used: the band went from **316px
to 171px**, run totals from **y1007 to y905**, and the failed check from 12px
below three zeros to the second row, in the failed-status colour.

The review-0913-c02-c04 branch added no unit FILE and 7 cases (4 to
`Chart.test.tsx`, 3 to `AppShell.test.tsx`), from a floor of 143 / 1716.
Integration is **133 files / 1681 tests** and e2e stays 113.

**TWO EXPRESSIONS DECIDING ONE THING WILL EVENTUALLY DISAGREE.** The legend is
withheld from a NAVIGATOR (`!compact && !navigator && drawn.length >= 2`) while
`grid.bottom` reserved its band on `drawn.length >= 2` alone — so the run
page's time selector kept 26px of clearance for a legend it never draws.
Measured in Chromium at 1440x900, before and after:

```
                          before   after
y-axis tick labels          7        3
spacing between them      4-5px    33px      (line height is 14px)
overlapping pairs           5        0
plotted path height      a stripe   63px     (canvas is 160px)
```

`showLegend` is computed once now and both consumers read it. Two supporting
changes: a navigator names no value axis so its top band has nothing to clear,
and its axis asks for `splitNumber: 2` — ECharts' default asks for six labels
and draws them whether or not they fit, which is how six numbers came to
overprint each other in a 34px plot.

**A `<Link>` TO THE PATH YOU ARE ALREADY ON DOES NOT SCROLL TO ITS FRAGMENT.**
React Router answers a same-path navigation with `pushState`, and a browser
scrolls to a fragment only on a real hash navigation or a document load. The
decision band's "See the failed simulation check" therefore set
`#simulation-assertions` and moved nothing — measured at scrollY 0 with the
target 1463px below. `AppShell` owns scroll behaviour and owns this now: it
reveals the target, MOVES FOCUS to it (scrolling without refocusing leaves a
keyboard user reading the link they just followed), and retries across
animation frames because the same URL opened FRESH is worse — the target
belongs to a lazy route child behind a query, so at first paint there is
nothing for anyone to scroll to.

The other half is `scroll-margin-top`, and it is CSS on purpose: the run page
has two sticky bands (header at `top: 0`, tabs at `top: var(--header-height)`)
so a fragment flush to the viewport top lands under both — and CSS is what the
BROWSER honours on the fresh-load case this code never sees.

**`pnpm typecheck` CAUGHT WHAT A GREEN SUITE DID NOT.** The new `Chart` cases
passed 33/33 while omitting a required `brush.value`; vitest does not
typecheck, so the gate's FIRST command is the only thing that sees a test
building a prop wrong. Worth remembering whenever a new case constructs a
component's props by hand.

**AND THE LOAD GATE NEEDS THE 5-MINUTE AVERAGE, NOT JUST THE 1-MINUTE.** This
branch waited for the 1-minute figure to reach 10.8 and started anyway while
the 5-minute was 21.9. The run took **986s against a usual ~540s** and failed
one test with a **503 after 40.5 seconds** — a single request the API could not
serve, which is what resource exhaustion looks like from inside a suite. The
1-minute average decays fastest and is therefore the one that most easily says
"settled" over a machine still working through a backlog. Gated on BOTH
(1 < 8 and 5 < 10) it settled in 210s and the same suite passed 1681/1681.

**THE SIGNATURE IS WORTH RECOGNISING**, because it is now three sessions of the
same shape: ONE test fails, in a file `git diff origin/main --name-only` says
the branch cannot reach, passing alone and on a re-run. The tells that separate
it from a real defect are the DURATION (a sub-second test taking tens of
seconds) and the ERROR CLASS (503, connection, deadlock — not an assertion
about a value).

The review-0913-criticals branch added ONE unit file —
`apps/web/test/TableFrame.test.tsx` (5) — and 2 cases to
`RunList.compact.test.tsx`, from a MEASURED floor of 142 / 1709. Integration is
**133 files / 1681 tests** (both files are `.tsx`) and e2e stays 113. It takes
the three criticals a second review found in the branches immediately above.

**THE HEADLINE SAID 1693 AND MAIN MEASURED 1709 — SIXTEEN TESTS OF SLACK.** Not
drift from an unrecorded branch this time: the number was simply written down
wrong. The sla-authoring run that produced it reported *141* files, the entry
recorded 142, and the test count went with the file count rather than with the
run. **Read the floor off the runner's own last two lines and paste both**; a
floor below the truth catches nothing, and a silently-skipped run of up to
sixteen tests would have read as a pass. Re-measured by stashing the branch and
running `test:unit` on clean `main`, which is the only way to get this number
without inferring it.

**ALL THREE CRITICALS WERE THE SAME MISTAKE: SOMETHING MOVED AND THE THING
DESCRIBING IT DID NOT.**

  - A link labelled "Configure rules for this project" still used
    `projectSetupPath`. M15 moved rules to `projectRulesPath` and turned
    `/setup` into "Add results", so the one remedy a no-rules empty state
    offered opened a page about uploading bundles. The path still resolved, the
    page still rendered, and **no test asserted where a link GOES** — only that
    it exists. `ProjectRuns` carried the other half: its label said "Setup"
    while `ProjectTests` said "Add results" for the same destination. **When a
    page is split, grep every caller of the old path for what it MEANT.**

  - The run-health caveat read "NOT the assertions a simulation declares for
    itself" while `needsAttention` had been counting exactly those since M02
    widened the list contract. One complete run, no SLA verdict, "Needs
    attention 1", under a paragraph denying it.

  - `TableFrame` wrapped a `<details>`/`<summary>` in `aria-hidden="true"`.
    That attribute removes an element from the accessibility tree and NOT from
    the tab order, so six tables shared a tab stop a screen reader cannot
    describe.

**A TEST THAT PINS PROSE VERBATIM PROTECTS IT FROM CORRECTION.** The M18 branch
moved that caveat and asserted "the words are not weakened" — which kept a
sentence that had already become false, and turned the suite into the reason it
survived. Assert the CLAIM instead: the new case says the denial must not come
back, whatever words carry it.

**AND REASONING ABOUT HALF A RULE IS HOW IT SURVIVES BEING READ.** The
`aria-hidden` was examined during M18 — there is a comment three lines away
explaining why `RunCards` must NOT copy it — and the question "is hiding an
interactive control valid at all" was never asked. `TableFrame` had no test
file, which is how a component six tables share acquired the defect at all.

**THE INTEGRATION FLAKE NOW CORRELATES WITH LOAD, TWICE IN A ROW.** A different
single test failed each time — `verdict.integration.test.ts` on the branch
above, `tests.integration.test.ts` here — each in a file the branch's own
`git diff origin/main --name-only` cannot reach, each passing alone and on a
re-run. Here the failing run STARTED at load **17.32** and the clean one at
**5.43**. This file already says to gate the start on load; printing `uptime`
and running anyway is not gating it.

The sla-authoring-clarity branch (M17's remainder) added no unit FILE and 18
cases — 11 to `apps/web/test/ProjectRules.test.tsx` and 7 to
`packages/contracts/test/rules.test.ts` — from a floor of 142 / 1675 once M18
had merged. Its integration floor is **133 files / 1681 tests** (that
`rules.test.ts` is a `.ts` file integration runs too) and e2e stays 113.

**THE PICKER'S ENDPOINTS HAD TO BE MOCKED OR THE SUITE WOULD HAVE TESTED THE
FALLBACK.** The target field is now a choice over the names a run recorded, and
it degrades to the typed input it replaced when either read fails. Left
unmocked those reads fail, so every existing target case would have gone on
passing against the fallback while the picker went untested. **This is the
second branch in a row to meet that**, one component over — see the
setup-and-launch entry. Whenever a control gains a data source AND a degraded
path, the suite's default state is the degraded one.

**AND ONE INTEGRATION RUN FAILED WITH A TEST THIS BRANCH CANNOT REACH.**
`verdict.integration.test.ts`'s "keeps two declared tests of one simulation
apart" reported `[ 'checkout-smoke' ]` against the expected pair — one test
created where two were declared. The file then passed ALONE 16/16, the full
suite passed 1681/1681 on a re-run, and `git diff origin/main --name-only`
carries nothing under `apps/api`, `apps/worker` or `packages/persistence` at
all. Recorded rather than glossed, as the review-majors-workflow entry asks:
this is the same undiagnosed shape, and the branch-diff is the cheapest
evidence that it is not the change under test.

**THE GREP TRAP FROM THAT ENTRY BIT AGAIN, IMMEDIATELY.** The first failing run
was piped through `grep -E "×|FAIL"` and the assertion message went with it,
so the second run had to be spent re-finding what the first had already said.
**Redirect the suite to a file and read the tail** — `tail -6` costs nothing
and keeps the whole failure.

The mobile-summary branch (M18) added ONE unit file —
`apps/web/test/RunList.compact.test.tsx` (9) — and 7 cases across
`DesktopOnly` and `RunShell`, from a floor of 141 / 1675. Its integration floor is
UNCHANGED at **133 files / 1674 tests** (both new files are `.tsx`/e2e, which
that config never runs) and **e2e rises to 113**
(`apps/web/e2e/mobile.spec.ts`, the first spec in this repo to set its own
viewport).

**A HEIGHT CLAIM CANNOT BE TESTED ANYWHERE BUT A BROWSER, AND THIS FINDING IS
ALL HEIGHTS.** M18 is measured in pixels — "the first run table begins around
y=1123", "the basic decision must fit in the initial mobile screen" — and jsdom
lays everything out at 0x0, the same reason this file already records for
`m-auto`, `truncate` and the decision band's collapsed column. So the unit
cases assert what EXISTS (a closed disclosure, a list instead of a table, every
field still present) and `mobile.spec.ts` asserts the geometry at 375x812.
Measured there against a real seeded run, before and after:

```
                              before   after
run list   first row/card      908      472
run page   the run's totals   1485     1110
run page   p95                1801     1384
run page   the time brush     394px    not mounted
```

**AND THE ONE DEFECT IN THIS BRANCH WAS FOUND BY OPENING THE PAGE, NOT BY THE
SUITE.** The compact filter summary read `Filter runs “undefined”` on every
unfiltered list: `filtersFromParams` spells the search term
`params.get('q') ?? undefined`, and the summary tested for `null` and `''`, so
the absent case fell through into a template literal. Nothing threw, nothing
failed — the case that existed rendered a FILTERED url, where the summary was
correct. **A field that has been three things (absent, empty, a string) does
not get a longer chain of falsy spellings; it gets a `typeof` check**, and the
new assertion is on the unfiltered state, which is the half nobody had written.

**THE THRESHOLDS IN THAT SPEC ARE THE MEASUREMENT, NOT THE GOAL** — the same
discipline the run-page reading-order branch used for M01. p95 at 1384 is still
the second screen and the review asks for it in a compact summary; what is left
in front of it is the decision band, 555px at 375px, and shortening that
materially trades against the three separate outcomes C02 put there. That is
the design decision M01 already recorded, met again one viewport down.

**AND `test.use({ viewport })` IS FILE-SCOPED, WHICH IS WHAT YOU WANT HERE AND
IS THE OPPOSITE OF `test.skip`.** The skip form at file scope silently drops the
whole spec on an engine (recorded above); `use` at file scope is the documented
way to run every case in one file at one viewport, and putting it inside a test
body would apply to nothing.

The setup-and-launch branch (M15, M16) added TWO unit files —
`apps/web/test/runnerReadiness.test.ts` (13) and a rewritten
`apps/web/test/ProjectSetup.test.tsx` (9) — plus 7 cases to
`NewRunnerRun.test.tsx`, from a floor of 139 / 1647; integration is **133 files
/ 1674 tests** (only `runnerReadiness.test.ts` is a `.ts` file integration
runs) and **e2e rises to 109**. `ProjectSetup.test.tsx` was RENAMED to
`ProjectAccess.test.tsx` and a new file took its name, so `git log --follow`
reads the token cases' history under the new name and the file count moves by
two rather than three.

**AN UNMOCKED QUERY CAN MAKE A SUITE TEST THE FALLBACK INSTEAD OF THE
FEATURE.** `NewRunnerRun`'s test field became a PICKER over
`GET /v1/projects/:slug/tests`, which degrades to the old typed field when that
list cannot be loaded. The existing cases typed into
`getByPlaceholderText('checkout-soak')` — and that placeholder survives on the
FALLBACK input, so leaving `fetchProjectTests` unmocked would have kept them
green while they exercised the degraded path and the picker went untested.
Mocking it turned them red immediately, which is how the gap was found. This is
the "malformed fixture exercises the fallback" trap this file already records,
met from the other direction: there the fixture was wrong, here it was absent.

**AND A SUMMARY THAT ECHOES A FIELD BREAKS EVERY UNSCOPED `getByText` FOR IT.**
M16's review group reads back the chosen artifact, so
`getByText(/alpha\.jar/i)` — which had the page to itself — resolved two
elements. The fix is to name the one you mean, and the assertion is better for
it: it now claims the REVIEW shows the file, which is the new behaviour, rather
than that the string appears somewhere.

**THERE IS NO RUNNER-HEALTH ENDPOINT, AND THAT SHAPED THE WHOLE ANSWER.** The
on-prem runner POLLS for work, so nothing in the API is told when one connects
or leaves; `runner_job` has no heartbeat column. M16 asks for availability
"where supported, with explicit unknown/unavailable states", and the only
evidence available is the project's own job list. `runnerReadiness` reads it
and keeps each state's claim to what the evidence supports — a claimed job
proves a node is there, a long-`queued` job proves nothing is claiming, and a
project whose jobs are all terminal proves NOTHING about now. That last one is
the case worth guarding: rounding it up to "available" is exactly the failure a
status panel exists to prevent.

The assertion-structure branch (M10, M11) added ONE unit file —
`apps/web/test/toolAssertion.test.ts` (9) — and 4 unit cases (3 to
`StatisticsTable.test.tsx`, 1 to `ScopedStatistics.test.tsx`), from a measured
floor of 138 / 1634. Its integration floor is **132 files / 1661 tests** (that
one new `.ts` file runs there too; the two `.tsx` files never do) and e2e
stays 108 — its two spec changes are assertions inside existing `test(`
blocks.

**THE HEADLINE ABOVE HAD DRIFTED BY SEVEN, AND THE INTEGRATION NUMBER PROVES
WHERE.** It said 138 / 1627; this tree measures 1647, of which 13 are this
branch's. The integration figure recorded for the previous branch (1652) is
EXACTLY 1661 minus this branch's 9 `.ts` cases — so the missing seven are
`.tsx` cases, which integration never runs, added by the two review branches
merged since and never written down. That is the drift the parenthetical
above exists to catch, and it is worth knowing it can hide in ONE of the two
numbers while the other stays perfect.

The review-criticals branch then added ONE unit file
(`apps/web/test/comparability.test.ts`, 10) and **49** unit cases —
3 to `ProjectRules.test.tsx`, 6 to `TimeBrush.test.tsx`, 8 to
`ErrorsTable.test.tsx`, 4 to `RunTabs.test.tsx`, 4 to `RunShell.test.tsx` and 5
to `transforms.compare.test.ts`, 8 to `RunDecisionBand.test.tsx`, 1 to
`RunList.test.tsx` and 10 in that new file — from a floor of 137 / 1533. Its
integration floor is **131 files / 1629 tests** (`comparability.test.ts`,
`transforms.compare.test.ts` and `contracts.test.ts` are `.ts` files
integration runs too, plus 2 new cases in `trends.integration.test.ts`) and its
**e2e rises to 106**.

The sla-authoring-units branch after that added no unit FILE and 9 cases (7 to
`packages/contracts/test/rules.test.ts`, 2 net to `ProjectRules.test.tsx`),
from a floor of 138 / 1618; integration is **131 files / 1652 tests** and e2e
stays 108. It carries M17's unit change and the two minors that are defects
rather than taste (m03, m04).

**THE AUTHOR WAS THE ONE PLACE IN THE PRODUCT THAT CONVERTED.** `error_rate` is
`koCount / count`, so the evaluator compares 0.0268 while every read surface
renders 2.68%. The SLA form took the fraction, which is the trap recorded
further down this file: `1` meaning "one percent" is a legal, resolvable,
permanently PASSING gate of ≤ 100%, and no schema can refuse it. The field
takes a PERCENTAGE now and `percentToFraction` stores the fraction. **Nothing
about the wire or the evaluator changes** — older rules read back identically.

`formatSlaThreshold` lives beside `slaMetricUnit` and is the ONLY place the
unit decision lives, so the rules table, the run page's evidence panel and the
CSV export cannot drift about what `≤ 0.01` means. The warning MOVED rather
than being deleted: it caught a fraction above 1, and now catches a percentage
above 100 — and a new case pins that **one percent is quiet**, because the
input the old warning fired on is the input the field is now designed for.

**AND A PROCESS MISTAKE THAT INVALIDATED A WHOLE RUN.** An integration suite
was started and then the branch was switched while it ran, so its 1652/1652
was measured against a tree that changed underneath it — and the work was still
UNCOMMITTED, so it travelled onto the next branch and left the old one pointing
at someone else's commit. **Commit before starting a background suite, and do
not touch the tree until it finishes.** The result is otherwise unfalsifiable:
it neither passes nor fails anything in particular.

TWO MINORS WERE LEFT ON PURPOSE. m01 (uppercase mono across every status pill
and column heading) and m02 (the explanatory paragraphs above most tables) are
labelled "design assessment" by the reviewer and are: that treatment is the
control-room redesign's deliberate signature, and this file already records
MEASURING it rather than assuming. A direction to be chosen, not a defect to
be corrected.

The review-majors-workflow branch after that added no unit FILE and 15 cases,
from a floor of 138 / 1603; integration is **131 files / 1645 tests** and e2e
stays 108. Nine majors, chosen because each states something false, hands the
reader a dead end, or drops context they need — the page-level redesigns
(M11's column selector, M15/M16's setup and launch forms, M17's SLA
vocabulary, M18's mobile restructure) are left, because they want product
decisions rather than a correct answer.

THREE THINGS FROM IT.

**`data?.user.name` READS AS SAFE AND IS NOT.** The `?.` short-circuits only on
a nullish `data`, so a session body that is an OBJECT WITHOUT a user throws on
`.name` — and this was in `AppShell`, the chrome, so it took every page down.
`AppShell.test.tsx`'s "renders the page even when the rail cannot load its
projects" went red the moment it was added. **Optional at every hop, not just
the first.**

**THE SESSION CARRIES NO ORGANISATION AT ALL**, so M19 is half-done ON PURPOSE:
the header names who is signed in and cannot name the tenant. The review is
explicit that multi-tenant UI must not be invented, and `Session`
(`api/session.ts`) has a user and nothing else. The same shape stopped M23
short — `TestSummary.latestRun` is `{id, status, verdict}`, so the catalog can
fix the duplicated class string and cannot show the latest run's date or p95
without the contract widening M02 did for the run list.

**SCROLL RESTORATION IS KEYED ON `pathname` ALONE, AND THE SEARCH STRING IS THE
REASON.** A new path is a new thing and should start at its own top; a new
QUERY is the same thing asked again — the analysis window and the compare
selection both live there, and resetting scroll on every brush drag or
checkbox would be its own defect. The first render is skipped so a deep link,
including the decision band's own `#simulation-assertions`, still lands where
the browser puts it.

**AND TWO INTEGRATION RUNS FAILED WITH DIFFERENT TESTS EACH TIME, ONE OF THEM
AT LOAD 5.** `rules.integration.test.ts` at load 18, then `parity.e2e.test.ts`
plus `trends.integration.test.ts` at load 5.00 — each passing alone, and a
third full run green at 1645/1645. Low load does NOT rule out the flake this
file already documents; it only rules out the explanation. **Capture the full
output, not a `grep` of it**: the first of those runs was piped through one and
lost the assertion message, which is the only thing that separates a real
ordering defect from noise.

The run-page-reading-order branch after that added no unit case and TWO e2e
(**e2e rises to 108**); unit stays 138 / 1603 and integration 131 / 1638.

THREE THINGS FROM IT, AND THE LAST IS THE ONE TO READ.

**THE CHARTS WERE ORDERED BY WHICH QUERY PRODUCED THEM.** The tab opened with
two aggregates — a response-time range bar and a large OK/KO donut — and put
latency-over-time seventh, because `stats`, `users`, `distribution` and
`series` each rendered their own `Payload` in that order. A reader correlating
offered load against throughput, latency and failures scrolled past whole-run
summaries to reach the series and back again. The four time series are adjacent
now, in the order the question is asked. `CHART_IDS` in `run-charts.spec.ts` is
asserted as a LIST for this reason: a reorder that kept every figure present
would otherwise undo it silently.

**`compact` IS THE SPARKLINE MODE AND IT WAS THE WRONG TOOL FOR THE BRUSH.**
Reaching for it to shorten the time selector stripped the axis labels with
everything else — `TimeBrush.test.tsx`'s "labels that axis in seconds" went red
immediately, and rightly: a control you DRAG with no time labels gives the
reader no idea where they are. `navigator` is the middle setting — 160px, no
legend, axes kept — and the legend is the safe thing to drop because the chart
directly below names the same All/OK/KO.

**AND M01's ACCEPTANCE IS NOT MET, WHICH IS RECORDED RATHER THAN ROUNDED UP.**
Measured at 1440x900: the run's own totals began at **y=1570**; reordering the
Overview and shortening the brush took them to **y=1001**. The review asks for
them inside a 900px window. What is left is the decision band — **313px** at
that width — and making it materially shorter trades against the three separate
outcomes C02 put there and against the redesign's choice to make the verdict the
largest text on the page. That is a design decision, not a defect.

So the e2e case asserts the ORDER (which cannot regress silently — the tiles
contribute no heading, so the heading-outline case cannot see them) and a
geometry bound of 1100 (what was achieved), with the gap stated in its own
docstring. **A threshold set to the goal rather than the measurement would be
a failing test describing work nobody has agreed to do.**

The run-list-triage branch after that added no unit FILE and 6 cases
(`RunList.test.tsx`), from a floor of 138 / 1597; its integration floor is
**131 files / 1638 tests** (2 new cases in `read.integration.test.ts`) and its
e2e stays 106.

TWO THINGS FROM IT, AND THE FIRST IS WHY IT WAS CHEAP.

**THE LIST WAS ALREADY FETCHING WHAT IT NEEDED AND THROWING IT AWAY.**
`RunRepository.list`'s SQL selected `r.environment`, `r.branch`,
`r.commit_sha`, `r.duration_ms` and `r.tool_assertions` all along;
`RunListResponseSchema` picked NINE fields, so the rest died between the
repository and the wire. That is why a row could not be triaged without opening
it, and why "Needs attention" read zero over a run whose simulation had a
failing check — the outcomes were fetched and discarded. Only the statistics
needed a new join. **Check what a query already selects before adding one.**

**`RunListItem` IS AN INTERSECTION AT ONE RETURN TYPE, NOT A FIELD ON
`RunRecord`.** The first shape was `{ run, metrics }`, which broke every
existing `items[].id` in `repositories.integration.test.ts`. `RunRecord &
{ metrics }` keeps the canonical record free of a field that is null for
reasons peculiar to one query, AND leaves every caller working. The tally
rather than the array for the same reason: a corpus run declares hundreds of
assertions, and a page of 25 would carry every expression to render one number.

**AND THE BACKTICK TRAP BIT TWICE MORE, AN HOUR AFTER BEING WRITTEN DOWN.**
Two SQL comments in the new LEFT JOIN mentioned identifiers in backticks. The
list query is a template literal, so each one ended the string and failed two
lines later as `TS1005`. Writing the lesson down is evidently not the same as
remembering it: **no backticks in SQL comments, in any of these files.**

The review-majors branch after it added no unit FILE and 16 cases, from a
floor of 138 / 1582; its integration floor is **131 files / 1636 tests** and
its e2e stays 106. It took the MAJORS that state something false or unusable
and left the page-level redesigns alone.

FOUR THINGS FROM IT.

**A ZERO BASELINE IS A BASELINE.** `deltaPercent === null` covered three
different facts — nothing selected, nothing measured, and a baseline of ZERO
making a relative change undefined — and the tile rendered all three as
"Waiting for baseline". False for the third, and false in the case that
matters most: errors rising from 0 to 2/s is the regression an engineer most
needs to see, and it is exactly when the baseline is zero. The model carries
`deltaUnavailable` now and the tile says which.

**A SHARED LINK CARRIED THE RUNS AND NOT THE QUESTION.** `runs=` was
serialised; the metric was component state defaulting to p95, so a link to an
ERRORS comparison opened as p95 for whoever received it. It is in the URL now,
and an unknown value falls back rather than throwing — a URL is something
people hand-edit.

**THE ONBOARDING RECIPE COULD NOT BE RUN.** Project setup's curl example ended
in a bare `/v1/runs`; a shell does not resolve that against the page's origin,
so the first command anybody copies out of this product failed with "No host
part in the request URL". It carries `window.location.origin` now, which is
right for a custom domain and a port alike where a hard-coded localhost would
not be.

**TWO TRUE NUMBERS AN ORDER OF MAGNITUDE APART, NEITHER LABELLED.** The tab
counts distinct error MESSAGES ("Errors (2)") and the run totals count failed
REQUESTS (24), so a reader reconciling them assumes one is wrong. `ErrorsTable`
held both already — `rows.length` and the `total` it divides its shares by —
and now says which is which. And "Export run" became "Export SLA summary
(JSON)", because the file is identity, state, verdict and platform assertions
and nothing else: somebody attaching it to a review as evidence sent something
close to empty.

SIX THINGS FROM IT, AND THE FIRST FOUR ARE THE SAME SHAPE: A SENTENCE THE UI
STATED CONFIDENTLY AND WRONGLY.

**A SCOPED EMPTY RESULT IS NOT A WHOLE-RUN CONCLUSION.** `ErrorsTable` is
rendered by `RequestDetail` over a request-scoped payload, and its empty branch
said "No errors were recorded for this run" and "Every request this run made
came back OK" — on a request with no failures, inside a run with 24 of 895
failed. Not a broken screen: a precisely wrong sentence, read by somebody
checking whether a regression touched that request. The component cannot know
its own scope (the payload carries a runId and nothing narrower), so the caller
passes `scopeLabel` and the unscoped wording is untouched.

**`onChange(null)` IS NOT A NEUTRAL FAILURE — IT IS "THE WHOLE RUN".**
`TimeBrush.apply()` answered every unparseable, negative or reversed input with
it, so typing From=30 To=10 silently WIDENED the analysis instead of refusing
it. Of all the responses to bad input, a reset is the one that control must
never produce. It refuses now, keeps the reader's typing and the previously
applied window, and "Whole run" is still the deliberate way to widen.

**AN EMPTY THRESHOLD IS NOT ZERO, AND A SCHEMA CANNOT TELL THEM APART.**
`Number('')` is `0`, which is a legal threshold, so a blank SLA field authored
a real gate. `p95 <= 0` breaches on any run recording one request — the mirror
of the fraction trap recorded below, which silently PASSES forever. The check
has to happen before the conversion, in the raw string, because that is the
last place the difference still exists.

**A CONTROL OVER A SECTION THAT IGNORES IT IS A CLAIM ABOUT THAT SECTION.** The
brush lives in `RunShell`, so it sat above Trends and Compare, whose queries
are historical and take no window at all: it accepted 10–30s there, announced
it, and changed nothing. Withheld rather than disabled — a disabled control
still asserts that a window is a property of the page. The PARAMETERS still
travel, which is the other half: `useWindowSuffix` carries `from`/`to` across
every tab and into request/group drill-downs, so the selection survives the
whole investigation instead of being discarded on the first tab change. Only
`from`/`to` travel; Compare's `runs=` belongs to Compare.

**TWO SURFACES OF ONE SCREEN MEANT DIFFERENT POPULATIONS BY ONE WORD.** A
`SeriesBucket` carries THREE percentile maps — `percentiles`, `percentilesOk`,
`percentilesKo`. A `StatRow` carries exactly one, the combined set, and has no
OK-only variant at all. The compare OVERLAY read `percentilesOk` while
`metricValue` — which feeds the comparison matrix AND the summary tiles
directly above that overlay — read `row.percentiles`. Combined is the only
population all three CAN share without a backend change, so it is the one they
share, and the chart's `limitation` says which it is.

**AND THE POPULATION MIX-UP HID A REAL HOLE IN THE LINE.** `max` read
`bucket.maxMs`, a COMBINED extremum, from behind a guard on `percentilesOk`
being empty — so a bucket in which every request failed has no OK percentiles,
a perfectly real maximum, and lost it. The overlay dropped the slowest
measurement in exactly the buckets a regression hunt cares about most, with
nothing thrown. **Order of branches, not arithmetic**: `max` comes before the
percentile guard now.

**A BREAKPOINT THAT ALSO MOVES THE LAYOUT AROUND IT IS THE WRONG QUESTION.**
`RunDecisionBand` went three-up at `lg:` — 1024px of VIEWPORT, which is also
where `ProjectRail` appears. So it took its widest layout at the exact moment
it lost ~270px to the sidebar. Measured at 1024x900: tracks resolved to
`338px 0px 336px`, the middle column collapsed to ZERO, and its explanation
overflowed across the action column starting at the same x — 395px tall and
unreadable. It is an `@container` query now, so the question is the width the
BAND has: 309px and single-column at 1024, 190px and three-up at 1280, 151px at
1440, no overlap at any of them. `minmax(14rem,1fr)` rather than
`minmax(0,1fr)` for the explanation, because a zero minimum is what let the
other two tracks take the whole row. **jsdom lays everything out at 0x0**, so
every unit assertion over this component passed throughout — the same reason
the `m-auto` dialog and the `truncate` rail needed Playwright. The e2e guard
was verified red at 1024; at 1280 it PASSES against the original with this
fixture, so that half is a regression guard rather than a reproduction.

**SHORT LABELS OVER ONE SYSTEM'S COUNTERS READ AS OVERALL HEALTH.** Both demo
runs showed "Not evaluated — 0 passed · 0 failed" because those are
PLATFORM-SLA counters and neither project had configured a rule; both also had
FAILING assertions the simulation declared for itself, far below the fold. The
band states three facts separately now — execution, platform gates, simulation
checks — and links to the first failing check. It deliberately does NOT fold
simulation results into the release verdict: a platform gate is the
organisation's policy and a simulation assertion is the test author's, and
merging them makes the gate mean something nobody configured.

`evaluated` was `assertions !== undefined`, so an EMPTY array counted as
evaluated and produced "0 passed · 0 failed" — the three zeros that read as
health. For that row `[]` now says "not configured", because nothing judging a
run is not the same as nothing failing.

**AND THE RUN LIST CANNOT COUNT SIMULATION CHECKS AT ALL.**
`RunListResponseSchema` picks nine fields and none carries assertions, so
"Needs attention: 0" over a run with a failing check is not a bug in the tile —
it is the tile claiming more than its data. It says which systems it counted
now. The COUNT needs a field the list endpoint does not have; that is a backend
change and is not in this branch.

**A COHORT IS NOT A CONTROLLED EXPERIMENT.** `TRENDS_SQL` groups completed runs
by (project, test) — same simulation, nothing about the conditions. The same
test runs against staging and production at very different offered loads, and
a p95 that fell because the load halved was presented as "Best selected".
`TrendRun` carries `environment`, `branch` and `commitSha` now, and
`comparability.ts` reports them beside throughput, request count and duration,
BEFORE the deltas.

**THOSE THREE ARE `nullable().optional()`, AND THE OPTIONAL HALF IS THE
LOAD-BEARING ONE.** The browser drops any body that fails the schema, so
`nullable` alone would make a response from an API pod that predates the fields
fail to parse — blanking the compare page for a whole rolling deploy rather
than degrading it. Same trap `live-delta.ts` already carries cases for;
`contracts.test.ts` pins it for trends before somebody tidies the optionality
away as redundant.

**UNKNOWN IS NOT COMPATIBLE.** `undefined` means the server does not report it
and `null` means the run did not record it; neither is evidence two runs agree,
so both read "unknown" and neither is ever counted as matching. A comparison
where every VISIBLE value agrees but something is missing still tells the
reader to look.

**AND A SQL COMMENT CANNOT CONTAIN A BACKTICK.** `TRENDS_SQL` is a template
literal, so a `--` comment mentioning `TrendRunSchema` in backticks ended the
string and produced `TS1005: ',' expected` two lines later.

**AND ONE THING THE WINDOW STILL CANNOT DO.** `/v1/runs/:id/errors` takes no
`from`/`to` — deliberately, per that handler's own comment — while its sibling
`errors/series` does. So a window narrows the errors CHART and leaves the table
beneath it reporting the run's own totals. Windowed error aggregation is a
backend change; `ErrorsTable` says which it is meanwhile, and the empty state
is where that matters most, because "no errors" beside a visible 10–30s
selection reads as "none in that interval".

FIVE THINGS FROM IT, AND FOUR OF THEM WERE BROKEN BY THE WORLD RATHER THAN BY
A COMMIT HERE.

FIRST, **`infra/` IS IN NO GATE, AND EVERYTHING IN IT HAD ROTTED.** `pnpm
lint`, `pnpm typecheck` and every `pnpm test:*` are blind to
`infra/docker-compose.yml` and `infra/Dockerfile` exactly the way they are
blind to `agent/` and `clients/gatling-gradle/` — and unlike those two, `infra/`
had no gate of its own at all. Measured on an untouched checkout, all four of
these were true at once:

  - `docker compose -f infra/docker-compose.yml up -d`, the command BOTH
    READMEs open with, failed before starting a container:
    `required variable PERFPORTAL_RUNNER_ORG_ID is missing`. Compose
    interpolates the WHOLE file before it decides which profiles are active,
    so a `${VAR:?}` inside a service behind the `onprem` profile aborts the
    base command too. **Every onprem-only variable must be `${VAR:-}` and
    validated by the process that needs it.**
  - the image did not build: Debian pruned `openjdk-21` from
    `bookworm-backports`. A `-backports` suite is by definition not stable
    over time, so pinning a runtime to one was always a build that would fail
    on somebody else's schedule. It is `node:22-trixie-slim` now, where
    openjdk-21 is in `main`.
  - the image did not build for a SECOND reason behind that one: the Gatling
    3.15.1 bundle has no `lib/` directory. It is a Maven project now — `pom.xml`,
    `mvnw`, a pre-populated `.m2/repository` — so `find … -name lib` returned
    nothing and the step died at exit 1 with no message, one line after the
    checksum had printed `OK`.
  - the image built with a FLOATING pnpm: `corepack enable` with no pin
    resolved pnpm 11 against a lockfile written by pnpm 9, and failed with
    `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH`. `package.json` now carries
    `packageManager: pnpm@9.15.0`, which also means `pnpm/action-setup` must
    NOT be given a `version:` input — it refuses both at once.

There is a `compose` CI job now that runs `docker compose config` with only the
three documented variables exported, builds the image, and RUNS what the image
is built to carry (java, the Gatling runtime, and a production start with no
auth secret). **Do not add anything to `infra/` without adding its check
there**; the whole cost above was paid for a file nothing ran.

**AND THE SECOND THING IN `infra/` GOT ITS OWN JOB RATHER THAN A LINE IN THAT
ONE.** `infra/clean-test-residue.sql` deletes the orgs `pnpm test:e2e` leaves
behind — that suite seeds through the real API and, unlike `test:integration`,
never truncates. Measured 2026-09-12 on this machine: **1793 orgs, 2933 runs,
1792 logins and 1,159,383 metrics rows**, in a database `VACUUM (FULL,
ANALYZE)` then took from **728 MB to 10 MB**. It deletes by FIXTURE PATTERN
(`org-<hex8>`, `acme-<uuid>`), never by "everything except X", so running it
against real data is a no-op rather than a catastrophe.

The `test-residue` job is separate from `compose` because what breaks that
file is a MIGRATION, not an edit to it — so it needs a migrated schema, which
means a Postgres service `compose` does not have.

**SIX TABLES CARRY `org_id` AND ARE NOT REACHABLE FROM `org` BY ANY CASCADE**:
`run_stat`, `run_error`, `run_error_bucket`, `run_series_bucket`,
`run_user_bucket`, `telemetry_sample` — partitioned and deliberately FK-free
for write throughput. `DELETE FROM org` does not touch them, and
`schema.prisma` reads as though it would. `infra/test/fk-free-tables.sql`
computes the CASCADE closure from `pg_constraint` and the job fails if a
seventh table appears that the script does not name — the one drift no human
will notice, because nothing raises when those rows are orphaned.

**THE ORDER OF THE DELETES IS NOT WHAT MAKES IT CORRECT, AND THE FIRST VERSION
OF THAT COMMENT SAID IT WAS.** Capturing the org ids in a temp table up front
is; measured, the deletes can then be reordered freely with identical results.
What actually breaks is resolving the org set INLINE and deleting orgs first —
the subqueries match nothing, nothing raises, exit 0.
`infra/test/residue-broken.sql` is exactly that shape, and the job re-runs the
same assertion against it and fails if it PASSES. An assertion nobody has
watched fail is a guess.

**THE OBJECT STORE IS A SECOND RESIDUE, AND `test:integration` HAS NEVER
TOUCHED IT.** That suite truncates the DATABASE on setup; it has never removed
an S3 bucket. `packages/storage`'s two integration files each create a
`test-${randomUUID()}` bucket, and measured 2026-09-12 there were **8 stale
buckets holding 4,896 objects**. `infra/clean-test-buckets.mjs` removes them,
by the same pattern-not-keep-list rule, and refuses the configured bucket a
second time by NAME as well as by pattern.

Two things it cost, both of which will recur:

**A BARE `import '@aws-sdk/client-s3'` FROM `infra/` CANNOT RESOLVE, HOWEVER
YOU INVOKE IT.** The SDK is a dependency of `@perfportal/storage`, not of the
root, and pnpm does not hoist. Node resolves a bare specifier relative to the
importing FILE, so `pnpm --filter @perfportal/storage exec node …` does not
help either — it changes the working directory, which resolution never
consults. `createRequire(new URL('../packages/storage/package.json',
import.meta.url))` is what actually resolves it.

**`DeleteObjects` FAILS AGAINST THE COMPOSE MinIO WITHOUT AN EXPLICIT
Content-MD5.** RELEASE.2024-09-13 still enforces the legacy requirement, and
aws-sdk 3.1105.0 sends a CRC32 trailer instead: `MissingContentMD5`, nothing
deleted. The documented client option `requestChecksumCalculation:
'WHEN_REQUIRED'` does NOT fix it — measured. Hashing the serialised body in a
`build` middleware does, verified at 1000 objects in one request. The whole
sweep then runs in **1.1 seconds**; one `DeleteObject` per key would have been
~120k round trips.

The bucket half needs no deliberately-broken fixture because
`infra/test/buckets-fixture.mjs` asserts BOTH directions — a script that
deletes nothing fails on the test bucket still existing, one whose pattern
grew too broad fails on the real bucket or its object being gone. Both
branches were red-verified by hand. **The first attempt at that
red-verification proved nothing**: the test-bucket check fires first, so
deleting the real bucket without also cleaning the test one fails on the wrong
assertion and reads as a pass for the branch you meant to exercise.

**A THIRD RESIDUE LIVES INSIDE THE REAL BUCKET, AND IT IS THE BIGGEST.**
Measured 2026-09-12: **129,465 objects / 48.2 MB against ONE surviving run**,
swept to 1 object by `infra/clean-orphaned-objects.mjs`. Most of it is not a
bug — `LiveChunkStore.finalize` deletes a run's chunks after writing the
assembled log, and when that delete fails it says so and leaves the debris
"for a lifecycle rule to reap". There is no lifecycle rule on the compose
MinIO. That script is the reaper.

**THE TWO KEY SHAPES ARE NOT KEYED THE SAME WAY, AND THIS IS THE TRAP:**

```
live/{runId}/{offset}.bin     packages/storage/src/live-chunks.ts
runs/{projectId}/{uuid}.tgz   apps/api/src/ingest/ingest.service.ts
                 ^^^^^^^^^ PROJECT id, not run id
```

The obvious rule — "the uuid after the prefix is the run" — is right for
`live/` and WRONG for `runs/`, where it would delete every bundle of a project
whose id never appears in `run.id`. The `runs/` rule therefore parses nothing:
`run.bundle_key` stores the FULL object key, so that column is an exact
keep-list, and it disposes of storage's own `runs/test/…` and `runs/collide/…`
fixtures for free. Both shapes were read out of the source. **This was caught
by checking the writers before writing the sweep, not by a test** — a sweep
built on the inferred rule would have passed every assertion that only looked
at `live/`.

**IT IS DRY-RUN BY DEFAULT, UNLIKE ITS TWO SIBLINGS.** They delete by a pattern
only a fixture can produce, so their worst case is doing nothing. This one
deletes from the bucket holding real bundles, and its keep-list is computed
from live database state — the wrong `DATABASE_URL` makes every rule compute
the right answer to the wrong question. It also **refuses outright** when the
run table is empty, because that state classifies every object as orphaned and
is far more likely to be a mis-pointed URL, or a database a test run has just
truncated, than a real instance.

**THE AGE GUARD IS WHAT MAKES THE SNAPSHOT RACE SAFE** (default 24h): the
database is read before the bucket is listed, so a run opened mid-sweep has no
row yet and its chunks look orphaned. CI passes `--min-age-hours 0` because
every fixture object is seconds old and the default would exempt all of them —
the step would pass while deleting nothing — and a separate step runs the same
seed at the default age asserting everything SURVIVES.

FOUR THINGS THE CROSS-BROWSER SUITE COST TO SET UP, AND ALL FOUR WILL RECUR.

**`test:e2e:cross` IS `--workers=1`, AND THAT IS MEASURED RATHER THAN
CAUTIOUS.** At the default (5 workers here) it failed 19, then 7, then 9 — a
DIFFERENT set each time, drifting between Firefox and WebKit, always timeouts
or a chart that missed its 5s window. Serial: **303 passed, 3 skipped, 0
failed, and FASTER** (6.7 min against 8.8), which is what contention looks
like. Three engines is three times the Chromium suite's load, and CLAUDE.md
already records that that one is unreliable at its default here. A chart that
"did not draw" in one engine and drew in the other two is a worker-count
symptom, not a rendering bug — check it alone before believing it.

**AND THE TWO RUNS THAT LOOKED LIKE THEY PROVED THE WORKER COUNT PROVED
NOTHING, BECAUSE THE FLAG NEVER APPLIED.** `pnpm test:e2e:cross -- --workers=2`
SILENTLY DROPS THE FLAG — pnpm eats the `--` — and both runs reported
`Running 306 tests using 5 workers` while being described as constrained. The
19 → 7 "improvement" was the skip-link scoping plus noise. Write it as
`pnpm test:e2e:cross --workers=1`, with no `--`, and **read the runner's own
`Running N tests using M workers` line back** rather than trusting that an
argument arrived.

**AND AN EMULATED `colorScheme` DOES NOT REACH FIREFOX UNDER THE RUNNER.**
Measured on Playwright 1.62.1 against a minimal spec with no fixtures and no
sign-in:

```
                      chromium  firefox  webkit
page.emulateMedia       true     false    true
test.use colorScheme    true     false    true
```

The same two calls through the LIBRARY api (`firefox.launch()` →
`newContext()`), including with `devices['Desktop Firefox']`, report true. So
`matchMedia('(prefers-color-scheme: dark)')` is genuinely false in the harness
and the app painting its LIGHT background is CORRECT for what the browser told
it — `run-charts.spec.ts`'s dark-mode case would be testing the runner. It is
skipped on Firefox and still covered by the other two. **Before believing a
theme assertion in a new engine, ask the page what `matchMedia` returns.**

**`PERFPORTAL_E2E_PORT` MOVES FOUR THINGS, NOT THREE.** `playwright.config.ts`
owns `baseURL`, `webServer.url` and the server's own `PORT`; `fixtures.ts`
owns its own copy, because it seeds over plain `fetch` and can never see
`baseURL`. Moving three of them sent the browser to 3100 and the seeding to
3000 — where an unrelated project was listening — and 214 of 306 specs failed
with `POST /v1/runs expected 202, got 404` naming somebody else's server. The
port is worth having because `reuseExistingServer` is deliberately false, so
anything at all on 3000 fails the whole run before a single spec.

**`test.skip(fn, reason)` AT FILE SCOPE SKIPS THE FILE.** Reaching for it to
exempt ONE test from one engine silently drops that whole spec file on that
engine. It belongs inside the test body, taking `browserName` from the
fixture. `--list` is the check: `project-rail.spec.ts` collects 21 across
three engines either way, and only a runtime skip leaves it at 21.

A SEVENTH THING, AND IT IS THE ONE MOST LIKELY TO WASTE SOMEBODY'S AFTERNOON.
**THE ANONYMOUS-VOLUME BUG ABOVE IS WHAT EVENTUALLY BREAKS THE INTEGRATION
SUITE ON A LONG-LIVED MACHINE, AND IT DOES NOT REPORT ITSELF.** Postgres and
MinIO had no `volumes:` key, so every container replacement orphaned one
anonymous volume apiece. Measured here after months of that:
`/var/lib/docker/volumes` inside the Docker VM held **3,317,759 of the
filesystem's 3,907,584 inodes**, against 533,119 for every image layer
combined. `df -h` said 22 GB free — and there were about twenty thousand
inodes left. The suite then failed 36 files at once with

```
error: could not create file "base/16384/64222": No space left on device
XMinioStorageFull: Storage backend has reached its minimum free drive threshold
```

which is the everything-is-broken shape this file already documents for a full
disk, from a disk that is 60% empty. **`df -i` is the check, not `df -h`**:

```
docker run --rm --privileged --pid=host alpine \
  nsenter -t 1 -m -u -n -i df -i /var/lib
```

`docker volume prune -f` is the fix, and it takes many minutes because it is
deleting millions of small files. `docker builder prune` and `docker image
prune` do NOT touch it — both were run first here, reclaimed 4 GB of bytes, and
moved the inode count by nothing.

AN EIGHTH THING, AND IT IS A PRODUCT DEFECT THAT ONLY A THIRD ENGINE COULD
FIND. **`secure: true` ON THE SESSION COOKIE MEANT NOBODY COULD SIGN IN TO A
LOCAL INSTANCE IN SAFARI.** Adding the WebKit e2e project turned 98 of its 102
specs red; 95 of the 98 page snapshots are the LOGIN FORM, which is what every
authenticated route renders when the session never established. A
three-engine probe against a plain-HTTP loopback server setting one `Secure`
cookie says it in one line each:

```
chromium  cookie:pp_session=abc
firefox   cookie:pp_session=abc
webkit    cookie:(none)
```

Chromium and Firefox treat loopback as a trustworthy origin and store it;
WebKit does not. `cookiesAreSecure` now exempts `localhost`, `127.0.0.1` and
`[::1]` and NOTHING else — a plain-HTTP deployment reachable by hostname still
gets `Secure` and still fails closed, which is the property worth keeping.
`auth-cookies.test.ts` asserts both halves, because a test that only checked
the exemption would pass just as happily against `secure: false` everywhere.

**`URL.hostname` KEEPS THE BRACKETS ON AN IPv6 LITERAL** — it is `[::1]`, not
`::1`. The first version of that comparison used the unbracketed form and only
the `http://[::1]:3000` case caught it.

**THE GENERAL LESSON IS ABOUT WHAT ONE ENGINE CANNOT TELL YOU.** Every unit
test, every integration test and 102 Chromium e2e specs were green while a
whole browser could not log in. Adding an engine is not redundant coverage; it
is the only thing that can see a decision a spec leaves to the implementation.

**AND SOME OF WHAT IT SEES IS THE OPERATING SYSTEM, NOT THE PAGE.** Whether
Tab reaches a LINK is a macOS keyboard-navigation preference, and the three
engines ship different defaults — measured against a two-element page on a
real origin:

```
chromium  Tab order: lnk → btn
firefox   Tab order: btn → btn        ← the link is skipped
webkit    Tab order: (body) → (body)  ← nothing is focusable by Tab
```

So `project-rail.spec.ts`'s skip-link test is Chromium-only, and that is not a
gap in the product: the markup is correct, and a keyboard user with full
keyboard access on gets the link in every engine. Weakening the assertion to
`focus()`-then-check would pass everywhere and stop testing the thing that
matters, which is that the skip link is the FIRST stop.

SECOND, **FLATTENING A MAVEN REPOSITORY IS NOT THE SAME AS RESOLVING ONE.**
The obvious fix for the Gatling bundle was to copy every jar out of its
`.m2/repository` into one directory. That repository is what Maven needs to
BUILD the demo project, so it carries the build toolchain too: 301 jars
including THREE `slf4j-api` versions. Flattened, `-cp lib/*` picked 1.7.32 and
Gatling started with `Failed to load class org.slf4j.impl.StaticLoggerBinder …
Defaulting to no-operation (NOP) logger` — a run whose logging was silently
dead, from a step that looked like it had worked. Letting the bundle's own
`mvnw` do `dependency:copy-dependencies -DincludeScope=test` offline gives 95
jars, 52 MB, one slf4j and logback bound. **`-DincludeScope=test`, not
`runtime`**: Gatling's own archetype declares `gatling-charts-highcharts` at
`test` scope, so `runtime` resolves to an EMPTY directory and reproduces the
"Could not find or load main class" the whole step exists to prevent.

THIRD, **A `role` IS A PROMISE, AND HALF-KEEPING IT IS WORSE THAN NOT MAKING
IT.** `ThemeToggle` shipped `role="radiogroup"` with three `role="radio"`
buttons and no arrow-key handling, on the reasoning that three tab stops cost
less than an interaction with no browser test over it. A screen reader
announces "radio button, 1 of 3" and its user then presses an arrow key,
because that is what the role means; nothing happened. Three plain buttons
would at least have been honest. It has a roving tabindex now
(`ThemeToggle.test.tsx`, 9 cases), and the case that matters most asserts
FOCUS moves and not just `aria-checked` — a roving tabindex that never moves
focus leaves the caret on a segment that is no longer the tab stop.

FOURTH, **THE CSP's `script-src` HASH IS COMPUTED, NEVER WRITTEN DOWN.**
`index.html` carries an inline theme script on purpose (it is the pre-paint
write that avoids the white flash), so a policy with `script-src 'self'`
blocks it — and the symptom is a flash plus a console error nobody is
watching for, with no test failing. `security-headers.ts` reads the built
`index.html` at boot and hashes what is actually in it, so those five lines can
change freely. `style-src` DOES keep `'unsafe-inline'`, and that is the
weakest line in the policy: ECharts writes inline `style` attributes on every
render, up to ten charts per run page, so the choice is that or no charts.
The e2e case that guards all of it reads the CONSOLE while the real bundle
boots — header assertions cannot tell you whether a browser could still run
the page.

FIFTH, **`vitest/globals` USED TO IMPLY `@types/node`, AND STOPPED.**
`apps/web/test/tsconfig.json` listed `"types": ["vitest/globals"]` and
`palette`, `paths`, `tokens` and both `transforms.*` suites resolved
`node:fs` and `process` through it by accident. Under Vitest 4 they all stopped
compiling at once with `Cannot find module 'node:fs'`. Those suites read source
files off disk deliberately — `paths.test.ts` reads `App.tsx`, `tokens.test.ts`
reads the emitted CSS — so the dependency is real and is now declared.

A SIXTH THING IS NOT A LESSON BUT IT WILL COST SOMEBODY AN HOUR: **`pnpm audit
--prod` is a CI gate now**, and the four `pnpm.overrides` in `package.json`
plus the Vitest 2→4 upgrade are what took it from 1 critical / 6 high / 7
moderate to zero. The vitest chain reached the PRODUCTION graph because
`better-auth` declares `vitest` as an OPTIONAL PEER and pnpm satisfies it from
the workspace root's dev copy — so the repo's own test runner was, by pnpm's
reckoning, a production dependency of `apps/api`. Vitest 4 pairs with the
vite 8 `apps/web` already had, so there is now one vite in the tree instead of
two.

Before that, the sla-threshold-unit branch added no
unit FILE and 17 unit cases — 14 to `packages/contracts/test/rules.test.ts`
(one is an `it.each` over the seven scalars) and 3 to
`apps/web/test/ProjectRules.test.tsx` — from a floor of 133 / 1466. Its
integration floor was **127 files / 1568 tests** (that `rules.test.ts` is a
`.ts` file integration runs too) and e2e was 101.

ONE THING FROM IT, AND NO TEST COULD HAVE FOUND IT.

**A UNIT THAT ONE SURFACE SHOWS AS A PERCENTAGE AND ANOTHER TAKES AS A
FRACTION IS A GATE THAT NEVER FIRES.** `errorRate` is `koCount / count`, so
0.1775. Every read surface renders it `17.75%`. The SLA rule form took a bare
number, so an author who typed `1` meaning "one percent" authored `≤ 100%` —
valid, resolvable, evaluated on every run, and PASSED forever. Found by doing
exactly that while demonstrating the feature; the gate behaved CORRECTLY for
the value it was given, so nothing failed and no test could have.

The fix is to make the unit a fact code can read (`SLA_METRIC_UNITS`,
`slaMetricUnit`) rather than a sentence in a doc comment, and to put it in the
LABEL rather than a placeholder — a placeholder disappears the moment the
author types, which is exactly when they are choosing the number.
`slaThresholdWarning` then names the number to type instead, because a warning
that only disapproves leaves the reader with the arithmetic that confused them.
**A schema could not have refused it**: 100% is a legal bound, so validation
was never available and telling the author was the only defence.

While proving the colour, `text-status-pending` turned out to emit NOTHING —
the status tokens are declared on `:root`, not inside `@theme inline`, so
Tailwind generates no utility for them. That is the trap this file already
records one section down, met in the wild; `StatTile` and `RunList` reference
them as `var(--color-status-pending)` for exactly this reason.

Before that, the runner-runs-a-real-jar branch added
TWO unit files — `packages/storage/test/gatling-jar.test.ts` (8) and
`apps/runner/test/artifact.test.ts` (8) — from a floor of 131 / 1450. Its
integration floor is **127 files / 1554 tests** (both of those are `.ts` files
integration runs too, plus a new `apps/api/test/runner.integration.test.ts`
(5)) and e2e stays 101.

FOUR THINGS FROM IT, AND THE FIRST IS THE PRODUCT MODEL.

FIRST, `gatlingEnterprisePackage` BUILDS A THIN JAR ON PURPOSE, AND WHOEVER
RUNS THE TEST SUPPLIES THE FRAMEWORK. That command — the one Gatling's own
documentation gives you — packages your simulations and your dependencies and
NOT ONE BYTE of Gatling, because Gatling Enterprise lends the runtime at
execution time. Measured on a real one: 1.8 MB, zero `io/gatling/**` entries,
and a manifest saying `Gatling-Version: 3.15.1` /
`Gatling-Simulations: example.AssertionCorpus,example.BasicSimulation`.

The runner ran `java -cp <uploaded.jar> io.gatling.app.Gatling`, which only
works for a fat jar — so the artifact a reader is most likely to produce died
with `Could not find or load main class io.gatling.app.Gatling`. `Gatling jar`
was the form's DEFAULT and the README called it "a fat jar", which nothing in
the product said and no ordinary build produces. The runner lends a runtime
now (`RUNNER_GATLING_HOME`, baked into `infra/Dockerfile`), and only to a jar
that carries none — `readGatlingJar().carriesRuntime` decides, so a fat jar is
launched exactly as before rather than having a second Gatling appended to its
classpath.

SECOND, THREE BREAKAGES WERE STACKED, EACH HIDDEN BY THE ONE IN FRONT. Fixing
the classpath only revealed the missing `--add-opens`; fixing that only
revealed that `infra/Dockerfile` shipped `openjdk-17-jre-headless` while a
current packager emits class file version 65 (`UnsupportedClassVersionError …
only recognizes class file versions up to 61.0`). **Do not conclude a path
works because the first failure went away** — re-run to a real result. The
image installs Java 21 from bookworm-backports now, and a JVM runs older
bytecode happily, so raising that floor cannot break an artifact that already
worked.

THIRD, `SIMULATION_LOG_NOT_FOUND` IS A CATCH-ALL WEARING A SPECIFIC
REMEDIATION. All three failures above surfaced as "Gatling finished without
producing a simulation.log file. Confirm the simulation class is correct…" —
one message covering a typo'd class, a jar with no runtime, a JVM too old and
a dead process, naming only the first. Two of the three now fail earlier and
by name (`GATLING_RUNTIME_REQUIRED`, `GATLING_VERSION_MISMATCH`), and a typo is
refused at UPLOAD against the manifest's own `Gatling-Simulations` — an
instant 400 listing the real classes, which is what Gatling Enterprise does
with the same header. **When a message can mean four things, the fix is more
errors, not better wording.**

FOURTH, THE PURE-PACKAGE LINT RULE FORCED A BETTER SHAPE. The jar reader
started life in `@perfportal/core` and `no-restricted-imports` rejected
`node:fs/promises` there ("Pure packages must not touch the filesystem",
`packages/{core,plugin-gatling,statistics,sla}/src/**`). Splitting it was
strictly better than exempting it: `core` decodes zip over a
`ReadAt` callback with no idea where bytes come from, `@perfportal/storage`
supplies the file-backed one beside its existing `bundle.ts`, and the parser
became testable from a Buffer. **When that rule fires, the import is usually
telling you the module is two modules.**

THREE THINGS FROM IT, AND THE FIRST CORRECTS WHAT THE ENTRY BELOW THIS ONE
CLAIMED.

FIRST, `metadata.test` REACHED ONE SUBMIT PATH, NOT THREE. The entry below
said it "shipped on three: the bundle upload, the live open and the Gradle
plugin", and the runner branch after it said it closed the fourth. Measured by
running each path against a real stack, only the BUNDLE UPLOAD ever worked.
`RunRepository.createLive` declared `declaredTestSlug` in `CreateLiveRunInput`
and never wrote it to the `data` block — `create` (upload) had the line eleven
lines up and `createLive` did not — so the live open, the plugin's live mode
and the runner all silently fell back to grouping by simulation class. That is
the exact behaviour declaring a test exists to REPLACE, which is why nothing
looked wrong: every run still landed on a test, just not the one it named.

THE RUNNER WAS BROKEN TWICE OVER, and the second cause is the transferable
one. **A CONDITIONAL SPREAD IS A HOLE IN TYPE CHECKING.** `live-sink.ts` built
its metadata as `...(job.job.testSlug ? { test: job.job.testSlug } : {})`, and
the field is `declaredTestSlug` — `test` is not a member of
`CreateLiveRunInput` at all. It compiled, because TypeScript's
excess-property check applies to object LITERALS and a spread is not one. So a
mistyped key inside a spread is accepted in silence, forever. Naming the four
frozen-metadata keys directly in the literal (`environment: job.job.environment
|| undefined`, and so on) is what puts them back in front of the compiler;
verified by re-introducing the typo and watching `tsc` reject it with
`'test' does not exist in type 'CreateLiveRunInput'`. **Grep for
`...(x ? { … } : {})` before trusting that a field reaches its repository.**

SECOND, EVERY GATE WAS GREEN AND THE FEATURE HAD NEVER WORKED. Unit, integration,
e2e, typecheck and lint all passed on all four branches that built this feature.
`test-entity.integration.test.ts` drove `resolveTestId` directly and proved it
honours a declared slug — with the slug handed to it by the test itself. **A
test that supplies the value it is checking proves the CONSUMER, never the
seam.** The two integration cases added here read the ROW back instead
(`run.declared_test_slug`), which is the only witness available at open time:
a freshly-opened live run has no RESOLVED test yet by design, so `GET
/v1/runs/:id` reports `test: null` whether the declaration was stored or not,
and so does the 201 body. Both cases were verified red against the original
`createLive`.

THIRD, WHAT FOUND IT WAS A REAL GATLING RUN AND NOTHING ELSE COULD HAVE.
Submitting a bundle through `POST /v1/projects/:slug/runner/runs` with
`test: "checkout-soak"`, letting the real runner claim it, extract it and
stream `simulation.log`, then reading three columns: `runner_job.test_slug`
was `checkout-soak`, `run.declared_test_slug` was NULL, and `run.test_id`
pointed at `example-paritysimulation`. That is a ten-minute check that no
amount of suite-writing substitutes for.

**A field added to ingest metadata has FOUR homes, and they are easy to
enumerate**: `IngestMetadataSchema` (bundle upload), `OpenLiveRunRequestSchema`
(live), `RunnerJobRequest` (on-prem), and the Gatling plugin's
`VantrixExtension`/`ResolvedConfig`. Check all four before calling one of them
done — and check them by RUNNING each one, because all four of these had
schemas, plumbing and passing tests while three of them dropped the field.

**A `POST /v1/runs` IN A TEST COSTS 25 SECONDS UNLESS IT SAYS `waitMs: 0`.**
The handler waits `INGEST_WAIT_MS` (default 25s) for a terminal verdict, and
no worker runs inside the API's own test process — so the wait always expires.
A two-post case therefore takes 51 seconds while asserting something written
before the first response: measured at 51,687ms, and 1,167ms with `waitMs: 0`
added. `ingest.integration.test.ts`'s "does not update provenance on an
idempotent re-post" is still paying it, and is the likeliest candidate whenever
that suite reports `Test timed out in 60000ms` with no other explanation —
51s of deliberate waiting leaves 9s of headroom for a loaded machine. Any new
case there that does not need a verdict should say so.

**THE ON-PREM RUNNER NEEDED `--add-opens` ON JAVA 17+ AND DID NOT PASS IT —
FIXED IN THE BRANCH ABOVE, and the mechanism is worth keeping.**
`prepareGatlingRun` built `java … -cp … io.gatling.app.Gatling` with only the
operator's `javaOptions` and system properties; Gatling's own `gatling.sh` and
the `io.gatling.gradle` plugin both add JVM opens that launching the class
directly loses. Without `--add-opens=java.base/java.lang=ALL-UNNAMED`
(measured: that one alone is sufficient for 3.15.1, and `DEFAULT_JVM_OPTIONS`
mirrors Gatling's fuller set so a feature needing another does not fail here
while working under `gatling.sh`) every job died before writing a byte:

```
java.lang.IllegalAccessException: module java.base does not open java.lang
  at io.gatling.core.stats.writer.StringInternals.<clinit>
```

**Operator options are appended AFTER the defaults**, so `javaOptions` can
still override them — a default appended last would silently win over the
operator, which is the opposite of what a per-job field is for.

**THAT FLAKE IS FIXED, AND THE CAUSE GENERALISES.** `ProjectRail.test.tsx`'s
"lists every project as a link to its own page" failed 3 of 4 full `test:unit`
runs and passed alone every time, reporting `Unable to find role="link" and
name /Checkout Flow/` after ~1.8s. The file DOES call `afterEach(cleanup)`, so
it was not the leak this file diagnosed earlier.

**`testTimeout` was 30s and Testing Library's `findBy*` gave up at 1s.** The
suite was willing to wait thirty times longer for a TEST than for the query
inside it, and that gap is a flake generator: the rail's fetch stub resolves
with `Promise.resolve`, so nothing there can be slow except the machine failing
to schedule a render within a second. `apps/web/test/setup.ts` now sets
`asyncUtilTimeout: 5_000`.

It cannot hide a real failure, only delay one — `findBy*` retries and then
throws the identical message, five seconds later instead of one. What changed
is the verdict on a render that WOULD have succeeded given a moment more.
Measured: three consecutive clean `test:unit` runs at load averages of **102,
89 and 127**, well above the ~40 this file calls untrustworthy.

The setup file lives under `apps/web/test/` and not at the root because
`configure` comes from Testing Library, a dependency of `apps/web` and not of
the workspace root — a root-level setup file fails to resolve it outright. It
deliberately does NOT register a global `cleanup`; see its own docstring.

Before that, the test-per-configuration branch added
no unit FILE and 8 unit cases to `packages/contracts/test/contracts.test.ts`,
from a floor of 130 / 1438. Its integration floor is **123 files / 1525 tests**
(that `contracts.test.ts` is a `.ts` file integration runs too, plus 6 net new
in `apps/worker/test/test-entity.integration.test.ts` — 7 added and 1 deleted —
and 3 in `verdict.integration.test.ts`) and e2e stays 101.

TWO THINGS FROM IT.

FIRST, DROPPING A UNIQUE INDEX MOVES CORRECTNESS OUT OF THE DATABASE AND INTO
THE APPLICATION, AND A TEST THAT MIRRORED THE SQL STOPS BEING VALID.
`test-entity.integration.test.ts` held a verbatim copy of the worker's upsert,
drove it directly, and had a separate case reading `test-resolver.ts` to prove
the copy had not drifted. That worked while the SQL WAS the whole rule: the
upsert conflicted on `(project_id, simulation_class)`, so running it twice for
one class was idempotent all by itself.

With that index gone the conflict target moved to `(project_id, slug)` — and
the upsert alone is no longer idempotent per class. Run it twice and the
candidate CTE picks `example-paritysimulation-2` the second time, because the
base slug is taken and nothing has looked for an existing test of that CLASS.
The SELECT that precedes it is what makes the whole thing idempotent now. The
mirror and its drift guard are deleted, and the file calls `resolveTestId`
directly — which is only possible because an earlier branch extracted it out of
a `#private` method. **When a constraint moves from the schema into code, every
test that stood in for the schema has to be re-pointed at the code.**

SECOND, A PRISMA FIELD INSERTED BY REGEX CAN LAND IN THE WRONG MODEL, AND THE
SYMPTOM POINTS SOMEWHERE ELSE. `declaredTestSlug` was anchored on `commitSha`,
which appears in `Run` AND in `RunnerJob` — it landed in `RunnerJob`. What
typecheck then reported was `Property 'declaredTestSlug' does not exist` on the
generated client, which reads exactly like a stale `prisma generate` and sends
you to re-run it. One line settles it:

```
awk '/^model /{m=$2} /declaredTestSlug/{print "in model: " m}' packages/persistence/prisma/schema.prisma
```

Before that, the compare-from-test branch added no
unit FILE and 3 unit cases to `apps/web/test/TestRuns.test.tsx`, from a floor
of 130 / 1435. Its integration floor is unchanged at **123 files / 1508
tests** (it touches no `.ts` file integration runs) and its **e2e rises to
101**.

ONE THING FROM IT, ABOUT LINKING TO A PAGE THAT VALIDATES ITS OWN INPUT.
`parseCompareSelection` drops any run outside its cohort, and `TRENDS_SQL`
builds that cohort from `status = 'complete'` runs of one test. So a Compare
link built from the wrong runs does not error — the page renders a comparison
of however many survived, and a comparison of ONE still draws a chart. The
e2e case therefore asserts the overlay draws TWO series rather than that it
drew at all: "an svg exists" is satisfied by exactly the failure being
guarded against.

Before that, the test-entity-loose-ends branch added
no unit FILE and 10 unit cases — 8 to `apps/web/test/TestRuns.test.tsx` and 2
to `RunList.test.tsx` — from a floor of 130 / 1425. Its integration floor is
**123 files / 1508 tests** (6 cases in `apps/api/test/tests.integration.test.ts`)
and its e2e stays 100.

ONE THING FROM IT, AND IT IS THE DUPLICATE-KEY TRAP RECORDED UNDER
"Conventions that bite". Two siblings keyed off the same route params get the
same key, React renders one of them four times, and nothing errors. Read that
entry before adding a second remount key to a page.

Before that, the live-test-rules branch added no
unit FILE and no unit case — it REPLACED one in `ProjectRules.test.tsx` with
its inverse — so the unit floor is unchanged, while **integration rises to 123
files / 1502 tests** (5 new cases in
`apps/worker/test/fold-owner.integration.test.ts` plus one existing case split
in two) and e2e stays 100.

TWO THINGS FROM IT, AND BOTH ARE ABOUT A CAVEAT THAT STOPPED BEING TRUE.

FIRST, A LIVE RUN CAN KNOW ITS TEST, AND THE ANSWER WAS ALREADY IN THE STREAM.
The branch before this one shipped a real limitation: `run.test_id` was
resolved only by `PipelineService` at finalize, so a streaming run belonged to
no test and a test-scoped SLA rule could not judge it — the live banner showed
project-wide rules and nothing else. The fix needed no protocol change and no
client change, because `StreamingLogDecoder` already emits a `meta` event
carrying the fully-qualified simulation class, from the log HEADER, in the
first few hundred bytes of every run. `LiveFoldOwner.#identify` resolves the
test there and widens the rule set.

**Before designing a way to make a client tell you something, check whether the
bytes already do.** The rejected alternative was adding `simulation` to
`OpenLiveRunRequestSchema` and teaching the Gradle plugin to send it: a
protocol change, a JVM release, every other client left behind, and a
client's CLAIM rather than the log's own statement.

SECOND, "LOADED ONCE AT CLAIM" AND "NEVER RE-READ" ARE DIFFERENT RULES.
`FoldState.rules` forbids re-reading rules per tick, for a good reason — a run's
SLA should be the SLA it started under, or a rule edited mid-run makes a breach
appear with no change in the data. `#identify` looks like it violates that and
does not: it is the INITIAL load completing, because the claim could not ask
the right question yet. It runs once per run, guarded by a flag set before its
first await.

A THIRD THING, AND IT IS ABOUT VERIFYING LIVE BEHAVIOUR BY HAND. **Read the
DELTAS, never `live:{runId}:snapshot`.** `SNAPSHOT_EVERY_N_TICKS` is 60 — two
minutes at the default 2-second tick — so a 60-second run only ever writes the
snapshot its FIRST tick produced, and that one is frozen at `evaluated: 0`
because nothing has been folded yet. Polling it during a real Gatling run
therefore reports "no rules evaluated" for the whole run, whatever the truth
is, and looks exactly like the feature being broken. `XRANGE
live:{runId}:deltas - +` is written every tick and is the honest record; it
showed the rule entering the set and breaching from tick 4. The snapshot is a
seed for late joiners, not a status board.

A recorded behaviour changed as a result, and the test that pinned it was
inverted rather than deleted. `fold-owner.integration.test.ts` asserted "this
claim never gets a second attempt at loading rules… that is the documented
behaviour, not a hang". It now asserts the opposite: a claim-time load failure
RECOVERS at the header. That is strictly better — a transient database problem
at claim no longer blinds a soak test's banner for hours — and the
both-loads-fail case survives beside it, because a rules problem must still
never read as "nothing configured".

Before that, the test-scoped-rules branch added no
unit FILE and 16 unit cases — 8 to `apps/web/test/ProjectRules.test.tsx` and 8
to `packages/contracts/test/rules.test.ts` — from a floor of 130 / 1409. Its
integration floor is **123 files / 1496 tests** (that `rules.test.ts` is a
`.ts` file integration runs too, plus 9 cases in
`apps/api/test/rules.integration.test.ts` and 3 in
`verdict.integration.test.ts`) and its **e2e rises to 100**.

TWO THINGS FROM IT, AND THE FIRST IS THE ONE THAT WOULD HAVE COST A RELEASE.

FIRST, A PARAMETER WHOSE WRONG VALUE IS SILENT MUST NOT HAVE A DEFAULT.
`RuleRepository.listEnabled` gained a `testId` argument — which rules judge
THIS run. Giving it `= null` would have been the polite change: both existing
call sites keep compiling, no diff outside the repository. It would also have
meant the pipeline, which is the one caller that KNOWS the run's test,
carrying on evaluating project-wide rules only. Nothing throws, no test fails,
and every test-scoped gate somebody configured sits there reading as
protection while never firing once. The parameter is required, so both callers
had to state their answer, and the fold owner's `null` is a comment explaining
itself rather than an omission.

The same reasoning made `PipelineService` resolve the run's test BEFORE
loading its rules — an ordering that looks cosmetic and is not.
`verdict.integration.test.ts`'s "judges a run of the test it names" is the
guard, and it was verified red by passing `null` there.

SECOND, A WORD THAT ALREADY MEANS TWO THINGS DOES NOT GET A THIRD. `scope` on
an SLA rule means run/scenario/group/request — what it MEASURES — and
`ProjectScope` in the repositories means the tenant. The new axis is which
TEST a rule judges, and calling it a scope would have put three senses of one
word in one file, two of them in the same form. It is `test` in the schema,
`testSlug` in the contract, and "Applies to" in the UI, everywhere, and the
migration says so at the top. The failure this avoids is not a crash: it is
somebody authoring a gate on the wrong thing while reading their own
configuration as correct.

THAT BRANCH SHIPPED A LIMITATION, AND THE NEXT ONE REMOVED IT. It read: "a
live run has NO test for its whole stream, by construction… a test-scoped rule
never appears in the live SLA banner". True as written, and fixed by
`LiveFoldOwner.#identify` — see the live-test-rules entry above. The
prohibition is recorded here only so a reader meeting the old comments in a
`git log` knows they were superseded rather than forgotten.

Before that, the test-ui branch added TWO unit files
— `apps/web/test/ProjectTests.test.tsx` (10) and `TestRuns.test.tsx` (11) —
plus cases across `RunHeader.test.tsx` (4), `ProjectRail.test.tsx` (2),
`paths.test.ts` (5) and `packages/contracts/test/contracts.test.ts` (4), from a
floor of 128 / 1373. Its integration floor is **123 files / 1476 tests** — no
new integration FILE, but `contracts.test.ts` and `paths.test.ts` are `.ts`
files integration runs too, plus three cases in
`apps/api/test/tests.integration.test.ts` — and its **e2e rises to 99**
(`apps/web/e2e/project-tests.spec.ts`).

TWO THINGS FROM IT, AND BOTH ARE ABOUT COMPOSING A PAGE OUT OF PARTS.

FIRST, A COMPONENT THAT DRAWS A PAGE HEADING CANNOT BE COMPOSED INTO A PAGE
THAT ALREADY HAS ONE. `RunList` renders its own `<h1>` and its own
`useDocumentTitle`, which is right on the three screens where it IS the page.
`TestRuns` needs a breadcrumb above the heading and a metadata strip below it,
so it owns the heading and passes `showHeading={false}`; without that the
document carries two `<h1>`s and a screen-reader user navigating by heading
meets the page twice. NOTHING VISUAL SHOWS IT — the second heading looks like a
section title. This is the same rule as "a shell component must not contribute
an `<h2>`", one level up, and the same reason: a heading's correctness is a
property of the DOCUMENT, which no component can see from inside itself.

The document TITLE is the other half and points the other way. `heading` stays
required when `showHeading` is false precisely so `useDocumentTitle` is called
in exactly ONE place. Calling it in both would work by accident — effects run
child-first, so the parent's write lands last — and break the day the tree
moves.

SECOND, A FIXTURE MISSING A REQUIRED CONTRACT FIELD EXERCISES THE FALLBACK, NOT
THE FIELD. `ProjectTests.test.tsx`'s project fixture omitted `latestRun`, which
`ProjectSummarySchema` requires. That does not produce a project with no latest
run: `apiFetch` parses with the schema, so the WHOLE `GET /v1/projects` call
throws, the query errors, and the page falls back to rendering the slug. The
"falls back to the slug" case then passed for the wrong reason and the "names
the project" case failed with `Unable to find role="heading" and name
"Checkout"` — a message pointing at the heading, which was fine.

**Wherever a page degrades gracefully, a malformed fixture is silent in one
direction and misdirecting in the other.** The cheap guard is to build fixtures
that would satisfy the real schema, and to keep a paired positive assertion
beside every fallback case — the pattern `ProjectRail.test.tsx` already uses to
stop an absence assertion passing against an empty rail.

Before that, the trends-by-test branch added no unit
FILE and no unit case — it rewrote existing ones — so the unit floor was
unchanged, while **integration rose to 123 files / 1464 tests** (two new cases
in `apps/api/test/trends.integration.test.ts`) and e2e stayed 96.

TWO THINGS FROM IT.

FIRST, THE FLAKE THIS FILE RECORDED AS "MECHANISM UNDIAGNOSED" IS DIAGNOSED.
`RequestDetail.test.tsx` failed intermittently with a stale
`request-stat-count` cell surviving between renders. **`vitest.config.ts` does
not set `globals`, so Testing Library's automatic cleanup never registers** —
every file has to call `afterEach(cleanup)` itself, and four did not (`Card`,
`RequestDetail`, `payload`, `useLiveRun`). Every `render` appends to the same
`document.body`.

It is INTERMITTENT rather than always wrong because an earlier test's
`useQuery` can resolve AFTER that test has ended and commit into its
still-attached container — so whether the stale node exists depends on timing,
which is exactly why it looked unreproducible. Four cleanup calls fixed it;
four consecutive clean runs since. **When a jsdom test finds an element it did
not render, check the file for cleanup before suspecting the component.**

SECOND, LOAD AVERAGE IS A PREREQUISITE FOR BELIEVING ANY RESULT HERE. One
integration sweep came back with 22 failures across LiveFoldOwner,
PipelineService, Sweeper, the OpenAPI document and more — the same everything-
is-broken shape the disk-full incident produced, on a healthy disk. The tells
were a single test running **15 minutes against a 2-minute timeout**, and
`prisma.org.create` failing `Unique constraint failed on (slug)` immediately
after a `TRUNCATE`. `uptime` said **79**. The same suite on the same commit
passed 1464/1464 once load fell to ~30. Nothing was wrong with the code, and
nothing in the output said so. **Check `uptime` before diagnosing a broad
integration failure; above roughly 40 on this machine the suite cannot be
trusted either way.**

**AND CHECK MEMORY, BECAUSE LOAD ALONE DOES NOT SAY WHY.** A later session hit
the same everything-is-broken shape at load averages of **174, then 278** —
`ProjectRail` cases at 193s, "refuses a bearer credential" at 139s, and finally
the whole run killed by SIGTERM (`exit 143`) part-way through. The CPU list
looked innocent; the cause was swapping, and `memory_pressure` said so:
**7.2 million pageouts, 29% free**. Under thrashing, `pnpm test:unit` took
**908s and reported 8 failures**, then ran **130s and passed 1466/1466** once
the machine recovered — same commit, same tree, nothing changed but the load.

Two practical consequences. Waiting for a number to fall is not enough, because
it can climb back mid-run: gate the START on load and still re-check `uptime`
after, since a run that BEGAN at 24 and finished at 218 is as worthless as one
that began high. And typecheck and lint stay trustworthy throughout — they are
deterministic, so a thrashing machine makes them slow rather than wrong, which
makes them the right thing to run when the suites cannot be believed.

A `.metadata_never_index` file in a scratch directory stops Spotlight
re-indexing whatever the work generates, which is worth doing before unpacking
a hundred megabytes of jars into one.

Before that, the test-api branch,
which added ONE unit file — `packages/contracts/test/test.test.ts` (13) — from
a floor of 127 / 1360. Its integration floor is **123 files / 1462 tests**
(that `.ts` file runs there too, plus `apps/api/test/tests.integration.test.ts`
(21) and two cases in `openapi.integration.test.ts`) and its e2e stays 96.

ONE THING FROM IT, AND IT IS ABOUT ASSERTING A SPLIT. The tests routes guard
per HANDLER — GETs take either credential, the PATCH is session-only — and the
gate over that asserts BOTH halves: the PATCH overrides to cookieAuth, AND the
GETs carry no override at all. Only the pair catches the split collapsing in
either direction. A one-sided assertion would have let a GET quietly become
session-only, locking out the bearer callers it exists for, with every other
test still green. **When a rule is "these differ", assert both sides of the
difference, not the interesting one.**

Before that, the test-entity branch added no unit
FILE and no unit case — its whole surface is a migration, a worker rule and one
INTEGRATION file — so the unit floor is unchanged while **integration rises to
121 files / 1426 tests** (`apps/worker/test/test-entity.integration.test.ts`, 8)
and e2e stays 96.

TWO THINGS ABOUT RUNNING THE GATE, AND NEITHER IS ABOUT THE CODE.

FIRST, `No space left on device` LOOKS LIKE TWO HUNDRED BROKEN TESTS. Docker's
VM disk filled (1.9 GB free of 58.4 GB) and the integration suite failed across
nearly every file at once — `LiveFoldOwner`, `PipelineService`, the OpenAPI
document, the rules API, all of them. Not one message named the disk except a
single Postgres line buried in the output: `could not create file
"base/16384/…": No space left on device`. Everything downstream reported
`Can't reach database server`, which reads like a stack problem and is not one.
The PerfPortal database was 14 MB at the time — the suite's own data is never
the cause. `docker system df` is the check, and `docker builder prune -f`
reclaimed 20.4 GB with no images, volumes or containers touched. Re-run after
that: 1426/1426.

SECOND, `pnpm test:e2e` AT ITS DEFAULT FIVE WORKERS IS NOT RELIABLE ON A LOADED
MACHINE. Five specs failed with missing run data — no statistics table, no
error count, no compare chart — and every failure was a fixture whose data had
not arrived. It reproduced on a tree with the branch's changes STASHED, and
worse there (5 failures against 3), which is the measurement that matters: it
is not the change under test. `--workers=2` passes 96/96, and CI passes at its
own default. **Before believing an e2e failure that looks like missing data,
re-run at `--workers=2`, and re-run it with your change stashed.** The second
half is what separates "my change broke this" from "this machine is busy".

Before that, the rail-layout
branch, which added no unit FILE and 2 cases to `apps/web/test/Badge.test.tsx`,
from a floor of 127 / 1358. Its integration floor stays 120 files / 1418 tests
(every file it touches is a `.tsx` integration never runs) and its **e2e rises
to 96**.

TWO THINGS FROM IT.

FIRST, A `truncate` DEFECT IS INVISIBLE TO EVERY TEXT ASSERTION. `truncate` is
`text-overflow: ellipsis`, which leaves the full string in the DOM — so
`textContent` is identical whether a name is clipped or not, and every
existing assertion in `ProjectRail.test.tsx` and `project-rail.spec.ts` passed
while the rail was clipping fourteen-character project names. Only
`scrollWidth > clientWidth` can see it, and only in a browser. What caused it
is worth as much as the fix: the badge is `shrink-0` and the name is the
flexible one, so a 119px status word took its width out of the NAME's budget —
"Search Service" needed 94px and got 84. **A `shrink-0` sibling is a claim on
space that something else pays for, and the payer is whatever has
`truncate`.**

SECOND, THE RAIL'S ACTIVE-ROW FILL WAS NEVER DOING THE JOB ITS COMMENT
CLAIMED. `ProjectRail`'s docstring described `bg-surface` as a "card-raised"
signal, the card colour being one step lighter than the sidebar in both
themes. Measured, that step is **1.05:1 in dark and 1.04:1 in light** — one
step lighter, and very nearly nothing. What a reader actually sees is the
accent `before:` bar (6.38:1 / 4.96:1) and, since this pass, the accent-
coloured ICON (6.07:1 / 5.18:1). The claim was not false, it was just not
load-bearing, which is the harder kind of stale comment to notice.

Before that, the
chart-header-controls branch, which added ONE unit file —
`apps/web/test/ChartActions.test.tsx` (13) — from a floor of 126 / 1345.
Its integration floor stays 120 files / 1418 tests (every file it touches is a
`.tsx` integration never runs) and its **e2e rises to 95**, the first e2e case
added since the review-followup branch: a chart filling the screen, which no
unit layer can see.

TWO DEFECTS FROM IT, AND BOTH WERE INVISIBLE TO A GREEN SUITE.

FIRST, A REMOUNT NEEDS **BOTH** ECHARTS EFFECTS RE-RUN, NOT ONE. Expanding a
chart moves its canvas into a `<dialog>`, which remounts the node — so the
instance effect has to rebuild on the new element, which is obvious, and the
OPTION effect has to re-run too, which is not: a fresh instance has no option
on it. Miss the second and full screen is a blank rectangle with a valid SVG
root in it. `Chart.tsx` lists `expanded` in both dependency arrays and says why
in each. Verified red by removing the option one.

SECOND, `m-auto` ON A `<dialog>` IS LOAD-BEARING UNDER TAILWIND. A modal
`<dialog>` centres itself with the UA stylesheet's `margin: auto`, and
Tailwind's preflight resets `margin: 0` on **every** element — so a modal pins
to the top-left corner and the class list looks entirely reasonable. Measured
at (0,0) in a 1440×900 viewport before the fix. jsdom lays out nothing, so only
a browser can see it; `run-charts.spec.ts` now asserts the left and right gaps
match, and that assertion was verified red too.

A THIRD THING NEARLY SHIPPED AND IS RECORDED BECAUSE IT REPEATS AN EXISTING
LESSON ONE ROLE OVER. `ChartActions`'s copy-feedback live region was written
always-mounted, per the usual advice — so ten charts contributed ten
permanently-EMPTY `role="status"` elements, and `RunTelemetry`'s clock-skew
test began resolving eleven. That is exactly the unscoped-`alert` trap recorded
below, reintroduced for `status` within a minute of being read. A status role
now exists exactly when there is a status, which is what `Chart`'s own
empty-state `<p role="status">` always did. **The rule generalizes: a component
rendered N times per page must not contribute an always-present landmark or
live region.**

Before that, the sla-rule-authoring
branch, which added TWO unit files — `packages/contracts/test/rules.test.ts`
(29) and `apps/web/test/ProjectRules.test.tsx` (12) — from a floor of
124 / 1304, which is FIVE TESTS ABOVE the 124 / 1299 recorded below and
measured on `main` itself rather than inferred by subtraction. The integration
and e2e figures were both accurate; only the unit test count had drifted. That
is the drift this parenthetical exists to catch, and it is worth knowing it
happens even while the FILE count stays right — a branch that adds cases to an
existing file moves one number and not the other, which is the easier of the
two to forget. Its integration floor is 120 files / 1418 tests: `rules.test.ts`
is a `.ts` file integration runs too, plus one new integration FILE
(`apps/api/test/rules.integration.test.ts`, 33) and one case added to
`openapi.integration.test.ts`. Its e2e stays 94.

THREE THINGS FROM IT, AND THE FIRST IS A TRAP THIS FILE ALREADY WARNS ABOUT
IN THE OTHER DIRECTION. A page-wide `getByRole('alert')` silently changes
meaning when a page grows a second thing that can fail: it stops asking "did
the revoke fail" and starts asking "did ANYTHING fail". Composing
`ProjectRules` into `ProjectSetup` broke two token tests that way — the
rules panel's own load failure (its query has no server under jsdom)
answered the query first. Unlike the `ProjectRail` link collision, jsdom CAN
see this one, because both alerts are in ONE document rather than in two
components rendered apart. The fix is the same either way: scope the query
to the block it means (`token-mint`, `token-list`), and mock the new
section's data the way the file already mocked the others. **A page with N
independently-failing sections cannot be asserted on with an unscoped
`alert` query, and the assertion does not fail when it goes wrong — it just
starts passing for a different reason.**

SECOND, THE 201 CARVE-OUT IN `openapi.integration.test.ts` IS
BIDIRECTIONAL AND THAT IS THE POINT. Adding `POST /v1/projects/{slug}/rules`
to `CREATES_SYNCHRONOUSLY` does not wave it through: the allowlist branch
ASSERTS the operation still declares 201, so an operation that drops it
while its handler keeps returning 201 fails there rather than being skipped.
The standard it had to meet is the one already written down — a handler that
awaits a single Prisma insert and returns the row it wrote, complete and
addressable when the response is sent.

THIRD, A UNIT FAILURE THAT NEVER REPRODUCED, recorded because the
investigation is worth more than the verdict.
`apps/web/test/RequestDetail.test.tsx`'s "renders the row it found, and says
so when there is none" failed ONCE, on a branch that does not touch it, with
a `request-stat-count` cell from that test's own FIRST render surviving into
its second. It passes alone, and the full unit suite then passed six
consecutive times at 126 / 1345, plus four runs of `apps/web/test` alone.
That test does two renders in one case with an `unmount()` between them,
which is the only unusual thing about it. One occurrence stands, mechanism
undiagnosed — do not "fix" it on the strength of this note, and do not
assume a new file caused it beyond perturbing timing.

THE WHOLE GATE PASSED AND PROVED NOTHING ABOUT THE FEATURE, which is the
fourth thing and the reason the section below this one exists. Every suite
was green while the only question that mattered — does a rule authored here
actually judge a run — was answered by no test in any of them, because the
three suites between them never author a rule through the API and then feed
a real simulation to the evaluator. Three real `gatlingRun` executions
through `clients/gatling-gradle/e2e/e2e-project` did answer it, and it took
about ten minutes: a run-scoped p95 gate PASSED at 645ms/800, an error-rate
gate FAILED at 2.23%/1% and drove the run's verdict to `failed`, disabling
that gate through PATCH flipped the NEXT run's verdict to `passed` with one
assertion instead of two, and neither the disable nor a subsequent DELETE
touched the assertion the first run had already recorded. A request-scoped
rule authored through the browser form then failed `Search`'s p50 at 572ms
against 100 — independently agreeing with `ParitySimulation`'s own
deliberately-failing Gatling assertion about that same request, which is a
cross-check no unit fixture can give you.

Before that, the redesign-run-page
branch added no unit FILE and 1 case to
`apps/web/test/RunDecisionBand.test.tsx` — the gate tick strip follows the
counts' own evaluated gate and stays aria-hidden — from a floor of 124 / 1299.
Its integration floor stays 118 files / 1355 tests (the touched test file is
`.tsx`, which integration never runs) and its e2e stays 94. The
redesign-foundation branch before it (the control-room retheme: palette, three
vendored faces, shell restyles) moved no counts at all — its churn was inside
`palette.test.ts`'s mirrors, updated in lockstep with `charts/theme.ts`.
Before that, the duration-is-activity-span branch added no unit
FILE and 2 cases to `packages/statistics/test/parity.test.ts`, from a floor of
124 / 1297. Its integration floor is 117 files / 1351 tests (that `.ts` file
runs there too, plus `PT-G-13` in `parity.e2e.test.ts`) and its e2e stays 94.
The openapi-public branch then took integration to 118 files / 1355 tests --
one new integration FILE, `apps/api/test/openapi-public.integration.test.ts`
(4) -- leaving the unit floor at 124 / 1299 and e2e at 94, since it adds no
`.tsx` file and no spec.

TWO THINGS FROM THAT BRANCH, AND THE SECOND IS ABOUT HOW TO RUN THIS GATE.

FIRST, `apps/api/test/openapi.integration.test.ts` FAILED ONCE WITH
`expected 401 to be 200`, AND WAS NEVER REPRODUCED. Recorded because the
investigation is more useful than the verdict. The file passes 4 of 4 in
isolation and the full suite passes clean on an idle stack; one occurrence
stands, mechanism undiagnosed. An earlier note here claimed it "fails 2 of 3
on main" — that measurement was taken while a queued e2e was running and is
worthless; see the second point. Do not trust a flake rate measured against a
busy stack, including one your own diagnosis is keeping busy.

What the investigation DID establish, by measuring the real bootstrap:
`/v1/openapi.json` and `/v1/docs` answer 200 with no credential while
`/v1/runs` answers 401. Those two were public only as a SIDE EFFECT OF MOUNT
ORDERING — `mountOpenApi` registers them on Express before `app.init()`, and
Express matches in registration order, so they resolved ahead of
`AuthMiddleware`, which excludes nothing. `app.module.ts` states that contract
explicitly now and `openapi-public.integration.test.ts` pins it. Note which
case guards it: `/v1/runs` stays 401 even under a wide-open `exclude('v1/*path')`,
because `AuthGuard` still runs for MATCHED routes — only the
unimplemented-path case (must 401, never 404) catches an over-broad exclusion,
and it was verified red exactly that way.

SECOND, "RUN INTEGRATION BEFORE e2e" IS NOT ENOUGH — NOTHING ELSE MAY TOUCH
THE STACK WHILE EITHER RUNS, INCLUDING DIAGNOSIS. Three ad-hoc integration
runs started to investigate the flake above, while a queued e2e was already
executing, truncated every table underneath it: 63 of 94 passed and the log
filled with `failed to update last_used_at ... No record was found for an
update` — tokens deleted mid-run. Nothing was wrong with the code. Re-run
alone: 94/94. The rule below about not racing the suite against ITSELF
applies just as much to the commands you type WHILE it runs.

Before that, the second review-followup
branch, which added ONE unit file — `RunSectionNotFound.test.tsx` (3) — plus a
route-declaration guard in `paths.test.ts`, from a floor of 123 / 1293. Its
integration floor is 117 files / 1348 tests (four cases in
`repositories.integration.test.ts`: a project-name search, an id-prefix
search, and a PLAN assertion) and its e2e rises to 94 — the first e2e case
added in several sub-projects, for a stale run-section URL, which only a real
router resolving a real URL can see.

THE PLAN ASSERTION IS THE ONE WORTH KNOWING ABOUT. Two ordinary-looking
things silently made the run search's indexes unreachable while every row
assertion stayed green: wrapping a nullable column in `COALESCE(col, '')`
(an expression a plain-column index cannot serve — and the COALESCE was a
no-op anyway, since `NULL ILIKE x` is NULL and NULL in a positive OR is
already false to a WHERE clause), and matching the project through the JOIN.
That second one is the subtle half: PostgreSQL can only fold an OR into a
BitmapOr while it can index EVERY branch, and a branch on a JOINED table is
never indexable — so one cross-table clause cost the six run columns beside
it their indexes too. The project match is resolved by its own query now and
arrives as `project_id = ANY($n::uuid[])`. Adding a column to that OR means
adding an index for it, or the whole predicate goes back to a sequential
scan.

`pg_trgm` IS A TRUSTED EXTENSION, AND THE FIRST VERSION OF THIS NOTE SAID
OTHERWISE. Migration `20260821200000_run_search_trigram` runs
`CREATE EXTENSION IF NOT EXISTS pg_trgm`, and it was written up — in the
migration's own comment and in the review that shipped it — as needing
"rights an unprivileged application role usually does not have". Measured on
`postgres:16-alpine`, that is false: `pg_available_extension_versions`
reports `trusted = t` for 1.3 through 1.6, and since PostgreSQL 13 a trusted
extension installs for a NON-SUPERUSER holding CREATE on the database. Both
sides were tested — a nosuperuser database owner succeeded; a nosuperuser
role without CREATE on the database got `permission denied to create
extension "pg_trgm"`.

So the failing shape is narrow (CREATE on the schema but not the database),
and any role that ran the twenty migrations before it already has broad DDL
rights. `infra/pg_trgm-preflight.sql` answers it for a specific database
without changing anything — run it AS THE ROLE THAT RUNS MIGRATIONS, or it
reports on the wrong identity. The onprem compose profile is settled either
way: `POSTGRES_USER` is created superuser by the official image, and the full
migration history was applied from scratch on an empty database on it.

THE GENERAL POINT IS WORTH MORE THAN THE EXTENSION. A privilege claim is
cheap to assert and cheap to TEST — `create role … nosuperuser`, a scratch
database, and the statement itself. Asserting one from memory is how a note
that reads like operational knowledge ends up overstating a deployment risk
by a wide margin.

EDITING AN ALREADY-APPLIED MIGRATION CHANGES ITS CHECKSUM, and correcting
that comment did exactly that — `_prisma_migrations.checksum` still holds the
hash of the original text. `prisma migrate deploy` and `prisma migrate status`
both tolerate it: verified against a database holding the OLD checksum, deploy
answered "No pending migrations to apply" and status answered "Database schema
is up to date!", with no warning. Since `deploy` is the only path this repo
uses (README, infra/README, infra/docker-compose.yml, and the command in this
file), a comment-only edit is safe.

NOT VERIFIED, and stated as such: `prisma migrate dev` detects modified
migrations and may offer to reset. It is not run here — it appears only in
historical planning docs — but if you ever do, expect it to notice.

Before that, the enterprise run
dashboard branch and the fifteen-finding review wave that followed it, which
between them added FIVE unit files — `RunDecisionBand.test.tsx` (7),
`assertionExport.test.ts` (2), `compareSummary.test.ts` (3),
`runBaseline.test.ts` (6) and `RunOverviewTab.baseline.test.tsx` (2) — plus
cases across `RunList.test.tsx`, `RunStats.test.tsx` and
`RunDetail.live.test.tsx`, from a floor of 118 / 1265. Its integration floor is
117 files / 1344 tests: no `.tsx` file runs there, but `assertionExport`,
`compareSummary` and `runBaseline` are all `.ts`, and
`apps/api/test/read.integration.test.ts` gained six cases for the new list
filters. Its e2e stays 93 — that suite gained no case, and the one spec it
touched was hardened rather than added to.

THREE THINGS FROM THAT REVIEW WAVE ARE WORTH KNOWING, and none of them was
visible to `pnpm test:unit`. FIRST, THE INTEGRATION SUITE CANNOT SHARE ITS
DATABASE WITH A RUNNING WORKER, which is the same hazard as the
cannot-race-itself rule below and reads identically: 73 failures across 13
files, `deadlock detected` on the setup `TRUNCATE`, unique-constraint
violations, and timeouts — none of them naming a cause. A `pnpm --filter
@perfportal/worker start` left running from an earlier session was holding
the `FOR UPDATE` rows the sweeper polls while the suite tried to truncate
underneath it. `pgrep -f vitest` is not enough on its own; check for a worker
and an API too (`pgrep -f 'perfportal/worker'`). Stopping it turned the same
tree green, 1344/1344, with no code change.

IT IS NOT ONLY POSTGRES. A running worker also holds a `LiveFoldOwner`
subscribed to `live:opened` on the SAME Redis, and that owner CLAIMS runs —
so it can win the claim a test is waiting for. Seen as
`fold-owner.integration.test.ts`'s "evaluates a rule for a run claimed via a
live:opened ping" failing with `expected null not to be null` from
`owner.snapshotOf(runId)`, deterministically, on a tree whose only change was
in an unrelated test. Nothing in that message points at a second worker. The
loop that finds it:

```
for p in $(pgrep -f "dist/main.js"); do
  printf '%s %s\n' "$p" "$(lsof -a -p "$p" -d cwd -Fn | sed -n 's/^n//p')"
done
```

SECOND, A SHELL COMPONENT MUST NOT CONTRIBUTE AN `<h2>`. `run-tables.spec.ts`
asserts the Overview tab's heading outline is EXACTLY
`['Assertions', 'Simulation assertions', 'Statistics']` and the Errors tab's
is exactly `['Errors']`. `RunShell` renders above the `<Outlet/>`, so
anything it draws is on all five tabs — `RunDecisionBand` shipped with an
`<h2>` carrying its verdict sentence and broke that outline on every one of
them, with a heading whose WORDS changed per run. `SlaBanner` and
`LiveStatusStrip` contribute no heading for exactly this reason; `RunHeader`
owns the one `<h1>`. Shell chrome is named by `aria-label` on its `<section>`.

THIRD, `page.mouse` DOES NOT SCROLL AND `locator.click()` DOES. The scrubber
drag in `run-charts.spec.ts` is the suite's only raw-mouse gesture, and it
takes VIEWPORT coordinates — as do `boundingBox()` and the in-page
`getBoundingClientRect()` it locates the handle with. Adding one more band of
chrome above the tab content pushed the brush below the fold at the default
1280x720, so the query still found the handle, the measurement still returned
a box, the drag landed on empty page, and the only symptom was the URL
assertion timing out five seconds later. It now calls
`scrollIntoViewIfNeeded()` before taking any geometry. Any test that drives
`page.mouse` needs the same line.

Before that, three review
follow-ups, which added ONE unit file —
`packages/persistence/test/project-repository.test.ts` (6) — and 4 cases to
the existing 409 case in `apps/api/test/projects.integration.test.ts`. Its
integration floor is 114 files / 1325 tests (the new `.ts` file runs there
too) and its e2e stays 93. The three: a duplicate-slug 409 now carries a
real `remediation` via a new `conflict()` helper beside `badRequest`,
because `ProblemFilter`'s fallback tells the user to consult the OpenAPI
document for a request that matches it perfectly; `formatStarted` became
`formatInstant` and `ProjectSetup` stopped carrying a third private
`toLocaleString()` copy; and `createInOrg` no longer maps EVERY P2002 to
"that slug is taken". THAT LAST ONE IS THE INTERESTING TEST. Only one
unique index exists on `project`, so the branch that matters — a P2002 that
is NOT the slug — cannot be produced against a live schema, which is why
its file stubs the client instead. The real `meta.target` shape
(`['org_id', 'slug']`, database column names rather than Prisma field
names) was OBSERVED by triggering a genuine duplicate before the cases were
written, not guessed. From a floor of 117 / 1259. Before that, the duplicate
"New project" link fix, which added no unit FILE and 1 unit case to
`ProjectRail.test.tsx` plus 1 E2E case to `run-list.spec.ts` — so its e2e
floor rises to 93, the first time that number has moved in several
sub-projects, and its integration floor stays 113 files / 1319 tests
(neither file is a `.ts` integration runs). The rail carried a "New project"
row while `RunList`'s heading rendered the same action, and because the rail
is on EVERY authenticated page the `/runs` document held two links with one
accessible name. THE UNIT SUITE COULD NOT SEE IT AND NEVER WILL: jsdom
renders one component at a time, so a collision BETWEEN two components in
one document is invisible there — the e2e case is the guard, and it failed
with "locator resolved to 2 elements" when verified red. The unit case
pins WHICH component dropped the row, so a re-add fails with its cause
attached rather than as a strict-mode error in an unrelated spec. From a
floor of 117 / 1258. Before that, the project setup
and token-management UI, which added two unit FILES —
`apps/web/test/NewProject.test.tsx` and `apps/web/test/ProjectSetup.test.tsx`
— covering the create-project form and the API-token screen, plus the
review-fix cases those two grew: a slug field that ate every typed hyphen
(the full `slugify` ran per keystroke and trims a trailing `-`, so
`checkout-api` became `checkoutapi`), a revoke that failed silently, a copy
button that claimed success with no clipboard, a one-click destructive
revoke, and `paths.test.ts`'s new guard that reads `App.tsx` and rejects any
literal segment under `/projects/` matching the slug grammar — `/projects/new`
had been permanently shadowing a project legitimately slugged `new`. Its
integration floor is 113 files / 1319 tests: no integration FILE was added,
but `apps/api/test/openapi.integration.test.ts` gained a third exception to
the never-declare-201 rule, and the two new `.tsx` files are unit-only, so
the file count holds while the test count moves. THAT 201 GATE IS WORTH
KNOWING ABOUT: it went red on CI for `POST /v1/projects` and is not
cosmetic — 201 is reserved here for operations that really do create
synchronously, and every other create is a 202 over a state machine. A new
201 has to be argued for, and it only runs under `test:integration`, so a
green `pnpm test:unit` says nothing about it. Its e2e stays 92: the specs
gained cases inside existing `test(` blocks (the Compare tab), not new ones.
From a floor of 115 / 1245. Before that, the header-height
token, which added no unit FILE and 2 cases to `tokens.test.ts` — the shell
header's 56px had been three hard-coded spellings in three files
(`AppShell`'s height, `ProjectRail`'s sticky offset AND its
`calc(100dvh - …)`, `RunTabs`' sticky offset) that had to agree with nothing
making them, and the failure when they stop is invisible to jsdom: the
tab strip slides UNDER a resized header as a blurry ghost band only a
scrolling browser shows. The two cases gate the declaration (once, and
aliased into the spacing namespace under a DIFFERENT name — `@theme`'s
self-reference trap) and the consumption (each dependent reads the token;
none still contains `h-14`, `top-14` or `3.5rem`). That second case scans
WHOLE FILES, comments included, which is deliberate — stale prose naming
the old spelling is exactly as misleading as a stale class, and it caught
its own author's comment first. Verified for real by BUILDING and grepping
the emitted CSS rather than trusting the token: `.h-header`,
`.top-header`, `.lg\:top-header` and `calc(100dvh - var(--header-height))`
all present. A token absent from `@theme` generates NO utility, silently,
so a source-only assertion would have passed against a page with no
height at all. The same build revealed a second thing worth knowing:
Tailwind v4 SCANS `apps/web/test`, so every class string a test quotes as
DATA became a real rule in the shipped bundle — the gate forbidding
`top-14` was itself emitting `.top-14`. `tokens.css` now carries
`@source not '../../test'`; the rebuild dropped exactly six rules, all six
verified test-injected by diffing the selector sets, with nothing from
`src` lost. From a floor of 115 / 1243. Its integration floor is 113 files
/ 1312 tests — the file count is unchanged but the TEST count moved,
because `tokens.test.ts` is a `.ts` file and the integration config runs
every one of those; its e2e stays 92, which runs no `.ts` unit file at
all. THE e2e-BEFORE-INTEGRATION TRAP BELOW CLAIMED THIS BRANCH TOO, which
is worth a second datapoint since the first cost two sessions: run in that
reverse order, integration came back `1 failed | 1311 passed` with no
failing assertion anywhere in the output, and re-run alone against an
untouched tree it was 1312/1312 green. Nothing about the failure named
itself; only the ORDER did. Before that, the UI
modernization branch (shadcn-style cva/cn foundation, lucide-react behind
`components/icons.tsx`'s unchanged exports, and the rail's desktop
collapse), which added no unit FILE and 3 cases to `ProjectRail.test.tsx`,
all pinning the collapse's one load-bearing decision: the collapsed state
is CSS-ONLY (`lg:sr-only` labels, `lg:hidden` badges), so every row's
accessible name and exact textContent — which this file already pins
verbatim — are IDENTICAL in both states, the toggle's own name flips to
the action it will perform, and the choice survives a remount via the same
storage discipline as `theme.ts`. Verified red: conditionally RENDERING
the name span instead — the obvious rewrite, and what the reference design
does — failed exactly the textContent case. Measured from a floor of
115 / 1240: the recorded floor below (112 / 1232) had gone stale against
main by three files and eight tests before this branch touched anything,
which is precisely the drift the parenthetical you are reading exists to
prevent. Its integration floor is 113 files / 1310 tests and its e2e is
92 — also both above their recorded values below, re-measured green on
this branch; `ProjectRail.test.tsx` is a `.tsx` file integration never
runs, so this branch's own cases move only the unit floor. Before that,
the two residual
fixes left before the five-tab live page branch merges, which added no unit
FILE and 2 unit cases: one each to `RunTelemetry.test.tsx` and
`RunCompare.test.tsx`, both pinning the SAME shape of gap. Every hook in
each component already sits above its own `!terminal` early return, correct
today — but nothing PINNED that shape, and this branch has already shipped
that exact class of bug twice, once in `RunTelemetry.tsx` itself. Each new
case mounts the component RUNNING, then re-renders the SAME instance
TERMINAL, the identical shape `RunTrends.live.test.tsx`'s own "survives a
running run finishing while the reader is on this tab" already used for
that tab; mounting each state SEPARATELY — what every other case in both
files does — cannot catch this, because the defect
("Rendered more hooks than during the previous render.") is in the
TRANSITION, not in either state alone. Verified red: moving `!terminal`
above one hook in each file (the `useState`/`useQuery` block that follows)
turned the new case red with that exact error, and reverting made it green
again. `RunTelemetry`'s case also re-proves CRITICAL 1 AT the transition
rather than only at either endpoint — `enabled: terminal` means
`/telemetry` never fires while running, so the flip has to trigger a FRESH
fetch rather than surface a cached `available: false`, and the case asserts
a `/telemetry` request lands only after the flip. The other half of this
residual fix touched no test: two comments — `LiveStatusStrip.tsx`'s own
docstring and `RunShell.tsx`'s echo of it — still claimed the strip "now
always has something to say about polling, capped or not," false in
exactly the state `streamed` was added for (a `running` run with no
evidence yet renders NOTHING there, deliberately, on a compact viewport and
on a desktop's first paint); both now say so instead. From a floor of
112 / 1230. Its integration floor stays 111 files / 1297 tests and its e2e
stays 90 — neither runs a `.tsx` file, and this fix touched no spec. Before
that, the five-tab live page branch's own final whole-branch review fix
wave, which fixed six
findings in one pass before merge: `RunTelemetry` was the one tab whose
query was never gated on `terminal` — `telemetryQuery` carries `staleTime:
Infinity` (`api/metrics.ts`), so a live run's honest `available: false` got
fetched, cached FOREVER, and silently relabelled as "no load generator
reported" the moment the run went terminal, with nothing ever refetching it;
`LiveStatusStrip` claimed "Reconnecting" with no evidence a socket had ever
delivered anything, true on every phone (§22.6 disables the socket below
768px) and on a desktop's first paint; `RunShell` re-derived `terminal` from
a `status` allowlist instead of receiving it as a prop, the exact
`statusFor` trap this file documents elsewhere; a stale doc comment in
`api/metrics.ts` still claimed charts could only mount under a `ready` run;
`RunCompare` — a sixth `<Outlet/>` child the five-tab audit missed — fired
`/trends` with no `terminal` gate at all; and a widened-202 test consumer in
`apps/api/test/telemetry.integration.test.ts` would have silently computed
against the Unix epoch (`new Date(null)`) rather than failing loudly. One
new file, `apps/web/test/RunCompare.test.tsx` (5: the withheld wording
across pending/parsing/running, and that `/trends` fires only once the run
is terminal), plus 2 cases each to `LiveStatusStrip.test.tsx` (a
disconnected, never-streamed run says nothing at all, not "Reconnecting" —
the exact prop combination a compact viewport produces) and
`RunShell.test.tsx` (the shell trusts the `terminal` PROP over `status` in
both directions, proving neither `complete` nor `running` predicts it any
more), and 1 case each to `RunTelemetry.test.tsx`, `RunOverviewTab.live.test.tsx`,
`RunChartsTab.live.test.tsx` and `RunErrorsTab.live.test.tsx` — the missing
per-tab fetch spy the review itself called out (before this, the rule was
pinned only in `RunShell.test.tsx` and `RunTrends.live.test.tsx`, and
`RunTelemetry` was exactly the tab no spy was watching) — from a floor of
111 / 1217. Its integration floor stays 110 files / 1298 tests: the one new
file is a `.tsx` component test integration never runs, and the one `.ts`
file this wave touched (`telemetry.integration.test.ts`) gained a defensive
throw in its own setup, not a new case. Its e2e stays 92, unchanged. Before
that, the five-tab live page sub-project itself, which made a run page
render its header and five tabs for EVERY run state rather than only a
terminal one — deleting three standalone
screens (`Processing`, `Live`, `LiveCapped`) and redistributing their
content into `RunShell`, `WaitingPanel`, and per-tab live branches.
`apps/web/test/run-detail.test.ts` is GONE: its four cases pinned the
polling-cap UI of the deleted `Processing` component; three are now covered
by `LiveStatusStrip.test.tsx`'s own capped-block cases, and the fourth —
that the cap's two sentences never coexist — became a real assertion there
("the capped block REPLACES the finalizing notice, never joins it").
`RunDetail.live.test.tsx` shrank from 19 cases to 9 the same way, not by
loss: most of what it pinned (a distinct `<h1>`, a standalone "still
processing" screen) no longer exists to assert on, and the file's own
docstring accounts for every remaining old case as moved, already covered
elsewhere, or left as an `it.todo` naming the task that will re-cover it.
Six new files carry what moved plus what is genuinely new:
`WaitingPanel.test.tsx` (4, the pending/parsing distinction, and that it
owns neither the page's `<h1>` nor its back link), `LiveStatusStrip.test.tsx`
(10, the strip every tab now mounts unconditionally —
streaming/reconnecting/frozen phrasing, the partial-seed notice ALONGSIDE
the finalizing one, and the capped block REPLACING either streaming
sentence rather than joining it), `RunOverviewTab.live.test.tsx` (5, the
live tiles, the withheld statistics table stated rather than omitted, and
`WaitingPanel` for a pending run with no delta yet),
`RunChartsTab.live.test.tsx` (3, the five live figures with the two
withheld ones named, gated behind `DesktopOnly`),
`RunErrorsTab.live.test.tsx` (2, the errors table kept live while its own
chart says it is not), and `RunTrends.live.test.tsx` (6, an `it.each` gate
across pending/parsing/running plus surviving a running run finishing
mid-read). Plus 13 cases to `RunShell.test.tsx` (mounting the strip above
the outlet, gating the time brush and the shared-metric fetch behind
liveness, and threading live state through the outlet context), 3 to
`RunHeader.test.tsx` for rendering off bare identity now that the header no
longer needs a whole run object, 2 to `RunTelemetry.test.tsx` for a
non-terminal run, and 4 to `packages/contracts/test/live.test.ts` for the
202 body's own identity fields — from a floor of 106 / 1179. Its
integration floor is 110 files / 1298 tests — one FEWER file than the unit
floor's rise would suggest, because `run-detail.test.ts` was the only
deleted file integration also ran; every new file above is a `.tsx`
component test integration never runs — and its e2e is 92. Before that, live
SLA signals' whole-branch review fixes, which added no unit FILE and 9 unit
cases: 6 to
`apps/web/test/SlaBanner.test.tsx` (the denominator naming what it counts, the
unchecked-rule count in both plurals and its absence at zero, and the two
rules-could-not-be-loaded cases — the one state where that banner renders with
nothing breaching), 2 to `packages/contracts/test/live-delta.test.ts` (a delta
written before `sla` existed, and an `sla` written before its two newer
fields did — a required field there blanks the live page for a whole rolling
deploy, because the browser drops any frame that fails the schema and the
gateway forwards stored bodies without validating them) and 2 to
`apps/worker/test/live-delta.test.ts`, MINUS one: `packages/sla/test/stats.test.ts`
lost the case claiming to pin batch/live agreement, whose two sides were the
identical expression. Its replacement is an integration file — see that
file's own note. Its integration floor is 111 files / 1297 tests and its e2e
is 90. Before that, live SLA signals itself —
the run page's own SLA breach banner — which added
`packages/sla/test/stats.test.ts` (4 at the time, `toEvaluableStats`'s field
mapping and its "does not carry an unrelated field" boundary — the fourth was
the tautology the whole-branch review removed),
`packages/sla/test/evidence-gate.test.ts` (6, the evidence floor a live tick
judges a metric against before it counts as evaluated — `not_applicable`
below the floor, a real breach once it clears, and absent by default for the
batch path) and `apps/web/test/SlaBanner.test.tsx` (5: the three
condition-not-event cases — renders on any non-empty `breaching`, nothing on
an empty one, and survives a re-render carrying the identical breach — plus
two the review's own fix round added, pinning that `frozen` flips the
banner's tense without ever showing both at once) as new files, plus 1 case
to `apps/worker/test/live-delta.test.ts` — the built delta carrying only the
breaching rules and a count of those evaluated — and, from that same fix
round, 4 cases to `apps/web/test/format.test.ts` for `formatOffset`'s own
boundaries (zero, sub-second rounding, and the minute rollover that must
never read "1m 60s") — from a floor of 103 / 1150. Its integration floor was
110 files / 1286 tests and its e2e 90 — neither of which `pnpm test:unit`
counts. Earlier: live run monitoring part 2b — the fan-out and the live
dashboard — which added
`packages/statistics/test/bucket-latency.test.ts` (4),
`apps/web/test/useLiveRun.test.tsx` (15), `apps/web/test/LiveNotice.test.tsx`
(4) and `apps/web/test/RunDetail.live.test.tsx` (14) as new files, plus cases
across `live-delta.test.ts`, `timeAxis.test.ts` and the two live integration
suites, from a floor of 99 / 1079. The last 19 of those tests came from the
whole-branch review's own fix wave, which is worth knowing: two of its
findings were defects no per-task review could see, and neither had ANY test
over it. Its integration floor is 108 files / 1269 tests and its e2e is 89 — neither of which `pnpm test:unit` counts. Earlier: the live dashboard
sub-project's task 1, the `bucketLatency` extraction, which added
`packages/statistics/test/bucket-latency.test.ts` (4, deriving min/max/mean
from the all-outcomes sketch, emitting every fixed band per outcome split,
and the empty-sketch asymmetry — {} for percentiles but 0 for min/max/mean)
as a new file — from a floor of 99 / 1079 — and that one from the fold
owner's whole-branch review fixes, which added
`packages/storage/test/blobs.test.ts`
(2, the black-hole socket case that catches `requestTimeout` being the wrong
option), `apps/worker/test/replay-cap.test.ts` (4, the replay stream's byte
budget) and `apps/worker/test/shutdown.test.ts` (3, a designed
`AggregateError` not being allowed to crash SIGTERM) as new files, plus 5
`withConnectionLimit` cases to `packages/persistence/test/client.test.ts` for
Prisma's own, previously unsized pool — from a floor of 96 / 1065. That
sub-project's own additions were `apps/worker/test/config.test.ts` (12),
`packages/persistence/test/client.test.ts` (3),
`packages/contracts/test/live-delta.test.ts` (9), and
`apps/worker/test/live-delta.test.ts` (9) as new files, plus 3 cases to
`apps/worker/test/retry.test.ts` — one for `PipelineService`'s own
`RUN_LOCKED` signal, one for pg-pool's own connect-timeout error, and one
proving an unrelated bare `Error` still reads as deterministic — from a floor
of 92 / 1029 — and that one from §22.6's mobile summary, which added
`DesktopOnly.test.tsx` (6) and `useIsCompact.test.tsx` (6), from a floor of
90 / 1017 — and that one from live run monitoring
part 1's review fixes, which added 2 cases to
`packages/plugin-gatling/test/stream.test.ts` — one pinning `consumedBytes`
against the last whole-record boundary, one pinning that the decoder's
retained buffer is bounded by the chunk rather than by the run — from a
floor of 90 / 1015. That sub-project's own additions were
`packages/statistics/test/live-engine.test.ts` (3),
`packages/statistics/test/chunk-invariance.test.ts` (2),
`packages/plugin-gatling/test/stream.test.ts` (3), and
`packages/contracts/test/live.test.ts` (10), plus 4 truncation-bounds cases
added to `packages/plugin-gatling/test/reader.test.ts`, from a floor of
86 / 993 — and that one from the shared time axis, which added
`apps/web/test/timeAxis.test.ts` (8) plus 3 axis cases to `Chart` and 3 pair
cases to `tooltip`, from a floor of 85 / 979 — and that one from the G-05
assertion decoder and evaluator, which added
`packages/plugin-gatling/test/assertions.test.ts` (6) and
`packages/statistics/test/tool-assertions.test.ts` (12), from 83 / 961. Earlier
floors: the standalone-errors fix (G-17) 83 / 957, the chart-controls pass
83 / 954, the run-timestamp fix 83 / 954, the time-brush fix 82 / 936, and
81 / 931 through `feat/telemetry-agent`. No fix's e2e or integration cases are
in this count: `pnpm test:unit` runs neither.)

`pnpm test:unit` does **not** run the integration or e2e suites —
`vitest.config.ts` excludes `*.integration.test.ts` and `*.e2e.test.ts`. A
change to anything the API consumes by name can pass every unit gate and still
break `apps/api/test`. Before claiming a sub-project complete:

```
pnpm typecheck && pnpm lint && pnpm test:unit && pnpm test:integration && pnpm test:e2e
```

**AND READ EACH GATE'S OWN EXIT CODE, NEVER A PIPELINE'S.** A shell pipeline
exits with its LAST command's status, so

```
pnpm typecheck 2>&1 | tail -1 >/dev/null && echo "TYPECHECK OK"
```

prints OK over a FAILING `tsc` — `tail` succeeded. That exact line reported a
green typecheck on a branch CI then failed in 1m53s at its very first step,
`RunStats.test.tsx(460,19): error TS2532`, and the same shape masks a red
`lint` or `test:unit` just as quietly. Redirect to a FILE and test `$?`:

```
pnpm typecheck > /tmp/tc.txt 2>&1; echo "exit=$?"
```

This is the grep trap recorded further down, one level worse: piping a suite
through `grep` loses the failure MESSAGE, piping anything through `tail` or
`head` loses the failure ITSELF. `set -o pipefail` also fixes it, and is not on
by default in the shell these commands run in.

**THE CONVERSE IS NOT TRUE, AND IT COSTS TIME: `pnpm test:integration`
RE-RUNS THE UNIT `.ts` FILES.** `vitest.integration.config.ts` includes
`packages/*/test/**/*.test.ts` and `apps/*/test/**/*.test.ts` with **no
`exclude` at all**, so its 111 files are 78 ordinary unit files, 32
`*.integration.test.ts`, and `apps/api/test/parity.e2e.test.ts` — which is why
its count is the unit count plus the integration one and not a separate
number, and why a unit-only change still moves the integration floor. Waiting
for an eight-minute integration run to re-prove a pure function is the
avoidable half of it; reading its total as "the integration tests" is the
expensive half.

It is **not** a superset either. That config's `include` has no `.tsx` entry
(the unit config lists `apps/*/test/**/*.test.tsx` separately, because those
28 files need jsdom), so every React component test runs under `test:unit`
ALONE. A component change verified only by `pnpm test:integration` has not
been verified at all.

`test:integration` and `test:e2e` need the local stack:

```
docker compose -f infra/docker-compose.yml up -d
export DATABASE_URL=postgresql://perfportal:perfportal@localhost:5433/perfportal
export REDIS_URL=redis://localhost:6380
export S3_ENDPOINT=http://localhost:9000
export S3_ACCESS_KEY=perfportal
export S3_SECRET_KEY=perfportal123
```

**NEVER `prisma db push` AGAINST THIS DATABASE. IT PARTIALLY APPLIES, AND A
FAILED PUSH LEAVES THE SCHEMA THE MIGRATIONS NO LONGER DESCRIBE.** Reached for
once, to red-verify a foreign key's `onDelete` by editing `schema.prisma` and
pushing. The push FAILED (exit 1) — and had already DROPPED
`sla_rule_test_id_fkey` before it did. The integration case then went red,
which is what was wanted, for entirely the wrong reason: there was no
constraint at all rather than a different one. Nothing in the output said the
constraint was gone; `\d sla_rule` is what found it.

The database was left describing a schema no migration produces, and the next
`migrate deploy` would not have restored it — that migration is already
recorded as applied.

**To red-verify a referential action, change the CONSTRAINT, not the schema
file**, and put it back afterwards:

```
ALTER TABLE sla_rule DROP CONSTRAINT sla_rule_test_id_fkey;
ALTER TABLE sla_rule ADD CONSTRAINT sla_rule_test_id_fkey
  FOREIGN KEY (test_id) REFERENCES test(id) ON DELETE SET NULL ON UPDATE CASCADE;
```

`select confdeltype from pg_constraint where conname = '…'` reads back what is
actually in force — `c` for CASCADE, `n` for SET NULL, `a` for NO ACTION — and
is the only thing worth believing after either of these.

**No compose service here has a volume, so EDITING one destroys its data.**
`docker compose up -d` recreates a container whose service definition changed,
and with no volume the recreated container starts empty — the edit does not
have to be about storage, it just has to be an edit. Postgres is the one that
hurts: you get a running server with no schema, and `test:integration` fails on
missing relations rather than on anything you changed. This has already
happened once, to everyone who pulled the `max_connections=200` line
(`infra/docker-compose.yml`) that live monitoring's connection budget needed.
After any change to that file, assume the database is gone and re-run:

```
pnpm --filter @perfportal/persistence exec prisma migrate deploy --schema prisma/schema.prisma
```

CI never sees this — `.github/workflows/ci.yml` declares its own service
containers and does not read the compose file. Which also means a compose-only
fix is invisible to CI: the `max_connections` override cannot be expressed as a
GitHub Actions service container, so CI still runs Postgres at the stock 100.

**It also cannot race ITSELF, and that failure is the more likely one.** The
same setup truncation means two overlapping `pnpm test:integration`
invocations sabotage each other, and what you get back is not a timeout — it
is unique-constraint violations on slugs, null results mid-test, and
timing-sensitive assertions failing, i.e. a plausible-looking regression that
reproduces on nothing. This has already cost this project two separate
sessions. Before believing an integration failure, run
`ps aux | grep vitest` (or `pgrep -f vitest`) and confirm you are alone, then
re-run once.

Never run `pnpm test:integration` while `scripts/capture-chart-fixture.mjs` is
capturing: that suite truncates every table on setup and will delete the org
the capture just seeded, mid-run.

**The same applies to `pnpm test:e2e` — so run the gate in its documented
order, integration BEFORE e2e, and not the other way round.** Playwright's
`webServer` and the worker it starts do not stop the instant the last spec
passes, and `test:integration` truncating every table underneath a
still-draining queue produces a failure that reproduces on nothing. Seen once,
running the two ad hoc in the reverse order, as a bare `exit 1` with no
reported failing test, then two clean 814-test runs in a row. If integration
fails right after an e2e run and the tail shows no failing assertion, re-run it
alone before believing it.

**There is now a second gate, and `pnpm` does not run it.** The load-generator
telemetry agent is Go, lives at `agent/`, and is outside the pnpm workspace —
so `pnpm lint`, `pnpm typecheck` and every `pnpm test:*` are all blind to it:

```
cd agent && go vet ./... && go test ./... -race
```

`-race` is not optional here. The agent's whole design is a sampler goroutine
writing to a bounded buffer a sender goroutine drains; a data race in that pair
is the one defect class its tests exist to catch, and the race detector is what
makes those tests able to catch it.

**There is now a third toolchain, and `pnpm` is equally blind to it.** The
Gatling Gradle plugin lives at `clients/gatling-gradle/` — JVM/Kotlin, also
outside the pnpm workspace, so `pnpm lint`, `pnpm typecheck` and every
`pnpm test:*` see none of it, same as the Go agent above. Its gate:

```
cd clients/gatling-gradle && ./gradlew build --no-daemon
```

`build` runs its 38-test suite. Its real-stack e2e,
`clients/gatling-gradle/e2e/run-e2e.sh`, is manual and on demand — it needs
the local Docker stack plus the API and worker both running against it, and
is not part of any `pnpm` gate or the CI `plugin` job for that reason.

**BEING IN NO GATE IS EXACTLY WHY IT ROTTED.** That script hard-coded the
plugin version (`0.1.0-SNAPSHOT`) in its own log line and in
`e2e-project/build.gradle.kts`, while the plugin's default version had moved
to `0.2.0-SNAPSHOT`. Every invocation then died in Gradle's plugin-RESOLUTION
phase — "Plugin [id: 'dev.vantrix.gatling', version: '0.1.0-SNAPSHOT'] was not
found" — before Gatling, the platform, or anything this gate exists to prove.
The script now DERIVES the version from the plugin build the same way CI's own
`plugin-consume` job already did (`awk '/^version:/{print $2}'`) and passes it
as `-PvantrixPluginVersion`; `e2e-project` declares no version at all. It also
checks that the plugin MARKER artifact landed in `~/.m2`, because a missing
marker fails with the SAME message a wrong version does.

Anything else written down in two places here has the same half-life. Run
this gate after touching the plugin, its publishing, or the fixture
simulation.


## Conventions that bite

**Expectations are computed from the payload, never written down.** A test that
hard-codes a value `apps/web/test/fixtures/reference-run.json` supplies breaks
on the next re-capture for a reason that is not a defect. Derive it.

**`?name=X` without `scope` is silently ignored.** The metrics endpoints force
`name` to `''` when `scope` is absent, so a scoped call missing `scope` returns
the whole run's data with a 200. Both parameters, always. Test the omission,
not just the correct call.

**An instant column must be `timestamptz`, because Prisma and node-postgres
disagree about a bare `timestamp`.** Prisma decodes `timestamp without time
zone` as UTC; node-postgres decodes it in the NODE PROCESS's local zone, and
serializes a JS Date PARAMETER in local time too. A column holding UTC by
convention therefore reads back differently depending on which client asked,
and both halves of that have already shipped here: the worker passes
`tool_started_at` as an ISO string to survive the write side
(`pipeline.service.ts`), and `GET /v1/runs/:id/trends` — the one read that goes
through the raw pool (`TRENDS_SQL`) — reported a start time 5h30m off the
`GET /v1/runs/:id` value for the same row on an Asia/Kolkata machine. **It is
invisible in UTC**, so CI can never catch it: a test comparing the two
endpoints passes on every runner regardless. `run`'s columns are timestamptz as
of `20260817000000_run_timestamps_are_timestamptz`; `telemetry_sample`'s always
were. The remaining bare-`timestamp` columns (`org`, `project`, `api_token`,
`org_member`, Better Auth's own tables) are read only through Prisma today —
put a raw-pool read on one and it is the same bug again.

**A test for a timezone bug must SET the timezone, and prove it took.** Node
honours `process.env.TZ` changed after startup, so the case can flip to
`Asia/Kolkata` mid-test — but on a UTC runner the offset is zero and a case
that merely compares two endpoints passes whether or not the bug is there.
`trends.integration.test.ts`'s zone case asserts the flip landed
(`new Date('…T00:00:00Z').getHours() === 5`) before asserting anything else, and
restores the old value in a `finally` — integration files share a worker
process (`fileParallelism: false`), so a leaked `TZ` becomes someone else's
mystery failure.

**A `type: 'value'` x-axis needs PAIR-shaped series, and scalars on one fail
silently.** `ChartData.series[].data` has two forms — one value per
`axisLabels` entry, or explicit `[x, y]` pairs — and `Chart` hands whichever it
is straight to ECharts. Give a value axis the scalar form and ECharts maps each
number onto BOTH axes: the chart plots the measure against itself, a straight
45° line, with both axes carrying the same range. It throws nothing and logs
nothing. `TimeBrush` did this for its whole life, and because the dataZoom
slider reports its handles in the AXIS' units, every drag committed a window in
rate values read as milliseconds — a drag over a third of a 63 s run produced
`?from=0&to=7`. When adding `xAxis={{ type: 'value' }}`, check the transform
emits pairs (`toErrorSeries`, `toPercentileDistribution` and
`toRequestRate(_, { x: 'ms' })` do).

**§22.6's mobile rule is the app's ONE JS breakpoint, and it has to be.** Every
other responsive decision here is a Tailwind class, and should stay that way.
Below 768px the run page is a read-only summary because "deep analysis is
explicitly a desktop task" — and a class can only HIDE the charts, leaving a
phone paying for ten ECharts instances, a statistics table of every request, and
the four payloads behind them, to display none of it. That is the "degrading
badly" the rule exists to prevent, so `useIsCompact()` decides and the charts
never mount. `DesktopOnly` takes its children as a FUNCTION for the same reason:
a node would be built before the component could decline it. Its `onShow` exists
because the withheld content usually needs data, and the caller's queries are
`enabled` on the same flag — leaving the decision inside would fetch payloads it
had just been told not to draw.

**A CONNECTED `axisPointer` ON A CATEGORY AXIS SYNCS BY INDEX, not by time.**
So charts sharing a crosshair (`Chart`'s `group`) point at the same INSTANT only
if their category lists are identical — and on a run page they are not:
`/series` is sparse (a second with no request produces no bucket at all), so the
reference run carries 62 response-time buckets against 63 user buckets, spanning
the same start and the same end. One payload has a hole in the middle, and every
index past it is a second out. The fix is that every time chart is now a VALUE
axis in milliseconds, pinned to one `[0, durationMs]` domain
(`useTimeDomainFromShell`) and labelled in seconds via `tickUnit`. **Adding a
time chart means pairs plus that domain, never a category axis** —
`timeAxis.test.ts` is the guard, and the failure it prevents is silent.

**Two things follow a value axis that are easy to miss.** A pair-shaped series
makes the tooltip print BOTH components (`"42000, 127.75 ms"`) unless the chart
declares `pairValue="y"` — right for a scatter, whose x is a measurement, wrong
for a time series, whose x is already the tooltip's title. And the axis
POINTER's label IS that title, so it needs the same unit formatting as the
ticks or the tooltip announces `49,000.00` above an axis reading `0..100`.

**A `<caption>`'s WORDS become the table's accessible name, and Playwright
matches names as a case-insensitive SUBSTRING.** So adding a table whose caption
merely mentions an existing table's subject breaks that table's query, in a file
you did not touch. `run-tables.spec.ts` reaches the statistics table with
`getByRole('table', { name: /statistics/i })`; the G-05 assertions table shipped
with a caption reading "…re-checked against this run's statistics", and five
specs failed at once on a strict-mode violation resolving two elements. Same
class as the `ProjectRail` collision below — the query was never wrong, the new
name simply collided with it. **Before adding a table, grep the e2e suite for
`getByRole('table'` and make sure your caption shares no distinctive word with
an existing one.**

**Sharing a transform does NOT share its colours — `roles` is a separate,
silently-optional prop.** `Chart` falls back to the six-hue categorical palette
whenever `roles` is absent, so a chart can consume the right numbers and draw
them in the wrong language with nothing failing. `TimeBrush` and `RatesChart`
both call `toRequestRate`, but only `RatesChart` passed `RATE_ROLES`
(`['neutral','passed','failed']`) — so the run page drew All/OK/KO as
grey/green/red in one figure and indigo/teal/**violet** in the figure directly
above it, with KO in a hue `rates.ts` explicitly reserves for "neither
outcome". Nothing threw, no test failed, and both components' own tests stayed
green because neither asserted colour. **When a transform exports a `*_ROLES`
constant, every chart built on that transform has to pass it**; `TimeBrush.test.tsx`
now pins that for this pair by asserting the emitted `color` array contains no
`CATEGORICAL` hue.

**The value axis' `name` and a top-anchored legend occupy the same band.** A
value axis draws its name one `nameGap` ABOVE the axis line — i.e. directly
above `grid.top`, exactly where `legend: { top: 0 }` sits. They always compete,
and on the percentile chart they collided at every width: at 1568px the `min`
swatch was drawn over `Response time (ms)`, and at 390px the wrapped legend
covered both the axis name and the topmost tick label. The legend is now
bottom-anchored and `type: 'scroll'` — one row, always, because a wrapping
legend has no bounded height and no reservation in `grid.bottom` could be right
at every width. **jsdom cannot see any of this** (it lays every chart out at
0×0), so the guard in `Chart.test.tsx` asserts the layout NUMBERS — that the
legend carries `bottom` and no `top`, and that `grid.bottom` clears both it and
the brush slider.

**A mocked renderer cannot see it either, and neither can a green unit suite on
both sides.** `Chart.test.tsx` proved the brush reports its handles in the
axis' own units; `transforms.rates.test.ts` proved the transform's numbers.
Both stayed green while the two disagreed about what those units WERE, because
nothing asserted the join. That is what `apps/web/test/TimeBrush.test.tsx` is
for — assert the numbers a component hands the renderer for x, not just that
each side is internally consistent.

**A jsdom test cannot see an accessible-name defect.** `dom-accessibility-api`
does not consult a descendant's `aria-label`; Chromium does. A `<button
aria-label>` inside a `<th>` therefore pollutes the header's name in a browser
and in no unit test. Those assertions belong in Playwright.

**`getByRole(role, { name })` is EXACT in Testing Library and a
case-insensitive SUBSTRING in Playwright.** The same call reads as the same
assertion in `apps/web/test` and `apps/web/e2e`, but it is not: Playwright's
default `name` match will pass `{ name: 'Beta' }` against rendered text
`'beta'`, or against `'Beta Checkout'`. Pass `exact: true` whenever a
fallback value (a slug, an id, a placeholder) could be a substring or case
variant of the value you actually mean to require — otherwise the assertion
passes whether or not the real value ever loaded. Cheaper still: pick fixture
values that cannot collide with their fallback in the first place —
`'beta'`/`'Beta Checkout Flow'`, never `'beta'`/`'Beta'`.

**TWO SIBLINGS KEYED OFF THE SAME ROUTE PARAMS GET THE SAME KEY, AND REACT
RENDERS ONE OF THEM FOUR TIMES.** This codebase uses `key={slug}` to FORCE a
remount in several places — `ProjectRuns`, `TestRuns` — because a same-route
param change otherwise reuses a component instance and carries its cursor or
its half-typed form into a scope where neither belongs. That is right, and it
has a trap: `TestRuns` came to hold two such siblings, `ProjectRules` and
`RunList`, both keyed `` `${slug}/${testSlug}` ``. Identical keys among
siblings.

React does not error. It rendered the rules panel FOUR times, behind a console
warning ("Encountered two children with the same key") that nobody reads in a
browser tab. Every jsdom case kept passing, because each queried something
unique to the page. The e2e suite caught it as
`getByRole('button', { name: 'Add rule' }) resolved to 2 elements` — the
symptom, two layers from the cause.

**Prefix a remount key with what it is keying** — `` `rules:${slug}/${test}` ``,
`` `runs:${slug}/${test}` `` — the moment a second sibling gets one. And when a
strict-mode violation reports a duplicate that no source file duplicates, count
the RENDERED components before hunting for a second JSX site: `TestRuns.test.tsx`'s
"mounts exactly one rules panel" is that check, and it fails with the cause
attached.

**Every page-scoped `getByRole('link', { name })` in the e2e suite now shares
a document with N rail links.** `ProjectRail` (`apps/web/src/ProjectRail.tsx`)
renders on every authenticated page — **All runs** plus one link per
project — so a link query that used to have the page mostly to itself can
now also be satisfied by a rail row instead of the one it meant to find,
under Playwright's case-insensitive substring default above. Green today
only because no seeded project name collides with a page's own link text;
that is a standing constraint on fixture naming from here on, not a one-off
check to pass once. (The brand link moved to `AppShell`'s header in the
design pass, but it is still in the document on every page — same rule.)

**AND IT RUNS THE OTHER WAY: A PAGE MAY NOT ADD A LINK NAMED LIKE A RAIL
ROW.** The note above is about fixture NAMES colliding with a page's links;
the test-ui branch hit the mirror image, which is a product defect rather
than a test one. `ProjectTests` shipped an action link reading **All runs**,
pointing at that project's run list — the identical accessible name the
rail's own row carries for the ORG-WIDE list, in every authenticated
document. Two links, one name, two destinations; a screen-reader user hears
the same words for both. `project-tests.spec.ts` failed as a strict-mode
violation naming both elements, which is the only reason it was caught
before merge. The label is **Project runs** now. **The rail's vocabulary —
"All runs", and every project name — is reserved: a page's own controls have
to be named around it.**

**A truncated read does not throw — `subarray` returns a short buffer.**
`BinaryReader.readString` reads a length then slices, and slicing past the
end yields fewer bytes with nothing raised, so a truncated string decoded to
a plausible wrong value. Every primitive now bounds-checks explicitly and
throws `TruncatedError`, which a streaming caller distinguishes from
corruption: it rewinds and waits on the first, gives up on the second.

**There is exactly ONE record decoder, and that is deliberate.**
`packages/plugin-gatling/src/record-decoder.ts` is shared by
`parseSimulationLog` (pull, finished buffer) and `StreamingLogDecoder` (push,
live feed). A second copy was written and removed during this work: drift
between two decoders surfaces as the live chart contradicting the final
report, which is the worst failure this product can produce. Do not
re-duplicate it.

**A replay must be acknowledged, never re-written.** `POST
/v1/runs/:id/stream` with an offset behind the cursor returns 202 and writes
nothing. Writing it re-creates an orphan chunk object at an unvalidated key,
which `LiveChunkStore.finalize` then splices into the assembled log — and
`close()` hashes the corrupt assembly, so the checksum passes and the decoder
eats it. The bytes are already stored, because the cursor only advances after
the write.

**A raw-body handler must reject an ALREADY-CONSUMED request, not wait on
it.** Nest registers Express's global `json()` and `urlencoded()`, and either
one fully drains a body whose Content-Type matches its own before any handler
runs. A handler that then attaches `'data'`/`'end'` to that stream waits for
an `'end'` that has already happened and will never fire again: no response,
one leaked socket and one leaked promise per request, and no timeout on the
path. `readRawBody` (`live.controller.ts`) guards on `req.readableEnded` —
true only once `'end'` has actually been emitted, so a body nobody has read
yet, including a legitimate zero-byte one, still reads `false`. The sibling
`readMultipart` never had the bug (`req.pipe(bb)` on an ended stream fires
`'close'` and rejects), which is exactly why it is easy to reintroduce.
**Test the wrong Content-Type with a request DEADLINE** — without one the
case does not fail, it hangs, and takes the file's whole `testTimeout` with
it.

**A per-request memory cap is not a per-run size cap.** `MAX_BUNDLE_BYTES`
(512 MB) bounds a whole run; `MAX_STREAM_CHUNK_BYTES` (8 MiB) bounds one
`POST /v1/runs/:id/stream` body, which the API buffers in memory before it
can judge the offset — so sharing the first number let one in-flight request
pin 512 MB and N requests pin N × that, even for a chunk about to be refused
as a gap. Both answer 413 under `BUNDLE_TOO_LARGE`; the message says which,
because re-chunking fixes one and not the other. Whenever a limit's number
looks reusable, check the two limits bound the same THING first.

**`close()` releases its claim only up to `finalizeLive`.** The claim
(`claimForClose`) is reverted by `releaseClose` when an object-store step
fails, which is right — those are retryable. `queue.add` is not: past
`finalizeLive` the bundle is assembled, hashed and recorded, and the
per-chunk objects are deleted, so reverting to `running` re-opens
`advanceOffset` to bytes that a retried `close()` will silently drop
(`finalize`'s `exists(key)` guard skips the re-assembly, deletes the new
chunks anyway, and hashes the stale bundle). Recovery past that point is the
sweeper's `parsing` branch, not a client retry. `releaseClose` is called with
its own rejection swallowed, so a failing compensating write cannot replace
the error that caused it.

**The sweeper measures `parsing` staleness from `parsing_started_at`, and
`running` staleness from `stream_updated_at` — never `created_at` for
either.** A live run's `created_at` is its OPEN time, so any run
streaming longer than `parsingStaleAfterMs` (15 min default) was sweepable
the instant `close()` moved it to `parsing` — the sweeper would re-enqueue
it, the pipeline would run against an empty `bundleSha256`, and the run would
be permanently `failed` while `close()`'s own write silently no-opped.
`finalizeLive` requires `status: 'parsing'` exactly (`run.ts`); `markIncomplete`
excludes `'failed'` (among other terminal states) from the rows it will touch
— two different guards, but both already miss once the sweeper's premature
re-enqueue has driven the pipeline to mark the row `failed` first, which is
what makes `close()`'s own write a silent no-op rather than a conflict. The
sweeper reads `COALESCE(parsing_started_at, created_at)` so rows predating
the migration stay sweepable. `running` is the same trap one state over and
needed its own column: a soak run streams for hours, so ageing it from
`created_at` would finalize a healthy mid-stream run as `incomplete` purely
for being long. What "stale" means there is that the PRODUCER stopped, so
`advanceOffset` stamps `stream_updated_at` on every ACCEPTED chunk — not on
a replay, which proves the agent is alive but not that it is progressing.
That branch finalizes in place via `markIncomplete`; it must never
re-enqueue, because nothing is assembled at `bundleKey` until `close()` runs.

**A raw SQL write inside the sweeper's transaction cannot be a Prisma call.**
`sweep()` holds its rows under `FOR UPDATE` in its own transaction, so
reaching for `RunRepository` would open a SECOND connection and block on the
lock this transaction holds — a self-deadlock that resolves only when the
pool times out. `Sweeper` is constructed with a `pg.Pool` and no Prisma
client for that reason; a new terminal transition there is hand-written SQL
on the sweep's own client, carrying the repository method's guard verbatim.

**A run status absent from `statusFor` inherits the `202` fallthrough,
silently.** `RunsService.statusFor` is the one function `POST /v1/runs` and
`GET /v1/runs/{id}` both call through `respondWithRun` — that sharing is the
entire "same code for the same state" guarantee. It has explicit branches for
`failed`, `incomplete`, and `complete`; everything else falls through to
`202`, which is correct for `pending`/`parsing`/`running` but wrong for any
future terminal status that forgets to add its own branch. This is not
hypothetical: `incomplete` shipped with exactly that bug first — before
`statusFor` gained its `run.status === 'incomplete'` line, a closed,
zero-byte run answered `202` with a `Retry-After` header and no `verdict`
field, forever, because an aborted live run has no worker left to ever move
it past 202. Add a status to `statusFor` in the same change that adds it to
`RunStatusSchema`.

**A fold cursor is a fetch frontier, not a decode position.**
`LiveChunkStore.readFrom` returns every chunk whose **start** offset is at
or past the offset it is given (`packages/storage/src/live-chunks.ts`) — it
wants the highest byte already FETCHED. `StreamingLogDecoder.consumedBytes`
is the last whole-record boundary instead, and it routinely sits *behind*
the last byte fetched: a record straddling a chunk boundary leaves a partial
tail the decoder buffers and reports as unconsumed. Passing that value to
`readFrom` re-selects chunks already delivered; the decoder splices them in
again after the tail it correctly retained, and every absolute position from
there on is wrong, silently, for the rest of the run. `LiveFoldOwner`'s
`FoldState.fetchedBytes` tracks the fetch frontier instead, advanced by the
length of the bytes just received — exact, because offset negotiation only
ever accepts a chunk at `offset === cursor` (`LiveService.stream`), so a
run's chunks tile `[0, stream_offset)` with no gap and no overlap.
`fold-owner.integration.test.ts`'s "folds correctly when chunks are smaller
than a single record, across several ticks" is the guard.

**Two series, two widths.** `UserSeries` coalesces against its own
`maxBucketsUsers` cap, independent of the response-time series'
`maxBucketsRun`, and on its own per-scenario schedule — bucket count tracks
a scenario's active SPAN, not its event volume, so a run whose scenarios
have staggered durations genuinely holds two widths at once
(`packages/statistics/src/users.ts`). A live delta therefore carries one
`widthMs` per envelope, never one for the whole message. The users width is
the **minimum** across scenarios, not the maximum: every real width is
`1000 × 2^k`, so the finest width divides every coarser scenario's offsets
exactly, while a coarser width does not divide a finer scenario's —
declaring anything but the minimum leaves a fine scenario's real offsets as
non-multiples of the declared width. `apps/worker/test/live-delta.test.ts`'s
"reduces the users envelope width to the FINEST scenario, not the coarsest"
is the guard.

**The owned-run cap and the pool size are one decision.** `createPool`
defaults to `new pg.Pool({ max: 10 })` with no `connectionTimeoutMillis`
(`packages/persistence/src/client.ts`), and the worker hands that ONE pool
to `PipelineService`, `Sweeper`, and `LiveFoldOwner` alike
(`apps/worker/src/main.ts`). A `maxOwnedRuns` cap above what the pool can
serve does not degrade — it deadlocks the whole worker: at ten owned runs
every client is held by a `FoldState`, the eleventh `pool.connect()` queues
forever because pg's own default connection timeout is 0, `tick()` never
reaches its fold loop, and the pipeline and sweeper starve behind it, with
no error, no timeout, no log. `main.ts` now sizes the pool as `maxOwnedRuns`
plus one client for the fold owner's own discovery query, `concurrency * 2`
for the pipeline's worst case, and one for the sweeper — and sets a
10-second `connectionTimeoutMillis`, so a future mis-sizing surfaces as a
loud, rejected `connect()` instead of a silent, permanent stall.

**A cursor must not advance past a failed publish.** `LiveFoldOwner#publish`
builds a delta from `state.cursor`, then writes it to both `PUBLISH
live:{runId}` and `XADD live:{runId}:deltas`; that cursor carries the
coalesce-replacement flag (`lastBucketWidthMs`) the NEXT delta's replacement
decision is computed from. Advancing `state.cursor` before either Redis call
means a dropped connection on the very tick the buckets halve loses that
tick's `replaces: true` — the next delta then computes `replaces = width !==
prev.lastBucketWidthMs` against a width the cursor already (wrongly) equals,
so it silently presents new-width buckets as a plain upsert into a series
the consumer never got the replacement for. On failure only `seq` advances
(`{ ...state.cursor, seq: next.seq }`): a consumer still needs a gap-free
`seq` to detect a drop, but nothing about `replaces`/`since` may be assumed
to have reached anyone. `fold-owner.integration.test.ts`'s "preserves the
coalesce replacement flag across a failed publish, so the next tick still
replaces rather than silently upserting" is the guard.

## Conventions the design pass added

Each of these shipped as a real defect first and was caught by a browser, not
by the unit suite.

**`text-transform` AND PLAYWRIGHT ACCESSIBLE NAMES — THIS NOTE WAS WRONG, AND
THE CORRECTION IS THE POINT.** It read: "Playwright computes accessible names
in its own injected script and applies `text-transform`, so a
`<th class="uppercase">Percentage</th>` is named `PERCENTAGE` and
`getByRole('columnheader', { name: 'Percentage', exact: true })` no longer
resolves… **Never put `uppercase` on anything queried by accessible name**."

MEASURED ON PLAYWRIGHT 1.62.1, TWICE, AND IT DOES NOT REPRODUCE. `uppercase`
was added to `tableStyles.ts`'s `TH` (every column heading in the app) and to
`components/Badge.tsx` (every status and verdict pill, including the ones
inside `<td>`s whose names come from content), then the whole e2e suite was
run against each change separately: **94 passed both times**, including
`run-tables.spec.ts`'s `getByRole('columnheader', { name, exact: true })`
sweep and `run-list.spec.ts`'s `expect(statusCell).toHaveAccessibleName('complete')`.

The reason is that `text-transform` is a RENDERING property and the DOM text
is untouched: `td.textContent` is still `●complete` with the pill drawn
`COMPLETE`. That is also why it is safe for real users — a screen reader
announces "complete", not the spelled-out capitals some readers produce for
all-caps strings.

WHAT REMAINS TRUE: whatever the accessible name is computed FROM must stay
put. Uppercase the RENDERING freely; do not uppercase the DATA (`marks.tsx`'s
labels) or an `aria-label`, because those are the name. And a `<th>` whose
name you change for real still breaks its query.

Do not restore the old prohibition without re-measuring — it cost the
control-room redesign its uppercase LED badges and column headings on a
constraint that no longer exists. If a future Playwright reinstates the
behaviour, the e2e suite says so in 90 seconds; that run is the arbiter, not
this paragraph.

**A token that is not in `@theme` produces NO utility, silently.** Tailwind v4
generates utilities only from `@theme` declarations, never from a bare `:root`
custom property. `text-accent-foreground` looked correct in the markup, matched
a real token in `tokens.css`, and emitted no CSS at all — so the skip link and
every primary button inherited `color` from `body` and rendered dark slate on
indigo at 2.84:1. Publish the alias under a DIFFERENT name than the runtime
token (`--color-on-accent: var(--color-accent-foreground)`), because a key that
reads a `var()` of its own name also resolves to nothing, equally silently.

**AN `<svg>` INSIDE A CHART `<figure>` USED TO BREAK NINE SPECS. IT NO LONGER
DOES, AND THE FIX IS THE INTERESTING PART.** This entry read: "a decorative
`<svg>` inside a chart `<figure>` breaks nine specs… icons are fine everywhere
else; not in there."

It was true, and it was a design rule handed down by a test convenience.
`run-charts.spec.ts` and `request-detail.spec.ts` proved a chart really drew by
counting SVG elements **within the whole figure** — `getByTestId('chart-x')
.locator('svg')`, `toHaveCount(1)`, in twenty-two places across seven files. So
any icon in a chart card corrupted the count, and the prohibition followed.

`Chart` now marks its ECharts container `data-chart-canvas`, and `helpers.ts`
exports `plot(scope)` for `scope.locator('[data-chart-canvas] svg')`. **The new
form is strictly HARDER to satisfy**: "this figure holds one SVG" could in
principle be answered by something that is not the plot; "the canvas holds one
SVG" cannot. Nothing was weakened to make room for the icons.

What survives: the invariant itself. A chart that failed to draw renders its
axes and nothing else, and only a mark count catches that — every `plot()` call
site still asserts `toHaveCount(1)` plus an attached `path`. And one
`locator('svg')` is deliberately still raw, in `run-live.spec.ts`: the SLA
banner asserts the WHOLE component carries no SVG, which is a claim about a
component rather than about a plot it does not have.

**The general lesson is worth more than the rule it replaces.** When a test
spells an invariant more broadly than it means, the extra breadth becomes a
constraint on the product — silently, and in a place nobody thinks to look for
one. The fix is to narrow the assertion to what it actually claims, not to
work around it.

**`focus:not-sr-only` resets `padding` to 0.** It has to, to undo `sr-only` —
and a `focus:`-variant utility outranks an unprefixed one, so `sr-only … px-3
focus:not-sr-only` reveals a skip link with no padding. Every visual utility on
a skip link must be `focus:`-prefixed, including the padding.

**A `<caption>` is as wide as its TABLE, not its scroll box.** Put a table in
`overflow-x-auto` and its caption stops wrapping at the viewport and scrolls
sideways with the columns — on a phone the reader gets half a sentence and has
to drag a data table to finish it. `components/TableFrame.tsx` is the fix:
one caption node, drawn visibly outside the scroller and again as the real
`sr-only` `<caption>` inside, so the accessible name and the
`caption.textContent` assertions in `ErrorsTable.test.tsx` /
`StatisticsTable.test.tsx` keep working.
