import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { PrismaClient } from '@prisma/client';
import {
  createPool,
  createPrisma,
  OrgMemberRepository,
  ProjectRepository,
  RunnerRepository,
  RunRepository,
  RuleRepository,
  TokenRepository,
} from '@perfportal/persistence';
import pg from 'pg';
import { loadConfig } from '../config.js';
import { AuthGuard } from './auth.guard.js';
import { AuthMiddleware } from './auth.middleware.js';

export const CONFIG = Symbol('CONFIG');

@Global()
@Module({
  providers: [
    { provide: CONFIG, useFactory: () => loadConfig() },
    { provide: PrismaClient, useFactory: () => createPrisma(loadConfig().databaseUrl) },
    { provide: pg.Pool, useFactory: () => createPool(loadConfig().databaseUrl) },
    { provide: TokenRepository, useFactory: (p: PrismaClient) => new TokenRepository(p), inject: [PrismaClient] },
    { provide: OrgMemberRepository, useFactory: (p: PrismaClient) => new OrgMemberRepository(p), inject: [PrismaClient] },
    { provide: ProjectRepository, useFactory: (p: PrismaClient) => new ProjectRepository(p), inject: [PrismaClient] },
    { provide: RunnerRepository, useFactory: (p: PrismaClient) => new RunnerRepository(p), inject: [PrismaClient] },
    { provide: RunRepository, useFactory: (p: PrismaClient) => new RunRepository(p), inject: [PrismaClient] },
    { provide: RuleRepository, useFactory: (p: PrismaClient) => new RuleRepository(p), inject: [PrismaClient] },
    AuthGuard,
    AuthMiddleware,
    // Global so @Scopes() is enforced everywhere by default — a handler
    // that forgets @UseGuards(AuthGuard) no longer skips scope checking.
    // useExisting (not useClass) so this is the same instance as the
    // AuthGuard provider above, not a second one.
    { provide: APP_GUARD, useExisting: AuthGuard },
  ],
  exports: [CONFIG, PrismaClient, pg.Pool, TokenRepository, OrgMemberRepository, ProjectRepository, RunnerRepository, RunRepository, RuleRepository, AuthGuard, AuthMiddleware],
})
export class AuthModule {}
