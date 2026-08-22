# SLA rule authoring — design

2026-08-22. Rules are the only configuration this platform evaluates and the
only one it has never let anyone write: `sla_rule` rows exist solely because
tests and fixtures insert them with direct Prisma calls (`apps/web/e2e/fixtures.ts:452`,
`apps/api/test/verdict.integration.test.ts:102`, and four more). There is no
endpoint, no UI, and no validation on the write path. This closes that.

Three decisions were made explicitly and are settled:

1. **Rules gain a name and timestamps.** One additive migration.
2. **Removal is disable AND delete.** `enabled` already exists and is what
   evaluation filters on; a two-step delete mirrors token revocation.
3. **Only `threshold`, `enabled` and `name` are mutable.** A rule's identity
   is WHAT it measures; changing that is a different rule.

## The problem worth solving first

`resolveMetric` (`packages/sla/src/metrics.ts:41`) resolves a metric name
against `SCALARS` — `count`, `mean`, `min`, `max`, `stddev`, `error_rate`,
`throughput_rps` — or the percentile pattern `/^p(\d+(?:\.\d+)?)$/` with the
number strictly inside (0, 100). An unresolvable name **does not error**. It
returns `null`, and `evaluateRules` records `not_applicable`
(`packages/sla/src/evaluate.ts:146-156`).

So a rule authored as `p95th` instead of `p95` produces a gate that renders as
"not checked" on every run forever, while looking like configured protection.
The engine is right to degrade rather than throw — a rule may legitimately
target a metric a given run has no data for — but that tolerance is exactly
why the AUTHORING path must reject what the engine will silently ignore.
Validation at the write path is the point of this sub-project, not a detail of
it.

The same argument applies to the scope/target pairing: `scope: 'run'` reads
`targetName ?? ''` and matches the run row, while every other scope needs a
name to match against. A `request`-scoped rule with a null target silently
matches nothing.

## Schema

`packages/persistence/prisma/schema.prisma`, model `SlaRule`:

| column | type | note |
| --- | --- | --- |
| `name` | `String?` / `text NULL` | human label; null for the rules that already exist |
| `createdAt` | `DateTime @db.Timestamptz` default `now()` | |
| `updatedAt` | `DateTime @db.Timestamptz @updatedAt` | |

`timestamptz`, not bare `timestamp`, per CLAUDE.md's instant-column rule.
`sla_rule` is read only through Prisma today, which is the same thing that was
true of the `run` columns before a raw-pool read on one of them produced a
5h30m discrepancy — the rule exists so the next reader does not have to
rediscover it.

Additive only: `created_at` takes `now()` for existing rows, `updated_at`
likewise, `name` stays null. No index changes — `@@index([projectId, enabled])`
still serves `listEnabled`, and the authoring list is per-project and small.

## Contracts — `packages/contracts/src/rules.ts`

Requests `.strict()`; responses deliberately loose. `TokenSummarySchema`
records why (`packages/contracts/src/tokens.ts:64-79`): a response schema that
re-asserts an enum turns one stale row into a 500 for the whole list. So the
response types `scope`, `family` and `comparator` as `z.string()` while the
request uses `z.enum`.

- `SLA_RULE_SCOPES`, `SLA_RULE_FAMILIES`, `SLA_RULE_COMPARATORS`,
  `SLA_METRIC_SCALARS` — const arrays, declared here rather than imported from
  `apps/api`, because the browser consumes this package.
- `SlaMetricSchema` — a refined string: a member of `SLA_METRIC_SCALARS`, or
  `p<number>` with the number strictly in (0, 100). Mirrors `resolveMetric`
  exactly, and a test pins the two against each other.
- `CreateSlaRuleRequestSchema` — `name?`, `scope`, `targetName` (nullable),
  `family`, `metric`, `comparator`, `threshold`, with a `.refine()` for the
  scope/target pairing.
- `UpdateSlaRuleRequestSchema` — `threshold?`, `enabled?`, `name?`, refined to
  require at least one field, so an empty PATCH is a 400 rather than a silent
  no-op.
- `SlaRuleSchema`, `SlaRuleListResponseSchema`.

## Persistence

`RuleRepository` (`packages/persistence/src/repositories/rule.ts`) currently
has exactly one method, `listEnabled`. It gains `listForProject` (all rules,
enabled or not, newest first), `create`, `update` and `remove`.

Every one takes a `ProjectScope` and puts `orgId` + `projectId` in the `where`
clause — including the single-row operations, which therefore return `null`
for a rule belonging to another org rather than touching it. The controller
turns that `null` into a 404, never a 403, the same way `resolveProject` does
for a slug outside the caller's org.

`SlaRuleRecord` stays as it is — the seven fields evaluation needs, no more.
The authoring API returns a wider `SlaRuleRow` shape; conflating the two would
put `name` and timestamps into the object the evaluator reads, which has no
use for them.

## API — `apps/api/src/rules/`

`@Controller('/v1/projects/:slug/rules')` with `@UseGuards(SessionOnlyGuard)`
at CLASS level, following `TokensController` rather than `ProjectsController`:
every route here is authoring, and a CI bearer token has no business editing a
release gate. (`ProjectsController` puts the guard per-handler precisely
because its `list` must stay bearer-reachable; nothing here is.)

| method | path | code |
| --- | --- | --- |
| POST | `/v1/projects/{slug}/rules` | 201 |
| GET | `/v1/projects/{slug}/rules` | 200 |
| PATCH | `/v1/projects/{slug}/rules/{ruleId}` | 200 |
| DELETE | `/v1/projects/{slug}/rules/{ruleId}` | 200, returns the deleted rule |

`@Body() body: unknown` + `safeParse` + `badRequest(code, message, remediation)`
— there is no global `ValidationPipe` and `projects.controller.ts:42-45`
explains why. Every response is re-parsed through its contract schema before
return.

Two knock-on edits outside the new module:

- `PathItemObject` (`apps/api/src/openapi/document.ts:70-74`) declares only
  `get`, `post` and `delete`. It gains `patch`.
- `CREATES_SYNCHRONOUSLY` (`apps/api/test/openapi.integration.test.ts:96`)
  gains `POST /v1/projects/{slug}/rules`. That test's own standard for a 201 is
  a handler that "awaits a single Prisma insert and returns the row it just
  wrote… complete and addressable the instant the response is sent", which
  this is — as opposed to `POST /v1/runs`, whose row is a promise to parse
  something later. The carve-out is bidirectional, so the operation must also
  actually declare 201.

## UI

`apps/web/src/api/rules.ts` — `projectRulesQueryKey(slug)` plus four client
functions, exactly the shape of `api/tokens.ts`.

`ProjectSetup` gains an **SLA rules** card below API tokens:

- **Create form** — name, scope, target name (rendered only when scope is not
  `run`), family, metric, comparator, threshold. Validated client-side against
  `CreateSlaRuleRequestSchema` before the mutation fires, the way
  `NewProject.tsx:36-45` does, so a bad metric is caught without a round trip
  and the server's own rejection stays the backstop.
- **Rules table** — the rule as `describeAssertionRule()` renders it, so the
  authoring table, the run page's assertion list and the evaluator's own
  message all phrase a rule identically; plus name, threshold, status, and
  actions. Enable/disable is a single button. Delete is the two-step arm that
  `TokenTable` establishes (`ProjectSetup.tsx:297-312`): no modal, no
  `window.confirm`, no `title=` on a labelled button, and the consequence as
  visible sibling text.

**Deliberately not in scope:** validating `targetName` against real request
names. It needs a run to check against, and a rule authored before a project's
first run legitimately names something not yet seen. A picker sourced from
recent runs is the obvious follow-up and is recorded here so it is not
mistaken for an oversight.

## Verification

The full gate, integration before e2e on an idle stack. New tests:

- **contracts** — `SlaMetricSchema` accepts exactly what `resolveMetric`
  resolves (the two are pinned against each other, including the (0, 100)
  bound), and the scope/target refinement in both directions.
- **persistence** — CRUD, plus a rule in another org being invisible to
  `update` and `remove`.
- **api integration** — create/list/patch/delete, a 400 for an unresolvable
  metric, a 404 for a cross-org rule id, and a bearer token refused where a
  session succeeds.
- **web unit** — the form's client-side validation and the table's two-step
  delete.

Floors move; the numbers in CLAUDE.md are updated in the same change.
