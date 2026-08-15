/**
 * `?runs=` — the entire state of the Compare page.
 *
 * IN THE URL RATHER THAN IN COMPONENT STATE, deliberately. A comparison
 * someone assembled is a thing they paste into a review comment or a ticket;
 * state that lives only in a component cannot be pasted, and `?next=`'s
 * docstring in `paths.ts` makes the same argument for the same reason.
 *
 * Which means it arrives from a URL bar, and every id in it is used to fetch.
 */

/**
 * Five.
 *
 * The categorical palette has six hues and never cycles (`assignPalette`), so
 * five overlaid runs leave one hue spare and nothing goes undrawn. Raising
 * this without raising the palette makes the sixth run silently absent, which
 * is the failure `assignPalette` already refuses to produce.
 */
export const MAX_COMPARE = 5;

/**
 * The runs actually drawn, from what the URL asked for.
 *
 * ═══ VALIDATED, NEVER TRUSTED ═══
 *
 * COHORT MEMBERSHIP IS THE CONTROL HERE, and it is not a security one —
 * `/v1/runs/:id/*` is tenant-scoped, so a hostile id cannot read another org's
 * run whatever this function does. It is a MEANING control: a run of a
 * different simulation is not comparable, the picker never offers one, and
 * overlaying it would answer a question nobody asked while looking exactly
 * like an answer to the one they did.
 *
 * ═══ THE CURRENT RUN IS ALWAYS FIRST ═══
 *
 * This page is reached from a run, and a selection that dropped it would
 * compare that run against a set it is not in. Its position is fixed rather
 * than merely present so the palette assigns it the same hue on every visit —
 * a comparison whose colours reshuffle when a second run is added is one a
 * reader has to re-learn each time.
 *
 * ═══ NO PARAMETER MEANS THIS RUN AND ITS NEAREST NEIGHBOUR ═══
 *
 * Not "this run alone". A page called Compare that opens with one run on it
 * has answered nothing and asks the reader to go find a second — and the
 * comparison they almost always want first is against the previous run, which
 * is the "did my change make this worse" question. See `defaultSelection` for
 * why the oldest run in a cohort falls back to a NEWER neighbour rather than
 * to nothing.
 *
 * AN EXPLICIT PARAMETER IS ALWAYS HONOURED, including one that names only the
 * current run: a reader who deselected everything down to one run gets
 * `?runs=<current>`, which is not absent, so the default does not fight them.
 *
 * ═══ A BAD VALUE FALLS BACK, IT DOES NOT THROW ═══
 *
 * `safeNext`'s stance, applied to a different parameter: the reader asked to
 * compare runs, and a malformed query string is no reason to refuse them. The
 * one case that yields nothing is a current run outside its own cohort, which
 * is not a selection this page can render anything honest for.
 */
export function parseCompareSelection(
  raw: string | null,
  cohort: readonly string[],
  current: string,
): string[] {
  const asked =
    raw === null
      ? defaultSelection(cohort, current)
      : raw
          .split(',')
          .map((id) => id.trim())
          .filter((id) => id !== '');

  const allowed = new Set(cohort);

  const out: string[] = [];
  for (const id of [current, ...asked]) {
    if (out.length >= MAX_COMPARE) break;
    if (!allowed.has(id)) continue;
    if (out.includes(id)) continue;
    out.push(id);
  }
  return out;
}

/**
 * The run to compare against when the URL names none: `current`'s NEAREST
 * NEIGHBOUR IN THE COHORT, preferring the older one.
 *
 * `cohort` is newest-first — the order `/v1/runs/:id/trends` returns and
 * `/v1/runs` uses — so "older" is the NEXT index, not the previous one.
 * Getting that backwards would default to comparing a run against a newer one,
 * which asks "did this used to be worse" instead of "did I make it worse".
 *
 * THE FALLBACK TO THE NEWER NEIGHBOUR IS NOT A DETAIL. The oldest run in a
 * cohort has no predecessor, and returning nothing for it opens Compare with a
 * single run on it — a page that has answered nothing and asks the reader to
 * go find a second. The only comparison available to the oldest run is against
 * a newer one, and that is still worth having: it answers "was this ever
 * fixed", which is exactly why someone opens an old run from a ticket.
 *
 * Only a cohort of ONE genuinely has no neighbour, and the page renders its own
 * explanation for that rather than an overlay of one line.
 */
function defaultSelection(cohort: readonly string[], current: string): string[] {
  const here = cohort.indexOf(current);
  if (here < 0) return [];
  const neighbour = cohort[here + 1] ?? cohort[here - 1];
  return neighbour === undefined ? [] : [neighbour];
}

/** The inverse, for writing the selection back to the URL. */
export const serialiseCompareSelection = (ids: readonly string[]): string => ids.join(',');
