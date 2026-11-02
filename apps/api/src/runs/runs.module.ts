import { Module } from '@nestjs/common';
import { AiAnalysisRepository, MetricReader, OrgSettingsRepository, VerificationRepository } from '@perfportal/persistence';
import pg from 'pg';
import { CONFIG } from '../auth/auth.module.js';
import type { AppConfig } from '../config.js';
import { AiAnalysisQueue } from './ai-analysis-queue.js';
import { RunAiAnalysisController } from './run-ai-analysis.controller.js';
import { RunEventsController } from './run-events.controller.js';
import { RunVerificationController } from './run-verification.controller.js';
import { ProjectRunsController, RunsController } from './runs.controller.js';
import { RunsService } from './runs.service.js';
import { TerminalWaiter } from './terminal-waiter.js';

@Module({
  controllers: [
    RunsController,
    ProjectRunsController,
    RunEventsController,
    RunVerificationController,
    RunAiAnalysisController,
  ],
  providers: [
    RunsService,
    // `windowable` on a run response is one EXISTS against that run's own
    // partition, so this module needs the reader too. Provided the same way
    // MetricsModule provides it — a factory over the shared pool, not a second
    // connection.
    { provide: MetricReader, useFactory: (pool: pg.Pool) => new MetricReader(pool), inject: [pg.Pool] },
    // `GET /v1/runs/{id}/verification` reads the run's verification row. Raw
    // SQL on a pg pool like MetricReader, so a factory over the same pool.
    {
      provide: VerificationRepository,
      useFactory: (pool: pg.Pool) => new VerificationRepository(pool),
      inject: [pg.Pool],
    },
    // `GET`/`POST /v1/runs/{id}/ai-analysis`: the run's analysis row and its
    // eligibility, and the org's AI switch. Raw SQL on a pg pool, the same
    // factory shape as the verification repository above.
    { provide: AiAnalysisRepository, useFactory: (pool: pg.Pool) => new AiAnalysisRepository(pool), inject: [pg.Pool] },
    { provide: OrgSettingsRepository, useFactory: (pool: pg.Pool) => new OrgSettingsRepository(pool), inject: [pg.Pool] },
    // The POST's queue. Its own Redis connection, the IngestQueue shape; its
    // onModuleDestroy closes it when the app does.
    {
      provide: AiAnalysisQueue,
      useFactory: (config: AppConfig) => new AiAnalysisQueue(config.redisUrl),
      inject: [CONFIG],
    },
    {
      provide: TerminalWaiter,
      useFactory: (config: AppConfig) => new TerminalWaiter(config.databaseUrl),
      inject: [CONFIG],
    },
  ],
  exports: [RunsService, TerminalWaiter],
})
export class RunsModule {}
