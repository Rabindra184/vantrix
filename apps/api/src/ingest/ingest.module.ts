import { Module } from '@nestjs/common';
import { BlobStore, LiveChunkStore } from '@perfportal/storage';
import { CONFIG } from '../auth/auth.module.js';
import type { AppConfig } from '../config.js';
import { RunsModule } from '../runs/runs.module.js';
import { IngestController } from './ingest.controller.js';
import { IngestService } from './ingest.service.js';
import { LiveController } from './live.controller.js';
import { LiveNotifier } from './live-notifier.js';
import { LiveService } from './live.service.js';
import { IngestQueue } from './queue.js';

@Module({
  // IngestController and LiveController both wait on the terminal state and
  // share the response path with GET (RunsService, TerminalWaiter), so this
  // module needs RunsModule's exports — sibling modules don't see each
  // other's providers without an explicit import.
  imports: [RunsModule],
  controllers: [IngestController, LiveController],
  providers: [
    IngestService,
    LiveService,
    {
      provide: BlobStore,
      useFactory: async (config: AppConfig) => {
        const store = new BlobStore({ ...config.blob });
        await store.ensureBucket();
        return store;
      },
      inject: [CONFIG],
    },
    // A thin wrapper over the same BlobStore instance — one bucket, one
    // client, so live chunk objects and finished bundles share the exact
    // connection/pool the factory above already sets up.
    {
      provide: LiveChunkStore,
      useFactory: (blobs: BlobStore) => new LiveChunkStore(blobs),
      inject: [BlobStore],
    },
    {
      provide: IngestQueue,
      useFactory: (config: AppConfig) => new IngestQueue(config.redisUrl),
      inject: [CONFIG],
    },
    // Same useFactory + inject: [CONFIG] shape as IngestQueue just above --
    // the API has no other Redis client for this to reuse (see
    // LiveNotifier's own docstring). Implementing OnModuleDestroy is what
    // lets Nest's own app.close() quit this connection, the same way it
    // already closes IngestQueue's -- no manual disposal wiring needed in
    // createTestApp() or main.ts.
    {
      provide: LiveNotifier,
      useFactory: (config: AppConfig) => new LiveNotifier(config.redisUrl),
      inject: [CONFIG],
    },
  ],
  exports: [BlobStore, IngestQueue, LiveNotifier],
})
export class IngestModule {}
