import { Module } from '@nestjs/common';
import { SessionOnlyGuard } from '../auth/session-only.guard.js';
import { TokensController } from './tokens.controller.js';

// TokenRepository and ProjectRepository are provided and exported by the
// @Global() AuthModule (see auth.module.ts), so no repository providers are
// declared here — only SessionOnlyGuard, which nothing else exports yet.
@Module({
  controllers: [TokensController],
  providers: [SessionOnlyGuard],
})
export class TokensModule {}
