import 'reflect-metadata';
import { createPool, createPrisma } from '@perfportal/persistence';
import { BlobStore } from '@perfportal/storage';
import { loadWorkerConfig } from './config.js';
import { startConsumer } from './consumer.js';
import { PipelineService } from './pipeline/pipeline.service.js';
import { Sweeper } from './sweeper.js';

const config = loadWorkerConfig();
const prisma = createPrisma(config.databaseUrl);
const pool = createPool(config.databaseUrl);
const blobs = new BlobStore(config.blob);
await blobs.ensureBucket();

const pipeline = new PipelineService(config, prisma, pool, blobs);
const worker = startConsumer(config, pipeline);
const sweeper = new Sweeper(config, pool);

const timer = setInterval(() => {
  void sweeper.sweep().catch((err) => console.error('sweep failed', err));
}, config.sweepIntervalMs);

async function shutdown(): Promise<void> {
  clearInterval(timer);
  await worker.close();
  await sweeper.close();
  await pool.end();
  await prisma.$disconnect();
}

process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
