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
  /**
   * 'header' added for POST /v1/runs/{id}/stream's "X-Stream-Offset" —
   * every other parameter in this document is 'path' or 'query'.
   */
  in: 'path' | 'query' | 'header';
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

/**
 * A security requirement naming one scheme with no scopes — this document
 * never uses OAuth-style scopes, so the array is always empty. Two schemes
 * are named because the two credentials are truly interchangeable everywhere
 * except the bearer-only overrides below: an array of single-scheme entries
 * (rather than one entry naming both) is OpenAPI's way of expressing OR, not
 * AND — "bearerAuth alone is sufficient; cookieAuth alone is sufficient."
 */
type SecurityRequirement = { bearerAuth: [] } | { cookieAuth: [] };

interface OperationObject {
  operationId: string;
  summary: string;
  description: string;
  tags: string[];
  parameters?: (ParameterObject | Ref)[];
  requestBody?: RequestBodyObject;
  responses: Record<string, ResponseObject | Ref>;
  /** Present only to override the document-level default (empty = no auth). */
  security?: SecurityRequirement[];
}

interface PathItemObject {
  get?: OperationObject;
  post?: OperationObject;
  delete?: OperationObject;
}

export interface OpenApiDocument {
  openapi: '3.1.0';
  info: { title: string; version: string; description: string };
  security: SecurityRequirement[];
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
  StatsName: {
    name: 'name',
    in: 'query',
    description:
      'Restrict to one exact row name (e.g. one request name). Not validated against known ' +
      'names, for the same reason as "scope": an unmatched name simply returns an empty ' +
      '"stats" array instead of erroring.',
    schema: { type: 'string' },
  },
  ErrorsScope: {
    name: 'scope',
    in: 'query',
    description:
      'Restrict to one metric scope. Omitting this returns only run-scoped errors, NOT every ' +
      'scope: the errors table stores one row per (scope, name), so an unscoped read would ' +
      'double-count each failure across levels. When this is omitted, "name" below is ignored ' +
      'entirely — even if supplied, it is treated as "" (run-level).',
    schema: { type: 'string', enum: ['run', 'scenario', 'group', 'request'] },
  },
  ErrorsName: {
    name: 'name',
    in: 'query',
    description:
      'The target name within "scope" (e.g. a request name). Only applied when "scope" is ' +
      'also given — see that parameter\'s description for what happens when it is omitted.',
    schema: { type: 'string' },
  },
  DistributionScope: {
    name: 'scope',
    in: 'query',
    description:
      'The metric scope of the target histogram. Unlike "scope" on /series, an unmatched ' +
      'scope/name/family combination does not come back as an empty result — it 404s, because ' +
      'a histogram (unlike a series) either exists for a given key or does not.',
    schema: { type: 'string', enum: ['run', 'scenario', 'group', 'request'], default: 'run' },
  },
  DistributionName: {
    name: 'name',
    in: 'query',
    description:
      'The target name within "scope" (e.g. a request name). Empty string selects the ' +
      'run-level histogram, which has no name of its own.',
    schema: { type: 'string', default: '' },
  },
  DistributionFamily: {
    name: 'family',
    in: 'query',
    description:
      'The metric family of the target histogram — see "scope" above for what an unmatched ' +
      'combination does.',
    schema: {
      type: 'string',
      enum: ['response_time', 'latency', 'group_cumulated', 'group_duration'],
      default: 'response_time',
    },
  },
  ScatterName: {
    name: 'name',
    in: 'query',
    description:
      'The request name to plot (scope is always "request" — there is no "scope" parameter on ' +
      'this endpoint). Its status-filtered p95 is plotted against the run-level requests/sec ' +
      'rate at each bucket. Empty string (the default) matches no request, so "ok" and "ko" ' +
      'both come back empty rather than erroring.',
    schema: { type: 'string', default: '' },
  },
  SeriesScope: {
    name: 'scope',
    in: 'query',
    description:
      'The metric scope the named series belongs to. Not validated against the enum below — ' +
      'an unrecognized combination of scope, name, and family returns an empty "buckets" ' +
      'array, not an error.',
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
  SeriesFamily: {
    name: 'family',
    in: 'query',
    description:
      'The metric family of the target series — see "scope" above for what an unmatched ' +
      'combination does. A group has two: "group_cumulated" (the sum of its child requests\' ' +
      'durations) and "group_duration" (its own wall clock).',
    schema: {
      type: 'string',
      enum: ['response_time', 'latency', 'group_cumulated', 'group_duration'],
      default: 'response_time',
    },
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
  ProjectFilter: {
    name: 'project',
    in: 'query',
    description:
      'Restrict to one project, by slug. Validated: a slug not in the caller\'s org is a 404, ' +
      'never an empty result, so a caller can tell "no such project" from "that project is ' +
      'idle". A bearer token naming a project other than its own gets a 400 PROJECT_MISMATCH.',
    schema: { type: 'string' },
  },
  TelemetryFrom: {
    name: 'from',
    in: 'query',
    description:
      'Elapsed ms from this run\'s own "toolStartedAt" (inclusive) — the same axis "series" ' +
      'buckets are on. Independently meaningful from "to": "from" alone narrows to "the rest ' +
      'of the run", never silently ignored. Omitting both "from" and "to" returns the whole ' +
      'run with "window: null". Rejected with 400 WINDOW_UNAVAILABLE for a run ingested before ' +
      'per-bucket histograms existed — unreachable in practice for telemetry, since a run old ' +
      'enough to predate that migration predates this feature too.',
    schema: { type: 'integer', minimum: 0 },
  },
  TelemetryTo: {
    name: 'to',
    in: 'query',
    description:
      'Elapsed ms from this run\'s own "toolStartedAt" (exclusive). See "from" above for how ' +
      'the two bounds combine.',
    schema: { type: 'integer', minimum: 0 },
  },
  TokenProjectSlug: {
    name: 'slug',
    in: 'path',
    required: true,
    description:
      'A project slug within the caller\'s own organisation. Resolved by the session\'s org ' +
      'membership, unlike "slug" on GET /v1/projects/{slug}/runs — this route accepts no bearer ' +
      'credential at all (see SessionOnlyGuard), so there is no "the token\'s own project" to ' +
      'match against. A slug outside the caller\'s org 404s rather than 403, so the response ' +
      'never confirms that another organisation\'s project exists.',
    schema: { type: 'string' },
  },
  TokenPrefix: {
    name: 'prefix',
    in: 'path',
    required: true,
    description:
      'The "prefix" a mint or list response returned — everything up to the last underscore of ' +
      '"pp_<hex>_<secret>" (i.e. the "pp_<hex>" value itself, not merely the middle segment). ' +
      'Never the full token: revocation does not need the secret, which is why an operator can ' +
      'act on a leaked token from the list alone.',
    schema: { type: 'string' },
  },
  StreamOffset: {
    name: 'X-Stream-Offset',
    in: 'header',
    required: true,
    description:
      'The byte offset this chunk\'s body begins at, within the run\'s simulation.log. Missing ' +
      'or not a non-negative integer is a 400. The offset a genuinely new run starts at, and ' +
      'the offset to resume from after any response, is always "nextOffset" from the most ' +
      'recent POST /v1/runs/live or POST /v1/runs/{id}/stream response for this run.',
    schema: { type: 'integer', minimum: 0 },
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
      'rule targeting no known metric family, and so on), or a path parameter was malformed — ' +
      'the same 400 that GET /v1/runs/{id} returns once that rejection is persisted on the ' +
      'run. The one exception is code PROJECT_REQUIRED: returned only here, when the caller ' +
      'authenticated with a session (which names no project) rather than a project-scoped ' +
      'token. It fires before any run row exists, so GET /v1/runs/{id} can never return it — ' +
      'there is no run to have persisted the failure on. Always application/problem+json with ' +
      'a required "remediation".',
    content: problem(),
  },
  BadRequest: {
    description:
      'A path or query parameter was malformed (e.g. "id" or "cursor" is not a UUID). ' +
      'application/problem+json with a required "remediation" that says what a valid value ' +
      'looks like.',
    content: problem(),
  },
  ProjectRunsBadRequest: {
    description:
      'Either a query parameter was malformed (e.g. "cursor" is not a valid cursor), or (code ' +
      'PROJECT_REQUIRED) the caller authenticated with a session, which names no project — ' +
      'only a project-scoped token can list a project\'s runs by slug. The remediation names ' +
      'GET /v1/runs as the session-reachable equivalent. application/problem+json with a ' +
      'required "remediation".',
    content: problem(),
  },
  StatsBadRequest: {
    description:
      'Either "id" was malformed, or (code PROJECT_SETTINGS_INVALID) the project\'s stored ' +
      '"indicators" setting cannot be used to compute indicator bands for this run — either ' +
      'the setting itself is structurally invalid (e.g. lowerMs >= higherMs), or its ' +
      '"higherMs" sits above the histogram\'s overflow cap while this run has overflow ' +
      'observations. application/problem+json with a required "remediation" naming the setting ' +
      'to fix.',
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
  TelemetryRejected: {
    description:
      'The batch failed validation (code INVALID_TELEMETRY — a counter is negative, ' +
      '"sampledAt" is not a valid ISO 8601 timestamp, "samples" is empty or exceeds 500, or the ' +
      'body names a field this schema does not — TelemetryBatchSchema is `.strict()`, so a ' +
      'payload-supplied "orgId"/"projectId" lands here rather than being silently ignored). ' +
      'A session credential is refused earlier and differently: it is rejected with 403 by the ' +
      '"telemetry" scope check (see cookieAuth) before this handler — and this code path\'s own ' +
      'missing-project check — ever runs, since no session carries that scope. ' +
      'Always application/problem+json with a required "remediation".',
    content: problem(),
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
  SessionRequired: {
    description:
      'The credential is a valid bearer API token, not a signed-in session (code FORBIDDEN). ' +
      'Refused unconditionally, regardless of which scopes the token carries — token minting is ' +
      'checked by SessionOnlyGuard, never by @Scopes(), because a scope check would let any ' +
      'credential holding that scope mint itself a broader one. Sign in at ' +
      'POST /auth/sign-in/email and retry with the session cookie.',
    content: problem(),
  },
  InvalidTokenRequest: {
    description:
      'The request body failed MintTokenRequestSchema (code INVALID_TOKEN_REQUEST): "name" is ' +
      'blank or missing, "scopes" is empty or missing, an entry in "scopes" is not one of ' +
      '"ingest"/"read"/"telemetry"/"stream", or the body names a field the schema does not — ' +
      'MintTokenRequestSchema is `.strict()`, so an extra field (e.g. a caller-supplied ' +
      '"projectId") lands here rather than being silently ignored. ' +
      'application/problem+json with a required "remediation".',
    content: problem(),
  },
  LiveOpened: {
    description:
      'The run is open and accepting POST /v1/runs/{id}/stream chunks at byte "nextOffset" — 0 ' +
      'for a genuinely new run, or the run\'s already-accepted byte count for an idempotent ' +
      'retry of the same "idempotencyKey".',
    content: json(schemaRef('OpenLiveRunResponse')),
  },
  LiveOpenRejected: {
    description:
      'Either the request body failed OpenLiveRunRequestSchema (code INVALID_LIVE_OPEN — ' +
      '"tool" is missing or unrecognized, or an optional field is out of bounds), or (code ' +
      'PROJECT_REQUIRED) the caller authenticated with a session, which names no project — ' +
      'only a project-scoped token can open a live run. The latter is unreachable through the ' +
      'credential model as it stands today: a session never carries the "stream" scope (see ' +
      'bearerAuth\'s description below), so it is refused earlier and differently, by the scope ' +
      'check itself. Kept for the same defensive symmetry POST /v1/runs\'s own PROJECT_REQUIRED ' +
      'check has. application/problem+json with a required "remediation".',
    content: problem(),
  },
  StreamAccepted: {
    description:
      'The chunk landed. "nextOffset" is the byte offset to send the NEXT chunk at (or to ' +
      'resume from after a reconnect) — the only thing this response says, deliberately, since ' +
      'a streaming caller may be posting in a loop for hours.',
    content: json(schemaRef('StreamAccepted')),
  },
  StreamRejected: {
    description:
      'The declared "X-Stream-Offset" is AHEAD of this run\'s current byte cursor (a gap), or ' +
      'the run is no longer "running" (already closed). An offset BEHIND the cursor is a ' +
      'different case entirely — a replay, answered 202 as a no-op, which is what makes the ' +
      'agent\'s own retries idempotent; see StreamAccepted. A required "remediation", plus — a ' +
      'field this response carries that plain ProblemDetails does not, which is why this is its ' +
      'own schema rather than a $ref to ProblemDetails (a bare object schema like that one\'s ' +
      'implies "no other properties") — a top-level "nextOffset", the exact field the 202 case ' +
      'carries too, so a caller\'s resume loop reads the same field regardless of which status ' +
      'code it got back.',
    content: { 'application/problem+json': { schema: schemaRef('StreamRejected') } },
  },
  RunNotRunning: {
    description:
      'This run is not in the "running" state — already closed, or never opened for streaming ' +
      'in the first place. application/problem+json with a required "remediation".',
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
    get: {
      operationId: 'listRuns',
      summary: 'Cursor-paginated list of runs, scoped by credential',
      tags: ['runs'],
      description:
        'Requires the "read" scope. Scoped by the credential, not by the URL: a project-scoped ' +
        'token sees only that project\'s runs, exactly like GET /v1/projects/{slug}/runs; a ' +
        'session names no project and sees every run across its whole org instead, unless ' +
        '"project" below narrows it to one. This is the session-reachable list route named by ' +
        'GET /v1/projects/{slug}/runs\'s PROJECT_REQUIRED remediation.',
      parameters: [parameters['Limit']!, parameters['Cursor']!, parameters['ProjectFilter']!],
      responses: {
        '200': { description: 'Newest-first page of runs.', content: json(schemaRef('RunListResponse')) },
        '400': ref('BadRequest'),
        '404': ref('NotFound'),
        ...authFailureResponses,
      },
    },
    post: {
      operationId: 'ingestRun',
      summary: 'Ingest a Gatling results bundle',
      tags: ['runs'],
      // A session names no project (see listRuns and this operation's 400
      // PROJECT_REQUIRED response below), so it can never satisfy this
      // route — bearer-only, overriding the document-level "either
      // credential" default.
      security: [{ bearerAuth: [] }],
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

  '/v1/runs/live': {
    post: {
      operationId: 'openLiveRun',
      summary: 'Open a run fed by POST /v1/runs/{id}/stream rather than a bundle upload',
      tags: ['runs'],
      // A session names no project (see openLiveRun's 400 LiveOpenRejected
      // response), so it can never satisfy this route even before scope is
      // considered — bearer-only, overriding the document-level "either
      // credential" default, exactly as POST /v1/runs does and for the same
      // reason. Here a session is refused even earlier, by the "stream"
      // scope check itself, since no session carries that scope — see
      // bearerAuth's description below.
      security: [{ bearerAuth: [] }],
      description:
        'Requires the "stream" scope. Creates a "running" run immediately (unlike POST ' +
        '/v1/runs, this never waits on a terminal state — there is nothing to wait for yet) ' +
        'and returns where to stream its bytes. Takes the same frozen metadata a bundle ' +
        'upload does — "environment"/"branch"/"commitSha", plus "idempotencyKey" so a retried ' +
        'open (e.g. after a network timeout) rejoins the run it already created instead of ' +
        'starting a second one.',
      requestBody: {
        required: true,
        description: '"tool" is required; every other field is optional, exactly as on POST /v1/runs.',
        content: json(schemaRef('OpenLiveRunRequest')),
      },
      responses: {
        '201': ref('LiveOpened'),
        '400': ref('LiveOpenRejected'),
        ...authFailureResponses,
      },
    },
  },

  '/v1/runs/{id}/stream': {
    post: {
      operationId: 'streamLiveRunChunk',
      summary: 'Feed one chunk of simulation.log bytes into a live run',
      tags: ['runs'],
      // Same reasoning as POST /v1/runs/live: a session can never carry the
      // "stream" scope, so this route is bearer-only.
      security: [{ bearerAuth: [] }],
      description:
        'Requires the "stream" scope. The body is the raw bytes of this chunk; ' +
        '"X-Stream-Offset" (required) names the byte offset they begin at. The server holds ' +
        'the run\'s expected offset: a match appends and answers 202; an offset behind the ' +
        'cursor is a no-op 202 (a replay — this is what makes the agent\'s own retries ' +
        'idempotent); an offset ahead of the cursor, or a run that is no longer "running", is a ' +
        '409 naming the offset to resume from. Rejected with 413 if this single chunk, or the ' +
        'run\'s total accepted bytes including it, would exceed the project\'s bundle size limit ' +
        '— the same limit and the same code POST /v1/runs enforces.',
      parameters: [parameters['RunId']!, parameters['StreamOffset']!],
      requestBody: {
        required: true,
        description: 'Raw chunk bytes, starting at "X-Stream-Offset".',
        content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } },
      },
      responses: {
        '202': ref('StreamAccepted'),
        '400': ref('BadRequest'),
        '404': ref('NotFound'),
        '409': ref('StreamRejected'),
        '413': ref('BundleTooLarge'),
        ...authFailureResponses,
      },
    },
  },

  '/v1/runs/{id}/close': {
    post: {
      operationId: 'closeLiveRun',
      summary: 'Close a live run and finalize it',
      tags: ['runs'],
      // Same reasoning as POST /v1/runs/live: a session can never carry the
      // "stream" scope, so this route is bearer-only.
      security: [{ bearerAuth: [] }],
      description:
        'Requires the "stream" scope. A run that received at least one byte is finalized ' +
        'through the SAME pipeline a bundle upload is — this operation shares POST ' +
        '/v1/runs\'s state machine (200/202/400/413/422) and description for exactly that ' +
        'reason: a streamed run becomes a row indistinguishable from an uploaded one. A run ' +
        'closed having received zero bytes finalizes immediately as "incomplete" instead ' +
        '(200, "verdict": "not_evaluated") — see GET /v1/runs/{id}\'s RunResponse for that ' +
        'shape. Closing a run that is not currently "running" (already closed, or never a live ' +
        'run) is a 409.',
      parameters: [parameters['RunId']!],
      responses: {
        ...runStateResponses(),
        '404': ref('NotFound'),
        '409': ref('RunNotRunning'),
        ...authFailureResponses,
      },
    },
  },

  '/v1/runs/{id}/stats': {
    get: {
      operationId: 'getRunStats',
      summary: 'Per-scope statistics table for a run',
      tags: ['metrics'],
      description:
        'Requires the "read" scope. Indicator bands ("indicators" on each row, and the ' +
        'top-level "indicators") are folded from the run\'s stored histogram at the project\'s ' +
        'current "indicators" bounds — see "configurable" and "bounds" on the response.',
      parameters: [
        parameters['RunId']!,
        parameters['StatsScope']!,
        parameters['StatsName']!,
        parameters['StatsFamily']!,
      ],
      responses: {
        '200': { description: 'Statistics for this run, optionally filtered.', content: json(schemaRef('StatsResponse')) },
        '400': ref('StatsBadRequest'),
        '404': ref('NotFound'),
        ...authFailureResponses,
      },
    },
  },

  '/v1/runs/{id}/trends': {
    get: {
      operationId: 'getRunTrends',
      summary: 'This run in the context of its cohort',
      tags: ['metrics'],
      description:
        'Requires the "read" scope. The cohort is every complete run of the SAME SIMULATION ' +
        'in the same project, newest first — with a null simulation forming its own cohort ' +
        'rather than matching every run. "cohortSize" is the whole cohort and may exceed the ' +
        'number of runs returned, which "limit" caps. Percentiles are recomputed from each ' +
        'run\'s stored sketch at the project\'s current percentile set, exactly as ' +
        'GET /v1/runs/{id}/stats does, so the two cannot disagree.',
      parameters: [parameters['RunId']!, parameters['Limit']!],
      responses: {
        '200': {
          description: 'This run\'s cohort, newest first.',
          content: json(schemaRef('TrendsResponse')),
        },
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
      parameters: [
        parameters['RunId']!,
        parameters['SeriesScope']!,
        parameters['SeriesName']!,
        parameters['SeriesFamily']!,
      ],
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
      description: 'Requires the "read" scope. See "scope" below for the default-scope behavior.',
      parameters: [parameters['RunId']!, parameters['ErrorsScope']!, parameters['ErrorsName']!],
      responses: {
        '200': { description: 'Distinct error messages and counts, most frequent first.', content: json(schemaRef('ErrorsResponse')) },
        '400': ref('BadRequest'),
        '404': ref('NotFound'),
        ...authFailureResponses,
      },
    },
  },

  '/v1/runs/{id}/distribution': {
    get: {
      operationId: 'getRunDistribution',
      summary: 'Response-time histogram (Gatling-style bucketed distribution) for a run',
      tags: ['metrics'],
      description:
        'Requires the "read" scope. Folds the run\'s stored histogram for the given ' +
        'scope/name/family into Gatling-parity buckets. Unlike /series, an unmatched ' +
        'scope/name/family combination 404s rather than returning an empty result — see ' +
        '"scope" below.',
      parameters: [
        parameters['RunId']!,
        parameters['DistributionScope']!,
        parameters['DistributionName']!,
        parameters['DistributionFamily']!,
      ],
      responses: {
        '200': { description: 'Bucketed OK/KO distribution.', content: json(schemaRef('DistributionResponse')) },
        '400': ref('BadRequest'),
        '404': ref('NotFound'),
        ...authFailureResponses,
      },
    },
  },

  '/v1/runs/{id}/users': {
    get: {
      operationId: 'getRunUsers',
      summary: 'Active-users-over-time series, per scenario and summed across scenarios',
      tags: ['metrics'],
      description:
        'Requires the "read" scope. No query parameters: always returns every scenario in the ' +
        'run. "total" is the per-scenario SUM at each offset (not a true max-of-sums) — this ' +
        'is what Gatling\'s own "All users" series is, verified against its fixture output.',
      parameters: [parameters['RunId']!],
      responses: {
        '200': { description: 'Per-scenario and total user-concurrency buckets.', content: json(schemaRef('UsersResponse')) },
        '400': ref('BadRequest'),
        '404': ref('NotFound'),
        ...authFailureResponses,
      },
    },
  },

  '/v1/runs/{id}/scatter': {
    get: {
      operationId: 'getRunScatter',
      summary: 'Response-time-vs-throughput scatter plot for one request',
      tags: ['metrics'],
      description:
        'Requires the "read" scope. For each bucket where a status-filtered p95 digest exists ' +
        'for the named request, plots that (truncated, not rounded) p95 against the run-level ' +
        'requests/sec rate in the same bucket — one point per status per bucket, so a bucket ' +
        'with both successes and failures contributes to both "ok" and "ko".',
      parameters: [parameters['RunId']!, parameters['ScatterName']!],
      responses: {
        '200': { description: 'OK and KO (x=throughput, y=p95) point series.', content: json(schemaRef('ScatterResponse')) },
        '400': ref('BadRequest'),
        '404': ref('NotFound'),
        ...authFailureResponses,
      },
    },
  },

  '/v1/runs/{id}/telemetry': {
    get: {
      operationId: 'getRunTelemetry',
      summary: "Host telemetry for this run, on the run's own elapsed axis",
      tags: ['metrics'],
      description:
        'Requires the "read" scope. Every point\'s "startOffsetMs" is elapsed ms from this ' +
        'run\'s own "toolStartedAt", bucketed at this run\'s own "bucketWidthMs" — the same ' +
        'axis GET /v1/runs/{id}/series uses, which is what lets "from"/"to" here mean exactly ' +
        'what they mean there. Takes no "scope" or "name": telemetry is a property of the ' +
        'MACHINE, not of a request or a group — the one dimension is "host", one entry per ' +
        'host that reported. "available" is false when this run has no telemetry at all — ' +
        'either "toolStartedAt" is null (the run never finished parsing, so it has no elapsed ' +
        'axis to place a sample on) or no agent ever reported inside its window. It is computed ' +
        'BEFORE "from"/"to" narrows the response, so a window over a quiet stretch of a run ' +
        'that WAS recorded still reports "available": true with an empty "hosts" for that ' +
        'slice — never "this run was never recorded".',
      parameters: [parameters['RunId']!, parameters['TelemetryFrom']!, parameters['TelemetryTo']!],
      responses: {
        '200': {
          description: 'Per-host telemetry series, or "available: false" with an empty "hosts".',
          content: json(schemaRef('TelemetryResponse')),
        },
        '400': ref('BadRequest'),
        '404': ref('NotFound'),
        ...authFailureResponses,
      },
    },
  },

  '/v1/projects': {
    get: {
      operationId: 'listProjects',
      summary: 'Projects this credential can see',
      tags: ['projects'],
      description:
        'Requires the "read" scope. A session names no project and sees every project in its ' +
        'org; a bearer token is minted against exactly one and sees that one, as a ' +
        'one-element list. Each project carries its most recent run by the same ordering ' +
        'GET /v1/runs uses, or null for a project nothing has been ingested into. Not ' +
        'paginated: an org has a handful of projects, not a page of them.',
      responses: {
        '200': {
          description: 'Every project this credential can see, ordered by name.',
          content: json(schemaRef('ProjectListResponse')),
        },
        ...authFailureResponses,
      },
    },
  },

  '/v1/projects/{slug}/runs': {
    get: {
      operationId: 'listProjectRuns',
      summary: 'Cursor-paginated list of runs in a project',
      tags: ['projects'],
      // A session names no project, so it can never satisfy this route's
      // tenancy check (400 PROJECT_REQUIRED below names GET /v1/runs as the
      // session-reachable equivalent) — bearer-only, overriding the
      // document-level "either credential" default.
      security: [{ bearerAuth: [] }],
      description:
        'Requires the "read" scope. 404s if "slug" does not name the project the bearer ' +
        'token belongs to — a token cannot list a project by naming a different one.',
      parameters: [parameters['ProjectSlug']!, parameters['Limit']!, parameters['Cursor']!],
      responses: {
        '200': { description: 'Newest-first page of runs.', content: json(schemaRef('RunListResponse')) },
        '400': ref('ProjectRunsBadRequest'),
        '404': ref('NotFound'),
        ...authFailureResponses,
      },
    },
  },

  '/v1/projects/{slug}/tokens': {
    post: {
      operationId: 'mintProjectToken',
      summary: 'Mint a new API token for a project',
      tags: ['tokens'],
      // The MIRROR of POST /v1/runs's bearer-only override, for the OPPOSITE
      // reason: that route needs a project-scoped bearer identity a session
      // cannot supply. Here a bearer credential must never be accepted at
      // all, no matter its scopes — SessionOnlyGuard refuses it before the
      // handler runs, because a scope check would let any credential holding
      // that scope mint itself a broader one. Without this override the
      // document would advertise an authentication scheme (bearerAuth) the
      // handler always rejects.
      security: [{ cookieAuth: [] }],
      description:
        'Requires a signed-in session — refused for ANY bearer token regardless of scopes (see ' +
        'SessionOnlyGuard and the 403 response below). "token" in the 201 response is the ONLY ' +
        'moment the plaintext credential is ever returned: only its hash is persisted, so it ' +
        'cannot be recovered later — a caller who loses it mints a replacement.',
      parameters: [parameters['TokenProjectSlug']!],
      requestBody: {
        required: true,
        description:
          'A non-empty "name" for the credential (what an operator sees on a revocation list ' +
          'later) and at least one scope from ["ingest", "read", "telemetry"].',
        content: json(schemaRef('MintTokenRequest')),
      },
      responses: {
        '201': {
          description:
            'Minted. "scopes" echoes back exactly what was requested — this route grants no ' +
            'scope the caller did not ask for.',
          content: json(schemaRef('MintedToken')),
        },
        '400': ref('InvalidTokenRequest'),
        '401': ref('Unauthorized'),
        '403': ref('SessionRequired'),
        '404': ref('NotFound'),
      },
    },
    get: {
      operationId: 'listProjectTokens',
      summary: "List a project's API tokens",
      tags: ['tokens'],
      // Same override and the same reason as the POST above: this route
      // accepts no bearer credential at all (SessionOnlyGuard), so
      // advertising bearerAuth here would document an authentication the
      // handler always rejects.
      security: [{ cookieAuth: [] }],
      description:
        'Requires a signed-in session — refused for ANY bearer token regardless of scopes (see ' +
        'SessionOnlyGuard and the 403 response below). Newest first. Each entry is a ' +
        'TokenSummary: "token" and the stored hash never appear here — the plaintext existed ' +
        'once, in the 201 response the mint returned, and cannot be recovered. "lastUsedAt" is ' +
        'what makes the list actionable: it is how an operator finds the credential nothing has ' +
        'used since March.',
      parameters: [parameters['TokenProjectSlug']!],
      responses: {
        '200': {
          description: 'This project\'s tokens, newest first.',
          content: json(schemaRef('TokenListResponse')),
        },
        '401': ref('Unauthorized'),
        '403': ref('SessionRequired'),
        '404': ref('NotFound'),
      },
    },
  },

  '/v1/projects/{slug}/tokens/{prefix}': {
    delete: {
      operationId: 'revokeProjectToken',
      summary: 'Revoke a project API token',
      tags: ['tokens'],
      // Same override and the same reason as POST /v1/projects/{slug}/tokens:
      // this route accepts no bearer credential at all, no matter its
      // scopes — SessionOnlyGuard refuses it before the handler runs.
      security: [{ cookieAuth: [] }],
      description:
        'Requires a signed-in session — refused for ANY bearer token regardless of scopes (see ' +
        'SessionOnlyGuard and the 403 response below). Sets "revokedAt"; every subsequent ' +
        'authentication attempt with this token then fails with 401 (see cookieAuth and ' +
        'bearerAuth). IDEMPOTENT: revoking an already-revoked token still returns 200 with the ' +
        'ORIGINAL "revokedAt", not a newer one, so the record keeps saying when the credential ' +
        'actually stopped working. 404 (code NOT_FOUND) when "prefix" does not name a token in ' +
        'this project — including a prefix that belongs to a different project or org, which ' +
        'answers the same 404 rather than confirming that the token exists elsewhere.',
      parameters: [parameters['TokenProjectSlug']!, parameters['TokenPrefix']!],
      responses: {
        '200': {
          description: 'Revoked (or already was). The token\'s current summary, "revokedAt" now set.',
          content: json(schemaRef('TokenSummary')),
        },
        '401': ref('Unauthorized'),
        '403': ref('SessionRequired'),
        '404': ref('NotFound'),
      },
    },
  },

  '/v1/telemetry': {
    post: {
      operationId: 'postTelemetry',
      summary: "Ingest a batch of an agent's host-counter samples",
      tags: ['telemetry'],
      // A session names no project, so it can never satisfy this route —
      // bearer-only, overriding the document-level "either credential"
      // default, exactly as POST /v1/runs does and for the same reason.
      // (Here a session is refused even earlier, by the "telemetry" scope
      // check itself, since no session carries that scope — see
      // TelemetryRejected's description below. There is no reachable 400
      // PROJECT_REQUIRED case for this operation.)
      security: [{ bearerAuth: [] }],
      description:
        'Requires the "telemetry" scope — deliberately not "ingest": an agent token lives on a ' +
        'load generator, a machine an attacker is far likelier to reach than the API or a CI ' +
        'runner, and this scope can do exactly one thing. "orgId" and "projectId" come from the ' +
        'token, never the body — TelemetryBatchSchema is `.strict()`, so a payload naming ' +
        'either is a 400, not a silently-ignored field. Every counter is the agent\'s RAW ' +
        'cumulative reading, not a rate: the sampling interval is the agent\'s and it drifts, so ' +
        'a rate computed server-side against an assumed interval would be wrong by exactly that ' +
        'drift. Idempotent under retry — a batch resent after a timeout that actually succeeded ' +
        'inserts nothing twice, so "accepted" on a retried batch may be smaller than the batch ' +
        'size without that being an error.',
      requestBody: {
        required: true,
        description: 'The generator\'s label plus 1–500 raw samples.',
        content: json(schemaRef('TelemetryBatch')),
      },
      responses: {
        '202': {
          description: 'Stored. "accepted" is the number of rows actually inserted — smaller ' +
            'than "samples.length" only when this batch was already partly stored by a prior ' +
            'attempt.',
          content: json({
            type: 'object',
            required: ['accepted'],
            properties: { accepted: { type: 'integer' } },
          }),
        },
        '400': ref('TelemetryRejected'),
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
    // Either credential satisfies a /v1 route by default — see
    // SecurityRequirement's docstring above for why this is an array of
    // single-scheme entries rather than one two-scheme entry. POST /v1/runs
    // and GET /v1/projects/{slug}/runs override this to bearer-only, above,
    // because a session cannot satisfy either (both require a project).
    security: [{ bearerAuth: [] }, { cookieAuth: [] }],
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
            'token with the "ingest" scope; every GET requires "read"; POST /v1/telemetry ' +
            'requires "telemetry"; POST /v1/runs/live, POST /v1/runs/{id}/stream, and POST ' +
            '/v1/runs/{id}/close require "stream" — a FOURTH scope, deliberately not a reuse ' +
            'of "ingest", because that token lives on the same load generator "telemetry" ' +
            'does and should be equally narrow: it can open, feed, and close exactly one live ' +
            'run, and do nothing else. Scoped to an org AND a project, and the only credential ' +
            'POST /v1/runs, POST /v1/telemetry, POST /v1/runs/live, POST /v1/runs/{id}/stream, ' +
            'POST /v1/runs/{id}/close, and GET /v1/projects/{slug}/runs accept — see cookieAuth ' +
            'for the session alternative everywhere else.',
        },
        cookieAuth: {
          type: 'apiKey',
          in: 'cookie',
          name: 'better-auth.session_token',
          description:
            'A Better Auth session cookie, obtained via POST /auth/sign-up/email or ' +
            '/auth/sign-in/email (see the root README\'s Authentication section — /auth/* is ' +
            'Better Auth\'s own surface, not this document). Scoped to an org only, no ' +
            'project, so it cannot satisfy POST /v1/runs, POST /v1/telemetry, POST ' +
            '/v1/runs/live, POST /v1/runs/{id}/stream, POST /v1/runs/{id}/close, or ' +
            'GET /v1/projects/{slug}/runs (all require a project); GET /v1/runs is the ' +
            'org-wide equivalent a session can use instead. Its scopes are ["read", "ingest"] ' +
            '— NOT "telemetry" and NOT "stream": a browser session has no reason to post host ' +
            'counters or stream a run, and widening it would make either scope\'s whole ' +
            'purpose decorative, so both are refused by their own @Scopes() check even before ' +
            'the missing-project check above applies. Minted with the Secure attribute ' +
            'unconditionally, so it requires an HTTPS origin — see the root README\'s ' +
            'Authentication section.',
        },
      },
      parameters,
      headers,
      responses,
    },
  };
}
