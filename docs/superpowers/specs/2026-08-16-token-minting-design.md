# Minting API tokens — design

**Status:** proposed
**Date:** 2026-08-16
**Follows:** `2026-08-16-load-generator-telemetry-agent-design.md`, which shipped a
`telemetry` scope that nothing can currently issue a token for.

**Goal:** let a signed-in human create, list and revoke a project's API tokens,
so a credential can be obtained by someone who is not running this repository's
test suite.

---

## 0. The gap

`POST /v1/telemetry` authenticates with a bearer token carrying the `telemetry`
scope. **No such token can be created.** `mintToken`/`hashToken` exist in
`@perfportal/core` and are called nowhere in `apps/api/src` or
`packages/persistence/src`; `TokenRepository` exposes `findByPrefix` and
`touch` and nothing else. The only API token that has ever existed outside a
developer's database is the one `apps/api/test/support/app.ts` inserts through
Prisma in `createTestApp()`.

So the telemetry agent — built, tested, cross-compiled and merged — cannot be
run by anybody. This closes that, and in doing so gives ingest and read
credentials the same supported path.

---

## 1. Surface

Three routes on one resource, in a new `apps/api/src/tokens/`:

```text
POST   /v1/projects/:slug/tokens
GET    /v1/projects/:slug/tokens
DELETE /v1/projects/:slug/tokens/:prefix
```

The slug resolves to a project **inside the caller's org**, exactly as the
existing project-scoped routes do: a session is org-scoped and names no project
(`AuthMiddleware.authenticateSession`), so the URL supplies it and the
repository scopes the lookup. A slug belonging to another org answers 404, not
403 — the same choice `MetricsController.#run` already makes for a foreign run,
so the endpoint never confirms that someone else's project exists.

### Any scope, chosen by the caller

The request names the scopes it wants. This is not a loosening: a session
already holds `['read', 'ingest']` within its org, so a token minted with those
scopes grants nothing the caller did not already have. `telemetry` is the one
scope a session does NOT hold, and it is deliberately mintable anyway — the
scope exists to be narrower than a session, not to be unreachable from one.

RBAC does not exist yet (`authenticateSession`: *"Scopes are full within the
org; RBAC is M6"*), so "who may mint" is answered today by "any authenticated
member of the org". Inventing a role check here would be a different project,
and a worse one, because it would be the only role check in the system.

---

## 2. Session-only, and why it is the load-bearing line

**These routes must not carry `@Scopes(...)`.**

A scope check passes for any credential holding that scope, including a bearer
token. `@Scopes('read')` on a minting route therefore lets a leaked read-only
CI credential mint itself an `ingest` token — privilege escalation through the
front door, with every guard behaving exactly as designed.

The discriminator already exists and needs no new plumbing:
`authenticateSession` sets `tenant.tokenId` to `session:<session-id>`, while
`authenticateRequest` sets it to the token row's id. A bearer credential can
therefore never impersonate a session at this check.

It lives in a `@SessionOnly()` guard rather than inline in each handler, so it
reads as a policy rather than three repetitions of a condition, and so a second
credential-issuing route added later cannot quietly omit it. A bearer token
receives 403 with a message saying tokens are minted by a signed-in human, not
by a machine credential.

The OpenAPI path declares `security: [{ cookieAuth: [] }]`, overriding the
document-level "either credential" default. This is the mirror of `POST
/v1/runs`, which overrides to bearer-only because a session names no project —
here the reason is inverted, and the document must say so rather than
advertising an authentication the handler always rejects.

---

## 3. Shapes, and the secret's single moment

Contracts live in `packages/contracts/src/`, following the existing Zod style.

**Request** — `{ name, scopes }`.

`name` is required, free text. It is what a human reads in the list months
later when deciding what is safe to revoke, and an unnamed credential is one
nobody dares turn off.

`scopes` is a non-empty array validated against the `TokenScope` union. An
unknown scope is a 400 rather than a stored string: a garbage scope would
authenticate and match nothing, producing a token that fails every request for
a reason no message explains. An empty array is likewise a 400 — a token that
authenticates and can do nothing is a confusing thing to hand somebody.

**Mint response** — the only moment the plaintext exists anywhere:

```
{ token: "pp_<prefix>_<secret>", prefix, name, scopes, createdAt }
```

Only `tokenHash` is persisted, so this value cannot be recovered or re-derived.
The OpenAPI description says so in as many words; a caller who loses it mints a
new token.

**List response** — the same fields minus `token`, plus `lastUsedAt` and
`revokedAt`. Never the hash, never the secret.

`lastUsedAt` is what makes the list actionable rather than decorative: it is how
an operator finds the credential nothing has used since March.
`authenticateRequest` already maintains it, throttled by
`TOKEN_TOUCH_INTERVAL_MS` to at most one write per minute per token, so the
field costs nothing to expose.

**Revoke** sets `revokedAt` and returns the updated record rather than a bare
204, so the caller sees *when* it was revoked and a retry returns the same
answer instead of ambiguity.

### Revoke by prefix

When a token leaks, what the operator holds is the token string — and the
prefix is the middle of `pp_<prefix>_<secret>`. Revoking by prefix is therefore
directly actionable during an incident; revoking by id would require a lookup
first. The prefix is already unique-indexed, because verification depends on
it.

> **Correction, 2026-08-16.** The line above is wrong about which part of the
> token the prefix is. `packages/core/src/tokens.ts`'s `mintToken` builds the
> token as `` `${prefix}_${secret}` `` where `prefix` is already
> `` `pp_${randomBytes(PREFIX_BYTES).toString('hex')}` `` — so `prefix` is
> `pp_<hex>`, **including the leading `pp_`**, i.e. everything up to the LAST
> underscore of `pp_<hex>_<secret>`. It is not "the middle" of anything; there
> is no third segment for it to sit between.
>
> This is not academic: the OpenAPI description for the `prefix` path
> parameter and this repository's own `TokenRepository.revokeByPrefix`
> docstring both repeated the same "middle segment" claim (now fixed) before
> this correction was written. An operator who trusted the published
> OpenAPI description during an incident, holding a leaked
> `pp_ab12cd34ef56_<secret>`, would extract only the hex segment and send
> `DELETE .../tokens/ab12cd34ef56` — which 404s, reading as "already revoked,
> nothing to do" on the one route that exists for incidents. The correct
> value to send is the whole `pp_ab12cd34ef56`.

### Repository

`TokenRepository` gains `create`, `listForProject` and `revokeByPrefix`. It is
read-only today, so all three are additive and nothing existing changes.

---

## 4. No migration

`ApiToken` already carries `name`, `scopes`, `createdAt`, `lastUsedAt` and
`revokedAt`. **`revokedAt` has been checked on every authentication since it
was created and has never been written by anything** — `authenticateRequest`
rejects a revoked token today. Revocation is therefore half-built already, and
this supplies the missing half without touching the schema.

**Tokens do not expire.** The two `expiresAt` columns in `schema.prisma` belong
to `Session` and `Verification`, better-auth's own tables; `ApiToken` has none,
deliberately. Revocation covers the credential you know leaked, and
`lastUsedAt` makes the forgotten one visible. Adding expiry later is an
additive nullable column plus one check beside the existing `revokedAt` one —
genuinely easy, unlike widening a credential surface after it has issued
credentials.

---

## 5. Errors

| Condition | Answer |
|---|---|
| No credential | 401 (the middleware already does this) |
| Bearer token on any of these routes | 403 — session-only |
| Slug outside the caller's org | 404, not 403 |
| Unknown scope, empty scopes, missing name | 400 |
| DELETE on an unknown prefix | 404 |
| DELETE on an already-revoked token | Succeeds, returns the same record |

---

## 6. Testing

Integration only. This is an API surface with no UI, so the e2e suite gains
nothing from it.

**The escalation test, in both directions.** A bearer `read` token gets 403; a
bearer `ingest` token gets 403; a session succeeds. This is the feature's
security property, and it is the assertion that would silently keep passing if
someone replaced the session check with `@Scopes('read')` — a plausible-looking
simplification that reintroduces the escalation exactly.

**A round trip proving the credential works**, not merely that a row was
written: mint a `telemetry` token, then POST real telemetry with it and expect
202. Without this, every other assertion could pass against a token the API
will not actually accept.

**Revocation biting end to end**: mint, use successfully, revoke, use again,
expect 401. `revokedAt` has been checked-but-never-written since it existed, so
this is the first test that closes that loop.

Plus: the secret never appears in a list response; a `telemetry`-scoped token
still cannot upload a bundle; unknown and empty scope arrays are 400s; a slug
in another org is 404.

Expectations derived from the payload, never written down.

---

## 7. Deliberately not here

- **Expiry** — §4.
- **RBAC.** No role system exists; this would be the only role check in the
  product.
- **Rate limiting.** Nothing in the API has it; adding it for one route would
  be inconsistent and would not be where it belongs.
- **A UI.** The endpoint is the surface an admin UI would call. Building the UI
  first would fix its shape before anything has used it.
- **Rotation.** Mint-new-then-revoke-old is rotation, expressed with the two
  routes that exist.
- **Who minted this token.** `ApiToken` carries `name`, `createdAt`,
  `lastUsedAt` and `revokedAt`, and no `createdByUserId`. The controller has
  the minting session's user in hand (the same session `SessionOnlyGuard`
  requires) and discards it. This is the first code path that issues
  credentials outside the test harness, and "who issued this" is normally
  the first question asked of a credential during an incident — after which
  the answer is permanently unavailable, because nothing wrote it down at
  mint time. Recording it needs a `createdByUserId` column, which is a
  migration; out of scope for this sub-project, but it should be near the
  top of whichever one comes next.

---

## 8. What this unblocks

`agent/README.md` — the install and distribution story spec §9 of the telemetry
design required and the plan under-delivered. It cannot be written honestly
until there is a supported way to obtain the credential its first paragraph
would have to tell the reader to get.
