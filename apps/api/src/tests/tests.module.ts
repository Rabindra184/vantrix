import { Module } from '@nestjs/common';
import { SessionOnlyGuard } from '../auth/session-only.guard.js';
import { TestsController } from './tests.controller.js';

// TestRepository and ProjectRepository are both provided and exported by the
// @Global() AuthModule, so no repository providers belong here — only
// SessionOnlyGuard, which the PATCH handler uses. Same shape as RulesModule.
@Module({
  controllers: [TestsController],
  providers: [SessionOnlyGuard],
})
export class TestsModule {}
