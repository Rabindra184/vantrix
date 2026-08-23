import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createPool, createPrisma, RunRepository } from '../src/index.js';
import { requireDatabaseUrl, resetDatabase } from './support/db.js';

const url = requireDatabaseUrl();
const pool = createPool(url);
const prisma = createPrisma(url);

async function seedProject() {
  const org = await prisma.org.create({ data: { slug: 'acme', name: 'Acme' } });
  const project = await prisma.project.create({
    data: { orgId: org.id, slug: 'checkout', name: 'Checkout', settings: {} },
  });
  return { orgId: org.id, projectId: project.id };
}

/** A non-'gatling' tool id -- if createLive ever hardcoded 'gatling' instead
 *  of threading input.tool through, every assertion below that checks
 *  run.tool would catch it. */
function liveInput(
  orgId: string,
  projectId: string,
  over: Partial<Record<string, unknown>> = {},
) {
  return {
    orgId,
    projectId,
    tool: 'k6',
    startedAt: new Date('2026-08-07T10:00:00Z'),
    engineOptions: { warmupMs: 0 },
    ...over,
  };
}

beforeEach(async () => {
  await resetDatabase(pool);
});

afterAll(async () => {
  await pool.end();
  await prisma.$disconnect();
});

describe('RunRepository live runs', () => {
  it('opens a run in running state at offset zero, with placeholder bundle columns', async () => {
    const { orgId, projectId } = await seedProject();
    const repo = new RunRepository(prisma);
    const run = await repo.createLive(liveInput(orgId, projectId));

    expect(run.status).toBe('running');
    expect(run.tool).toBe('k6'); // not hardcoded to 'gatling'
    expect(run.verdict).toBeNull();
    // Ruling 3: bundleKey/bundleSha256/bundleBytes are NON-NULL columns, so a
    // live run (no bundle yet) gets deterministic placeholders instead of a
    // nullability migration. bundleKey is what the chunks will assemble into.
    expect(run.bundleKey).toBe(`runs/${run.id}/simulation.log`);
    expect(run.bundleSha256).toBe('');
    expect(run.bundleBytes).toBe(0);

    const row = await prisma.run.findUniqueOrThrow({ where: { id: run.id } });
    expect(row.streamOffset).toBe(0n);
    // startedOn is derived from startedAt, never supplied -- confirm the
    // partition key actually reflects the UTC date rather than a caller-
    // guessed value.
    expect(row.startedOn.toISOString().slice(0, 10)).toBe(
      liveInput(orgId, projectId).startedAt.toISOString().slice(0, 10),
    );
  });

  // ═══ THE FIELD `CreateLiveRunInput` DECLARED AND `createLive` DROPPED ═══
  //
  // `declaredTestSlug` was in the input interface and absent from the
  // `prisma.run.create` data block, so every caller could pass it and none of
  // them had any effect. Three of the platform's four submit paths go through
  // here — a live open, the Gatling plugin's live mode, and the on-prem runner
  // — and all three silently fell back to grouping by simulation class, which
  // is the exact behaviour declaring a test exists to replace.
  //
  // NOTHING FAILED, and nothing could: `create` (the bundle-upload path) wrote
  // the column correctly, `resolveTestId` honours it correctly, and this file
  // is the seam between them that nobody had asserted on. A test that hands
  // the resolver a slug proves the resolver; only a test that reads the ROW
  // back proves the slug ever arrived.
  //
  // The null case is half the point rather than filler. It is what makes the
  // positive case mean "the caller's value", not "some value is present" — a
  // column defaulted to a constant would pass one of these and fail the other.
  it('stores the test the caller declared, and null when it declared none', async () => {
    const { orgId, projectId } = await seedProject();
    const repo = new RunRepository(prisma);

    const declared = await repo.createLive(
      liveInput(orgId, projectId, { declaredTestSlug: 'checkout-soak' }),
    );
    const undeclared = await repo.createLive(liveInput(orgId, projectId));

    // Read the ROW, not the returned record: the record could carry a value
    // the insert never persisted.
    const declaredRow = await prisma.run.findUniqueOrThrow({ where: { id: declared.id } });
    const undeclaredRow = await prisma.run.findUniqueOrThrow({ where: { id: undeclared.id } });
    expect(declaredRow.declaredTestSlug).toBe('checkout-soak');
    expect(undeclaredRow.declaredTestSlug).toBeNull();
  });

  it('advances the offset only from the expected position', async () => {
    const { orgId, projectId } = await seedProject();
    const repo = new RunRepository(prisma);
    const run = await repo.createLive(liveInput(orgId, projectId));

    // Advance: the expected `from` matches the row's current offset.
    expect(await repo.advanceOffset(run.id, 0, 1024)).toBe(true);
    // Replay: the same chunk claimed again finds the row already past `from`
    // -- the compare-and-set matches no row, so it must not double-count.
    expect(await repo.advanceOffset(run.id, 0, 1024)).toBe(false);
    // Gap: a chunk that assumes bytes the row never reached must be refused,
    // not accepted and silently jumped.
    expect(await repo.advanceOffset(run.id, 4096, 8192)).toBe(false);

    const row = await prisma.run.findUniqueOrThrow({ where: { id: run.id } });
    expect(row.streamOffset).toBe(1024n);
  });

  it('stamps streamUpdatedAt only when the cursor actually moves', async () => {
    // The sweeper's 'running' staleness predicate reads this column, and
    // an unmoved cursor must not refresh it: a replay proves the agent is
    // alive but not that it is making progress, and a stuck agent
    // retrying one chunk forever has to age out. A createLive that pre-set
    // it would break the COALESCE fallback the sweeper relies on for a run
    // abandoned before its first chunk, so it starts null.
    const { orgId, projectId } = await seedProject();
    const repo = new RunRepository(prisma);
    const run = await repo.createLive(liveInput(orgId, projectId));
    expect((await prisma.run.findUniqueOrThrow({ where: { id: run.id } })).streamUpdatedAt).toBeNull();

    expect(await repo.advanceOffset(run.id, 0, 1024)).toBe(true);
    const advanced = await prisma.run.findUniqueOrThrow({ where: { id: run.id } });
    expect(advanced.streamUpdatedAt).not.toBeNull();

    // A refused advance (the replay above returns false) writes no row at
    // all, so the stamp cannot move -- asserted by value, not by absence,
    // since "still not null" would pass either way.
    expect(await repo.advanceOffset(run.id, 0, 1024)).toBe(false);
    const replayed = await prisma.run.findUniqueOrThrow({ where: { id: run.id } });
    expect(replayed.streamUpdatedAt?.getTime()).toBe(advanced.streamUpdatedAt?.getTime());
  });

  it('reopening with the same idempotency key returns the same run, not a second one', async () => {
    const { orgId, projectId } = await seedProject();
    const repo = new RunRepository(prisma);
    const a = await repo.createLive(liveInput(orgId, projectId, { idempotencyKey: 'agent-run-1' }));
    const b = await repo.createLive(liveInput(orgId, projectId, { idempotencyKey: 'agent-run-1' }));

    expect(b.id).toBe(a.id);
    const rows = await prisma.run.findMany({ where: { projectId } });
    expect(rows).toHaveLength(1);
  });

  // The sequential test above cannot prove the race guard: both calls there
  // run one after the other, so the second always finds the first's row via
  // the plain findByIdempotencyKey check and never reaches create() at all.
  // Firing both requests concurrently is what can drive two callers past
  // that check before either has committed, so the loser's create() hits
  // the (projectId, idempotencyKey) unique index instead -- exactly the
  // P2002 the catch in createLive() exists to turn back into "same run".
  it('two concurrent opens with the same idempotency key still agree on one run', async () => {
    const { orgId, projectId } = await seedProject();
    const repo = new RunRepository(prisma);

    const [a, b] = await Promise.all([
      repo.createLive(liveInput(orgId, projectId, { idempotencyKey: 'concurrent-open' })),
      repo.createLive(liveInput(orgId, projectId, { idempotencyKey: 'concurrent-open' })),
    ]);

    expect(a.id).toBe(b.id);
    const rows = await prisma.run.findMany({ where: { projectId } });
    expect(rows).toHaveLength(1);
  });

  it('markIncomplete is terminal and leaves the verdict unevaluated', async () => {
    const { orgId, projectId } = await seedProject();
    const repo = new RunRepository(prisma);
    const run = await repo.createLive(liveInput(orgId, projectId));
    await repo.advanceOffset(run.id, 0, 2048);

    await repo.markIncomplete(run.id);

    const row = await prisma.run.findUniqueOrThrow({ where: { id: run.id } });
    expect(row.status).toBe('incomplete');
    expect(row.verdict).toBe('not_evaluated');
    // The byte cursor is retained, not reset -- all received data stays.
    expect(row.streamOffset).toBe(2048n);
  });

  it('markIncomplete does not resurrect an already-terminal run', async () => {
    const { orgId, projectId } = await seedProject();
    const repo = new RunRepository(prisma);
    const run = await repo.createLive(liveInput(orgId, projectId));
    await prisma.run.update({
      where: { id: run.id },
      data: { status: 'complete', verdict: 'passed' },
    });

    await repo.markIncomplete(run.id);

    const row = await prisma.run.findUniqueOrThrow({ where: { id: run.id } });
    expect(row.status).toBe('complete');
    expect(row.verdict).toBe('passed');
  });

  it('claimForClose moves running to parsing and stamps parsingStartedAt, once', async () => {
    const { orgId, projectId } = await seedProject();
    const repo = new RunRepository(prisma);
    const run = await repo.createLive(liveInput(orgId, projectId));

    expect(await repo.claimForClose(run.id)).toBe(true);
    const row = await prisma.run.findUniqueOrThrow({ where: { id: run.id } });
    expect(row.status).toBe('parsing');
    expect(row.parsingStartedAt).not.toBeNull();

    // A second claim on the same (now 'parsing') row must not match --
    // this is what makes two concurrent close() calls resolve to exactly
    // one winner.
    expect(await repo.claimForClose(run.id)).toBe(false);
  });

  it('releaseClose undoes claimForClose, and only claimForClose can then re-claim it', async () => {
    // Fix round 2, Important C: a close() that fails partway through
    // (LiveChunkStore.finalize, or the blobs.get that reads the assembly
    // back to hash it) must not strand the run at 'parsing' forever --
    // releaseClose is the mechanism LiveService.close() relies on to make
    // that failure retryable.
    const { orgId, projectId } = await seedProject();
    const repo = new RunRepository(prisma);
    const run = await repo.createLive(liveInput(orgId, projectId));
    await repo.advanceOffset(run.id, 0, 2048);

    expect(await repo.claimForClose(run.id)).toBe(true);
    await repo.releaseClose(run.id);

    const row = await prisma.run.findUniqueOrThrow({ where: { id: run.id } });
    expect(row.status).toBe('running');
    expect(row.parsingStartedAt).toBeNull();
    // The byte cursor survives the round trip untouched -- releaseClose
    // undoes the CLAIM, not the data the run already has.
    expect(row.streamOffset).toBe(2048n);

    // The actual proof of retryability: claimForClose can win again.
    expect(await repo.claimForClose(run.id)).toBe(true);
  });

  it('releaseClose cannot resurrect a run a real ingest job already decided', async () => {
    const { orgId, projectId } = await seedProject();
    const repo = new RunRepository(prisma);
    const run = await repo.createLive(liveInput(orgId, projectId));
    await repo.claimForClose(run.id);
    // A real ingest job raced in and completed the run while it was still
    // 'parsing' -- releaseClose must not undo a decision that already
    // happened through a different path.
    await prisma.run.update({
      where: { id: run.id },
      data: { status: 'complete', verdict: 'passed' },
    });

    await repo.releaseClose(run.id);

    const row = await prisma.run.findUniqueOrThrow({ where: { id: run.id } });
    expect(row.status).toBe('complete');
    expect(row.verdict).toBe('passed');
  });
});
