import { rm } from 'node:fs/promises';
import path from 'node:path';
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
let nextRetentionSweepAt = 0;
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
console.log(`on-prem runner started for org ${config.scope.orgId}${config.scope.projectId ? ` project ${config.scope.projectId}` : ''}`);

while (!shutdown.stopping) {
  let job: RunnerJobWithArtifact | null;
  try {
    await runner.failStale(config.scope, new Date(Date.now() - config.staleJobMs));
    if (Date.now() >= nextRetentionSweepAt) {
      nextRetentionSweepAt = Date.now() + config.retentionSweepIntervalMs;
      await cleanupExpiredArtifacts();
    }
    job = await runner.claimNext(config.scope);
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

async function cleanupExpiredArtifacts(): Promise<void> {
  if (config.artifactRetentionDays === 0) return;
  const retentionMs = config.artifactRetentionDays * 24 * 60 * 60 * 1000;
  const rows = await runner.deleteTerminalArtifactsOlderThan(
    config.scope,
    new Date(Date.now() - retentionMs),
  );
  for (const row of rows) {
    await removeIfUnder(config.artifactDir, row.storagePath);
    for (const logPath of row.logPaths) await removeIfUnder(config.logDir, logPath);
  }
  if (rows.length > 0) {
    console.log(`removed ${rows.length} expired runner artifact${rows.length === 1 ? '' : 's'}`);
  }
}

async function removeIfUnder(root: string, storedPath: string): Promise<void> {
  const resolvedRoot = path.resolve(root);
  const target = path.isAbsolute(storedPath)
    ? path.resolve(storedPath)
    : path.resolve(resolvedRoot, storedPath);
  if (target !== resolvedRoot && !target.startsWith(`${resolvedRoot}${path.sep}`)) {
    console.warn(`skipping retention delete outside ${resolvedRoot}: ${target}`);
    return;
  }
  await rm(target, { force: true, recursive: true }).catch((err: unknown) => {
    console.warn(`failed to remove retained runner file ${target}`, err);
  });
}
