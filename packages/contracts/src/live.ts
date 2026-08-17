import { z } from 'zod';
import { TOOL_IDS } from './ingest.js';
import { ProblemDetailsSchema } from './problem.js';
import { TOKEN_SCOPES } from './tokens.js';

/**
 * `TOKEN_SCOPES` as a schema, for validating a single scope value (e.g. the
 * one a `stream`-scoped token's route guard checks) rather than the array
 * `MintTokenRequestSchema` validates. Built from the same constant so the two
 * can never list a different set of names.
 */
export const TokenScopeSchema = z.enum(TOKEN_SCOPES);
export type TokenScope = z.infer<typeof TokenScopeSchema>;

/**
 * The body of `POST /v1/runs/live` -- a `stream`-scoped token asking to start
 * a run it will feed batches into.
 *
 * Deliberately the SAME frozen metadata a bundle upload takes
 * (`environment`/`branch`/`commitSha` on ingest, plus `idempotencyKey` so a
 * retried open does not mint two runs for one execution): a live run and a
 * bundle upload are the same kind of thing to every downstream reader --
 * project, filters, trend charts -- and should not diverge in what they can
 * be labelled with just because one arrives one batch at a time. Those four
 * fields are optional for the same reason they are on ingest: a load
 * generator that sends none of them still gets a run, just an unlabelled one.
 *
 * The bounds on all four are copied VERBATIM from `IngestMetadataSchema`
 * (`ingest.ts`), not reinvented, because the comment above claims this is the
 * same metadata a bundle upload takes -- a claim of sameness that used
 * different bounds would be worse than no claim at all. `idempotencyKey`'s
 * `.min(1)` is the one that matters most: `run` carries
 * `@@unique([projectId, idempotencyKey])`, so an ungated empty string is a
 * distinct, real key rather than "no key supplied" -- two live opens that
 * both send `idempotencyKey: ''` would collide on that index instead of each
 * getting their own run.
 *
 * `tool` is the exception: REQUIRED, same as it is on `IngestMetadataSchema`
 * (its first field, and the only one with no `.optional()`), built from the
 * same `TOOL_IDS` constant so the two lists of tool ids can't disagree. A run
 * cannot exist without one -- `CreateRunInput.tool` is a required, non-null
 * column (`packages/persistence/src/repositories/run.ts`) -- and it names
 * which plugin decodes the stream, so there is no default worth guessing.
 */
export const OpenLiveRunRequestSchema = z.object({
  tool: z.enum(TOOL_IDS),
  environment: z.string().min(1).max(100).optional(),
  branch: z.string().min(1).max(200).optional(),
  commitSha: z.string().min(7).max(64).optional(),
  idempotencyKey: z.string().min(1).max(200).optional(),
});
export type OpenLiveRunRequest = z.infer<typeof OpenLiveRunRequestSchema>;

/**
 * What opening a live run returns: where to stream to, and from which byte to
 * start.
 *
 * `nextOffset` rather than assuming 0, because an idempotent retry of the
 * SAME `idempotencyKey` (a generator that opened, lost the response, and
 * asked again) must resume the run it already opened, not restart it -- and
 * the caller cannot know how many bytes the first attempt's response
 * delivered without being told. `0` for a genuinely new run is just this
 * field's first value, not a special case.
 *
 * `int().min(0)`, no upper bound: it is a byte offset into a run's log, and a
 * run's log length is not something this schema should cap. But it is not a
 * free-floating number either -- offset negotiation is the entire mechanism
 * that keeps a gap or a reorder from reaching the streaming decoder, whose
 * string-cache back-references mean a single misplaced byte corrupts every
 * record after it. A negative or fractional offset is never a valid resume
 * point, so both are rejected here rather than left for the decoder to fail
 * on less clearly.
 */
export const OpenLiveRunResponseSchema = z.object({
  runId: z.string().uuid(),
  streamUrl: z.string(),
  nextOffset: z.number().int().min(0),
});
export type OpenLiveRunResponse = z.infer<typeof OpenLiveRunResponseSchema>;

/**
 * The body a streamed batch is acknowledged with -- deliberately the only
 * thing it says. Not a run body, not a progress summary: the generator that
 * just posted a chunk needs one fact back, the byte offset to resume from on
 * its NEXT batch (or after a reconnect), and nothing else it would have to
 * parse and discard on every call in a loop that may run for hours.
 *
 * `int().min(0)`, same reasoning and same bound as `OpenLiveRunResponseSchema`
 * above -- this is the same offset, acknowledged again after each batch
 * rather than only at open.
 */
export const StreamAcceptedSchema = z.object({
  nextOffset: z.number().int().min(0),
});
export type StreamAccepted = z.infer<typeof StreamAcceptedSchema>;

/**
 * The 409 body POST /v1/runs/:id/stream answers with for a gap, or a run
 * that is no longer `running` -- every `ProblemDetails` field (so it is
 * still `application/problem+json` with a `remediation`), PLUS `nextOffset`,
 * the exact field the 202 case carries, so a caller's resume loop reads one
 * field regardless of which status code it got back.
 *
 * A bare `ProblemDetailsSchema` reference would not do here: it is a plain
 * `z.object` with no `.passthrough()`, so the JSON Schema the OpenAPI
 * document derives from it comes out `additionalProperties: false` --
 * meaning the document would describe this response as FORBIDDING the one
 * field its own prose says the response carries. This schema exists so the
 * document does not contradict the protocol it documents.
 */
export const StreamRejectedSchema = ProblemDetailsSchema.extend({
  nextOffset: z.number().int().min(0),
});
export type StreamRejected = z.infer<typeof StreamRejectedSchema>;
