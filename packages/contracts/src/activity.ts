import { z } from 'zod';
import { AttentionReasonSchema } from './attention.js';
import { RunStatusSchema, RunVerdictSchema } from './run.js';
import { RunNumberSchema } from './run-number.js';

/**
 * ═══ `GET /v1/activity`: EVERYTHING THE HOME PAGE DRAWS, IN ONE REQUEST ═══
 * (docs/superpowers/specs/2026-10-05-portfolio-home-and-command-palette-design.md)
 *
 * A seven-day glance, a pass rate, a "running now" count, runs per project,
 * the tests that need attention and the last run. One request because the
 * app's gate asks it on every cold load to learn whether the signed-in user
 * has an organisation at all, and the page it lands on should not then ask
 * five more questions.
 *
 * Loose on the way out, like `OrgTestSummarySchema`, for the same reason: a
 * stored row that fails a tighter shape must not 500 a page the reader may
 * see. No string here is bounded, so the trimmed-input guard has nothing to
 * demand of it — trimming a value we only RETURN would quietly rewrite what
 * is stored.
 *
 * Every window is on ARRIVAL (`run.created_at`), so a bundle uploaded today
 * for a test that ran last month counts for today.
 */

const NamedRefSchema = z.object({ slug: z.string(), name: z.string() });

/**
 * One local calendar day of the glance. `total` is every run that arrived that
 * day, in flight included; `successful` is those that finished (`complete`)
 * and need no attention; `needsAttention` is those the rule in `attention.ts`
 * flags. A run still in flight is in `total` and in neither of the other two,
 * which is why a bar's height is always its day's `total`.
 */
const ActivityDaySchema = z.object({
  /** The calendar day in the requested zone, `YYYY-MM-DD`. */
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  total: z.number().int().nonnegative(),
  successful: z.number().int().nonnegative(),
  needsAttention: z.number().int().nonnegative(),
});

/**
 * A test whose latest run in the window needs attention, or — when `test` is
 * null — a run that never parsed a header and so cannot be grouped under a
 * test (a stuck ingest). Each such run is its own row.
 */
export const ActivityAttentionRowSchema = z.object({
  test: NamedRefSchema.nullable(),
  project: NamedRefSchema,
  run: z.object({
    id: z.string().uuid(),
    /** "Run 12". Null for a run with no test number; see `RunNumberSchema`. */
    runNumber: RunNumberSchema.nullable(),
    /** `status` rides along with `verdict` for the reason `OrgTestSummarySchema`
     *  records: a pending run has no verdict yet, which is not "not evaluated". */
    status: RunStatusSchema,
    verdict: RunVerdictSchema.nullable(),
    /** When the LOAD TEST started, the instant the run list's Started column
     *  shows — not when the run arrived. */
    startedAt: z.string().datetime(),
    /** Null until the run has a measured duration. */
    durationMs: z.number().int().nullable(),
    /** Failed and total simulation checks. Null when the run recorded none,
     *  which is different from `0 / 0`. */
    checks: z.object({ failed: z.number().int(), total: z.number().int() }).nullable(),
    /** The tool's own class name, when the log header recorded one. A row with
     *  no test names its run by this, else "Upload" and the short id. */
    simulation: z.string().nullable(),
  }),
  /**
   * Which clauses of the attention rule held, in `ATTENTION_REASONS` order.
   * At least one: a row is listed BECAUSE a clause held, so an empty list is
   * an upstream defect that must fail to parse rather than draw an unexplained
   * line.
   */
  reasons: z.array(AttentionReasonSchema).min(1),
});

export const ActivityResponseSchema = z.object({
  /**
   * The attention window, on arrival: `from` is the first instant of the
   * oldest of the seven `days` in `tz` (that day's local midnight, or its
   * first real instant on a day whose midnight was skipped), and `to` is the
   * moment the server answered. So it is the same seven calendar days the
   * glance draws, and `attention`, `attentionTotal`, `runCount` and `passRate`
   * all count one set of runs.
   *
   * NOT THE SPEC'S 168 HOURS, ON PURPOSE. Gatling Enterprise's window is the
   * 604 800 000 ms before now, and beside a glance of seven calendar days that
   * leaves a slice — the 24 hours minus today's time of day before the
   * glance's first midnight — inside one and outside the other. A run in it
   * was in this window and in no day, so the page could say "No runs in the
   * last 7 days" beside a run six days old under a heading whose range held
   * it. Corrected at the final review: there is one window.
   *
   * `tz` is the zone the caller sent, echoed as sent (trimmed) — never the
   * canonical name ICU resolves it to, which can differ (`Asia/Kolkata` is
   * `Asia/Calcutta` there) and would read as a bug.
   */
  window: z.object({ from: z.string().datetime(), to: z.string().datetime(), tz: z.string() }),
  /** Exactly the seven local calendar days ending today, oldest first. */
  days: z.array(ActivityDaySchema).length(7),
  /** The sum of `days[].total`. */
  runCount: z.number().int().nonnegative(),
  /**
   * Successful runs over successful plus needing attention, as a FRACTION in
   * [0, 1]; null when both are zero. The page shows the whole percent rounded
   * DOWN, so 199 of 200 reads 99% and never 100%.
   */
  passRate: z.number().min(0).max(1).nullable(),
  /** Runs with `status = 'running'` now. Not windowed. */
  running: z.number().int().nonnegative(),
  /** The five busiest projects over the glance days, by runs. At most five. */
  byProject: z.array(z.object({ project: NamedRefSchema, runs: z.number().int().nonnegative() })).max(5),
  /** Newest first, at most twenty; `attentionTotal` carries the true count. */
  attention: z.array(ActivityAttentionRowSchema).max(20),
  /**
   * How many tests need attention, which can exceed the rows sent. Required:
   * a header counting only the rows sent would say "20 tests" over thirty-five.
   */
  attentionTotal: z.number().int().nonnegative(),
  /** The most recent run by arrival, or null for an org that has none. */
  lastRun: z
    .object({
      id: z.string().uuid(),
      runNumber: RunNumberSchema.nullable(),
      test: NamedRefSchema.nullable(),
      project: NamedRefSchema,
      startedAt: z.string().datetime(),
    })
    .nullable(),
});
export type ActivityResponse = z.infer<typeof ActivityResponseSchema>;
