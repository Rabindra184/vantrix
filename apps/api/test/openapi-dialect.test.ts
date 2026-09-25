import { describe, expect, it } from 'vitest';
import { buildOpenApiDocument } from '../src/openapi/document.js';

/**
 * THE DEFECT THIS GUARDS. The document declares `openapi: '3.1.0'`, which
 * uses JSON Schema 2020-12 — and it emitted `exclusiveMinimum: true` beside a
 * separate `minimum`, which is the draft-04 spelling, i.e. OpenAPI 3.0. That
 * is a TYPE ERROR against the dialect the document claims, in 14 places
 * across six response schemas.
 *
 * IT WAS NOT SUBTLE TO A MACHINE AND INVISIBLE TO A READER. A standards
 * validator refused to compile the document at all:
 *
 *     schema is invalid: data/properties/window/anyOf/0/properties/toMs/
 *                        exclusiveMinimum must be number
 *
 * Nothing in this product cares — `apiFetch` parses with zod, not with the
 * document — so the blast radius is every consumer that does: a generated
 * client, a contract test, a gateway that validates against the spec. That
 * is the same shape as the trends 400 this repository already records: a
 * defect in the published CONTRACT rather than in behaviour.
 *
 * WHY A TEST AND NOT JUST THE FIX. `zod-to-json-schema` emits the draft-04
 * form regardless of its `target:`, so the correct spelling is produced by a
 * rewrite in `schemas.ts` rather than by configuration. A library upgrade, a
 * target change, or a new numeric constraint added to any schema can all
 * reintroduce it, and none of them would fail anything else.
 */

const walk = (node: unknown, path: string, visit: (n: Record<string, unknown>, p: string) => void): void => {
  if (Array.isArray(node)) {
    node.forEach((v, i) => walk(v, `${path}/${i}`, visit));
    return;
  }
  if (node === null || typeof node !== 'object') return;
  visit(node as Record<string, unknown>, path);
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) walk(v, `${path}/${k}`, visit);
};

describe('the OpenAPI document is valid for the version it declares', () => {
  const doc = buildOpenApiDocument() as unknown as Record<string, unknown>;

  it('declares 3.1, whose dialect is what the rules below are about', () => {
    // Read rather than assumed: every assertion here is a consequence of the
    // declared version, so a document that moved to 3.0 would want the
    // OPPOSITE spellings and this suite would be wrong rather than the code.
    expect(doc['openapi']).toBe('3.1.0');
  });

  it('spells every exclusive bound as a number, not as a draft-04 flag', () => {
    const offenders: string[] = [];
    // EVERY occurrence, right or wrong. Counting only the CORRECT spelling
    // was this case's own first bug: with the fix reverted, every bound is
    // boolean, the counter reads zero, and the vacuity guard below fires —
    // so the before-state reported "this case has stopped inspecting
    // anything" for a document carrying fourteen of the defect. A vacuity
    // counter must count the CONSTRUCT, never the verdict.
    let bounds = 0;
    walk(doc, '', (node, path) => {
      for (const flag of ['exclusiveMinimum', 'exclusiveMaximum'] as const) {
        if (!(flag in node)) continue;
        bounds += 1;
        if (typeof node[flag] === 'boolean') offenders.push(`${path}/${flag} = ${String(node[flag])}`);
      }
    });

    /**
     * VACUITY, AND THIS ONE IS LOAD-BEARING RATHER THAN CEREMONIAL. If no
     * schema carried an exclusive bound at all — a zod change, a constraint
     * dropped — the offender list would be empty for ever and this case
     * would pass against a document it had stopped inspecting. The repo's
     * `.positive()` fields are what produce these, and there were 14.
     */
    expect(bounds, 'no exclusive bound anywhere — this case has stopped inspecting anything')
      .toBeGreaterThan(5);
    expect(offenders, offenders.join('; ')).toEqual([]);
  });

  /**
   * `nullable: true` IS THE SAME MISTAKE'S TWIN, and `schemas.ts` already
   * argues it: the keyword is OpenAPI 3.0-only and "meaningless — and
   * therefore a lie — once the document claims to be 3.1", where the union
   * is spelled `type: [..., 'null']` or `anyOf`. Asserted here because that
   * argument lived only in a comment, and the `target:` it depends on is one
   * word away from being changed.
   */
  it('expresses nullability as a union, never as the 3.0-only keyword', () => {
    const offenders: string[] = [];
    // Again the CONSTRUCT, not the verdict: a document that spelled every
    // union as `nullable: true` has plenty of nullable fields and zero
    // unions, and a counter that only saw unions would call that vacuous.
    let nullableFields = 0;
    walk(doc, '', (node, path) => {
      if ('nullable' in node) {
        offenders.push(`${path}/nullable`);
        nullableFields += 1;
      }
      const t = node['type'];
      if (Array.isArray(t) && t.includes('null')) nullableFields += 1;
      if (Array.isArray(node['anyOf']) && (node['anyOf'] as unknown[]).some(
        (m) => typeof m === 'object' && m !== null && (m as Record<string, unknown>)['type'] === 'null',
      )) nullableFields += 1;
    });
    expect(nullableFields, 'no nullable field anywhere — this case has stopped inspecting anything')
      .toBeGreaterThan(5);
    expect(offenders, offenders.join('; ')).toEqual([]);
  });
});
