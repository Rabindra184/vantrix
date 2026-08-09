import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * basePath is '/auth', NOT Better Auth's default '/api/auth'. With the default
 * left in place while the handler is mounted at /auth/*, every request 404s
 * with an EMPTY BODY and no error - a silent failure that costs an afternoon.
 *
 * The organization plugin is deliberately absent: `org` and `project` are the
 * tenancy source of truth (spec §3). Two org models would give two answers to
 * "what may this caller see?", and that disagreement is a tenancy leak.
 */
export const auth = betterAuth({
  basePath: '/auth',
  database: prismaAdapter(prisma, { provider: 'postgresql' }),
  emailAndPassword: { enabled: true },
  session: { expiresIn: 60 * 60 * 24 * 14, updateAge: 60 * 60 * 24 },
  advanced: { defaultCookieAttributes: { httpOnly: true, sameSite: 'strict', secure: true } },
});
