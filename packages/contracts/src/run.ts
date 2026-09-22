import { z } from 'zod';

export const RunStatusSchema = z.enum([
  'pending', 'parsing',
  // Opened for streaming, accepting batches. Reported as 202 exactly like
  // pending/parsing, so a CI poll loop needs no change.
  'running',
  'complete', 'failed',
  // Closed without its producer saying so -- inactivity or abort. All received
  // data is retained and the run is labelled; its verdict is always
  // not_evaluated, because a partial run can satisfy every SLA rule purely by
  // having stopped before the load that would have broken it (FR-LIVE-5).
  'incomplete',
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const RunVerdictSchema = z.enum(['passed', 'failed', 'not_evaluated']);
export type RunVerdict = z.infer<typeof RunVerdictSchema>;

export const AssertionOutcomeSchema = z.enum(['passed', 'failed', 'not_applicable']);
export type AssertionOutcome = z.infer<typeof AssertionOutcomeSchema>;

/**
 * The six fields the evaluator needs to judge a run, and the six a reader
 * needs to be told what was judged.
 *
 * NAMED because it has two consumers now. `AssertionSchema` below is the
 * BATCH path — an assertion recorded when a run finished — and
 * `LiveBreachSchema` (`live-delta.ts`) is the LIVE one, a rule breaching in
 * a run still streaming. Both render through `describeSlaOutcome`, which
 * takes exactly this shape.
 *
 * Two inline copies would be the "two expressions deciding one thing" shape
 * this repo keeps recording: they agree today, and the day one gains a
 * family the other does not, the live banner and the gates table start
 * describing the same rule differently with nothing failing.
 */
export const AssertionRuleSchema = z.object({
  scope: z.enum(['run', 'scenario', 'group', 'request']),
  targetName: z.string().nullable(),
  family: z.enum(['response_time', 'latency', 'group_cumulated', 'group_duration']),
  metric: z.string(),
  comparator: z.enum(['lte', 'gte']),
  threshold: z.number(),
});
export type AssertionRule = z.infer<typeof AssertionRuleSchema>;

export const AssertionSchema = z.object({
  ruleId: z.string().uuid(),
  outcome: AssertionOutcomeSchema,
  /** Null when the outcome is not_applicable — there was nothing to measure. */
  actualValue: z.number().nullable(),
  message: z.string(),
  rule: AssertionRuleSchema,
});
export type Assertion = z.infer<typeof AssertionSchema>;

/**
 * One of the tool's own assertions, as a reader sees it — Appendix A G-05's
 * four columns.
 *
 * `expression` carries the expected value inside it ("… is less than 30000.0"),
 * because that is how the tool renders it and G-05's tolerance is exact on the
 * wording, not just the number. Splitting the threshold back out would produce
 * a row that reads differently from the report it claims parity with.
 */
export const ToolAssertionOutcomeSchema = z.enum(['passed', 'failed', 'not_applicable']);
export type ToolAssertionOutcome = z.infer<typeof ToolAssertionOutcomeSchema>;

export const ToolAssertionSchema = z.object({
  expression: z.string(),
  /* ═══ THE STRUCTURE WAS ALWAYS THERE, TYPED AWAY ═══
   *
   * The engine evaluates `{ path, target, condition }` and `describe()` renders
   * it to `expression`; the pipeline then `JSON.stringify`s the WHOLE
   * evaluated object, so every stored row already carries the structure.
   * Verified against a real ingest before this was written — the column's keys
   * are `outcome`, `assertion`, `expression`, `actualValue`.
   *
   * It was dropped twice on the way out: the persistence type named three
   * fields, and `runs.service.ts` mapped those three. So the UI had prose and
   * nothing else, and the only way to columns looked like PARSING another
   * tool's sentences back apart. It is not — this just stops discarding them.
   *
   * `expression` STAYS, and not as a fallback. `tool-assertions.ts` records
   * that G-05's tolerance is EXACT WORDING, recovered from a 29-assertion
   * corpus run rather than invented; the review asks for the tool's own phrasing
   * to remain available, and it is the only thing that can render an assertion
   * shape this client does not know about.
   *
   * `.optional()` for the usual reason: a response from an API pod that
   * predates this would otherwise fail the schema and blank the run page for
   * the length of a rolling deploy. */
  assertion: z
    .object({
      path: z.object({ kind: z.string(), parts: z.array(z.string()).optional() }).passthrough(),
      target: z
        .object({ kind: z.string(), stat: z.string().optional(), rank: z.number().optional(), status: z.string().optional() })
        .passthrough(),
      condition: z
        .object({ kind: z.string(), value: z.number().optional(), lo: z.number().optional(), hi: z.number().optional() })
        .passthrough(),
    })
    .optional(),
  /** Null when nothing could be measured — see `not_applicable`. */
  actualValue: z.number().nullable(),
  /**
   * `not_applicable` where the assertion named a path this run has no
   * statistics for. The tool calls that a failure; this platform does not,
   * because "the endpoint you named does not exist" and "the endpoint is too
   * slow" are different facts a reader acts on differently (§22.1 tenet 6).
   */
  outcome: ToolAssertionOutcomeSchema,
});
export type ToolAssertion = z.infer<typeof ToolAssertionSchema>;

/**
 * A run's owning project, as every run response carries it. Its own schema
 * rather than an inline object so RunResponse and RunListResponse cannot
 * describe the same thing two ways.
 */
export const ProjectRefSchema = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  name: z.string(),
});
export type ProjectRef = z.infer<typeof ProjectRefSchema>;

/**
 * The test this is a run OF — the layer between a project and its runs.
 *
 * The same three fields as `ProjectRefSchema`, and for the same reason: a
 * reader who has the run needs to be able to NAME the test and LINK to it
 * without a second request, and the id alone gives neither.
 *
 * `TestSummarySchema` (test.ts) is not reused here on purpose. That carries
 * `runCount`, `latestRun` and both timestamps — an aggregate over the test's
 * whole history, computed by a `groupBy` and an ordered scan. Attaching it to
 * every run body would make one run's fetch pay for a query about all the
 * others, and `respondWithRun`'s 202 branch exists precisely to avoid that
 * kind of work on a path a poller hits every five seconds.
 */
export const TestRefSchema = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  name: z.string(),
});
export type TestRef = z.infer<typeof TestRefSchema>;

/**
 * What a run knows about itself from the moment it exists, independent of
 * whether anything has parsed it.
 *
 * ONE SCHEMA, EXTENDED TWICE — by `RunResponseSchema` below and by
 * `RunProcessingSchema` further down. That is the anti-drift device and the
 * reason this is not a copied field list: adding a chip to the run header is
 * then one edit rather than two that can silently disagree about a field's
 * nullability.
 *
 * NO `status` HERE, deliberately. The two consumers enumerate their own
 * statuses independently (see `RunProcessingSchema`'s own comment), and
 * hoisting the field would make widening one widen the other.
 *
 * NO `verdict`, `windowable`, `assertions` or `error` either: those are
 * MEASUREMENTS, not identity, and keeping them off this schema is what stops
 * a running run's type from being able to express one.
 */
export const RunIdentitySchema = z.object({
  id: z.string().uuid(),
  /**
   * The project this run belongs to. REQUIRED, not optional: run.project_id
   * is NOT NULL, so an optional field would model a state the database
   * cannot hold — and apps/web parses with RunResponseSchema.parse, so a
   * server that forgets it must fail loudly rather than render a blank
   * where a project name belongs.
   */
  project: ProjectRefSchema,
  tool: z.string(),
  toolVersion: z.string().nullable().optional(),
  /**
   * From ingest metadata, frozen at accept time. Null for every run created
   * before migration 20260815000000_run_ingest_provenance, and for any run
   * whose caller did not send them.
   */
  environment: z.string().nullable().optional(),
  branch: z.string().nullable().optional(),
  commitSha: z.string().nullable().optional(),
  /**
   * The warm-up window this run was PARSED under, in milliseconds, or null
   * when the project configured none.
   *
   * ═══ WHY THE READER NEEDS IT AT ALL (AC-STAT-4) ═══
   *
   * `LiveEngine.add` keeps warm-up events in every time SERIES and withholds
   * them from the summary ROLLUPS — deliberately, and `isWarmup`'s docstring
   * says so ("Warm-up requests stay in the time series but are excluded from
   * summary stats"). The charts therefore draw traffic the statistics table
   * does not count, which is correct and, until now, unsayable: nothing on
   * the wire told the browser where the ramp ended, so the two surfaces
   * disagreed with nothing explaining why. Keeping warm-up in the series is
   * only meaningful if a reader can tell which part of the line it is.
   *
   * ═══ FROM THE RUN, NEVER FROM THE PROJECT ═══
   *
   * `engineOptionsFrom` freezes this onto the run at ingest, and its docstring
   * gives the reason: "a project changing its warm-up must not silently
   * reinterpret its own history". Reading the project's CURRENT setting here
   * would redraw an old run's ramp at whatever width the project happens to
   * use today — the same class of mistake `ruleSnapshot` exists to prevent
   * for SLA thresholds.
   *
   * NULLABLE AND OPTIONAL, for the reason every other field in this block is:
   * `null` is a run parsed with no warm-up (the overwhelmingly common case,
   * and the default), `undefined` is a body from an API pod that predates
   * this field. Required-but-nullable would blank the run page for a whole
   * rolling deploy, because the browser drops a body that fails safeParse.
   */
  warmupMs: z.number().int().nonnegative().nullable().optional(),
  /**
   * The test this is a run of, or null.
   *
   * NULLABLE AND OPTIONAL, AND THE TWO MEAN DIFFERENT THINGS. `null` is a run
   * that belongs to no test — one still pending, one that failed before the
   * worker could read its simulation class, one ingested before migration
   * `20260822220000_test_entity` whose grouping key the backfill could not
   * recover. That is a real state the column holds (`test_id` is nullable by
   * necessity: the class is unknowable until the log header is parsed).
   *
   * `undefined` is a run body from an API pod that predates this field —
   * mid-rolling-deploy. Required-but-nullable would blank the run page for
   * the whole rollout, the same failure `RunProcessingSchema`'s comment below
   * and `live-delta.test.ts` one endpoint over both exist to prevent.
   *
   * Distinct from `simulation`, which is what the log HEADER said. Two runs
   * can carry the same simulation string and different tests (a project
   * renamed, a test deleted and re-created), so a reader following the
   * hierarchy has to follow this and not that — see `TRENDS_SQL`, which
   * cohorts on `test_id` for exactly this reason.
   */
  test: TestRefSchema.nullable().optional(),
  /** The tool's own simulation identity and run description (G-01, G-02). */
  simulation: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  /**
   * The span the SERIES OFFSETS live in: run-header start to last event.
   * Every bucket `startOffsetMs` is relative to the header start, so a time
   * axis must span this or the final bucket falls outside the domain
   * (`useTimeDomainFromShell`, `TimeBrush`).
   *
   * NOT the number the run page labels "Duration" — that is `activityMs`.
   */
  durationMs: z.number().int().nullable().optional(),
  /**
   * The run's MEASURED span: first event (after warm-up) to last event, and
   * exactly what every `throughputRps` divides by (G-04).
   *
   * THE PAGE USED TO CONTRADICT ITSELF WITHOUT THIS. The header rendered
   * `durationMs` while the throughput tile beside it divided by the activity
   * span, so `throughput x duration` disagreed with the request count on the
   * same screen — 14.32 req/s over a stated 63s is 907, printed next to 895.
   * Gatling anchors its own reported duration at the first event too, which
   * is why its report reads "1m 2s" where `durationMs` rounds to 63s.
   *
   * Null for runs ingested before migration 20260822090000: the lead-in it
   * subtracts is not recoverable from a stored row, so readers fall back to
   * `durationMs` rather than showing a backfilled guess.
   */
  activityMs: z.number().int().nullable().optional(),
  /** When the platform received this run's bundle — ingest time, not tool start. */
  startedAt: z.string().datetime(),
  /**
   * The load test's own start, read from the tool's run header. Null until
   * the worker finishes parsing (and forever for a run that never
   * completes) — distinct from startedAt, which is always ingest time.
   */
  toolStartedAt: z.string().datetime().nullable().optional(),
});
export type RunIdentity = z.infer<typeof RunIdentitySchema>;

export const RunResponseSchema = RunIdentitySchema.extend({
  status: RunStatusSchema,
  verdict: RunVerdictSchema.nullable(),
  /**
   * Whether this run's buckets carry the per-bucket histograms a time window is
   * re-aggregated from.
   *
   * False for a run ingested before that migration. The UI must not offer a
   * brush for such a run: every windowed metric call would return 400
   * WINDOW_UNAVAILABLE, which is correct of the API and useless to a reader who
   * was invited to drag something. Optional so a client written before this
   * field existed still parses.
   */
  windowable: z.boolean().optional(),
  ingestedAt: z.string().datetime().nullable().optional(),
  assertions: z.array(AssertionSchema),
  /**
   * The assertions the LOAD TEST declared, re-evaluated against this
   * platform's statistics — Appendix A G-05.
   *
   * A SECOND FIELD, not merged into `assertions` above. Those are SLA rule
   * results: they carry a `ruleId`, they are configured per project, and their
   * outcome drives the 200/422 verdict a CI job gates on. These are owned by
   * whoever wrote the simulation, are immutable, and can express comparisons
   * (`between`, `in`) that the SLA comparator set has no member for. Merging
   * them would mean inventing a rule id or widening a contract CI depends on.
   *
   * NULL means the run predates the assertion decoder — its definitions were
   * discarded at ingest and live only in the raw bundle. `[]` means the
   * simulation declared none. Optional so a client written before this field
   * existed still parses.
   */
  toolAssertions: z.array(ToolAssertionSchema).nullable().optional(),
  error: z
    .object({ code: z.string(), message: z.string(), remediation: z.string() })
    .nullable()
    .optional(),
});
export type RunResponse = z.infer<typeof RunResponseSchema>;

/**
 * The 202 body: the run is not yet terminal. Mirrors exactly what
 * respondWithRun() sends (apps/api/src/runs/runs.controller.ts) — `failed`
 * is excluded because a failed run is handled by that function's own
 * `run.status === 'failed'` branch before this shape would ever apply, and
 * `complete` never reaches 202 at all (it resolves to 200 or 422 instead).
 *
 * `incomplete` is excluded for the same reason `complete` is: it is terminal
 * (see RunStatusSchema above), so it is never reported as 202 either.
 *
 * This enum is declared INDEPENDENTLY of RunStatusSchema rather than derived
 * from it (e.g. `RunStatusSchema.exclude([...])`), so widening one is not
 * enough to widen the other -- and nothing typechecks that gap, which is
 * exactly why `running` needs its own line here. `running` belongs: an
 * in-progress live run is still pending-shaped from a poller's point of
 * view, so it gets the same 202 treatment as pending/parsing and a CI script
 * needs no new branch to keep working once streaming exists.
 *
 * EVERY IDENTITY FIELD IS OPTIONAL HERE, INCLUDING `project` AND `tool` — and
 * for a different reason than they are optional on a run body. During a
 * rolling deploy a new browser polls an OLD pod and receives just
 * `{ id, status, statusUrl }`. A required field would make `.parse()` throw
 * and blank the run page for the whole rollout, the same failure
 * `live-delta.test.ts` exists to prevent one endpoint over.
 */
export const RunProcessingSchema = RunIdentitySchema.partial().extend({
  // Re-required after `.partial()`: the API has always sent it, on every path.
  id: z.string().uuid(),
  status: z.enum(['pending', 'parsing', 'running']),
  statusUrl: z.string(),
});
export type RunProcessing = z.infer<typeof RunProcessingSchema>;

export const RunListResponseSchema = z.object({
  items: z.array(
    RunResponseSchema.pick({
      id: true,
      project: true,
      status: true,
      verdict: true,
      tool: true,
      startedAt: true,
      toolStartedAt: true,
      simulation: true,
    }).extend({
      /* ═══ WHAT A TRIAGE ROW NEEDS, AND WHY IT IS ALL OPTIONAL ═══
       *
       * The list carried identity and two verdicts, so deciding whether a run
       * was interesting meant OPENING it. Worse, "Needs attention" counted
       * execution state and the platform SLA only — `toolAssertions` was never
       * sent, so a tile read zero over a run whose simulation had a failing
       * check.
       *
       * Every field here is `.optional()`, and that is the load-bearing part
       * rather than politeness: the browser drops any body that fails the
       * schema, so a REQUIRED field would blank the whole run list against an
       * API pod that predates it — for the length of a rolling deploy. Same
       * trap `live-delta.ts` and `TrendRunSchema` already carry cases for.
       *
       * `null` and absent then mean different things, and the UI shows both as
       * unavailable rather than as zero: a run with no statistics row has no
       * p95, and "—" is the honest cell. */
      environment: z.string().nullable().optional(),
      branch: z.string().nullable().optional(),
      commitSha: z.string().nullable().optional(),
      durationMs: z.number().int().nullable().optional(),
      test: TestRefSchema.nullable().optional(),
      /**
       * The simulation's OWN checks, reduced to a tally.
       *
       * The array itself is deliberately NOT sent: a corpus run declares
       * hundreds, and a page of 25 such runs would carry them all to render
       * one number. The run's own page is where the expressions belong.
       */
      checks: z
        .object({ failed: z.number().int(), total: z.number().int() })
        .nullable()
        .optional(),
      /**
       * The run-scope response-time row, when one exists.
       *
       * Null for a run that has no statistics — still parsing, or a bundle
       * that never produced any. Not zero: a zero p95 is a measurement, and
       * this is the absence of one.
       */
      metrics: z
        .object({
          count: z.number().int(),
          errorRate: z.number(),
          throughputRps: z.number(),
          p95Ms: z.number().nullable(),
        })
        .nullable()
        .optional(),
    }),
  ),
  nextCursor: z.string().nullable(),
});
export type RunListResponse = z.infer<typeof RunListResponseSchema>;
