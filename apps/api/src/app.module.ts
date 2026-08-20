import { MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { AuthMiddleware } from './auth/auth.middleware.js';
import { AuthModule } from './auth/auth.module.js';
import { HealthController } from './health.controller.js';
import { IngestModule } from './ingest/ingest.module.js';
import { LiveModule } from './live/live.module.js';
import { MetricsModule } from './metrics/metrics.module.js';
import { ProjectsModule } from './projects/projects.module.js';
import { RunsModule } from './runs/runs.module.js';
import { RunnerModule } from './runner/runner.module.js';
import { TelemetryModule } from './telemetry/telemetry.module.js';
import { TokensModule } from './tokens/tokens.module.js';

@Module({
  imports: [AuthModule, RunsModule, IngestModule, LiveModule, MetricsModule, ProjectsModule, RunnerModule, TelemetryModule, TokensModule],
  controllers: [HealthController],
})
export class AppModule implements NestModule {
  /**
   * Authenticate the entire /v1 surface, not just the routes that exist
   * today. NestJS guards only run for requests already matched to a
   * controller, so a route this app hasn't implemented yet (GET /v1/runs/:id
   * before Task 13) would otherwise 404 before AuthGuard ever saw it.
   * Middleware runs ahead of routing, so it authenticates those requests too.
   * /healthz and /readyz are outside /v1 and stay unauthenticated on purpose.
   */
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(AuthMiddleware).forRoutes('v1/*path');
  }
}
