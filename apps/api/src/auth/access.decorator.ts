import { SetMetadata } from '@nestjs/common';
import type { AccessAction } from '@perfportal/contracts';

/*
 * ═══ FOUR WAYS A ROUTE STATES WHO MAY CALL IT ═══
 * (docs/superpowers/specs/2026-10-07-project-access-design.md, section 2)
 *
 * Every route carries exactly one of the four below, or `@Public` (the
 * health probes). The route walk in `access-routes.integration.test.ts` reads
 * these keys off Nest's metadata, the way `openapi.integration.test.ts` reads
 * `PATH_METADATA`, and fails any route carrying none of the five, or more
 * than one — so a route cannot ship without saying who it is for. Only
 * `@Requires` changes what a request gets back; the other three are
 * statements for that walk, and `AccessGuard` does not read them.
 *
 * `@AllowedBeforePasswordChange`, at the bottom, is not one of the four: it
 * says nothing about who may call a route, only that a session which must
 * still choose its password may.
 */

export const REQUIRES_KEY = 'perfportal:requires';
export const BEARER_ONLY_KEY = 'perfportal:bearer-only';
export const NOT_PROJECT_SCOPED_KEY = 'perfportal:not-project-scoped';
export const OWN_ACCOUNT_KEY = 'perfportal:own-account';
export const ALLOWED_BEFORE_PASSWORD_CHANGE_KEY = 'perfportal:allowed-before-password-change';

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

/**
 * A route that acts only on the caller's OWN account (`PUT /v1/me/password`).
 * It takes no action and names no project, so `AccessGuard` judges nothing
 * on it; what keeps it to a person is `SessionOnlyGuard`, which the route
 * walk requires every `@OwnAccount` route to carry — a bearer token names
 * nobody, so it has no own account. Like `@NotProjectScoped`, a statement for
 * that walk, not a check.
 */
export const OwnAccount = () => SetMetadata(OWN_ACCOUNT_KEY, true);

/**
 * The password gate's allow-list. `PasswordChangeGuard` refuses a session
 * whose `user.mustChangePassword` is set on every route that does NOT carry
 * this, with 403 PASSWORD_CHANGE_REQUIRED. Read off the HANDLER only, never
 * the class, so a controller cannot open every route it holds at once; the
 * route walk pins the set of routes carrying it.
 *
 * A decorator rather than a list of paths in the middleware: PR 1 measured
 * path matching in front of Better Auth bypassed by dot-segments and by the
 * Host and X-Forwarded-Proto headers. Metadata is attached to the handler
 * Nest has already routed to, so there is no path to spell differently.
 */
export const AllowedBeforePasswordChange = () => SetMetadata(ALLOWED_BEFORE_PASSWORD_CHANGE_KEY, true);
