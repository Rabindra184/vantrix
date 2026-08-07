import { MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { AuthMiddleware } from './auth/auth.middleware.js';
import { AuthModule } from './auth/auth.module.js';
import { HealthController } from './health.controller.js';

@Module({
  imports: [AuthModule],
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
