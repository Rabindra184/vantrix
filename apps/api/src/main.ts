import 'reflect-metadata';
import { resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { mountBetterAuth } from './auth/mount-better-auth.js';
import { AppModule } from './app.module.js';
import { ProblemFilter } from './common/problem.filter.js';
import { loadConfig } from './config.js';
import { mountOpenApi } from './openapi.js';
import { mountSecurityHeaders } from './security-headers.js';
import { mountSpa } from './spa.js';

const app = await NestFactory.create(AppModule);
const webDist = resolve(import.meta.dirname, '../../web/dist');

// FIRST, ahead of Better Auth's mount, the SPA's static handler and Nest's
// own router — all three register on this same Express instance, and only a
// middleware ahead of every one of them sees every response.
mountSecurityHeaders(app.getHttpAdapter().getInstance(), webDist);
mountBetterAuth(app);
mountSpa(app.getHttpAdapter().getInstance(), webDist);

app.useGlobalFilters(new ProblemFilter());
mountOpenApi(app);
await app.listen(loadConfig().port);
