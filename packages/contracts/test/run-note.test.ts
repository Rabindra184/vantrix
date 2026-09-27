import { describe, expect, it } from 'vitest';
import {
  NOTE_MAX_LENGTH,
  RunIdentitySchema,
  RunListResponseSchema,
  RunNoteRequestSchema,
  RunNoteResponseSchema,
} from '../src/index.js';

/**
 * ═══ THE RUN NOTE ON THE WIRE ═══
 * (docs/superpowers/specs/2026-09-27-run-note-design.md)
 *
 * A note a PERSON writes on a run after the fact. Trimmed like every bounded
 * human-typed string in this package, with whitespace alone refused rather
 * than stored as a second spelling of "no note".
 */
const MINIMAL_IDENTITY = {
  id: '0f9b1d4e-1111-2222-3333-444455556666',
  project: { id: '11111111-1111-4111-8111-111111111111', slug: 'checkout', name: 'Checkout' },
  tool: 'gatling',
  startedAt: '2026-09-27T09:00:00.000Z',
};

const NOTE = {
  text: 'baseline after the cache change',
  updatedAt: '2026-09-27T09:30:00.000Z',
  updatedBy: { name: 'Asha' },
};

describe('RunNoteRequest — what a person may write', () => {
  it('trims the note before judging it', () => {
    expect(RunNoteRequestSchema.parse({ note: '  flaky environment, ignore \n' })).toEqual({
      note: 'flaky environment, ignore',
    });
  });

  it(`accepts ${NOTE_MAX_LENGTH} characters and refuses one more`, () => {
    expect(RunNoteRequestSchema.safeParse({ note: 'x'.repeat(NOTE_MAX_LENGTH) }).success).toBe(true);
    expect(RunNoteRequestSchema.safeParse({ note: 'x'.repeat(NOTE_MAX_LENGTH + 1) }).success).toBe(false);
  });

  it('measures the limit AFTER trimming, so padding cannot push a note over it', () => {
    expect(RunNoteRequestSchema.safeParse({ note: `  ${'x'.repeat(NOTE_MAX_LENGTH)}  ` }).success).toBe(true);
  });

  it('refuses whitespace alone rather than storing an empty note', () => {
    expect(RunNoteRequestSchema.safeParse({ note: '   \n\t ' }).success).toBe(false);
  });

  it('takes null as the way to remove a note', () => {
    expect(RunNoteRequestSchema.parse({ note: null })).toEqual({ note: null });
  });

  it('refuses a body with no note, and one naming anything else — the server stamps who and when', () => {
    expect(RunNoteRequestSchema.safeParse({}).success).toBe(false);
    expect(RunNoteRequestSchema.safeParse({ note: 'ok', updatedBy: 'someone' }).success).toBe(false);
  });
});

describe('the note a reader receives', () => {
  it('still parses a run identity without it — the rolling-deploy guarantee', () => {
    expect(RunIdentitySchema.parse(MINIMAL_IDENTITY).note).toBeUndefined();
  });

  it('carries a note with its author and time, or null for none', () => {
    expect(RunIdentitySchema.parse({ ...MINIMAL_IDENTITY, note: NOTE }).note).toEqual(NOTE);
    expect(RunIdentitySchema.parse({ ...MINIMAL_IDENTITY, note: null }).note).toBeNull();
    // The author's account deleted: the words survive, the attribution does not.
    expect(RunNoteResponseSchema.parse({ note: { ...NOTE, updatedBy: null } }).note?.updatedBy).toBeNull();
    expect(RunNoteResponseSchema.parse({ note: null }).note).toBeNull();
  });

  it('gives a run-list row the text alone, and still parses a row without it', () => {
    const row = {
      id: MINIMAL_IDENTITY.id,
      project: MINIMAL_IDENTITY.project,
      status: 'complete',
      verdict: null,
      tool: 'gatling',
      startedAt: MINIMAL_IDENTITY.startedAt,
    };
    const parsed = RunListResponseSchema.parse({
      items: [row, { ...row, note: 'flaky environment' }],
      nextCursor: null,
    });
    expect(parsed.items[0]!.note).toBeUndefined();
    expect(parsed.items[1]!.note).toBe('flaky environment');
  });
});
