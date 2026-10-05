import { useEffect, useState } from 'react';
import { SearchIcon } from '../components/icons';
import useIsCompact from '../useIsCompact';
import CommandPalette from './CommandPalette';
import { isApplePlatform, isPaletteShortcut } from './shortcut';

/**
 * ═══ THE HEADER'S SEARCH CONTROL, AND THE SHORTCUT THAT OPENS THE SAME PALETTE ═══
 * (docs/superpowers/specs/2026-10-05-portfolio-home-and-command-palette-design.md)
 *
 * It owns one thing — whether the palette is open — and renders the palette
 * beside the button that opens it, so there is exactly one of each however
 * many pages the shell wraps.
 *
 * ═══ THE LISTENER IS ON `window`, IN THE CAPTURE PHASE ═══
 *
 * A shortcut registered the ordinary way is a bubble-phase handler, and
 * anything between the focused element and the window may take the key first:
 * an open Radix menu handles keys on its own content, and a text field's own
 * handler runs before a document-level one. Capture runs before all of them,
 * so the shortcut cannot be swallowed by whatever has focus — which is the
 * property that makes it worth having, since "⌘K works unless a menu is open"
 * is a shortcut a reader stops trusting.
 *
 * ═══ IT TOGGLES, AND IT PREVENTS THE DEFAULT ═══
 *
 * The same chord closes an open palette — the palette's own input has focus
 * when it is open, so that press is a keydown inside the dialog, which this
 * listener still sees. And `preventDefault` is what stops the key doing
 * anything else: pressed in a text field, a browser would otherwise type a
 * "k", and Ctrl+K is "search the web" in some of them.
 *
 * A held key repeats the keydown, and a toggle on every repeat would flicker
 * the dialog open and shut. Repeats are prevented — the browser must not act
 * on them either — and ignored.
 *
 * ═══ FOCUS ═══
 *
 * Returning it to where it was is `CommandPalette`'s: Radix hands it back to a
 * `Dialog.Trigger`, and this dialog has none, so the palette records and
 * restores it itself. `SearchTrigger.test.tsx` asserts it through this
 * component, because that is how a reader opens it.
 *
 * ═══ ICON-ONLY BELOW 768px ═══
 *
 * The one JS breakpoint (`useIsCompact`): on a phone the header has no room for
 * a labelled field, and the shortcut hint names a key most phones lack. The
 * accessible name is "Search" at every width — it is an `aria-label`, not the
 * visible text, so the name does not change when the viewport does.
 */
export default function SearchTrigger() {
  const [open, setOpen] = useState(false);
  const compact = useIsCompact();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!isPaletteShortcut(event)) return;
      /* A native modal <dialog> is open — a chart expanded to full screen
         (`Chart.tsx` calls `showModal()`). HTML makes everything outside it
         inert and paints it below the top layer, and the palette is portalled
         to <body>, outside it: it would be invisible and unable to take focus,
         while Radix's own modal side effects (`aria-hidden` on the page,
         `pointer-events: none` on <body>) would still engage and stop the
         chart's Close button responding. So do nothing — and do not prevent
         the default either, so the browser keeps the key. Any open <dialog>
         counts, not only a modal one: the palette itself is a Radix div with
         `role="dialog"`, not a <dialog>, so it never trips its own guard. */
      if (document.querySelector('dialog[open]') !== null) return;
      event.preventDefault();
      if (event.repeat) return;
      setOpen((current) => !current);
    };
    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
  }, []);

  return (
    <>
      <button
        type="button"
        aria-label="Search"
        aria-keyshortcuts="Meta+K Control+K"
        onClick={() => setOpen(true)}
        className={
          compact
            ? 'transition-ui flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-sunken hover:text-primary [@media(pointer:coarse)]:h-10 [@media(pointer:coarse)]:w-10'
            : 'transition-ui flex h-8 w-56 shrink-0 items-center gap-2 rounded-lg border border-default bg-sunken px-2.5 text-[0.8125rem] text-muted hover:text-primary'
        }
      >
        <SearchIcon className="h-4 w-4 shrink-0" />
        {compact ? null : (
          <>
            <span className="flex-1 text-left">Search</span>
            {/* Decoration for the eye: the button is already named "Search" and
                `aria-keyshortcuts` carries the keys, so reading this out as
                well would say it twice. */}
            <kbd
              aria-hidden="true"
              className="rounded border border-default bg-surface px-1.5 font-mono text-[0.6875rem] leading-5 text-muted"
            >
              {isApplePlatform() ? '⌘K' : 'Ctrl K'}
            </kbd>
          </>
        )}
      </button>
      <CommandPalette open={open} onOpenChange={setOpen} />
    </>
  );
}
