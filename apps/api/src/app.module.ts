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
import { RulesModule } from './rules/rules.module.js';
import { TokensModule } from './tokens/tokens.module.js';

@Module({
  imports: [AuthModule, RunsModule, IngestModule, LiveModule, MetricsModule, ProjectsModule, RulesModule, RunnerModule, TelemetryModule, TokensModule],
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
    consumer
      // THE API DESCRIPTION IS ALREADY PUBLIC — THIS ONLY MAKES IT
      // DETERMINISTIC.
      //
      // `mountOpenApi` registers /v1/docs and /v1/openapi.json straight onto
      // the Express instance BEFORE `app.init()` (see main.ts and
      // test/support/app.ts), and Express matches in registration order — so
      // those two have always resolved ahead of this middleware and answered
      // 200 with no credential. Measured against the real bootstrap, not
      // assumed: unauthenticated, /v1/openapi.json and /v1/docs both return
      // 200 while /v1/runs returns 401.
      //
      // Relying on that ordering is the problem. Nothing declares it, nothing
      // tests it, and any future change to when Swagger is mounted flips
      // these two routes from public to 401 with no failing assertion to say
      // so — `openapi.integration.test.ts` asserts 200 from `fetchDoc()`, so
      // the symptom would be that whole file failing on whichever test
      // happened to call it first, naming nothing.
      //
      // Excluding them states the existing contract instead of inheriting it
      // from a side effect. It widens nothing: both were already reachable
      // without a credential, and `openapi-public.integration.test.ts` pins
      // that /v1/runs still is not.
      .apply(AuthMiddleware)
      .exclude('v1/openapi.json', 'v1/docs', 'v1/docs/*path')
      .forRoutes('v1/*path');
  }
}
