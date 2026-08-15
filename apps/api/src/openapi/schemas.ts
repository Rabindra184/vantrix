import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ZodTypeAny } from 'zod';
import {
  DistributionResponseSchema,
  ErrorsResponseSchema,
  IndicatorBandsSchema,
  IngestMetadataSchema,
  ProblemDetailsSchema,
  ProjectListResponseSchema,
  RunListResponseSchema,
  RunProcessingSchema,
  RunResponseSchema,
  ScatterResponseSchema,
  SeriesResponseSchema,
  StatRowSchema,
  StatsResponseSchema,
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
  StatsResponse: StatsResponseSchema,
  StatRow: StatRowSchema,
  SeriesResponse: SeriesResponseSchema,
  ErrorsResponse: ErrorsResponseSchema,
  DistributionResponse: DistributionResponseSchema,
  UsersResponse: UsersResponseSchema,
  ScatterResponse: ScatterResponseSchema,
  IndicatorBands: IndicatorBandsSchema,
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
  return out;
}

/** `components.schemas`, built once at module load. */
export const schemaComponents: Record<string, JsonSchema> = Object.fromEntries(
  Object.entries(SOURCE).map(([name, zodSchema]) => [name, toJsonSchema(zodSchema)]),
);

/** `{ "$ref": "#/components/schemas/<name>" }` for a name known to exist above. */
export function schemaRef(name: keyof typeof SOURCE): JsonSchema {
  return { $ref: `#/components/schemas/${name}` };
}
