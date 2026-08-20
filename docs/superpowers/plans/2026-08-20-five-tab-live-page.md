# Five-tab live page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a run page the same header, tab strip and five URLs from the moment the run is opened to the moment its report is read, so a run ending is a data swap rather than a layout swap.

**Architecture:** Widen the 202 body with the identity fields a non-terminal run genuinely knows, via one `RunIdentitySchema` that both `RunResponse` and `RunProcessing` extend. `RunShell` then mounts for every state, which makes the five tab URLs reachable with no router change. The standalone `Processing` and `Live` page components are deleted and their content redistributed to the tabs and to two new shell-level bands.

**Tech Stack:** TypeScript, Zod (contracts), NestJS + Express (API), React 18 + React Router 6 + TanStack Query 5 (web), Vitest + Testing Library (unit), Playwright (e2e), pnpm workspaces.

**Spec:** `docs/superpowers/specs/2026-08-20-five-tab-live-page-design.md`

## Global Constraints

- **Node from `.nvmrc` (22).** `nvm use` before any test run. On Node 20 roughly two thirds of the unit suite fails to LOAD and the run still prints a green `Test Files`/`Tests` summary above the error line.
- **Verification floors before this plan:** unit **103 files / 1150 tests**, integration **108 files / 1269 tests**, e2e **89** — this branch's `CLAUDE.md:56`, reproduced by a clean baseline run. (An earlier draft quoted 106/1179/111/1297/90; those are `feat/live-sla`'s figures and that branch is unmerged, so they are NOT reachable from here.) A unit run reporting fewer than 103 files did not run everything. Task 13 raises all three from measured output.
- **`pnpm test:unit` runs neither integration nor e2e.** `pnpm test:integration` RE-RUNS the unit `.ts` files but includes no `.tsx` at all, so a React component change verified only by `test:integration` has not been verified.
- **Every task's final verification ends with `pnpm typecheck && pnpm lint`.** A `vitest`-only gate ships lint failures: Task 6 landed `as any` in a test helper and passed its own verification, because `@typescript-eslint/no-explicit-any` is `error` via `tseslint.configs.recommended` in `eslint.config.js` with no test-file override, and nothing but `pnpm lint` sees it.
- **Gate order is integration BEFORE e2e**, never the reverse: `pnpm typecheck && pnpm lint && pnpm test:unit && pnpm test:integration && pnpm test:e2e`.
- **Integration and e2e need the local stack** and cannot run concurrently with each other or with themselves — `createTestApp()` TRUNCATEs all 15 tables on every call. Before believing an integration failure, run `pgrep -f vitest` and confirm you are alone.
- **No `uppercase` on anything queried by accessible name.** Playwright applies `text-transform` when computing a name; jsdom does not.
- **`getByRole(role, { name })` is EXACT in Testing Library and a case-insensitive SUBSTRING in Playwright.** Pass `exact: true` in e2e wherever a fallback value could be a substring of the intended one.
- **No decorative `<svg>` inside a chart `<figure>`.** `run-charts.spec.ts` and `request-detail.spec.ts` prove a chart drew by counting SVG elements within it.
- **Zero is a measurement.** A count that is not yet known is `null`, never `0`. A verdict that has not been evaluated is absent, never `'none'`.

## Dependency order

```
1 ──> 2
 └──> 3 ──┐
4 ────────┼──> 6 ──> 7 ──> 8, 9, 10, 11 ──> 12 ──> 13
5 ────────┘
                                    14 (conditional, independent)
```

## Prerequisite note: `SlaBanner` is not on this branch

Spec §3.7 places `SlaBanner` at shell level. That component ships in
`feat/live-sla`, which is **18 commits unmerged**; this branch is based on
`main`, where it does not exist and `LiveDeltaSchema` carries no `sla` field.

Task 14 is therefore **conditional** — run it only once `feat/live-sla` has
merged into this branch's base. **Also know the merge interaction:** this plan
DELETES the standalone `Live` component, which is exactly where `feat/live-sla`
renders `SlaBanner`. Whichever branch merges second will hit a conflict there,
and resolving it by keeping `Live` would silently undo this whole plan. The
correct resolution is: keep the deletion, and place `SlaBanner` per Task 14.

---

### Task 1: `RunIdentitySchema` in contracts

**Files:**
- Modify: `packages/contracts/src/run.ts:77-175`
- Test: `packages/contracts/test/live.test.ts`

**Interfaces:**
- Produces: `RunIdentitySchema` (Zod object), `type RunIdentity`. `RunResponseSchema` and `RunProcessingSchema` keep their existing exported names and types; `RunProcessing` gains every identity field as optional.
- Consumes: `ProjectRefSchema` (already exported from the same file).

- [ ] **Step 1: Write the failing tests**

Append to `packages/contracts/test/live.test.ts`, inside the existing `describe('live contracts', ...)`. Import `RunIdentitySchema` and `RunResponseSchema` alongside the existing imports.

```ts
  it('accepts a 202 body carrying the run identity a header needs', () => {
    const parsed = RunProcessingSchema.parse({
      id: '0f9b1d4e-1111-2222-3333-444455556666',
      status: 'running',
      statusUrl: '/v1/runs/0f9b1d4e-1111-2222-3333-444455556666',
      project: { id: '11111111-1111-4111-8111-111111111111', slug: 'checkout', name: 'Checkout' },
      tool: 'gatling',
      toolVersion: null,
      environment: 'staging',
      branch: 'main',
      commitSha: 'deadbeefcafe',
      simulation: null,
      description: null,
      durationMs: null,
      startedAt: '2026-08-20T10:43:49.546Z',
      toolStartedAt: null,
    });
    expect(parsed.project?.slug).toBe('checkout');
    expect(parsed.environment).toBe('staging');
  });

  it('still accepts the NARROW 202 body an older API pod sends', () => {
    // The rolling-deploy direction that matters most: a new browser polling an
    // old pod. A required identity field here blanks the run page for the whole
    // rollout, because the client parses with .parse() and drops what fails.
    const parsed = RunProcessingSchema.parse({
      id: '0f9b1d4e-1111-2222-3333-444455556666',
      status: 'running',
      statusUrl: '/v1/runs/0f9b1d4e-1111-2222-3333-444455556666',
    });
    expect(parsed.project).toBeUndefined();
    expect(parsed.tool).toBeUndefined();
  });

  it('keeps a verdict off the 202 body entirely, however wide it gets', () => {
    // Identity is what a run knows about ITSELF; a verdict is a measurement.
    // z.object strips unknown keys, so this asserts the field is absent from
    // the parsed result rather than merely unvalidated.
    const parsed = RunProcessingSchema.parse({
      id: '0f9b1d4e-1111-2222-3333-444455556666',
      status: 'running',
      statusUrl: '/v1/runs/0f9b1d4e-1111-2222-3333-444455556666',
      verdict: 'passed',
      assertions: [],
    }) as Record<string, unknown>;
    expect(parsed.verdict).toBeUndefined();
    expect(parsed.assertions).toBeUndefined();
  });

  it('a run body still requires the project a run row cannot be missing', () => {
    // RunResponseSchema extends the NON-partial identity, so extraction must
    // not have loosened the required-ness its own comment argues for.
    expect(() => RunIdentitySchema.parse({
      id: '0f9b1d4e-1111-2222-3333-444455556666',
      tool: 'gatling',
      startedAt: '2026-08-20T10:43:49.546Z',
    })).toThrow();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
nvm use && pnpm vitest run packages/contracts/test/live.test.ts
```

Expected: FAIL — `RunIdentitySchema` is not exported, and the wide-body case fails because `RunProcessingSchema` currently has only three keys and `z.object` strips the rest.

- [ ] **Step 3: Extract the identity schema**

In `packages/contracts/src/run.ts`, insert immediately after `ProjectRefSchema` (around line 76) and BEFORE `RunResponseSchema`:

```ts
/**
 * What a run knows about itself from the moment it exists, independent of
 * whether anything has parsed it.
 *
 * ONE SCHEMA, EXTENDED TWICE — by `RunResponseSchema` below and by
 * `RunProcessingSchema` further down. That is the anti-drift device and the
 * reason this is not a copied field list: adding a chip to the run header is
 * then one edit rather than two that can silently disagree about a field's
 * nullability.
 *
 * NO `status` HERE, deliberately. The two consumers enumerate their own
 * statuses independently (see `RunProcessingSchema`'s own comment), and
 * hoisting the field would make widening one widen the other.
 *
 * NO `verdict`, `windowable`, `assertions` or `error` either: those are
 * MEASUREMENTS, not identity, and keeping them off this schema is what stops
 * a running run's type from being able to express one.
 */
export const RunIdentitySchema = z.object({
  id: z.string().uuid(),
  project: ProjectRefSchema,
  tool: z.string(),
  toolVersion: z.string().nullable().optional(),
  environment: z.string().nullable().optional(),
  branch: z.string().nullable().optional(),
  commitSha: z.string().nullable().optional(),
  simulation: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  durationMs: z.number().int().nullable().optional(),
  startedAt: z.string().datetime(),
  toolStartedAt: z.string().datetime().nullable().optional(),
});
export type RunIdentity = z.infer<typeof RunIdentitySchema>;
```

- [ ] **Step 4: Re-express `RunResponseSchema` as an extension**

Replace `export const RunResponseSchema = z.object({` … through the identity fields it now inherits, keeping every existing doc comment by moving it onto the corresponding key in `RunIdentitySchema` above. The result:

```ts
export const RunResponseSchema = RunIdentitySchema.extend({
  status: RunStatusSchema,
  verdict: RunVerdictSchema.nullable(),
  windowable: z.boolean().optional(),
  ingestedAt: z.string().datetime().nullable().optional(),
  assertions: z.array(AssertionSchema),
  toolAssertions: z.array(ToolAssertionSchema).nullable().optional(),
  error: z
    .object({ code: z.string(), message: z.string(), remediation: z.string() })
    .nullable()
    .optional(),
});
```

Move the existing doc comments for `project`, `windowable`, `simulation`, `description`, `durationMs`, `startedAt`, `toolStartedAt` and `toolAssertions` to whichever schema now owns the key. Do not delete any of them — each records a decision.

- [ ] **Step 5: Widen `RunProcessingSchema`**

Replace the existing three-key object (around line 168), keeping its whole doc comment and adding the new paragraph:

```ts
/**
 * … (keep the entire existing comment verbatim) …
 *
 * EVERY IDENTITY FIELD IS OPTIONAL HERE, INCLUDING `project` AND `tool` — and
 * for a different reason than they are optional on a run body. During a
 * rolling deploy a new browser polls an OLD pod and receives just
 * `{ id, status, statusUrl }`. A required field would make `.parse()` throw
 * and blank the run page for the whole rollout, the same failure
 * `live-delta.test.ts` exists to prevent one endpoint over.
 */
export const RunProcessingSchema = RunIdentitySchema.partial().extend({
  // Re-required after `.partial()`: the API has always sent it, on every path.
  id: z.string().uuid(),
  status: z.enum(['pending', 'parsing', 'running']),
  statusUrl: z.string(),
});
export type RunProcessing = z.infer<typeof RunProcessingSchema>;
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
nvm use && pnpm vitest run packages/contracts/test/ && pnpm typecheck && pnpm lint
```

Expected: PASS, and typecheck clean — `RunResponse`'s inferred type is unchanged, so no consumer moves yet.

- [ ] **Step 7: Commit**

```bash
git add packages/contracts/src/run.ts packages/contracts/test/live.test.ts
git commit -m "feat(contracts): one identity schema, extended by both run bodies

A 202 body carries no project, no tool and no start time, so RunShell — which
renders its header from a full RunResponse — cannot mount for a running run at
all. Widen the 202 rather than widen the shell's tolerance for missing data.

RunIdentitySchema holds what a run knows about ITSELF, independent of parsing.
RunResponseSchema and RunProcessingSchema both extend it, so the two cannot
drift about a field's nullability. Status stays independently enumerated in
each, per RunProcessingSchema's own long-standing argument.

Every field new to RunProcessing is optional, project and tool included. Not
because a run may lack them, but because a new browser polling an old pod
mid-deploy receives the narrow body, and a required field there makes .parse()
throw and blanks the page for the whole rollout."
```

---

### Task 2: The API sends the wider 202

**Files:**
- Modify: `apps/api/src/runs/runs.controller.ts:113-135` (`respondWithRun`)
- Test: `apps/api/test/live.integration.test.ts`

**Interfaces:**
- Consumes: `RunIdentity` field names from Task 1.
- Produces: a 202 body carrying identity. No signature change — `respondWithRun(runs, run, res, retryAfterSeconds?)` is unchanged.

- [ ] **Step 1: Write the failing test**

Append to `apps/api/test/live.integration.test.ts`. Follow the file's existing helpers for opening a live run; the assertion is what matters:

```ts
  it('answers a running run with 202 carrying its identity but no verdict', async () => {
    const { runId } = await openLiveRun({ tool: 'gatling', environment: 'staging', branch: 'main' });

    const res = await request(app.getHttpServer())
      .get(`/v1/runs/${runId}`)
      .set('Cookie', cookie)
      .expect(202);

    // Identity: what the header needs, all of it known at open time.
    expect(res.body.project).toMatchObject({ slug: expect.any(String), name: expect.any(String) });
    expect(res.body.tool).toBe('gatling');
    expect(res.body.environment).toBe('staging');
    expect(res.body.branch).toBe('main');
    expect(typeof res.body.startedAt).toBe('string');

    // Measurements: absent, because nothing has measured this run yet.
    expect(res.body).not.toHaveProperty('verdict');
    expect(res.body).not.toHaveProperty('assertions');
    expect(res.body).not.toHaveProperty('windowable');

    // The poll contract is untouched — this is still a 202 with Retry-After.
    expect(res.headers['retry-after']).toBe('5');
    expect(res.body.status).toBe('running');
    expect(res.body.statusUrl).toBe(`/v1/runs/${runId}`);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
nvm use && pnpm vitest run --config vitest.integration.config.ts apps/api/test/live.integration.test.ts
```

Expected: FAIL on `expect(res.body.project).toMatchObject(...)` — `project` is `undefined`.

Confirm you are alone first: `pgrep -f vitest`.

- [ ] **Step 3: Widen the 202 branch**

In `apps/api/src/runs/runs.controller.ts`, replace the body of the `status === 202` branch:

```ts
  if (status === 202) {
    // IDENTITY, NOT MEASUREMENTS. Every field here is already on the
    // RunRecord this function was handed — `project` is joined (see
    // RunRecord's own comment on why the worker pays that indexed join), so
    // the wider body costs no additional query. That is the whole reason this
    // is a widened 202 rather than a full `toResponse` at every status:
    // toResponse runs runAssertion.findMany and the isWindowable EXISTS, which
    // a poller would pay for every five seconds, per watcher, per live run.
    res
      .status(202)
      .set('Retry-After', String(retryAfterSeconds))
      .json({
        id: run.id,
        status: run.status,
        statusUrl: `/v1/runs/${run.id}`,
        project: run.project,
        tool: run.tool,
        toolVersion: run.toolVersion,
        environment: run.environment,
        branch: run.branch,
        commitSha: run.commitSha,
        simulation: run.simulation,
        description: run.description,
        durationMs: run.durationMs,
        startedAt: run.startedAt.toISOString(),
        toolStartedAt: run.toolStartedAt ? run.toolStartedAt.toISOString() : null,
      });
    return;
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
nvm use && pnpm vitest run --config vitest.integration.config.ts apps/api/test/live.integration.test.ts apps/api/test/openapi.integration.test.ts
```

Expected: PASS. `openapi.integration.test.ts` is included because the `RunProcessing` schema it publishes changed shape; if it asserts a field list, update that assertion to the widened one.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/runs/runs.controller.ts apps/api/test/live.integration.test.ts
git commit -m "feat(api): the 202 carries the run's identity, and no measurements

respondWithRun already holds a RunRecord with project joined, so every field a
run header needs is in hand. Sending them costs no extra query, which is what
rules out the alternative of answering every status with a full RunResponse —
that would run findMany and the isWindowable EXISTS on every five-second poll,
and would put assertions: [] on a run nobody has finished measuring.

statusFor is untouched. Still 202, still Retry-After: a CI poller keying on the
status code needs no new branch."
```

---

### Task 3: `RunHeader` renders from identity

**Files:**
- Modify: `apps/web/src/routes/RunHeader.tsx`
- Test: `apps/web/test/RunHeader.test.tsx`

**Interfaces:**
- Consumes: `RunIdentity` from Task 1.
- Produces: `RunHeader({ identity, status, verdict, peakUsers })` where `identity: Partial<RunIdentity> & { readonly id: string }`, `status: RunResponse['status']`, `verdict: RunResponse['verdict'] | undefined` (`undefined` = not evaluated yet, badge omitted), `peakUsers: number | null`.

- [ ] **Step 1: Write the failing tests**

Add to `apps/web/test/RunHeader.test.tsx`:

```ts
  it('renders identity-only, omitting what an old pod did not send', () => {
    // The rolling-deploy render: a new browser polling an old API pod gets
    // { id, status, statusUrl } and nothing else. Thin, but coherent — and it
    // self-heals at the next poll that reaches a new pod.
    render(
      <MemoryRouter>
        <RunHeader identity={{ id: 'a66548b7-2962-43ff-8b93-7149a6f2a1b8' }}
                   status="running" verdict={undefined} peakUsers={null} />
      </MemoryRouter>,
    );
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Run a66548b7');
    expect(screen.getByTestId('run-status')).toHaveTextContent(/running/i);
    expect(screen.queryByRole('navigation', { name: 'Breadcrumb' })).toBeNull();
    expect(screen.queryByTestId('run-verdict')).toBeNull();
  });

  it('omits the verdict badge entirely while a run is non-terminal', () => {
    // NOT `VERDICT['none']`. "No verdict" reads as evaluated-and-nothing-found,
    // which is a claim about a run nobody has finished measuring. Same argument
    // RunTabs' `errorCount: number | null` already makes one line away.
    render(
      <MemoryRouter>
        <RunHeader identity={{ id: 'a66548b7-2962-43ff-8b93-7149a6f2a1b8',
                               project: { id: '11111111-1111-4111-8111-111111111111',
                                          slug: 'checkout', name: 'Checkout' },
                               tool: 'gatling', startedAt: '2026-08-20T10:43:49.546Z' }}
                   status="running" verdict={undefined} peakUsers={null} />
      </MemoryRouter>,
    );
    expect(screen.queryByTestId('run-verdict')).toBeNull();
    expect(screen.getByRole('link', { name: 'Checkout' })).toBeInTheDocument();
  });

  it('still renders the verdict badge for a terminal run', () => {
    render(
      <MemoryRouter>
        <RunHeader identity={FULL_IDENTITY} status="complete" verdict={null} peakUsers={8} />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('run-verdict')).toBeInTheDocument();
  });
```

Define `FULL_IDENTITY` in the file from the existing `RUN` fixture: `const FULL_IDENTITY = { ...RUN }`. Update the file's existing cases to the new prop shape — every current `<RunHeader run={RUN} peakUsers={...} />` becomes `<RunHeader identity={RUN} status={RUN.status} verdict={RUN.verdict} peakUsers={...} />`.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
nvm use && pnpm vitest run apps/web/test/RunHeader.test.tsx
```

Expected: FAIL — `RunHeader` still takes `run`, so `identity` is undefined and the component throws on `run.simulation`.

- [ ] **Step 3: Change the signature and guard each part**

In `apps/web/src/routes/RunHeader.tsx`:

```tsx
export default function RunHeader({
  identity,
  status,
  verdict,
  peakUsers,
}: {
  /**
   * PARTIAL, and the partiality is the point. A terminal run supplies every
   * field; a non-terminal one supplies what it knows at open time; a run read
   * from an API pod that predates the widened 202 supplies only its id. Each
   * part below renders only when its field is present — the same rule the
   * environment/branch/commit chips already followed, extended to the
   * breadcrumb and the tool chip.
   */
  readonly identity: Partial<RunIdentity> & { readonly id: string };
  readonly status: RunResponse['status'];
  /**
   * `undefined` means NOT EVALUATED YET and omits the badge; `null` means
   * evaluated with no verdict and renders `VERDICT['none']` as before.
   *
   * Collapsing the two would put "no verdict" on a running run, which reads as
   * evaluated-and-nothing-found — a claim about a run nobody has finished
   * measuring. Same distinction `RunTabs`' `errorCount: number | null` draws.
   */
  readonly verdict: RunResponse['verdict'] | undefined;
  readonly peakUsers: number | null;
}) {
  const startedAt = identity.toolStartedAt ?? identity.startedAt ?? null;
  const isIngestTime = identity.toolStartedAt == null;
```

Then, in the body:

- Wrap the `<nav aria-label="Breadcrumb">` block in `{identity.project != null && ( … )}`, reading `identity.project.slug` / `.name`.
- `<h1>`: `{identity.simulation ?? \`Run ${identity.id.slice(0, 8)}\`}` — unchanged expression, new source.
- Verdict badge: `{verdict !== undefined && <NamedBadge mark={VERDICT[verdict ?? 'none']} testId="run-verdict" />}`.
- Tool chip: wrap in `{identity.tool != null && ( … )}`.
- Started chip: wrap in `{startedAt !== null && ( … )}`.
- Duration chip: unchanged — `formatDuration` already handles `null` and `identity.durationMs` is optional.
- Every other chip keeps its existing `!= null && !== ''` guard, reading off `identity`.

Leave the module docstring's three text-content rules verbatim; they still hold.

- [ ] **Step 4: Update the one existing caller so typecheck passes**

In `apps/web/src/routes/RunShell.tsx`, change the call to:

```tsx
<RunHeader
  identity={run}
  status={run.status}
  verdict={run.verdict}
  peakUsers={users.data ? peakConcurrentUsers(users.data) : null}
/>
```

Task 6 replaces this component wholesale; this keeps the tree compiling in between.

- [ ] **Step 5: Run the tests to verify they pass**

```bash
nvm use && pnpm vitest run apps/web/test/RunHeader.test.tsx apps/web/test/RunShell.test.tsx && pnpm typecheck && pnpm lint
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/routes/RunHeader.tsx apps/web/src/routes/RunShell.tsx apps/web/test/RunHeader.test.tsx
git commit -m "feat(web): the run header renders from identity, not from a whole run

Each part renders only when its field is present — the rule the environment,
branch and commit chips already followed, now extended to the breadcrumb and
the tool chip. A run read from an API pod that predates the widened 202 gets
the h1 fallback and a status badge: thin, coherent, and self-healing at the
next poll.

The verdict badge is omitted entirely when verdict is undefined, rather than
rendered as VERDICT['none']. 'No verdict' reads as evaluated-and-nothing-found,
which is a claim about a run nobody has finished measuring."
```

---

### Task 4: `WaitingPanel`, extracted from `Processing`

**Files:**
- Create: `apps/web/src/routes/WaitingPanel.tsx`
- Test: `apps/web/test/WaitingPanel.test.tsx`

**Interfaces:**
- Produces: `WaitingPanel({ status })` where `status: RunProcessing['status']`. No `<h1>`, no `BackToRuns`, no cap block — the header, the breadcrumb and the status strip own those now.

- [ ] **Step 1: Write the failing test**

Create `apps/web/test/WaitingPanel.test.tsx`:

```tsx
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import WaitingPanel from '../src/routes/WaitingPanel';

afterEach(cleanup);

describe('WaitingPanel', () => {
  it('says WHICH of pending and parsing is happening', () => {
    // A spinner says "something is happening". This says which — the one fact
    // a reader can act on, since a run stuck in `pending` never reached the
    // worker at all.
    render(<WaitingPanel status="pending" />);
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.getByText(/pending/i)).toBeInTheDocument();
  });

  it('distinguishes parsing from pending', () => {
    render(<WaitingPanel status="parsing" />);
    expect(screen.getByText(/parsing/i)).toBeInTheDocument();
  });

  it('renders no heading — the run header above it owns the h1', () => {
    render(<WaitingPanel status="parsing" />);
    expect(screen.queryByRole('heading')).toBeNull();
  });

  it('renders no back link — the breadcrumb above it owns that', () => {
    render(<WaitingPanel status="pending" />);
    expect(screen.queryByRole('link')).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
nvm use && pnpm vitest run apps/web/test/WaitingPanel.test.tsx
```

Expected: FAIL — module not found.

- [ ] **Step 3: Create the component**

Create `apps/web/src/routes/WaitingPanel.tsx`, lifting the middle of the old `Processing` verbatim:

```tsx
import type { RunProcessing } from '@perfportal/contracts';
import { Marked, STATUS } from './marks';

/**
 * What a tab shows when the run has produced nothing to draw yet.
 *
 * THE MIDDLE OF THE OLD `Processing` SCREEN, and only the middle. That
 * component's `<h1>` and its "Back to all runs" link are now the run header's
 * and the breadcrumb's job, because this panel renders INSIDE the shell rather
 * than instead of it. Its polling-cap block moved to the status strip, which
 * is where a fact about the page having stopped polling belongs.
 *
 * THE STATUS MARK IS THE ILLUSTRATION, not a generic spinner. A spinner says
 * "something is happening"; this says which of `pending` and `parsing` is
 * happening, which is the one fact a reader can act on — a run stuck in
 * `pending` never reached the worker.
 *
 * The colour arrives as DATA on the `Mark`, through an inline `style`. That is
 * the same route `Marked` and `Badge` take and the reason `routes/marks.tsx`
 * is exempt from the arbitrary-value gate in `test/tokens.test.ts`; a token
 * written in here as a Tailwind arbitrary value would trip that gate, and not
 * only on a technicality — it would be a second place to edit on the day
 * `pending` and `parsing` stop sharing a colour.
 */
export default function WaitingPanel({ status }: { readonly status: RunProcessing['status'] }) {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-3 rounded-xl border border-dashed border-default px-6 py-14 text-center">
      <span
        className="tint relative flex h-11 w-11 items-center justify-center rounded-full border"
        style={{ color: STATUS[status].colour }}
      >
        <span className="absolute inset-0 animate-ping rounded-full bg-current opacity-20" />
        <span aria-hidden="true" className="relative text-lg leading-none">
          {STATUS[status].glyph}
        </span>
      </span>

      {/* `role="status"` on the sentence that changes, so a screen reader hears
          the transition rather than only the first paint. */}
      <p role="status" className="text-[13px] text-muted">
        This run is still processing.
      </p>
      <p className="text-[13px]">
        <Marked mark={STATUS[status]} />
      </p>
    </div>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
nvm use && pnpm vitest run apps/web/test/WaitingPanel.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/routes/WaitingPanel.tsx apps/web/test/WaitingPanel.test.tsx
git commit -m "feat(web): WaitingPanel, the middle of the Processing screen

Extracted so Overview, Charts and Errors can share it. What is dropped is what
the shell now owns: the h1 belongs to the run header, the back link to the
breadcrumb, and the polling-cap block to the status strip, since the cap is a
fact about the page having stopped polling rather than about any one tab."
```

---

### Task 5: `LiveStatusStrip`

**Files:**
- Create: `apps/web/src/routes/LiveStatusStrip.tsx`
- Test: `apps/web/test/LiveStatusStrip.test.tsx`

**Interfaces:**
- Consumes: `LiveNotice` (existing), `Button`, `RefreshIcon`.
- Produces: `LiveStatusStrip({ status, connected, partial, capReached, onRetry })` — `status: RunProcessing['status']`, the rest booleans plus `onRetry: () => void`. Renders `null` for a run that has never streamed AND is not capped, so a pending run gets no empty band.

- [ ] **Step 1: Write the failing test**

Create `apps/web/test/LiveStatusStrip.test.tsx`:

```tsx
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import LiveStatusStrip from '../src/routes/LiveStatusStrip';

afterEach(cleanup);

const BASE = { connected: true, partial: false, capReached: false, onRetry: () => {} };

describe('LiveStatusStrip', () => {
  it('says the run is live while it streams and the socket is up', () => {
    render(<LiveStatusStrip {...BASE} status="running" />);
    expect(screen.getByRole('status')).toHaveTextContent(/live/i);
  });

  it('says it is reconnecting, not that the run stopped', () => {
    // A dropped socket is not a finished run, and saying so would be a lie
    // about the load test rather than about this page's connection.
    render(<LiveStatusStrip {...BASE} status="running" connected={false} />);
    expect(screen.getByRole('status')).toHaveTextContent(/reconnect/i);
    expect(screen.queryByText(/stopped/i)).toBeNull();
  });

  it('says streaming stopped once the run leaves running', () => {
    // Queried by TEXT, not by a singular `getByRole('status')`: the connection
    // sentence and the `finalizing` notice both carry role="status", so the
    // singular query throws on finding two. Same reason the partial case below
    // asserts a COUNT.
    const { getByText } = render(<LiveStatusStrip {...BASE} status="parsing" />);
    expect(getByText(/stopped/i)).toBeInTheDocument();
    expect(screen.getByTestId('live-notice-finalizing')).toBeInTheDocument();
  });

  it('the capped block REPLACES the finalizing notice, never joins it', () => {
    // `finalizing` promises "this page will refresh with the full report once
    // they are ready" — a lie the moment polling has stopped.
    render(<LiveStatusStrip {...BASE} status="parsing" capReached />);
    expect(screen.queryByTestId('live-notice-finalizing')).toBeNull();
    expect(screen.getByRole('button', { name: /check again/i })).toBeInTheDocument();
  });

  it('calls onRetry when the reader asks', async () => {
    const onRetry = vi.fn();
    const { default: userEvent } = await import('@testing-library/user-event');
    render(<LiveStatusStrip {...BASE} status="parsing" capReached onRetry={onRetry} />);
    await userEvent.click(screen.getByRole('button', { name: /check again/i }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('the partial notice renders ALONGSIDE, not instead', () => {
    // A partial seed is a fact about the DATA; the sentence above it is a fact
    // about the connection. Neither displaces the other.
    render(<LiveStatusStrip {...BASE} status="running" partial />);
    expect(screen.getByTestId('live-notice-partial')).toBeInTheDocument();
    // Two live regions: the connection sentence AND the partial notice. That
    // count IS the claim — `getByRole('status')` would throw on finding two,
    // and `{ name: '' }` is not a meaningful query for an unnamed region.
    expect(screen.getAllByRole('status').length).toBeGreaterThan(1);
  });

  it('renders nothing for a pending run that has never streamed', () => {
    const { container } = render(
      <LiveStatusStrip {...BASE} status="pending" connected={false} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('still renders for a pending run once polling has capped', () => {
    // The one thing a never-streamed run still needs to be told: this page has
    // stopped asking, and here is the control.
    render(<LiveStatusStrip {...BASE} status="pending" connected={false} capReached />);
    expect(screen.getByRole('button', { name: /check again/i })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
nvm use && pnpm vitest run apps/web/test/LiveStatusStrip.test.tsx
```

Expected: FAIL — module not found.

- [ ] **Step 3: Create the component**

Create `apps/web/src/routes/LiveStatusStrip.tsx`:

```tsx
import type { RunProcessing } from '@perfportal/contracts';
import Button from '../components/Button';
import { RefreshIcon } from '../components/icons';
import LiveNotice from './LiveNotice';

/**
 * What the PAGE is doing, on every tab.
 *
 * Mounted by `RunShell` between the tab strip and the `<Outlet/>` rather than
 * on any one tab, because a dropped socket is not a fact about Overview: a
 * reader watching Charts needs it exactly as much.
 *
 * ═══ PRECEDENCE, BECAUSE THREE THINGS COMPETE FOR THIS BAND ═══
 *
 * Capped REPLACES finalizing. `LiveNotice[kind="finalizing"]` promises "this
 * page will refresh with the full report once they are ready", which is a lie
 * the moment polling has stopped — so the capped block makes the same
 * situation readable and hands the reader the control instead.
 *
 * `partial` renders ALONGSIDE either, because it is a fact about the DATA (the
 * seed this view was built from had a hole) and the sentence above it is a
 * fact about the CONNECTION. Neither displaces the other.
 *
 * ═══ `role="status"`, NEVER `alert` ═══
 *
 * Nothing here is a problem — the same distinction `LiveNotice` and
 * `DesktopOnly` already make for their own notices.
 */
export default function LiveStatusStrip({
  status,
  connected,
  partial,
  capReached,
  onRetry,
}: {
  readonly status: RunProcessing['status'];
  readonly connected: boolean;
  readonly partial: boolean;
  /**
   * `RunDetail`'s polling cap. It can only be ACTED on once the run has
   * stopped streaming: `pollIntervalFor` exempts a `running` run from the cap
   * entirely, so while `status === 'running'` the page is still polling
   * whatever this flag says, and claiming otherwise would be the "appears to be
   * working while making no requests" failure inverted.
   */
  readonly capReached: boolean;
  readonly onRetry: () => void;
}) {
  const streaming = status === 'running';
  const frozen = status === 'parsing';

  // A pending run has never opened a socket and has nothing to say about one.
  // Rendering an empty bordered band under its tabs would be furniture.
  if (!streaming && !frozen && !capReached) return null;

  return (
    <div className="flex flex-col gap-3">
      {streaming && (
        <p role="status" className="text-[13px] text-muted">
          {connected
            ? 'Live — updating as the run streams.'
            : 'Reconnecting — showing the last update received.'}
        </p>
      )}

      {frozen && (
        <p role="status" className="text-[13px] text-muted">
          Streaming has stopped. The numbers below are its last update.
        </p>
      )}

      {frozen && !capReached && <LiveNotice kind="finalizing" />}

      {capReached && (
        <div
          role="status"
          data-testid="live-status-capped"
          className="flex flex-col items-start gap-2 rounded-xl border border-default bg-surface px-4 py-3 text-[13px] text-muted"
        >
          <p className="leading-relaxed">
            PerfPortal stopped checking automatically after two minutes. The numbers above are the
            last update this page received.
          </p>
          <Button variant="primary" size="sm" onClick={onRetry}>
            <RefreshIcon className="h-3.5 w-3.5" />
            Check again
          </Button>
        </div>
      )}

      {partial && <LiveNotice kind="partial" />}
    </div>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
nvm use && pnpm vitest run apps/web/test/LiveStatusStrip.test.tsx
```

Expected: PASS. If the `role="status"` query in the partial case resolves two elements, narrow it with `getAllByRole('status')` and assert on length — two live regions is correct here.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/routes/LiveStatusStrip.tsx apps/web/test/LiveStatusStrip.test.tsx
git commit -m "feat(web): one status strip, on every tab

What the page is doing — live, reconnecting, stopped, capped, partial — is not
a fact about Overview, so it renders in the shell between the tabs and the
outlet. A reader watching Charts needs a dropped socket exactly as much.

Capped replaces finalizing rather than joining it: the finalizing notice
promises a refresh this page will never make once polling has stopped. Partial
renders alongside either, being a fact about the data rather than the
connection. A pending run renders nothing at all, not an empty band."
```

---

### Task 6: `RunShell` mounts for every state

**Files:**
- Modify: `apps/web/src/routes/RunShell.tsx`
- Modify: `apps/web/src/routes/useRunWindow.ts:55-80` (`RunWindowContext`, new `useLiveFromShell`)
- Test: `apps/web/test/RunShell.test.tsx`

**Interfaces:**
- Consumes: `RunHeader` (Task 3), `LiveStatusStrip` (Task 5), `LiveRunState` from `../api/live`.
- Produces:
  - `RunShell({ identity, status, verdict, windowable, live, capReached, onRetry })`.
  - `RunWindowContext` gains `readonly live: LiveRunState | null`.
  - `useLiveFromShell(): LiveRunState | null`.

- [ ] **Step 1: Write the failing tests**

Add to `apps/web/test/RunShell.test.tsx`, adapting `renderShell` to the new props:

```tsx
  it('mounts header and tabs for a running run', () => {
    renderShellWith({ status: 'running', verdict: undefined, windowable: undefined });
    expect(screen.getByRole('navigation', { name: 'Run sections' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Overview' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Trends' })).toBeInTheDocument();
  });

  it('offers no time brush while a run is live', () => {
    // A live view is never narrowed (useLiveRun's own rule), and identity
    // carries no `windowable`, so the brush cannot be offered. Pinned here so
    // nobody later "fixes" it by threading windowable onto identity.
    renderShellWith({ status: 'running', verdict: undefined, windowable: undefined });
    expect(screen.queryByRole('slider')).toBeNull();
  });

  it('does not FETCH the shared metric keys while a run is live', () => {
    // useLiveRun's applyDelta already writes usersQuery and errorsQuery
    // directly. A live REST fetch answers emptier for a run whose rows do not
    // exist yet, and TanStack applies whichever write resolves last — so the
    // socket's own numbers would lose a race to an empty payload.
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    renderShellWith({ status: 'running', verdict: undefined, windowable: undefined });
    const urls = fetchSpy.mock.calls.map((c) => String(c[0]));
    // `.some(...)`, NOT `expect(urls).not.toContain(expect.stringContaining(...))` —
    // toContain does not meaningfully take an asymmetric matcher, so that
    // spelling passes whether or not the fetch happened.
    expect(urls.some((u) => u.includes('/users'))).toBe(false);
    expect(urls.some((u) => u.includes('/errors'))).toBe(false);
    fetchSpy.mockRestore();
  });

  it('hands its children the live state through the outlet context', () => {
    const live = { connected: true, lastDelta: null, unauthorized: false, partial: false };
    renderProbeWith({ status: 'running', live });
    expect(screen.getByTestId('context-probe').textContent).toContain('"connected":true');
  });

  it('reports the growing domain from the live delta, not from a null duration', () => {
    const live = {
      connected: true, unauthorized: false, partial: false,
      lastDelta: { summary: { durationMs: 42_000 } },
    };
    renderProbeWith({ status: 'running', live });
    expect(screen.getByTestId('context-probe').textContent).toContain('"liveDurationMs":42000');
  });
```

Add the two helpers beside the existing `renderShell`:

```tsx
function renderShellWith(overrides: Record<string, unknown>) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const props = {
    identity: RUN, status: RUN.status, verdict: RUN.verdict, windowable: RUN.windowable,
    live: null, capReached: false, onRetry: () => {}, ...overrides,
  };
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/runs/${RUN.id}`]}>
        <Routes>
          <Route path="/runs/:runId" element={<RunShell {...(props as never)} />}>
            <Route index element={<div />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
```

`renderProbeWith` is the same with `<ContextProbe />` as the index element.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
nvm use && pnpm vitest run apps/web/test/RunShell.test.tsx
```

Expected: FAIL — `RunShell` still takes `run`.

- [ ] **Step 3: Extend the outlet context**

In `apps/web/src/routes/useRunWindow.ts`, add to `RunWindowContext`:

```ts
  /**
   * The live socket's state, or `null` for a run that is not streaming.
   *
   * ON THE CONTEXT RATHER THAN AS A PROP because the tabs are `<Outlet/>`
   * children: they read `runId` from `useParams` and have no prop channel from
   * the shell at all. This is the same argument `window` and `durationMs`
   * already make one field up — the shell is where the run's state lives, and
   * a tab that opened its own socket would be a second consumer of one run's
   * stream.
   */
  readonly live: LiveRunState | null;
```

and beside `useWindowFromShell`:

```ts
export const useLiveFromShell = (): LiveRunState | null =>
  useOutletContext<RunWindowContext>().live;
```

Import `type LiveRunState` from `../api/live`.

- [ ] **Step 4: Rewrite `RunShell`'s signature and body**

```tsx
export default function RunShell({
  identity,
  status,
  verdict,
  windowable,
  live,
  capReached,
  onRetry,
}: {
  readonly identity: Partial<RunIdentity> & { readonly id: string };
  readonly status: RunResponse['status'];
  readonly verdict: RunResponse['verdict'] | undefined;
  /** `RunResponse` only — identity carries no such field, which is exactly
   *  why a live run is never offered a brush. */
  readonly windowable: boolean | undefined;
  readonly live: LiveRunState | null;
  readonly capReached: boolean;
  readonly onRetry: () => void;
}) {
  useDocumentTitle(identity.simulation ?? `Run ${identity.id.slice(0, 8)}`);

  // TERMINAL IS THE ONE GATE ON FETCHING. While a run streams, `useLiveRun`'s
  // `applyDelta` already writes both of these keys directly; a REST fetch
  // answers emptier for a run whose rows do not exist yet, and TanStack applies
  // whichever write resolves last. A pending run has neither rows nor a socket,
  // so `false` is right there too.
  const terminal = status === 'complete' || status === 'incomplete' || status === 'failed';

  const errors = useQuery({ ...errorsQuery(identity.id), enabled: terminal });
  const { window, setWindow } = useRunWindow(identity.durationMs ?? Number.MAX_SAFE_INTEGER);
  const users = useQuery({ ...usersQuery(identity.id, window), enabled: terminal });

  return (
    <div className="flex flex-col gap-6">
      <RunHeader
        identity={identity}
        status={status}
        verdict={verdict}
        peakUsers={users.data ? peakConcurrentUsers(users.data) : null}
      />
      <RunTabs runId={identity.id} errorCount={errors.data ? errors.data.errors.length : null} />

      {/* WHAT THE PAGE IS DOING, above the tab content and below the strip that
          selects it, so it is on screen whichever tab is open. */}
      {!terminal && (
        <LiveStatusStrip
          status={status as RunProcessing['status']}
          connected={live?.connected ?? false}
          partial={live?.partial ?? false}
          capReached={capReached}
          onRetry={onRetry}
        />
      )}

      {windowable === true && identity.durationMs != null && (
        <TimeBrush
          runId={identity.id}
          runDurationMs={identity.durationMs}
          window={window}
          applied={users.data?.window ?? null}
          onChange={setWindow}
        />
      )}

      <Outlet
        context={{
          window,
          durationMs: identity.durationMs ?? null,
          // NOW REAL. This was hard-coded `null` for as long as no live run
          // reached this shell; a live run reaches it now, and this is what
          // `useTimeDomainFromShell` consults to grow the shared domain.
          liveDurationMs: live?.lastDelta?.summary.durationMs ?? null,
          live,
        } satisfies RunWindowContext}
      />
    </div>
  );
}
```

Replace the long `liveDurationMs: null` comment block with the two-line one above — the condition it described no longer holds.

- [ ] **Step 5: Run the tests to verify they pass**

```bash
nvm use && pnpm vitest run apps/web/test/RunShell.test.tsx apps/web/test/timeAxis.test.ts && pnpm typecheck
```

Expected: `RunShell` PASS. `typecheck` FAILS at `RunDetail.tsx`'s `Ready` — that is Task 7's job, and is the expected intermediate state.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/routes/RunShell.tsx apps/web/src/routes/useRunWindow.ts apps/web/test/RunShell.test.tsx
git commit -m "feat(web): the shell mounts for a live run, and carries the socket down

RunShell takes identity, status, verdict, windowable and the live state instead
of a whole RunResponse, so it can render for a run that has none. Its two
shared metric queries fetch only for a terminal run: while a run streams,
applyDelta already writes those exact keys, and a REST fetch would answer
emptier for a run with no rows and win the race.

liveDurationMs is real for the first time — the field its own comment predicted
would be a one-line change if a live run ever reached this shell. The live state
travels on the outlet context because tabs are Outlet children with no prop
channel, the same argument window and durationMs already make.

No time brush for a live run: identity carries no windowable, which is the
mechanism, and a live view is never narrowed, which is the reason."
```

---

### Task 7: `RunDetail` renders the shell for every state

**Files:**
- Modify: `apps/web/src/routes/RunDetail.tsx:73-224` (the state branch), delete `Processing` (266-370) and `Live` (371-565) and `LiveCapped` (566-610)
- Test: `apps/web/test/RunDetail.live.test.tsx`, `apps/web/test/run-detail.test.ts`

**Interfaces:**
- Consumes: `RunShell` (Task 6), `WaitingPanel` (Task 4).
- Produces: `RunDetail` renders `<RunShell …/>` on every non-error path. `Processing`, `Live` and `LiveCapped` are gone; `LiveSummary` and `livePercentileValue` survive and are exported for Task 8.

- [ ] **Step 1: Write the failing tests**

Rewrite `apps/web/test/RunDetail.live.test.tsx`'s render helper to mount `RunDetail` inside a route with tab children, then add:

```tsx
  it('renders the tab strip for a run that is only pending', () => {
    // New: today this renders the standalone Processing screen and the tab
    // URLs resolve to nothing at all.
    mountRun({ state: 'processing', run: { id: RUN_ID, status: 'pending', statusUrl: '/x' } });
    expect(screen.getByRole('navigation', { name: 'Run sections' })).toBeInTheDocument();
  });

  it('keeps the tab strip across running -> parsing -> complete', async () => {
    const { rerenderAs } = mountRun({ state: 'processing', run: RUNNING_IDENTITY });
    expect(screen.getByRole('navigation', { name: 'Run sections' })).toBeInTheDocument();
    await rerenderAs({ state: 'processing', run: { ...RUNNING_IDENTITY, status: 'parsing' } });
    expect(screen.getByRole('navigation', { name: 'Run sections' })).toBeInTheDocument();
    await rerenderAs({ state: 'ready', run: COMPLETE_RUN });
    expect(screen.getByRole('navigation', { name: 'Run sections' })).toBeInTheDocument();
  });

  it('renders the shell even when the 202 carried no identity', () => {
    // An old API pod mid-deploy. Thin header, real tabs, no crash.
    mountRun({ state: 'processing', run: { id: RUN_ID, status: 'running', statusUrl: '/x' } });
    expect(screen.getByRole('navigation', { name: 'Run sections' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/^Run /);
  });
```

Move every existing case in this file that asserts on the frozen banner, the partial notice or the withheld notices to the file matching its new home — `LiveStatusStrip.test.tsx` for the first two, and Tasks 8–10's tab tests for the third. Do not delete them; the behaviour is unchanged, only its address.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
nvm use && pnpm vitest run apps/web/test/RunDetail.live.test.tsx
```

Expected: FAIL — `RunDetail` still returns `Processing`/`Live`, so there is no tab strip.

- [ ] **Step 3: Collapse the three-state branch**

Replace `RunDetail`'s tail (from `if (run.data.state === 'processing')` to the end of the function) with:

```tsx
  // ONE SHELL FOR EVERY STATE. `RunDetail` used to return `Processing` or
  // `Live` INSTEAD of the shell, which is what made the five tab URLs resolve
  // to nothing while a run was live — `RunShell` is the layout route, so no
  // `<Outlet/>` mounted for them at all. Rendering it here is the whole
  // reachability fix, and it needs no router change.
  const detail = run.data;
  // Both arms of the union satisfy `Partial<RunIdentity> & { id }` — a ready
  // run supplies every field, a processing one supplies what it knows — so
  // this needs no branch, only the shared type.
  const identity = detail.run;

  return (
    <RunShell
      identity={identity}
      status={detail.run.status}
      // `undefined`, not `null`, for a non-terminal run: the header omits the
      // badge rather than rendering "no verdict" over a run nobody has finished
      // measuring.
      verdict={detail.state === 'ready' ? detail.run.verdict : undefined}
      windowable={detail.state === 'ready' ? detail.run.windowable : undefined}
      live={detail.state === 'processing' ? live : null}
      capReached={capReached}
      onRetry={() => void run.refetch()}
    />
  );
}
```

Then delete `Processing`, `Live` and `LiveCapped` entirely, along with the imports only they used (`Button`, `RefreshIcon`, `linkButtonClasses` if now unused, `LiveNotice`, `DesktopOnly` if now unused, `ErrorsTable`, `ConcurrentUsersChart`, `UserStartRateChart`, `PercentilesChart`, `RequestRateChart`, `ResponseRateChart`, `growingDomainMs`). Keep `BackToRuns` — the error branches still use it. Keep `LiveSummary` and `livePercentileValue`, and add `export` to `LiveSummary`.

Update the module docstring: the three-state branch is now a one-shell branch, and the sentence about `Processing` rendering "completely unmodified" is no longer true.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
nvm use && pnpm vitest run apps/web/test/RunDetail.live.test.tsx apps/web/test/RunDetail.polling.test.tsx apps/web/test/run-detail.test.ts && pnpm typecheck && pnpm lint
```

Expected: PASS. `run-detail.test.ts` renders `Processing` directly to static markup — delete those two cases; `WaitingPanel.test.tsx` covers the same branches through a real mount.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/routes/RunDetail.tsx apps/web/test/
git commit -m "feat(web): one shell for every run state, so the tab URLs resolve

RunDetail returned Processing or Live INSTEAD of the shell, and RunShell is the
layout route — which is why /runs/:id/charts rendered nothing at all while a run
was live. Rendering the shell on every path is the whole reachability fix and
needs no router change; App.tsx already nests the five tabs.

Processing, Live and LiveCapped are deleted rather than kept as a fallback for
the rolling-deploy window. Two renderings of the same four states is a drift
risk that outlives the deploy that motivated it by a very long way; the shell
degrades honestly instead, omitting what an old pod did not send."
```

---

### Task 8: The Overview tab, live

**Files:**
- Modify: `apps/web/src/routes/RunDetail.tsx` (`RunOverviewTab`)
- Test: `apps/web/test/RunOverviewTab.live.test.tsx` (create)

**Interfaces:**
- Consumes: `useLiveFromShell` (Task 6), `WaitingPanel` (Task 4), `LiveSummary` (Task 7), `LiveNotice`.

- [ ] **Step 1: Write the failing test**

Create `apps/web/test/RunOverviewTab.live.test.tsx` with a helper that renders `RunOverviewTab` inside a `MemoryRouter` route whose parent supplies a `RunWindowContext` with a `live` value:

```tsx
  it('shows the live tiles while a run streams', () => {
    renderOverview({ live: liveWith({ count: 1200, errorRate: 0.02, maxUsers: 8 }) });
    expect(screen.getByTestId('live-stat-total-requests')).toHaveTextContent('1,200');
    expect(screen.getByTestId('live-stat-error-rate')).toHaveTextContent('2.00%');
  });

  it('states that the statistics table is withheld, rather than omitting it', () => {
    // Silent absence is what the withheld-notice pattern exists to replace: the
    // table needs per-endpoint rows the live wire excludes entirely, on any
    // path, so there is no live version of it at any viewport width.
    renderOverview({ live: liveWith({ count: 1 }) });
    expect(screen.getByTestId('live-notice-withheld')).toHaveTextContent(/statistics/i);
  });

  it('shows the waiting panel for a pending run with no delta', () => {
    renderOverview({ live: null, status: 'pending' });
    expect(screen.getByText(/still processing/i)).toBeInTheDocument();
    expect(screen.queryByTestId('live-stat-total-requests')).toBeNull();
  });
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
nvm use && pnpm vitest run apps/web/test/RunOverviewTab.live.test.tsx
```

Expected: FAIL — `RunOverviewTab` returns `null` for a non-`ready` run.

- [ ] **Step 3: Add the live branch**

In `RunOverviewTab`, replace the `return null` guard:

```tsx
  const live = useLiveFromShell();

  if (runId === undefined || run.data === undefined) return null;

  // NOT TERMINAL: either a populated live dashboard, or an honest wait.
  if (run.data.state !== 'ready') {
    const delta = live?.lastDelta ?? null;
    if (delta === null) return <WaitingPanel status={run.data.run.status} />;
    return (
      <div className="flex flex-col gap-6">
        <LiveSummary summary={delta.summary} frozen={run.data.run.status !== 'running'} />
        {/* Gated exactly as the REAL statistics table is on a finished run
            below — same `what` text — because the table needs per-endpoint rows
            the live wire excludes, so there is no live version of it at any
            width. */}
        <DesktopOnly compact={compact} what="The per-request statistics table">
          {() => <LiveNotice kind="withheld" subject="Statistics" />}
        </DesktopOnly>
      </div>
    );
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
nvm use && pnpm vitest run apps/web/test/RunOverviewTab.live.test.tsx apps/web/test/RunStats.test.tsx && pnpm typecheck && pnpm lint
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/routes/RunDetail.tsx apps/web/test/RunOverviewTab.live.test.tsx
git commit -m "feat(web): Overview carries the live tiles and states what is withheld

The tiles are the same LiveSummary the standalone page drew; what is new is
that they sit under a real header on a real tab. The statistics table is gated
exactly as the finished-run table is, with the same DesktopOnly text, because
it needs per-endpoint rows the live wire excludes on every path."
```

---

### Task 9: The Charts tab, live

**Files:**
- Modify: `apps/web/src/routes/RunDetail.tsx` (`RunChartsTab`)
- Test: `apps/web/test/RunChartsTab.live.test.tsx` (create)

**Interfaces:**
- Consumes: `useLiveFromShell`, `WaitingPanel`, `LiveNotice`, `useTimeDomainFromShell`, the five live chart components.

- [ ] **Step 1: Write the failing test**

```tsx
  it('draws the five live figures and states the two that are withheld', () => {
    renderCharts({ live: liveWith({ count: 1200 }) });
    // Errors per second is NOT here — its real chart lives on the Errors tab,
    // and a withheld notice belongs where its section belongs.
    const withheld = screen.getAllByTestId('live-notice-withheld').map((n) => n.textContent ?? '');
    expect(withheld).toHaveLength(2);
    expect(withheld.join(' ')).toMatch(/distribution/i);
    expect(withheld.join(' ')).not.toMatch(/errors per second/i);
  });

  it('shows the waiting panel before any delta has arrived', () => {
    renderCharts({ live: null, status: 'pending' });
    expect(screen.getByText(/still processing/i)).toBeInTheDocument();
  });
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
nvm use && pnpm vitest run apps/web/test/RunChartsTab.live.test.tsx
```

Expected: FAIL — the tab fetches unconditionally and draws eight slots regardless of state.

- [ ] **Step 3: Add the live branch**

In `RunChartsTab`, put these three declarations at the TOP of the component,
immediately after `useParams` and **before any `useQuery`** — the metric queries
below reference `terminal` in their `enabled`, so declaring it later is a
temporal-dead-zone error:

```tsx
  const live = useLiveFromShell();
  const detail = useQuery({ queryKey: runQueryKey(runId ?? ''), queryFn: () => fetchRun(runId!),
                            enabled: runId !== undefined });
  const terminal = detail.data?.state === 'ready';
```

Then, after the existing `compact`/`shown` block, insert:

```tsx
  if (detail.data !== undefined && !terminal) {
    const delta = live?.lastDelta ?? null;
    if (delta === null) return <WaitingPanel status={detail.data.run.status} />;
    return (
      <section
        aria-labelledby="live-charts-heading"
        className="grid grid-cols-1 gap-6 2xl:grid-cols-2"
      >
        <h2 id="live-charts-heading" className="sr-only">Charts</h2>
        {users.data !== undefined && (
          <>
            <ConcurrentUsersChart users={users.data} group={RUN_TIME} domainMs={domainMs} />
            <UserStartRateChart users={users.data} group={RUN_TIME} domainMs={domainMs} />
          </>
        )}
        {series.data !== undefined && (
          <>
            <PercentilesChart series={series.data} domainMs={domainMs} />
            <RequestRateChart series={series.data} domainMs={domainMs} />
            <ResponseRateChart series={series.data} domainMs={domainMs} />
          </>
        )}
        {/* THE TWO CHART SLOTS WITH NO LIVE SOURCE ON ANY PATH. Both fold the
            same /distribution payload on a finished run, and neither has a live
            equivalent: they need per-request or full-sketch data no delta
            carries. Errors per second is the same shape of gap but belongs on
            the Errors tab, where its real chart is. */}
        <LiveNotice kind="withheld" subject="Response time distribution" />
        <LiveNotice kind="withheld" subject="Response time percentiles distribution" />
      </section>
    );
  }
```

Change the four metric queries' `enabled: on` to `enabled: on && terminal` so a
live run reads the socket-written cache without firing REST — the same rule the
shell follows. `terminal` is `false` while `detail.data` is still `undefined`,
which is correct: there is nothing to fetch for a run this tab has not yet
identified, and the query re-enables the moment it resolves as ready.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
nvm use && pnpm vitest run apps/web/test/RunChartsTab.live.test.tsx apps/web/test/timeAxis.test.ts && pnpm typecheck && pnpm lint
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/routes/RunDetail.tsx apps/web/test/RunChartsTab.live.test.tsx
git commit -m "feat(web): Charts draws the five live figures under the real tab

Two withheld notices here, not three. The standalone page stacked all three
together because it had no tabs to distribute them across; a notice belongs
where its real section belongs, and errors-per-second's chart is on Errors."
```

---

### Task 10: The Errors tab, live

**Files:**
- Modify: `apps/web/src/routes/RunDetail.tsx` (`RunErrorsTab`)
- Test: `apps/web/test/RunErrorsTab.live.test.tsx` (create)

- [ ] **Step 1: Write the failing test**

```tsx
  it('keeps the errors table live and states that the chart is not', () => {
    // The table is fed by delta.errors.rows through the shared errorsQuery key;
    // the chart's endpoint is not on the live wire at all.
    renderErrors({ live: liveWith({ errors: [{ message: 'timeout', count: 3 }] }) });
    expect(screen.getByRole('table', { name: /errors/i })).toBeInTheDocument();
    expect(screen.getByTestId('live-notice-withheld')).toHaveTextContent(/errors per second/i);
  });

  it('shows the waiting panel before any delta has arrived', () => {
    renderErrors({ live: null, status: 'pending' });
    expect(screen.getByText(/still processing/i)).toBeInTheDocument();
  });
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
nvm use && pnpm vitest run apps/web/test/RunErrorsTab.live.test.tsx
```

Expected: FAIL — the tab renders `Payload` for the chart unconditionally.

- [ ] **Step 3: Add the live branch**

In `RunErrorsTab`, put these three declarations at the TOP of the component,
immediately after `useParams` and **before the `errors` and `series` queries** —
both reference `terminal` in their `enabled`, so declaring it later is a
temporal-dead-zone error:

```tsx
  const live = useLiveFromShell();
  const detail = useQuery({ queryKey: runQueryKey(runId ?? ''), queryFn: () => fetchRun(runId!),
                            enabled: runId !== undefined });
  const terminal = detail.data?.state === 'ready';
```

Then, before the existing return:

```tsx
  if (detail.data !== undefined && !terminal) {
    if ((live?.lastDelta ?? null) === null) return <WaitingPanel status={detail.data.run.status} />;
    return (
      <div className="flex flex-col gap-6">
        {/* §1.3 scopes the live errors envelope to run-scope TOTALS — no time
            series — so the chart has no live source while the table does. */}
        <LiveNotice kind="withheld" subject="Errors per second" />
        <TableSection title="Errors" query={errors}>
          {(data) => <ErrorsTable errors={data} />}
        </TableSection>
      </div>
    );
  }
```

Set the two queries' `enabled` to `runId !== undefined && terminal` so neither races the socket.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
nvm use && pnpm vitest run apps/web/test/RunErrorsTab.live.test.tsx apps/web/test/ErrorsTable.test.tsx && pnpm typecheck && pnpm lint
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/routes/RunDetail.tsx apps/web/test/RunErrorsTab.live.test.tsx
git commit -m "feat(web): Errors stays live for the table, states the chart is not

The live errors envelope is run-scope totals with no time series, so the table
has a live source and the chart does not. The notice now sits beside the chart
it is about rather than three tabs away."
```

---

### Task 11: Load generators and Trends say what they are waiting for

**Files:**
- Modify: `apps/web/src/routes/RunTelemetry.tsx`
- Modify: `apps/web/src/routes/RunTrends.tsx`
- Test: `apps/web/test/RunTelemetry.test.tsx`, `apps/web/test/RunTrends.live.test.tsx` (create)

- [ ] **Step 1: Write the failing tests**

In `apps/web/test/RunTelemetry.test.tsx`:

```tsx
  it('says telemetry arrives when the run finishes, not that the agent was silent', () => {
    // `available: false` is already what the endpoint answers for a run with a
    // null toolStartedAt — every non-terminal run. The existing copy blames the
    // agent, which is wrong here: nothing has failed, the window does not exist
    // yet.
    renderTelemetry({ available: false, status: 'running' });
    expect(screen.getByRole('status')).toHaveTextContent(/when the run finishes/i);
    expect(screen.queryByText(/never reported/i)).toBeNull();
  });
```

Create `apps/web/test/RunTrends.live.test.tsx`:

```tsx
  it('states that trends are withheld while the run is live', () => {
    renderTrends({ status: 'running' });
    expect(screen.getByTestId('live-notice-withheld')).toHaveTextContent(/trends/i);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
nvm use && pnpm vitest run apps/web/test/RunTelemetry.test.tsx apps/web/test/RunTrends.live.test.tsx && pnpm typecheck && pnpm lint
```

Expected: FAIL — the telemetry copy is unconditional, and `RunTrends` has no live branch.

- [ ] **Step 3: Add the branches**

`RunTelemetry.tsx` — where it renders the `available: false` `EmptyState`, branch on the run's status via `useLiveFromShell() !== null || status !== terminal`. Simplest correct form: read the run detail the same way Tasks 9 and 10 do and pass a different `description` to the existing `EmptyState`:

```tsx
  const description = terminal
    ? 'No load generator reported for this run’s window.'
    : 'Load generator telemetry appears once the run finishes — it is placed on the run’s own elapsed axis, which needs the tool’s start time from the parsed report.';
```

`RunTrends.tsx` — add, before its existing fetch:

```tsx
  if (!terminal) {
    return <LiveNotice kind="withheld" subject="Trends" />;
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
nvm use && pnpm vitest run apps/web/test/RunTelemetry.test.tsx apps/web/test/RunTrends.live.test.tsx && pnpm typecheck && pnpm lint
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/routes/RunTelemetry.tsx apps/web/src/routes/RunTrends.tsx apps/web/test/
git commit -m "feat(web): the last two tabs say what they are waiting for

Telemetry needs the tool's start time to place samples on the run's own elapsed
axis, and that arrives with the parsed report — so 'when the run finishes' is
the honest sentence, not 'the agent never reported'. Trends takes a withheld
notice for the same reason it always would have: a running run has no
statistics rows to plot a point from."
```

---

### Task 12: e2e — the five tab URLs resolve for a live run

**Files:**
- Modify: `apps/web/e2e/run-detail.spec.ts`
- Modify: `apps/web/e2e/fixtures.ts` — **`seedLiveRun` does not exist and this task must write it**

**Before Step 1:** add `seedLiveRun(orgId: string): Promise<string>` to
`apps/web/e2e/fixtures.ts`, following `seedRunWithData`'s shape (line 273) but
inserting a run row with `status: 'running'`, a null `toolStartedAt`, a null
`durationMs`, and **no** statistics, series or error rows — a running run has
none. Give it a project name and a simulation name that share **no distinctive
word with any tab name** (`Overview`, `Charts`, `Load generators`, `Errors`,
`Trends`): `ProjectRail` renders on every authenticated page and Playwright
matches accessible names as a case-insensitive substring, so a project called
"Trends Demo" would satisfy the Trends tab query and break the spec below in a
way that looks like a product bug.

- [ ] **Step 1: Write the failing spec**

```ts
test('each tab of a LIVE run is its own URL, reachable directly', async ({ page }) => {
  const runId = await seedLiveRun(page);

  for (const [path, heading] of [
    ['', 'Overview'], ['/charts', 'Charts'], ['/load-generators', 'Load generators'],
    ['/errors', 'Errors'], ['/trends', 'Trends'],
  ] as const) {
    await page.goto(`/runs/${runId}${path}`);
    // `exact: true` — 'Errors' is a substring of nothing here, but 'Charts' is
    // a substring of the Charts tab AND of no other link only by luck; pin it.
    await expect(page.getByRole('link', { name: heading, exact: true })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Run sections' })).toBeVisible();
  }
});

test('a live run shows its identity in the header, not a bare id', async ({ page }) => {
  const runId = await seedLiveRun(page);
  await page.goto(`/runs/${runId}`);
  await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toBeVisible();
  await expect(page.getByTestId('run-status')).toContainText(/running/i);
  await expect(page.getByTestId('run-verdict')).toHaveCount(0);
});
```

- [ ] **Step 2: Run the spec to verify it fails**

```bash
nvm use && pnpm test:e2e -- run-detail.spec.ts
```

Expected: FAIL if any step of Tasks 1–11 is incomplete; PASS otherwise. Confirm the stack is up and no other vitest or Playwright run is active first.

- [ ] **Step 3: Fix whatever the browser finds**

Two failure classes to expect, neither visible to jsdom:

- **Accessible-name collisions.** `ProjectRail` renders on every authenticated page, so a page-scoped `getByRole('link', { name })` can be satisfied by a rail row instead. If a seeded project name collides with a tab name, rename the fixture, not the query.
- **`text-transform` in a name.** If a tab or heading was given `uppercase` anywhere in this work, Playwright names it in caps and jsdom does not. Remove the class.

- [ ] **Step 4: Run the full gate**

```bash
nvm use && pnpm typecheck && pnpm lint && pnpm test:unit && pnpm test:integration && pnpm test:e2e
```

Integration BEFORE e2e. If integration fails immediately after an e2e run with no named failing assertion, re-run it alone before believing it.

- [ ] **Step 5: Commit**

```bash
git add apps/web/e2e/run-detail.spec.ts
git commit -m "test(e2e): the five tab URLs resolve for a run that is still live

The assertion this sub-project exists to make true. Also pins that a live run's
header carries its real identity and NO verdict badge — the two halves of
'honest, not blank'."
```

---

### Task 13: Raise the verification floors

**Files:**
- Modify: `CLAUDE.md` (the Verification section)

- [ ] **Step 1: Measure, do not estimate**

```bash
nvm use && pnpm test:unit 2>&1 | tail -20
```

Record the reported `Test Files` and `Tests` totals. Confirm the file count is at or above **103** — below that, the run did not load everything and the number is worthless.

- [ ] **Step 2: Measure the other two**

```bash
nvm use && pnpm test:integration 2>&1 | tail -20
nvm use && pnpm test:e2e 2>&1 | tail -20
```

- [ ] **Step 3: Update the floors**

In `CLAUDE.md`, replace `103 files / 1150 tests` with the measured unit figures, and update the integration (`108 files / 1269 tests`) and e2e (`89`) figures in the same paragraph. Add a sentence naming this sub-project and what it added, in the style of the entries already there: which files are new (`WaitingPanel.test.tsx`, `LiveStatusStrip.test.tsx`, `RunOverviewTab.live.test.tsx`, `RunChartsTab.live.test.tsx`, `RunErrorsTab.live.test.tsx`, `RunTrends.live.test.tsx`), which cases MOVED rather than being added, and which were deleted with `Processing`.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: raise the verification floor for the five-tab live page

Measured, not estimated. Names which cases are new and which merely moved out
of RunDetail.live.test.tsx, so the next reader can tell the difference between
this sub-project's coverage and its relocation."
```

---

### Task 14 (CONDITIONAL): `SlaBanner` at shell level

**Run this task ONLY if `feat/live-sla` has merged into this branch's base.**
Verify first: `ls apps/web/src/routes/SlaBanner.tsx`. If it does not exist, skip
this task and leave it unchecked — the spec's §3.7 is then still pending.

**Files:**
- Modify: `apps/web/src/routes/RunShell.tsx`
- Test: `apps/web/test/RunShell.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
  it('renders the SLA banner on every tab, not only on Overview', () => {
    // A rule breaching right now is a fact about the RUN, not about the tab the
    // reader happens to be on — and a reader watching Charts is exactly who
    // needs to see it.
    const live = { connected: true, unauthorized: false, partial: false,
                   lastDelta: { summary: { durationMs: 1000 },
                                sla: { breaching: [{ ruleId: 'r1', message: 'p95 over 800ms' }],
                                       evaluated: 3, unchecked: 0 } } };
    renderShellWith({ status: 'running', verdict: undefined, live, indexElement: <div /> });
    expect(screen.getByTestId('sla-banner')).toBeInTheDocument();
  });
```

- [ ] **Step 2: Run it to verify it fails**

```bash
nvm use && pnpm vitest run apps/web/test/RunShell.test.tsx
```

Expected: FAIL — the banner is not rendered by the shell.

- [ ] **Step 3: Render it in the shell**

In `RunShell.tsx`, immediately below `<LiveStatusStrip …/>`:

```tsx
      {/* WHAT THE NUMBERS SAY, where the strip above says what the CONNECTION
          is doing. At shell level rather than on Overview: a breach is a fact
          about the run, and a reader watching Charts needs it as much. Never
          viewport-gated — it is a few strings off a delta already in hand, not
          a chart. */}
      {live?.lastDelta != null && (
        <SlaBanner sla={live.lastDelta.sla} frozen={status !== 'running'} />
      )}
```

- [ ] **Step 4: Run it to verify it passes**

```bash
nvm use && pnpm vitest run apps/web/test/RunShell.test.tsx apps/web/test/SlaBanner.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/routes/RunShell.tsx apps/web/test/RunShell.test.tsx
git commit -m "feat(web): the SLA banner renders on every tab

A rule breaching right now is a fact about the run, not about the tab in front
of the reader. It moves from the deleted standalone live page to the shell,
which is the only place that is true on all five."
```

---

## Self-review

**Spec coverage:**

| Spec section | Task |
|---|---|
| §1.1 identity schema, extended twice | 1 |
| §1.2 status enums stay independent | 1 (Step 5 keeps the comment and the literal enum) |
| §1.3 every new field optional | 1 (Steps 5, and the narrow-body test in Step 1) |
| §2 API 202 widened, zero extra queries | 2 |
| §3.1 no route changes | 7 (the collapse is what makes the existing routes resolve) |
| §3.2 socket stays in `RunDetail` | 7 (`live` passed down), 6 (context) |
| §3.3 `RunShell`/`RunHeader` take identity | 3, 6 |
| §3.4 shell queries are cache reads unless terminal | 6 |
| §3.5 `TimeBrush` absent while live | 6 (test in Step 1) |
| §3.6 identity absent → degraded, no fallback page | 3 (header test), 7 (deletion + test) |
| §3.7 status strip + SLA banner | 5, 6; SLA in 14 (conditional) |
| §3.8 cap hoists, precedence | 5 |
| §4 five tabs, per-slot notices | 8, 9, 10, 11 |
| §5 transition is a data swap | 7 (the running→parsing→complete test) |
| §6 edge cases: deep link, compact, title, simulation arriving | 6 (title), 7 (deep link via shell), 9 (compact gate retained) |
| §7 testing | every task's TDD steps, plus 12 and 13 |
| §8 files | matches each task's Files block |

**Placeholder scan:** no "TBD", no "add error handling", no "similar to Task N" — Task 9 and Task 10 repeat their live-branch code in full rather than referring to Task 8.

**Type consistency:** `RunIdentity` (Task 1) is the type named in Tasks 3 and 6. `WaitingPanel({ status })` (Task 4) is called with `status` in Tasks 8, 9, 10. `LiveStatusStrip({ status, connected, partial, capReached, onRetry })` (Task 5) is called with exactly those five in Task 6. `useLiveFromShell()` (Task 6) is called in Tasks 8, 9, 10, 11. `LiveSummary` is exported in Task 7 and consumed in Task 8.

**Known gap, stated rather than hidden:** Task 11's `terminal` flag needs the same `useQuery(runQueryKey…)` read that Tasks 9 and 10 introduce. If a fourth copy of that three-line read feels wrong by the time you reach Task 11, extract `useRunTerminal(runId)` into `apps/web/src/routes/useRunWindow.ts` and use it in all four — that is a refactor the plan endorses, not scope creep.
