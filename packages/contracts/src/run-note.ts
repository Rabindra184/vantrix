import { z } from 'zod';

/**
 * ═══ THE RUN NOTE ═══
 * (docs/superpowers/specs/2026-09-27-run-note-design.md)
 *
 * A short note a PERSON writes on a run after the fact — "baseline after the
 * cache change", "flaky environment, ignore".
 *
 * NOT the run's description. That field is Gatling's own run description,
 * decoded from the simulation.log header and bound by PRD G-02 as an exact
 * string: the tool's claim about the run, frozen at parse. A person editing it
 * would overwrite what the tool said, so the note is a separate field and the
 * run page keeps the two visibly apart.
 */

/** The longest note a run carries, counted after trimming. Exported so the
 *  browser's counter reads the same number the server enforces. */
export const NOTE_MAX_LENGTH = 500;

/**
 * `PUT /v1/runs/{id}/note`.
 *
 * TRIMMED, like every bounded human-typed string in this package. Whitespace
 * alone is REFUSED rather than stored as an empty note — an empty string would
 * be a second spelling of "no note", and this contract gives that one
 * spelling: `null`.
 *
 * `.strict()`: a body naming anything else — an author, a time — is refused
 * rather than silently ignored, because the server stamps both itself.
 */
export const RunNoteRequestSchema = z
  .object({
    note: z.string().trim().min(1).max(NOTE_MAX_LENGTH).nullable(),
  })
  .strict();
export type RunNoteRequest = z.infer<typeof RunNoteRequestSchema>;

/**
 * A note that EXISTS. "No note" is `null` wherever this is used, never an
 * empty `text`.
 */
export const RunNoteSchema = z.object({
  text: z.string(),
  /** When it was last written. Null only for a row written by hand. */
  updatedAt: z.string().datetime().nullable(),
  /** Who last wrote it. Null once that person's account is deleted: the words
   *  survive and the attribution does not (ON DELETE SET NULL). */
  updatedBy: z.object({ name: z.string() }).nullable(),
});
export type RunNote = z.infer<typeof RunNoteSchema>;

/** The PUT's 200 body: the note as it now stands, `null` after a removal. */
export const RunNoteResponseSchema = z.object({ note: RunNoteSchema.nullable() });
export type RunNoteResponse = z.infer<typeof RunNoteResponseSchema>;
