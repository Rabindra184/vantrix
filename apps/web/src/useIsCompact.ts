import { useEffect, useState } from 'react';

/**
 * The mobile breakpoint, in JS rather than in CSS — PRD §22.6's `< 768px`.
 *
 * ═══ WHY THIS IS NOT A TAILWIND CLASS ═══
 *
 * Every other breakpoint in this app is CSS, and should stay that way: `lg:`
 * turning the project rail from a sidebar into a horizontal scroller costs
 * nothing but layout. §22.6 asks for something a class cannot do. Below 768px
 * the run page is meant to be a READ-ONLY SUMMARY, because "deep analysis is
 * explicitly a desktop task" — and hiding ten figures with `hidden` would leave
 * a phone paying for ten ECharts instances, a statistics table of every request
 * and group, and the four payloads behind them, to display none of it. That is
 * the "degrading badly" the requirement exists to prevent, so the charts must
 * not MOUNT, which only JS can decide.
 *
 * 767px, not 768: `max-width` is inclusive, and the CSS breakpoint is "from 768
 * up". A query of `max-width: 768px` would make 768 itself both compact and
 * not.
 *
 * ═══ GUARDED LIKE `Chart`'s OWN matchMedia ═══
 *
 * `vitest.config.ts` runs some suites in a node environment with no `window`,
 * and jsdom has `matchMedia` only when the test provides it. Both fall back to
 * "not compact", which is the honest default: it renders the full page, which
 * is what every existing test expects and what a server-rendered client would
 * want before it can measure anything.
 */
const COMPACT = '(max-width: 767px)';

function matches(): boolean {
  if (typeof matchMedia !== 'function') return false;
  return matchMedia(COMPACT).matches;
}

export default function useIsCompact(): boolean {
  const [compact, setCompact] = useState(matches);

  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const query = matchMedia(COMPACT);
    const onChange = (): void => setCompact(query.matches);
    // Re-read on subscribe as well as on change: a rotation or a resize between
    // the initial `useState` and this effect would otherwise leave the page
    // rendering for a width it no longer has.
    onChange();
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  return compact;
}
