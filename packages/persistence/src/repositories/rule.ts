import type { PrismaClient } from '@prisma/client';
import type { TenantScope } from './tenant.js';

export interface SlaRuleRecord {
  id: string;
  scope: 'run' | 'scenario' | 'group' | 'request';
  targetName: string | null;
  family: 'response_time' | 'latency' | 'group_cumulated' | 'group_duration';
  metric: string;
  comparator: 'lte' | 'gte';
  threshold: number;
}

export class RuleRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async listEnabled(scope: TenantScope): Promise<SlaRuleRecord[]> {
    const rows = await this.prisma.slaRule.findMany({
      where: { orgId: scope.orgId, projectId: scope.projectId, enabled: true },
      orderBy: { id: 'asc' },
    });
    return rows.map((r) => ({
      id: r.id,
      scope: r.scope as SlaRuleRecord['scope'],
      targetName: r.targetName,
      family: r.family as SlaRuleRecord['family'],
      metric: r.metric,
      comparator: r.comparator as SlaRuleRecord['comparator'],
      threshold: r.threshold,
    }));
  }
}
