import { ACCESS_ACTIONS, roleName, type AccessAction } from '@perfportal/contracts';

/**
 * The sentence an operation's description opens with: which role a signed-in
 * session needs to perform `action`, read from the row `AccessGuard` judges by
 * (`ACCESS_ACTIONS`), so the document cannot say one role while the guard
 * asks for another.
 *
 * Three shapes, one per kind of requirement:
 *   - an admin action names no project role, because none can grant it;
 *   - a viewer action is open to ANY role in the project, which is said
 *     plainly rather than as "the Viewer role or above";
 *   - any other names its role, which every role ranked above it also meets.
 *
 * It speaks of SESSIONS only: a bearer token is judged by its scopes, never by
 * a role, so whatever an operation says about tokens follows this sentence.
 */
export function sessionAccessSentence(action: AccessAction): string {
  const { role } = ACCESS_ACTIONS[action];
  if (role === 'admin') return 'A signed-in session needs an admin account.';
  if (role === 'viewer') return 'A signed-in session needs any role in this project, or an admin account.';
  return `A signed-in session needs the ${roleName(role)} role or above in this project, or an admin account.`;
}
