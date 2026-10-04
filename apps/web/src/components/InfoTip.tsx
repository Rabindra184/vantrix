import * as Popover from '@radix-ui/react-popover';
import { useId, type ReactNode } from 'react';
import { InfoIcon } from './icons';

/**
 * A caveat about the thing beside it, opened on request.
 *
 * ═══ WHERE AN EXPLANATION GOES ONCE THE PAGE STOPS PRINTING IT ═══
 *
 * The clean-UI rule (docs/superpowers/specs/2026-10-04-clean-ui-design.md)
 * keeps labels and data on screen and moves every caveat that changes how ONE
 * number, chart or table should be read behind an ⓘ beside it. This is that ⓘ.
 *
 * A TOGGLETIP, NOT A HOVER TOOLTIP. Click, tap, Enter or Space opens it;
 * Escape, an outside click or a second activation closes it, and focus goes
 * back to the trigger. A hover-only tooltip is unreachable on touch and
 * unreliable from a keyboard, so it would hide exactly the caveats this exists
 * to keep available.
 *
 * THE CAVEAT IS THE TRIGGER'S DESCRIPTION, so a screen reader announces
 * "About p95, button, p95 is an estimate…" on focus without opening anything.
 * The copy that carries it has the `hidden` attribute rather than `sr-only`:
 * the accessible-description computation follows `aria-describedby` into a
 * hidden node, while a hidden node is no tab stop (a link inside it stays out
 * of the tab order) and is not read a second time in browse mode. The open
 * panel repeats the words; a focusable control cannot be marked redundant, and
 * opt-in repetition is the honest trade.
 *
 * `label` IS REQUIRED and names the trigger after its subject ("About p95"),
 * because ten "More info" buttons in one document is the duplicate-name defect
 * this repo has paid for three times.
 *
 * NEVER INSIDE A HEADING OR A `<th>` — only beside one. Their accessible names
 * are computed from their content, so a trigger inside either adds "About …"
 * to their name, and the hidden copy adds its words to their `textContent`,
 * which `run-tables.spec.ts` reads to pin each tab's heading outline.
 */
export default function InfoTip({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}) {
  const descriptionId = useId();
  return (
    <span className="inline-flex items-center">
      <Popover.Root>
        <Popover.Trigger asChild>
          <button
            type="button"
            aria-label={label}
            aria-describedby={descriptionId}
            className="transition-ui inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted hover:text-primary data-[state=open]:text-primary"
          >
            <InfoIcon className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            aria-label={label}
            side="top"
            align="start"
            sideOffset={6}
            collisionPadding={8}
            className="z-50 max-w-72 rounded-lg border border-default bg-surface p-3 text-[0.8125rem] leading-relaxed text-primary shadow-panel"
          >
            {children}
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
      <span id={descriptionId} hidden>
        {children}
      </span>
    </span>
  );
}
