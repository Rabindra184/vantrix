import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, copyFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BlobStore, LiveChunkStore } from '@perfportal/storage';
import { RunRepository } from '@perfportal/persistence';
import { IngestQueue } from '../src/ingest/queue.js';
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

/**
 * close() waits up to config.defaultWaitMs (INGEST_WAIT_MS) for a terminal
 * notification before answering. Nothing drains the BullMQ queue in this
 * test process, so that wait would otherwise run out the full default
 * (25s). Shortening it here, the same env-var-plus-finally-restore
 * technique CLAUDE.md's timezone convention documents, keeps tests that
 * only need close() to have durably finalized the blob (not to have fully
 * processed) fast. INGEST_WAIT_MS is read by loadConfig() at
 * createTestApp() time, so the env var must already be set before that
 * call -- this wraps the whole body, not just the close() call.
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
    // timeout that actually succeeded. This offset is now BEHIND the
    // cursor, which is a replay, not a gap: a 202 no-op is what makes the
    // agent's own retries idempotent, and nextOffset still reports the
    // cursor the earlier chunk already advanced to.
    const replay = await stream(ctx.streamToken, opened.body.runId, 0, bytes);
    expect(replay.status).toBe(202);
    expect(replay.body.nextOffset).toBe(bytes.length);
  });

  it('a rejected gap is never written to blob storage, so it cannot corrupt the assembled log', async () => {
    await withFastCloseWait(async () => {
      ctx = await createTestApp();
      const opened = await open(ctx.streamToken);
      const runId = opened.body.runId;

      const good = Buffer.from('hello world');
      // Far ahead of the cursor (still 0) -- a genuine gap. If the chunk
      // store were written to before offset validation, this would land at
      // live/{runId}/0000000000999999.bin regardless of the 409 the caller
      // sees, and LiveChunkStore.finalize concatenates every key under the
      // prefix in sorted order with no concept of "this one was never
      // accepted" -- so it would appear in the assembled log, sorted after
      // the legitimately accepted bytes.
      const gap = await stream(ctx.streamToken, runId, 999999, Buffer.from('CORRUPTION'));
      expect(gap.status).toBe(409);

      const accepted = await stream(ctx.streamToken, runId, 0, good);
      expect(accepted.status).toBe(202);
      expect(accepted.body.nextOffset).toBe(good.length);

      await close(ctx.streamToken, runId);

      const blobs = ctx.app.get(BlobStore);
      const assembled = await blobs.get(`runs/${runId}/simulation.log`);
      expect(assembled.toString('latin1')).toBe('hello world');
    });
  });

  it('a replay with different bytes and a different length never touches the assembled log', async () => {
    await withFastCloseWait(async () => {
      ctx = await createTestApp();
      const opened = await open(ctx.streamToken);
      const runId = opened.body.runId;

      const first = await stream(ctx.streamToken, runId, 0, Buffer.from('hello '));
      expect(first.status).toBe(202);
      const second = await stream(ctx.streamToken, runId, 6, Buffer.from('world'));
      expect(second.status).toBe(202);
      expect(second.body.nextOffset).toBe(11);

      // Same offset a REAL chunk already landed at (0), but neither the
      // same bytes nor the same length -- an agent that restarted and
      // re-chunked differently, replaying a byte range the run already
      // has. If this were written (the bug this test guards against), it
      // would overwrite the real "hello " object with 32 junk bytes at the
      // same key, or -- had it declared a boundary that was never a real
      // chunk in the first place -- spliced an extra object into the
      // middle of the assembled log the same way a gap's orphan would.
      const replay = await stream(ctx.streamToken, runId, 0, Buffer.from('this replay has completely different bytes'));
      expect(replay.status).toBe(202);
      expect(replay.body.nextOffset).toBe(11);

      await close(ctx.streamToken, runId);

      const blobs = ctx.app.get(BlobStore);
      const assembled = await blobs.get(`runs/${runId}/simulation.log`);
      expect(assembled.toString('latin1')).toBe('hello world');
    });
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

  it('rejects a chunk sent under a Content-Type a body parser consumes, instead of hanging forever', async () => {
    // Nest's NestFactory.create/createNestApplication registers Express's
    // global json() and urlencoded({ extended: true }) middleware, and each
    // consumes a request whose Content-Type matches its own BEFORE any
    // handler runs. readRawBody then attaches 'data'/'end' to a stream that
    // has already ended: 'end' never fires again, the promise never settles,
    // and no response is ever written — the socket and the promise leak, per
    // request, with no timeout anywhere on this path.
    //
    // THE DEADLINE IS THE ASSERTION'S TEETH. Without one this case does not
    // fail, it hangs, and takes the file's whole 120s testTimeout with it
    // before reporting something that looks like a slow test rather than a
    // leak. Five seconds is two orders of magnitude past what a 400 costs
    // here (every other case in this file answers in well under a second).
    ctx = await createTestApp();
    const opened = await open(ctx.streamToken);

    const form = await request(ctx.app.getHttpServer())
      .post(`/v1/runs/${opened.body.runId}/stream`)
      .set('Authorization', `Bearer ${ctx.streamToken}`)
      .set('X-Stream-Offset', '0')
      .type('form')
      .send('offset=0')
      .timeout({ deadline: 5_000 });
    expect(form.status).toBe(400);
    expect(form.body.remediation).toBeTruthy();

    // application/json is the same defect through the other default parser,
    // and the likelier mistake in practice: an agent that already speaks
    // JSON to `open` reusing its own client for `stream`.
    const json = await request(ctx.app.getHttpServer())
      .post(`/v1/runs/${opened.body.runId}/stream`)
      .set('Authorization', `Bearer ${ctx.streamToken}`)
      .set('X-Stream-Offset', '0')
      .send({ bytes: 'not how this works' })
      .timeout({ deadline: 5_000 });
    expect(json.status).toBe(400);
    expect(json.body.remediation).toBeTruthy();
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

  it('rejects a single chunk larger than the PER-CHUNK limit, which is not the bundle limit', async () => {
    // MAX_STREAM_CHUNK_BYTES, and MAX_BUNDLE_BYTES left at its default on
    // purpose: this asserts the per-request cap in its own right, so the
    // case would still be honest if the cumulative check were deleted.
    // Setting MAX_BUNDLE_BYTES here instead (as this test used to) proves
    // nothing about which of the two limits fired — LiveService.stream's
    // cumulative check would reject the same body a moment later, from a
    // 413 that had already buffered every byte of it.
    //
    // Read by loadConfig() at createTestApp() time, so it has to be set
    // before that call, same as INGEST_WAIT_MS.
    const previous = process.env.MAX_STREAM_CHUNK_BYTES;
    process.env.MAX_STREAM_CHUNK_BYTES = '16';
    try {
      ctx = await createTestApp();
      const opened = await open(ctx.streamToken);

      // A single body already past the limit -- readRawBody's PER-REQUEST
      // cap is what fires here, before LiveService.stream ever sees it.
      const res = await stream(
        ctx.streamToken, opened.body.runId, 0,
        Buffer.from('this is way more than sixteen bytes'),
      );
      expect(res.status).toBe(413);
      expect(res.body.remediation).toBeTruthy();
      // Names the per-chunk limit, not the run's total: the two 413s are
      // otherwise indistinguishable to an agent deciding whether to
      // re-chunk (fixable) or give up on the run (not).
      expect(res.body.detail).toContain('per-chunk');
    } finally {
      if (previous === undefined) delete process.env.MAX_STREAM_CHUNK_BYTES;
      else process.env.MAX_STREAM_CHUNK_BYTES = previous;
    }
  });

  it('does not buffer a whole bundle-sized body for one chunk: the per-chunk default is far below it', async () => {
    // The defect this pins is invisible from the outside — an oversized
    // chunk 413s either way — so assert the CONFIGURED NUMBERS instead.
    // readRawBody buffers a chunk in memory before LiveService.stream can
    // judge its offset, so a per-chunk cap equal to maxBundleBytes let one
    // in-flight request pin 512 MB, and N requests N × that, even for a
    // chunk about to be refused as a gap.
    const { loadConfig } = await import('../src/config.js');
    const config = loadConfig({ DATABASE_URL: 'postgresql://unused/unused' });
    expect(config.maxStreamChunkBytes).toBeLessThan(config.maxBundleBytes);
    // Comfortably above the 64 KiB this file itself streams at, so the cap
    // bounds memory without ever constraining a real agent.
    expect(config.maxStreamChunkBytes).toBeGreaterThan(CHUNK_BYTES * 16);
  });

  it("rejects a chunk that would push the run's cumulative total past the configured size limit", async () => {
    // Two chunks, each individually well under the 16-byte cap, so
    // readRawBody's per-request check never fires -- only
    // LiveService.stream's cumulative (offset + bytes.length) check can
    // reject the second one.
    const previous = process.env.MAX_BUNDLE_BYTES;
    process.env.MAX_BUNDLE_BYTES = '16';
    try {
      ctx = await createTestApp();
      const opened = await open(ctx.streamToken);
      const runId = opened.body.runId;

      const first = await stream(ctx.streamToken, runId, 0, Buffer.from('0123456789'));
      expect(first.status).toBe(202);
      expect(first.body.nextOffset).toBe(10);

      const second = await stream(ctx.streamToken, runId, 10, Buffer.from('0123456789'));
      expect(second.status).toBe(413);
      expect(second.body.remediation).toBeTruthy();
    } finally {
      if (previous === undefined) delete process.env.MAX_BUNDLE_BYTES;
      else process.env.MAX_BUNDLE_BYTES = previous;
    }
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

  it('a close() that fails BEFORE finalizeLive leaves the run retryable, not stranded at "parsing"', async () => {
    await withFastCloseWait(async () => {
      ctx = await createTestApp();
      const opened = await open(ctx.streamToken);
      const runId = opened.body.runId;

      // Real fixture bytes, not placeholder text: the end of this test
      // drives the run all the way to 'complete' through the real
      // PipelineService, which a made-up byte string could never do (it
      // would fail to parse and land on 'failed' instead, muddying what
      // this test is actually trying to show).
      const buf = readFileSync(LOG);
      const accepted = await stream(ctx.streamToken, runId, 0, buf);
      expect(accepted.status).toBe(202);

      const blobs = ctx.app.get(BlobStore);
      const chunks = ctx.app.get(LiveChunkStore);
      // Simulate a transient object-store failure: the chunk this run's
      // only byte range lives at disappears before close() runs.
      // LiveChunkStore.finalize then finds nothing under the run's prefix
      // -- a legitimate no-op by its own contract, since it cannot tell
      // that from "never received a byte" -- so bundleKey is never
      // written, and the SUBSEQUENT blobs.get(bundleKey) throws (no such
      // key). Neither is an IngestError, so this reaches ProblemFilter's
      // generic catch-all: 500, with the generic-but-still-required
      // "remediation".
      await blobs.delete(`live/${runId}/0000000000000000.bin`);

      const failed = await close(ctx.streamToken, runId);
      expect(failed.status).toBe(500);
      expect(failed.body.remediation).toBeTruthy();

      // Not stranded: a GET shows the run reverted to 'running' (202,
      // exactly like it was before this close() attempt), not stuck at
      // 'parsing' with an empty bundleSha256 forever.
      const afterFailure = await request(ctx.app.getHttpServer())
        .get(`/v1/runs/${runId}`)
        .set('Authorization', `Bearer ${ctx.readToken}`);
      expect(afterFailure.status).toBe(202);
      expect(afterFailure.body.status).toBe('running');

      // Prove the retry can actually SUCCEED, not merely be attempted:
      // restore the "transiently unavailable" chunk (what a real transient
      // object-store failure would look like once it resolves), then close
      // again.
      await chunks.put(runId, 0, buf);
      const retried = await close(ctx.streamToken, runId);
      expect(retried.status).not.toBe(409);
      expect(retried.status).not.toBe(500);

      await runPipelineFor(ctx, runId);
      const finalRun = await request(ctx.app.getHttpServer())
        .get(`/v1/runs/${runId}`)
        .set('Authorization', `Bearer ${ctx.readToken}`);
      expect(finalRun.body.status).toBe('complete');
    });
  });

  it('a close() that fails only at the ENQUEUE stays at "parsing" — the release would lose bytes', async () => {
    await withFastCloseWait(async () => {
      ctx = await createTestApp();
      const opened = await open(ctx.streamToken);
      const runId = opened.body.runId;

      const buf = readFileSync(LOG);
      expect((await stream(ctx.streamToken, runId, 0, buf)).status).toBe(202);

      // Redis down at exactly the wrong moment: every durable step of
      // close() has already committed (the chunks are assembled into
      // bundleKey, the assembly is hashed, bundleSha256/bundleBytes are
      // written, and the per-chunk objects are deleted) and only the
      // enqueue fails. Reverting to 'running' here -- which is what one
      // try/catch spanning all four steps did -- is not a retry, it is
      // data loss: with the chunks gone and the status back to 'running',
      // advanceOffset accepts further bytes that finalize's own
      // exists(key) guard will then refuse to re-assemble, so the retried
      // close hashes the stale bundle and bundleBytes disagrees with
      // stream_offset. Nothing sweeps 'running' back out either, so an
      // agent that has already exited leaves the run stuck forever.
      const queue = ctx.app.get(IngestQueue);
      vi.spyOn(queue, 'add').mockRejectedValueOnce(new Error('redis is unreachable'));

      const failed = await close(ctx.streamToken, runId);
      expect(failed.status).toBe(500);
      expect(failed.body.remediation).toBeTruthy();

      // Still 'parsing' -- NOT reverted. This is the whole assertion.
      const afterFailure = await request(ctx.app.getHttpServer())
        .get(`/v1/runs/${runId}`)
        .set('Authorization', `Bearer ${ctx.readToken}`);
      expect(afterFailure.status).toBe(202);
      expect(afterFailure.body.status).toBe('parsing');

      // And the run is genuinely finished, not merely parked: the bundle
      // it will be parsed from is committed, and parsing_started_at is set
      // so the sweeper measures this run's 'parsing' age from the claim
      // rather than from its (far older) open time.
      const row = await ctx.prisma.run.findUniqueOrThrow({ where: { id: runId } });
      expect(row.bundleSha256).toHaveLength(64);
      expect(Number(row.bundleBytes)).toBe(buf.length);
      expect(row.parsingStartedAt).not.toBeNull();

      // Recovery is the sweeper's 'parsing' path re-enqueueing this run,
      // and there is nothing left for it to do but run the pipeline --
      // proven by running it directly, with no second close() involved.
      await runPipelineFor(ctx, runId);
      const finalRun = await request(ctx.app.getHttpServer())
        .get(`/v1/runs/${runId}`)
        .set('Authorization', `Bearer ${ctx.readToken}`);
      expect(finalRun.body.status).toBe('complete');
    });
  });

  it('a failing releaseClose does not replace the error that caused it', async () => {
    await withFastCloseWait(async () => {
      ctx = await createTestApp();
      const opened = await open(ctx.streamToken);
      const runId = opened.body.runId;
      expect((await stream(ctx.streamToken, runId, 0, readFileSync(LOG))).status).toBe(202);

      // Both halves of the recovery path fail: the object store first
      // (the real failure), then the compensating write. An unguarded
      // `await this.runs.releaseClose(runId)` inside the catch replaces
      // the original rejection with its own, and the run is left at
      // 'parsing' either way -- so the ONLY thing that changes is what the
      // operator is told went wrong. That makes the log the surface to
      // assert on, not the response: ProblemFilter's generic 500 body is
      // deliberately identical for both (internalProblem leaks no
      // message), and only logInternalError carries the distinction.
      const blobs = ctx.app.get(BlobStore);
      await blobs.delete(`live/${runId}/0000000000000000.bin`);
      const runs = ctx.app.get(RunRepository);
      vi.spyOn(runs, 'releaseClose').mockRejectedValueOnce(new Error('the compensating write also failed'));
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

      try {
        const failed = await close(ctx.streamToken, runId);
        expect(failed.status).toBe(500);
        expect(failed.body.remediation).toBeTruthy();

        const unhandled = logged.mock.calls.filter((c) => c[0] === 'unhandled');
        expect(unhandled).toHaveLength(1);
        // The object store is what actually broke. Reporting the
        // compensating write instead sends triage at the database.
        expect(String(unhandled[0]?.[2])).not.toContain('the compensating write also failed');
      } finally {
        logged.mockRestore();
      }
    });
  });

  it('a streamed run finalizes to the same figures as an uploaded one', async () => {
    await withFastCloseWait(async () => {
      ctx = await createTestApp();
      const buf = readFileSync(LOG);

      // The live path: open, stream the whole fixture in 64 KB chunks, close.
      const opened = await open(ctx.streamToken);
      expect(opened.status).toBe(201);
      const liveRunId = opened.body.runId;

      let offset = 0;
      while (offset < buf.length) {
        const n = Math.min(CHUNK_BYTES, buf.length - offset);
        const res = await stream(ctx.streamToken, liveRunId, offset, buf.subarray(offset, offset + n));
        expect(res.status).toBe(202);
        offset = res.body.nextOffset;
      }
      expect(offset).toBe(buf.length);

      await close(ctx.streamToken, liveRunId);
      // The real finalization: constructs a PipelineService and processes
      // the run synchronously, exactly like every other integration suite
      // that needs a completed run without a live worker (support/pipeline.ts).
      await runPipelineFor(ctx, liveRunId);

      // The SAME fixture, through the ordinary bundle-upload path, so the
      // claim in this test's title is actually checked against a second,
      // independent run rather than merely asserted plausible of the live
      // one alone. Nothing here is hardcoded: both sides are read back from
      // whatever the two pipelines actually produced.
      const dir = mkdtempSync(join(tmpdir(), 'live-parity-'));
      const resultsDir = join(dir, 'uploaded-run');
      mkdirSync(resultsDir, { recursive: true });
      copyFileSync(LOG, join(resultsDir, 'simulation.log'));
      const tarball = join(dir, 'bundle.tgz');
      execFileSync('tar', ['-czf', tarball, '-C', dir, 'uploaded-run']);

      const uploaded = await request(ctx.app.getHttpServer())
        .post('/v1/runs')
        .set('Authorization', `Bearer ${ctx.ingestToken}`)
        .field('metadata', JSON.stringify({ tool: 'gatling', waitMs: 0 }))
        .attach('bundle', readFileSync(tarball), 'bundle.tgz');
      await runPipelineFor(ctx, uploaded.body.id);

      const [liveStats, uploadedStats] = await Promise.all([
        request(ctx.app.getHttpServer())
          .get(`/v1/runs/${liveRunId}/stats`)
          .set('Authorization', `Bearer ${ctx.readToken}`),
        request(ctx.app.getHttpServer())
          .get(`/v1/runs/${uploaded.body.id}/stats`)
          .set('Authorization', `Bearer ${ctx.readToken}`),
      ]);
      expect(liveStats.status).toBe(200);
      expect(uploadedStats.status).toBe(200);

      type Row = { scope: string; family: string; count: number; okCount: number; koCount: number; meanMs: number; minMs: number; maxMs: number };
      const liveRow = (liveStats.body.stats as Row[]).find((s) => s.scope === 'run' && s.family === 'response_time');
      const uploadedRow = (uploadedStats.body.stats as Row[]).find((s) => s.scope === 'run' && s.family === 'response_time');

      expect(liveRow?.count).toBeGreaterThan(0);
      expect(liveRow?.count).toBe(uploadedRow?.count);
      expect(liveRow?.okCount).toBe(uploadedRow?.okCount);
      expect(liveRow?.koCount).toBe(uploadedRow?.koCount);
      expect((liveRow?.okCount ?? 0) + (liveRow?.koCount ?? 0)).toBe(liveRow?.count);
      expect(liveRow?.minMs).toBe(uploadedRow?.minMs);
      expect(liveRow?.maxMs).toBe(uploadedRow?.maxMs);
      expect(liveRow?.meanMs).toBeCloseTo(uploadedRow?.meanMs ?? NaN, 6);

      const [liveRun, uploadedRun] = await Promise.all([
        request(ctx.app.getHttpServer()).get(`/v1/runs/${liveRunId}`).set('Authorization', `Bearer ${ctx.readToken}`),
        request(ctx.app.getHttpServer()).get(`/v1/runs/${uploaded.body.id}`).set('Authorization', `Bearer ${ctx.readToken}`),
      ]);
      expect(liveRun.body.status).toBe('complete');
      expect(liveRun.body.durationMs).toBe(uploadedRun.body.durationMs);
    });
  });
});
