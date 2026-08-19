# Live SLA signals — design (FR-LIVE-6)

**Status:** design, approved 2026-08-19
**Requirement:** FR-LIVE-6 (P1) — "Live SLA evaluation may fire **early-abort
signals** — the platform reports the breach; the decision to stop the test
remains with the caller."
**Builds on:** live run monitoring parts 1, 2a and 2b (M7, merged).

A running load test already publishes a statistics delta every few seconds and
draws it on a live page. This adds one thing: while the run is in flight, the
project's SLA rules are evaluated against that same fold, and any rule
**currently** breaching is reported on the page.

---

## 0. What this is not

**It does not stop anything.** The requirement's own wording is that the
platform reports and the caller decides. Nothing here aborts a run, signals the
load generator, or touches the agent.

**It does not change a verdict.** The authoritative evaluation is still the one
`PipelineService` runs at parse time against the finished run, and that is the
only thing that writes `run.verdict` or `run_assertion`. A live breach is a
signal to a human watching; it is not evidence about the run's outcome, because
it is computed from a partial fold that has not finished.

**It persists nothing.** No migration, no new table, no write path in the fold
owner. A breach exists while it is breaching and then it is gone. That is what
an early-abort signal is for: you look, you see the run is in trouble *now*,
you decide whether to kill it. Recording breach intervals for a finished
report is a genuinely useful but different feature, and it is not this one.

**It notifies nobody.** There are no notification channels in this codebase —
no Slack, no webhook, no email — and building them is M5. The audience here is
whoever has the live page open.

---

## 1. Where the evaluation runs

In `LiveFoldOwner`, on the tick it already takes. It has an `EngineResult`
every `liveTickMs` and publishes a delta from it; the SLA evaluation folds into
that same step and rides the same message.

### 1.1 Rules are snapshotted at claim, not read per tick

`LiveFoldOwner` gains a `RuleRepository` — `createPrisma` is already
constructed in `apps/worker/src/main.ts`, so this is a constructor argument,
not new infrastructure. Rules are loaded **once**, when a run is claimed, and
held in `FoldState`.

That is not only to avoid N queries per tick. **A run's SLA should be the SLA
it started under.** A rule edited at minute 40 of a four-hour soak
retroactively changing what that run is being judged against is worse than a
stale read — the reader would see a breach appear with no change in the data.
The batch path has this property for free, because it evaluates once at the
end against rules read once; the live path has to choose it deliberately.

The cost is that a genuinely urgent rule change does not reach a run already in
flight. That is the right trade for a signal whose whole value is that a change
in it means a change in the *run*.

### 1.2 The stat mapping is extracted, not copied

`apps/worker/src/pipeline/pipeline.service.ts:301` maps `EngineResult.stats`
(`StatRollup[]`) into `EvaluableStat[]` inline, field by field. The fold owner
needs exactly that mapping.

**A second copy is the defect this project keeps re-learning.** It has already
been paid for twice: once by the record decoder (one decoder, deliberately,
because drift surfaces as the live chart contradicting the final report), and
once by `percentilesOf` (extracted to `bucketLatency` for the same reason in
part 2b). A live breach that disagrees with the final verdict for the same run
is the same failure on the same product surface, and it arrives by the same
route.

The mapping moves to `@perfportal/sla` as `toEvaluableStats(stats)`, and both
`PipelineService` and `LiveFoldOwner` call it. Neither keeps its own.

---

## 2. The minimum-evidence gate

### 2.1 Why a gate is required at all

The batch evaluator runs once, on a complete run, with warm-up already excluded
by the engine. The live evaluator runs every five seconds, including at second
six, when a p99 rests on a handful of requests. Ungated, the first minute of
every run would breach almost any latency threshold, and readers would learn to
ignore the banner — which is strictly worse than not having it.

### 2.2 The gate is an option on the existing evaluator, defaulting off

`evaluateRules(rules, stats)` gains an optional third argument carrying a
minimum-observation requirement. **Called without it, behaviour is byte
identical** — the batch path passes nothing and every existing test over it
holds unchanged (`apps/api/test/verdict.integration.test.ts` among them).

The gate lives inside the evaluator rather than in the live caller because
deciding *which stat a rule resolves to* is the evaluator's own job
(`resolveMetric`, the scope/family candidate matching). A caller that filtered
thin rules beforehand would have to reimplement that matching, which is the
§1.2 mistake one level down.

### 2.3 A gated rule is `not_applicable`, with a populated `actualValue`

`AssertionOutcome` already has `not_applicable`, and it already means "this
rule could not be judged". A gated rule is that. **No fourth outcome is
introduced** — a new outcome would need handling in every consumer, including
the web `ASSERTION_OUTCOME` map and its glyphs, for a distinction only the live
path makes.

The distinguishing information goes in the `message`, which already carries a
human-readable reason.

One documented contract widens. `EvaluatedAssertion.actualValue` is commented
"null when not_applicable — there was nothing to measure". For a gated rule
there *is* something to measure, just not enough of it, and reporting it is
more useful than discarding it ("p99 is 900 ms, but on 40 samples"). The
comment becomes: null when there was nothing to measure, populated when there
was too little to trust. No existing consumer depends on the pairing — checked
across `apps/` and `packages/`; the one test asserting `actualValue` is null
(`verdict.integration.test.ts:159`) covers a batch case the default leaves
untouched.

### 2.4 The threshold scales with how deep in the tail the metric reads

A flat count is wrong in both directions: 100 observations is generous for a
p50 and meaningless for a p99, where it is a single sample in the tail.

For a percentile rule `pXX`, the requirement is `10 x 100/(100 - XX)`
observations — p50 needs 20, p95 needs 200, p99 needs 1000. For the scalar
metrics (`count`, `mean`, `min`, `max`, `stddev`, `error_rate`,
`throughput_rps`) it is a flat 100.

The factor of 10 is a judgement, not a derivation: it asks for ten expected
observations beyond the quantile before trusting it. It is one constant in one
file, and the spec states it as a starting value to be revised against real
runs rather than as a proven bound.

---

## 3. A breach is a state, not an event

### 3.1 What that buys

The delta reports which rules are breaching **now**, and since when. Recovery
clears them with no extra mechanism, no debouncing, and no de-duplication: the
page renders whatever the current message says. A reader who looks sees the
truth at that moment, which is precisely the question an early-abort decision
turns on.

An event stream would need every one of those: suppression of repeats, a
recovery event, and a rule for what a reader who arrives mid-run should be
shown.

### 3.2 On the wire

The delta gains one envelope:

```
sla: {
  evaluated: number,          // rules that passed the gate this tick
  breaching: [{
    ruleId: string,
    description: string,      // the evaluator's own `message`
    actualValue: number,
    sinceOffsetMs: number,
  }],
}
```

Only breaching rules are listed; `evaluated` is a count, so the page can say
"2 of 7 rules breaching" without carrying six passing rules every tick. Bounded
by rules-per-project, which is a handful — this envelope does not need the
size analysis the response-time series did.

### 3.3 `sinceOffsetMs` is the fold owner's own memory

The evaluator is pure and stateless; it cannot know when a breach started. The
fold owner keeps a `Map<ruleId, number>` in `FoldState`: an entry is written
when a rule transitions into breaching, read while it stays breaching, and
deleted when it recovers or when the rule stops being evaluated.

**A rule that drops back below the evidence gate is a recovery for this
purpose** — its entry is cleared. The alternative (freezing the timer) would
report a rule as "breaching for 4 minutes" when it has not been judged at all
for three of them.

---

## 4. The dashboard

A banner on the live page, above the charts, naming each breaching rule and how
long it has been breaching. It renders only when `breaching` is non-empty.

**A banner, not a toast.** The decision in §3 is that a breach is a condition
you can look at, not an event you might miss; a toast asserts the opposite and
would fire on every reconnect. The live page already has a banner idiom from
the finalizing state.

Nothing else on the page changes. The charts do not gain rule markers — that is
a real idea and a separate one, and it needs a threshold-to-axis mapping this
design does not have.

---

## 5. Testing

### 5.1 Live and batch agree on identical input

The load-bearing test. Given one `EngineResult`, `toEvaluableStats` plus
`evaluateRules` must produce the same assertions on both paths. This is what
§1.2's extraction exists to guarantee, and it is what stops the two drifting
later.

### 5.2 The gate returns `not_applicable`, never `failed`

A rule whose stat is below the requirement must not report a breach, however
badly the thin value violates the threshold. The inverse case matters equally:
once the count crosses, the same rule and the same data must breach.

### 5.3 The batch path is unchanged by the option's existence

`evaluateRules` called with two arguments produces byte-identical output to
today. The existing SLA and verdict suites are the evidence.

### 5.4 The state transitions

Breach begins (entry written, `sinceOffsetMs` set), holds across ticks
(`sinceOffsetMs` stable, not re-stamped), clears on recovery, and clears when a
rule falls back below the gate.

### 5.5 A rule edited mid-run does not disturb a running evaluation

Claim a run, change the rule in the database, tick again, and assert the
evaluation still uses the snapshot.

### 5.6 Gate reminders

Node 22 (`nvm use`); on Node 20 roughly two thirds of the unit suite silently
does not load.

```
pnpm typecheck && pnpm lint && pnpm test:unit && pnpm test:integration && pnpm test:e2e
```

integration BEFORE e2e, each run alone — that suite truncates every table on
setup, so two overlapping runs sabotage each other and produce failures that
reproduce on nothing.

The Go agent is untouched by this work and outside the pnpm workspace.

---

## 6. Out of scope

| Excluded | Why |
|---|---|
| Stopping a run, or signalling the load generator | The requirement says the caller decides |
| Any effect on `run.verdict` or `run_assertion` | The parse-time evaluation stays authoritative |
| Persisting breach intervals | §0 — useful, different feature |
| Slack / webhook / email | M5, unbuilt |
| A machine-readable breach on `GET /v1/runs/:id` | Deliberate: the audience chosen for this pass is a human watching the page |
| Rule markers on the charts | Needs a threshold-to-axis mapping this design does not have |

---

## 7. Requirement coverage

| Requirement | Where |
|---|---|
| FR-LIVE-6 — live SLA evaluation fires early-abort signals | §1, §3 |
| FR-LIVE-6 — the platform reports, the caller decides | §0, §4 |

---

## 8. Sequencing

1. **Extract `toEvaluableStats`** to `@perfportal/sla` and switch
   `PipelineService` to it. Pure refactor; the existing suites are the proof.
2. **Add the gate option** to `evaluateRules`, defaulting off. §5.2 and §5.3
   pass here.
3. **Evaluate in the fold owner** — rules at claim, evaluation per tick, the
   `sinceOffsetMs` map. §5.1, §5.4 and §5.5 pass here.
4. **The envelope and the banner.**

Step 1 is deliberately first and deliberately boring, for the same reason it
was in part 2b: it makes the live and batch answers equal by construction
rather than by review, and everything after it depends on that being settled.
