import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestContext } from './support/app.js';
import { runPipelineFor } from './support/pipeline.js';

// Matches the fixture path parity.e2e.test.ts and ingest.integration.test.ts
// already use for this file.
const LOG = fileURLToPath(
  new URL('../../../fixtures/gatling-3.15.1.2/reference-report/simulation.log', import.meta.url),
);

const CHUNK_BYTES = 64 * 1024;

let ctx: TestContext;

afterEach(async () => {
  await ctx?.close();
});

function open(token: string, body: Record<string, unknown> = { tool: 'gatling' }) {
  return request(ctx.app.getHttpServer())
    .post('/v1/runs/live')
    .set('Authorization', `Bearer ${token}`)
    .send(body);
}

function stream(token: string, runId: string, offset: number, bytes: Buffer) {
  return request(ctx.app.getHttpServer())
    .post(`/v1/runs/${runId}/stream`)
    .set('Authorization', `Bearer ${token}`)
    .set('Content-Type', 'application/octet-stream')
    .set('X-Stream-Offset', String(offset))
    .send(bytes);
}

function close(token: string, runId: string) {
  return request(ctx.app.getHttpServer())
    .post(`/v1/runs/${runId}/close`)
    .set('Authorization', `Bearer ${token}`);
}

describe('live streaming', () => {
  it('rejects a token without the stream scope', async () => {
    ctx = await createTestApp();

    const res = await open(ctx.ingestToken);
    expect(res.status).toBe(403);
    expect(res.body.remediation).toBeTruthy();
  });

  it('opens at offset zero and reports where to stream', async () => {
    ctx = await createTestApp();

    const res = await open(ctx.streamToken, {
      tool: 'gatling', environment: 'staging', branch: 'main',
    });
    expect(res.status).toBe(201);
    expect(res.body.nextOffset).toBe(0);
    expect(res.body.streamUrl).toContain(res.body.runId);
  });

  it('refuses a gap and names the offset to resume from', async () => {
    ctx = await createTestApp();
    const opened = await open(ctx.streamToken);

    const res = await stream(ctx.streamToken, opened.body.runId, 4096, Buffer.from('nonsense'));
    expect(res.status).toBe(409);
    expect(res.body.nextOffset).toBe(0);
    expect(res.body.remediation).toBeTruthy();
  });

  it('accepts a chunk at the expected offset and reports the next one', async () => {
    ctx = await createTestApp();
    const opened = await open(ctx.streamToken);
    const bytes = Buffer.from('some bytes of a simulation.log');

    const res = await stream(ctx.streamToken, opened.body.runId, 0, bytes);
    expect(res.status).toBe(202);
    expect(res.body.nextOffset).toBe(bytes.length);
  });

  it('treats a replayed (behind-the-cursor) chunk as a no-op 202, not an error', async () => {
    ctx = await createTestApp();
    const opened = await open(ctx.streamToken);
    const bytes = Buffer.from('some bytes of a simulation.log');
    const first = await stream(ctx.streamToken, opened.body.runId, 0, bytes);
    expect(first.status).toBe(202);

    // Same chunk, same offset, sent again -- e.g. the agent retried after a
    // timeout that actually succeeded. advanceOffset's CAS no longer
    // matches (the cursor already moved), so this is the identical 409 a
    // genuine gap gets -- the caller cannot tell the two apart, and does
    // not need to: "resume from nextOffset" is the same instruction either
    // way, and nextOffset here already reflects the earlier chunk landing.
    const replay = await stream(ctx.streamToken, opened.body.runId, 0, bytes);
    expect(replay.status).toBe(409);
    expect(replay.body.nextOffset).toBe(bytes.length);
  });

  it('404s a stream chunk for a run that does not exist', async () => {
    ctx = await createTestApp();
    const res = await stream(ctx.streamToken, randomUUID(), 0, Buffer.from('x'));
    expect(res.status).toBe(404);
  });

  it('rejects a stream chunk with no X-Stream-Offset header, before touching the run', async () => {
    ctx = await createTestApp();
    const opened = await open(ctx.streamToken);

    const res = await request(ctx.app.getHttpServer())
      .post(`/v1/runs/${opened.body.runId}/stream`)
      .set('Authorization', `Bearer ${ctx.streamToken}`)
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from('x'));
    expect(res.status).toBe(400);
    expect(res.body.remediation).toBeTruthy();
  });

  it('rejects a non-numeric X-Stream-Offset header', async () => {
    ctx = await createTestApp();
    const opened = await open(ctx.streamToken);

    const res = await request(ctx.app.getHttpServer())
      .post(`/v1/runs/${opened.body.runId}/stream`)
      .set('Authorization', `Bearer ${ctx.streamToken}`)
      .set('Content-Type', 'application/octet-stream')
      .set('X-Stream-Offset', 'not-a-number')
      .send(Buffer.from('x'));
    expect(res.status).toBe(400);
    expect(res.body.remediation).toBeTruthy();
  });

  it('rejects opening a run with no "tool"', async () => {
    ctx = await createTestApp();
    const res = await open(ctx.streamToken, { environment: 'staging' });
    expect(res.status).toBe(400);
    expect(res.body.remediation).toBeTruthy();
  });

  it('404s a close for a run that does not exist', async () => {
    ctx = await createTestApp();
    const res = await close(ctx.streamToken, randomUUID());
    expect(res.status).toBe(404);
  });

  it('closes a run that received no bytes as incomplete, not failed or still-processing', async () => {
    ctx = await createTestApp();
    const opened = await open(ctx.streamToken);

    const res = await close(ctx.streamToken, opened.body.runId);
    // Design §1.2 / RunRepository.markIncomplete: a zero-byte close never
    // enqueues, so this returns immediately with no wait — the assertion
    // that follows is on the SAME response, not a later poll.
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('incomplete');
    expect(res.body.verdict).toBe('not_evaluated');

    // Verifies RunsService.statusFor's fix directly: GET must report the
    // identical 200/incomplete/not_evaluated the close response itself did
    // — "the same code for the same state" via respondWithRun, exercised a
    // second time through the read path rather than trusting one response.
    const got = await request(ctx.app.getHttpServer())
      .get(`/v1/runs/${opened.body.runId}`)
      .set('Authorization', `Bearer ${ctx.readToken}`);
    expect(got.status).toBe(200);
    expect(got.body.status).toBe('incomplete');
    expect(got.body.verdict).toBe('not_evaluated');
  });

  it('refuses to close a run twice — the second close 409s, not-running', async () => {
    ctx = await createTestApp();
    const opened = await open(ctx.streamToken);
    const first = await close(ctx.streamToken, opened.body.runId);
    expect(first.status).toBe(200);

    const second = await close(ctx.streamToken, opened.body.runId);
    expect(second.status).toBe(409);
    expect(second.body.remediation).toBeTruthy();
  });

  it('refuses to stream into a run after it has closed', async () => {
    ctx = await createTestApp();
    const opened = await open(ctx.streamToken);
    await close(ctx.streamToken, opened.body.runId);

    const res = await stream(ctx.streamToken, opened.body.runId, 0, Buffer.from('too late'));
    expect(res.status).toBe(409);
  });

  it('a streamed run finalizes to the same figures as an uploaded one', async () => {
    // close() waits up to config.defaultWaitMs (INGEST_WAIT_MS) for a
    // terminal notification before answering — exactly what
    // IngestController.post does for a bundle upload. Nothing drains the
    // BullMQ queue in this test process (Global Constraint #4), so that
    // wait would otherwise always run out the full default (25s) before
    // falling back to its own re-read. Shortening it here, the same
    // env-var-plus-finally-restore technique CLAUDE.md's timezone
    // convention already documents, keeps this test's own answer fast;
    // the REAL answer comes from runPipelineFor below regardless of what
    // close() itself reported, exactly like read.integration.test.ts's
    // ingested() helper (metadata.waitMs: 0, then runPipelineFor) does for
    // the upload path. Integration files share one worker process
    // (fileParallelism: false), so the restore in `finally` matters here
    // for the same reason it does there.
    const previousWaitMs = process.env.INGEST_WAIT_MS;
    process.env.INGEST_WAIT_MS = '50';
    try {
      ctx = await createTestApp();
      const buf = readFileSync(LOG);

      const opened = await open(ctx.streamToken);
      expect(opened.status).toBe(201);
      const runId = opened.body.runId;

      let offset = 0;
      while (offset < buf.length) {
        const n = Math.min(CHUNK_BYTES, buf.length - offset);
        const res = await stream(ctx.streamToken, runId, offset, buf.subarray(offset, offset + n));
        expect(res.status).toBe(202);
        offset = res.body.nextOffset;
      }
      expect(offset).toBe(buf.length);

      await close(ctx.streamToken, runId);
      // The real finalization: constructs a PipelineService and processes
      // the run synchronously, exactly like every other integration suite
      // that needs a completed run without a live worker (support/pipeline.ts).
      await runPipelineFor(ctx, runId);

      const run = await request(ctx.app.getHttpServer())
        .get(`/v1/runs/${runId}`)
        .set('Authorization', `Bearer ${ctx.readToken}`);
      expect(run.status).toBe(200);
      expect(run.body.status).toBe('complete');
      // Same figures an uploaded bundle of this exact fixture produces
      // (parity.e2e.test.ts, pipeline.integration.test.ts) — derived from
      // the response, never written down here.
      expect(run.body.durationMs).toBeGreaterThan(0);

      const stats = await request(ctx.app.getHttpServer())
        .get(`/v1/runs/${runId}/stats`)
        .set('Authorization', `Bearer ${ctx.readToken}`);
      expect(stats.status).toBe(200);
      const runRow = (stats.body.stats as { scope: string; family: string; count: number; okCount: number; koCount: number }[])
        .find((s) => s.scope === 'run' && s.family === 'response_time');
      expect(runRow?.count).toBeGreaterThan(0);
      expect((runRow?.okCount ?? 0) + (runRow?.koCount ?? 0)).toBe(runRow?.count);
    } finally {
      if (previousWaitMs === undefined) delete process.env.INGEST_WAIT_MS;
      else process.env.INGEST_WAIT_MS = previousWaitMs;
    }
  });
});
