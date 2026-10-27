import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Agent, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { hashToken, mintToken } from '@perfportal/core';
import { BlobStore } from '@perfportal/storage';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { CONFIG } from '../src/auth/auth.module.js';
import { loadConfig } from '../src/config.js';
import { createTestApp, type TestContext } from './support/app.js';
import { runPipelineFor } from './support/pipeline.js';

/**
 * ═══ PUT /v1/runs/{id}/agent: A LIVE RUN'S AGENT FILE, FROM THE GRADLE PLUGIN ═══
 *
 * The on-prem runner stores the Gatling agent's file itself, at
 * `runs/<runId>/agent.ndjson`, before it closes the run. A Gradle-plugin run
 * streams its log over the bearer `stream` routes and has no such writer, so
 * this route is the API-side equivalent: the plugin PUTs the file once, after
 * the simulation's JVM exits and before it closes. Every assertion reads the
 * ROW and the STORED OBJECT back, because a 204 alone says nothing about
 * where the bytes went.
 */

const FIXTURE_DIR = fileURLToPath(new URL('../../../fixtures/gatling-3.15.1.2/agent-run/', import.meta.url));
const AGENT = readFileSync(`${FIXTURE_DIR}agent.ndjson`);
const LOG = readFileSync(`${FIXTURE_DIR}simulation.log`);
const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

let ctx: TestContext;
const server = () => request(ctx.app.getHttpServer());

function open(token: string) {
  return server().post('/v1/runs/live').set('Authorization', `Bearer ${token}`).send({ tool: 'gatling' });
}

function putAgent(token: string, runId: string, body: Buffer) {
  return server()
    .put(`/v1/runs/${runId}/agent`)
    .set('Authorization', `Bearer ${token}`)
    .set('Content-Type', 'application/x-ndjson')
    .send(body)
    .timeout({ deadline: 15_000, response: 15_000 });
}

async function openRun(token: string): Promise<string> {
  const res = await open(token);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.runId as string;
}

async function agentRow(runId: string) {
  return ctx.prisma.run.findUniqueOrThrow({
    where: { id: runId },
    select: { agentLogKey: true, agentLogSha256: true, agentLogBytes: true },
  });
}

/** A stream-scoped bearer token for a SECOND project in the same org. */
async function otherProjectStreamToken(): Promise<string> {
  const project = await ctx.prisma.project.create({
    data: { orgId: ctx.orgId, slug: `other-${randomUUID().slice(0, 8)}`, name: 'Other', settings: {} },
  });
  const minted = mintToken();
  await ctx.prisma.apiToken.create({
    data: {
      orgId: ctx.orgId, projectId: project.id, name: 'other-streamer',
      prefix: minted.prefix, tokenHash: await hashToken(minted.token.split('_')[2] ?? ''),
      scopes: ['stream'],
    },
  });
  return minted.token;
}

const blobs = () => new BlobStore(loadConfig().blob);

/**
 * close() waits INGEST_WAIT_MS for a verdict nothing in this process will
 * produce; read once when createTestApp loads the config, as
 * live.integration.test.ts does.
 */
async function withFastCloseWait<T>(run: () => Promise<T>): Promise<T> {
  const previous = process.env.INGEST_WAIT_MS;
  process.env.INGEST_WAIT_MS = '50';
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.INGEST_WAIT_MS;
    else process.env.INGEST_WAIT_MS = previous;
  }
}

describe('PUT /v1/runs/{id}/agent', () => {
  beforeAll(async () => {
    ctx = await withFastCloseWait(() => createTestApp());
  });

  afterAll(async () => {
    await ctx?.close();
  });

  it('stores the agent file at the runner’s key and records its sha256 and size on the run', async () => {
    const runId = await openRun(ctx.streamToken);

    const res = await putAgent(ctx.streamToken, runId, AGENT);
    expect(res.status, JSON.stringify(res.body)).toBe(204);

    const row = await agentRow(runId);
    expect(row.agentLogKey).toBe(`runs/${runId}/agent.ndjson`);
    expect(Number(row.agentLogBytes)).toBe(AGENT.length);
    expect(row.agentLogSha256).toBe(sha256(AGENT));
    expect((await blobs().get(`runs/${runId}/agent.ndjson`)).equals(AGENT)).toBe(true);
  });

  it('replaces the object and the row on a second PUT before close', async () => {
    const runId = await openRun(ctx.streamToken);
    expect((await putAgent(ctx.streamToken, runId, AGENT)).status).toBe(204);

    const second = AGENT.subarray(0, AGENT.indexOf(0x0a) + 1);
    const res = await putAgent(ctx.streamToken, runId, Buffer.from(second));
    expect(res.status, JSON.stringify(res.body)).toBe(204);

    const row = await agentRow(runId);
    expect(Number(row.agentLogBytes)).toBe(second.length);
    expect(row.agentLogSha256).toBe(sha256(Buffer.from(second)));
    expect((await blobs().get(`runs/${runId}/agent.ndjson`)).equals(Buffer.from(second))).toBe(true);
  });

  it('answers 409 RUN_NOT_RUNNING once the run is closed, and records nothing', async () => {
    const runId = await openRun(ctx.streamToken);
    const closed = await server().post(`/v1/runs/${runId}/close`).set('Authorization', `Bearer ${ctx.streamToken}`);
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);

    const res = await putAgent(ctx.streamToken, runId, AGENT);
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.code).toBe('RUN_NOT_RUNNING');
    expect(res.body.remediation).toBeTruthy();
    expect((await agentRow(runId)).agentLogKey).toBeNull();
  });

  // A token of another project must not reach this run at all — not its row,
  // and not its object either: the key is the run's own, so writing it would
  // overwrite a file the run's owner stored.
  it('answers 404 for another project’s run, and writes neither its row nor its object', async () => {
    const runId = await openRun(ctx.streamToken);
    const other = await otherProjectStreamToken();

    const res = await putAgent(other, runId, AGENT);
    expect(res.status, JSON.stringify(res.body)).toBe(404);
    expect(res.body.detail).toBe(`No run ${runId} in this project.`);
    expect((await agentRow(runId)).agentLogKey).toBeNull();
    expect(await blobs().exists(`runs/${runId}/agent.ndjson`)).toBe(false);
  });

  it('answers 404 for a run that does not exist', async () => {
    const res = await putAgent(ctx.streamToken, randomUUID(), AGENT);
    expect(res.status, JSON.stringify(res.body)).toBe(404);
  });

  it('answers 400 INVALID_ID for a malformed run id', async () => {
    const res = await putAgent(ctx.streamToken, 'not-a-uuid', AGENT);
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body.code).toBe('INVALID_ID');
  });

  it('answers 400 AGENT_LOG_EMPTY for an empty body', async () => {
    const runId = await openRun(ctx.streamToken);
    const res = await putAgent(ctx.streamToken, runId, Buffer.alloc(0));
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body.code).toBe('AGENT_LOG_EMPTY');
    expect(res.body.remediation).toBeTruthy();
    expect((await agentRow(runId)).agentLogKey).toBeNull();
  });

  it('refuses a body a parser already drained, naming the agent file and not a package', async () => {
    const runId = await openRun(ctx.streamToken);
    const res = await server()
      .put(`/v1/runs/${runId}/agent`)
      .set('Authorization', `Bearer ${ctx.streamToken}`)
      .send({ not: 'ndjson' })
      .timeout({ deadline: 5_000 });
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body.code).toBe('STREAM_BODY_CONSUMED');
    expect(res.body.detail).toMatch(/agent file/);
    expect(res.body.detail).not.toMatch(/package/);
    expect(res.body.remediation).toMatch(/application\/x-ndjson/);
  });

  it('gives a streamed run the agent figures once it is closed and processed', async () => {
    const runId = await openRun(ctx.streamToken);
    const streamed = await server()
      .post(`/v1/runs/${runId}/stream`)
      .set('Authorization', `Bearer ${ctx.streamToken}`)
      .set('Content-Type', 'application/octet-stream')
      .set('X-Stream-Offset', '0')
      .send(LOG);
    expect(streamed.status, JSON.stringify(streamed.body)).toBe(202);
    expect(streamed.body.nextOffset).toBe(LOG.length);

    expect((await putAgent(ctx.streamToken, runId, AGENT)).status).toBe(204);

    const closed = await server().post(`/v1/runs/${runId}/close`).set('Authorization', `Bearer ${ctx.streamToken}`);
    expect([200, 202]).toContain(closed.status);
    await runPipelineFor(ctx, runId);

    const run = await server().get(`/v1/runs/${runId}`).set('Authorization', `Bearer ${ctx.readToken}`);
    expect(run.body.status, JSON.stringify(run.body)).toBe('complete');

    const agent = await server().get(`/v1/runs/${runId}/agent`).set('Authorization', `Bearer ${ctx.readToken}`);
    expect(agent.status, JSON.stringify(agent.body)).toBe(200);
    expect(agent.body.available).toBe(true);
    expect(agent.body.header.host).toBe('loadgen-1');
  });
});

/**
 * A chunked PUT (no Content-Length) over a socket this helper opens, so the
 * cap can only be judged mid-stream. Rejects on a reset: the 413 has to reach
 * the client.
 */
function chunkedPut(token: string, runId: string, chunks: readonly Buffer[]): Promise<{ status: number; body: { code?: string; remediation?: string } }> {
  return new Promise((resolve, reject) => {
    const { port } = (ctx.app.getHttpServer() as Server).address() as AddressInfo;
    const agent = new Agent({ keepAlive: true });
    const deadline = setTimeout(() => {
      agent.destroy();
      reject(new Error('no response within 5s'));
    }, 5_000);
    const req = httpRequest(
      {
        host: '127.0.0.1', port, method: 'PUT', path: `/v1/runs/${runId}/agent`, agent,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-ndjson' },
      },
      (res) => {
        const parts: Buffer[] = [];
        res.on('data', (p: Buffer) => parts.push(p));
        res.on('end', () => {
          clearTimeout(deadline);
          agent.destroy();
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(parts).toString('utf8') || '{}') });
        });
      },
    );
    req.on('error', (err) => {
      clearTimeout(deadline);
      agent.destroy();
      reject(err);
    });
    for (const c of chunks) req.write(c);
    req.end();
  });
}

describe('PUT /v1/runs/{id}/agent over the agent cap', () => {
  const CAP = 2048;

  afterEach(async () => {
    await ctx?.close();
  });

  async function capped(): Promise<void> {
    ctx = await createTestApp({}, [], [{ provide: CONFIG, useValue: { ...loadConfig(), maxAgentLogBytes: CAP } }]);
  }

  it('answers 413 AGENT_LOG_TOO_LARGE for a declared Content-Length over the cap, naming the setting', async () => {
    await capped();
    const runId = await openRun(ctx.streamToken);
    const res = await putAgent(ctx.streamToken, runId, Buffer.alloc(4096, 0x61));
    expect(res.status, JSON.stringify(res.body)).toBe(413);
    expect(res.body.code).toBe('AGENT_LOG_TOO_LARGE');
    expect(res.body.remediation).toMatch(/MAX_AGENT_LOG_BYTES/);
    expect((await agentRow(runId)).agentLogKey).toBeNull();
  });

  it('answers 413 AGENT_LOG_TOO_LARGE, not a reset, for a chunked body that crosses the cap', async () => {
    await capped();
    const runId = await openRun(ctx.streamToken);
    const res = await chunkedPut(ctx.streamToken, runId, Array.from({ length: 4 }, () => Buffer.alloc(1024, 0x61)));
    expect(res.status, JSON.stringify(res.body)).toBe(413);
    expect(res.body.code).toBe('AGENT_LOG_TOO_LARGE');
    expect((await agentRow(runId)).agentLogKey).toBeNull();
  });
});
