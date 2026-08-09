import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { toNodeHandler } from 'better-auth/node';
import { auth } from './auth/better-auth.instance.js';
import { AppModule } from './app.module.js';
import { ProblemFilter } from './common/problem.filter.js';
import { loadConfig } from './config.js';
import { mountOpenApi } from './openapi.js';

const app = await NestFactory.create(AppModule);

// Mounted on the raw Express instance, outside /v1, and BEFORE Nest's body
// parser (registered during app.init() below): Better Auth needs the raw,
// unparsed body for sign-up and sign-in. '/auth/*splat' is Express 5's
// named-wildcard syntax; '/auth/*' does not match.
app.getHttpAdapter().getInstance().all('/auth/*splat', toNodeHandler(auth));

app.useGlobalFilters(new ProblemFilter());
mountOpenApi(app);
await app.listen(loadConfig().port);
