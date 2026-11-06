import { Module } from '@nestjs/common';
import { OrgSettingsRepository, PublicLinkRepository } from '@perfportal/persistence';
import pg from 'pg';
import { SessionOnlyGuard } from '../auth/session-only.guard.js';
import { PublicLinksController } from './public-links.controller.js';

// RunRepository is provided and exported by the @Global() AuthModule (see
// auth.module.ts). PublicLinkRepository and OrgSettingsRepository are raw SQL
// on a pg pool, so each is a factory over the shared pool AuthModule exports —
// the way RunsModule and AdminModule provide theirs — not a second connection.
@Module({
  controllers: [PublicLinksController],
  providers: [
    SessionOnlyGuard,
    { provide: PublicLinkRepository, useFactory: (pool: pg.Pool) => new PublicLinkRepository(pool), inject: [pg.Pool] },
    { provide: OrgSettingsRepository, useFactory: (pool: pg.Pool) => new OrgSettingsRepository(pool), inject: [pg.Pool] },
  ],
})
export class PublicLinksModule {}
