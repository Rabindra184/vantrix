import type pg from 'pg';

/**
 * An org's own settings: so far, the one switch for AI run analysis.
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
}
