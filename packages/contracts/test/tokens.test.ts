import { describe, expect, it } from 'vitest';
import { MintTokenRequestSchema } from '../src/tokens.js';

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
