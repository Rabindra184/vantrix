/**
 * The shape of content that has not arrived.
 *
 * WHY A SKELETON AND NOT "Loading…". The run list, the statistics table and
 * the stat-tile row are all fixed-shape: the reader knows a table is coming
 * and roughly how tall it is. A text line collapses the page to one row and
 * then pushes everything down when the data lands, which is a layout shift the
 * reader pays attention to (Core Web Vitals CLS, and more to the point it
 * moves the thing they were about to click). Reserving the space is the whole
 * point; the shimmer is secondary.
 *
 * NOT A REPLACEMENT FOR `role="status"`. Every caller here still renders the
 * live-region sentence it rendered before — these are `aria-hidden`, because a
 * screen-reader user gets "Loading runs…" announced once, which is better than
 * a description of six grey rectangles. The two are complementary: the
 * skeleton is for the sighted reader's sense of place, the live region is the
 * announcement.
 *
 * The pulse is `animate-pulse`, an opacity animation, so it composites off the
 * main thread and costs nothing on a page already initialising eight ECharts
 * instances — and `tokens.css`'s `prefers-reduced-motion` block turns it off
 * along with everything else, leaving the reserved space, which is the part
 * that was doing the work anyway.
 */
export function Skeleton({ className = '' }: { readonly className?: string }) {
  return <div aria-hidden="true" className={`animate-pulse rounded-md bg-sunken ${className}`} />;
}

/**
 * A table's worth of skeleton rows, sized from the real thing.
 *
 * `columns` and `rows` are the caller's own numbers rather than defaults, so
 * the placeholder is the width and height of the table that is coming rather
 * than a generic block that resizes on arrival.
 */
export function SkeletonTable({
  columns,
  rows = 6,
}: {
  readonly columns: number;
  readonly rows?: number;
}) {
  return (
    <div aria-hidden="true" className="flex flex-col gap-px overflow-hidden rounded-xl border border-default">
      <div className="flex gap-4 bg-sunken px-4 py-2.5">
        {Array.from({ length: columns }, (_, i) => (
          <Skeleton key={i} className="h-3 flex-1" />
        ))}
      </div>
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} className="flex gap-4 bg-surface px-4 py-3">
          {Array.from({ length: columns }, (_, c) => (
            // Varied widths, deterministically. A grid of identical bars reads
            // as a loading GRAPHIC; rows of differing length read as text that
            // has not arrived. Derived from the indices rather than from
            // `Math.random()` so a re-render does not reshuffle the widths
            // while the reader is looking at them.
            <Skeleton key={c} className={`h-3 flex-1 ${(r + c) % 3 === 0 ? 'opacity-60' : ''}`} />
          ))}
        </div>
      ))}
    </div>
  );
}
