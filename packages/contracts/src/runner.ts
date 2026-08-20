import { z } from 'zod';

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
});

export const RunnerStartMetadataSchema = OptionalRunMetadataSchema.extend({
  name: z.string().trim().min(1).max(160),
  artifactKind: RunnerArtifactKindSchema.default('gatling_jar'),
  simulationClass: z.string().trim().min(1).max(300),
  gatlingVersion: z.string().trim().min(1).max(40).optional(),
  javaOptions: z.string().trim().max(2_000).optional(),
  systemProperties: z.record(z.string().trim().max(500)).default({}),
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
