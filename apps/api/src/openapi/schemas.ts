import { z } from 'zod';
import {
  ActivityResponseSchema,
  AiAnalysisResponseSchema,
  OrgSettingsSchema,
  UpdateOrgSettingsRequestSchema,
  AgentConnectionsResponseSchema,
  AgentDnsResponseSchema,
  AgentInjectorsResponseSchema,
  AgentStatusResponseSchema,
  AgentSummaryResponseSchema,
  DurationSectionSchema,
  AddMemberRequestSchema,
  AdminProjectListResponseSchema,
  AdminProjectSchema,
  AdminUserListResponseSchema,
  AdminUserSchema,
  RecomputeProgressSchema,
  VerdictChangeSchema,
  DataIntegritySchema,
  FigureMismatchSchema,
  GatlingDifferenceSchema,
  VerificationSchema,
  VerificationSummarySchema,
  ChangePasswordRequestSchema,
  CreateUserRequestSchema,
  MemberListResponseSchema,
  ProjectMemberSchema,
  SetPasswordRequestSchema,
  UpdateMemberRequestSchema,
  UpdateUserRequestSchema,
  DistributionResponseSchema,
  ErrorSeriesResponseSchema,
  ErrorsResponseSchema,
  IndicatorBandsSchema,
  CreateProjectRequestSchema,
  CreatePublicLinkRequestSchema,
  CreatePublicLinkResponseSchema,
  PublicLinkListResponseSchema,
  PublicLinkResolveResponseSchema,
  PublicLinkSchema,
  IngestMetadataSchema,
  MintedTokenSchema,
  MintTokenRequestSchema,
  OpenLiveRunRequestSchema,
  OpenLiveRunResponseSchema,
  ProblemDetailsSchema,
  ProjectListResponseSchema,
  CreateSlaRuleRequestSchema,
  OrgTestListResponseSchema,
  OrgTestSummarySchema,
  TestListResponseSchema,
  TestSummarySchema,
  UpdateTestRequestSchema,
  SlaRuleListResponseSchema,
  SlaRuleSchema,
  UpdateSlaRuleRequestSchema,
  RunEventsResponseSchema,
  RunListResponseSchema,
  RunNoteRequestSchema,
  RunNoteResponseSchema,
  RunProcessingSchema,
  RunResponseSchema,
  ProjectSummarySchema,
  ScatterResponseSchema,
  SeriesResponseSchema,
  StatRowSchema,
  StatsResponseSchema,
  StreamAcceptedSchema,
  StreamRejectedSchema,
  RunnerStartByPackageRequestSchema,
  RunnerStartMetadataSchema,
  RunnerStartResponseSchema,
  RunnerJobListResponseSchema,
  RunnerJobActionResponseSchema,
  RunnerJobLogsResponseSchema,
  PackageListResponseSchema,
  PackageSchema,
  PackageUsageSchema,
  PackageVersionSchema,
  CreatePackageRequestSchema,
  RenamePackageRequestSchema,
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
const SOURCE: Record<string, z.ZodType> = {
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
  RunEventsResponse: RunEventsResponseSchema,
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
  OrgTestSummary: OrgTestSummarySchema,
  OrgTestListResponse: OrgTestListResponseSchema,
  ActivityResponse: ActivityResponseSchema,
  UpdateTestRequest: UpdateTestRequestSchema,
  RunNoteRequest: RunNoteRequestSchema,
  RunNoteResponse: RunNoteResponseSchema,
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
  RunnerStartByPackageRequest: RunnerStartByPackageRequestSchema,
  RunnerStartResponse: RunnerStartResponseSchema,
  RunnerJobListResponse: RunnerJobListResponseSchema,
  RunnerJobActionResponse: RunnerJobActionResponseSchema,
  RunnerJobLogsResponse: RunnerJobLogsResponseSchema,
  // PACKAGES: a project's named, reusable Gatling artifacts.
  Package: PackageSchema,
  PackageVersion: PackageVersionSchema,
  PackageUsage: PackageUsageSchema,
  PackageListResponse: PackageListResponseSchema,
  CreatePackageRequest: CreatePackageRequestSchema,
  RenamePackageRequest: RenamePackageRequestSchema,
  // ADMINISTRATION, PROJECT MEMBERS AND ONE'S OWN PASSWORD (project access,
  // PR 2). Registered ahead of the routes that reference them: a component no
  // operation names is still a valid document — `StatRow` and `TrendRun`
  // above are referenced by no operation today, and the validator passes.
  AdminUser: AdminUserSchema,
  AdminUserListResponse: AdminUserListResponseSchema,
  CreateUserRequest: CreateUserRequestSchema,
  UpdateUserRequest: UpdateUserRequestSchema,
  SetPasswordRequest: SetPasswordRequestSchema,
  AdminProject: AdminProjectSchema,
  AdminProjectListResponse: AdminProjectListResponseSchema,
  // EXACT STATISTICS, PR 2: the backfill's progress for an admin, and the
  // verdict changes a recompute leaves on a run (the run responses embed
  // them; registered here so the shape has a name of its own).
  RecomputeProgress: RecomputeProgressSchema,
  VerdictChange: VerdictChangeSchema,
  // EXACT STATISTICS, PR 3: a run's verification (the run responses embed
  // its summary; `GET /v1/runs/{id}/verification` answers the whole record)
  // and an admin's data-integrity summary.
  VerificationSummary: VerificationSummarySchema,
  FigureMismatch: FigureMismatchSchema,
  Verification: VerificationSchema,
  // EXACT STATISTICS, PR 4: one percentile where Gatling's own report would
  // differ (the verification record embeds a list of them).
  GatlingDifference: GatlingDifferenceSchema,
  DataIntegrity: DataIntegritySchema,
  ProjectMember: ProjectMemberSchema,
  MemberListResponse: MemberListResponseSchema,
  AddMemberRequest: AddMemberRequestSchema,
  UpdateMemberRequest: UpdateMemberRequestSchema,
  ChangePasswordRequest: ChangePasswordRequestSchema,
  // GE REPORT PARITY, PR 2: the agent figures' five reads, and the duration
  // section three of them embed (TCP connect, TLS handshake, DNS resolution).
  AgentSummaryResponse: AgentSummaryResponseSchema,
  AgentConnectionsResponse: AgentConnectionsResponseSchema,
  AgentDnsResponse: AgentDnsResponseSchema,
  AgentInjectorsResponse: AgentInjectorsResponseSchema,
  AgentStatusResponse: AgentStatusResponseSchema,
  DurationSection: DurationSectionSchema,
  // AI RUN ANALYSIS: a run's analysis or why it has none, and the org's
  // switch (Administration's settings, read and written).
  AiAnalysisResponse: AiAnalysisResponseSchema,
  OrgSettings: OrgSettingsSchema,
  UpdateOrgSettingsRequest: UpdateOrgSettingsRequestSchema,
  // PUBLIC LINKS: one link, the create's body and answer (the answer carries
  // the secret, once), a run's list with the org's switch, and what a link
  // itself reads first — which run, and until when.
  PublicLink: PublicLinkSchema,
  CreatePublicLinkRequest: CreatePublicLinkRequestSchema,
  CreatePublicLinkResponse: CreatePublicLinkResponseSchema,
  PublicLinkListResponse: PublicLinkListResponseSchema,
  PublicLinkResolveResponse: PublicLinkResolveResponseSchema,
};

/**
 * The components a request BODY names — read by a client and parsed by this
 * server — as opposed to everything else here, which the server sends.
 *
 * ═══ ONE ZOD SCHEMA HAS TWO JSON SCHEMAS, AND WHICH ONE IS A FACT ABOUT USE ═══
 *
 * A field with a `.default()` may be OMITTED by a client and is ALWAYS present
 * in what the parse produces; a non-strict object accepts unknown keys (and
 * strips them) but never emits one. So a request body is described by its
 * INPUT and a response by its OUTPUT, and `z.toJSONSchema` asks which:
 *
 *     io: 'input'    defaulted fields optional, no `additionalProperties: false`
 *     io: 'output'   defaulted fields required, `additionalProperties: false`
 *
 * `zod-to-json-schema` answered with a mixture of the two for every schema —
 * input's requiredness with output's closed objects — which was right for
 * neither half. No component is both a request body and a response;
 * `openapi-dialect.test.ts` derives the set below from the document's own
 * `requestBody` references and fails naming any that drift, in either
 * direction.
 */
export const REQUEST_BODIES: ReadonlySet<string> = new Set([
  'IngestMetadata',
  'OpenLiveRunRequest',
  'RunNoteRequest',
  'CreateProjectRequest',
  'MintTokenRequest',
  'AddMemberRequest',
  'UpdateMemberRequest',
  'UpdateTestRequest',
  'RunnerStartByPackageRequest',
  'RunnerStartMetadata',
  'CreatePackageRequest',
  'RenamePackageRequest',
  'CreateSlaRuleRequest',
  'CreatePublicLinkRequest',
  'UpdateSlaRuleRequest',
  'ChangePasswordRequest',
  'CreateUserRequest',
  'UpdateOrgSettingsRequest',
  'UpdateUserRequest',
  'SetPasswordRequest',
  'TelemetryBatch',
]);

/**
 * Converts one Zod schema to a fully self-contained JSON Schema object, in
 * the JSON Schema 2020-12 dialect OpenAPI 3.1 — which `document.ts` declares —
 * uses. Nothing is registered with a metadata registry, so no internal `$ref`
 * is emitted and every component below is independently valid.
 *
 * `unrepresentable` is left at its default, `'throw'`: a schema this document
 * cannot describe (a transform, a date object) fails the module load rather
 * than shipping as `{}` — an empty schema is a claim that ANY value is valid.
 *
 * The `$schema` dialect key is dropped: it marks a schema DOCUMENT's dialect,
 * not a subschema embedded in one.
 *
 * zod 4 writes `exclusiveMinimum` as a NUMBER, the 2020-12 form, so the
 * draft-04 rewrite `zod-to-json-schema` needed is gone; `openapi-dialect.test.ts`
 * still refuses the boolean spelling, should a later converter bring it back.
 */
function toJsonSchema(name: string, schema: z.ZodType): JsonSchema {
  const out = z.toJSONSchema(schema, {
    target: 'draft-2020-12',
    io: REQUEST_BODIES.has(name) ? 'input' : 'output',
  }) as JsonSchema;
  delete out['$schema'];
  return out;
}

/** `components.schemas`, built once at module load. */
export const schemaComponents: Record<string, JsonSchema> = Object.fromEntries(
  Object.entries(SOURCE).map(([name, zodSchema]) => [name, toJsonSchema(name, zodSchema)]),
);

/** `{ "$ref": "#/components/schemas/<name>" }` for a name known to exist above. */
export function schemaRef(name: keyof typeof SOURCE): JsonSchema {
  return { $ref: `#/components/schemas/${name}` };
}
