import type { PrismaClient } from '@prisma/client';
import type { TenantScope } from './tenant.js';

/**
 * Re-exported, not redeclared: this package used to define its own FLAT
 * lowerMs/higherMs ProjectSettings here, which disagreed with
 * @perfportal/contracts' same-named export (nested under "indicators") for
 * the exact same underlying JSON column. A project configured in the shape
 * contracts (and the rest of the app) documents was silently invisible to
 * whichever code read the flat shape. There is exactly one ProjectSettings
 * now, defined once in @perfportal/contracts.
 */
export type { ProjectSettings } from '@perfportal/contracts';

export interface ProjectRecord {
  id: string;
  orgId: string;
  slug: string;
  name: string;
  /**
   * The project's settings JSON column, RAW and unvalidated - not narrowed to
   * @perfportal/contracts' ProjectSettings. That type models only the
   * request-time-read subset (indicators/percentiles, K-04); ingest-time
   * engine knobs (warmupMs, maxEndpoints, maxBucketsRun, maxBucketsEndpoint)
   * and bundle-size caps (maxBundleBytes, maxDecompressedBundleBytes) live in
   * this same column but outside that schema. Callers that want the
   * validated shape parse it themselves via parseProjectSettings(); callers
   * that want an ad hoc engine/bundle knob read it directly off this bag.
   */
  settings: Record<string, unknown>;
}

export class ProjectRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findBySlug(orgSlug: string, projectSlug: string): Promise<ProjectRecord | null> {
    const row = await this.prisma.project.findFirst({
      where: { slug: projectSlug, org: { slug: orgSlug } },
    });
    if (!row) return null;
    return {
      id: row.id,
      orgId: row.orgId,
      slug: row.slug,
      name: row.name,
      settings: (row.settings ?? {}) as Record<string, unknown>,
    };
  }

  async byId(projectId: string): Promise<ProjectRecord | null> {
    const row = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!row) return null;
    return {
      id: row.id,
      orgId: row.orgId,
      slug: row.slug,
      name: row.name,
      settings: (row.settings ?? {}) as Record<string, unknown>,
    };
  }

  async settings(scope: TenantScope): Promise<Record<string, unknown>> {
    const row = await this.prisma.project.findFirst({
      where: { id: scope.projectId, orgId: scope.orgId },
    });
    return (row?.settings ?? {}) as Record<string, unknown>;
  }
}
