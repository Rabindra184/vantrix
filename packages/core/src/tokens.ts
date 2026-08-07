import { randomBytes } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';

const PREFIX_BYTES = 6;   // 12 hex chars — the indexed lookup key
const SECRET_BYTES = 24;  // 48 hex chars

/**
 * Token layout: pp_<prefix-hex>_<secret-hex>
 *
 * The prefix is stored in an indexed unique column so verification is exactly
 * one row read plus one Argon2 verification, rather than hashing against every
 * token in the table.
 *
 * Lives in @perfportal/core (not apps/api) so the API's auth guard and any
 * out-of-process credential minting (see packages/persistence/scripts/bootstrap.ts)
 * share exactly one implementation of the token format — a second one is
 * exactly the kind of drift this codebase has already paid for twice.
 */
export function mintToken(): { token: string; prefix: string } {
  const prefix = `pp_${randomBytes(PREFIX_BYTES).toString('hex')}`;
  const secret = randomBytes(SECRET_BYTES).toString('hex');
  return { token: `${prefix}_${secret}`, prefix };
}

const HEX = /^[0-9a-f]+$/;

export function splitToken(token: string): { prefix: string; secret: string } | null {
  const parts = token.split('_');
  if (parts.length !== 3) return null;
  const [scheme, prefixBody, secret] = parts;
  if (scheme !== 'pp' || !prefixBody || !secret) return null;
  // A well-formed prefix/secret is hex-only; anything else (e.g. "pp_only_two")
  // has the right shape but is not a token we ever minted.
  if (!HEX.test(prefixBody) || !HEX.test(secret)) return null;
  return { prefix: `pp_${prefixBody}`, secret };
}

export function hashToken(secret: string): Promise<string> {
  return hash(secret);
}

/** Never throws: a corrupt stored hash is a verification failure, not a 500. */
export async function verifyToken(storedHash: string, secret: string): Promise<boolean> {
  try {
    return await verify(storedHash, secret);
  } catch {
    return false;
  }
}
