import { Module } from '@nestjs/common';
import { ActivityController } from './activity.controller.js';

// ActivityRepository is provided and exported by the @Global() AuthModule, with
// the other repositories, so no provider belongs here. Same shape as TestsModule.
@Module({
  controllers: [ActivityController],
})
export class ActivityModule {}
