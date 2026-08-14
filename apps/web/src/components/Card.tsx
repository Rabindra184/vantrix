import type { ReactNode } from 'react';

/**
 * The bordered surface every chart and table sits on.
 *
 * `title` is OPTIONAL and defaults to drawing nothing, because `Chart` already
 * renders its own `<h3>` and the e2e suite finds charts by it. A card that
 * always drew a heading would give every figure two, and the accessible name
 * of the figure would become whichever one won.
 */
export default function Card({
  title,
  description,
  as: Element = 'section',
  'data-testid': testId,
  children,
}: {
  readonly title?: string;
  readonly description?: string;
  readonly as?: 'section' | 'figure';
  readonly 'data-testid'?: string;
  readonly children: ReactNode;
}) {
  return (
    <Element
      className="flex flex-col gap-2 rounded-lg border border-default bg-surface p-4"
      data-testid={testId}
    >
      {title !== undefined && <h3 className="text-lg font-semibold">{title}</h3>}
      {description !== undefined && <p className="text-sm text-muted">{description}</p>}
      {children}
    </Element>
  );
}
