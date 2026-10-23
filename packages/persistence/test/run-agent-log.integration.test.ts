import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createPool, createPrisma, RunRepository } from '../src/index.js';
import { requireDatabaseUrl, resetDatabase } from './support/db.js';

const url = requireDatabaseUrl();
const pool = createPool(url);
const prisma = createPrisma(url);

async function seedRun() {
  const org = await prisma.org.create({ data: { slug: 'acme', name: 'Acme' } });
  const project = await prisma.project.create({
    data: { orgId: org.id, slug: 'checkout', name: 'Checkout', settings: {} },
  });
  const repo = new RunRepository(prisma);
  const run = await repo.createLive({
    orgId: org.id,
    projectId: project.id,
    tool: 'gatling',
    startedAt: new Date('2026-10-23T10:00:00Z'),
    engineOptions: {},
  });
  return { repo, orgId: org.id, projectId: project.id, runId: run.id };
}

beforeEach(async () => {
  await resetDatabase(pool);
});

afterAll(async () => {
  await pool.end();
  await prisma.$disconnect();
});

/**
 * The run's AGENT FILE: the raw NDJSON the Gatling agent writes beside
 * simulation.log, stored at runs/<runId>/agent.ndjson by the on-prem runner.
 * The run records where it is, its checksum and its size — the same three
 * facts it records for its bundle — so a later reader can find the bytes and
 * prove they are the ones that were written.
 */
describe('RunRepository.recordAgentLog', () => {
  it('records the key, checksum and size, and every read returns them', async () => {
    const { repo, orgId, projectId, runId } = await seedRun();
    const sha256 = 'a'.repeat(64);
    // Above 2^31, so a column narrower than bigint (or a mapping through
    // Number that loses it) shows here rather than on the first soak run.
    const bytes = 3_000_000_000;

    await repo.recordAgentLog(runId, { key: `runs/${runId}/agent.ndjson`, sha256, bytes });

    const expected = { agentLogKey: `runs/${runId}/agent.ndjson`, agentLogSha256: sha256, agentLogBytes: bytes };
    expect(await repo.findById({ orgId, projectId }, runId)).toMatchObject(expected);
    expect(await repo.findByIdUnscoped(runId)).toMatchObject(expected);
    // The list is a hand-written SELECT; a column it forgets reads undefined.
    const listed = await repo.list({ orgId, projectId }, { limit: 10 });
    expect(listed.items.find((r) => r.id === runId)).toMatchObject(expected);
  });

  it('throws for a run that does not exist, rather than recording nothing quietly', async () => {
    const { repo } = await seedRun();
    await expect(
      repo.recordAgentLog('00000000-0000-4000-8000-000000000000', { key: 'k', sha256: 'a'.repeat(64), bytes: 1 }),
    ).rejects.toThrow();
  });

  it('answers three nulls for a run that never had one', async () => {
    const { repo, orgId, projectId, runId } = await seedRun();

    const none = { agentLogKey: null, agentLogSha256: null, agentLogBytes: null };
    expect(await repo.findById({ orgId, projectId }, runId)).toMatchObject(none);
    const listed = await repo.list({ orgId, projectId }, { limit: 10 });
    // Null, never 0: Number(null) is 0, and a zero-byte agent file is a
    // different claim from no agent file at all.
    expect(listed.items.find((r) => r.id === runId)).toMatchObject(none);
  });
});
