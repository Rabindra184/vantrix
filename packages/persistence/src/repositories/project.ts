import { Prisma, type PrismaClient } from '@prisma/client';
import type { ProjectScope } from './tenant.js';

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

interface RawProjectRow {
  id: string;
  slug: string;
  name: string;
  latestRunId: string | null;
  latestRunStatus: string | null;
  latestRunVerdict: string | null;
}

export interface ProjectListRow {
  id: string;
  slug: string;
  name: string;
  latestRun: { id: string; status: string; verdict: string | null } | null;
}

/**
 * Whether a failed insert is THE duplicate this method is allowed to report
 * as "that slug is taken" — the `(org_id, slug)` uniqueness — rather than any
 * unique violation at all.
 *
 * The distinction is not hypothetical caution. `createInOrg` answers `null`
 * for a conflict and its caller turns that into a 409 reading
 * `A project with slug "x" already exists`. Collapsing EVERY P2002 into that
 * answer means the day `project` grows a second unique index, violating it
 * tells the user something confidently false about a slug that was never the
 * problem, and the real fault is swallowed. Narrowing here makes anything
 * else propagate as the 500 it is: an unexpected constraint violation is a
 * bug to fix, not advice to give.
 *
 * `meta.target` is the DATABASE column list, snake_case, not Prisma field
 * names — verified against this schema, where the violation reports
 * `["org_id", "slug"]`. Matched as a set of exactly those two, so a future
 * index that merely happens to include `slug` is not mistaken for this one.
 */
function isSlugTaken(err: unknown): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (err.code !== 'P2002') return false;
  const target = err.meta?.['target'];
  if (!Array.isArray(target)) return false;
  const columns = new Set(target.map(String));
  return columns.size === 2 && columns.has('org_id') && columns.has('slug');
}

export class ProjectRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async createInOrg({
    orgId,
    slug,
    name,
  }: {
    orgId: string;
    slug: string;
    name: string;
  }): Promise<ProjectRecord | null> {
    try {
      const row = await this.prisma.project.create({
        data: { orgId, slug, name, settings: {} },
      });
      return {
        id: row.id,
        orgId: row.orgId,
        slug: row.slug,
        name: row.name,
        settings: (row.settings ?? {}) as Record<string, unknown>,
      };
    } catch (err) {
      if (isSlugTaken(err)) return null;
      throw err;
    }
  }

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

  /**
   * A project by slug WITHIN an org id.
   *
   * Separate from findBySlug, which takes an org SLUG. `req.tenant` carries
   * an org id, and bending one method into accepting either would make
   * every call site read ambiguously.
   */
  async findBySlugInOrg(orgId: string, slug: string): Promise<ProjectRecord | null> {
    const row = await this.prisma.project.findFirst({ where: { orgId, slug } });
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

  async settings(scope: ProjectScope): Promise<Record<string, unknown>> {
    const row = await this.prisma.project.findFirst({
      where: { id: scope.projectId, orgId: scope.orgId },
    });
    return (row?.settings ?? {}) as Record<string, unknown>;
  }

  /**
   * Every project in an org, each with its most recent run.
   *
   * LEFT JOIN LATERAL, not DISTINCT ON (project_id) over `run`: a project
   * with zero runs must still appear — an org's newest project is exactly
   * the one with nothing in it — and DISTINCT ON over the run table would
   * silently omit it.
   *
   * The inner ORDER BY resolves the same run RunRepository.list puts first
   * — same COALESCE, same tie-break — though unaliased here, because this
   * subquery reads from `run` alone while list() qualifies its columns `r.`
   * to disambiguate the `project` join. Do not "fix" that difference by
   * adding an alias: there is no second table here to disambiguate from.
   * If the two expressions ever disagree, a project's "latest run" and the
   * run list's top row name different runs, and nothing on screen looks
   * wrong.
   *
   * `projectId` narrows to a single project for a bearer token, which is
   * scoped to exactly one. Absent for a session, which sees the whole org.
   */
  async listForOrg(orgId: string, projectId?: string): Promise<ProjectListRow[]> {
    const projectFilter = projectId === undefined ? Prisma.empty : Prisma.sql`AND p.id = ${projectId}::uuid`;
    const rows = await this.prisma.$queryRaw<RawProjectRow[]>`
      SELECT p.id, p.slug, p.name,
             r.id AS "latestRunId", r.status AS "latestRunStatus",
             r.verdict AS "latestRunVerdict"
      FROM project p
      LEFT JOIN LATERAL (
        SELECT id, status, verdict
        FROM run
        WHERE project_id = p.id
        ORDER BY COALESCE(tool_started_at, started_at) DESC, id DESC
        LIMIT 1
      ) r ON true
      WHERE p.org_id = ${orgId}::uuid
      ${projectFilter}
      ORDER BY p.name ASC
    `;
    return rows.map((row: RawProjectRow) => ({
      id: row.id,
      slug: row.slug,
      name: row.name,
      latestRun:
        row.latestRunId === null
          ? null
          : { id: row.latestRunId, status: row.latestRunStatus!, verdict: row.latestRunVerdict },
    }));
  }
}
