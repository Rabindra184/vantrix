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
export function cookiesAreSecure(baseUrl: string, allowInsecure = false): boolean {
  let host: string;
  try {
    const url = new URL(baseUrl);
    if (url.protocol === 'https:') return true;
    /* ═══ THE OPERATOR'S OPT-OUT, AND WHY IT EXISTS ═══
     *
     * Everything below this line fails closed, deliberately, and that is the
     * right default. It is also stricter than Grafana, Jenkins, Nexus or
     * GitLab, every one of which will serve a session over plain HTTP on an
     * internal network — so the behaviour a deployer expects from "it is an
     * HTTP app, I can reach it by hostname" is the behaviour they get
     * everywhere except here.
     *
     * What they actually met was the worst shape a refusal can take: the page
     * loads, credentials are accepted, sign-in answers 200, and then every
     * request says signed out, because the browser discarded a `Secure`
     * cookie it was handed over HTTP. Nothing on screen says why, and no
     * amount of configuration fixed it.
     *
     * So there is a switch now. It is OFF by default — `allowInsecure`
     * defaults to false and every existing caller keeps its behaviour to the
     * byte — and turning it on is a decision an operator makes in one place,
     * about their own network, with `DEPLOYMENT.md` spelling out the cost:
     * a session cookie sent in the clear is readable by anyone on the path,
     * so this belongs on a trusted LAN and nowhere else.
     *
     * HTTPS ignores it entirely — the check above returns before this — so
     * the flag can never downgrade a TLS deployment, even set by mistake. */
    if (allowInsecure) return false;
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
export function createAuth(opts: {
  databaseUrl: string;
  baseUrl: string;
  /**
   * Serve sessions over plain HTTP to a non-loopback host. OFF unless the
   * operator says otherwise, ignored entirely when `baseUrl` is HTTPS, and
   * described at `cookiesAreSecure`.
   */
  allowInsecureCookies?: boolean;
}) {
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
        secure: cookiesAreSecure(opts.baseUrl, opts.allowInsecureCookies ?? false),
      },
    },
  });
}
