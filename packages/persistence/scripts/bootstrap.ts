/**
 * Bootstrap script: mints the org/project/token that the rest of this repo
 * assumes already exist, and (optionally) a human admin account.
 *
 * There is no admin API and no seed data — `createTestApp` (apps/api/test/support/app.ts)
 * creates its org/project/token directly via Prisma for every test run, which
 * quietly hid the fact that nothing outside the test harness can do the same.
 * `infra/README.md`'s documented "post the fixture bundle" flow needs a
 * `$PERFPORTAL_TOKEN` that, before this script, could not be obtained. The
 * same gap existed for a human: before `--admin-email`, there was no way to
 * get a session-authenticated account either.
 *
 * Usage:
 *   pnpm --filter @perfportal/persistence run bootstrap [orgSlug] [projectSlug] [--admin-email <email>]
 *
 * Org/project slugs, in priority order: CLI positional args, then
 * PERFPORTAL_ORG_SLUG / PERFPORTAL_PROJECT_SLUG, then "demo" / "demo".
 *
 * Safe to re-run: the org and project are upserted by their unique slugs, so
 * re-running never duplicates either. A fresh API token IS minted on every
 * run — that's deliberate (see the task write-up); existing tokens are never
 * touched, let alone revoked. `--admin-email` is NOT idempotent: Better Auth
 * rejects a second sign-up for the same email, so re-running with the same
 * address fails loudly rather than minting a second password silently.
 *
 * The plaintext token (and, when `--admin-email` is given, the plaintext
 * password) is printed to stdout exactly once and nowhere else: not logged,
 * not written to a file. There is no way to recover either after this
 * process exits — only the Argon2id/scrypt hash is persisted.
 */
import { randomBytes } from 'node:crypto';
import { hashToken, mintToken, splitToken } from '@perfportal/core';
import { createAuth } from '../src/auth.js';
import { createPrisma } from '../src/client.js';
import { OrgMemberRepository } from '../src/repositories/membership.js';

function parseArgs(argv: string[]): { positional: string[]; adminEmail?: string } {
  const positional: string[] = [];
  let adminEmail: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--admin-email') {
      const value = argv[i + 1];
      // Un-validated, `argv[i + 1]` for a trailing `--admin-email` is
      // `undefined` — that used to become `adminEmail = undefined`, which
      // reads exactly like "flag not passed": no admin is created and the
      // script still reports success (M5). A value that itself starts with
      // `--` is almost certainly the NEXT flag, silently swallowed as this
      // one's argument instead of validated — reject both loudly rather
      // than mint nothing and say nothing.
      if (value === undefined || value.startsWith('--')) {
        throw new Error(
          '--admin-email requires a value, e.g. --admin-email you@example.test' +
            (value === undefined
              ? ' (none was given — it was the last argument).'
              : ` (got "${value}", which looks like another flag, not an email).`),
        );
      }
      adminEmail = value;
      i++;
    } else if (arg !== undefined) {
      positional.push(arg);
    }
  }
  return { positional, adminEmail };
}

function resolveSlug(positional: string[], argIndex: number, envVar: string, fallback: string): string {
  const fromArg = positional[argIndex];
  if (fromArg) return fromArg;
  const fromEnv = process.env[envVar];
  if (fromEnv) return fromEnv;
  return fallback;
}

function titleCase(slug: string): string {
  return slug
    .split(/[-_]/)
    .filter(Boolean)
    .map((word) => word[0]!.toUpperCase() + word.slice(1))
    .join(' ');
}

/** 32 url-safe characters — comfortably inside Better Auth's default 8-128 bound. */
function generatePassword(): string {
  return randomBytes(24).toString('base64url');
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      'DATABASE_URL is required. Example: postgresql://perfportal:perfportal@localhost:5433/perfportal',
    );
  }

  const { positional, adminEmail } = parseArgs(process.argv.slice(2));
  const orgSlug = resolveSlug(positional, 0, 'PERFPORTAL_ORG_SLUG', 'demo');
  const projectSlug = resolveSlug(positional, 1, 'PERFPORTAL_PROJECT_SLUG', 'demo');

  const prisma = createPrisma(databaseUrl);
  try {
    // Upsert by the unique slug columns so re-running this script never
    // creates a second org or project — only ever reuses the existing one.
    const org = await prisma.org.upsert({
      where: { slug: orgSlug },
      update: {},
      create: { slug: orgSlug, name: titleCase(orgSlug) },
    });

    const project = await prisma.project.upsert({
      where: { orgId_slug: { orgId: org.id, slug: projectSlug } },
      update: {},
      create: { orgId: org.id, slug: projectSlug, name: titleCase(projectSlug), settings: {} },
    });

    // Only created when --admin-email is passed. Goes through Better Auth's
    // own server API (never raw SQL) so the password hash this writes is one
    // Better Auth's own login path can verify — createAuth is the single
    // shared definition apps/api's instance also builds on, so there is no
    // second hashing scheme to desync. See createAuth's docstring.
    //
    // Deliberately BEFORE the token mint below (M4): signUpEmail throws on a
    // duplicate email, and used to run AFTER the token had already been
    // `prisma.apiToken.create`d — so that throw left a token row committed
    // with its plaintext already gone (stdout, the only place it's ever
    // printed, is reached further down, after both of these succeed) and no
    // way to recover it. Every retry against the same taken email minted
    // another orphaned token. Sign-up first means a duplicate-email failure
    // here happens before any token exists to orphan.
    let admin: { email: string; password: string } | undefined;
    if (adminEmail) {
      const auth = createAuth({
        databaseUrl,
        baseUrl: process.env.BETTER_AUTH_URL ?? `http://localhost:${Number(process.env.PORT ?? 3000)}`,
      });
      const password = generatePassword();
      const signUp = await auth.api.signUpEmail({
        body: {
          email: adminEmail,
          password,
          name: titleCase(adminEmail.split('@')[0] ?? 'admin'),
        },
      });
      await new OrgMemberRepository(prisma).add(signUp.user.id, org.id, 'admin');
      admin = { email: adminEmail, password };
    }

    // Reuse the API's own token format and hashing path (@perfportal/core) —
    // a second implementation of "pp_<prefix>_<secret>" plus Argon2id would
    // be exactly the kind of drift this branch has already been bitten by.
    const { token, prefix } = mintToken();
    const parts = splitToken(token)!;
    const tokenHash = await hashToken(parts.secret);

    const apiToken = await prisma.apiToken.create({
      data: {
        orgId: org.id,
        projectId: project.id,
        name: `bootstrap-${new Date().toISOString()}`,
        prefix,
        tokenHash,
        scopes: ['ingest', 'read'],
      },
    });

    // The ONLY place the plaintext token (and, if minted, the plaintext admin
    // password) is ever written: stdout, once. Neither is ever logged, never
    // persisted, and cannot be recovered after this process exits — only the
    // token's Argon2id hash and the admin password's Better Auth hash live in
    // the database.
    process.stdout.write(
      [
        '',
        '======================================================================',
        'PerfPortal bootstrap complete.',
        '',
        `  Org:       ${org.slug}  (${org.id})`,
        `  Project:   ${project.slug}  (${project.id})`,
        `  Token id:  ${apiToken.id}`,
        `  Scopes:    ${apiToken.scopes.join(', ')}`,
        '',
        '  API token — shown ONCE, unrecoverable after this point:',
        '',
        `    ${token}`,
        '',
        '  Only its Argon2id hash and prefix are stored. Save the plaintext now.',
        '',
        '  export PERFPORTAL_TOKEN=\'' + token + '\'',
        ...(admin
          ? [
              '',
              '  Admin account — shown ONCE, unrecoverable after this point:',
              '',
              `    Email:    ${admin.email}`,
              `    Password: ${admin.password}`,
              '',
              '  Only its hash is stored. Save the plaintext now, then log in via',
              '  POST /auth/sign-in/email.',
            ]
          : []),
        '======================================================================',
        '',
      ].join('\n'),
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error('Bootstrap failed:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
