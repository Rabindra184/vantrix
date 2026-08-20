#!/usr/bin/env node
// Seeds a fresh org/project/API token for the Gradle plugin's real end-to-end
// test (Task 7 of the gatling-gradle-live-streaming plan).
//
// Deliberately plain JS, not TypeScript: run-e2e.sh copies this file into
// apps/api/ (see that script's own comment) and runs it there with a plain
// `node`, because that is the cwd where @perfportal/core and
// @perfportal/persistence resolve as workspace packages (apps/api depends on
// both directly -- see apps/api/package.json). Running it from clients/
// would need its own node_modules wiring for no benefit.
//
// Mirrors apps/web/e2e/fixtures.ts's mintIngestToken/mintStreamToken and
// packages/persistence/scripts/bootstrap.ts's mint -- same token format
// (mintToken/hashToken from @perfportal/core), same Prisma writes -- except
// this mints ONE token carrying BOTH 'stream' (to open/stream/close a live
// run, checked by LiveController's @Scopes('stream')) and 'read' (to poll
// GET /v1/runs/:id, checked by RunsController's @Scopes('read')).
//
// Output contract: the ONLY thing written to stdout is one line of JSON --
// run-e2e.sh captures it whole and parses it. Every human-readable status
// line goes to stderr instead, so a `node seed.mjs 2>/dev/null` (or the
// equivalent `$(... 2>&1 1>&3 3>&-)` shell juggling) always gets clean JSON.
import { randomUUID } from 'node:crypto';
import { hashToken, mintToken, splitToken } from '@perfportal/core';
import { createPrisma } from '@perfportal/persistence';

function log(msg) {
  process.stderr.write(`[seed] ${msg}\n`);
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      'DATABASE_URL is required, e.g. postgresql://perfportal:perfportal@localhost:5433/perfportal',
    );
  }

  const prisma = createPrisma(databaseUrl);
  try {
    // Fresh org + project every run (F4/Task 7: "make it re-runnable").
    // Slug/name avoid Overview/Charts/Errors/Trends/Load -- this org is only
    // ever driven by this script and never opened in the web app during the
    // e2e run, but the constraint costs nothing to honour and the whole
    // point of this branch's design pass was that colliding with a tab name
    // is easy to do by accident (see CLAUDE.md's ProjectRail note).
    const suffix = randomUUID().slice(0, 8);
    const orgSlug = `gatling-e2e-${suffix}`;
    const projectSlug = `parity-run-${suffix}`;

    const org = await prisma.org.create({ data: { slug: orgSlug, name: `Gatling E2E ${suffix}` } });
    const project = await prisma.project.create({
      data: { orgId: org.id, slug: projectSlug, name: `Parity Run ${suffix}`, settings: {} },
    });
    log(`org ${org.slug} (${org.id}), project ${project.slug} (${project.id})`);

    // One token, both scopes -- LiveController requires 'stream' to
    // open/stream/close the live run, RunsController requires 'read' to poll
    // GET /v1/runs/:id. A single credential is fine for both (Task 7 brief).
    const { token, prefix } = mintToken();
    const parts = splitToken(token);
    if (!parts) throw new Error('mintToken() produced a token splitToken() cannot parse -- token format drift');
    const tokenHash = await hashToken(parts.secret);

    const apiToken = await prisma.apiToken.create({
      data: {
        orgId: org.id,
        projectId: project.id,
        name: 'gatling-e2e',
        prefix,
        tokenHash,
        scopes: ['stream', 'read'],
      },
    });
    log(`token ${apiToken.prefix} minted with scopes [${apiToken.scopes.join(', ')}]`);

    // readToken === token: one credential carries both scopes (Task 7
    // brief: "one token with both scopes is fine for both streaming and
    // polling"). Kept as its own field so run-e2e.sh never has to guess
    // whether streaming and polling share a credential.
    process.stdout.write(
      `${JSON.stringify({
        token,
        readToken: token,
        orgSlug: org.slug,
        projectSlug: project.slug,
      })}\n`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  process.stderr.write(`[seed] failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exitCode = 1;
});
