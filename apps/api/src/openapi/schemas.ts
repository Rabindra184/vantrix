import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ZodTypeAny } from 'zod';
import {
  DistributionResponseSchema,
  ErrorSeriesResponseSchema,
  ErrorsResponseSchema,
  IndicatorBandsSchema,
  CreateProjectRequestSchema,
  IngestMetadataSchema,
  MintedTokenSchema,
  MintTokenRequestSchema,
  OpenLiveRunRequestSchema,
  OpenLiveRunResponseSchema,
  ProblemDetailsSchema,
  ProjectListResponseSchema,
  CreateSlaRuleRequestSchema,
  TestListResponseSchema,
  TestSummarySchema,
  UpdateTestRequestSchema,
  SlaRuleListResponseSchema,
  SlaRuleSchema,
  UpdateSlaRuleRequestSchema,
  RunListResponseSchema,
  RunProcessingSchema,
  RunResponseSchema,
  ProjectSummarySchema,
  ScatterResponseSchema,
  SeriesResponseSchema,
  StatRowSchema,
  StatsResponseSchema,
  StreamAcceptedSchema,
  StreamRejectedSchema,
  RunnerStartMetadataSchema,
  RunnerStartResponseSchema,
  RunnerJobListResponseSchema,
  RunnerJobActionResponseSchema,
  RunnerJobLogsResponseSchema,
  TelemetryBatchSchema,
  TelemetryResponseSchema,
  TokenListResponseSchema,
  TokenSummarySchema,
  TrendRunSchema,
  TrendsResponseSchema,
  UsersResponseSchema,
} from '@perfportal/contracts';

/**
 * A JSON Schema object as embedded in an OpenAPI document. Intentionally
 * loose (not @nestjs/swagger's `SchemaObject`): that interface types `type`
 * as a single string and `exclusiveMinimum` as a boolean, which is the 3.0
 * dialect. Draft 2019-09/2020-12 (what OpenAPI 3.1 uses) allows `type` to be
 * an array — this repo's schemas don't happen to need that (nullability
 * below is expressed with `anyOf` instead, which both dialects accept), but
 * the type is kept loose so a future schema addition isn't blocked on it.
 */
export type JsonSchema = Record<string, unknown>;

/**
 * Every reusable schema this document references by name, keyed exactly as
 * they appear under `components.schemas`. Derived from the Zod schemas in
 * `@perfportal/contracts` rather than hand-written, so the document cannot
 * silently drift from the request/response shapes the app actually produces
 * — that drift is how the previous (empty) `components.schemas` happened.
 */
const SOURCE: Record<string, ZodTypeAny> = {
  IngestMetadata: IngestMetadataSchema,
  ProblemDetails: ProblemDetailsSchema,
  RunResponse: RunResponseSchema,
  RunProcessing: RunProcessingSchema,
  RunListResponse: RunListResponseSchema,
  ProjectListResponse: ProjectListResponseSchema,
  ProjectSummary: ProjectSummarySchema,
  CreateProjectRequest: CreateProjectRequestSchema,
  StatsResponse: StatsResponseSchema,
  StatRow: StatRowSchema,
  SeriesResponse: SeriesResponseSchema,
  ErrorsResponse: ErrorsResponseSchema,
  ErrorSeriesResponse: ErrorSeriesResponseSchema,
  DistributionResponse: DistributionResponseSchema,
  UsersResponse: UsersResponseSchema,
  ScatterResponse: ScatterResponseSchema,
  TrendsResponse: TrendsResponseSchema,
  TrendRun: TrendRunSchema,
  IndicatorBands: IndicatorBandsSchema,
  TelemetryBatch: TelemetryBatchSchema,
  TelemetryResponse: TelemetryResponseSchema,
  MintTokenRequest: MintTokenRequestSchema,
  MintedToken: MintedTokenSchema,
  TokenSummary: TokenSummarySchema,
  TokenListResponse: TokenListResponseSchema,
  CreateSlaRuleRequest: CreateSlaRuleRequestSchema,
  TestSummary: TestSummarySchema,
  TestListResponse: TestListResponseSchema,
  UpdateTestRequest: UpdateTestRequestSchema,
  UpdateSlaRuleRequest: UpdateSlaRuleRequestSchema,
  SlaRule: SlaRuleSchema,
  SlaRuleListResponse: SlaRuleListResponseSchema,
  OpenLiveRunRequest: OpenLiveRunRequestSchema,
  OpenLiveRunResponse: OpenLiveRunResponseSchema,
  StreamAccepted: StreamAcceptedSchema,
  StreamRejected: StreamRejectedSchema,
  // THE ON-PREM RUNNER'S OWN SCHEMAS. They existed in `contracts` from the
  // start and were registered here by nothing, which is how five live routes
  // came to be absent from the document while it went on describing a
  // "runner" scope a token can hold.
  RunnerStartMetadata: RunnerStartMetadataSchema,
  RunnerStartResponse: RunnerStartResponseSchema,
  RunnerJobListResponse: RunnerJobListResponseSchema,
  RunnerJobActionResponse: RunnerJobActionResponseSchema,
  RunnerJobLogsResponse: RunnerJobLogsResponseSchema,
};

/**
 * Converts one Zod schema to a fully self-contained JSON Schema object — no
 * internal `$ref`/`definitions` indirection (`$refStrategy: 'none'`), so
 * every component below is independently valid and there is nothing for a
 * validator to fail to resolve.
 *
 * `target: 'jsonSchema2019-09'` picks the dialect closest to what OpenAPI
 * 3.1 actually uses (2020-12) without pulling in a Zod-to-JSON-Schema target
 * that doesn't exist yet: nullability comes out as `anyOf: [..., {type:
 * 'null'}]`, which both 2019-09 and 2020-12 accept, rather than the 3.0-only
 * `nullable: true` keyword (meaningless — and therefore a lie — once the
 * document claims to be 3.1).
 */
function toJsonSchema(schema: ZodTypeAny): JsonSchema {
  // No `name` option: passing one makes the library wrap the schema in a
  // `definitions[name]` bag with a top-level `$ref` into it — a document
  // structure appropriate for a standalone JSON Schema file, not for a
  // value that itself becomes the body of `components.schemas.<name>`. The
  // `$schema` dialect-identifier key is dropped for the same reason: it
  // marks a schema *document*'s dialect, not a subschema embedded in one.
  const out = zodToJsonSchema(schema, {
    target: 'jsonSchema2019-09',
    $refStrategy: 'none',
  }) as JsonSchema;
  delete out['$schema'];
  return numericExclusiveBounds(out);
}

/**
 * ═══ `exclusiveMinimum` IS A NUMBER IN THIS DOCUMENT'S OWN DIALECT ═══
 *
 * OpenAPI 3.1 — which `document.ts` declares — uses JSON Schema 2020-12,
 * where `exclusiveMinimum`/`exclusiveMaximum` carry the BOUND. The boolean
 * spelling beside a separate `minimum`/`maximum` is draft-04, i.e. OpenAPI
 * 3.0, and it is a TYPE ERROR against 2020-12.
 *
 * `zod-to-json-schema@3.25.2` emits the draft-04 form regardless of the
 * target — measured, and the reason this function exists rather than a
 * different `target:` string:
 *
 *     jsonSchema2019-09  {"exclusiveMinimum": true, "minimum": 0}   <- wrong
 *     jsonSchema7        {"exclusiveMinimum": 0}                    <- right
 *     openApi3           {"exclusiveMinimum": true, "minimum": 0}   <- right for 3.0
 *
 * 2019-09 inherits draft-06's numeric form, so the middle row is what this
 * target should already produce; the library disagrees with its own dialect.
 *
 * THE ONE-WORD FIX WAS MEASURED AND REJECTED. Switching to `jsonSchema7`
 * produces byte-identical output for every other construct this document
 * uses — nullability, enums, records, formats — so it would work today. It
 * is refused because the NAME would then claim draft-07 for a document that
 * declares 3.1, leaving the next reader to rediscover that the two targets
 * differ in exactly one keyword. Rewriting the keyword says so out loud, and
 * it degrades to a no-op the day the library emits the right form.
 *
 * BEFORE: 14 occurrences across six response schemas, and a standards
 * validator refused to compile the document at all.
 */
function numericExclusiveBounds<T>(node: T): T {
  if (Array.isArray(node)) return node.map(numericExclusiveBounds) as unknown as T;
  if (node === null || typeof node !== 'object') return node;

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    out[key] = numericExclusiveBounds(value);
  }
  for (const [flag, bound] of [
    ['exclusiveMinimum', 'minimum'],
    ['exclusiveMaximum', 'maximum'],
  ] as const) {
    // Only the draft-04 pairing is rewritten: `exclusiveMinimum: true` is
    // meaningless without the `minimum` it qualifies, and a numeric one is
    // already correct and must be left alone.
    if (out[flag] === true && typeof out[bound] === 'number') {
      out[flag] = out[bound];
      delete out[bound];
    } else if (out[flag] === false) {
      // draft-04's explicit "not exclusive" — the bound alone says that.
      delete out[flag];
    }
  }
  return out as T;
}

/** `components.schemas`, built once at module load. */
export const schemaComponents: Record<string, JsonSchema> = Object.fromEntries(
  Object.entries(SOURCE).map(([name, zodSchema]) => [name, toJsonSchema(zodSchema)]),
);

/** `{ "$ref": "#/components/schemas/<name>" }` for a name known to exist above. */
export function schemaRef(name: keyof typeof SOURCE): JsonSchema {
  return { $ref: `#/components/schemas/${name}` };
}
