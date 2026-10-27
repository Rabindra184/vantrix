/**
 * ═══ A FRAGMENT WRITTEN FOR THE LINK, NOT FOR A MOVE ═══
 *
 * `AppShell` reveals and FOCUSES the element a URL's fragment names, because a
 * same-path `<Link>` to `#section` changes the address bar and nothing else
 * (review 09-13 C04). But some navigations write a fragment only so the URL
 * SHARES well: the Report's filters put their section's hash back
 * (`useReportFilter`), so a link to "?remote=X" reopens that section rather
 * than collapsing it. The reader is already there, inside the section, on the
 * control they just changed — and a reveal would scroll them and pull focus
 * off that control.
 *
 * Such a navigation carries this as its `state`; `AppShell` leaves it alone.
 * Its own module so the shell (in the entry chunk) and the Report (lazy) can
 * share it without the shell importing a route.
 */
export const FRAGMENT_IN_PLACE = { fragmentInPlace: true } as const;

/** Whether a location's `state` marks its fragment as already in place. */
export function isFragmentInPlace(state: unknown): boolean {
  return typeof state === 'object' && state !== null && (state as { fragmentInPlace?: unknown }).fragmentInPlace === true;
}
