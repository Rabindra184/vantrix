import { Module } from '@nestjs/common';
import { SessionOnlyGuard } from '../auth/session-only.guard.js';
import { MeController } from './me.controller.js';
import { PasswordAttempts } from './password-attempts.js';

// UserRepository and RedisCommands (which PasswordAttempts takes) are
// provided and exported by the @Global() AuthModule (see auth.module.ts).
@Module({
  controllers: [MeController],
  providers: [SessionOnlyGuard, PasswordAttempts],
})
export class MeModule {}
