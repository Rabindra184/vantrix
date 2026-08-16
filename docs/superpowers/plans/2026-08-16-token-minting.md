# Token minting — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** let a signed-in human create, list and revoke a project's API tokens, so the `telemetry` scope shipped in PR #29 has a credential path and the agent can be run by someone who is not this repository's test suite.

**Architecture:** three routes on one resource — `POST`, `GET` and `DELETE /v1/projects/:slug/tokens` — guarded by a new `@SessionOnly()` that rejects bearer credentials. `TokenRepository` gains `create`, `listForProject` and `revokeByPrefix`. **No migration:** `ApiToken` already carries every column needed, including a `revokedAt` that has been checked on every authentication since it was created and never written by anything.

**Tech Stack:** NestJS, Zod contracts shared API↔web, Prisma, vitest integration tests.

**Spec:** [`docs/superpowers/specs/2026-08-16-token-minting-design.md`](../specs/2026-08-16-token-minting-design.md)

## Global Constraints

- **Node 22 (`.nvmrc`). `nvm use` FIRST.** On Node 20 every DOM-environment test file silently fails to load while Vitest prints a confident green summary above the errors.
- **These routes must NEVER carry `@Scopes(...)`.** A scope check passes for any credential holding that scope, so `@Scopes('read')` would let a leaked read-only CI token mint itself an `ingest` one. Authorisation here is "is this a session", enforced by `@SessionOnly()`.
- **The tenant comes from `req.tenant`, never the request body.** The slug names the project; the org comes from the session.
- **Expectations are computed from the payload, never written down.**
- **Run test commands in the FOREGROUND and wait.** Several tasks in the previous sub-project stalled by backgrounding a suite and ending the turn.
- **To run one integration file** (this form genuinely filters):
  ```
  pnpm exec vitest run --config vitest.integration.config.ts apps/api/test/tokens.integration.test.ts
  ```
  `pnpm test:integration -- tokens` does **NOT** filter — it runs the whole ~5-minute suite.
- **Full gate, integration BEFORE e2e:** `pnpm typecheck && pnpm lint && pnpm test:unit && pnpm test:integration && pnpm test:e2e`. Reversing the last two truncates every table underneath a still-draining Playwright worker.
- **Baselines that must go UP, never down:** unit **81 files / 931 tests**; integration **83 files / 996 tests**; e2e **86 passed** (this plan adds no e2e).
- **Known flake:** `apps/api/test/ingest.integration.test.ts` can fail an idempotency assertion under full-suite parallel load and passes 10/10 alone. If that is the only failure, re-run it alone and say so.
- **No new DI providers are needed.** `AuthModule` is `@Global()` and already exports `TokenRepository` and `ProjectRepository`. (The `useFactory` trap from the telemetry work applies only to `pg.Pool`-backed services; these are `PrismaClient`-backed and already provided.)

---

## File Structure

**Create:**
- `packages/contracts/src/tokens.ts` — the three Zod schemas
- `apps/api/src/auth/session-only.guard.ts` — the security core
- `apps/api/src/tokens/tokens.controller.ts`, `apps/api/src/tokens/tokens.module.ts`
- `apps/api/test/tokens.integration.test.ts`

**Modify:**
- `packages/contracts/src/index.ts` (re-export)
- `packages/persistence/src/repositories/token.ts` (three additive methods)
- `apps/api/src/app.module.ts` (register `TokensModule`)
- `apps/api/src/openapi/document.ts`, `apps/api/src/openapi/schemas.ts`

---

## Task 1: The contracts

**Files:**
- Create: `packages/contracts/src/tokens.ts`
- Modify: `packages/contracts/src/index.ts`
- Test: `packages/contracts/test/tokens.test.ts`

**Interfaces:**
- Consumes: `TokenScope`-equivalent scope names. **Note:** `TokenScope` currently lives in `apps/api/src/auth/scopes.decorator.ts`, which `packages/contracts` must not import (contracts is consumed by the browser). Declare the scope list here as the shared source and leave the API's union alone; Task 3 checks the two agree.
- Produces: `MintTokenRequestSchema`, `MintedTokenSchema`, `TokenSummarySchema`, `TokenListResponseSchema` and their inferred types.

- [ ] **Step 1: Write the failing test**

`packages/contracts/test/tokens.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { MintTokenRequestSchema } from '../src/tokens.js';

describe('MintTokenRequestSchema', () => {
  it('accepts a named request for a known scope', () => {
    const r = MintTokenRequestSchema.safeParse({ name: 'gen-1 agent', scopes: ['telemetry'] });
    expect(r.success).toBe(true);
  });

  it('rejects an unknown scope', () => {
    // A garbage scope would authenticate and match nothing, producing a token
    // that fails every request for a reason no message explains.
    const r = MintTokenRequestSchema.safeParse({ name: 'x', scopes: ['admin'] });
    expect(r.success).toBe(false);
  });

  it('rejects an empty scope array', () => {
    // A token that authenticates and can do nothing is a confusing thing to
    // hand somebody.
    expect(MintTokenRequestSchema.safeParse({ name: 'x', scopes: [] }).success).toBe(false);
  });

  it('rejects a missing or blank name', () => {
    // The name is what a human reads months later when deciding what is safe
    // to revoke.
    expect(MintTokenRequestSchema.safeParse({ scopes: ['read'] }).success).toBe(false);
    expect(MintTokenRequestSchema.safeParse({ name: '   ', scopes: ['read'] }).success).toBe(false);
  });

  it('rejects unknown top-level fields', () => {
    // .strict(), for the same reason the telemetry batch is strict: a caller
    // that starts sending something we ignore should fail loudly rather than
    // appear to work.
    const r = MintTokenRequestSchema.safeParse({ name: 'x', scopes: ['read'], projectId: 'nope' });
    expect(r.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
source ~/.nvm/nvm.sh && nvm use && pnpm exec vitest run packages/contracts/test/tokens.test.ts
```

Expected: FAIL — cannot resolve `../src/tokens.js`.

- [ ] **Step 3: Write the implementation**

`packages/contracts/src/tokens.ts`:

```ts
import { z } from 'zod';

/**
 * The scopes a token may carry.
 *
 * DECLARED HERE rather than imported from the API, because `TokenScope` lives
 * in `apps/api/src/auth/scopes.decorator.ts` and this package is consumed by
 * the browser. Task 3 asserts the two lists agree, so the duplication cannot
 * drift silently.
 */
export const TOKEN_SCOPES = ['ingest', 'read', 'telemetry'] as const;
export type TokenScopeName = (typeof TOKEN_SCOPES)[number];

/**
 * The body of POST /v1/projects/:slug/tokens.
 *
 * `.strict()` for the same reason `TelemetryBatchSchema` is strict: a field we
 * silently ignore is a field a caller believes is doing something. There is no
 * `projectId` here — the slug in the URL names the project and the org comes
 * from the session.
 */
export const MintTokenRequestSchema = z
  .object({
    /** Free text, and required. An unnamed credential is one nobody dares
     *  revoke, because nothing on the list says what it was for. */
    name: z.string().trim().min(1).max(120),
    /** Non-empty. A token with no scopes authenticates and can do nothing. */
    scopes: z.array(z.enum(TOKEN_SCOPES)).min(1),
  })
  .strict();
export type MintTokenRequest = z.infer<typeof MintTokenRequestSchema>;

/**
 * What a mint returns — and the ONLY moment `token` exists anywhere.
 *
 * Only `tokenHash` is persisted, so this value cannot be recovered or
 * re-derived. A caller who loses it mints a new token.
 */
export const MintedTokenSchema = z.object({
  token: z.string(),
  prefix: z.string(),
  name: z.string(),
  scopes: z.array(z.enum(TOKEN_SCOPES)),
  createdAt: z.string().datetime(),
});
export type MintedToken = z.infer<typeof MintedTokenSchema>;

/**
 * One row of the list. NOTE the absence of `token` — the secret is never
 * returned again, and the hash is never returned at all.
 *
 * `lastUsedAt` is what makes this list actionable rather than decorative: it
 * is how an operator finds the credential nothing has used since March.
 * `authenticateRequest` maintains it, throttled to at most one write per
 * minute per token.
 */
export const TokenSummarySchema = z.object({
  prefix: z.string(),
  name: z.string(),
  scopes: z.array(z.enum(TOKEN_SCOPES)),
  createdAt: z.string().datetime(),
  lastUsedAt: z.string().datetime().nullable(),
  revokedAt: z.string().datetime().nullable(),
});
export type TokenSummary = z.infer<typeof TokenSummarySchema>;

export const TokenListResponseSchema = z.object({
  tokens: z.array(TokenSummarySchema),
});
export type TokenListResponse = z.infer<typeof TokenListResponseSchema>;
```

- [ ] **Step 4: Export and verify**

Append `export * from './tokens.js';` to `packages/contracts/src/index.ts`, then:

```bash
pnpm exec vitest run packages/contracts/test/tokens.test.ts && pnpm typecheck && pnpm lint
```

Expected: PASS, five tests.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts && git commit -m "feat(contracts): the shapes for minting, listing and revoking API tokens"
```

---

## Task 2: The repository

**Files:**
- Modify: `packages/persistence/src/repositories/token.ts`
- Test: `packages/persistence/test/tokens.integration.test.ts`

**Interfaces:**
- Consumes: `PrismaClient`; `hashToken`/`mintToken` from `@perfportal/core` are used by the CONTROLLER, not here — this layer stores what it is given.
- Produces, on `TokenRepository`:
  - `create(input: { orgId, projectId, name, prefix, tokenHash, scopes }): Promise<TokenSummaryRow>`
  - `listForProject(orgId: string, projectId: string): Promise<TokenSummaryRow[]>`
  - `revokeByPrefix(orgId: string, projectId: string, prefix: string): Promise<TokenSummaryRow | null>`
- `TokenSummaryRow` = `{ prefix, name, scopes, createdAt, lastUsedAt, revokedAt }` — **never `tokenHash`**.

- [ ] **Step 1: Write the failing test**

`packages/persistence/test/tokens.integration.test.ts` — follow `packages/persistence/test/metrics.integration.test.ts` for setup (`requireDatabaseUrl`, `resetDatabase` from `./support/db.js`, `createPrisma` from `../src/index.js`, org and project via prisma).

```ts
describe('TokenRepository writes', () => {
  it('creates a token and returns it without the hash', async () => {
    const created = await tokens.create({
      orgId: org.id, projectId: project.id,
      name: 'gen-1 agent', prefix: 'pp_abc123', tokenHash: 'HASH', scopes: ['telemetry'],
    });
    expect(created.prefix).toBe('pp_abc123');
    expect(created.name).toBe('gen-1 agent');
    expect(created.scopes).toEqual(['telemetry']);
    expect(created.revokedAt).toBeNull();
    // The hash must never leave this layer.
    expect(Object.keys(created)).not.toContain('tokenHash');
  });

  it('lists only this project's tokens', async () => {
    await tokens.create({ orgId: org.id, projectId: project.id, name: 'mine', prefix: 'pp_mine', tokenHash: 'H', scopes: ['read'] });
    await tokens.create({ orgId: other.orgId, projectId: other.projectId, name: 'theirs', prefix: 'pp_theirs', tokenHash: 'H', scopes: ['read'] });

    const listed = await tokens.listForProject(org.id, project.id);
    expect(listed.map((t) => t.prefix)).toEqual(['pp_mine']);
    expect(listed.some((t) => 'tokenHash' in t)).toBe(false);
  });

  it('revokes by prefix and is idempotent', async () => {
    await tokens.create({ orgId: org.id, projectId: project.id, name: 'x', prefix: 'pp_rev', tokenHash: 'H', scopes: ['read'] });

    const first = await tokens.revokeByPrefix(org.id, project.id, 'pp_rev');
    expect(first?.revokedAt).not.toBeNull();

    // A retried revoke returns the same answer rather than 404-ing, so a
    // caller retrying after a timeout is not told the token vanished.
    const second = await tokens.revokeByPrefix(org.id, project.id, 'pp_rev');
    expect(second?.revokedAt?.getTime()).toBe(first?.revokedAt?.getTime());
  });

  it('will not revoke another project's token', async () => {
    await tokens.create({ orgId: other.orgId, projectId: other.projectId, name: 'theirs', prefix: 'pp_theirs2', tokenHash: 'H', scopes: ['read'] });
    expect(await tokens.revokeByPrefix(org.id, project.id, 'pp_theirs2')).toBeNull();
  });

  it('returns null for an unknown prefix', async () => {
    expect(await tokens.revokeByPrefix(org.id, project.id, 'pp_nope')).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
source ~/.nvm/nvm.sh && nvm use
export DATABASE_URL=postgresql://perfportal:perfportal@localhost:5433/perfportal
pnpm exec vitest run --config vitest.integration.config.ts packages/persistence/test/tokens.integration.test.ts
```

Expected: FAIL — `tokens.create is not a function`.

- [ ] **Step 3: Write the implementation**

Add to `packages/persistence/src/repositories/token.ts`:

```ts
/**
 * What a token looks like to anything outside this repository.
 *
 * NO `tokenHash`. The hash never leaves this layer — a list endpoint that
 * returned it would hand an attacker the one value that makes an offline
 * attack possible, and a `select` that names its columns is what keeps that
 * true when someone later adds a field.
 */
export interface TokenSummaryRow {
  prefix: string;
  name: string;
  scopes: string[];
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

const SUMMARY_SELECT = {
  prefix: true, name: true, scopes: true,
  createdAt: true, lastUsedAt: true, revokedAt: true,
} as const;
```

and, on the class:

```ts
  /**
   * Stores a minted token. The caller mints and hashes — this layer never sees
   * a plaintext secret, which is why `tokenHash` is a parameter rather than
   * something computed here.
   */
  async create(input: {
    orgId: string; projectId: string; name: string;
    prefix: string; tokenHash: string; scopes: string[];
  }): Promise<TokenSummaryRow> {
    return this.prisma.apiToken.create({ data: input, select: SUMMARY_SELECT });
  }

  /** Newest first — the one just minted is the one being looked for. */
  async listForProject(orgId: string, projectId: string): Promise<TokenSummaryRow[]> {
    return this.prisma.apiToken.findMany({
      where: { orgId, projectId },
      select: SUMMARY_SELECT,
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Revokes by PREFIX, scoped to the project.
   *
   * By prefix rather than id because of what an operator holds during an
   * incident: the leaked token string, whose middle segment IS the prefix
   * (`pp_<prefix>_<secret>`). An id would need a lookup first.
   *
   * IDEMPOTENT: an already-revoked token keeps its original `revokedAt` rather
   * than having it moved, so a retry after a timeout returns the same answer
   * and the record still says when the credential actually stopped working.
   * Returns null when no such token exists in this project — the caller turns
   * that into a 404.
   */
  async revokeByPrefix(orgId: string, projectId: string, prefix: string): Promise<TokenSummaryRow | null> {
    const existing = await this.prisma.apiToken.findFirst({
      where: { orgId, projectId, prefix },
      select: SUMMARY_SELECT,
    });
    if (!existing) return null;
    if (existing.revokedAt) return existing;

    return this.prisma.apiToken.update({
      where: { prefix },
      data: { revokedAt: new Date() },
      select: SUMMARY_SELECT,
    });
  }
```

- [ ] **Step 4: Verify**

```bash
pnpm exec vitest run --config vitest.integration.config.ts packages/persistence/test/tokens.integration.test.ts
pnpm typecheck && pnpm lint
```

Expected: PASS, five tests.

- [ ] **Step 5: Commit**

```bash
git add packages/persistence && git commit -m "feat(persistence): create, list and revoke API tokens, never returning the hash"
```

---

## Task 3: The guard, and minting

This is the security-critical task. Its escalation tests are the point of the whole feature.

**Files:**
- Create: `apps/api/src/auth/session-only.guard.ts`, `apps/api/src/tokens/tokens.controller.ts`, `apps/api/src/tokens/tokens.module.ts`
- Modify: `apps/api/src/app.module.ts`, `apps/api/src/openapi/document.ts`, `apps/api/src/openapi/schemas.ts`
- Test: `apps/api/test/tokens.integration.test.ts`

**Interfaces:**
- Consumes: `TokenRepository`, `ProjectRepository` (both already exported by the `@Global()` `AuthModule` — no new providers), `mintToken`/`hashToken` from `@perfportal/core`, the Task 1 contracts.
- Produces: `SessionOnly` guard; `POST /v1/projects/:slug/tokens`.

- [ ] **Step 1: Write the failing tests**

`apps/api/test/tokens.integration.test.ts`. `createTestApp()` already mints `ingestToken`, `readToken` and `telemetryToken`; a session is obtained the way `session-auth.integration.test.ts` does it.

```ts
describe('POST /v1/projects/:slug/tokens', () => {
  // ═══ THE ESCALATION TEST, BOTH DIRECTIONS ═══
  // This is the feature's security property. It is also the assertion that
  // would silently keep passing if someone replaced the session check with
  // @Scopes('read') — a plausible-looking simplification that reintroduces the
  // escalation exactly.

  it('refuses a bearer read token', async () => {
    const res = await post(`/v1/projects/checkout/tokens`, ctx.readToken, { name: 'x', scopes: ['telemetry'] });
    expect(res.status).toBe(403);
  });

  it('refuses a bearer ingest token', async () => {
    const res = await post(`/v1/projects/checkout/tokens`, ctx.ingestToken, { name: 'x', scopes: ['telemetry'] });
    expect(res.status).toBe(403);
  });

  it('accepts a session', async () => {
    const res = await postAsSession(`/v1/projects/checkout/tokens`, { name: 'gen-1 agent', scopes: ['telemetry'] });
    expect(res.status).toBe(201);
    expect(res.body.token).toMatch(/^pp_[0-9a-f]+_[0-9a-f]+$/);
    expect(res.body.prefix).toBe(res.body.token.split('_').slice(0, 2).join('_'));
    expect(res.body.scopes).toEqual(['telemetry']);
  });

  // The round trip that proves the credential WORKS, rather than that a row
  // was written. Without it every other assertion could pass against a token
  // the API will not actually accept.
  it('mints a telemetry token that can actually post telemetry', async () => {
    const minted = await postAsSession(`/v1/projects/checkout/tokens`, { name: 'agent', scopes: ['telemetry'] });
    const res = await request(ctx.app.getHttpServer())
      .post('/v1/telemetry')
      .set('Authorization', `Bearer ${minted.body.token}`)
      .send({ host: 'lg-alpha', samples: [telemetrySample()] });
    expect(res.status).toBe(202);
  });

  it('mints a token that cannot do what it was not scoped for', async () => {
    const minted = await postAsSession(`/v1/projects/checkout/tokens`, { name: 'agent', scopes: ['telemetry'] });
    const res = await request(ctx.app.getHttpServer())
      .get('/v1/runs')
      .set('Authorization', `Bearer ${minted.body.token}`);
    expect(res.status).toBe(403);
  });

  it('rejects an unknown scope, an empty scope list and a blank name', async () => {
    for (const body of [
      { name: 'x', scopes: ['admin'] },
      { name: 'x', scopes: [] },
      { name: '  ', scopes: ['read'] },
    ]) {
      expect((await postAsSession(`/v1/projects/checkout/tokens`, body)).status).toBe(400);
    }
  });

  it('answers 404 for a project outside the caller's org', async () => {
    const res = await postAsSession(`/v1/projects/${otherOrgProjectSlug}/tokens`, { name: 'x', scopes: ['read'] });
    expect(res.status).toBe(404);
  });
});

describe('the contract and the API agree about scopes', () => {
  it('TOKEN_SCOPES matches the API's TokenScope union', () => {
    // The duplication is deliberate (contracts must not import from apps/api,
    // which the browser also loads), so this is what stops it drifting.
    const fromApi: TokenScope[] = ['ingest', 'read', 'telemetry'];
    expect([...TOKEN_SCOPES].sort()).toEqual([...fromApi].sort());
  });
});
```

- [ ] **Step 2: Run to verify they fail**

```bash
pnpm exec vitest run --config vitest.integration.config.ts apps/api/test/tokens.integration.test.ts
```

Expected: FAIL — 404, the route does not exist.

- [ ] **Step 3: Write the guard**

`apps/api/src/auth/session-only.guard.ts`:

```ts
import { ForbiddenException, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

/**
 * Refuses any BEARER credential, allowing only a signed-in human's session.
 *
 * ═══ WHY THIS IS NOT `@Scopes(...)` ═══
 *
 * A scope check passes for any credential that holds the scope — including a
 * bearer token. `@Scopes('read')` on a token-minting route therefore lets a
 * leaked read-only CI credential mint itself an `ingest` token: privilege
 * escalation through the front door, with every guard behaving exactly as
 * designed. Authorisation here is not "which scope" but "is this a human".
 *
 * The discriminator already existed and needs no new plumbing:
 * `AuthMiddleware.authenticateSession` sets `tenant.tokenId` to
 * `session:<session-id>`, while `authenticateRequest` sets it to the token
 * row's id. A bearer credential cannot produce the prefix.
 *
 * A GUARD rather than a line in each handler, so it reads as a policy and a
 * second credential-issuing route added later cannot quietly omit it.
 *
 * Ordering is safe: the global APP_GUARD (`AuthGuard`) runs before route
 * guards, so `req.tenant` is always populated by the time this runs.
 */
export const SESSION_TOKEN_ID_PREFIX = 'session:';

@Injectable()
export class SessionOnlyGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request>();
    const tokenId = req.tenant?.tokenId ?? '';
    if (!tokenId.startsWith(SESSION_TOKEN_ID_PREFIX)) {
      throw new ForbiddenException(
        'API tokens are minted by a signed-in user, not by a machine credential. ' +
          'Sign in at POST /auth/sign-in/email and retry with the session cookie.',
      );
    }
    return true;
  }
}
```

- [ ] **Step 4: Write the controller and module**

`apps/api/src/tokens/tokens.controller.ts` — `@Controller('/v1/projects/:slug/tokens')`, `@UseGuards(SessionOnlyGuard)` on the class, **no `@Scopes()` anywhere**. The mint handler:

1. resolves the project with `projects.findBySlugInOrg(tenant.orgId, slug)`, 404 if null;
2. parses the body with `MintTokenRequestSchema.safeParse`, 400 via `badRequest` on failure (follow `TelemetryController`'s shape);
3. `const { token, prefix } = mintToken()`, `const tokenHash = await hashToken(secretOf(token))` — note `createTestApp` splits the secret as `token.split('_')[2]`, so use the same accessor or `splitToken`;
4. `tokens.create({ orgId: tenant.orgId, projectId: project.id, name, prefix, tokenHash, scopes })`;
5. returns `MintedToken` with `@HttpCode(201)`.

`tokens.module.ts` declares the controller and provides `SessionOnlyGuard`. **No repository providers** — `AuthModule` is `@Global()` and exports both. Register `TokensModule` in `app.module.ts`.

- [ ] **Step 5: OpenAPI**

Add the path with `security: [{ cookieAuth: [] }]` — the mirror of `POST /v1/runs`'s bearer-only override, for the opposite reason. The description must state that `token` is returned once and cannot be recovered. Register the schemas in `openapi/schemas.ts` alongside the existing ones.

- [ ] **Step 6: Verify**

```bash
pnpm exec vitest run --config vitest.integration.config.ts apps/api/test/tokens.integration.test.ts
pnpm typecheck && pnpm lint
```

**Then prove the guard is load-bearing:** temporarily replace `@UseGuards(SessionOnlyGuard)` with `@Scopes('read')`, confirm the two bearer-refusal tests go RED, and restore. Report what you saw — a guard whose removal breaks nothing is not a guard.

- [ ] **Step 7: Commit**

```bash
git add apps/api && git commit -m "feat(api): mint project API tokens, session-only so a bearer cannot escalate"
```

---

## Task 4: Listing, revoking, and the full gate

**Files:**
- Modify: `apps/api/src/tokens/tokens.controller.ts`, `apps/api/src/openapi/document.ts`
- Test: `apps/api/test/tokens.integration.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
describe('GET /v1/projects/:slug/tokens', () => {
  it('lists this project's tokens and never the secret', async () => {
    const minted = await postAsSession(`/v1/projects/checkout/tokens`, { name: 'listed', scopes: ['read'] });
    const res = await getAsSession(`/v1/projects/checkout/tokens`);

    expect(res.status).toBe(200);
    const row = res.body.tokens.find((t: { prefix: string }) => t.prefix === minted.body.prefix);
    expect(row).toBeDefined();
    expect(row.name).toBe('listed');
    // Derived from what was minted, not written down.
    expect(row.scopes).toEqual(minted.body.scopes);
    expect(row.revokedAt).toBeNull();
    // The secret exists once, at mint. Never again, and never the hash.
    expect(JSON.stringify(res.body)).not.toContain(minted.body.token.split('_')[2]);
    expect(Object.keys(row)).not.toContain('tokenHash');
  });

  it('refuses a bearer credential', async () => {
    expect((await getWithBearer(`/v1/projects/checkout/tokens`, ctx.readToken)).status).toBe(403);
  });
});

describe('DELETE /v1/projects/:slug/tokens/:prefix', () => {
  // THE TEST THAT CLOSES THE LOOP. `revokedAt` has been checked on every
  // authentication since the column was created and never written by
  // anything; this is the first proof it bites end to end.
  it('revokes a token that then stops authenticating', async () => {
    const minted = await postAsSession(`/v1/projects/checkout/tokens`, { name: 'doomed', scopes: ['telemetry'] });
    const auth = { Authorization: `Bearer ${minted.body.token}` };

    const before = await postTelemetry(auth);
    expect(before.status).toBe(202);

    const revoked = await deleteAsSession(`/v1/projects/checkout/tokens/${minted.body.prefix}`);
    expect(revoked.status).toBe(200);
    expect(revoked.body.revokedAt).not.toBeNull();

    const after = await postTelemetry(auth);
    expect(after.status).toBe(401);
  });

  it('is idempotent, keeping the original revocation time', async () => {
    const minted = await postAsSession(`/v1/projects/checkout/tokens`, { name: 'twice', scopes: ['read'] });
    const first = await deleteAsSession(`/v1/projects/checkout/tokens/${minted.body.prefix}`);
    const second = await deleteAsSession(`/v1/projects/checkout/tokens/${minted.body.prefix}`);
    expect(second.status).toBe(200);
    expect(second.body.revokedAt).toBe(first.body.revokedAt);
  });

  it('answers 404 for an unknown prefix', async () => {
    expect((await deleteAsSession(`/v1/projects/checkout/tokens/pp_nope`)).status).toBe(404);
  });

  it('refuses a bearer credential', async () => {
    expect((await deleteWithBearer(`/v1/projects/checkout/tokens/pp_x`, ctx.readToken)).status).toBe(403);
  });
});
```

- [ ] **Step 2: Run to verify they fail, then implement**

`GET` returns `{ tokens }` from `listForProject`. `DELETE` calls `revokeByPrefix` and 404s on null. Both inherit the class-level `@UseGuards(SessionOnlyGuard)` and the same slug resolution. Dates serialise as ISO strings to match the contract.

- [ ] **Step 3: OpenAPI for both, same `cookieAuth` override.**

- [ ] **Step 4: The full gate**

```bash
source ~/.nvm/nvm.sh && nvm use
export DATABASE_URL=postgresql://perfportal:perfportal@localhost:5433/perfportal
export REDIS_URL=redis://localhost:6380
export S3_ENDPOINT=http://localhost:9000
export S3_ACCESS_KEY=perfportal
export S3_SECRET_KEY=perfportal123
pnpm typecheck && pnpm lint && pnpm test:unit && pnpm test:integration && pnpm test:e2e
```

Counts must go UP from unit 81/931 and integration 83/996; e2e stays at 86.

- [ ] **Step 5: Commit, then finish**

```bash
git add apps/api && git commit -m "feat(api): list and revoke project API tokens"
```

Then **REQUIRED SUB-SKILL: superpowers:finishing-a-development-branch.** Base is `main`; this repo merges with `--merge`, never squash.

---

## Self-Review

**Spec coverage.** §1 surface → Tasks 3 and 4. §2 session-only → Task 3's guard and its escalation tests. §3 shapes → Task 1, with the secret-once property asserted in Task 4's list test. §4 no migration → nothing to do, asserted implicitly by the suite passing without one. §5 errors → the 400/403/404 cases across Tasks 3 and 4. §6 testing → the three named tests are Task 3's escalation pair and round trip, and Task 4's revocation loop. §7 out of scope → nothing built. §8 unblocks the agent README → follow-on, not this plan.

**Placeholders.** Task 3 Step 4 and Task 4 Step 2 describe handlers in prose rather than full code, because they are mechanical given the contracts and repository already specified, and the existing `TelemetryController` is a closer model than anything I would transcribe here. Every value that must be exact — route paths, status codes, guard behaviour, the `cookieAuth` override — is stated.

**Type consistency.** `TokenSummaryRow` (persistence, `Date`) and `TokenSummarySchema` (contracts, ISO string) differ deliberately at the serialisation boundary; the controller converts, and Task 4's list test asserts the string form. `TOKEN_SCOPES` in contracts and `TokenScope` in the API are checked against each other by a test in Task 3 rather than shared, because contracts must not import from `apps/api`.

**One gap found and closed while reviewing.** The plan originally had no check that the contract's scope list and the API's union agree — a drift that would let the contract accept a scope the guard could never satisfy. Task 3's final test now pins them.
