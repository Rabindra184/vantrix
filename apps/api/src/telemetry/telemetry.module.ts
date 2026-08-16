import { Module } from '@nestjs/common';
import { TelemetryStore } from '@perfportal/persistence';
import pg from 'pg';
import { TelemetryController } from './telemetry.controller.js';

@Module({
  controllers: [TelemetryController],
  providers: [
    // useFactory + explicit `inject` reads the token directly rather than via
    // design:paramtypes reflection — see metrics.module.ts's identical
    // comment. `pg.Pool` is reached as a property of the `pg` default export,
    // so a plain `providers: [TelemetryStore]` would have Nest reflect the
    // wrong constructor parameter type and inject `undefined` while reporting
    // a clean boot.
    { provide: TelemetryStore, useFactory: (pool: pg.Pool) => new TelemetryStore(pool), inject: [pg.Pool] },
  ],
})
export class TelemetryModule {}
