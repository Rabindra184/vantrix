import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { ProblemFilter } from './common/problem.filter.js';
import { loadConfig } from './config.js';

const app = await NestFactory.create(AppModule);
app.useGlobalFilters(new ProblemFilter());
await app.listen(loadConfig().port);
