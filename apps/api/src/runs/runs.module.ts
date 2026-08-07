import { Module } from '@nestjs/common';
import { CONFIG } from '../auth/auth.module.js';
import type { AppConfig } from '../config.js';
import { ProjectRunsController, RunsController } from './runs.controller.js';
import { RunsService } from './runs.service.js';
import { TerminalWaiter } from './terminal-waiter.js';

@Module({
  controllers: [RunsController, ProjectRunsController],
  providers: [
    RunsService,
    {
      provide: TerminalWaiter,
      useFactory: (config: AppConfig) => new TerminalWaiter(config.databaseUrl),
      inject: [CONFIG],
    },
  ],
  exports: [RunsService, TerminalWaiter],
})
export class RunsModule {}
