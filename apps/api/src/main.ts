import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { mountBetterAuth } from './auth/mount-better-auth.js';
import { AppModule } from './app.module.js';
import { ProblemFilter } from './common/problem.filter.js';
import { loadConfig } from './config.js';
import { mountOpenApi } from './openapi.js';

const app = await NestFactory.create(AppModule);

mountBetterAuth(app);

app.useGlobalFilters(new ProblemFilter());
mountOpenApi(app);
await app.listen(loadConfig().port);
