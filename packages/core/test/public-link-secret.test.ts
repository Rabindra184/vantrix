import { describe, expect, it } from 'vitest';
import { hashPublicLinkSecret, mintPublicLinkSecret } from '../src/public-link-secret.js';

/**
 * PUBLIC_LINK_SECRET_PATTERN in @perfportal/contracts, restated because this
 * package does not depend on that one and must not: core sits below the wire
 * contracts. The decode case below is what makes this more than a copy — it
 * checks the 32 bytes the pattern's 43 characters stand for.
 */
const SECRET_SHAPE = /^ppl_[A-Za-z0-9_-]{43}$/;

describe('mintPublicLinkSecret', () => {
  it('mints ppl_ followed by 43 base64url characters', () => {
    expect(mintPublicLinkSecret()).toMatch(SECRET_SHAPE);
  });

  it('carries exactly 32 bytes, encoded canonically', () => {
    const secret = mintPublicLinkSecret();
    const bytes = Buffer.from(secret.slice('ppl_'.length), 'base64url');
    expect(bytes).toHaveLength(32);
    expect(`ppl_${bytes.toString('base64url')}`).toBe(secret);
  });

  it('mints a different secret every time', () => {
    const minted = new Set(Array.from({ length: 1000 }, () => mintPublicLinkSecret()));
    expect(minted.size).toBe(1000);
  });
});

describe('hashPublicLinkSecret', () => {
  it('is the lowercase hex SHA-256 of the secret', () => {
    // Computed once with node's createHash('sha256').update('ppl_x').digest('hex').
    expect(hashPublicLinkSecret('ppl_x')).toBe('58b088d7f884f4b13bc2033fb94f2f7d258b7ce12bf4c15d3f81fb22734e7976');
  });
});
