import { Module } from '@nestjs/common';
import { SessionOnlyGuard } from '../auth/session-only.guard.js';
import { MembersController } from './members.controller.js';

// ProjectRepository, ProjectMemberRepository and UserRepository are provided
// and exported by the @Global() AuthModule (see auth.module.ts), so only what
// is this module's own is declared here.
@Module({
  controllers: [MembersController],
  providers: [SessionOnlyGuard],
})
export class MembersModule {}
