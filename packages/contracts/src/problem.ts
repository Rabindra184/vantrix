import { z } from 'zod';

/** RFC 9457 problem+json, with the two fields this product adds: code and remediation. */
export const ProblemDetailsSchema = z.object({
  type: z.string().url(),
  title: z.string().min(1),
  status: z.number().int(),
  code: z.string().min(1),
  detail: z.string().min(1),
  /** Required, mirroring IngestError.remediation. */
  remediation: z.string().min(1),
  traceId: z.string().optional(),
  meta: z.record(z.unknown()).optional(),
});
export type ProblemDetails = z.infer<typeof ProblemDetailsSchema>;
