import { useEffect, useId, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { cn } from '../lib/cn';
import { FRAGMENT_SCROLL_MARGIN } from '../routes/fragment';
import { ChevronDownIcon } from './icons';
import SectionHeading from './SectionHeading';

/**
 * One of Gatling Enterprise's collapsible sections — the Report's Requests,
 * Groups and the rest, and the Summary's two assertion bars.
 *
 * MEASURED ON GE: sections open and close independently (opening Groups left
 * Requests open), only Requests starts open, and which are open is kept
 * nowhere — not in the URL, not across a reload. This copies that behaviour
 * and declines GE's markup, whose headers are clickable `div`s with no button
 * role and no heading: here the title is a real heading holding a real button,
 * the WAI-ARIA disclosure shape, so the outline still lists the section and a
 * keyboard reaches it.
 *
 * A CLOSED SECTION BUILDS NOTHING. `children` is a function and is called only
 * while open, so a shut Connections section runs no query and draws no chart.
 * `<details>` was declined for exactly this: it keeps closed content mounted,
 * so every chart in every closed section would fetch and lay out into a hidden
 * 0x0 box, a heading inside its `<summary>` leaves the outline, and nested
 * disclosures have already broken a WebKit case here. The REGION stays in the
 * DOM (empty and `hidden`) so `aria-controls` always names an element.
 *
 * A URL FRAGMENT NAMING THE SECTION OPENS IT — the one exception to "kept
 * nowhere", and the reason an old `/load-generators` link can land on that
 * section's content. `AppShell` already scrolls to and focuses a fragment's
 * target; the section only has to be open by then.
 *
 * `summary` and `actions` sit BESIDE the heading, never inside it: the heading
 * text is exactly `title`, which e2e specs compare verbatim. The button's
 * `::after` covers the whole row so the row is the click target, and the
 * actions sit above that layer.
 *
 * AND THE SUMMARY IS THE BUTTON'S DESCRIPTION. It is beside the heading so the
 * button's NAME stays exactly `title`, but a sibling is not announced with the
 * control: a screen-reader user landing on "Simulation assertions" heard
 * nothing of "1 failed, 2 passed", which is the one thing a collapsed bar
 * exists to say before it is opened. `aria-describedby` ties them without
 * touching the name — and only when a summary is rendered, so the attribute
 * never points at nothing.
 */
export default function CollapsibleSection({
  id,
  title,
  defaultOpen = false,
  summary,
  actions,
  children,
}: {
  readonly id: string;
  readonly title: string;
  readonly defaultOpen?: boolean;
  readonly summary?: ReactNode;
  readonly actions?: ReactNode;
  readonly children: () => ReactNode;
}) {
  const { hash } = useLocation();
  const named = hash === `#${id}`;
  const [open, setOpen] = useState(defaultOpen || named);
  // A later navigation to this section's fragment opens it too — the decision
  // band's link to `#simulation-assertions` lands on a page already mounted.
  useEffect(() => {
    if (named) setOpen(true);
  }, [named]);
  const regionId = useId();
  // Always allocated (a hook cannot be conditional); only USED when there is a
  // summary to point at.
  const summaryId = useId();
  const headingId = `${id}-heading`;

  return (
    <section
      id={id}
      aria-labelledby={headingId}
      data-testid={`section-${id}`}
      className="rounded-xl border border-default bg-surface shadow-panel"
      style={{ scrollMarginTop: FRAGMENT_SCROLL_MARGIN }}
    >
      <div className="relative flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3">
        <SectionHeading id={headingId}>
          <button
            type="button"
            aria-expanded={open}
            aria-controls={regionId}
            aria-describedby={summary !== undefined ? summaryId : undefined}
            onClick={() => setOpen((was) => !was)}
            className="flex items-center gap-2 text-left after:absolute after:inset-0 after:content-['']"
          >
            {title}
            <ChevronDownIcon
              className={cn('h-4 w-4 text-muted transition-transform', open && 'rotate-180')}
            />
          </button>
        </SectionHeading>
        {summary !== undefined && (
          <div id={summaryId} className="text-[0.8125rem] text-muted">
            {summary}
          </div>
        )}
        {actions !== undefined && (
          <div className="relative z-10 ml-auto flex items-center gap-2">{actions}</div>
        )}
      </div>
      <div id={regionId} hidden={!open} className="border-t border-default px-4 py-4">
        {open && children()}
      </div>
    </section>
  );
}
