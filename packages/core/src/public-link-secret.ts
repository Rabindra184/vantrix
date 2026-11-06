import { createHash, randomBytes } from 'node:crypto';

const SECRET_BYTES = 32; // 43 base64url characters

/**
 * A public link's secret: `ppl_` and 32 random bytes in base64url, the shape
 * `PUBLIC_LINK_SECRET_PATTERN` in @perfportal/contracts accepts.
 *
 * Lives here beside `mintToken` so the API and anything minting out of process
 * share one implementation of the format.
 */
export function mintPublicLinkSecret(): string {
  return `ppl_${randomBytes(SECRET_BYTES).toString('base64url')}`;
}

/**
 * What is stored and looked up: the secret's SHA-256, as lowercase hex.
 *
 * SHA-256, NOT Argon2 as API tokens are. The secret carries 256 bits of
 * entropy, so a slow hash adds nothing against guessing — and a link is
 * checked on every request its page makes, about twenty when a Report opens,
 * where Argon2 would cost real time per page. Being deterministic is also what
 * lets the credential be found by its hash through a unique index, with no
 * prefix split and no comparison loop.
 */
export function hashPublicLinkSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}
