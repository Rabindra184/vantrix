import { describe, expect, it } from 'vitest';
import { MintTokenRequestSchema, TokenSummarySchema } from '../src/tokens.js';

describe('MintTokenRequestSchema', () => {
  it('accepts a named request for a known scope', () => {
    const r = MintTokenRequestSchema.safeParse({ name: 'gen-1 agent', scopes: ['telemetry'] });
    expect(r.success).toBe(true);
  });

  it('knows the runner scope', () => {
    const r = MintTokenRequestSchema.safeParse({ name: 'on-prem runner', scopes: ['runner'] });
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

describe('token expiry (review 09-13 M18)', () => {
  const base = { name: 'ci', scopes: ['read'] };

  it('accepts a request with no expiry, which is what every existing caller sends', () => {
    // The load-bearing compatibility claim: the field is additive, so a client
    // that has never heard of it must be entirely unaffected.
    expect(MintTokenRequestSchema.parse({ ...base }).expiresAt).toBeUndefined();
  });

  it('accepts a future expiry', () => {
    const at = new Date(Date.now() + 86_400_000).toISOString();
    expect(MintTokenRequestSchema.parse({ ...base, expiresAt: at }).expiresAt).toBe(at);
  });

  it('refuses an expiry in the past, which would mint a credential that never works', () => {
    // A typo, never an intention — and one a caller would otherwise debug
    // against the server rather than against their own request.
    const past = new Date(Date.now() - 1000).toISOString();
    const r = MintTokenRequestSchema.safeParse({ ...base, expiresAt: past });
    expect(r.success).toBe(false);
    expect(r.success === false && r.error.issues[0]?.path).toEqual(['expiresAt']);
  });

  it('still refuses unknown keys, so the strict contract survived the addition', () => {
    // `.strict()` runs before `.refine()`; a refinement layered on a schema
    // that had started stripping instead would silently accept typo'd names.
    expect(MintTokenRequestSchema.safeParse({ ...base, expires: 'nope' }).success).toBe(false);
  });

  it('reads a summary from an API that predates the field', () => {
    // `.nullable().optional()`, and the OPTIONAL half is the one that matters:
    // the browser drops any body failing this schema, so during a rolling
    // deploy an older pod's response must still parse rather than blanking the
    // entire token list. Same reasoning the trends contract carries.
    const old = {
      prefix: 'pp_abc',
      name: 'ci',
      scopes: ['read'],
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
      revokedAt: null,
    };
    expect(TokenSummarySchema.parse(old).expiresAt).toBeUndefined();
    expect(TokenSummarySchema.parse({ ...old, expiresAt: null }).expiresAt).toBeNull();
  });
});
