import { Module } from '@nestjs/common';
import { RunnerController } from './runner.controller.js';

@Module({
  controllers: [RunnerController],
})
export class RunnerModule {}
