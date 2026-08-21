import { Prisma, type PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { ProjectRepository } from '../src/repositories/project.js';

/**
 * `createInOrg`'s error narrowing, with a STUB client rather than a database.
 *
 * The behaviour under test is which failures become `null` — the answer the
 * API turns into "that slug is already taken" — and which propagate. Only one
 * of those cases can be produced for real: `project` has exactly one unique
 * index today, so there is no second constraint to violate and the
 * interesting branch (a P2002 that is NOT the slug) is unreachable against a
 * live schema. A stub is the only way to reach it, and reaching it is the
 * whole point: the mapping was written as "any P2002 means the slug is
 * taken", which is correct precisely until someone adds a second index and
 * then tells users something confidently false about a slug that was never
 * the problem.
 *
 * The real shape is not guessed. Against this schema a genuine duplicate
 * reports `meta.target === ['org_id', 'slug']` — database column names, not
 * Prisma field names — which was observed by triggering one before these
 * cases were written.
 */
function knownError(code: string, meta?: Record<string, unknown>) {
  return new Prisma.PrismaClientKnownRequestError('stubbed', {
    code,
    clientVersion: 'test',
    meta,
  });
}

/** A client whose only job is to fail `project.create` in a chosen way. */
function clientThatThrows(err: unknown): PrismaClient {
  return {
    project: {
      create: () => Promise.reject(err),
    },
  } as unknown as PrismaClient;
}

const INPUT = { orgId: 'org-1', slug: 'checkout', name: 'Checkout' };

describe('ProjectRepository.createInOrg', () => {
  it('returns the created project when the insert succeeds', async () => {
    const client = {
      project: {
        create: () =>
          Promise.resolve({
            id: 'p1',
            orgId: 'org-1',
            slug: 'checkout',
            name: 'Checkout',
            settings: null,
          }),
      },
    } as unknown as PrismaClient;

    const created = await new ProjectRepository(client).createInOrg(INPUT);

    expect(created).toEqual({
      id: 'p1',
      orgId: 'org-1',
      slug: 'checkout',
      name: 'Checkout',
      // A null `settings` column becomes an empty bag, never null — callers
      // read knobs straight off it.
      settings: {},
    });
  });

  it('reports the (org_id, slug) duplicate as null, which the API renders as 409', async () => {
    const client = clientThatThrows(knownError('P2002', { target: ['org_id', 'slug'] }));
    await expect(new ProjectRepository(client).createInOrg(INPUT)).resolves.toBeNull();
  });

  /**
   * THE CASE THE NARROWING EXISTS FOR. Before it, this rethrow was a `null`,
   * so a violation of some future constraint surfaced to the user as
   * "A project with slug "checkout" already exists" — a confident,
   * specific, wrong diagnosis, with the real fault swallowed. An unexpected
   * constraint violation is a bug to fix, not advice to give, so it must
   * reach the error handler as the 500 it is.
   */
  it('rethrows a P2002 on any OTHER constraint rather than blaming the slug', async () => {
    const client = clientThatThrows(knownError('P2002', { target: ['name'] }));
    await expect(new ProjectRepository(client).createInOrg(INPUT)).rejects.toThrow();
  });

  it('rethrows a P2002 whose target merely includes slug among more columns', async () => {
    // A future `(org_id, slug, environment)` index is not this one, and
    // matching on "contains slug" would have swallowed it.
    const client = clientThatThrows(knownError('P2002', { target: ['org_id', 'slug', 'environment'] }));
    await expect(new ProjectRepository(client).createInOrg(INPUT)).rejects.toThrow();
  });

  it('rethrows a non-P2002 Prisma error', async () => {
    const client = clientThatThrows(knownError('P2003', { field_name: 'org_id' }));
    await expect(new ProjectRepository(client).createInOrg(INPUT)).rejects.toThrow();
  });

  it('rethrows an error that is not a Prisma error at all', async () => {
    const client = clientThatThrows(new Error('connection reset'));
    await expect(new ProjectRepository(client).createInOrg(INPUT)).rejects.toThrow('connection reset');
  });
});
