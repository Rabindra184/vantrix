import { Module } from '@nestjs/common';
import { SessionOnlyGuard } from '../auth/session-only.guard.js';
import { MeController } from './me.controller.js';

// UserRepository is provided and exported by the @Global() AuthModule (see
// auth.module.ts), so only SessionOnlyGuard is declared here.
@Module({
  controllers: [MeController],
  providers: [SessionOnlyGuard],
})
export class MeModule {}
