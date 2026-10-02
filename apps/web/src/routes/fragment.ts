/**
 * How far a fragment target keeps from the top of the viewport — review 09-13
 * C04's other half.
 *
 * The run page has TWO sticky bands: `AppShell`'s header at `top: 0` and
 * `RunTabs` at `top: var(--header-height)`. A fragment scrolled flush to the
 * viewport top therefore lands UNDER both of them, heading first, which is a
 * different way of not revealing the thing the link named.
 *
 * `scroll-margin-top` rather than an offset computed in the scroll call,
 * because it is also what the BROWSER honours: the same URL opened fresh is a
 * real fragment navigation that this file never sees, and it lands correctly
 * for free.
 *
 * The header is read from its token because that is the convention the files
 * that depend on its height are held to — `tokens.test.ts` forbids a spelled-out
 * `3.5rem` in AppShell, ProjectRail and RunTabs. This module is not one of the
 * three it scans, so nothing but this comment keeps the margin from drifting
 * from the header. The tab strip's own 42px is not tokenised and is measured
 * rather than guessed; being a few pixels out here is a cosmetic gap above a
 * heading, not a defect, which is why it does not warrant a second token.
 */
export const FRAGMENT_SCROLL_MARGIN = 'calc(var(--header-height) + 2.625rem)';
