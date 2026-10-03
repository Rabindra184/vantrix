import { Module } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PackageRepository } from '@perfportal/persistence';
import { SessionOnlyGuard } from '../auth/session-only.guard.js';
import { PackagesController } from './packages.controller.js';
import { RunnerController } from './runner.controller.js';

// ProjectRepository and RunnerRepository come from the @Global() AuthModule.
// PackageRepository is provided HERE, the way AuthModule provides each of them
// (a factory over the shared PrismaClient), because only this module's two
// controllers use it. SessionOnlyGuard is listed for the package DELETE, as
// TestsModule lists it for a test's.
@Module({
  controllers: [RunnerController, PackagesController],
  providers: [
    { provide: PackageRepository, useFactory: (p: PrismaClient) => new PackageRepository(p), inject: [PrismaClient] },
    SessionOnlyGuard,
  ],
})
export class RunnerModule {}
