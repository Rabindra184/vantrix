import { Module } from '@nestjs/common';
import { CONFIG } from '../auth/auth.module.js';
import type { AppConfig } from '../config.js';
import { LiveHub } from './live-hub.js';

@Module({
  providers: [
    // Same useFactory + inject: [CONFIG] shape as IngestQueue / LiveNotifier
    // (ingest.module.ts) -- the API has no other Redis client for this to
    // reuse, and LiveHub needs its own regardless: ioredis in subscriber mode
    // refuses ordinary commands, so it cannot share ANY other client's
    // connection either.
    {
      provide: LiveHub,
      useFactory: (config: AppConfig) => new LiveHub(config.redisUrl),
      inject: [CONFIG],
    },
  ],
  exports: [LiveHub],
})
export class LiveModule {}
