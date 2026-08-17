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

  it('reopening with the same idempotency key returns the same run, not a second one', async () => {
    const { orgId, projectId } = await seedProject();
    const repo = new RunRepository(prisma);
    const a = await repo.createLive(liveInput(orgId, projectId, { idempotencyKey: 'agent-run-1' }));
    const b = await repo.createLive(liveInput(orgId, projectId, { idempotencyKey: 'agent-run-1' }));

    expect(b.id).toBe(a.id);
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
});
