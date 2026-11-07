import { Module } from '@nestjs/common';
import { OrgSettingsRepository } from '@perfportal/persistence';
import pg from 'pg';
import { SessionOnlyGuard } from '../auth/session-only.guard.js';
import { PublicLinkResolveController } from './public-link-resolve.controller.js';
import { PublicLinksController } from './public-links.controller.js';

// RunRepository and PublicLinkRepository are provided and exported by the
// @Global() AuthModule (see auth.module.ts) — the second because AuthMiddleware
// reads it on every PublicLink request. OrgSettingsRepository is raw SQL on a
// pg pool, so it is a factory over the shared pool AuthModule exports — the
// way RunsModule and AdminModule provide theirs — not a second connection.
@Module({
  controllers: [PublicLinksController, PublicLinkResolveController],
  providers: [
    SessionOnlyGuard,
    { provide: OrgSettingsRepository, useFactory: (pool: pg.Pool) => new OrgSettingsRepository(pool), inject: [pg.Pool] },
  ],
})
export class PublicLinksModule {}
