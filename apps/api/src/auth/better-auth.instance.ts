import { createAuth } from '@perfportal/persistence';
import { loadConfig } from '../config.js';

/**
 * The factory (basePath, the deliberate absence of the organization plugin,
 * cookie/session settings) lives in @perfportal/persistence's createAuth —
 * see its docstring — because `packages/persistence/scripts/bootstrap.ts`
 * needs the identical config and cannot import an app. This file only
 * supplies the two values that differ per-process and constructs the
 * module-scope `const` Task 4 mounts on the raw Express instance before
 * Nest's body parser; that ordering is spike-proven, so only construction
 * moved here — the shape did not.
 */
const config = loadConfig();
export const auth = createAuth({ databaseUrl: config.databaseUrl, baseUrl: config.betterAuthUrl });
