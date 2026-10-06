/**
 * A user's search words, made safe to sit inside a `LIKE` / `ILIKE` pattern.
 *
 * `%` and `_` are wildcards and the backslash is the escape character, so a
 * reader searching `50%_off` would otherwise match `500-offset`. Every search
 * that builds `%${escapeLike(q)}%` pairs it with `ESCAPE '\'` in the SQL.
 *
 * Shared by the run list's free-text search and the org-wide test list's, so
 * the two cannot drift into escaping a different set of characters.
 */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}
