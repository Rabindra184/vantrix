import { z } from 'zod';

/**
 * Better Auth's own default password bounds (`minPasswordLength`,
 * `maxPasswordLength`), which `packages/persistence/src/auth.ts` does not
 * override. Better Auth's sign-up and its password-changing routes enforce
 * them; the admin plugin's `createUser` does NOT, so a request schema that
 * creates or sets a password has to — or an admin could hand someone a
 * temporary password Better Auth itself would have refused.
 *
 * Both count `string.length` (UTF-16 code units), the same unit Better Auth
 * compares, so the two agree on every password.
 */
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

/**
 * A password someone chooses or an admin types, wherever one is sent.
 *
 * NOT TRIMMED, and that is the point rather than an oversight. A password's
 * whitespace is part of the secret: Better Auth's sign-in verifies exactly the
 * string it is sent, so a trimmed stored password is one the person can never
 * type back in. `trimmed-input.test.ts` exempts this line by name and says so.
 */
export const PasswordSchema = z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH);

/**
 * The body of `PUT /v1/me/password`: change your own password, which also
 * clears a forced change.
 *
 * `currentPassword` is only required, never bounded: Better Auth checks it
 * against the stored hash, and that check is the authority on what it may be.
 * It is untrimmed for the same reason as `PasswordSchema`.
 *
 * The refinement is the spec's rule that the new password must differ from
 * the current one — a person forced to replace a temporary password who types
 * it back would clear the flag over the same secret an admin chose. Compared
 * untrimmed, as Better Auth would compare them.
 */
export const ChangePasswordRequestSchema = z
  .object({
    currentPassword: z.string().min(1),
    newPassword: PasswordSchema,
  })
  .strict()
  .refine((body) => body.newPassword !== body.currentPassword, {
    path: ['newPassword'],
    message: 'The new password is the same as the current one.',
  });
export type ChangePasswordRequest = z.infer<typeof ChangePasswordRequestSchema>;
