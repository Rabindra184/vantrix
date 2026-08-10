import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { createPrisma } from './client.js';

/**
 * Shared Better Auth config for both `apps/api` (a module-scope `const`
 * mounted on the raw Express instance, see better-auth.instance.ts) and
 * `packages/persistence/scripts/bootstrap.ts` (which runs from this package
 * and cannot import an app). One definition means a future custom
 * `password.hash` cannot silently desync the two — which would present as a
 * correct password being rejected, the least debuggable failure this script
 * could produce.
 *
 * basePath is '/auth', NOT Better Auth's default '/api/auth'. With the
 * default left in place while the handler is mounted at /auth/*, every
 * request 404s with an EMPTY BODY and no error - a silent failure that costs
 * an afternoon.
 *
 * The organization plugin is deliberately absent: `org` and `project` are the
 * tenancy source of truth (spec §3). Two org models would give two answers to
 * "what may this caller see?", and that disagreement is a tenancy leak.
 */
export function createAuth(opts: { databaseUrl: string; baseUrl: string }) {
  return betterAuth({
    basePath: '/auth',
    baseURL: opts.baseUrl,
    trustedOrigins: [opts.baseUrl],
    database: prismaAdapter(createPrisma(opts.databaseUrl), { provider: 'postgresql' }),
    emailAndPassword: { enabled: true },
    session: { expiresIn: 60 * 60 * 24 * 14, updateAge: 60 * 60 * 24 },
    advanced: { defaultCookieAttributes: { httpOnly: true, sameSite: 'strict', secure: true } },
  });
}
