import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { ProjectsController } from './projects.controller.js';

// ProjectRepository is provided and exported by AuthModule (see its
// `exports` array), so importing that module is what supplies it here.
@Module({
  imports: [AuthModule],
  controllers: [ProjectsController],
})
export class ProjectsModule {}
