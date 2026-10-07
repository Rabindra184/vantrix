import type { ApplicationConfig } from '@nestjs/core';
import { afterEach, describe, expect, it } from 'vitest';
import { AccessGuard } from '../src/auth/access.guard.js';
import { AuthGuard } from '../src/auth/auth.guard.js';
import { createTestApp, type TestContext } from './support/app.js';

/**
 * ═══ AccessGuard RUNS SECOND ═══
 *
 * `auth.module.ts` lists `AccessGuard`'s APP_GUARD after `AuthGuard`'s and
 * says the list order is the run order. That is Nest's behaviour, not a
 * guarantee of this codebase's, so it is read back from the running app
 * rather than from the module's source: `getGlobalGuards()` is the array
 * `GuardsConsumer` walks, in order, for every route. A reordering — or a
 * second registration of either — fails here naming the actual list.
 *
 * `config` is NestApplication's own, private to TypeScript only.
 */
describe('the global guards', () => {
  let ctx: TestContext;
  afterEach(async () => {
    await ctx?.close();
  });

  it('run AuthGuard, then AccessGuard, and nothing else', async () => {
    ctx = await createTestApp();
    const config = (ctx.app as unknown as { config: ApplicationConfig }).config;

    expect(config.getGlobalGuards().map((g) => g.constructor)).toStrictEqual([AuthGuard, AccessGuard]);
  });
});
