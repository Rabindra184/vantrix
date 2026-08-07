import { Module } from '@nestjs/common';
import { BlobStore } from '@perfportal/storage';
import { CONFIG } from '../auth/auth.module.js';
import type { AppConfig } from '../config.js';
import { RunsModule } from '../runs/runs.module.js';
import { IngestController } from './ingest.controller.js';
import { IngestService } from './ingest.service.js';
import { IngestQueue } from './queue.js';

@Module({
  // IngestController now waits on the terminal state and shares the
  // response path with GET (RunsService, TerminalWaiter), so it needs
  // RunsModule's exports — sibling modules don't see each other's providers
  // without an explicit import.
  imports: [RunsModule],
  controllers: [IngestController],
  providers: [
    IngestService,
    {
      provide: BlobStore,
      useFactory: async (config: AppConfig) => {
        const store = new BlobStore({ ...config.blob });
        await store.ensureBucket();
        return store;
      },
      inject: [CONFIG],
    },
    {
      provide: IngestQueue,
      useFactory: (config: AppConfig) => new IngestQueue(config.redisUrl),
      inject: [CONFIG],
    },
  ],
  exports: [BlobStore, IngestQueue],
})
export class IngestModule {}
