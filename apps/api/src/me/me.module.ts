import { Module } from '@nestjs/common';
import { SessionOnlyGuard } from '../auth/session-only.guard.js';
import { MeController } from './me.controller.js';
import {
  DEFAULT_PASSWORD_ATTEMPT_POLICY,
  PASSWORD_ATTEMPT_POLICY,
  PasswordAttempts,
} from './password-attempts.js';

// UserRepository and RedisCommands (which PasswordAttempts takes) are
// provided and exported by the @Global() AuthModule (see auth.module.ts).
// The policy is provided HERE, and only so a test can override it: production
// takes the default, 3 attempts per 10 s.
@Module({
  controllers: [MeController],
  providers: [
    SessionOnlyGuard,
    PasswordAttempts,
    { provide: PASSWORD_ATTEMPT_POLICY, useValue: DEFAULT_PASSWORD_ATTEMPT_POLICY },
  ],
})
export class MeModule {}
