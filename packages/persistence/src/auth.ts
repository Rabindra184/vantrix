import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { createPrisma } from './client.js';

/**
 * ═══ `Secure` EVERYWHERE EXCEPT LOOPBACK, AND SAFARI IS WHY ═══
 *
 * This was `secure: true`, unconditionally, and the reasoning was sound: a
 * session cookie that a browser will send over plain HTTP is a session cookie
 * an attacker on the path can read. Fail closed.
 *
 * It failed closed on `http://localhost` too, and that is not the same thing.
 * Measured with a three-engine probe against a plain-HTTP loopback server
 * that sets one `Secure` cookie:
 *
 *     chromium  cookie:pp_session=abc
 *     firefox   cookie:pp_session=abc
 *     webkit    cookie:(none)
 *
 * Chromium and Firefox treat loopback as a trustworthy origin and store it.
 * WebKit does not. So **nobody could sign in to a local PerfPortal instance
 * in Safari** — sign-in appeared to succeed, no cookie was stored, and every
 * `/v1` request afterwards 401'd as if uncredentialed. It is also why 98 of
 * the 102 WebKit end-to-end specs rendered the login page instead of the run
 * they had navigated to; the suite could not have covered that engine at all.
 *
 * The exemption is LOOPBACK ONLY — `localhost`, `127.0.0.1`, `::1` — which
 * every browser's own spec already defines as a potentially-trustworthy
 * origin because there is no network between the two ends to listen on. A
 * plain-HTTP deployment reachable by hostname still gets `Secure` and still
 * fails closed, exactly as before: that case is a real exposure and the
 * behaviour there is deliberate, documented in the root README, and
 * unchanged.
 *
 * Derived from `baseUrl` rather than from `NODE_ENV`, because NODE_ENV says
 * nothing about the origin a browser will use — `pnpm test:e2e` runs a
 * production-mode build against `http://localhost:3000`, and a deployment can
 * perfectly well run with NODE_ENV unset.
 */
export function cookiesAreSecure(baseUrl: string): boolean {
  let host: string;
  try {
    const url = new URL(baseUrl);
    if (url.protocol === 'https:') return true;
    host = url.hostname;
  } catch {
    // An unparseable baseUrl is a misconfiguration, and the safe reading of a
    // misconfiguration is the strict one.
    return true;
  }
  // `URL.hostname` KEEPS the brackets on an IPv6 literal — it is `[::1]`,
  // not `::1`. Asserted rather than assumed: the first version of this line
  // compared against the unbracketed form and the `http://[::1]:3000` case in
  // auth-cookies.test.ts failed, which is the only way that would ever have
  // been noticed.
  return !(host === 'localhost' || host === '127.0.0.1' || host === '[::1]');
}

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
    advanced: {
      defaultCookieAttributes: {
        httpOnly: true,
        sameSite: 'strict',
        secure: cookiesAreSecure(opts.baseUrl),
      },
    },
  });
}
