import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CreatePublicLinkRequestSchema,
  PUBLIC_LINK_MAX_EXPIRY_DAYS,
  PUBLIC_LINK_MIN_LEAD_MS,
  PUBLIC_LINK_SECRET_PATTERN,
  PublicLinkSchema,
  publicLinkExpiryProblem,
  publicLinkState,
} from '../src/public-links.js';

const NOW = new Date('2026-11-06T12:00:00.000Z');
const DAY_MS = 86_400_000;
const at = (offsetMs: number): string => new Date(NOW.getTime() + offsetMs).toISOString();

describe('publicLinkState', () => {
  it('reads revoked over expired, because the two have different causes', () => {
    // A link somebody killed last month whose expiry has passed since is
    // revoked: "expired" would be true and misleading, the tokenStatus rule.
    expect(publicLinkState({ revokedAt: at(-2 * DAY_MS), expiresAt: at(-DAY_MS) }, NOW)).toBe('revoked');
  });

  it('reads expired once the expiry has passed', () => {
    expect(publicLinkState({ revokedAt: null, expiresAt: at(-1) }, NOW)).toBe('expired');
  });

  it('reads active while the expiry is still ahead', () => {
    expect(publicLinkState({ revokedAt: null, expiresAt: at(1) }, NOW)).toBe('active');
  });

  it('reads an expiry of exactly now as expired', () => {
    expect(publicLinkState({ revokedAt: null, expiresAt: at(0) }, NOW)).toBe('expired');
  });

  it('never reads an unreadable expiry as active', () => {
    // Fail closed: a link is active only while its expiry is provably ahead.
    expect(publicLinkState({ revokedAt: null, expiresAt: 'not-an-instant' }, NOW)).toBe('expired');
  });
});

describe('publicLinkExpiryProblem', () => {
  const lead = (offsetMs: number): string | null =>
    publicLinkExpiryProblem(new Date(NOW.getTime() + offsetMs), NOW);
  const maxMs = PUBLIC_LINK_MAX_EXPIRY_DAYS * DAY_MS;

  it('refuses an expiry inside the first minute', () => {
    expect(lead(PUBLIC_LINK_MIN_LEAD_MS - 1)).not.toBeNull();
  });

  it('refuses an expiry exactly a minute ahead, because it must be strictly after', () => {
    expect(lead(PUBLIC_LINK_MIN_LEAD_MS)).not.toBeNull();
  });

  it('accepts an expiry just past the first minute', () => {
    expect(lead(PUBLIC_LINK_MIN_LEAD_MS + 1)).toBeNull();
  });

  it('accepts an expiry exactly at the furthest bound', () => {
    expect(lead(maxMs)).toBeNull();
  });

  it('refuses an expiry one millisecond past the furthest bound', () => {
    expect(lead(maxMs + 1)).not.toBeNull();
  });

  it('refuses an invalid date rather than letting it through', () => {
    // NaN fails every comparison, so a check written only as two range tests
    // would answer null for an Invalid Date — the silent accept.
    expect(publicLinkExpiryProblem(new Date(Number.NaN), NOW)).not.toBeNull();
  });

  it('pins the bounds the spec names', () => {
    expect(PUBLIC_LINK_MIN_LEAD_MS).toBe(60_000);
    expect(PUBLIC_LINK_MAX_EXPIRY_DAYS).toBe(732);
  });
});

describe('CreatePublicLinkRequestSchema', () => {
  it('accepts an instant', () => {
    expect(CreatePublicLinkRequestSchema.safeParse({ expiresAt: at(DAY_MS) }).success).toBe(true);
  });

  it('refuses a field it does not know', () => {
    // .strict(): a field the server silently ignores is one a caller believes
    // is doing something.
    expect(CreatePublicLinkRequestSchema.safeParse({ expiresAt: at(DAY_MS), extra: 1 }).success).toBe(false);
  });

  it('refuses an expiry that is not an instant', () => {
    expect(CreatePublicLinkRequestSchema.safeParse({ expiresAt: 'next tuesday' }).success).toBe(false);
  });

  it('refuses a request with no expiry, because every link expires', () => {
    expect(CreatePublicLinkRequestSchema.safeParse({}).success).toBe(false);
  });
});

describe('PublicLinkSchema', () => {
  const link = {
    id: '6f9619ff-8b86-4011-b42d-00c04fc964ff',
    state: 'active',
    createdAt: at(-DAY_MS),
    createdBy: { name: 'Asha' },
    expiresAt: at(DAY_MS),
    revokedAt: null,
    revokedBy: null,
    lastUsedAt: null,
  };

  it('accepts a link whose people and instants are null', () => {
    expect(PublicLinkSchema.safeParse({ ...link, createdBy: null }).success).toBe(true);
  });

  it('refuses a state outside the three', () => {
    expect(PublicLinkSchema.safeParse({ ...link, state: 'paused' }).success).toBe(false);
  });
});

describe('PUBLIC_LINK_SECRET_PATTERN', () => {
  const body = (n: number): string => 'a'.repeat(n);

  it('accepts a secret minted as the spec describes', () => {
    // 32 random bytes in base64url, the shape @perfportal/core mints.
    expect(PUBLIC_LINK_SECRET_PATTERN.test(`ppl_${randomBytes(32).toString('base64url')}`)).toBe(true);
  });

  it('refuses an API token prefix', () => {
    expect(PUBLIC_LINK_SECRET_PATTERN.test(`pp_${body(43)}`)).toBe(false);
  });

  it('refuses a body one character short or long', () => {
    expect(PUBLIC_LINK_SECRET_PATTERN.test(`ppl_${body(42)}`)).toBe(false);
    expect(PUBLIC_LINK_SECRET_PATTERN.test(`ppl_${body(44)}`)).toBe(false);
  });

  it('refuses the standard base64 characters base64url replaces', () => {
    expect(PUBLIC_LINK_SECRET_PATTERN.test(`ppl_${body(42)}+`)).toBe(false);
    expect(PUBLIC_LINK_SECRET_PATTERN.test(`ppl_${body(42)}/`)).toBe(false);
  });
});
