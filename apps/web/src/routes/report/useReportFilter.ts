import { useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { FRAGMENT_IN_PLACE } from '../../fragmentInPlace';

/**
 * The Report's remote and hostname filters, as GE spells them (`?remote=`,
 * `?hostname=`), and Virtual users' scenario (`?users-scenario=`), read from
 * and written to the URL.
 *
 * ═══ IN THE URL, BECAUSE A FILTER IS PART OF THE VIEW (AC-DASH-4) ═══
 *
 * A link to "the connections to the checkout service" that opens on every
 * remote has kept the page and dropped the question. Written with
 * `replace: true` — picking a remote refines a view rather than being a place
 * to go Back to, the rule `RunCompare` and the statistics table already follow
 * — and with every other parameter kept: the window above all, since a reader
 * narrows to a spike and THEN asks which remote it was.
 *
 * ═══ AND WITH ITS SECTION'S HASH ═══
 *
 * `setSearchParams` navigates to `"?" + params`, which drops the hash — so a
 * link copied after picking a remote opened the Report with Connections
 * COLLAPSED, the filter applied to a section nobody could see (review I3). A
 * `CollapsibleSection` opens on a fragment naming it, so the write carries
 * `#<section>`. It is marked `FRAGMENT_IN_PLACE`: the reader is already in
 * that section, on this control, and `AppShell`'s reveal would scroll them and
 * take focus off it.
 *
 * ═══ AN UNKNOWN VALUE IS READ AS EVERY REMOTE, AND NEVER SENT ═══
 *
 * `known` is the summary's own list (`summary.remotes` / `.hostnames`), so a
 * stale link, a re-ingested run or a hand-edited URL whose value the run does
 * not carry reads `'*'` — the value the API takes as "every one together" —
 * rather than reaching the API as a filter matching nothing, which would draw
 * nine empty charts over a run that recorded plenty. Until the summary has
 * answered (`known` undefined) there is nothing to check against, so the
 * answer is `'*'` too, and the caller holds its figure read until then.
 * `named` is what the URL asked for when that is not the answer, so the
 * control can say the link named something this run never had.
 *
 * `set('*')` DELETES the parameter rather than writing `?remote=*`: the
 * absence already means every remote, and a literal `*` in a shared link is a
 * filter that is not filtering.
 */
export default function useReportFilter(
  param: 'remote' | 'hostname' | 'users-scenario',
  known: readonly string[] | undefined,
  /** The section's `id`, written as the URL's fragment so a shared link reopens it. */
  sectionId: string,
): readonly [value: string, set: (v: string) => void, named: string | null] {
  const location = useLocation();
  const raw = new URLSearchParams(location.search).get(param);
  const value = raw !== null && known !== undefined && known.includes(raw) ? raw : '*';
  // Only once the run has said what it has: before then, nothing is known to be missing.
  const named = raw !== null && known !== undefined && value === '*' ? raw : null;

  const write = useSectionParams(sectionId);
  const set = useCallback(
    (next: string) =>
      write((p) => {
        if (next === '*') p.delete(param);
        else p.set(param, next);
      }),
    [param, write],
  );

  return [value, set, named] as const;
}

/**
 * How a section filter writes the URL, once, so every filter on the Report
 * writes it the same way: `replace: true`, every parameter the edit does not
 * touch kept, the section's `#hash` carried, and that hash marked
 * `FRAGMENT_IN_PLACE` (see `useReportFilter`).
 *
 * `edit` changes the parameters in place, and may change several in ONE
 * navigation — the Requests section's Group pick sets `requests-group` and
 * deletes `requests-request` together (`useRequestsPick`). Two writes in a row
 * would not do: each reads `search` from the render it was made in, so the
 * second would put back what the first had just removed.
 */
export function useSectionParams(sectionId: string): (edit: (params: URLSearchParams) => void) => void {
  const { search } = useLocation();
  const navigate = useNavigate();
  return useCallback(
    (edit: (params: URLSearchParams) => void) => {
      const p = new URLSearchParams(search);
      edit(p);
      const query = p.toString();
      navigate(
        { search: query === '' ? '' : `?${query}`, hash: `#${sectionId}` },
        { replace: true, state: FRAGMENT_IN_PLACE },
      );
    },
    [search, sectionId, navigate],
  );
}
