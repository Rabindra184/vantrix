import { Module } from '@nestjs/common';
import { MetricReader } from '@perfportal/persistence';
import pg from 'pg';
import { CONFIG } from '../auth/auth.module.js';
import type { AppConfig } from '../config.js';
import { ProjectRunsController, RunsController } from './runs.controller.js';
import { RunsService } from './runs.service.js';
import { TerminalWaiter } from './terminal-waiter.js';

@Module({
  controllers: [RunsController, ProjectRunsController],
  providers: [
    RunsService,
    // `windowable` on a run response is one EXISTS against that run's own
    // partition, so this module needs the reader too. Provided the same way
    // MetricsModule provides it — a factory over the shared pool, not a second
    // connection.
    { provide: MetricReader, useFactory: (pool: pg.Pool) => new MetricReader(pool), inject: [pg.Pool] },
    {
      provide: TerminalWaiter,
      useFactory: (config: AppConfig) => new TerminalWaiter(config.databaseUrl),
      inject: [CONFIG],
    },
  ],
  exports: [RunsService, TerminalWaiter],
})
export class RunsModule {}
