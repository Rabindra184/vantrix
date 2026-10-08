/**
 * Reading a Prisma error off an unknown throw, for a handler that turns one
 * kind of database refusal into the answer a caller can act on.
 *
 * DUCK-TYPED, not `instanceof Prisma.PrismaClientKnownRequestError`: Better
 * Auth runs its writes on its own Prisma client, whose error classes need not
 * be the ones this app imports, and a check that silently stopped matching
 * would turn every mapped refusal back into a 500.
 */

/** Prisma's error code (`P2002`, `P2003`, `P2025`, …), or undefined for anything else. */
export function prismaCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/** Prisma's error `meta` — the constraint, the target columns — or undefined. */
export function prismaMeta(err: unknown): Record<string, unknown> | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const meta = (err as { meta?: unknown }).meta;
  return typeof meta === 'object' && meta !== null ? (meta as Record<string, unknown>) : undefined;
}

/**
 * A unique violation (P2002) on EXACTLY these columns, compared as a set: the
 * one index a caller means, and never a future one that merely shares a
 * column with it — which would otherwise be reported as the refusal this
 * index stands for, falsely. `ProjectRepository`'s `isSlugTaken` is the same
 * rule. Prisma names the columns in `meta.target`, as the database spells
 * them.
 */
export function isUniqueViolationOn(err: unknown, columns: readonly string[]): boolean {
  if (prismaCode(err) !== 'P2002') return false;
  const target = prismaMeta(err)?.['target'];
  if (!Array.isArray(target)) return false;
  const named = new Set(target.map(String));
  const wanted = new Set(columns);
  return named.size === wanted.size && [...wanted].every((c) => named.has(c));
}
