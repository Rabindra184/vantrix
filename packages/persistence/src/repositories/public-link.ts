import type pg from 'pg';
import { isUuid } from './uuid.js';

/**
 * A public link as anything outside this repository sees it: what the run's
 * Share list shows.
 *
 * NO `tokenHash`, for the reason `TokenSummaryRow` carries none: the hash is
 * the credential's lookup key, and a list endpoint that returned it would hand
 * out the one value that finds the link. Every select below names its
 * columns, which is what keeps that true when a column is added later.
 */
export interface PublicLinkRecord {
  id: string;
  runId: string;
  createdAt: Date;
  /** Null when the link was made with no user, or that user has since been deleted. */
  createdByName: string | null;
  expiresAt: Date;
  revokedAt: Date | null;
  /** Null until revoked, and again once the revoker's account is deleted. */
  revokedByName: string | null;
  lastUsedAt: Date | null;
}

/**
 * What the credential middleware decides from: the link's tenant, its run, its
 * lifecycle, and the org's switch, in one row. The hash it was found by is not
 * in it: the caller already holds the secret and has nothing to compare.
 */
export interface PublicLinkCredential {
  linkId: string;
  orgId: string;
  projectId: string;
  runId: string;
  expiresAt: Date;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
  publicLinksEnabled: boolean;
}

export interface PublicLinkScope {
  orgId: string;
  projectId: string;
}

export type PublicLinkRevokeOutcome = 'revoked' | 'already' | 'not_found';

interface PublicLinkRow {
  id: string;
  run_id: string;
  created_at: Date;
  created_by_name: string | null;
  expires_at: Date;
  revoked_at: Date | null;
  revoked_by_name: string | null;
  last_used_at: Date | null;
}

/**
 * The record's columns, read through the two user joins. One list for create's
 * CTE and the run's list, so the two answer one shape for one row. The alias
 * "l" is the link in both.
 */
const RECORD_COLUMNS = `l.id, l.run_id, l.created_at, creator.name AS created_by_name,
       l.expires_at, l.revoked_at, revoker.name AS revoked_by_name, l.last_used_at`;

/**
 * The two people a link names, LEFT joined: a link outlives both accounts
 * (ON DELETE SET NULL), and then reads a null name rather than vanishing.
 */
const PEOPLE_JOINS = `LEFT JOIN "user" creator ON creator.id = l.created_by
  LEFT JOIN "user" revoker ON revoker.id = l.revoked_by`;

function toRecord(row: PublicLinkRow): PublicLinkRecord {
  return {
    id: row.id,
    runId: row.run_id,
    createdAt: row.created_at,
    createdByName: row.created_by_name,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    revokedByName: row.revoked_by_name,
    lastUsedAt: row.last_used_at,
  };
}

/**
 * A run's public links (docs/superpowers/specs/2026-11-06-public-links-and-custom-report-design.md,
 * section 3). Raw SQL on a pg pool, like OrgSettingsRepository beside it.
 *
 * Rows are never deleted here: an expired or revoked link stays listed, so a
 * reader can see what was shared and when it stopped. They go only with their
 * run, project or org (ON DELETE CASCADE).
 */
export class PublicLinkRepository {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * Stores a link. The caller mints the secret and hashes it; this layer never
   * sees a plaintext secret, which is why `tokenHash` is a parameter.
   *
   * ═══ THE TENANT IS THE RUN'S, CHECKED IN THE INSERT ═══
   *
   * org_id and project_id are denormalised from the run so the credential
   * lookup answers the tenant in one row. The insert therefore SELECTs the
   * run with all three ids, so a link can only ever be written under the org
   * and project its run is really in: a mismatch inserts nothing and throws,
   * rather than storing a row whose tenant is false. A unique-index clash on
   * the hash is Postgres's own 23505, rethrown as is.
   */
  async create(input: {
    orgId: string;
    projectId: string;
    runId: string;
    tokenHash: string;
    createdBy: string | null;
    expiresAt: Date;
  }): Promise<PublicLinkRecord> {
    const { rows } = await this.pool.query<PublicLinkRow>(
      `WITH l AS (
         INSERT INTO run_public_link (org_id, project_id, run_id, token_hash, created_by, expires_at)
         SELECT r.org_id, r.project_id, r.id, $4::text, $5::text, $6::timestamptz
           FROM run r
          WHERE r.id = $3::uuid AND r.org_id = $1::uuid AND r.project_id = $2::uuid
         RETURNING id, run_id, created_by, created_at, expires_at, revoked_by, revoked_at, last_used_at
       )
       SELECT ${RECORD_COLUMNS}
         FROM l
         ${PEOPLE_JOINS}`,
      [input.orgId, input.projectId, input.runId, input.tokenHash, input.createdBy, input.expiresAt],
    );
    const row = rows[0];
    if (row === undefined) {
      throw new Error(`run ${input.runId} is not in this project, so no public link was stored for it`);
    }
    return toRecord(row);
  }

  /**
   * A run's links, newest first, scoped to the org and project: another
   * tenant's scope reads an empty list rather than this run's links. The id
   * breaks a tie between two links made in one millisecond, so the order is
   * stable between two reads.
   */
  async listForRun(scope: PublicLinkScope, runId: string): Promise<PublicLinkRecord[]> {
    const { rows } = await this.pool.query<PublicLinkRow>(
      `SELECT ${RECORD_COLUMNS}
         FROM run_public_link l
         ${PEOPLE_JOINS}
        WHERE l.org_id = $1::uuid AND l.project_id = $2::uuid AND l.run_id = $3::uuid
        ORDER BY l.created_at DESC, l.id DESC`,
      [scope.orgId, scope.projectId, runId],
    );
    return rows.map(toRecord);
  }

  /**
   * Revokes one link of one run, scoped to the org and project.
   *
   * IDEMPOTENT, as token revocation is: an already-revoked link keeps its
   * original revoked_at and revoker, so a retry after a timeout answers
   * 'already' and the record still says when the link actually stopped
   * working. The revoked_at IS NULL test is in the UPDATE itself, not a read
   * before it, so two concurrent revocations cannot both write: the database
   * lets exactly one match. A link of another run, or another tenant's, is
   * 'not_found', and so is an id that is not a uuid at all — a cast error on
   * the uuid column would otherwise be a 500 for a malformed URL.
   */
  async revoke(
    scope: PublicLinkScope,
    runId: string,
    linkId: string,
    userId: string,
  ): Promise<PublicLinkRevokeOutcome> {
    if (!isUuid(linkId) || !isUuid(runId)) return 'not_found';
    const where = 'id = $1::uuid AND org_id = $2::uuid AND project_id = $3::uuid AND run_id = $4::uuid';
    const params = [linkId, scope.orgId, scope.projectId, runId];
    const updated = await this.pool.query(
      `UPDATE run_public_link SET revoked_at = now(), revoked_by = $5
        WHERE ${where} AND revoked_at IS NULL`,
      [...params, userId],
    );
    if ((updated.rowCount ?? 0) > 0) return 'revoked';
    // Nothing matched: either it is already revoked, or it is not this run's.
    const existing = await this.pool.query(`SELECT 1 FROM run_public_link WHERE ${where}`, params);
    return existing.rows.length > 0 ? 'already' : 'not_found';
  }

  /**
   * The link a secret's hash names, joined with its org's switch; null for an
   * unknown hash. One indexed read through the unique index on token_hash.
   *
   * The ONLY method that reads token_hash, and only in its WHERE: nothing here
   * returns it. Expiry, revocation and the switch are returned rather than
   * filtered, so the caller can say WHICH of them stopped the link.
   */
  async findForCredential(tokenHash: string): Promise<PublicLinkCredential | null> {
    const { rows } = await this.pool.query<{
      id: string;
      org_id: string;
      project_id: string;
      run_id: string;
      expires_at: Date;
      revoked_at: Date | null;
      last_used_at: Date | null;
      public_links_enabled: boolean;
    }>(
      `SELECT l.id, l.org_id, l.project_id, l.run_id, l.expires_at, l.revoked_at, l.last_used_at,
              o.public_links_enabled
         FROM run_public_link l
         JOIN org o ON o.id = l.org_id
        WHERE l.token_hash = $1`,
      [tokenHash],
    );
    const row = rows[0];
    if (row === undefined) return null;
    return {
      linkId: row.id,
      orgId: row.org_id,
      projectId: row.project_id,
      runId: row.run_id,
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at,
      lastUsedAt: row.last_used_at,
      publicLinksEnabled: row.public_links_enabled,
    };
  }

  /**
   * Records that the link was just used, AT MOST ONCE A MINUTE: a Report makes
   * about twenty requests as it opens, and one write per request would be
   * twenty writes to say one thing. The guard is in the UPDATE, so the caller
   * may call this on every request and the database decides; a stale read of
   * last_used_at by the caller costs nothing but a no-op statement.
   */
  async touch(linkId: string): Promise<void> {
    await this.pool.query(
      `UPDATE run_public_link SET last_used_at = now()
        WHERE id = $1::uuid
          AND (last_used_at IS NULL OR last_used_at < now() - interval '60 seconds')`,
      [linkId],
    );
  }
}
