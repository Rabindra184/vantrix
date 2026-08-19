import { Module } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { OrgMemberRepository, RunRepository } from '@perfportal/persistence';
import { CONFIG } from '../auth/auth.module.js';
import type { AppConfig } from '../config.js';
import { LiveHub } from './live-hub.js';
import { LiveGateway } from './live.gateway.js';

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
    // A third Redis client, and for the reason directly above: the gateway's
    // seed is a GET and an XRANGE, which LiveHub's subscriber connection is
    // not allowed to serve.
    //
    // The repositories come from AuthModule, which is @Global -- this module
    // does not import it, and would double-provide them if it did.
    {
      provide: LiveGateway,
      useFactory: (
        config: AppConfig,
        hub: LiveHub,
        runs: RunRepository,
        members: OrgMemberRepository,
        adapterHost: HttpAdapterHost,
      ) => new LiveGateway(config.redisUrl, hub, runs, members, adapterHost),
      inject: [CONFIG, LiveHub, RunRepository, OrgMemberRepository, HttpAdapterHost],
    },
  ],
  exports: [LiveHub, LiveGateway],
})
export class LiveModule {}
