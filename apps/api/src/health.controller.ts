import { Controller, Get, Inject } from '@nestjs/common';
import pg from 'pg';

@Controller()
export class HealthController {
  // `pg.Pool` is a property-access type (a namespace member off a default
  // import), not a plain class reference. tsc's emitDecoratorMetadata can't
  // express that as a runtime value and silently degrades design:paramtypes
  // to Object here — unlike a directly-imported class such as
  // TokenRepository, which reflects correctly with no help. Under esbuild/swc
  // (what the test suite runs on) this same pattern resolves fine, so the
  // gap is invisible in tests and only surfaces as a hard "Nest can't
  // resolve dependencies" crash at boot with the real tsc build. An explicit
  // @Inject sidesteps the reflection gap entirely.
  constructor(@Inject(pg.Pool) private readonly pool: pg.Pool) {}

  @Get('/healthz')
  health(): { status: string } {
    return { status: 'ok' };
  }

  /** Readiness means dependencies answer, not merely that the process is up. */
  @Get('/readyz')
  async ready(): Promise<{ status: string }> {
    await this.pool.query('SELECT 1');
    return { status: 'ok' };
  }
}
