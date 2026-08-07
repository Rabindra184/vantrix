import { Global, Module } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import {
  createPool,
  createPrisma,
  ProjectRepository,
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
    { provide: ProjectRepository, useFactory: (p: PrismaClient) => new ProjectRepository(p), inject: [PrismaClient] },
    { provide: RunRepository, useFactory: (p: PrismaClient) => new RunRepository(p), inject: [PrismaClient] },
    { provide: RuleRepository, useFactory: (p: PrismaClient) => new RuleRepository(p), inject: [PrismaClient] },
    AuthGuard,
    AuthMiddleware,
  ],
  exports: [CONFIG, PrismaClient, pg.Pool, TokenRepository, ProjectRepository, RunRepository, RuleRepository, AuthGuard, AuthMiddleware],
})
export class AuthModule {}
