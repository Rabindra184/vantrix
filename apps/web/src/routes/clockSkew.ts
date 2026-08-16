/**
 * A MIRROR of `CLOCK_SKEW_WARN_MS` in `packages/statistics/src/telemetry.ts`,
 * duplicated here on purpose — the same reason `test/support/errorSeriesKeep.ts`
 * gives for `ERROR_SERIES_KEEP`: `@perfportal/statistics` depends on
 * `@perfportal/core`, which depends on `@node-rs/argon2` — a native addon with
 * only a WASM browser fallback — and `apps/web` depends only on
 * `@perfportal/contracts`. Adding a package dependency, and everything it
 * transitively pulls into the browser bundle, is not worth it to carry one
 * integer.
 *
 * Unlike `ERROR_SERIES_KEEP` (test-only), this constant is read by production
 * code (`RunTelemetry.tsx`) as well as by its test, which is why it lives in
 * `src/` rather than under `test/support/`.
 */
export const CLOCK_SKEW_WARN_MS = 5_000;
