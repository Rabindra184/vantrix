import { Injectable } from '@nestjs/common';
import type { RunResponse, ToolAssertionOutcome } from '@perfportal/contracts';
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

  async toResponse(run: RunRecord): Promise<RunResponse> {
    const assertions = await this.prisma.runAssertion.findMany({
      where: { runId: run.id },
      orderBy: { outcome: 'asc' },   // 'failed' sorts before 'not_applicable' and 'passed'
    }) as RunAssertionRow[];

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
      // Joined on the RunRecord already (`include: { test: true }`), so this
      // costs no query of its own — the same free ride `project` takes.
      test: run.test,
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
