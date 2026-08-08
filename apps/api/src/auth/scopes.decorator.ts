import { SetMetadata } from '@nestjs/common';

export type TokenScope = 'ingest' | 'read';
export const SCOPES_KEY = 'perfportal:scopes';
export const Scopes = (...scopes: TokenScope[]) => SetMetadata(SCOPES_KEY, scopes);

/**
 * Marks a route as exempt from the global AuthGuard (see auth.module.ts's
 * APP_GUARD registration). Only for routes that must stay reachable with no
 * token at all — today that's /healthz and /readyz. Everything else on the
 * API surface authenticates by default now, precisely so a handler can't
 * silently skip enforcement by forgetting a decorator.
 */
export const IS_PUBLIC_KEY = 'perfportal:public';
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
