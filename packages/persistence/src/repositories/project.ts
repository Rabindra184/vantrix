import type { PrismaClient } from '@prisma/client';
import type { TenantScope } from './tenant.js';

export interface ProjectRecord {
  id: string;
  orgId: string;
  slug: string;
  name: string;
  settings: ProjectSettings;
}

/** The EngineOptions the shipped statistics engine already accepts. */
export interface ProjectSettings {
  warmupMs?: number;
  lowerMs?: number;
  higherMs?: number;
  percentiles?: number[];
  maxEndpoints?: number;
  maxBucketsRun?: number;
  maxBucketsEndpoint?: number;
  waitMs?: number;
  maxBundleBytes?: number;
  /** Decompressed-bytes budget for openTarGzBundle. See @perfportal/storage. */
  maxDecompressedBundleBytes?: number;
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
      settings: (row.settings ?? {}) as ProjectSettings,
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
      settings: (row.settings ?? {}) as ProjectSettings,
    };
  }

  async settings(scope: TenantScope): Promise<ProjectSettings> {
    const row = await this.prisma.project.findFirst({
      where: { id: scope.projectId, orgId: scope.orgId },
    });
    return (row?.settings ?? {}) as ProjectSettings;
  }
}
