import { BlobStore } from '@perfportal/storage';
import { PipelineService } from '../../../worker/src/pipeline/pipeline.service.js';
import { loadWorkerConfig } from '../../../worker/src/config.js';
import type { TestContext } from './app.js';

export async function runPipelineFor(ctx: TestContext, runId: string): Promise<void> {
  const config = loadWorkerConfig();
  const blobs = new BlobStore(config.blob);
  const pipeline = new PipelineService(config, ctx.prisma, ctx.pool, blobs);
  await pipeline.process(runId).catch(() => undefined);   // failures are recorded on the run
}
