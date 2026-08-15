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
