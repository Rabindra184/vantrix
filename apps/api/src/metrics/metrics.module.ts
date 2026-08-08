import { Module } from '@nestjs/common';
import { MetricReader } from '@perfportal/persistence';
import pg from 'pg';
import { MetricsController } from './metrics.controller.js';
import { ParityController } from './parity.controller.js';

@Module({
  controllers: [MetricsController, ParityController],
  providers: [
    // useFactory + explicit `inject` reads the token directly rather than via
    // design:paramtypes reflection, so this is unaffected by the pg.Pool
    // property-access reflection gap described in metrics.controller.ts.
    { provide: MetricReader, useFactory: (pool: pg.Pool) => new MetricReader(pool), inject: [pg.Pool] },
  ],
})
export class MetricsModule {}
