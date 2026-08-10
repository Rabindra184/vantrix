import 'reflect-metadata';
import { resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { mountBetterAuth } from './auth/mount-better-auth.js';
import { AppModule } from './app.module.js';
import { ProblemFilter } from './common/problem.filter.js';
import { loadConfig } from './config.js';
import { mountOpenApi } from './openapi.js';
import { mountSpa } from './spa.js';

const app = await NestFactory.create(AppModule);

mountBetterAuth(app);
mountSpa(app.getHttpAdapter().getInstance(), resolve(import.meta.dirname, '../../web/dist'));

app.useGlobalFilters(new ProblemFilter());
mountOpenApi(app);
await app.listen(loadConfig().port);
