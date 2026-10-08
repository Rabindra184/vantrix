import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { PrismaClient } from '@prisma/client';
import {
  ActivityRepository,
  createPool,
  createPrisma,
  OrgMemberRepository,
  ProjectMemberRepository,
  ProjectRepository,
  RunnerRepository,
  RunRepository,
  RuleRepository,
  TestRepository,
  TokenRepository,
  UserRepository,
} from '@perfportal/persistence';
import pg from 'pg';
import { RedisCommands } from '../common/redis-commands.js';
import { loadConfig } from '../config.js';
import { AccessGuard } from './access.guard.js';
import { AuthGuard } from './auth.guard.js';
import { AuthMiddleware } from './auth.middleware.js';
import { PasswordChangeGuard } from './password-change.guard.js';

export const CONFIG = Symbol('CONFIG');

@Global()
@Module({
  providers: [
    { provide: CONFIG, useFactory: () => loadConfig() },
    { provide: PrismaClient, useFactory: () => createPrisma(loadConfig().databaseUrl) },
    { provide: pg.Pool, useFactory: () => createPool(loadConfig().databaseUrl) },
    // The one connection for ordinary Redis commands; see redis-commands.ts.
    { provide: RedisCommands, useFactory: () => new RedisCommands(loadConfig().redisUrl) },
    { provide: TokenRepository, useFactory: (p: PrismaClient) => new TokenRepository(p), inject: [PrismaClient] },
    { provide: OrgMemberRepository, useFactory: (p: PrismaClient) => new OrgMemberRepository(p), inject: [PrismaClient] },
    { provide: ProjectMemberRepository, useFactory: (p: PrismaClient) => new ProjectMemberRepository(p), inject: [PrismaClient] },
    { provide: ProjectRepository, useFactory: (p: PrismaClient) => new ProjectRepository(p), inject: [PrismaClient] },
    { provide: RunnerRepository, useFactory: (p: PrismaClient) => new RunnerRepository(p), inject: [PrismaClient] },
    { provide: RunRepository, useFactory: (p: PrismaClient) => new RunRepository(p), inject: [PrismaClient] },
    { provide: RuleRepository, useFactory: (p: PrismaClient) => new RuleRepository(p), inject: [PrismaClient] },
    { provide: TestRepository, useFactory: (p: PrismaClient) => new TestRepository(p), inject: [PrismaClient] },
    { provide: ActivityRepository, useFactory: (p: PrismaClient) => new ActivityRepository(p), inject: [PrismaClient] },
    { provide: UserRepository, useFactory: (p: PrismaClient) => new UserRepository(p), inject: [PrismaClient] },
    AuthGuard,
    AuthMiddleware,
    // Global so @Scopes() is enforced everywhere by default — a handler
    // that forgets @UseGuards(AuthGuard) no longer skips scope checking.
    // useExisting (not useClass) so this is the same instance as the
    // AuthGuard provider above, not a second one.
    { provide: APP_GUARD, useExisting: AuthGuard },
    // AFTER AuthGuard, and the position is the order: Nest collects APP_GUARD
    // providers in the order they are listed here and runs global guards in
    // that order (DependenciesScanner.insertProvider ->
    // ApplicationConfig.addGlobalGuard, then GuardsConsumer awaits each in
    // turn). AccessGuard never judges a bearer token, so what the order
    // decides is a SESSION's answer on a @Requires route whose @Scopes it
    // lacks (a session holds read, ingest and runner): AuthGuard's scope 403,
    // the same whichever project or run is named, before AccessGuard looks
    // anything up — rather than a 404 or ROLE_REQUIRED that depends on the
    // target. Outside /v1, where no middleware runs, it is also AuthGuard
    // that sets req.tenant for AccessGuard to read.
    // access-guard.integration.test.ts reads the order back from the running
    // app.
    //
    // The password gate sits BETWEEN the two: after AuthGuard, which sets
    // req.tenant outside /v1, and before AccessGuard, so a session that must
    // still choose its password is refused before AccessGuard can answer it
    // with a 404 or ADMIN_REQUIRED that says which projects exist and what
    // it may do. See password-change.guard.ts.
    PasswordChangeGuard,
    { provide: APP_GUARD, useExisting: PasswordChangeGuard },
    AccessGuard,
    { provide: APP_GUARD, useExisting: AccessGuard },
  ],
  exports: [CONFIG, PrismaClient, pg.Pool, RedisCommands, TokenRepository, OrgMemberRepository, ProjectMemberRepository, ProjectRepository, RunnerRepository, RunRepository, RuleRepository, TestRepository, ActivityRepository, UserRepository, AuthGuard, AuthMiddleware],
})
export class AuthModule {}
