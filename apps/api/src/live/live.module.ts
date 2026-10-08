import { Module } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { OrgMemberRepository, ProjectMemberRepository, RunRepository } from '@perfportal/persistence';
import { CONFIG } from '../auth/auth.module.js';
import { RedisCommands } from '../common/redis-commands.js';
import type { AppConfig } from '../config.js';
import { LiveHub } from './live-hub.js';
import { LiveGateway } from './live.gateway.js';

@Module({
  providers: [
    // Same useFactory + inject: [CONFIG] shape as IngestQueue / LiveNotifier
    // (ingest.module.ts). LiveHub needs a connection of its own: ioredis in
    // subscriber mode refuses ordinary commands, so it cannot share ANY other
    // client's connection, RedisCommands' included.
    {
      provide: LiveHub,
      useFactory: (config: AppConfig) => new LiveHub(config.redisUrl),
      inject: [CONFIG],
    },
    // Not LiveHub's client, for the reason directly above: the gateway's seed
    // is a GET and an XRANGE, which LiveHub's subscriber connection is not
    // allowed to serve. It takes the API's shared ordinary-command connection,
    // RedisCommands, instead.
    //
    // The repositories and RedisCommands come from AuthModule, which is
    // @Global -- this module does not import it, and would double-provide them
    // if it did.
    {
      provide: LiveGateway,
      useFactory: (
        commands: RedisCommands,
        hub: LiveHub,
        runs: RunRepository,
        members: OrgMemberRepository,
        projectMembers: ProjectMemberRepository,
        adapterHost: HttpAdapterHost,
      ) => new LiveGateway(commands, hub, runs, members, projectMembers, adapterHost),
      inject: [RedisCommands, LiveHub, RunRepository, OrgMemberRepository, ProjectMemberRepository, HttpAdapterHost],
    },
  ],
  exports: [LiveHub, LiveGateway],
})
export class LiveModule {}
