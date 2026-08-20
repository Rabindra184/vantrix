import {
  createPrisma,
  ProjectRepository,
  RunnerRepository,
  RunRepository,
} from '@perfportal/persistence';
import { BlobStore, LiveChunkStore } from '@perfportal/storage';
import { loadRunnerConfig } from './config.js';
import { RunnerExecutor } from './executor.js';
import { RunnerIngestQueue } from './ingest-queue.js';
import { RunnerLiveNotifier } from './live-notifier.js';
import { Shutdown } from './shutdown.js';
import { sleep } from './sleep.js';

const config = loadRunnerConfig();
const shutdown = new Shutdown();
shutdown.install();

const prisma = createPrisma(config.databaseUrl, { connectionLimit: 4 });
const projects = new ProjectRepository(prisma);
const runner = new RunnerRepository(prisma);
const runs = new RunRepository(prisma);
const blobs = new BlobStore(config.blob);
const chunks = new LiveChunkStore(blobs);
const queue = new RunnerIngestQueue(config.redisUrl);
const notifier = new RunnerLiveNotifier(config.redisUrl);
const executor = new RunnerExecutor({
  config,
  projects,
  runner,
  runs,
  blobs,
  chunks,
  queue,
  notifier,
});

shutdown.onStop(() => notifier.close());
shutdown.onStop(() => queue.close());
shutdown.onStop(() => prisma.$disconnect());

await blobs.ensureBucket();
console.log('on-prem runner started');

while (!shutdown.stopping) {
  const job = await runner.claimNext();
  if (!job) {
    await sleep(config.pollIntervalMs);
    continue;
  }
  await executor.run(job);
}

await shutdown.stop('loop exited');
