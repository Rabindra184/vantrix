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
  const asked = (raw ?? '')
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

/** The inverse, for writing the selection back to the URL. */
export const serialiseCompareSelection = (ids: readonly string[]): string => ids.join(',');
