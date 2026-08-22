import { Module } from '@nestjs/common';
import { SessionOnlyGuard } from '../auth/session-only.guard.js';
import { RulesController } from './rules.controller.js';

// RuleRepository and ProjectRepository are both provided and exported by the
// @Global() AuthModule (auth.module.ts), so no repository providers belong
// here — only SessionOnlyGuard, exactly as TokensModule does it.
@Module({
  controllers: [RulesController],
  providers: [SessionOnlyGuard],
})
export class RulesModule {}
