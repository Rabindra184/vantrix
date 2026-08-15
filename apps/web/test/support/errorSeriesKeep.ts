/**
 * A MIRROR of `ERROR_SERIES_KEEP` in
 * `packages/statistics/src/errors-series.ts`, duplicated here on purpose.
 *
 * The two cannot share a constant: `@perfportal/statistics` depends only on
 * `@perfportal/core`, and `apps/web` only on `@perfportal/contracts`, so
 * neither can import the other — and adding a package dependency to carry one
 * integer is not worth it.
 *
 * It lives in its own file rather than inline in a test so the duplication is
 * VISIBLE. `transforms.errorSeries.test.ts` asserts the palette still has room
 * for this many named series plus the folded remainder; without that assertion,
 * shrinking `CATEGORICAL` would push `Other errors` off the chart silently,
 * because `assignPalette` leaves an excess series undrawn rather than cycling.
 */
export const ERROR_SERIES_KEEP = 5;
