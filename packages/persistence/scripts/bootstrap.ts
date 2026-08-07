/**
 * Bootstrap script: mints the org/project/token that the rest of this repo
 * assumes already exist.
 *
 * There is no admin API and no seed data — `createTestApp` (apps/api/test/support/app.ts)
 * creates its org/project/token directly via Prisma for every test run, which
 * quietly hid the fact that nothing outside the test harness can do the same.
 * `infra/README.md`'s documented "post the fixture bundle" flow needs a
 * `$PERFPORTAL_TOKEN` that, before this script, could not be obtained.
 *
 * Usage:
 *   pnpm --filter @perfportal/persistence run bootstrap [orgSlug] [projectSlug]
 *
 * Org/project slugs, in priority order: CLI positional args, then
 * PERFPORTAL_ORG_SLUG / PERFPORTAL_PROJECT_SLUG, then "demo" / "demo".
 *
 * Safe to re-run: the org and project are upserted by their unique slugs, so
 * re-running never duplicates either. A fresh API token IS minted on every
 * run — that's deliberate (see the task write-up); existing tokens are never
 * touched, let alone revoked.
 *
 * The plaintext token is printed to stdout exactly once and nowhere else: not
 * logged, not written to a file. There is no way to recover it after this
 * process exits — only the Argon2id hash and prefix are persisted.
 */
import { hashToken, mintToken, splitToken } from '@perfportal/core';
import { createPrisma } from '../src/client.js';

function resolveSlug(argIndex: number, envVar: string, fallback: string): string {
  const fromArg = process.argv[2 + argIndex];
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

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      'DATABASE_URL is required. Example: postgresql://perfportal:perfportal@localhost:5433/perfportal',
    );
  }

  const orgSlug = resolveSlug(0, 'PERFPORTAL_ORG_SLUG', 'demo');
  const projectSlug = resolveSlug(1, 'PERFPORTAL_PROJECT_SLUG', 'demo');

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

    // The ONLY place the plaintext token is ever written: stdout, once.
    // It is never logged, never persisted, and cannot be recovered after
    // this process exits — only its Argon2id hash lives in the database.
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
