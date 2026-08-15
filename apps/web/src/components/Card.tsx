import type { ReactNode } from 'react';

/**
 * The bordered surface every chart sits on. No table is wrapped in a `Card`
 * today — `StatisticsTable`, `ErrorsTable` and `charts/DataTable` set their
 * own styling via `tableStyles.ts` instead (see that file's docstring).
 *
 * `title` is OPTIONAL and defaults to drawing nothing, because `Chart` already
 * renders its own `<h3>` and the e2e suite finds charts by it. A card that
 * always drew a heading would give every figure two, and the accessible name
 * of the figure would become whichever one won.
 *
 * `shadow-panel` ON TOP OF the border, not instead of it. The border is what
 * separates the card from the page in forced-colours mode and in a print-out,
 * where shadows are dropped entirely; the shadow is what stops twelve bordered
 * rectangles reading as a wire grid. Neither alone does both jobs. In dark
 * mode `--elevation-panel` is an inset highlight rather than a drop shadow,
 * for the reason `tokens.css` gives: a shadow is the absence of light and is
 * invisible on a near-black canvas.
 *
 * `actions` is a slot in the header rather than a prop per control, so a card
 * that grows a toggle does not grow an API. It renders only alongside a
 * `title` — an action row floating above untitled content has nothing to
 * label it.
 */
export default function Card({
  title,
  description,
  actions,
  as: Element = 'section',
  padding = 'md',
  'data-testid': testId,
  children,
}: {
  readonly title?: string;
  readonly description?: string;
  readonly actions?: ReactNode;
  readonly as?: 'section' | 'figure';
  /**
   * `none` is for a card whose child is a full-bleed table: a table inside
   * `p-5` has a 20px gutter its header fill does not reach, which reads as a
   * misaligned header rather than as padding.
   */
  readonly padding?: 'none' | 'md';
  readonly 'data-testid'?: string;
  readonly children: ReactNode;
}) {
  return (
    <Element
      className={`flex flex-col rounded-xl border border-default bg-surface shadow-panel ${
        padding === 'none' ? 'gap-0 overflow-hidden' : 'gap-3 p-5'
      }`}
      data-testid={testId}
    >
      {title !== undefined && (
        <div className={`flex items-start justify-between gap-3 ${padding === 'none' ? 'p-5 pb-3' : ''}`}>
          <div className="flex min-w-0 flex-col gap-1">
            <h3 className="text-[15px] font-semibold tracking-tight text-primary">{title}</h3>
            {description !== undefined && <p className="text-[13px] text-muted">{description}</p>}
          </div>
          {actions !== undefined && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
        </div>
      )}
      {/* The description renders here only when there is no title to sit
          under — the titled case is handled above so the two stay grouped as
          one block against the actions. */}
      {title === undefined && description !== undefined && (
        <p className="text-[13px] text-muted">{description}</p>
      )}
      {children}
    </Element>
  );
}
