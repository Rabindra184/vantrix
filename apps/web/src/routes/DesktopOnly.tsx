import { useState, type ReactNode } from 'react';
import Button from '../components/Button';

/**
 * §22.6's mobile rule, made a component: below 768px "deep analysis is
 * explicitly a desktop task, and the mobile view SAYS SO rather than degrading
 * badly".
 *
 * ═══ IT DOES NOT MOUNT WHAT IT IS HIDING ═══
 *
 * `children` is a function, not a node. A node would be constructed by the
 * caller before this component could decide anything — so the charts would be
 * created, their queries subscribed and their ECharts instances initialised, to
 * then be thrown away. Deferring construction to a callback is what makes
 * "don't do the expensive thing" true rather than merely invisible.
 *
 * ═══ AND IT IS NOT A DEAD END ═══
 *
 * A phone is where a shared link is most likely to be opened, so refusing
 * outright would strand the person a link was sent to. The notice explains the
 * trade and offers the analysis anyway; taking it is a deliberate act, and the
 * cost lands only on a reader who asked for it. `<Outlet/>`'s URL never
 * changes, so §22.1 tenet 3 ("every view is a URL") holds either way — which
 * redirecting to the summary instead would have broken.
 */
export default function DesktopOnly({
  compact,
  what,
  onShow,
  children,
}: {
  /** `useIsCompact()`. Passed in rather than read here so a caller can test both paths. */
  readonly compact: boolean;
  /** Names the thing being withheld, in the sentence "… is a desktop task." */
  readonly what: string;
  /**
   * CONTROLLED MODE. When the withheld content needs data, the decision has to
   * live with the caller — its queries are `enabled` on the same flag, so
   * keeping the state here would leave the caller fetching four payloads it had
   * already been told not to. Given one, this renders the notice and reports
   * the click; the caller decides what to render next.
   *
   * Omit it and the override is internal, which is right when the content is
   * already in hand and only expensive to DRAW.
   */
  readonly onShow?: () => void;
  readonly children: () => ReactNode;
}) {
  const [override, setOverride] = useState(false);

  if (!compact || (onShow === undefined && override)) return <>{children()}</>;

  return (
    <section
      // `status`, not `alert`: nothing has gone wrong, and an assertive live
      // region would interrupt a screen-reader user mid-sentence to tell them
      // about a layout decision.
      role="status"
      data-testid="desktop-only"
      className="flex flex-col items-start gap-3 rounded-xl border border-default bg-surface p-5"
    >
      <div className="flex flex-col gap-1.5">
        <h3 className="text-[15px] font-semibold tracking-tight text-primary">
          {what} is a desktop task
        </h3>
        <p className="text-[13px] leading-relaxed text-muted">
          This screen is narrow enough that the charts and tables here would be too small to read,
          and drawing them costs more than it is worth on a phone. The summary above carries the
          verdict and the headline numbers.
        </p>
      </div>
      <Button
        variant="secondary"
        onClick={() => (onShow === undefined ? setOverride(true) : onShow())}
        data-testid="desktop-only-show"
      >
        Show it anyway
      </Button>
    </section>
  );
}
