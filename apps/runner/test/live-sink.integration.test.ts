import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  createPool,
  createPrisma,
  ProjectRepository,
  RunRepository,
  type RunnerJobWithArtifact,
} from '@perfportal/persistence';
import { parseSimulationLog } from '@perfportal/plugin-gatling';
import { BlobStore, LiveChunkStore } from '@perfportal/storage';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunnerConfig } from '../src/config.js';
import type { RunnerIngestQueue } from '../src/ingest-queue.js';
import type { RunnerLiveNotifier } from '../src/live-notifier.js';
import { RunnerLiveSink } from '../src/live-sink.js';

/**
 * ═══ HOW THE RUNNER CLOSES A RUN WHOSE GATLING DIED PART-WAY ═══
 *
 * Against the real database and object store, because what matters is the
 * STATE the pipeline is handed: a row at `parsing` carrying
 * `stream_abandoned_at`, and a stored log that ends on a whole record. The
 * pipeline's half — that such a run ends `incomplete` WITH its statistics —
 * is pinned by `apps/worker/test/pipeline.integration.test.ts`'s
 * "finishes an abandoned run as incomplete, with the statistics it parsed".
 */

const FIXTURE_LOG = fileURLToPath(
  new URL('../../../fixtures/gatling-3.15.1.2/reference-report/simulation.log', import.meta.url),
);

const url = process.env.DATABASE_URL ?? '';
const pool = createPool(url);
const prisma = createPrisma(url);
const blobs = new BlobStore({
  endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:9000',
  region: process.env.S3_REGION ?? 'us-east-1',
  bucket: process.env.S3_BUCKET ?? 'perfportal',
  accessKeyId: process.env.S3_ACCESS_KEY ?? '',
  secretAccessKey: process.env.S3_SECRET_KEY ?? '',
});
const chunks = new LiveChunkStore(blobs);

const TABLES = [
  'run_assertion', 'run_error', 'run_series_bucket', 'run_user_bucket', 'run_stat',
  'run', 'test', 'sla_rule', 'api_token', 'project', 'org',
];

let log: Buffer;

beforeAll(async () => {
  log = readFileSync(FIXTURE_LOG);
  await blobs.ensureBucket();
});

beforeEach(async () => {
  await pool.query(`TRUNCATE TABLE ${TABLES.map((t) => `"${t}"`).join(', ')} CASCADE`);
});

afterAll(async () => {
  await pool.end();
  await prisma.$disconnect();
});

async function setup() {
  const org = await prisma.org.create({ data: { slug: 'acme', name: 'Acme' } });
  const project = await prisma.project.create({
    data: { orgId: org.id, slug: 'checkout', name: 'Checkout', settings: {} },
  });
  const queue = { add: vi.fn().mockResolvedValue(undefined) };
  const notifier = { opened: vi.fn(), advanced: vi.fn(), closed: vi.fn() };
  const sink = new RunnerLiveSink({
    config: { maxLogBytes: 100_000_000 } as RunnerConfig,
    projects: new ProjectRepository(prisma),
    runs: new RunRepository(prisma),
    blobs,
    chunks,
    queue: queue as unknown as RunnerIngestQueue,
    notifier: notifier as unknown as RunnerLiveNotifier,
  });
  const now = new Date();
  const job: RunnerJobWithArtifact = {
    artifact: {
      id: '55555555-5555-4555-8555-555555555555', orgId: org.id, projectId: project.id,
      name: 'checkout load', filename: 'checkout.jar', kind: 'gatling_jar',
      simulationClass: 'example.ParitySimulation', gatlingVersion: '3.15.1',
      sha256: 'a'.repeat(64), bytes: 4096, storagePath: 'runner-artifacts/x.jar', createdAt: now,
    },
    job: {
      id: randomUUID(), orgId: org.id, projectId: project.id,
      artifactId: '55555555-5555-4555-8555-555555555555', runId: null, status: 'starting',
      requestedBy: 'tester', environment: null, branch: null, commitSha: null, testSlug: null,
      javaOptions: null, systemProperties: {}, logPath: null, error: null,
      createdAt: now, updatedAt: now,
    },
  };
  const runId = await sink.open(job);
  return { sink, queue, notifier, runId };
}

async function row(runId: string) {
  const { rows } = await pool.query<{
    status: string;
    stream_abandoned_at: Date | null;
    bundle_key: string;
    bundle_sha256: string;
    bundle_bytes: string;
  }>(
    'SELECT status, stream_abandoned_at, bundle_key, bundle_sha256, bundle_bytes FROM run WHERE id = $1',
    [runId],
  );
  return rows[0]!;
}

/** Half the reference log, which ends inside a record — what a process
 *  killed between flushes leaves behind. */
function half(): Buffer {
  return log.subarray(0, Math.floor(log.length / 2));
}

describe('RunnerLiveSink.closeAbandoned', () => {
  it('has a fixture that ends mid-record, or this proves nothing', () => {
    expect(() => [...parseSimulationLog(half())]).toThrow();
  });

  it('keeps the whole records of a run whose producer died, and hands it on as abandoned', async () => {
    const { sink, queue, notifier, runId } = await setup();
    await sink.appendAt(0, half());

    await sink.closeAbandoned();

    const r = await row(runId);
    // Claimed for work, not finalized: the pipeline still has a log to parse.
    expect(r.status).toBe('parsing');
    // WITHOUT THIS the pipeline would finish it `complete`.
    expect(r.stream_abandoned_at).not.toBeNull();
    // Cut to whole records: shorter than what was streamed, and decodable.
    const stored = await blobs.get(r.bundle_key);
    expect(stored.length).toBeGreaterThan(0);
    expect(stored.length).toBeLessThan(half().length);
    expect(() => [...parseSimulationLog(stored)]).not.toThrow();
    // The recorded hash and size describe the bytes actually stored.
    expect(Number(r.bundle_bytes)).toBe(stored.length);
    expect(r.bundle_sha256).toBe(createHash('sha256').update(stored).digest('hex'));
    expect(queue.add).toHaveBeenCalledWith(runId);
    // The fold owner drops the run's advisory lock on this before the pipeline wants it.
    expect(notifier.closed).toHaveBeenCalledWith(runId);
    expect(sink.closed).toBe(true);
  });

  it('finalizes the run incomplete, with nothing to parse, when not one whole record arrived', async () => {
    const { sink, queue, runId } = await setup();
    await sink.appendAt(0, log.subarray(0, 3));

    await sink.closeAbandoned();

    expect((await row(runId)).status).toBe('incomplete');
    expect(queue.add).not.toHaveBeenCalled();
    expect(sink.closed).toBe(true);
  });

  /** The pair: a healthy close of a whole log is NOT marked abandoned, so
   *  the pipeline still ends it `complete`. */
  it('leaves a healthy close unmarked and its log untouched', async () => {
    const { sink, runId } = await setup();
    await sink.appendAt(0, log);

    await sink.close();

    const r = await row(runId);
    expect(r.status).toBe('parsing');
    expect(r.stream_abandoned_at).toBeNull();
    expect(Number(r.bundle_bytes)).toBe(log.length);
  });
});
