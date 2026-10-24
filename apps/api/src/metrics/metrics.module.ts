import { Module } from '@nestjs/common';
import { AgentReader, MetricReader, TelemetryStore } from '@perfportal/persistence';
import pg from 'pg';
import { RunsModule } from '../runs/runs.module.js';
import { AgentController } from './agent.controller.js';
import { MetricsController } from './metrics.controller.js';
import { ParityController } from './parity.controller.js';

@Module({
  // RunsModule for `RunsService.lifecycleOf`: the agent summary's
  // `sharedWithPerfPortal` is the same runner-job link the run's identity reads.
  imports: [RunsModule],
  controllers: [MetricsController, ParityController, AgentController],
  providers: [
    // useFactory + explicit `inject` reads the token directly rather than via
    // design:paramtypes reflection, so this is unaffected by the pg.Pool
    // property-access reflection gap described in metrics.controller.ts.
    { provide: MetricReader, useFactory: (pool: pg.Pool) => new MetricReader(pool), inject: [pg.Pool] },
    // Same trap, same fix — see telemetry.module.ts's identical comment.
    // `pg.Pool` is reached as a property of the `pg` default export, so a
    // plain `providers: [TelemetryStore]` would have Nest reflect the wrong
    // constructor parameter type and inject `undefined` while reporting a
    // clean boot.
    { provide: TelemetryStore, useFactory: (pool: pg.Pool) => new TelemetryStore(pool), inject: [pg.Pool] },
    // The agent figures' reader: raw SQL on the same shared pool, provided the
    // same way for the same reflection reason.
    { provide: AgentReader, useFactory: (pool: pg.Pool) => new AgentReader(pool), inject: [pg.Pool] },
  ],
})
export class MetricsModule {}
