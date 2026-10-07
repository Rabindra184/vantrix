import { SetMetadata } from '@nestjs/common';
import type { AccessAction } from '@perfportal/contracts';

/*
 * ═══ THREE WAYS A ROUTE STATES WHO MAY CALL IT ═══
 * (docs/superpowers/specs/2026-10-07-project-access-design.md, section 2)
 *
 * Every route carries exactly one of the three below, or `@Public` (the
 * health probes). The route walk in `access-routes.integration.test.ts` reads
 * these keys off Nest's metadata, the way `openapi.integration.test.ts` reads
 * `PATH_METADATA`, and fails any route carrying none of the four, or more
 * than one — so a route cannot ship without saying who it is for. Only `@Requires` changes what a
 * request gets back; the other two are statements for that walk, and
 * `AccessGuard` does not read them.
 */

export const REQUIRES_KEY = 'perfportal:requires';
export const BEARER_ONLY_KEY = 'perfportal:bearer-only';
export const NOT_PROJECT_SCOPED_KEY = 'perfportal:not-project-scoped';

/**
 * A per-project route, and the action it performs. `AccessGuard` looks the
 * action up in `ACCESS_ACTIONS` and checks a SESSION's role in the route's
 * project (from `:slug`, or from the run for `/v1/runs/:id`) against it. A
 * bearer token is not checked here: its `@Scopes` and `SessionOnlyGuard`
 * decide, exactly as before.
 *
 * Read with `getAllAndOverride`, handler before class, as `@Scopes` is.
 */
export const Requires = (action: AccessAction) => SetMetadata(REQUIRES_KEY, action);

/**
 * A route only a bearer token can use (`POST /v1/runs`, the live run routes,
 * `POST /v1/telemetry`). A session cannot use these today — it names no
 * project, which they answer `PROJECT_REQUIRED`, or lacks the scope they ask
 * for — and gains no way in, so they take no role. Marks that the absence of
 * `@Requires` is deliberate; it grants and refuses nothing itself.
 */
export const BearerOnly = () => SetMetadata(BEARER_ONLY_KEY, true);

/**
 * An org-wide route that belongs to no single project (`GET /v1/projects`,
 * `GET /v1/runs`, `GET /v1/tests`, `GET /v1/activity`). It takes no action:
 * what a session sees there is narrowed by its list scope
 * (`listScope` in access.ts) rather than refused. Like `@BearerOnly`, a
 * statement for the route walk, not a check.
 */
export const NotProjectScoped = () => SetMetadata(NOT_PROJECT_SCOPED_KEY, true);
