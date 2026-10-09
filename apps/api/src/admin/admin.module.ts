import { Module } from '@nestjs/common';
import { SessionOnlyGuard } from '../auth/session-only.guard.js';
import { AdminUsersService } from './admin-users.service.js';
import { AdminController } from './admin.controller.js';

// PrismaClient and the repositories (UserRepository, ProjectRepository,
// ProjectMemberRepository) are provided and exported by the @Global()
// AuthModule (see auth.module.ts), so only what is this module's own is
// declared here.
@Module({
  controllers: [AdminController],
  providers: [SessionOnlyGuard, AdminUsersService],
})
export class AdminModule {}
