import { Prisma, type PrismaClient } from '@prisma/client';

export interface PackageVersionRecord {
  artifactId: string;
  filename: string;
  kind: string;
  gatlingVersion: string | null;
  sha256: string;
  bytes: number;
  /** Null when UNKNOWN (a bundle, a jar with no Gatling-Simulations header, a
   *  backfilled row) — never an empty list standing in for unknown. */
  simulations: string[] | null;
  storagePath: string;
  uploadedAt: Date;
}

export interface PackageRecord {
  id: string;
  orgId: string;
  projectId: string;
  name: string;
  kind: string;
  createdAt: Date;
  updatedAt: Date;
  current: PackageVersionRecord | null;
}

export interface PackageWithUsage extends PackageRecord {
  usage: { tests: number; runs: number; activeJobs: number };
}

export interface NewPackageVersion {
  artifactId: string;
  filename: string;
  gatlingVersion: string | null;
  sha256: string;
  bytes: number;
  simulations: string[] | null;
  storagePath: string;
}

/** The project already has a package by this name, ignoring case. */
export class PackageNameTakenError extends Error {}

const ACTIVE_JOB_STATUSES = ['queued', 'starting', 'running', 'closing'] as const;

/**
 * Prisma's budget for the two transactions that BEGIN by taking a package row
 * lock that is meant to queue: `addVersion` behind another upload or a delete,
 * `delete` behind a start holding the row FOR SHARE. The budget runs from BEGIN,
 * so every second parked on that lock is spent from it, and the defaults (5 s to
 * run, 2 s to get a connection) turn a queue behind a slow holder into P2028
 * "transaction already closed" for a caller that did nothing wrong. No
 * `lock_timeout` is configured anywhere, so this 30 s is the only ceiling there
 * is: a wait that long means a holder is stuck, and failing at 30 s is the
 * intended outcome — not a reason for the defaults to abandon, after five
 * seconds, a queue that would have cleared.
 */
const LOCK_WAITING_TX = { maxWait: 10_000, timeout: 30_000 } as const;

interface PackageRow {
  id: string;
  orgId: string;
  projectId: string;
  name: string;
  kind: string;
  createdAt: Date;
  updatedAt: Date;
  artifactId: string | null;
  filename: string | null;
  artifactKind: string | null;
  gatlingVersion: string | null;
  sha256: string | null;
  bytes: bigint | null;
  simulations: string[] | null;
  storagePath: string | null;
  uploadedAt: Date | null;
}

interface UsageRow extends PackageRow {
  tests: bigint;
  runs: bigint;
  activeJobs: bigint;
}

/** One SELECT list for every read, so a package is the same shape however it is asked for. */
const PACKAGE_COLUMNS = Prisma.sql`
  p.id, p.org_id AS "orgId", p.project_id AS "projectId", p.name, p.kind,
  p.created_at AS "createdAt", p.updated_at AS "updatedAt",
  a.id AS "artifactId", a.filename, a.kind AS "artifactKind",
  a.gatling_version AS "gatlingVersion", a.sha256, a.bytes, a.simulations,
  a.storage_path AS "storagePath", a.created_at AS "uploadedAt"`;

const USAGE_COLUMNS = Prisma.sql`
  (SELECT count(DISTINCT r.test_id) FROM run r WHERE r.package_id = p.id) AS tests,
  (SELECT count(*) FROM run r WHERE r.package_id = p.id) AS runs,
  (SELECT count(*) FROM runner_job j JOIN runner_artifact v ON v.id = j.artifact_id
     WHERE v.package_id = p.id AND j.status IN (${Prisma.join(ACTIVE_JOB_STATUSES)})) AS "activeJobs"`;

export class PackageRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async list(orgId: string, projectId: string): Promise<PackageWithUsage[]> {
    const rows = await this.prisma.$queryRaw<UsageRow[]>`
      SELECT ${PACKAGE_COLUMNS}, ${USAGE_COLUMNS}
      FROM package p
      LEFT JOIN runner_artifact a ON a.id = p.current_artifact_id
      WHERE p.org_id = ${orgId}::uuid AND p.project_id = ${projectId}::uuid
      ORDER BY p.updated_at DESC, p.id DESC
    `;
    return rows.map(withUsage);
  }

  async find(orgId: string, projectId: string, id: string): Promise<PackageWithUsage | null> {
    const [row] = await this.prisma.$queryRaw<UsageRow[]>`
      SELECT ${PACKAGE_COLUMNS}, ${USAGE_COLUMNS}
      FROM package p
      LEFT JOIN runner_artifact a ON a.id = p.current_artifact_id
      WHERE p.org_id = ${orgId}::uuid AND p.project_id = ${projectId}::uuid AND p.id = ${id}::uuid
    `;
    return row ? withUsage(row) : null;
  }

  async findByName(orgId: string, projectId: string, name: string): Promise<PackageRecord | null> {
    const [row] = await this.prisma.$queryRaw<PackageRow[]>`
      SELECT ${PACKAGE_COLUMNS}
      FROM package p
      LEFT JOIN runner_artifact a ON a.id = p.current_artifact_id
      WHERE p.org_id = ${orgId}::uuid AND p.project_id = ${projectId}::uuid
        AND lower(p.name) = lower(${name})
    `;
    return row ? toRecord(row) : null;
  }

  /** One package by id, without usage: what `create` hands back. */
  private async record(orgId: string, projectId: string, id: string): Promise<PackageRecord | null> {
    const [row] = await this.prisma.$queryRaw<PackageRow[]>`
      SELECT ${PACKAGE_COLUMNS}
      FROM package p
      LEFT JOIN runner_artifact a ON a.id = p.current_artifact_id
      WHERE p.org_id = ${orgId}::uuid AND p.project_id = ${projectId}::uuid AND p.id = ${id}::uuid
    `;
    return row ? toRecord(row) : null;
  }

  async create(input: {
    id: string;
    orgId: string;
    projectId: string;
    name: string;
    kind: string;
  }): Promise<PackageRecord> {
    try {
      await this.prisma.$executeRaw`
        INSERT INTO package (id, org_id, project_id, name, kind)
        VALUES (${input.id}::uuid, ${input.orgId}::uuid, ${input.projectId}::uuid, ${input.name}, ${input.kind})
      `;
    } catch (err) {
      throw nameTaken(err);
    }
    const created = await this.record(input.orgId, input.projectId, input.id);
    if (!created) throw new Error('package insert returned no row');
    return created;
  }

  async rename(orgId: string, projectId: string, id: string, name: string): Promise<PackageRecord | null> {
    let updated: number;
    try {
      updated = await this.prisma.$executeRaw`
        UPDATE package SET name = ${name}
        WHERE org_id = ${orgId}::uuid AND project_id = ${projectId}::uuid AND id = ${id}::uuid
      `;
    } catch (err) {
      throw nameTaken(err);
    }
    if (updated !== 1) return null;
    return this.find(orgId, projectId, id);
  }

  /**
   * Makes a version current. When this package already holds a version with
   * the same SHA-256, THAT row becomes current and nothing new is stored — the
   * caller deletes its temporary file (`reused: true`). Null when the package
   * is not in this tenant.
   *
   * THE RESULT IS THE VERSION THIS CALL MADE CURRENT, not whatever is current
   * when the caller gets it: the caller queues a job on `version`, and a run
   * must start from the jar this upload carried, never another upload's. So
   * the version and the package are read back INSIDE the transaction, by this
   * call's version id, while the package row is still locked. Re-reading
   * `current` after the commit would race a concurrent upload (wrong version)
   * and a concurrent delete (no row at all, after the insert succeeded).
   */
  async addVersion(
    orgId: string,
    projectId: string,
    packageId: string,
    version: NewPackageVersion,
  ): Promise<{ package: PackageRecord; version: PackageVersionRecord; reused: boolean } | null> {
    return this.prisma.$transaction(async (tx) => {
      const [owner] = await tx.$queryRaw<{ id: string; kind: string }[]>`
        SELECT id, kind FROM package
        WHERE org_id = ${orgId}::uuid AND project_id = ${projectId}::uuid AND id = ${packageId}::uuid
        FOR UPDATE
      `;
      if (!owner) return null;
      const [existing] = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM runner_artifact
        WHERE package_id = ${packageId}::uuid AND sha256 = ${version.sha256}
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      `;
      const artifactId = existing?.id ?? version.artifactId;
      if (!existing) {
        await tx.$executeRaw`
          INSERT INTO runner_artifact (
            id, org_id, project_id, package_id, filename, kind, gatling_version,
            sha256, bytes, storage_path, simulations
          )
          VALUES (
            ${version.artifactId}::uuid, ${orgId}::uuid, ${projectId}::uuid, ${packageId}::uuid,
            ${version.filename}, ${owner.kind}, ${version.gatlingVersion}, ${version.sha256},
            ${version.bytes}, ${version.storagePath},
            ${version.simulations === null ? null : JSON.stringify(version.simulations)}::jsonb
          )
        `;
      }
      await tx.$executeRaw`
        UPDATE package SET current_artifact_id = ${artifactId}::uuid, updated_at = now()
        WHERE id = ${packageId}::uuid
      `;
      const [row] = await tx.$queryRaw<PackageRow[]>`
        SELECT ${PACKAGE_COLUMNS}
        FROM package p
        JOIN runner_artifact a ON a.id = ${artifactId}::uuid
        WHERE p.id = ${packageId}::uuid
      `;
      const record = row ? toRecord(row) : null;
      if (!record?.current) throw new Error('package version insert returned no row');
      return { package: record, version: record.current, reused: existing !== undefined };
    }, LOCK_WAITING_TX);
  }

  /**
   * Deletes a package unless a job of any of its versions is active. One
   * transaction, two statements: the package row is locked FIRST (a start in
   * flight holds it FOR SHARE, so this waits for that start to commit), and the
   * active jobs are counted SECOND, on a fresh READ COMMITTED snapshot that
   * therefore sees the job that start queued. Version rows stay (their jobs'
   * history); their FILES are handed back for the caller to remove.
   */
  async delete(
    orgId: string,
    projectId: string,
    id: string,
  ): Promise<{ kind: 'deleted'; storagePaths: string[] } | { kind: 'in_use'; activeJobs: number } | { kind: 'not_found' }> {
    return this.prisma.$transaction(async (tx) => {
      const [locked] = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM package
        WHERE org_id = ${orgId}::uuid AND project_id = ${projectId}::uuid AND id = ${id}::uuid
        FOR UPDATE
      `;
      if (!locked) return { kind: 'not_found' as const };
      const [active] = await tx.$queryRaw<{ n: bigint }[]>`
        SELECT count(*) AS n FROM runner_job j JOIN runner_artifact v ON v.id = j.artifact_id
        WHERE v.package_id = ${id}::uuid AND j.status IN (${Prisma.join(ACTIVE_JOB_STATUSES)})
      `;
      const activeJobs = Number(active?.n ?? 0n);
      if (activeJobs > 0) return { kind: 'in_use' as const, activeJobs };
      const files = await tx.$queryRaw<{ storagePath: string }[]>`
        SELECT storage_path AS "storagePath" FROM runner_artifact WHERE package_id = ${id}::uuid
      `;
      await tx.$executeRaw`DELETE FROM package WHERE id = ${id}::uuid`;
      return { kind: 'deleted' as const, storagePaths: files.map((f) => f.storagePath) };
    }, LOCK_WAITING_TX);
  }
}

/** The key the unique index is declared on. */
const NAME_KEY = '(project_id, lower(name))';

function nameTaken(err: unknown): unknown {
  // Any other unique violation must surface as itself, never as "that name is
  // taken". Which index refused is read from what Prisma actually passes
  // through, and that is NOT the constraint name: a failed raw query arrives as
  // P2010 whose message carries Postgres' SQLSTATE (23505) and its DETAIL
  // line, "Key (project_id, lower(name))=(…) already exists." — the index's
  // key expression, which names exactly one unique index on this table (the
  // primary key reads "Key (id)=…"). The word "Key" is not matched because
  // Postgres translates it; the column list and the SQLSTATE are not.
  // The constraint name stays as a second spelling, for a driver that does
  // pass it.
  const text = err instanceof Error ? err.message : String(err);
  const taken =
    text.includes('package_project_name_lower_key') ||
    (text.includes('23505') && text.includes(NAME_KEY));
  if (taken) {
    return new PackageNameTakenError('A package with this name already exists in the project.');
  }
  return err;
}

function toRecord(row: PackageRow): PackageRecord {
  return {
    id: row.id,
    orgId: row.orgId,
    projectId: row.projectId,
    name: row.name,
    kind: row.kind,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    current:
      row.artifactId === null
        ? null
        : {
            artifactId: row.artifactId,
            filename: row.filename!,
            kind: row.artifactKind!,
            gatlingVersion: row.gatlingVersion,
            sha256: row.sha256!,
            bytes: Number(row.bytes ?? 0n),
            simulations: row.simulations,
            storagePath: row.storagePath!,
            uploadedAt: row.uploadedAt!,
          },
  };
}

function withUsage(row: UsageRow): PackageWithUsage {
  return {
    ...toRecord(row),
    usage: { tests: Number(row.tests), runs: Number(row.runs), activeJobs: Number(row.activeJobs) },
  };
}
