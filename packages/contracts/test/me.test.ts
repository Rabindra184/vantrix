import { describe, expect, it } from 'vitest';
import {
  ChangePasswordRequestSchema,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  PasswordSchema,
} from '../src/index.js';

/**
 * Imported through the package index, so a module nobody exported fails here
 * rather than in the API that consumes it.
 */
describe('PasswordSchema', () => {
  /**
   * 8 and 128 are Better Auth's own defaults, and `auth.api.createUser` does
   * not check them — so these bounds are the only thing standing between an
   * admin's typo and an account whose password Better Auth itself would have
   * refused at sign-up.
   */
  it('takes Better Auth’s default bounds, 8 to 128 characters', () => {
    expect(PASSWORD_MIN_LENGTH).toBe(8);
    expect(PASSWORD_MAX_LENGTH).toBe(128);
  });

  it.each([
    [7, false],
    [8, true],
    [128, true],
    [129, false],
  ])('a password of %i characters is accepted: %s', (length, accepted) => {
    expect(PasswordSchema.safeParse('p'.repeat(length)).success).toBe(accepted);
  });

  /**
   * A password's whitespace is part of the secret. Better Auth's sign-in
   * verifies exactly the string it is sent, so a trimmed stored password is
   * one the person can never type back in. The pair: leading and trailing
   * spaces survive, AND they count toward the length — seven letters and a
   * space is eight characters, which is what Better Auth would count too.
   */
  it('keeps surrounding whitespace, and counts it', () => {
    expect(PasswordSchema.parse('  secret1  ')).toBe('  secret1  ');
    expect(PasswordSchema.safeParse(' abcdefg').success).toBe(true);
    expect(PasswordSchema.safeParse('abcdefg').success).toBe(false);
  });
});

describe('ChangePasswordRequestSchema', () => {
  const valid = { currentPassword: 'old-password', newPassword: 'new-password' };

  it('accepts a current and a different new password', () => {
    expect(ChangePasswordRequestSchema.parse(valid)).toEqual(valid);
  });

  it.each([
    [7, false],
    [8, true],
    [128, true],
    [129, false],
  ])('a new password of %i characters is accepted: %s', (length, accepted) => {
    const r = ChangePasswordRequestSchema.safeParse({ ...valid, newPassword: 'n'.repeat(length) });
    expect(r.success).toBe(accepted);
  });

  /**
   * The current password is checked by Better Auth against what is stored, so
   * the schema asks only that one was sent. Any length is a question for the
   * stored hash, not for this schema — an account created before the bounds
   * were enforced here may hold a password outside them.
   */
  it('requires a current password but does not bound it', () => {
    expect(ChangePasswordRequestSchema.safeParse({ newPassword: 'new-password' }).success).toBe(false);
    expect(ChangePasswordRequestSchema.safeParse({ ...valid, currentPassword: '' }).success).toBe(false);
    expect(ChangePasswordRequestSchema.safeParse({ ...valid, currentPassword: 'x' }).success).toBe(true);
  });

  /**
   * The spec's rule: the new password must differ from the current one. A
   * person forced to change a temporary password who types it back has
   * changed nothing, and the flag would clear over the same secret an admin
   * typed.
   */
  it('refuses a new password equal to the current one, on the new password field', () => {
    const r = ChangePasswordRequestSchema.safeParse({
      currentPassword: 'same-password',
      newPassword: 'same-password',
    });
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error.issues).toEqual([
      expect.objectContaining({
        path: ['newPassword'],
        message: 'The new password is the same as the current one.',
      }),
    ]);
  });

  /** Untrimmed on both sides, so whitespace is a real difference — the same
   *  difference Better Auth's own comparison sees. */
  it('treats a password differing only in surrounding whitespace as different', () => {
    const r = ChangePasswordRequestSchema.safeParse({
      currentPassword: 'same-password',
      newPassword: ' same-password',
    });
    expect(r.success).toBe(true);
  });

  it('refuses a field it does not know', () => {
    expect(ChangePasswordRequestSchema.safeParse({ ...valid, userId: 'someone-else' }).success).toBe(false);
  });
});
