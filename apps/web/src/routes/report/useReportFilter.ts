import { useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';

/**
 * The Report's remote and hostname filters, as GE spells them (`?remote=`,
 * `?hostname=`), read from and written to the URL.
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
 * ═══ AN UNKNOWN VALUE IS READ AS EVERY REMOTE, AND NEVER SENT ═══
 *
 * `known` is the summary's own list (`summary.remotes` / `.hostnames`), so a
 * stale link, a re-ingested run or a hand-edited URL whose value the run does
 * not carry reads `'*'` — the value the API takes as "every one together" —
 * rather than reaching the API as a filter matching nothing, which would draw
 * nine empty charts over a run that recorded plenty. Until the summary has
 * answered (`known` undefined) there is nothing to check against, so the
 * answer is `'*'` too, and the caller holds its figure read until then.
 *
 * `set('*')` DELETES the parameter rather than writing `?remote=*`: the
 * absence already means every remote, and a literal `*` in a shared link is a
 * filter that is not filtering.
 */
export default function useReportFilter(
  param: 'remote' | 'hostname',
  known: readonly string[] | undefined,
): readonly [value: string, set: (v: string) => void] {
  const [params, setParams] = useSearchParams();
  const raw = params.get(param);
  const value = raw !== null && known !== undefined && known.includes(raw) ? raw : '*';

  const set = useCallback(
    (next: string) =>
      setParams(
        (was) => {
          const p = new URLSearchParams(was);
          if (next === '*') p.delete(param);
          else p.set(param, next);
          return p;
        },
        { replace: true },
      ),
    [param, setParams],
  );

  return [value, set] as const;
}
