import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * THE DEFECT THIS GUARDS. `ProblemFilter` fills `remediation` with
 * "Check the request against the OpenAPI description at /v1/openapi.json."
 * for any `HttpException` that carries none — and twenty-one throw sites
 * carried none. Measured against a real API before the fix:
 *
 *     404 NOT_FOUND  detail:      No run <uuid> in this project.
 *                    remediation: Check the request against the OpenAPI
 *                                 description at /v1/openapi.json.
 *
 * The document describes that request perfectly. `conflict()`'s own docstring
 * had already made exactly this argument — and then applied it to one status,
 * leaving the 404s and the two guard 403s behind it.
 *
 * THE RULE IS "GO THROUGH A HELPER", NOT "SAY SOMETHING". A remediation is a
 * required argument of `notFound`/`forbidden`/`badRequest`/`conflict`, so the
 * compiler already refuses one that says nothing; what it cannot see is a
 * caller bypassing them with a bare `new XException(...)`. That is the shape
 * that actually happened, so that is what this bans.
 */

const API_SRC = `${process.cwd()}/apps/api/src`;

/**
 * EXEMPT, AND MEASURED RATHER THAN ASSUMED. `AuthMiddleware` catches every
 * `HttpException` thrown out of the authentication path and writes its own
 * problem document — a missing credential really does answer "Provide a
 * bearer API token in the Authorization header ... or sign in at POST
 * /auth/sign-in/email", which was confirmed against a running API both before
 * and after this change. Middleware runs BEFORE guards, which is why
 * `AuthGuard`'s scope check and `SessionOnlyGuard` are NOT exempt: they sit
 * outside that catch and fell through to the generic fallback.
 */
const EXEMPT = new Set([
  'common/validation.ts', // the helpers themselves
  'auth/auth.guard.ts', // authenticateRequest's 401s — caught by the middleware
  'auth/auth.middleware.ts', // the catch that supplies their remediation
]);

const BANNED = /new (NotFound|Forbidden|Conflict|BadRequest|Unauthorized)Exception\s*\(/;

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : full.endsWith('.ts') ? [full] : [];
  });

/**
 * COMMENTS ARE STRIPPED, AND IT IS DEFENSIVE RATHER THAN LOAD-BEARING — WHICH
 * IS STATED THAT WAY BECAUSE IT WAS MEASURED.
 *
 * This docstring first claimed the strip was load-bearing. Defanged to the
 * identity on a correct tree, the case still PASSED: no comment anywhere
 * under `apps/api/src` happens to spell `new NotFoundException(` today. So
 * the claim was false, as the same claim was on the two branches before this
 * one — and there it was repaired by adding prose that quoted the banned
 * shape, which makes the test pass for a reason nobody would choose on
 * purpose. Writing documentation to justify a line of test code is the wrong
 * direction, so the third time the CLAIM is corrected instead.
 *
 * The strip stays. It costs one line and forecloses a false positive this
 * repository has hit six times — a source-scanning guard failing on the
 * paragraph that explains the rule rather than on code breaking it — and the
 * day somebody documents this ban at a call site, it starts earning its
 * keep with no edit here.
 */
const strip = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

describe('every problem document states a fix the caller can act on', () => {
  it('lets no handler construct an HttpException outside the remediation helpers', () => {
    const files = walk(API_SRC);
    // Vacuity: a collector that stopped finding files would report no
    // offenders for ever, which reads exactly like a clean tree.
    expect(files.length, 'collected no API sources — the path has rotted').toBeGreaterThan(20);

    const offenders: string[] = [];
    for (const file of files) {
      const rel = file.slice(API_SRC.length + 1);
      if (EXEMPT.has(rel)) continue;
      for (const line of strip(readFileSync(file, 'utf8')).split('\n')) {
        if (BANNED.test(line)) offenders.push(`${rel}: ${line.trim()}`);
      }
    }
    expect(offenders, offenders.join('; ')).toEqual([]);
  });

  /**
   * AND THE EXEMPTIONS ARE ASSERTED TO BE REACHABLE, so the list cannot rot
   * into three names that match nothing while the guard reports green. An
   * exemption for a file that no longer constructs one is an exemption
   * nobody notices has become a lie.
   */
  it('keeps every exemption earning its place', () => {
    for (const rel of EXEMPT) {
      const src = strip(readFileSync(join(API_SRC, rel), 'utf8'));
      expect(
        src.split('\n').some((l) => BANNED.test(l)),
        `${rel} is exempt and constructs no HttpException — drop it from EXEMPT`,
      ).toBe(true);
    }
  });
});
