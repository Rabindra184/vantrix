import { z } from 'zod';

export const TOOL_IDS = ['gatling'] as const;

/**
 * A test slug a CALLER may declare, at ingest or when opening a live run.
 *
 * ═══ WHY A SLUG AND NOT A NAME ═══
 *
 * It is an identifier, not a label. A caller declaring `checkout-soak` means
 * exactly the test at `/projects/…/tests/checkout-soak` — the same string the
 * URL carries and `?test=` filters by — and a caller who wants it to READ as
 * "Checkout soak" renames it once, in the UI, without touching their pipeline.
 * Accepting a display name instead would mean slugifying it on every run, so a
 * typo would silently create a second test rather than being refused.
 *
 * The grammar matches what `slugifySimulation` produces, so a slug the worker
 * derives and a slug a caller declares are the same kind of thing and cannot
 * collide by shape. `.max(200)` mirrors `UpdateTestRequestSchema`'s own bound
 * on the field a reader can edit.
 */
export const TEST_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const DeclaredTestSlugSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(TEST_SLUG_PATTERN, {
    message: 'must be lower-case letters, digits and single hyphens, e.g. "checkout-soak"',
  });

export const IngestMetadataSchema = z.object({
  tool: z.enum(TOOL_IDS),
  /** Scopes idempotency to the project. Bounded so the unique index stays sane. */
  idempotencyKey: z.string().min(1).max(200).optional(),
  environment: z.string().min(1).max(100).optional(),
  branch: z.string().min(1).max(200).optional(),
  commitSha: z.string().min(7).max(64).optional(),
  /**
   * WHICH TEST THIS RUN IS OF, when the caller wants to say.
   *
   * Optional, and absent is the ordinary case: the worker then groups by the
   * simulation class in the log header, exactly as it always has, so every
   * client that predates this field keeps its exact behaviour.
   *
   * Declaring one is what lets a project run ONE simulation as TWO tests —
   * "checkout smoke" and "checkout soak" with different injection profiles —
   * which is the model `20260823170000_test_per_configuration` dropped a
   * unique index to allow. The slug wins over the class when both are known.
   *
   * A slug naming no existing test CREATES it, rather than erroring: a
   * pipeline that names its test should not need a setup step in the UI
   * first, and there is no create endpoint precisely because the platform
   * would otherwise be inventing tests nobody runs.
   */
  test: DeclaredTestSlugSchema.optional(),
  /** Milliseconds the caller is willing to wait for a synchronous verdict. */
  waitMs: z.number().int().min(0).max(120_000).optional(),
});
export type IngestMetadata = z.infer<typeof IngestMetadataSchema>;
