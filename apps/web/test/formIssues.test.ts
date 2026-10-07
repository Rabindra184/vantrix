import { describe, expect, it } from 'vitest';
import type { ZodIssue } from 'zod';
import {
  ChangePasswordRequestSchema,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  PASSWORD_UNCHANGED,
  SetPasswordRequestSchema,
} from '@perfportal/contracts';
import { fieldMessages, isPasswordUnchanged, issueMessage, PASSWORD_LENGTH_MESSAGE } from '../src/formIssues.js';

/**
 * ═══ A FORM MUST NOT READ ZOD'S DEFAULT ENGLISH TO A PERSON ═══
 *
 * `PasswordSchema` is a plain `z.string().min(8).max(128)`, so a short password
 * fails with "String must contain at least 8 character(s)" — the library
 * describing its own check. Every form that sets a password (change your own,
 * create a user, reset one) shows the bound as one sentence instead, built
 * from the same two constants the schema is built from.
 */
function issuesOf(result: { success: boolean; error?: { issues: ZodIssue[] } }): ZodIssue[] {
  if (result.success || result.error === undefined) throw new Error('expected the parse to fail');
  return result.error.issues;
}

const longEnough = 'x'.repeat(PASSWORD_MIN_LENGTH);

describe('issueMessage — a password bound is one sentence', () => {
  it('is built from the two constants, not written down', () => {
    expect(PASSWORD_LENGTH_MESSAGE).toBe(
      `A password is ${PASSWORD_MIN_LENGTH} to ${PASSWORD_MAX_LENGTH} characters.`,
    );
  });

  it('replaces a too-short new password’s issue', () => {
    const [issue] = issuesOf(
      ChangePasswordRequestSchema.safeParse({ currentPassword: 'old-password', newPassword: 'short' }),
    );
    expect(issue?.code).toBe('too_small');
    expect(issueMessage(issue!)).toBe(PASSWORD_LENGTH_MESSAGE);
  });

  /** `password`, the field an admin types a temporary password into, is the
   *  other name the rule reaches — Tasks 7 and 8 read it through here. */
  it('replaces a too-long temporary password’s issue', () => {
    const [issue] = issuesOf(SetPasswordRequestSchema.safeParse({ password: 'x'.repeat(PASSWORD_MAX_LENGTH + 1) }));
    expect(issue?.code).toBe('too_big');
    expect(issueMessage(issue!)).toBe(PASSWORD_LENGTH_MESSAGE);
  });

  /**
   * THE CURRENT PASSWORD IS NOT BOUND BY 8 TO 128. It is only required, and the
   * stored hash is the authority on what it may be — so telling someone their
   * current password must be 8 to 128 characters would be false. The rule is
   * keyed on the field NAME, exactly: `currentPassword` ends in "Password" and
   * is not one of the two.
   */
  it('leaves the current password’s issue alone', () => {
    const [issue] = issuesOf(
      ChangePasswordRequestSchema.safeParse({ currentPassword: '', newPassword: longEnough }),
    );
    expect(issue?.path).toEqual(['currentPassword']);
    expect(issueMessage(issue!)).toBe(issue!.message);
    expect(issueMessage(issue!)).not.toBe(PASSWORD_LENGTH_MESSAGE);
  });

  it('shows every other issue in the schema’s own words', () => {
    const issue: ZodIssue = { code: 'custom', path: ['projects', 0, 'projectSlug'], message: '"checkout" is listed more than once.' };
    expect(issueMessage(issue)).toBe('"checkout" is listed more than once.');
  });
});

describe('PASSWORD_UNCHANGED is found by its code', () => {
  /**
   * zod 3 runs an object's `.refine` after its fields have failed, so an equal
   * pair that is also too short reports the LENGTH issue first and the
   * unchanged one second. "The first issue" is therefore the wrong way to find
   * it, and so is its message, which may be reworded.
   */
  it('is the second issue when the pair is also too short', () => {
    const issues = issuesOf(ChangePasswordRequestSchema.safeParse({ currentPassword: 'abc', newPassword: 'abc' }));
    expect(issues.map(isPasswordUnchanged)).toEqual([false, true]);
  });

  it('matches the code whatever the message says, and not the message without the code', () => {
    const coded: ZodIssue = { code: 'custom', path: ['newPassword'], message: 'Reworded.', params: { code: PASSWORD_UNCHANGED } };
    const worded: ZodIssue = {
      code: 'custom',
      path: ['newPassword'],
      message: 'The new password is the same as the current one.',
    };
    expect(isPasswordUnchanged(coded)).toBe(true);
    expect(isPasswordUnchanged(worded)).toBe(false);
  });
});

describe('fieldMessages — one message under each field', () => {
  it('keys each message by the field its path names', () => {
    const issues = issuesOf(ChangePasswordRequestSchema.safeParse({ currentPassword: '', newPassword: 'short' }));
    const messages = fieldMessages(issues);
    expect(Object.keys(messages).sort()).toEqual(['currentPassword', 'newPassword']);
    expect(messages.newPassword).toBe(PASSWORD_LENGTH_MESSAGE);
  });

  it('says a new password equal to the current one is the same, when nothing else is wrong with it', () => {
    const messages = fieldMessages(
      issuesOf(ChangePasswordRequestSchema.safeParse({ currentPassword: longEnough, newPassword: longEnough })),
    );
    expect(messages.newPassword).toBe('The new password is the same as the current one.');
  });

  /**
   * ═══ A LENGTH FIX SETTLES THE OTHER ONE, SO THE LENGTH IS WHAT IS SAID ═══
   *
   * Two equal strings with the new one out of bounds means the current one is
   * out of bounds too, and any new password inside them differs from it. So
   * the bound is the message to act on — chosen by the unchanged issue's CODE,
   * which is why the answer is the same in either order.
   */
  it('prefers the length sentence over "the same", in either order', () => {
    const issues = issuesOf(ChangePasswordRequestSchema.safeParse({ currentPassword: 'abc', newPassword: 'abc' }));
    expect(fieldMessages(issues).newPassword).toBe(PASSWORD_LENGTH_MESSAGE);
    expect(fieldMessages([...issues].reverse()).newPassword).toBe(PASSWORD_LENGTH_MESSAGE);
  });

  /** A nested path keys by the whole of it, so two project rows' issues land
   *  under their own rows rather than overwriting each other. */
  it('keys a nested path by all of its segments', () => {
    const messages = fieldMessages([
      { code: 'custom', path: ['projects', 0, 'projectSlug'], message: 'First.' },
      { code: 'custom', path: ['projects', 1, 'projectSlug'], message: 'Second.' },
    ]);
    expect(messages).toEqual({ 'projects.0.projectSlug': 'First.', 'projects.1.projectSlug': 'Second.' });
  });
});
