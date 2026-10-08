import type { ZodIssue } from 'zod';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, PASSWORD_UNCHANGED } from '@perfportal/contracts';

/**
 * What a form shows for a contract schema's issue.
 *
 * ═══ A PASSWORD BOUND IS ONE SENTENCE, NOT ZOD'S ENGLISH ═══
 *
 * `PasswordSchema` is a plain `z.string().min(8).max(128)`, so its issues carry
 * zod's default wording — "String must contain at least 8 character(s)" — the
 * library describing its own check. A form that sets a password shows the
 * bound instead, built from the same two constants the schema is built from,
 * so the sentence and the check cannot disagree.
 *
 * The rule is keyed on the field's NAME, exactly `password` or `newPassword`:
 * the two fields `PasswordSchema` bounds. `currentPassword` is deliberately not
 * one — it is only required, the stored hash being the authority on what it
 * may be, so "8 to 128 characters" would be false of it.
 *
 * Every other issue shows the schema's own message, as `NewProject` does: the
 * contract's custom messages are written for a person to read.
 */
export const PASSWORD_LENGTH_MESSAGE = `A password is ${PASSWORD_MIN_LENGTH} to ${PASSWORD_MAX_LENGTH} characters.`;

const PASSWORD_FIELDS: ReadonlySet<string> = new Set(['password', 'newPassword']);

export function issueMessage(issue: ZodIssue): string {
  const field = issue.path[issue.path.length - 1];
  if ((issue.code === 'too_small' || issue.code === 'too_big') && typeof field === 'string' && PASSWORD_FIELDS.has(field)) {
    return PASSWORD_LENGTH_MESSAGE;
  }
  return issue.message;
}

/**
 * Whether an issue is `ChangePasswordRequestSchema`'s "the new password is the
 * same as the current one" — read off `params.code`, never off the message
 * (which may be reworded) or the issue's position (zod reports a length issue
 * on the same field FIRST, see `fieldMessages`).
 */
export function isPasswordUnchanged(issue: ZodIssue): boolean {
  return issue.code === 'custom' && issue.params?.code === PASSWORD_UNCHANGED;
}

/**
 * One message per field, keyed by the issue's whole path joined with `.` —
 * `newPassword`, or `projects.0.projectSlug` for a row — so a form puts each
 * under the control its path names.
 *
 * ONE PER FIELD, AND "THE SAME" YIELDS TO ANYTHING ELSE. zod 3 runs an object's
 * `.refine` after its fields have failed, so an equal pair whose new password
 * is out of bounds carries two issues on `newPassword`: the bound, then
 * PASSWORD_UNCHANGED. The bound is the one to act on, and acting on it settles
 * the other — equal strings with the new one out of bounds mean the current one
 * is out of bounds too, and any new password inside them differs from it. The
 * unchanged issue is recognised by its code, so the choice does not rest on the
 * order zod happens to report them in.
 */
export function fieldMessages(issues: readonly ZodIssue[]): Readonly<Record<string, string>> {
  const messages: Record<string, string> = {};
  const deferred: Record<string, string> = {};
  for (const issue of issues) {
    const key = issue.path.join('.');
    if (isPasswordUnchanged(issue)) {
      deferred[key] ??= issueMessage(issue);
    } else {
      messages[key] ??= issueMessage(issue);
    }
  }
  for (const [key, message] of Object.entries(deferred)) messages[key] ??= message;
  return messages;
}
