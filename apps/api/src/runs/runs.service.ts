import { Injectable } from '@nestjs/common';
import {
  AssertionRuleSchema,
  VerdictChangeSchema,
  type RunNote,
  type RunResponse,
  type ToolAssertionOutcome,
  type VerdictChange,
  type VerificationSummary,
  VerificationSummarySchema,
} from '@perfportal/contracts';
import { MetricReader, RunRepository, type RunRecord } from '@perfportal/persistence';
import { PrismaClient } from '@prisma/client';
import { statusForCode } from '../common/problem.js';

interface RunAssertionRow {
  ruleId: string;
  outcome: string;
  actualValue: number | null;
  message: string;
  ruleSnapshot: unknown;
}

@Injectable()
export class RunsService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly reader: MetricReader,
  ) {}

  /**
   * One status per state, used by BOTH the POST response and the GET response.
   * The identity of those two codes is the contract: a CI script handles the
   * fast and slow paths with one branch instead of two.
   *
   *   200  ingested (complete), verdict passed or not_evaluated
   *   200  incomplete — closed without its producer saying so; verdict is
   *        always not_evaluated (RunRepository.markIncomplete), so this is
   *        NOT the 422 row below, and it must not fall into the 202 branch
   *        either: an aborted live run has no worker left to ever move it
   *        past 202, so a poller would retry it forever (design §1.2).
   *   422  ingested, verdict failed
   *   400+ bundle rejected (the ingest error's own status — usually 400,
   *        but 413 for BUNDLE_TOO_LARGE; see apps/api/src/common/problem.ts)
   *   202  still processing (pending / parsing / running)
   */
  statusFor(run: RunRecord): number {
    if (run.status === 'failed') return statusForCode(run.error?.code ?? 'INTERNAL');
    if (run.status === 'incomplete') return 200;
    if (run.status !== 'complete') return 202;
    return run.verdict === 'failed' ? 422 : 200;
  }

  /**
   * The run's lifecycle stamps, for BOTH identity builders — `toResponse`
   * below and the 202 in `respondWithRun` — so the two cannot send different
   * sets. Three come off the RunRecord (`statsMethod` among them: which engine
   * produced the run's statistics); `queuedAt` and `runnerJobId` are one
   * indexed lookup (`runner_job_run_id_idx`) for the runner job that produced
   * the run, if any. A run has at most one: a retry makes a new job AND a new
   * run. `verdictChanges` is a second indexed lookup
   * (`run_verdict_change_run_id_idx`): what the exact recompute changed.
   * `verification` is the run's verification row, by primary key: what the
   * run header's mark says (null when the run has no row yet). The three
   * lookups are independent, so they run together.
   */
  async lifecycleOf(run: RunRecord): Promise<{
    parsingStartedAt: string | null;
    streamUpdatedAt: string | null;
    queuedAt: string | null;
    runnerJobId: string | null;
    statsMethod: RunRecord['statsMethod'];
    verdictChanges: VerdictChange[];
    verification: VerificationSummary | null;
  }> {
    const [job, changes, verification] = await Promise.all([
      this.prisma.runnerJob.findFirst({
        // The run's own project as well: the runner writes `run_id` only for a
        // run it opened in the job's own project, so this never narrows a real
        // answer — it only refuses one that could not be the run's own.
        where: { runId: run.id, projectId: run.projectId },
        orderBy: { createdAt: 'asc' },
        select: { id: true, createdAt: true },
      }),
      // Through Prisma, not `RecomputeRepository.verdictChanges`: this service
      // holds no pg pool, and the order is that method's own (changed_at, id).
      this.prisma.runVerdictChange.findMany({
        where: { runId: run.id },
        orderBy: [{ changedAt: 'asc' }, { id: 'asc' }],
      }),
      // The primary-key lookup of the run's verification row, through Prisma
      // for the reason the line above gives. Only the two columns the run
      // header's mark reads: the whole record is `GET /v1/runs/{id}/verification`.
      this.prisma.runVerification.findUnique({
        where: { runId: run.id },
        select: { status: true, unverifiableReason: true },
      }),
    ]);
    const iso = (at: Date | null): string | null => (at === null ? null : at.toISOString());
    return {
      parsingStartedAt: iso(run.parsingStartedAt),
      streamUpdatedAt: iso(run.streamUpdatedAt),
      queuedAt: iso(job?.createdAt ?? null),
      // The same lookup answers the Logs tab's question — does this run have
      // a runner job, and so any events? — at no extra query.
      runnerJobId: job?.id ?? null,
      statsMethod: run.statsMethod,
      verdictChanges: changes.flatMap((c) => verdictChangeOf(run.id, c)),
      verification: verificationSummaryOf(verification),
    };
  }

  async toResponse(run: RunRecord): Promise<RunResponse> {
    const assertions = await this.prisma.runAssertion.findMany({
      where: { runId: run.id },
      orderBy: { outcome: 'asc' },   // 'failed' sorts before 'not_applicable' and 'passed'
    }) as RunAssertionRow[];
    const lifecycle = await this.lifecycleOf(run);

    return {
      id: run.id,
      project: run.project,
      status: run.status as RunResponse['status'],
      verdict: (run.verdict ?? null) as RunResponse['verdict'],
      tool: run.tool,
      toolVersion: run.toolVersion,
      environment: run.environment,
      branch: run.branch,
      commitSha: run.commitSha,
      // AC-STAT-4. From the run's OWN frozen engine options, never from the
      // project's current settings: `engineOptionsFrom` freezes these at
      // ingest precisely so "a project changing its warm-up must not silently
      // reinterpret its own history", and redrawing an old run's ramp at
      // today's width would do exactly that.
      warmupMs: warmupMsOf(run.engineOptions),
      // Joined on the RunRecord already (`include: { test: true }`), so this
      // costs no query of its own — the same free ride `project` takes.
      test: run.test,
      runNumber: run.runNumber,
      simulation: run.simulation ?? null,
      description: run.description ?? null,
      durationMs: run.durationMs ?? null,
      activityMs: run.activityMs ?? null,
      // One EXISTS against this run's own partition, issued on the run fetch —
      // the one reader that needs it, the same way hasGroupSeries is only asked
      // for the group page. Derived from the ROWS, never from a date comparison
      // against the migration.
      windowable: await this.reader.isWindowable(
        { orgId: run.orgId, projectId: run.projectId }, run.id, run.startedOn,
      ),
      startedAt: run.startedAt.toISOString(),
      toolStartedAt: run.toolStartedAt ? run.toolStartedAt.toISOString() : null,
      ingestedAt: run.ingestedAt ? run.ingestedAt.toISOString() : null,
      parsingStartedAt: lifecycle.parsingStartedAt,
      streamUpdatedAt: lifecycle.streamUpdatedAt,
      queuedAt: lifecycle.queuedAt,
      runnerJobId: lifecycle.runnerJobId,
      statsMethod: lifecycle.statsMethod,
      verdictChanges: lifecycle.verdictChanges,
      verification: lifecycle.verification,
      note: noteOf(run),
      // Appendix A G-05. Already evaluated at ingest against the rollups the
      // engine had in hand, so this is a projection, not a computation — and
      // `null` is preserved rather than defaulted to `[]`, because "this run
      // predates the decoder" is not the same fact as "this simulation
      // declared no assertions".
      toolAssertions: run.toolAssertions === null
        ? null
        : run.toolAssertions.map((a) => ({
            expression: a.expression,
            actualValue: a.actualValue,
            outcome: a.outcome as ToolAssertionOutcome,
            // NAMED, not spread — the excess-property check does not reach
            // inside a spread, which CLAUDE.md records costing a field its
            // whole journey to the repository.
            assertion: a.assertion as NonNullable<RunResponse['toolAssertions']>[number]['assertion'],
          })),
      error: run.error,
      assertions: assertions.map((a: RunAssertionRow) => {
        const snap = a.ruleSnapshot as {
          scope: string; targetName: string | null; family: string;
          metric: string; comparator: string; threshold: number;
        };
        return {
          ruleId: a.ruleId,
          outcome: a.outcome as 'passed' | 'failed' | 'not_applicable',
          actualValue: a.actualValue,
          message: a.message,
          rule: {
            scope: snap.scope as 'run' | 'scenario' | 'group' | 'request',
            targetName: snap.targetName,
            family: snap.family as 'response_time' | 'latency' | 'group_cumulated' | 'group_duration',
            metric: snap.metric,
            comparator: snap.comparator as 'lte' | 'gte',
            threshold: snap.threshold,
          },
        };
      }),
    };
  }

  runs(): RunRepository {
    return new RunRepository(this.prisma);
  }
}

/**
 * `warmupMs` out of a run's frozen engine options, or null.
 *
 * NARROWED, NEVER CAST. `run.engineOptions` is the RAW project-settings JSON
 * — `engine-options.ts` says in as many words that these knobs "live in the
 * same JSON column but outside that schema's modeled shape, so they are read
 * here unvalidated". A column holding a string, a negative or a fraction
 * therefore reaches this function, and a cast would put it on the wire where
 * `RunIdentitySchema` rejects it — blanking the whole run page, because the
 * browser drops a body that fails safeParse.
 *
 * Answering null instead degrades to exactly what a run predating this field
 * gets: no ramp drawn, every other number unchanged. ONE fallback, several
 * causes, all honest — the shape `wireRule` already uses one package over.
 */
export function warmupMsOf(engineOptions: unknown): number | null {
  if (typeof engineOptions !== 'object' || engineOptions === null) return null;
  const raw = (engineOptions as Record<string, unknown>)['warmupMs'];
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw <= 0) return null;
  return raw;
}

/**
 * The run's note on the wire, or null for none — ONE helper for BOTH identity
 * builders, `toResponse` and `respondWithRun`'s hand-written 202. A note
 * written while a run streams is read through the 202, so a field sent only
 * by `toResponse` would vanish until the run finished: the warmupMs lesson,
 * with its guard written first.
 */
export function noteOf(run: RunRecord): RunNote | null {
  if (run.note === null) return null;
  return {
    text: run.note,
    updatedAt: run.noteUpdatedAt === null ? null : run.noteUpdatedAt.toISOString(),
    updatedBy: run.noteAuthorName === null ? null : { name: run.noteAuthorName },
  };
}

/**
 * One stored verdict change in the contract's shape, or nothing.
 *
 * ═══ A SNAPSHOT THAT IS NOT A RULE IS DROPPED, NOT A 500 ═══
 *
 * `rule_snapshot` is JSON that nothing validates on its way in. A row whose
 * snapshot does not read as a rule cannot be described to a reader, and
 * failing the whole run response over it would take the run page down for
 * one unrenderable line — so it is left out of the list and logged. The rest
 * of the row is the recompute's own writing and the contract checks it too;
 * a row failing for any reason takes the same path.
 */
function verdictChangeOf(
  runId: string,
  row: {
    id: string;
    ruleSnapshot: unknown;
    oldOutcome: string;
    newOutcome: string;
    oldValue: number | null;
    newValue: number | null;
    oldVerdict: string;
    newVerdict: string;
    changedAt: Date;
  },
): VerdictChange[] {
  const drop = (issues: unknown): VerdictChange[] => {
    console.warn(`dropping verdict change ${row.id} of run ${runId}: it does not parse`, issues);
    return [];
  };
  const rule = AssertionRuleSchema.safeParse(row.ruleSnapshot);
  if (!rule.success) return drop(rule.error.issues);
  const change = VerdictChangeSchema.safeParse({
    rule: rule.data,
    oldOutcome: row.oldOutcome,
    newOutcome: row.newOutcome,
    oldValue: row.oldValue,
    newValue: row.newValue,
    oldVerdict: row.oldVerdict,
    newVerdict: row.newVerdict,
    changedAt: row.changedAt.toISOString(),
  });
  if (!change.success) return drop(change.error.issues);
  return [change.data];
}

/**
 * The run header's verification mark, from the stored row. `null` when the
 * run has no row yet. The two columns are held to the contract's words by
 * `run_verification`'s CHECK constraints; a row that somehow does not parse
 * reads as no row rather than failing the whole run response — the rule
 * `verdictChangeOf` above follows for a stored snapshot.
 */
function verificationSummaryOf(
  row: { status: string; unverifiableReason: string | null } | null,
): VerificationSummary | null {
  if (row === null) return null;
  const parsed = VerificationSummarySchema.safeParse({ status: row.status, reason: row.unverifiableReason });
  return parsed.success ? parsed.data : null;
}
