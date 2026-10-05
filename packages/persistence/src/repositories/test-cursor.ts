/**
 * The opaque cursor `TestRepository.listOrg` pages by.
 *
 * ═══ THE CURSOR CARRIES THE SORT KEY, NOT A TEST ID ═══
 *
 * The first version was the last item's test id, re-resolved on the next
 * request to that test's CURRENT latest arrival. That key is not a run's start
 * time — it moves every time a run lands. If the cursor test got a new run
 * between two pages its re-read arrival was the newest in the organisation,
 * the keyset predicate ("earlier than the cursor") then matched every other
 * test, and page two repeated page one.
 *
 * So the cursor is the LAST ROW'S sort key as the reader was shown it —
 * `(latest arrival, name, id)` — and the next page is everything strictly after
 * that tuple. Nothing is re-read: the position is a fact about the page that
 * was returned, and it stays true however the data moves afterwards.
 *
 * Wire shape: base64url of `{"at": <ISO instant or null>, "name": …, "id": …}`.
 * The instant is kept at millisecond precision, which is the column's own
 * (`timestamptz(3)`), so equality against it holds.
 *
 * ═══ DECODING IS VALIDATION, AND A BAD CURSOR IS AN EMPTY PAGE ═══
 *
 * A cursor is a string a client hands back, so it can be anything. Every part
 * is checked before it is bound to a query: the `id` and the instant are cast
 * to `uuid` and `timestamptz` in SQL, where a malformed one would THROW and
 * surface as a 500 for what every other unresolvable cursor answers with an
 * empty page; and the name is refused if it holds a NUL, which Postgres will
 * not store in text and would reject the same way. `null` from `decode` means
 * "answer an empty page", never "start over" — a silent restart resurfaces
 * tests the reader already saw.
 *
 * It positions the page and nothing more. Tenancy is the WHERE clause's job and
 * every row still comes through it, so a cursor minted in another organisation
 * can only ever place the page among THIS caller's rows.
 */
export interface OrgTestCursorKey {
  /** The test's latest arrival, or null for a test that has never run. */
  readonly latestAt: Date | null;
  readonly name: string;
  readonly id: string;
}

const BASE64URL = /^[A-Za-z0-9_-]+$/;
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function encodeOrgTestCursor(key: OrgTestCursorKey): string {
  const tuple = {
    at: key.latestAt === null ? null : key.latestAt.toISOString(),
    name: key.name,
    id: key.id,
  };
  return Buffer.from(JSON.stringify(tuple), 'utf8').toString('base64url');
}

/** The key a cursor names, or null when it is not one this module minted. */
export function decodeOrgTestCursor(cursor: string): OrgTestCursorKey | null {
  if (!BASE64URL.test(cursor)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const { at, name, id } = parsed as Record<string, unknown>;

  if (typeof id !== 'string' || !UUID_SHAPE.test(id)) return null;
  if (typeof name !== 'string' || name.includes('\u0000')) return null;

  if (at === null) return { latestAt: null, name, id };
  if (typeof at !== 'string') return null;
  const latestAt = new Date(at);
  // Round-trip, so only the canonical spelling `encode` writes is accepted.
  if (Number.isNaN(latestAt.getTime()) || latestAt.toISOString() !== at) return null;
  return { latestAt, name, id };
}
