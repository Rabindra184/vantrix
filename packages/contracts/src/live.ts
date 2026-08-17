import { z } from 'zod';
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
 * be labelled with just because one arrives one batch at a time. All four
 * fields are optional for the same reason they are on ingest: a load
 * generator that sends none of them still gets a run, just an unlabelled one.
 */
export const OpenLiveRunRequestSchema = z.object({
  environment: z.string().optional(),
  branch: z.string().optional(),
  commitSha: z.string().optional(),
  idempotencyKey: z.string().optional(),
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
 */
export const OpenLiveRunResponseSchema = z.object({
  runId: z.string().uuid(),
  streamUrl: z.string(),
  nextOffset: z.number(),
});
export type OpenLiveRunResponse = z.infer<typeof OpenLiveRunResponseSchema>;

/**
 * The body a streamed batch is acknowledged with -- deliberately the only
 * thing it says. Not a run body, not a progress summary: the generator that
 * just posted a chunk needs one fact back, the byte offset to resume from on
 * its NEXT batch (or after a reconnect), and nothing else it would have to
 * parse and discard on every call in a loop that may run for hours.
 */
export const StreamAcceptedSchema = z.object({
  nextOffset: z.number(),
});
export type StreamAccepted = z.infer<typeof StreamAcceptedSchema>;
