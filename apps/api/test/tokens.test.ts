import { describe, expect, it } from 'vitest';
import { hashToken, mintToken, splitToken, verifyToken } from '../src/auth/tokens.js';

describe('token minting', () => {
  it('produces a token whose prefix is recoverable without the secret', () => {
    const { token, prefix } = mintToken();
    expect(token.startsWith(`${prefix}_`)).toBe(true);
    expect(splitToken(token)?.prefix).toBe(prefix);
  });

  it('produces a distinct token each time', () => {
    expect(mintToken().token).not.toBe(mintToken().token);
  });

  it('rejects a malformed token instead of throwing', () => {
    expect(splitToken('nonsense')).toBeNull();
    expect(splitToken('pp_only_two')).toBeNull();
    expect(splitToken('')).toBeNull();
  });
});

describe('token verification', () => {
  it('verifies the correct secret and rejects a wrong one', async () => {
    const { token } = mintToken();
    const parts = splitToken(token)!;
    const hash = await hashToken(parts.secret);

    expect(await verifyToken(hash, parts.secret)).toBe(true);
    expect(await verifyToken(hash, `${parts.secret}x`)).toBe(false);
  });

  it('does not store the secret in the hash', async () => {
    const { token } = mintToken();
    const parts = splitToken(token)!;
    const hash = await hashToken(parts.secret);
    expect(hash).not.toContain(parts.secret);
  });

  it('returns false rather than throwing on a corrupt stored hash', async () => {
    expect(await verifyToken('not-a-real-argon2-hash', 'whatever')).toBe(false);
  });
});
