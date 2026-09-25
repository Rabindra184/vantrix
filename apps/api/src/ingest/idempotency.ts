import { IdempotencyKeySchema } from '@perfportal/contracts';
import { badRequest } from '../common/validation.js';

/**
 * The header FR-ING-7 specifies. Lower-case because Node normalises incoming
 * header names, so this is the key `req.headers` is actually indexed by.
 */
export const IDEMPOTENCY_HEADER = 'idempotency-key';

/**
 * The one idempotency key for an ingest request, from the header or the
 * metadata field.
 *
 * WHY THIS EXISTS: FR-ING-7 is a P0 requirement and says "an optional
 * `Idempotency-Key` HEADER, unique per project, causes a repeat to return the
 * existing run rather than create a duplicate". AC-ING-5 restates it and
 * §"Idempotency" says it applies to all unsafe ingest operations. Measured
 * against a real API before this existed, the header was not merely ignored
 * for dedupe — it never reached the column at all:
 *
 *     header   Idempotency-Key: k  x2  ->  two runs, both idempotency_key NULL
 *     metadata idempotencyKey: k    x2  ->  ONE run, the second returns 422
 *
 * So the capability was built and correct and reachable only through the
 * metadata field. A client using any off-the-shelf idempotency middleware
 * sends the IETF-standard header, gets 202, and creates a duplicate run with
 * nothing anywhere saying so — the retry the dedupe exists to absorb becoming
 * a second run, which is the failure this key was added to prevent.
 *
 * THE METADATA FIELD IS NOT DEPRECATED. Every existing client sends it, it is
 * declared in the OpenAPI document, and the Gradle plugin and Go agent both
 * build their payload around it. This widens the door rather than moving it.
 *
 * A DISAGREEMENT IS REFUSED RATHER THAN RESOLVED BY PRECEDENCE. When both are
 * present and differ, either choice silently discards one spelling of the
 * request's OWN IDENTITY — and a client that sent two different keys for one
 * request does not have an opinion worth guessing at; it has a bug, most
 * likely middleware generating a fresh header key underneath an application
 * that already set its own. Guessing makes that bug behave like working
 * dedupe until the day it does not. Refusing names it on the first request.
 *
 * The same argument covers a repeated header: two `Idempotency-Key` lines
 * with different values is the same ambiguity arriving by another route. Two
 * IDENTICAL values are not ambiguous and are accepted, because nothing about
 * the request's identity is in doubt.
 *
 * READ FROM `headersDistinct`, NEVER `headers`, AND THAT IS MEASURED RATHER
 * THAN STYLISTIC. `req.headers` COMMA-JOINS a repeated header into one
 * string, which breaks this both ways:
 *
 *     two lines xxx / yyy    headers -> 'xxx, yyy'   headersDistinct -> ['xxx','yyy']
 *     two lines same / same  headers -> 'same, same' headersDistinct -> ['same','same']
 *
 * The first makes the ambiguity undetectable — and a joined value passes
 * min(1)/max(200) happily, so it would be STORED as a key, which was observed
 * in the database as `key='xxx, yyy'` before this was corrected. The second is
 * worse: two identical headers, which are not ambiguous at all, produce a key
 * the client never sent, so the retry that repeats the header once would not
 * match it. Refusing on a comma is not the alternative — a comma is legal in a
 * key, so a joined duplicate is indistinguishable from a real value.
 * `headersDistinct` (Node 18.3+, and this repo's floor is 22) is what makes
 * the two cases separable at all.
 */
export function resolveIdempotencyKey(
  raw: string[] | undefined,
  metadataKey: string | undefined,
): string | undefined {
  if (raw === undefined || raw.length === 0) return metadataKey;

  // A repeated header. Distinct values are ambiguous; identical ones are not.
  const values = [...new Set(raw.map((v) => v.trim()))];
  if (values.length > 1) {
    throw badRequest(
      'IDEMPOTENCY_KEY_CONFLICT',
      `The request carries ${values.length} different Idempotency-Key header values.`,
      'Send the Idempotency-Key header once. Two different values leave it ' +
        'ambiguous which run this request is a retry of.',
    );
  }

  // Validated by the SAME schema the metadata field uses, so a key accepted on
  // one route cannot be refused on the other.
  const parsed = IdempotencyKeySchema.safeParse(values[0]);
  if (!parsed.success) {
    throw badRequest(
      'IDEMPOTENCY_KEY_INVALID',
      `The Idempotency-Key header is not a valid key: ${parsed.error.issues
        .map((i) => i.message)
        .join('; ')}.`,
      'Send an Idempotency-Key of 1 to 200 characters, unique per run within ' +
        'the project — a CI build id or a UUID minted once per execution and ' +
        'reused across retries.',
    );
  }
  const fromHeader = parsed.data;

  if (metadataKey !== undefined && metadataKey !== fromHeader) {
    throw badRequest(
      'IDEMPOTENCY_KEY_CONFLICT',
      `The Idempotency-Key header ("${fromHeader}") and the metadata ` +
        `idempotencyKey ("${metadataKey}") disagree.`,
      'Send one or the other, or send the same value in both. Two different ' +
        'keys leave it ambiguous which run this request is a retry of.',
    );
  }

  return fromHeader;
}
