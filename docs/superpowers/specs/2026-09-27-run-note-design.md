# Run note

**Status:** approved 2026-09-27, in chat, section by section.
Backlog item #3 of the Gatling Enterprise comparison: a short note a person
writes on a run after the fact — "baseline after the cache change", "flaky
environment, ignore" — shown on the run page and in the run lists, and
matched by run search. One migration, one new route, one widened contract,
one new run-page component.

## Decisions taken, and the ones declined

| Question | Chosen | Declined, and why |
|---|---|---|
| Shape | ONE note per run, editable, last write wins | A comment thread (its own table, list UI, delete rules); a versioned note (a history table and view). Neither is what "why is this run odd" needs. |
| Where it shows | The run page, the three run lists, run search | Compare picker chips and Trends tooltips — not asked for. |
| Who writes | Signed-in people only (session) | API tokens. CI already has its own channel — Gatling's run description, shown verbatim (PRD G-02) — and a token writing the note raises which-write-wins and a pipeline re-run overwriting a person's words. |
| Storage | Three columns on `run` | A `run_note` table: search would need a second pre-query, because one OR branch on a joined table costs every other search column its index (recorded in `RunRepository.list`). |
| Route | `PUT /v1/runs/:id/note` | A general `PATCH /v1/runs/:id`: makes a run look editable in general, which is the door `UpdateTestRequestSchema` was written to keep narrow. |
| Concurrent edits | Last write wins | A conflict check (`If-Match`). Two people editing one note in the same minute is rare; recorded here so nobody mistakes it for an oversight. |

## It is NOT `run.description`

`run.description` is Gatling's OWN run description, decoded from the
`simulation.log` header (`packages/plugin-gatling/src/header.ts`), shown under
the run heading by `RunHeader`, and bound by PRD G-02 as an EXACT string. It is
the tool's claim about the run, frozen at parse. Editing it would break G-02
and let a person overwrite what the tool said. The note is a separate field,
written by a person, and the page keeps the two visibly apart.

## Data

Migration `20260927120000_run_note`:

```sql
ALTER TABLE run
  ADD COLUMN note            text,
  ADD COLUMN note_updated_at timestamptz,
  ADD COLUMN note_updated_by text REFERENCES "user"(id) ON DELETE SET NULL;
CREATE INDEX run_note_trgm ON run USING gin (note gin_trgm_ops);
```

- All three nullable; every existing run reads `null` for all three.
- `note_updated_at` is `timestamptz`, per this repo's instant-column rule.
- `note_updated_by` is Better Auth's `user.id` (text). `ON DELETE SET NULL`:
  deleting a person keeps what they wrote and drops only the attribution.
- `pg_trgm` is already installed (`20260821200000_run_search_trigram`).
- Prisma: `note String?`, `noteUpdatedAt DateTime? @map("note_updated_at")
  @db.Timestamptz(3)`, `noteUpdatedBy String? @map("note_updated_by")` with a
  `noteAuthor User? @relation(fields: [noteUpdatedBy], references: [id],
  onDelete: SetNull)` (the `User` model gains the back-relation).

## The session's user

`Tenant` (`apps/api/src/auth/auth.guard.ts`) carries no user id today — a
session tenant is `{ orgId, tokenId: 'session:<id>', scopes }`, and runner jobs
record `requestedBy: tenant.tokenId`, which names a SESSION rather than a
person and dies with it. `Tenant` gains `userId?: string`: PRESENT for a
session (`session.user.id`, set in `authenticateSession`), ABSENT for a bearer
token, documented exactly as `projectId`'s presence rule is beside it. The note
route is session-only, so it always has one; a handler that somehow reaches it
without one answers 500 rather than writing an unattributed note.

## Contract (`packages/contracts`)

- `RunNoteRequestSchema = z.object({ note: z.string().trim().min(1).max(500).nullable() }).strict()`
  — `null` clears; whitespace alone is REFUSED, not stored as `''` (the trim
  rule `trimmed-input.test.ts` guards: a bounded human-typed string trims).
  `NOTE_MAX_LENGTH = 500` is exported so the browser's counter reads the same
  number.
- `RunNoteSchema = z.object({ note: z.string().nullable(), updatedAt:
  z.string().datetime().nullable(), updatedBy: z.object({ name: z.string()
  }).nullable() })` — the PUT's 200 body, and the shape `RunIdentity` carries.
- `RunIdentitySchema` gains `note: RunNoteSchema.nullable().optional()` — ONE
  nested field, not three siblings, so it cannot arrive half-present (the
  `AssertionRuleSchema` argument). `.optional()` is load-bearing: the browser
  drops a body that fails its schema, so a required field blanks the run page
  for a whole rolling deploy.
- `RunListResponseSchema` items gain `note: z.string().nullable().optional()`
  — the text only. The list does not join `user`.

## API

`PUT /v1/runs/:id/note`, in `RunsController` (`@Controller('/v1/runs')`):

- `@UseGuards(SessionOnlyGuard)` and no `@Scopes`, exactly as the tests
  PATCH is guarded (`tests.controller.ts`). A bearer token answers 403
  `SessionRequired`, whatever scopes it carries.
- `uuidParam('id')` → 400 `INVALID_ID` for a malformed id.
- Body fails `RunNoteRequestSchema` → 400 `INVALID_RUN_NOTE`, remediation naming
  the 500-character limit and `"note": null` to clear.
- The run is found by `{ orgId, id }` (a session names no project). Another
  org's run, or no such run → 404 via `notFound(...)` with a real remediation
  (never a bare `NotFoundException` — `remediation-coverage.test.ts` bans it).
- Allowed in EVERY run status: a note is about the run, not its processing.
- Writes `note`, `note_updated_at = now()` and `note_updated_by = tenant.userId`
  in one `updateMany` scoped by org; a clear writes `null` to all three.
- 200 with `RunNoteSchema`.
- OpenAPI: operation `putRunNote`, cookieAuth only, responses 200 / 400
  (`InvalidRunNote`, and `BadRequest` for the id) / 401 / 403
  (`SessionRequired`) / 404. The route-coverage guard
  (`openapi.integration.test.ts`) refuses the branch until it is documented.

### Reads — BOTH builders

`GET /v1/runs/:id` has two response builders: `RunsService.toResponse` for a
terminal run and the hand-written 202 projection in `respondWithRun`. The note
goes into BOTH, through one helper (`noteOf(run)`), because a note written on a
live run must not vanish from the page until the run finishes — the
`warmupMs` and lifecycle-stamps lesson, with its guard written first.
`RunRepository.findById` includes `noteAuthor: { select: { name: true } }`.

### List and search

- `RunRepository.list`'s SQL selects `r.note`; `toListItem` names it.
- The search OR gains `r.note ILIKE $n ESCAPE '\\'`.
- The search-plan assertion in `repositories.integration.test.ts` restates the
  predicate BY HAND, so it would stay green while the real query drifted. The
  column list moves to one exported constant (`RUN_SEARCH_COLUMNS`) that both
  `list()` and the plan test build their predicate from, and the plan test
  requires `run_note_trgm` beside the other five.

## The run page

A new `apps/web/src/routes/RunNote.tsx`, rendered through a `note` slot on
`RunHeader` — under the heading, below Gatling's description — so `RunHeader`
stays presentational. `RunShell` owns the mutation.

- **Container:** `<section aria-label="Run note">`, no heading. Shell chrome
  must not add a heading to every tab's outline (`run-tables.spec.ts` pins it).
- **With a note:** the text with `whitespace-pre-line break-words`, set apart
  from Gatling's muted description by a thin accent rule on its left; under it
  one small line, `Edited by <name> · <instant>` (`Edited <instant>` when the
  author is gone), and an **Edit note** button. Shown on every viewport.
- **Without a note:** desktop — a quiet **Add a note** text button in that
  spot. Phone (`compact`) — NOTHING in the header; the button lives inside the
  existing `run-metadata` disclosure. The phone's fold has 7.6 px of headroom
  (`mobile.spec.ts`, 812), and an un-noted run must not lose it. A NOTED run on
  a phone does push the totals down — deliberately: "ignore this run" is the
  one thing worth a line of that fold.
- **Editing:** an inline `<textarea>` labelled `Run note`, pre-filled, focused
  on open, with a live count `n / 500` read from `NOTE_MAX_LENGTH`. **Save** and
  **Cancel**; Escape cancels. When the trimmed text is empty and a note exists
  the button reads **Remove note** and sends `null`; empty with no note leaves
  Save disabled. Save is disabled while unchanged or in flight. A failed save
  keeps the text and shows the API's own detail in a `role="alert"` scoped to
  the editor. After a save, focus returns to the Edit/Add button, and
  `runQueryKey(id)` plus the run-list keys are invalidated.

## The lists

`RunList` (org, project and test lists) and its mobile `RunCard` show the note
as one muted line under the simulation name: `line-clamp-2`, `break-words`,
and a fixed maximum width. The width cap is load-bearing: `run-list.spec.ts`'s
mid-width guard keeps p95 and Errors on-screen from 768 to 1280 px, and an
unwrapped note would widen the Simulation column past it — a guard whose
fixture carries no note cannot see that, so the new e2e case seeds one. No
author in the lists.

## Tests, and what each must be seen failing for

**Contract (unit, runs in integration too):** trims; 500 accepted and 501
refused; whitespace alone refused; `null` accepted; an unknown field refused;
`RunIdentity` parses with `note` absent (rolling deploy) and with it present.

**Integration (`apps/api`):**
- a session writes a note → 200, the row holds text, time and author;
- a bearer token → 403; another org's run → 404; a malformed id → 400; a
  501-character note → 400 `INVALID_RUN_NOTE`;
- `null` clears all three columns;
- the note reaches the 200 body AND the 202 body — red-verified by dropping it
  from each builder in turn;
- the run list carries the note text; `?q=` finds a run by a word only its note
  contains;
- the plan test sees `run_note_trgm` and a `BitmapOr`, built from the shared
  column constant;
- deleting the author keeps the note and makes `updatedBy` `null`;
- the OpenAPI document declares `putRunNote` (the coverage guard does the rest).

**Unit (`apps/web`):** `RunNote` renders the text and attribution; opens the
editor with focus; Escape cancels; Save sends trimmed text; emptying offers
Remove note and sends `null`; a failure keeps the text and alerts;
`RunHeader` places the slot under the description; on `compact` with no note
nothing renders outside the disclosure; `RunList` shows the note line and a
row without one shows nothing.

**e2e:** write a note on a real seeded run through the browser, reload, see it
with its author; find that run by searching a word of its note and see the
note in the list; a run with a long note leaves p95 and Errors on-screen at
1024 px; `mobile.spec.ts`'s fold stays green for an un-noted run.

## Not in this change

- Notes on Compare chips or in Trends tooltips.
- Setting a note from CI or at ingest.
- Note history, threads, mentions, or a conflict check.
- An audit record of edits (AC-SEC-4 is unbuilt; `note_updated_by` is
  attribution, not an audit log).
