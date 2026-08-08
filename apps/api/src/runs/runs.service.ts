import { Injectable } from '@nestjs/common';
import type { RunResponse } from '@perfportal/contracts';
import { RunRepository, type RunRecord } from '@perfportal/persistence';
import { PrismaClient } from '@prisma/client';
import { statusForCode } from '../common/problem.js';

@Injectable()
export class RunsService {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * One status per state, used by BOTH the POST response and the GET response.
   * The identity of those two codes is the contract: a CI script handles the
   * fast and slow paths with one branch instead of two.
   *
   *   200  ingested, verdict passed or not_evaluated
   *   422  ingested, verdict failed
   *   400+ bundle rejected (the ingest error's own status — usually 400,
   *        but 413 for BUNDLE_TOO_LARGE; see apps/api/src/common/problem.ts)
   *   202  still processing
   */
  statusFor(run: RunRecord): number {
    if (run.status === 'failed') return statusForCode(run.error?.code ?? 'INTERNAL');
    if (run.status !== 'complete') return 202;
    return run.verdict === 'failed' ? 422 : 200;
  }

  async toResponse(run: RunRecord): Promise<RunResponse> {
    const assertions = await this.prisma.runAssertion.findMany({
      where: { runId: run.id },
      orderBy: { outcome: 'asc' },   // 'failed' sorts before 'not_applicable' and 'passed'
    });

    return {
      id: run.id,
      status: run.status as RunResponse['status'],
      verdict: (run.verdict ?? null) as RunResponse['verdict'],
      tool: run.tool,
      toolVersion: run.toolVersion,
      simulation: run.simulation ?? null,
      description: run.description ?? null,
      durationMs: run.durationMs ?? null,
      startedAt: run.startedAt.toISOString(),
      toolStartedAt: run.toolStartedAt ? run.toolStartedAt.toISOString() : null,
      ingestedAt: run.ingestedAt ? run.ingestedAt.toISOString() : null,
      error: run.error,
      assertions: assertions.map((a) => {
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
