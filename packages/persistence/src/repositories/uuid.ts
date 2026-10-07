/**
 * A UUID as the API's `uuidParam` accepts one: 8-4-4-4-12 hex, either case —
 * the same pattern as Nest's `ParseUUIDPipe` with no version. Postgres takes
 * more (braces, no hyphens), so this is narrower than the `uuid` column on
 * purpose.
 *
 * Two readers have to refuse EXACTLY what that pipe refuses:
 * `RunRepository.projectIdOf`, which answers null without a query for any
 * other id, and `AccessGuard`, which leaves such an id to the pipe's 400 and
 * answers a well-formed one it cannot find with a 404. A test in
 * apps/api/test/access.test.ts holds this function against the pipe itself.
 *
 * Two more use it to keep a malformed id away from a `uuid` column, where it
 * would be a cast error rather than "not found": the live gateway's
 * `authorize`, which refuses such a run id before reading the session, and
 * `decodeOrgTestCursor`. One pattern, so none of them can drift from the
 * pipe's.
 */
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_SHAPE.test(value);
}
