import {
  createPrisma,
  ProjectRepository,
  RunnerRepository,
  RunRepository,
  type RunnerJobWithArtifact,
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

let activeJob: RunnerJobWithArtifact | null = null;
let activeRun: Promise<void> | null = null;
shutdown.onStop(() => notifier.close());
shutdown.onStop(() => queue.close());
shutdown.onStop(() => prisma.$disconnect());
shutdown.onStop(async () => {
  const job = activeJob;
  const run = activeRun;
  if (!job || !run) return;
  await runner.cancel(job.job.orgId, job.job.projectId, job.job.id).catch((err: unknown) => {
    console.error(`failed to cancel active runner job ${job.job.id} during shutdown`, err);
  });
  await run;
});

await blobs.ensureBucket();
console.log('on-prem runner started');

while (!shutdown.stopping) {
  let job: RunnerJobWithArtifact | null;
  try {
    job = await runner.claimNext();
  } catch (err) {
    console.error('failed to claim runner job', err);
    await sleep(config.pollIntervalMs);
    continue;
  }
  if (!job) {
    await sleep(config.pollIntervalMs);
    continue;
  }
  activeJob = job;
  activeRun = executor.run(job);
  await activeRun;
  activeJob = null;
  activeRun = null;
}

await shutdown.stop('loop exited');
