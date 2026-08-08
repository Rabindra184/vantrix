import { schemaComponents, schemaRef, type JsonSchema } from './schemas.js';

// A deliberately loose, hand-rolled OpenAPI 3.1 shape rather than
// @nestjs/swagger's `OpenAPIObject`/`SchemaObject` types: those model the
// 3.0 dialect (`SchemaObject.type` is a single string; `exclusiveMinimum` is
// a boolean), which this document does not use — see schemas.ts. The cast to
// `OpenAPIObject` happens once, at the `SwaggerModule.setup` call site in
// ../openapi.ts, with the same justification.

interface Ref {
  $ref: string;
}

interface ParameterObject {
  name: string;
  in: 'path' | 'query';
  required?: boolean;
  description: string;
  schema: JsonSchema;
}

interface HeaderObject {
  description: string;
  schema: JsonSchema;
}

interface MediaTypeObject {
  schema: JsonSchema | Ref;
  encoding?: Record<string, { contentType: string }>;
}

interface RequestBodyObject {
  required: boolean;
  description: string;
  content: Record<string, MediaTypeObject>;
}

interface ResponseObject {
  description: string;
  headers?: Record<string, HeaderObject>;
  content?: Record<string, MediaTypeObject>;
}

interface OperationObject {
  operationId: string;
  summary: string;
  description: string;
  tags: string[];
  parameters?: (ParameterObject | Ref)[];
  requestBody?: RequestBodyObject;
  responses: Record<string, ResponseObject | Ref>;
  /** Present only to override the document-level default (empty = no auth). */
  security?: { bearerAuth: string[] }[];
}

interface PathItemObject {
  get?: OperationObject;
  post?: OperationObject;
}

export interface OpenApiDocument {
  openapi: '3.1.0';
  info: { title: string; version: string; description: string };
  security: { bearerAuth: string[] }[];
  paths: Record<string, PathItemObject>;
  components: {
    schemas: Record<string, JsonSchema>;
    securitySchemes: Record<string, unknown>;
    parameters: Record<string, ParameterObject>;
    headers: Record<string, HeaderObject>;
    responses: Record<string, ResponseObject>;
  };
}

const json = (schema: JsonSchema | Ref): Record<string, MediaTypeObject> => ({
  'application/json': { schema },
});

const problem = (): Record<string, MediaTypeObject> => ({
  'application/problem+json': { schema: schemaRef('ProblemDetails') },
});

const ref = (name: string): Ref => ({ $ref: `#/components/responses/${name}` });

// ---------------------------------------------------------------------------
// Reusable parameters
// ---------------------------------------------------------------------------

const parameters: Record<string, ParameterObject> = {
  RunId: {
    name: 'id',
    in: 'path',
    required: true,
    description: 'A run id.',
    schema: { type: 'string', format: 'uuid' },
  },
  ProjectSlug: {
    name: 'slug',
    in: 'path',
    required: true,
    description: 'A project slug. Must be the project the bearer token belongs to.',
    schema: { type: 'string' },
  },
  StatsScope: {
    name: 'scope',
    in: 'query',
    description:
      'Restrict to one metric scope. Not validated: a value outside the listed set simply ' +
      'matches no rows rather than being rejected, so the response\'s "stats" array comes back empty.',
    schema: { type: 'string', enum: ['run', 'scenario', 'group', 'request'] },
  },
  StatsFamily: {
    name: 'family',
    in: 'query',
    description:
      'Restrict to one metric family. Not validated, for the same reason as "scope": an ' +
      'unrecognized value matches no rows instead of erroring.',
    schema: {
      type: 'string',
      enum: ['response_time', 'latency', 'group_cumulated', 'group_duration'],
    },
  },
  SeriesScope: {
    name: 'scope',
    in: 'query',
    description:
      'The metric scope the named series belongs to. Not validated against the enum below — ' +
      'an unrecognized combination of scope and name returns an empty "buckets" array, not an error.',
    schema: { type: 'string', enum: ['run', 'scenario', 'group', 'request'], default: 'run' },
  },
  SeriesName: {
    name: 'name',
    in: 'query',
    description:
      'The target name within "scope" (e.g. a request name). Empty string selects the ' +
      'run-level series, which has no name of its own.',
    schema: { type: 'string', default: '' },
  },
  Limit: {
    name: 'limit',
    in: 'query',
    description:
      'Page size. Clamped to the range [1, 100] rather than rejected: a missing or ' +
      'non-numeric value defaults to 25, and an out-of-range value is coerced to the nearest ' +
      'bound (so limit=0 behaves like limit=1, and limit=99999 behaves like limit=100).',
    schema: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
  },
  Cursor: {
    name: 'cursor',
    in: 'query',
    description:
      'Opaque pagination cursor: the "id" of the last item from the previous page. Must be a ' +
      'UUID — an invalid value is rejected with 400 INVALID_CURSOR, unlike "limit" above.',
    schema: { type: 'string', format: 'uuid' },
  },
};

// ---------------------------------------------------------------------------
// Reusable headers
// ---------------------------------------------------------------------------

const headers: Record<string, HeaderObject> = {
  RetryAfter: {
    description: 'Seconds to wait before polling this run again.',
    schema: { type: 'integer', minimum: 0 },
  },
};

// ---------------------------------------------------------------------------
// Reusable responses
//
// POST /v1/runs and GET /v1/runs/{id} share these definitions verbatim — that
// sharing IS the "same code for the same state" contract made structural in
// the document, the same way runs.controller.ts's respondWithRun() makes it
// structural in the code the document describes.
// ---------------------------------------------------------------------------

const responses: Record<string, ResponseObject> = {
  RunOk: {
    description:
      'Ingested. Verdict is "passed" or "not_evaluated" — the same 200 that GET /v1/runs/{id} ' +
      'returns once this run reaches this state.',
    content: json(schemaRef('RunResponse')),
  },
  RunProcessing: {
    description:
      'Still processing — a timing outcome, never an error. Poll "statusUrl" (or the request ' +
      'that reached this state). GET /v1/runs/{id} returns this identical 202 for this state.',
    headers: { 'Retry-After': headers['RetryAfter']! },
    content: json(schemaRef('RunProcessing')),
  },
  BundleRejected: {
    description:
      'The bundle was rejected (malformed archive, empty archive, unrecognized tool, an SLA ' +
      'rule targeting no known metric family, and so on), or a path parameter was malformed. ' +
      'Always application/problem+json with a required "remediation". The same 400 that ' +
      'GET /v1/runs/{id} returns once a rejected upload\'s failure is persisted on the run.',
    content: problem(),
  },
  BadRequest: {
    description:
      'A path or query parameter was malformed (e.g. "id" or "cursor" is not a UUID). ' +
      'application/problem+json with a required "remediation" that says what a valid value ' +
      'looks like.',
    content: problem(),
  },
  BundleTooLarge: {
    description:
      'The bundle exceeded the configured decompressed-size cap (code BUNDLE_TOO_LARGE). ' +
      'application/problem+json with a required "remediation". The same 413 that ' +
      'GET /v1/runs/{id} returns once this failure is persisted on the run.',
    content: problem(),
  },
  SlaBreach: {
    description:
      'Ingested. Verdict is "failed" — at least one SLA assertion did not hold. The body is a ' +
      'normal RunResponse (application/json, not problem+json): this is a completed, valid ' +
      'run, not a request error. The same 422 that GET /v1/runs/{id} returns for this state.',
    content: json(schemaRef('RunResponse')),
  },
  Unauthorized: {
    description: 'The bearer token is missing, malformed, unknown, or revoked.',
    content: problem(),
  },
  Forbidden: {
    description: 'The token is valid but lacks the scope this operation requires.',
    content: problem(),
  },
  NotFound: {
    description: 'No such resource in a project this token can access.',
    content: problem(),
  },
};

/** The five response entries every "same code for the same state" operation shares. */
function runStateResponses(): Record<string, Ref> {
  return {
    '200': ref('RunOk'),
    '202': ref('RunProcessing'),
    '400': ref('BundleRejected'),
    '413': ref('BundleTooLarge'),
    '422': ref('SlaBreach'),
  };
}

const authFailureResponses = { '401': ref('Unauthorized'), '403': ref('Forbidden') };

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const paths: Record<string, PathItemObject> = {
  '/v1/runs': {
    post: {
      operationId: 'ingestRun',
      summary: 'Ingest a Gatling results bundle',
      tags: ['runs'],
      description:
        'Requires the "ingest" scope. Streams the "bundle" part to object storage (never ' +
        'buffered in this process) while validating "metadata", then waits up to ' +
        '"metadata.waitMs" (default project-configured, commonly 25s) for the run to reach a ' +
        'terminal state before answering synchronously.\n\n' +
        'Returns the exact same status code that GET /v1/runs/{id} would return for the run\'s ' +
        'state at the moment this request answers — 200/202/400/413/422 below are not this ' +
        'operation\'s own error taxonomy, they are that shared state machine. This operation ' +
        'never returns 201: there is no "created, pending" response distinct from 202 ' +
        '"processing" — a run that exists but has not reached a terminal state IS the 202 case.',
      requestBody: {
        required: true,
        description:
          'multipart/form-data with exactly two parts, "metadata" BEFORE "bundle" (the server ' +
          'starts streaming "bundle" to storage as soon as it arrives, so "metadata" must ' +
          'already have been read). Omitting "metadata" is equivalent to sending "{}", which ' +
          'fails validation (400) because "tool" is required.',
        content: {
          'multipart/form-data': {
            schema: {
              type: 'object',
              required: ['metadata', 'bundle'],
              properties: {
                metadata: schemaRef('IngestMetadata'),
                bundle: {
                  type: 'string',
                  format: 'binary',
                  description:
                    'The gzipped tar of the Gatling results directory (a simulation.log plus ' +
                    'its assertions file). Rejected with 413 if its decompressed contents ' +
                    'exceed the project\'s size cap.',
                },
              },
            },
            encoding: {
              metadata: { contentType: 'application/json' },
              bundle: { contentType: 'application/gzip' },
            },
          },
        },
      },
      responses: { ...runStateResponses(), ...authFailureResponses },
    },
  },

  '/v1/runs/{id}': {
    get: {
      operationId: 'getRun',
      summary: "Get a run by id — the ingest response's status URL",
      tags: ['runs'],
      description:
        'Requires the "read" scope. Returns the exact same status code that ' +
        'POST /v1/runs returned (or would have returned, had it not been waiting) for this ' +
        'run\'s current state — see that operation\'s description for the shared state machine. ' +
        'This is the URL a 202 response\'s "statusUrl" points at.',
      parameters: [parameters['RunId']!],
      responses: { ...runStateResponses(), '404': ref('NotFound'), ...authFailureResponses },
    },
  },

  '/v1/runs/{id}/stats': {
    get: {
      operationId: 'getRunStats',
      summary: 'Per-scope statistics table for a run',
      tags: ['metrics'],
      description: 'Requires the "read" scope.',
      parameters: [parameters['RunId']!, parameters['StatsScope']!, parameters['StatsFamily']!],
      responses: {
        '200': { description: 'Statistics for this run, optionally filtered.', content: json(schemaRef('StatsResponse')) },
        '400': ref('BadRequest'),
        '404': ref('NotFound'),
        ...authFailureResponses,
      },
    },
  },

  '/v1/runs/{id}/series': {
    get: {
      operationId: 'getRunSeries',
      summary: 'Time-series buckets for one scope/name within a run',
      tags: ['metrics'],
      description: 'Requires the "read" scope.',
      parameters: [parameters['RunId']!, parameters['SeriesScope']!, parameters['SeriesName']!],
      responses: {
        '200': { description: 'Time-series buckets.', content: json(schemaRef('SeriesResponse')) },
        '400': ref('BadRequest'),
        '404': ref('NotFound'),
        ...authFailureResponses,
      },
    },
  },

  '/v1/runs/{id}/errors': {
    get: {
      operationId: 'getRunErrors',
      summary: 'Aggregated error table for a run',
      tags: ['metrics'],
      description: 'Requires the "read" scope.',
      parameters: [parameters['RunId']!],
      responses: {
        '200': { description: 'Distinct error messages and counts, most frequent first.', content: json(schemaRef('ErrorsResponse')) },
        '400': ref('BadRequest'),
        '404': ref('NotFound'),
        ...authFailureResponses,
      },
    },
  },

  '/v1/projects/{slug}/runs': {
    get: {
      operationId: 'listProjectRuns',
      summary: 'Cursor-paginated list of runs in a project',
      tags: ['projects'],
      description:
        'Requires the "read" scope. 404s if "slug" does not name the project the bearer ' +
        'token belongs to — a token cannot list a project by naming a different one.',
      parameters: [parameters['ProjectSlug']!, parameters['Limit']!, parameters['Cursor']!],
      responses: {
        '200': { description: 'Newest-first page of runs.', content: json(schemaRef('RunListResponse')) },
        '400': ref('BadRequest'),
        '404': ref('NotFound'),
        ...authFailureResponses,
      },
    },
  },

  '/healthz': {
    get: {
      operationId: 'healthz',
      summary: 'Liveness',
      tags: ['health'],
      description: '@Public() — no bearer token required. Confirms only that the process is up.',
      security: [],
      responses: {
        '200': {
          description: 'The process is up.',
          content: json({ type: 'object', required: ['status'], properties: { status: { type: 'string' } } }),
        },
      },
    },
  },

  '/readyz': {
    get: {
      operationId: 'readyz',
      summary: 'Readiness',
      tags: ['health'],
      description:
        '@Public() — no bearer token required. Confirms the database answers, not merely that ' +
        'the process is up.',
      security: [],
      responses: {
        '200': {
          description: 'The database answered.',
          content: json({ type: 'object', required: ['status'], properties: { status: { type: 'string' } } }),
        },
        '500': { description: 'A dependency (the database) did not answer.', content: problem() },
      },
    },
  },
};

export function buildOpenApiDocument(): OpenApiDocument {
  return {
    openapi: '3.1.0',
    info: {
      title: 'PerfPortal API',
      version: '1.0.0',
      description:
        'Ingest and read performance test runs.\n\n' +
        'POST /v1/runs and GET /v1/runs/{id} return THE SAME STATUS CODE for the same run ' +
        'state — see each operation\'s own description for the shared table. 202 is a timing ' +
        'outcome, never an error; a client that treats it as failure is misusing this API.',
    },
    security: [{ bearerAuth: [] }],
    paths,
    components: {
      schemas: schemaComponents,
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description:
            'API tokens have the shape "pp_<prefix>_<secret>" — an opaque token, not a JWT. ' +
            'Send as "Authorization: Bearer pp_<prefix>_<secret>". POST /v1/runs requires a ' +
            'token with the "ingest" scope; every GET requires "read".',
        },
      },
      parameters,
      headers,
      responses,
    },
  };
}
