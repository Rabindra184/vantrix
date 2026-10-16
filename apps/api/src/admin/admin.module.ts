import { Module } from '@nestjs/common';
import { RecomputeRepository, VerificationRepository } from '@perfportal/persistence';
import pg from 'pg';
import { SessionOnlyGuard } from '../auth/session-only.guard.js';
import { AdminUsersService } from './admin-users.service.js';
import { AdminController } from './admin.controller.js';

// PrismaClient and the repositories (UserRepository, ProjectRepository,
// ProjectMemberRepository) are provided and exported by the @Global()
// AuthModule (see auth.module.ts), so only what is this module's own is
// declared here. RecomputeRepository and VerificationRepository are raw SQL
// on a pg pool, so each is a factory over the shared pool AuthModule exports —
// the way RunsModule and MetricsModule provide MetricReader — not a second
// connection.
@Module({
  controllers: [AdminController],
  providers: [
    SessionOnlyGuard,
    AdminUsersService,
    { provide: RecomputeRepository, useFactory: (pool: pg.Pool) => new RecomputeRepository(pool), inject: [pg.Pool] },
    { provide: VerificationRepository, useFactory: (pool: pg.Pool) => new VerificationRepository(pool), inject: [pg.Pool] },
  ],
})
export class AdminModule {}
