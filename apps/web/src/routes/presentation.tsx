import { createContext, useContext, useMemo, type ReactNode } from 'react';
import {
  projectPath,
  projectTestPath,
  runComparePath,
  runGroupPath,
  runLogsPath,
  runPath,
  runReportPath,
  runRequestPath,
  runTrendsPath,
  shareSectionPath,
} from './paths';

/**
 * ═══ WHO THE RUN PAGE IS BEING SHOWN TO ═══
 *
 * One run shell serves two pages. In the app it is a signed-in reader's run
 * page; behind a public link (`/share/<secret>`) it is the same shell, the same
 * three tabs, read by somebody who may not be signed in at all
 * (spec 6.3). What differs is decided here and read by the pieces that differ:
 * where a link may go, and nothing else yet — Task 9 moves each run component
 * onto `useRunPaths`.
 *
 * `secret` is the link's own secret, which is the run's address on that page
 * (`shareSectionPath`), and `expiresAt` the instant the public header names.
 */
export type RunPresentation =
  | { readonly kind: 'app' }
  | { readonly kind: 'public'; readonly secret: string; readonly expiresAt: string };

/**
 * THE DEFAULT IS THE APP, and that is safe rather than lazy. The app has one run
 * shell and no provider around it; the public page has one provider, around its
 * shell. A missing provider on the public page would draw app links behind a
 * link — and the e2e anchor guard (Task 10) fails on any `href` there that is
 * not a share path, which is the check that catches it.
 */
const APP: RunPresentation = { kind: 'app' };

const RunPresentationContext = createContext<RunPresentation>(APP);

export function RunPresentationProvider({
  value,
  children,
}: {
  readonly value: RunPresentation;
  readonly children: ReactNode;
}) {
  return <RunPresentationContext.Provider value={value}>{children}</RunPresentationContext.Provider>;
}

export function useRunPresentation(): RunPresentation {
  return useContext(RunPresentationContext);
}

/** The run sections a link inside the shell may point at. */
export type RunSection = 'summary' | 'report' | 'logs' | 'trends' | 'compare';

/** Each section's app path. A `Record` over `RunSection`, so a section added to
 *  the type without a path here is a compile error rather than an `undefined`. */
const APP_SECTIONS: Readonly<Record<RunSection, (runId: string) => string>> = {
  summary: runPath,
  report: runReportPath,
  logs: runLogsPath,
  trends: runTrendsPath,
  compare: (runId) => runComparePath(runId),
};

/**
 * Every destination a link inside the run shell and its tabs may have, as a
 * path — or `null` where this presentation has none, which a caller renders as
 * text rather than as a link.
 *
 * Each member returns the PATH only. A window suffix (`?from=&to=`) or a
 * fragment is the caller's to append, exactly as it is with the global helpers.
 */
export interface RunPaths {
  section(name: RunSection): string | null;
  request(name: string): string | null;
  group(name: string): string | null;
  project(slug: string): string | null;
  test(slug: string, testSlug: string): string | null;
}

/**
 * The run page's links, for whichever presentation it is in.
 *
 * In the app: the global path helpers, unchanged — every destination the run
 * page links to today.
 *
 * Behind a public link: the Summary, the Report and Logs, at share paths, and
 * NOTHING else. The link's credential reaches fifteen reads of one run and no
 * page beyond those three tabs: a drill-down, Trends, Compare, the project and
 * the test are all places a stranger would meet a sign-in page — or, worse, a
 * signed-in sharer would meet the app with the link still in the URL bar. So
 * those answer `null`, never an app path and never a share path the allowlist
 * would refuse.
 *
 * `runId` is the run the page is showing. A share path does not carry it — the
 * secret names the run — but the hook takes it so one call site serves both
 * presentations, and the global path helpers stay for everything outside the
 * run page.
 */
export function useRunPaths(runId: string): RunPaths {
  const presentation = useRunPresentation();
  return useMemo<RunPaths>(() => {
    if (presentation.kind === 'public') {
      const { secret } = presentation;
      return {
        section: (name) =>
          name === 'summary' || name === 'report' || name === 'logs' ? shareSectionPath(secret, name) : null,
        request: () => null,
        group: () => null,
        project: () => null,
        test: () => null,
      };
    }
    return {
      section: (name) => APP_SECTIONS[name](runId),
      request: (name) => runRequestPath(runId, name),
      group: (name) => runGroupPath(runId, name),
      project: (slug) => projectPath(slug),
      test: (slug, testSlug) => projectTestPath(slug, testSlug),
    };
  }, [presentation, runId]);
}
