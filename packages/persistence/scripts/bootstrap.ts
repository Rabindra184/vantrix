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
 * touched, let alone revoked. `--admin-email` is NOT idempotent: this script
 * refuses an address that already has an account, so re-running with the
 * same address fails loudly rather than minting a second password silently.
 *
 * Sign-up is closed (`createAuth`'s `disableSignUp`), so the admin is created
 * the way an administrator creates any account: the admin plugin's
 * server-side `auth.api.createUser`, with `role: 'admin'`. Called with no
 * headers it needs no session, which is what lets the first admin exist
 * before anybody can sign in.
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

/**
 * The password a container deployment starts with, when the operator has not
 * chosen one.
 *
 * ═══ THIS IS A DEFAULT CREDENTIAL, WHICH IS A KNOWN VULNERABILITY CLASS ═══
 *
 * A fixed password shipped to every server is how exposed dashboards are taken
 * over: scanners try the published default of every product they can
 * fingerprint, and they try it within hours of a host appearing. It exists
 * here anyway because the alternative was worse in practice — before this, a
 * fresh `docker compose --profile onprem up` produced a healthy platform with
 * NO account that could sign in, and the documented fix was a `pnpm` command
 * on the host that a deployer who only runs compose does not have.
 *
 * So it is scoped the way the same trade is scoped in ReportPortal, Grafana
 * and GitLab:
 *
 *   - it is only ever used when `PERFPORTAL_ADMIN_PASSWORD` is unset, so an
 *     operator who sets one never has a published secret on their instance;
 *   - it is only ever SEEDED into an empty deployment — `createUser` runs
 *     once, and a re-run finds the account and leaves it alone, so it can
 *     never reset a password somebody has changed;
 *   - and using it prints the warning below on every bootstrap, naming the
 *     variable that removes it.
 *
 * `DEPLOYMENT.md` makes changing it step one after the first sign-in.
 *
 * ═══ WHAT A LONGER DEFAULT BUYS, AND WHAT IT DOES NOT ═══
 *
 * This value is published — here, in `DEPLOYMENT.md`, in the README and in
 * `.env.example` — so an attacker does not guess it, they look it up, and no
 * amount of entropy changes that. What it defends against is the generic
 * sweep that tries `admin`, `password`, `changeme` and the product's own name
 * against every host it finds. `perfportal` was squarely in that class; this
 * is not. Against anyone who knows what they are looking at it buys nothing,
 * and the two things that do are the ones above: set
 * `PERFPORTAL_ADMIN_PASSWORD` so nothing published is ever seeded, or change
 * it after first sign-in, which sticks because bootstrap never re-passwords
 * an account that exists.
 *
 * A GUARD KEEPS THE FOUR COPIES IN STEP — `ci.yml`'s `test-residue` job reads
 * this constant and fails if the three documents stop naming it. A guide that
 * tells a reader a password the product no longer sets is worse than one that
 * says nothing: they try it, it fails, and they cannot tell whether the
 * deployment broke or the document lied.
 */
const DEFAULT_ADMIN_PASSWORD = 'PerfPortal-Setup-2026';

/**
 * The admin account bootstrap was asked for, and the password it will get.
 *
 * ═══ `mustChangePassword`: TRUE EXACTLY WHEN NOBODY CHOSE THIS PASSWORD ═══
 *
 * The published default is one anyone can look up, and a generated one has
 * been printed to a terminal, where it may also have been captured. Both are
 * flagged: the person signing in with them has to choose their own. An
 * operator who set `PERFPORTAL_ADMIN_PASSWORD` chose theirs, and is not
 * flagged.
 * The rule is decided by where the PASSWORD came from, so it is the same
 * whether the account was asked for through `PERFPORTAL_ADMIN_EMAIL` or
 * `--admin-email`.
 *
 * Written only when the account is CREATED: a re-run that finds the account
 * leaves the flag alone, as it leaves the password and the role alone.
 */
interface WantedAdmin {
  email: string;
  password: string;
  usingDefaultPassword: boolean;
  mustChangePassword: boolean;
}

/**
 * Who to create, and with what — CLI first, then environment, then the
 * documented defaults.
 *
 * `--admin-email` keeps its old meaning exactly: passing it opts in to
 * creating an admin, and without it (and without the env var) no account is
 * created at all. That matters because this script's other caller is a human
 * at a terminal following `infra/README.md`, and turning admin creation on by
 * default would have changed what that command does underneath them.
 *
 * The CONTAINER path opts in through `PERFPORTAL_ADMIN_EMAIL`, which
 * `docker-compose.yml`'s bootstrap service always sets. That is the whole
 * difference between the two callers.
 */
function resolveAdmin(adminEmail: string | undefined): WantedAdmin | undefined {
  const email = adminEmail ?? process.env.PERFPORTAL_ADMIN_EMAIL;
  if (!email) return undefined;

  const chosen = process.env.PERFPORTAL_ADMIN_PASSWORD;
  if (chosen) return { email, password: chosen, usingDefaultPassword: false, mustChangePassword: false };

  // A CLI caller gets a random password, as it always has: they are reading
  // stdout and can save it. Only the container path, which nobody is watching,
  // falls back to the documented default — otherwise every `compose up` would
  // mint a password the deployer has to go hunting for in logs.
  if (process.env.PERFPORTAL_ADMIN_EMAIL && !adminEmail) {
    return { email, password: DEFAULT_ADMIN_PASSWORD, usingDefaultPassword: true, mustChangePassword: true };
  }
  return { email, password: generatePassword(), usingDefaultPassword: false, mustChangePassword: true };
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
    // Deliberately BEFORE the token mint below (M4): account creation throws
    // on a duplicate email, and used to run AFTER the token had already been
    // `prisma.apiToken.create`d — so that throw left a token row committed
    // with its plaintext already gone (stdout, the only place it's ever
    // printed, is reached further down, after both of these succeed) and no
    // way to recover it. Every retry against the same taken email minted
    // another orphaned token. Account creation first means a duplicate-email
    // failure here happens before any token exists to orphan.
    const wanted = resolveAdmin(adminEmail);

    /* ═══ IDEMPOTENT NOW, BECAUSE `docker compose up` RUNS IT EVERY TIME ═══
     *
     * This used to let sign-up's duplicate-email error escape, on the
     * reasoning quoted at the top of this file: re-running with the same
     * address "fails loudly rather than minting a second password silently".
     * That is right for a human retyping a command and wrong for the compose
     * service added beside it, which re-runs on every `up` and would fail the
     * whole deployment on the second one — a deployer who restarts their
     * stack does not want an error, they want their instance back.
     *
     * So an existing account is now REUSED, not recreated, and emphatically
     * not re-passworded: nothing here touches the credential of an account
     * that already exists, which is what keeps a default password from
     * reappearing on an instance whose operator has changed it.
     *
     * The loud-failure property survives where it belongs — a CLI caller who
     * passes `--admin-email` for an address that exists is told so, rather
     * than being handed a password that is not the account's.
     *
     * ═══ AND NEVER RE-PROMOTED: THE REUSE PATH WRITES NOTHING TO `role` ═══
     *
     * The admin flag is `user.role`, and an admin can take it away from
     * anybody — the bootstrap account included. If this path "made sure" the
     * account it found was an admin, every `compose up` would quietly undo
     * that demotion, and the one account an operator most wants to be able to
     * retire would be the one that keeps coming back. So an existing account
     * keeps whatever role it has. `ci.yml`'s bootstrap step demotes the
     * account, runs this a third time, and fails if it is an admin again.
     *
     * Nor to `mustChangePassword`, for the same reason one field over: a
     * re-run that set it on an account whose flag is clear would undo
     * whatever cleared it, on every `up`. The same CI step clears it and
     * requires it still clear after the next run.
     *
     * The lookup is by the LOWERCASED address because that is what Better
     * Auth stores: an operator who wrote `Admin@Corp.example` would otherwise
     * find nothing on the second run, try to create the account again, and
     * have every later `up` fail on "user already exists". */
    let admin: WantedAdmin | undefined;
    let adminExisted = false;
    if (wanted) {
      const existing = await prisma.user.findFirst({ where: { email: wanted.email.toLowerCase() } });
      if (existing) {
        adminExisted = true;
        if (adminEmail) {
          throw new Error(
            `An account already exists for ${wanted.email}. Bootstrap will not change ` +
              'its password. Use a different --admin-email, or sign in with the ' +
              'existing account.',
          );
        }
        /* Make sure the account can actually reach the org this run targets:
         * a deployment whose ADMIN exists but whose ORG was recreated would
         * otherwise sign in to nothing.
         *
         * GUARDED, because `add` is a plain `create` and `org_member` is
         * unique on `(user_id, org_id)`. Calling it unconditionally is what
         * the first version of this did, and the second `compose up` of a
         * deployment died on `Unique constraint failed on the fields:
         * (user_id, org_id)` — an idempotency fix that was not idempotent,
         * found by running the thing twice rather than by reading it. */
        const membership = await prisma.orgMember.findFirst({
          where: { userId: existing.id, orgId: org.id },
        });
        if (!membership) {
          await new OrgMemberRepository(prisma).add(existing.id, org.id);
        }
      }
    }

    if (wanted && !adminExisted) {
      const auth = createAuth({
        databaseUrl,
        baseUrl: process.env.BETTER_AUTH_URL ?? `http://localhost:${Number(process.env.PORT ?? 3000)}`,
      });
      const password = wanted.password;
      /* The admin plugin's create does NOT apply Better Auth's password
       * bounds (8 to 128 by default); sign-up did, and refused a too-short
       * PERFPORTAL_ADMIN_PASSWORD loudly. Without this check the same value
       * would be seeded silently, as the one credential guarding a fresh
       * install. The bounds are read from Better Auth's own context, so there
       * is no second definition of them here. */
      const { minPasswordLength, maxPasswordLength } = (await auth.$context).password.config;
      if (password.length < minPasswordLength || password.length > maxPasswordLength) {
        throw new Error(
          `The admin password must be ${minPasswordLength} to ${maxPasswordLength} characters ` +
            `(got ${password.length}). Choose another PERFPORTAL_ADMIN_PASSWORD.`,
        );
      }
      const created = await auth.api.createUser({
        body: {
          email: wanted.email,
          password,
          name: titleCase(wanted.email.split('@')[0] ?? 'admin'),
          role: 'admin',
          // `data` is how a server-side create sets a field declared
          // `input: false`; see WantedAdmin for the rule.
          data: { mustChangePassword: wanted.mustChangePassword },
        },
      });
      await new OrgMemberRepository(prisma).add(created.user.id, org.id);
      admin = wanted;
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
              /* Said here because nobody chose this password (WantedAdmin), and
                 the first thing the account meets is the step that replaces
                 it: the web app shows "Choose a new password" and nothing else,
                 and every route a session could otherwise reach, except
                 PUT /v1/me/password, answers 403 PASSWORD_CHANGE_REQUIRED until
                 it is done. An operator-chosen password is not flagged, so this
                 line is not printed for it — ci.yml's bootstrap steps hold both
                 halves. */
              ...(admin.mustChangePassword
                ? [
                    '',
                    '  At first sign-in it must choose a new password before anything else',
                    '  (in the web app, or with PUT /v1/me/password).',
                  ]
                : []),
              ...(admin.usingDefaultPassword
                ? [
                    '',
                    /* No "or redeploy with PERFPORTAL_ADMIN_PASSWORD set": the
                       account now exists, and bootstrap never re-passwords one
                       that does, so a redeploy would leave this password in
                       place. Signing in and changing it is the one thing that
                       replaces it. */
                    '  !! THIS IS THE PUBLISHED DEFAULT PASSWORD. Anyone who can reach',
                    '  !! this instance knows it. Sign in and change it now.',
                  ]
                : []),
            ]
          : adminExisted
            ? [
                '',
                '  Admin account: already present, left untouched.',
                '',
                '    Its password was NOT changed — bootstrap never re-passwords an',
                '    account that exists, which is what stops a default reappearing',
                '    on an instance whose operator has already changed it.',
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
