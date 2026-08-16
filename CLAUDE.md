# Working in this repository

## Branching and publishing

**Branch from `main`, work, open one PR back to `main`.** That is the whole
workflow. Merge with a merge commit (`--merge`), never squash: the commit
messages here carry reasoning, and collapsing them loses it.

**Do not create a `publish/*` branch.** Sub-projects M0 through M3-piece-3 used
one: each `feat/*` branch was cherry-picked onto `main` commit by commit with
`docs/` and `PerfPortal_Enterprise_PRD.md` stripped, leak-checked, and verified
from a clean install before its PR. That existed for one reason — keeping the
internal specs and the PRD off a public repository.

**That reason is gone.** On 2026-08-14 the four `feat/*` branches and the
`internal/pre-publish` tag were pushed to `origin`, deliberately. The PRD and
`docs/superpowers/` are public. Stripping them from `main` now protects
nothing, and the machinery costs real time — the last sub-project lost most of
an afternoon to a stacked-PR retarget trap and repeated base-branch confusion,
all of it in service of a boundary that no longer exists.

The `publish/*` branches and PRs #1–#9 are kept as history. Do not extend the
pattern.

### If you ever do stack a PR

Merged branches are **not deleted** in this repository. GitHub only
auto-retargets a stacked PR when its base branch is deleted, so here it does
not: PR #8 sat pointing at `publish/parity-charts` after that branch had
merged, and merging it would have landed the work on a side branch with no
error. Retarget explicitly before merging:

```
gh pr edit <N> --base main
```

PR #8's own description claimed the retarget would happen automatically. It was
wrong. Verify against the server (`git ls-remote origin refs/heads/main`)
rather than trusting a PR body or a merge click.

## Verification

**Use the Node in `.nvmrc` (22). On Node 20 the unit suite silently skips every
DOM-environment file.** jsdom 30 pulls an undici whose
`webidl.util.markAsUncloneable` does not exist on 20, so every component test —
i.e. exactly the ones a UI change needs — throws while LOADING. Vitest reports
those as `Errors` on a separate line from `Test Files`, and prints a confident
`Test Files N passed (N) | Tests M passed (M)` above them, counting only the
files that did load. A green-looking local run then fails in CI, which is on 22.

Only the RATIO matters, and it is roughly two thirds of the suite vanishing: on
Node 20 this was once measured at 47 of 67 files, 534 tests. Do not calibrate
against those absolutes — they were true of a smaller suite and are recorded
only to show the scale of what disappears.

`nvm use` first, and if a run reports fewer than **82 files / 936 tests**, it
did not run everything. (Update those two numbers when a sub-project adds
suites, or the next reader calibrates against a stale floor and a
silently-skipped run looks like a pass. Last measured on
`feat/token-minting`; the floor sat at 81 / 931 through `feat/telemetry-agent`
before this — this sub-project's own unit addition is just one file,
`packages/contracts/test/tokens.test.ts` (5 tests); the rest of the branch's
new coverage (`apps/api/test/tokens.integration.test.ts`,
`packages/persistence/test/tokens.integration.test.ts`) is integration, which
`pnpm test:unit` does not run.)

`pnpm test:unit` does **not** run the integration or e2e suites —
`vitest.config.ts` excludes `*.integration.test.ts` and `*.e2e.test.ts`. A
change to anything the API consumes by name can pass every unit gate and still
break `apps/api/test`. Before claiming a sub-project complete:

```
pnpm typecheck && pnpm lint && pnpm test:unit && pnpm test:integration && pnpm test:e2e
```

`test:integration` and `test:e2e` need the local stack:

```
docker compose -f infra/docker-compose.yml up -d
export DATABASE_URL=postgresql://perfportal:perfportal@localhost:5433/perfportal
export REDIS_URL=redis://localhost:6380
export S3_ENDPOINT=http://localhost:9000
export S3_ACCESS_KEY=perfportal
export S3_SECRET_KEY=perfportal123
```

Never run `pnpm test:integration` while `scripts/capture-chart-fixture.mjs` is
capturing: that suite truncates every table on setup and will delete the org
the capture just seeded, mid-run.

**The same applies to `pnpm test:e2e` — so run the gate in its documented
order, integration BEFORE e2e, and not the other way round.** Playwright's
`webServer` and the worker it starts do not stop the instant the last spec
passes, and `test:integration` truncating every table underneath a
still-draining queue produces a failure that reproduces on nothing. Seen once,
running the two ad hoc in the reverse order, as a bare `exit 1` with no
reported failing test, then two clean 814-test runs in a row. If integration
fails right after an e2e run and the tail shows no failing assertion, re-run it
alone before believing it.

**There is now a second gate, and `pnpm` does not run it.** The load-generator
telemetry agent is Go, lives at `agent/`, and is outside the pnpm workspace —
so `pnpm lint`, `pnpm typecheck` and every `pnpm test:*` are all blind to it:

```
cd agent && go vet ./... && go test ./... -race
```

`-race` is not optional here. The agent's whole design is a sampler goroutine
writing to a bounded buffer a sender goroutine drains; a data race in that pair
is the one defect class its tests exist to catch, and the race detector is what
makes those tests able to catch it.


## Conventions that bite

**Expectations are computed from the payload, never written down.** A test that
hard-codes a value `apps/web/test/fixtures/reference-run.json` supplies breaks
on the next re-capture for a reason that is not a defect. Derive it.

**`?name=X` without `scope` is silently ignored.** The metrics endpoints force
`name` to `''` when `scope` is absent, so a scoped call missing `scope` returns
the whole run's data with a 200. Both parameters, always. Test the omission,
not just the correct call.

**A jsdom test cannot see an accessible-name defect.** `dom-accessibility-api`
does not consult a descendant's `aria-label`; Chromium does. A `<button
aria-label>` inside a `<th>` therefore pollutes the header's name in a browser
and in no unit test. Those assertions belong in Playwright.

**`getByRole(role, { name })` is EXACT in Testing Library and a
case-insensitive SUBSTRING in Playwright.** The same call reads as the same
assertion in `apps/web/test` and `apps/web/e2e`, but it is not: Playwright's
default `name` match will pass `{ name: 'Beta' }` against rendered text
`'beta'`, or against `'Beta Checkout'`. Pass `exact: true` whenever a
fallback value (a slug, an id, a placeholder) could be a substring or case
variant of the value you actually mean to require — otherwise the assertion
passes whether or not the real value ever loaded. Cheaper still: pick fixture
values that cannot collide with their fallback in the first place —
`'beta'`/`'Beta Checkout Flow'`, never `'beta'`/`'Beta'`.

**Every page-scoped `getByRole('link', { name })` in the e2e suite now shares
a document with N rail links.** `ProjectRail` (`apps/web/src/ProjectRail.tsx`)
renders on every authenticated page — **All runs** plus one link per
project — so a link query that used to have the page mostly to itself can
now also be satisfied by a rail row instead of the one it meant to find,
under Playwright's case-insensitive substring default above. Green today
only because no seeded project name collides with a page's own link text;
that is a standing constraint on fixture naming from here on, not a one-off
check to pass once. (The brand link moved to `AppShell`'s header in the
design pass, but it is still in the document on every page — same rule.)

## Conventions the design pass added

Each of these shipped as a real defect first and was caught by a browser, not
by the unit suite.

**`text-transform` CHANGES A PLAYWRIGHT ACCESSIBLE NAME.** Playwright computes
accessible names in its own injected script and applies `text-transform`, so a
`<th class="uppercase">Percentage</th>` is named `PERCENTAGE` and
`getByRole('columnheader', { name: 'Percentage', exact: true })` no longer
resolves. jsdom's `dom-accessibility-api` reads `textContent` and sees none of
it, so the unit suite stays green. **Never put `uppercase` on anything queried
by accessible name** — column headings (`tableStyles.ts`'s `TH`) and section
headings (`components/SectionHeading.tsx`) both carry a comment saying so. It
is fine on a `<dt>`, a `<p>` label, or a rail overline, where nothing queries by
name.

**A token that is not in `@theme` produces NO utility, silently.** Tailwind v4
generates utilities only from `@theme` declarations, never from a bare `:root`
custom property. `text-accent-foreground` looked correct in the markup, matched
a real token in `tokens.css`, and emitted no CSS at all — so the skip link and
every primary button inherited `color` from `body` and rendered dark slate on
indigo at 2.84:1. Publish the alias under a DIFFERENT name than the runtime
token (`--color-on-accent: var(--color-accent-foreground)`), because a key that
reads a `var()` of its own name also resolves to nothing, equally silently.

**A decorative `<svg>` inside a chart `<figure>` breaks nine specs.**
`run-charts.spec.ts` and `request-detail.spec.ts` prove a chart really drew by
counting SVG elements within the figure — `toHaveCount(1)` per chart, and
`toHaveCount(0)` for one with nothing to draw. An icon in `DataTable`'s toggle
(which `Chart` renders inside the figure) makes both counts wrong AND destroys
the invariant they rest on. Icons are fine everywhere else; not in there.

**`focus:not-sr-only` resets `padding` to 0.** It has to, to undo `sr-only` —
and a `focus:`-variant utility outranks an unprefixed one, so `sr-only … px-3
focus:not-sr-only` reveals a skip link with no padding. Every visual utility on
a skip link must be `focus:`-prefixed, including the padding.

**A `<caption>` is as wide as its TABLE, not its scroll box.** Put a table in
`overflow-x-auto` and its caption stops wrapping at the viewport and scrolls
sideways with the columns — on a phone the reader gets half a sentence and has
to drag a data table to finish it. `components/TableFrame.tsx` is the fix:
one caption node, drawn visibly outside the scroller and again as the real
`sr-only` `<caption>` inside, so the accessible name and the
`caption.textContent` assertions in `ErrorsTable.test.tsx` /
`StatisticsTable.test.tsx` keep working.
