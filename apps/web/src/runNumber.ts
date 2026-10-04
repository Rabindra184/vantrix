/**
 * ═══ A RUN'S NUMBER, SPELLED IN ONE PLACE ═══
 * (docs/superpowers/specs/2026-09-27-run-number-design.md)
 *
 * The two forms Gatling Enterprise uses, measured on its own UI:
 *
 *   runName(12) -> "Run 12"   where a run is NAMED — a list row, a picker chip,
 *                             a chart series, a table column, a breadcrumb, a
 *                             document title, a tile delta's link
 *   runTag(12)  -> "#12"      where it is a compact TAG — the Trends axis
 *
 * GE spells its Compare series "Run #1" and its table column "Run 1"; here both
 * are "Run 12", because both are built from one label field and copying the
 * inconsistency buys nothing.
 *
 * A run with no number (no test, or an API pod that predates the field) keeps
 * EXACTLY the label it had before; see runLabels in charts/transforms/compare.
 */
export function runName(n: number): string {
  return `Run ${n}`;
}

export function runTag(n: number): string {
  return `#${n}`;
}
