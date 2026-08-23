import { z } from 'zod';
import { DeclaredTestSlugSchema } from './ingest.js';

export const RunnerArtifactKindSchema = z.enum(['gatling_jar', 'gatling_bundle']);
export type RunnerArtifactKind = z.infer<typeof RunnerArtifactKindSchema>;

export const RunnerJobStatusSchema = z.enum([
  'queued',
  'starting',
  'running',
  'closing',
  'complete',
  'failed',
  'cancelled',
]);
export type RunnerJobStatus = z.infer<typeof RunnerJobStatusSchema>;

const OptionalRunMetadataSchema = z.object({
  environment: z.string().trim().min(1).max(100).optional(),
  branch: z.string().trim().min(1).max(200).optional(),
  commitSha: z.string().trim().min(7).max(64).optional(),
  /**
   * WHICH TEST this run is of — the same field, the same grammar and the same
   * meaning as `IngestMetadataSchema.test`, reaching the platform by its
   * fourth and last route.
   *
   * `DeclaredTestSlugSchema` is SHARED rather than re-declared here, so the
   * four submit paths cannot drift into disagreeing about what a valid test
   * slug looks like. Absent is the ordinary case and groups by simulation
   * class, exactly as before.
   */
  test: DeclaredTestSlugSchema.optional(),
});

const SystemPropertiesSchema = z.record(z.string().trim().max(500)).superRefine((props, ctx) => {
  for (const key of Object.keys(props)) {
    if (!/^[A-Za-z0-9_.-]{1,120}$/.test(key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key],
        message: 'System property keys may contain only letters, numbers, dots, underscores and hyphens.',
      });
    }
  }
});

export const RunnerStartMetadataSchema = OptionalRunMetadataSchema.extend({
  name: z.string().trim().min(1).max(160),
  artifactKind: RunnerArtifactKindSchema.default('gatling_jar'),
  simulationClass: z.string().trim().min(1).max(300),
  gatlingVersion: z.string().trim().min(1).max(40).optional(),
  javaOptions: z.string().trim().max(2_000).optional(),
  systemProperties: SystemPropertiesSchema.default({}),
});
export type RunnerStartMetadata = z.infer<typeof RunnerStartMetadataSchema>;

export const RunnerArtifactSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  filename: z.string(),
  kind: RunnerArtifactKindSchema,
  simulationClass: z.string(),
  gatlingVersion: z.string().nullable(),
  sha256: z.string(),
  bytes: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
});
export type RunnerArtifact = z.infer<typeof RunnerArtifactSchema>;

export const RunnerJobSchema = z.object({
  id: z.string().uuid(),
  artifactId: z.string().uuid(),
  runId: z.string().uuid().nullable(),
  status: RunnerJobStatusSchema,
  requestedBy: z.string(),
  environment: z.string().nullable(),
  branch: z.string().nullable(),
  commitSha: z.string().nullable(),
  /** The test this job named, or null. Becomes the run's own declaration when
   *  the runner opens it. */
  testSlug: z.string().nullable(),
  javaOptions: z.string().nullable(),
  systemProperties: z.record(z.string()),
  error: z.object({ code: z.string(), message: z.string(), remediation: z.string() }).nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type RunnerJob = z.infer<typeof RunnerJobSchema>;

export const RunnerStartResponseSchema = z.object({
  artifact: RunnerArtifactSchema,
  job: RunnerJobSchema,
  next: z.object({
    reportUrl: z.string().nullable(),
    runner: z.string(),
  }),
});
export type RunnerStartResponse = z.infer<typeof RunnerStartResponseSchema>;

export const RunnerJobListResponseSchema = z.object({
  items: z.array(
    z.object({
      artifact: RunnerArtifactSchema,
      job: RunnerJobSchema,
    }),
  ),
});
export type RunnerJobListResponse = z.infer<typeof RunnerJobListResponseSchema>;

export const RunnerJobActionResponseSchema = z.object({
  artifact: RunnerArtifactSchema,
  job: RunnerJobSchema,
});
export type RunnerJobActionResponse = z.infer<typeof RunnerJobActionResponseSchema>;

export const RunnerJobLogsResponseSchema = z.object({
  jobId: z.string().uuid(),
  text: z.string(),
  truncated: z.boolean(),
  updatedAt: z.string().datetime().nullable(),
});
export type RunnerJobLogsResponse = z.infer<typeof RunnerJobLogsResponseSchema>;
