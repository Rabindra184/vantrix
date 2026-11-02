import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CreateProjectRequestSchema, CreateUserRequestSchema, DeclaredTestSlugSchema } from '../src/index.js';

/**
 * ═══ A BOUND A PERSON CAN TRIP SAYS WHAT TO DO, NEVER ZOD'S OWN CHECK ═══
 *
 * New project, Add user and New on-prem run show a contract issue's message
 * under the field. Without a message of its own a bound carries zod's default,
 * and zod 4 rewrote those into the library describing itself — "Too small:
 * expected string to have >=2 characters" where zod 3 had "String must
 * contain at least 2 character(s)". The upgrade put that on New project.
 *
 * Each case asks zod what it WOULD have said for the same check, rather than
 * pinning today's wording, so this fails the day a bound loses its message
 * whatever zod's English has become by then.
 */
const zodSays = (schema: z.ZodType, value: unknown): string =>
  schema.safeParse(value).error?.issues[0]?.message ?? '';

const firstMessage = (schema: z.ZodType, value: unknown): string => {
  const result = schema.safeParse(value);
  if (result.success) throw new Error(`expected ${JSON.stringify(value)} to be refused`);
  return result.error.issues[0]?.message ?? '';
};

const long = (n: number): string => 'a'.repeat(n);

const CASES: readonly [string, z.ZodType, unknown, z.ZodType, unknown][] = [
  ['an empty project name', CreateProjectRequestSchema, { name: ' ', slug: 'ok' }, z.string().trim().min(1), ' '],
  ['a long project name', CreateProjectRequestSchema, { name: long(121), slug: 'ok' }, z.string().max(120), long(121)],
  ['a one-letter slug', CreateProjectRequestSchema, { name: 'Checkout', slug: 'a' }, z.string().min(2), 'a'],
  ['a long slug', CreateProjectRequestSchema, { name: 'Checkout', slug: long(81) }, z.string().max(80), long(81)],
  ['an empty user name', CreateUserRequestSchema, { email: 'a@example.com', name: ' ', password: 'long-enough' }, z.string().trim().min(1), ' '],
  ['a long user name', CreateUserRequestSchema, { email: 'a@example.com', name: long(121), password: 'long-enough' }, z.string().max(120), long(121)],
  ['a malformed email', CreateUserRequestSchema, { email: 'a@b', name: 'Asha', password: 'long-enough' }, z.string().email(), 'a@b'],
  ['a long test slug', DeclaredTestSlugSchema, long(201), z.string().max(200), long(201)],
];

describe('the messages a form shows', () => {
  it.each(CASES)('%s is refused in the contract’s words', (_name, schema, value, bare, bareValue) => {
    const library = zodSays(bare, bareValue);
    // Vacuity: the bare check must really fail, or "differs from zod" proves nothing.
    expect(library, 'the bare check passed — this case compares nothing').not.toBe('');
    const message = firstMessage(schema, value);
    expect(message).not.toBe(library);
    expect(message).not.toBe('');
  });
});
