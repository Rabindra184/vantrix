import { useEffect } from 'react';

/**
 * Names the browser tab after the page you are actually on.
 *
 * EVERY ROUTE IN THIS APP RENDERED THE TITLE `PerfPortal`, because that is
 * what `index.html` says and nothing ever changed it — the ordinary failure of
 * a single-page app, where the document is loaded once and the router swaps
 * components underneath it. Three things break as a result, none of them
 * cosmetic:
 *
 *   Browser history is a list of identical entries. A reader who opened four
 *   runs cannot tell them apart in the back-button menu, or in a session
 *   restore, or in a bookmark.
 *
 *   So is the tab strip. This is a product people keep two runs of open side
 *   by side to compare — that is the whole reason `RunHeader` renders the
 *   fully-qualified simulation rather than the class name — and two tabs both
 *   reading `PerfPortal` defeats it.
 *
 *   A screen reader announces the document title on navigation. With one
 *   title, a route change announces nothing that distinguishes it, which is
 *   the SPA equivalent of a page that never says where you landed.
 *
 * `document.title` DIRECTLY, with no library and no context. The alternative
 * shapes — a `<Helmet>`-style provider, or a route-to-title table in
 * `App.tsx` — both put the title somewhere other than the component that
 * knows it: a run's title is its simulation, which only arrives with the
 * payload, and a project's is its name, which the rail's query resolves
 * asynchronously. The component holding the data is the only place that can
 * name the page without duplicating the fetch.
 *
 * `null` means NOT YET KNOWN — a run whose payload is still in flight — and
 * is deliberately distinct from a title of `PerfPortal`: it leaves whatever
 * the previous page set in place for the moment it takes to resolve, rather
 * than flashing the bare product name between two named pages. The same
 * "absence is not a value" rule `RunTabs`' `errorCount` and `RunHeader`'s
 * `peakUsers` already follow.
 */
export default function useDocumentTitle(title: string | null): void {
  useEffect(() => {
    if (title === null) return;
    // The product name second, after the specific part: a tab strip truncates
    // from the RIGHT, so `com.acme.checkout.PeakHourSimulation · PerfPortal`
    // still shows the simulation in a narrow tab where
    // `PerfPortal · com.acme…` would show nothing but the brand on every one.
    document.title = `${title} · PerfPortal`;
  }, [title]);
}
