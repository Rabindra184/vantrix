import { z } from 'zod';

export const TOOL_IDS = ['gatling'] as const;

export const IngestMetadataSchema = z.object({
  tool: z.enum(TOOL_IDS),
  /** Scopes idempotency to the project. Bounded so the unique index stays sane. */
  idempotencyKey: z.string().min(1).max(200).optional(),
  environment: z.string().min(1).max(100).optional(),
  branch: z.string().min(1).max(200).optional(),
  commitSha: z.string().min(7).max(64).optional(),
  /** Milliseconds the caller is willing to wait for a synchronous verdict. */
  waitMs: z.number().int().min(0).max(120_000).optional(),
});
export type IngestMetadata = z.infer<typeof IngestMetadataSchema>;
