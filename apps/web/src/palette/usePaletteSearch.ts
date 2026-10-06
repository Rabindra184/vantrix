import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import type { OrgTestSummary, RunListResponse } from '@perfportal/contracts';
import { ProblemError } from '../api/fetch';
import { fetchProjects, projectsQueryKey } from '../api/projects';
import { fetchRunByNumber, searchRuns } from '../api/runs';
import { fetchOrgTests, orgTestsQueryKey } from '../api/tests';
import {
  currentProjectSlug,
  goToDestinations,
  matchPages,
  matchProjects,
  type Destination,
  type ProjectRef,
} from './destinations';
import { parsePaletteQuery, type PaletteQuery } from './parseQuery';
import { useDebouncedValue } from './useDebouncedValue';

/** One row of `GET /v1/runs` — the type `RunTally.tsx` and `RunList.tsx` call `RunListItem`. */
export type RunRow = RunListResponse['items'][number];

/**
 * One group's answer.
 *
 * `idle` is a group the query does not ask — nothing typed, or no `#N` for the
 * run-number lookup — and is NOT pending: a palette waiting on a group nobody
 * asked would never settle. `loading` may still carry `items`: the previous
 * query's answer, kept on screen while this one is fetched.
 */
export interface GroupState<T> {
  readonly items: readonly T[];
  readonly status: 'idle' | 'loading' | 'error' | 'ready';
}

export interface RunByNumberHit {
  readonly run: RunRow;
  readonly test: OrgTestSummary;
}

export interface PaletteGroups {
  /** The DEBOUNCED query: what every group below is an answer to. */
  readonly query: PaletteQuery;
  /**
   * The empty state's destinations. Empty the moment anything is typed — the
   * RAW input, not the debounced one: a row on screen is a row Enter can
   * choose, and "All runs" is not what a reader who has typed `checkout` and
   * pressed Enter inside the pause is asking for.
   */
  readonly goTo: readonly Destination[];
  readonly projects: GroupState<ProjectRef>;
  readonly pages: GroupState<Destination>;
  readonly tests: GroupState<OrgTestSummary>;
  readonly runs: GroupState<RunRow>;
  readonly runByNumber: GroupState<RunByNumberHit>;
  /** Every group the query asks has answered — with results, nothing, or a failure. */
  readonly settled: boolean;
  /** Results across the five search groups. `goTo` is not a result and is not counted. */
  readonly total: number;
  /**
   * What is on screen is not yet the answer to what the input says — so
   * choosing a row on Enter now would act on something other than what was
   * typed. Two windows make it true:
   *
   *   - the debounce pause: the input says something the groups have not been
   *     asked yet;
   *   - the request after it: a group is still loading, which includes one
   *     showing the PREVIOUS query's rows as placeholder data while this
   *     query's are fetched (`keepPreviousData`).
   *
   * The palette queues an Enter pressed while this is true and chooses once it
   * is false (see `CommandPalette`).
   */
  readonly pending: boolean;
  /** End the pause now and ask the groups what the input says. */
  readonly flush: () => void;
}

/** How long the reader must stop typing before anything is searched. */
export const PALETTE_DEBOUNCE_MS = 150;

/** Each group's limit, in the order the palette draws them. */
const PROJECT_LIMIT = 5;
const TEST_LIMIT = 5;
const RUN_LIMIT = 5;
/** How many matching tests a `<text> #N` lookup asks for run N in. */
const RUN_NUMBER_TEST_LIMIT = 3;

/**
 * The palette's own keys for the two searches `api/` exposes no key for. They
 * are prefixed `palette-` so nothing that invalidates the run list by its
 * `['runs', …]` prefix reaches a short-lived search, and so the two cannot be
 * mistaken for each other.
 */
const paletteRunsQueryKey = (q: string) => ['palette-runs', q, RUN_LIMIT] as const;
const paletteRunNumberQueryKey = (text: string, n: number) =>
  ['palette-run-number', text, n] as const;

/**
 * `<text> #N`: run N of each of the (at most three) tests the text names.
 *
 * Every lookup is SETTLED rather than raced with `Promise.all`, because one of
 * them failing is two different facts. A 404 means that test is gone — deleted
 * between the test search answering and its own run being asked for — which
 * is no hit, the same as a test that has no run N. Anything else (a 500, a
 * dropped connection, an unreadable body) is a real failure, and the group
 * says so rather than quietly showing whichever lookups happened to succeed.
 * A run that is simply not there is an empty list, not an error, and leaves
 * the group `ready` with nothing in it.
 */
async function lookUpRunByNumber(text: string, n: number): Promise<RunByNumberHit[]> {
  const found = await fetchOrgTests({ q: text, limit: RUN_NUMBER_TEST_LIMIT });
  const lookups = await Promise.allSettled(
    found.items.map(async (test) => ({
      test,
      runs: await fetchRunByNumber(test.project.slug, test.slug, n),
    })),
  );
  const hits: RunByNumberHit[] = [];
  for (const lookup of lookups) {
    if (lookup.status === 'rejected') {
      if (lookup.reason instanceof ProblemError && lookup.reason.status === 404) continue;
      throw lookup.reason;
    }
    const run = lookup.value.runs.items[0];
    if (run !== undefined) hits.push({ run, test: lookup.value.test });
  }
  return hits;
}

interface QueryLike<T> {
  readonly data: T | undefined;
  readonly isPlaceholderData: boolean;
  readonly isError: boolean;
}

/**
 * One remote group's state, in an order that is the whole rule:
 *
 * 1. not asked → `idle`, with nothing, whatever the cache holds;
 * 2. showing the PREVIOUS query's answer → `loading`, with those items, so the
 *    rows stay while the next answer is fetched rather than flashing empty;
 * 3. an answer for THIS query → `ready` — including one whose background
 *    refetch has since failed, because that answer is still true;
 * 4. no answer and a failure → `error`;
 * 5. otherwise still waiting → `loading`.
 */
function remoteGroup<T>(enabled: boolean, query: QueryLike<readonly T[]>): GroupState<T> {
  if (!enabled) return { items: [], status: 'idle' };
  if (query.data !== undefined && query.isPlaceholderData) {
    return { items: query.data, status: 'loading' };
  }
  if (query.data !== undefined) return { items: query.data, status: 'ready' };
  if (query.isError) return { items: [], status: 'error' };
  return { items: [], status: 'loading' };
}

/**
 * Everything the palette shows for what the reader has typed.
 *
 * `raw` is debounced by `PALETTE_DEBOUNCE_MS` and every group is asked the
 * debounced value — never Projects for `chec` beside a Tests search for `che`.
 * The one exception is deliberate and labelled: while a server group's answer
 * for `chec` is in flight it keeps `che`'s rows on screen, as `loading`, so
 * typing never flashes an empty list (`keepPreviousData`).
 *
 * ═══ EXCEPT ACROSS A CLEARED BOX ═══
 *
 * TanStack's placeholder is the last query that HAD data, not the last one
 * asked. So a reader who searched `smo`, cleared the box (the groups go idle,
 * "Go to" returns) and typed `search` would see `smo`'s rows come back as
 * `search`'s placeholder — rows from a query they had abandoned, which an
 * Enter could then act on. Narrowing `che` to `chec` refines one question;
 * clearing starts another, and there is nothing to keep. So the placeholder
 * is withheld whenever the text the groups were asked before was empty.
 *
 * Projects and Pages are matched in the browser against `GET /v1/projects`,
 * read under the rail's own key so inside the app it is a cache hit. Tests,
 * Runs and Run-by-number are server searches, each its own query: one failing
 * or lagging leaves the others alone.
 */
export function usePaletteSearch(raw: string): PaletteGroups {
  const [debounced, flush] = useDebouncedValue(raw, PALETTE_DEBOUNCE_MS);
  const query = useMemo(() => parsePaletteQuery(debounced), [debounced]);
  const { text, runNumber } = query;
  const searching = text !== '';
  const typed = raw.trim();

  /* The text the groups were asked BEFORE this one — the previous DISTINCT
     debounced text, not the previous render's. Held as state and moved on
     during render (React's pattern for state derived from a prop), so the
     render that first asks `search` already knows it follows `''`. */
  const [asked, setAsked] = useState({ current: text, previous: '' });
  if (asked.current !== text) setAsked({ current: text, previous: asked.current });
  const previousText = asked.current === text ? asked.previous : asked.current;
  const placeholderData = previousText === '' ? undefined : keepPreviousData;
  const currentSlug = currentProjectSlug(useLocation().pathname);

  const projectList = useQuery({ queryKey: projectsQueryKey, queryFn: fetchProjects });
  const projectRefs = useMemo(
    () => projectList.data?.items.map((p): ProjectRef => ({ slug: p.slug, name: p.name })),
    [projectList.data],
  );

  /* The project the reader is inside, named from the project list when it has
     arrived and by its slug until then: a name the reader can read now beats
     waiting on a request to say "Tests · Checkout". */
  const current = useMemo((): ProjectRef | null => {
    if (currentSlug === null) return null;
    const name = projectRefs?.find((p) => p.slug === currentSlug)?.name ?? currentSlug;
    return { slug: currentSlug, name };
  }, [currentSlug, projectRefs]);

  const tests = useQuery({
    queryKey: orgTestsQueryKey(text, TEST_LIMIT),
    queryFn: () => fetchOrgTests({ q: text, limit: TEST_LIMIT }),
    enabled: searching,
    placeholderData,
  });

  const runs = useQuery({
    queryKey: paletteRunsQueryKey(text),
    queryFn: () => searchRuns(text, RUN_LIMIT),
    enabled: searching,
    placeholderData,
  });

  const runByNumber = useQuery({
    queryKey: paletteRunNumberQueryKey(runNumber?.text ?? '', runNumber?.n ?? 0),
    queryFn: () =>
      runNumber === null ? Promise.resolve([]) : lookUpRunByNumber(runNumber.text, runNumber.n),
    enabled: runNumber !== null,
    placeholderData,
  });

  const projectsGroup = ((): GroupState<ProjectRef> => {
    if (!searching) return { items: [], status: 'idle' };
    if (projectRefs !== undefined) {
      return { items: matchProjects(text, projectRefs, PROJECT_LIMIT), status: 'ready' };
    }
    return { items: [], status: projectList.isError ? 'error' : 'loading' };
  })();

  /* Pages belong to the project the reader is in, else to the best project
     match. Inside a project they need nothing fetched. Outside one they depend
     on the project list, and when that has failed they are an error too — the
     Projects group's failure line speaks for both, because a page cannot be
     matched to a project nobody could list. */
  const pagesGroup = ((): GroupState<Destination> => {
    if (!searching) return { items: [], status: 'idle' };
    if (current !== null) return { items: matchPages(text, current), status: 'ready' };
    if (projectRefs !== undefined) {
      const candidate = matchProjects(text, projectRefs, 1)[0] ?? null;
      return { items: matchPages(text, candidate), status: 'ready' };
    }
    return { items: [], status: projectList.isError ? 'error' : 'loading' };
  })();

  const testsGroup = remoteGroup<OrgTestSummary>(searching, {
    data: tests.data?.items,
    isPlaceholderData: tests.isPlaceholderData,
    isError: tests.isError,
  });
  const runsGroup = remoteGroup<RunRow>(searching, {
    data: runs.data?.items,
    isPlaceholderData: runs.isPlaceholderData,
    isError: runs.isError,
  });
  const runByNumberGroup = remoteGroup<RunByNumberHit>(runNumber !== null, {
    data: runByNumber.data,
    isPlaceholderData: runByNumber.isPlaceholderData,
    isError: runByNumber.isError,
  });

  const groups = [projectsGroup, pagesGroup, testsGroup, runsGroup, runByNumberGroup];
  const settled = groups.every((g) => g.status !== 'loading');
  return {
    query,
    goTo: typed === '' && !searching ? goToDestinations(current) : [],
    projects: projectsGroup,
    pages: pagesGroup,
    tests: testsGroup,
    runs: runsGroup,
    runByNumber: runByNumberGroup,
    settled,
    total: groups.reduce((sum, g) => sum + g.items.length, 0),
    // Inside the pause, or a group still loading — placeholder rows included,
    // because `loading` is exactly how `remoteGroup` reports them.
    pending: typed !== text || !settled,
    flush,
  };
}
