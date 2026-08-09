import { z } from 'zod';

/**
 * Read at REQUEST time, not frozen at ingest.
 *
 * This deliberately reverses the ingest spine's frozen-engineOptions rule for
 * these two settings only. That rule exists so a project changing configuration
 * cannot silently reinterpret its own history, and it still binds anything that
 * changes WHICH events are aggregated - warm-up above all. Indicator bounds and
 * percentile columns are not that: with an exact histogram and a stored sketch,
 * both are display thresholds applied to complete data, and recomputing them per
 * request yields exactly what a re-ingest would.
 */
export const ProjectSettingsSchema = z.object({
  indicators: z
    .object({
      lowerMs: z.number().int().positive().default(800),
      higherMs: z.number().int().positive().default(1200),
    })
    .default({ lowerMs: 800, higherMs: 1200 })
    .refine((v) => v.lowerMs < v.higherMs, {
      message: 'indicators.lowerMs must be below indicators.higherMs',
    }),
  percentiles: z
    .array(z.number().gt(0).lt(100))
    .min(1)
    .default([50, 75, 95, 99]),
});
export type ProjectSettings = z.infer<typeof ProjectSettingsSchema>;

/** Unrelated keys (e.g. maxDecompressedBundleBytes) are ignored, not rejected. */
export function parseProjectSettings(value: unknown): ProjectSettings {
  return ProjectSettingsSchema.parse(value ?? {});
}
