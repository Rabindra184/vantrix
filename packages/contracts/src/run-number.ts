import { z } from 'zod';

/**
 * ═══ A RUN'S NUMBER WITHIN ITS TEST ═══
 * (docs/superpowers/specs/2026-09-27-run-number-design.md)
 *
 * "Run 12": taken when a run JOINS its test and never renumbered, so it follows
 * arrival rather than start time. Positive and whole. Every schema that
 * carries it does so as `.nullable().optional()` — null for a run with no
 * test, absent from an API pod that predates the field.
 *
 * Its own file, importing only zod, so run.ts, metrics.ts and test.ts can all
 * reach it without an import cycle.
 */
export const RunNumberSchema = z.number().int().positive();
export type RunNumber = z.infer<typeof RunNumberSchema>;
