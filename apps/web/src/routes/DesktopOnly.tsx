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
 *
 * ═══ THE WORDING IS NEUTRAL NOW, AND THAT WAS A REAL FINDING ═══
 *
 * It read "{what} is a desktop task" over a button saying "Show it anyway".
 * Both sentences judge the reader: the first tells somebody holding a phone
 * that what they want is not for them, and the second frames taking it as
 * going against advice. Review M18 asks for neutral wording, naming
 * "Open detailed table" as the shape.
 *
 * So the heading states a fact about the LAYOUT rather than about the reader,
 * and the button says what it opens. `action` is a prop because only the
 * caller knows what the thing is called — a generic "Open it" is the fallback,
 * not the intent.
 */
export default function DesktopOnly({
  compact,
  what,
  action,
  onShow,
  children,
}: {
  /** `useIsCompact()`. Passed in rather than read here so a caller can test both paths. */
  readonly compact: boolean;
  /** Names the thing being withheld — used as the notice's heading. */
  readonly what: string;
  /**
   * What the button says. Name the destination ("Open detailed table"), never
   * the reader's decision to go there.
   */
  readonly action?: string;
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
        <h3 className="text-[15px] font-semibold tracking-tight text-primary">{what}</h3>
        <p className="text-[13px] leading-relaxed text-muted">
          Not drawn at this width — it would be too small to read here, and building it is work a
          narrow screen does not need to do. The summary above carries the verdict and the headline
          numbers.
        </p>
      </div>
      <Button
        variant="secondary"
        onClick={() => (onShow === undefined ? setOverride(true) : onShow())}
        data-testid="desktop-only-show"
      >
        {action ?? 'Open it'}
      </Button>
    </section>
  );
}
