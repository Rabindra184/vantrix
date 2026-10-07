import type { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { RunRepository } from '../src/repositories/run.js';

const ORG = '00000000-0000-4000-8000-0000000000aa';
const RUN = '3fa85f64-5717-4562-b3fc-2c963f66afa6';

/**
 * A client that fails the test on ANY use. Not a `findFirst` that returns
 * null: "no query" has to mean no query at all, and a stub that answered
 * would let a call through as long as its answer was null.
 */
function untouchable(): PrismaClient {
  return new Proxy({} as PrismaClient, {
    get(_target, prop) {
      throw new Error(`projectIdOf reached the database (prisma.${String(prop)})`);
    },
  });
}

function answering(projectId: string | null) {
  const findFirst = vi.fn(async () => (projectId === null ? null : { projectId }));
  return { findFirst, repo: new RunRepository({ run: { findFirst } } as unknown as PrismaClient) };
}

/**
 * `projectIdOf` is what `AccessGuard` asks for every `/v1/runs/:id` route,
 * and the guard runs BEFORE parameter pipes, so it sees the raw path
 * segment. A malformed id that reached a `uuid`-typed query would fail there
 * (a 500) before the controller's `uuidParam` could answer its 400
 * INVALID_ID. It answers null without asking instead; the guard then passes
 * the request through, and the pipe refuses it as it did before the guard
 * existed.
 *
 * ═══ THE SET IT REFUSES MUST BE EXACTLY THE SET THE PIPE REFUSES ═══
 *
 * Both directions matter. An id the pipe ACCEPTS but this refused would skip
 * the guard and reach the controller — a non-member reading a run. An id the
 * pipe REFUSES but this looked up (Postgres accepts braces and a missing
 * hyphen) would answer a non-member 404 where a member gets 400, which says
 * the run exists.
 */
describe('RunRepository.projectIdOf', () => {
  it.each([['not-a-uuid'], [''], [`${RUN}x`], [`{${RUN}}`], [RUN.replaceAll('-', '')]])(
    'answers null for %j, which uuidParam refuses, without a query',
    async (id) => {
      await expect(new RunRepository(untouchable()).projectIdOf(ORG, id)).resolves.toBeNull();
    },
  );

  it('looks up a well-formed id within the org, and reads only its project', async () => {
    const { findFirst, repo } = answering('p-1');

    await expect(repo.projectIdOf(ORG, RUN)).resolves.toBe('p-1');
    expect(findFirst).toHaveBeenCalledWith({ where: { id: RUN, orgId: ORG }, select: { projectId: true } });
  });

  /** uuidParam accepts upper case, and Postgres matches it to the stored id. */
  it('looks up an upper-case id too', async () => {
    const { findFirst, repo } = answering('p-1');

    await expect(repo.projectIdOf(ORG, RUN.toUpperCase())).resolves.toBe('p-1');
    expect(findFirst).toHaveBeenCalledTimes(1);
  });

  it('answers null for a well-formed id with no run in the org', async () => {
    await expect(answering(null).repo.projectIdOf(ORG, RUN)).resolves.toBeNull();
  });
});
