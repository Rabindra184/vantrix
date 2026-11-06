import type pg from 'pg';

/**
 * An org's own settings: the switch for AI run analysis, and the one for
 * public links.
 *
 * ═══ OFF UNTIL AN ADMIN SAYS OTHERWISE ═══
 *
 * `org.ai_enabled` defaults to false, so configuring a provider in the
 * environment never by itself sends a run's figures anywhere: an admin has to
 * turn this on as well. An org that does not exist reads as off — the safe
 * answer for a question about whether data may leave the deployment.
 */
export class OrgSettingsRepository {
  constructor(private readonly pool: pg.Pool) {}

  async aiEnabled(orgId: string): Promise<boolean> {
    const { rows } = await this.pool.query<{ ai_enabled: boolean }>(
      'SELECT ai_enabled FROM org WHERE id = $1::uuid',
      [orgId],
    );
    return rows[0]?.ai_enabled === true;
  }

  async setAiEnabled(orgId: string, enabled: boolean): Promise<void> {
    await this.pool.query('UPDATE org SET ai_enabled = $2 WHERE id = $1::uuid', [orgId, enabled]);
  }

  /**
   * Whether this org's public links answer at all. Off by default, like the
   * AI switch and for the same reason: a link lets someone read a run without
   * signing in, so an upgraded install exposes nothing until an admin says so.
   * Turning it off stops every link at once without touching them; turning it
   * back on restores the ones that have not expired or been revoked. An org
   * that does not exist reads as off.
   */
  async publicLinksEnabled(orgId: string): Promise<boolean> {
    const { rows } = await this.pool.query<{ public_links_enabled: boolean }>(
      'SELECT public_links_enabled FROM org WHERE id = $1::uuid',
      [orgId],
    );
    return rows[0]?.public_links_enabled === true;
  }

  async setPublicLinksEnabled(orgId: string, enabled: boolean): Promise<void> {
    await this.pool.query('UPDATE org SET public_links_enabled = $2 WHERE id = $1::uuid', [orgId, enabled]);
  }
}
