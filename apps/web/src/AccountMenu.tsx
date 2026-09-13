import { useEffect, useId, useRef, useState } from 'react';
import ThemeToggle from './components/ThemeToggle';
import SignOutButton from './SignOutButton';
import { ChevronRightIcon } from './components/icons';

/**
 * Who is signed in, the theme, and the way out — behind one control.
 *
 * ═══ WHAT THIS REPLACES, AND WHY (review 09-13 N03) ═══
 *
 * The header carried a brand, a truncated email, three theme buttons and Sign
 * out, all competing at the same weight. The review's complaint is that the
 * two least-used controls in the product hold permanent chrome while the
 * question the chrome should answer — which identity am I using — was a 12px
 * span that disappeared below `sm`. Theme is set once and Sign out is pressed
 * at the end of a session; neither earns a persistent slot.
 *
 * So identity becomes the control, and the two settings live inside it. The
 * full identity is legible in the panel at every width, which is the half the
 * old header could not do at all.
 *
 * ═══ A DISCLOSURE, NOT A `role="menu"` ═══
 *
 * `role="menu"` is the obvious reach and it would be wrong twice over.
 *
 * First it is invalid: a menu's children must be `menuitem`,
 * `menuitemradio` or `menuitemcheckbox`, and this panel holds a
 * `role="radiogroup"` (the theme control) and an ordinary button. Wrapping
 * them in a menu would either break that contract or force the theme control
 * to be rebuilt as menu radios, losing the segmented control the redesign
 * chose deliberately.
 *
 * Second, and the reason it matters more: a role is a promise about keyboard
 * behaviour. `ThemeToggle`'s own docstring records this exact lesson costing
 * this project a release — it shipped `role="radio"` with no arrow handling,
 * so a screen reader announced "radio button, 1 of 3" and the arrow keys its
 * user then pressed did nothing. A menu promises arrows, typeahead, and
 * Home/End across its items. This does not implement those, so it does not
 * claim them.
 *
 * A disclosure promises exactly what it delivers: a button whose
 * `aria-expanded` says whether the thing it controls is open. Escape closes
 * and returns the caret, because the one keyboard affordance a popup genuinely
 * owes its user is a way out that does not strand focus.
 *
 * ═══ THE PANEL IS UNMOUNTED WHEN CLOSED ═══
 *
 * Not hidden with a class. `AppShell.test.tsx` and two e2e specs assert there
 * is exactly ONE Sign out control in the document, and jsdom applies no CSS —
 * so a CSS-hidden copy is fully present there and would read as the
 * duplication those assertions exist to catch. Unmounting also keeps the
 * closed menu out of the tab order without a `tabindex` sweep.
 */
export default function AccountMenu({ identity }: { readonly identity: string | null }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const trigger = useRef<HTMLButtonElement | null>(null);
  const panel = useRef<HTMLDivElement | null>(null);

  /* Escape closes and gives the caret back; a click outside closes and leaves
     it where the reader put it. Both listeners exist only while open — an
     always-registered document handler on a component mounted by the shell is
     a listener on every page, for a control that is shut most of the time. */
  useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      trigger.current?.focus();
    };
    /* `pointerdown`, not `click`: a click that begins inside the panel and
       ends outside it (a drag off a button, a text selection that runs past
       the edge) fires `click` on the document and would close the panel out
       from under the reader's own gesture. */
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (panel.current?.contains(target) === true) return;
      if (trigger.current?.contains(target) === true) return;
      setOpen(false);
    };

    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open]);

  /* The first character of whatever identifies this person. Decorative — it is
     derived from the name beside it and carries nothing of its own, so it is
     hidden rather than announced as a stray letter before the email. */
  const initial = (identity ?? '?').trim().charAt(0).toUpperCase() || '?';

  return (
    <div className="relative">
      <button
        ref={trigger}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
        data-testid="account-menu-trigger"
        className="transition-ui flex max-w-[16rem] items-center gap-2 rounded-full border border-default bg-sunken py-1 pr-2 pl-1 text-[13px] text-primary hover:border-strong"
      >
        <span
          aria-hidden="true"
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-mark text-[11px] font-semibold text-on-brand"
        >
          {initial}
        </span>
        {/* ═══ THE NAME IS ONE NODE, THE VISIBLE TEXT IS DECORATIVE ═══
         *
         * The obvious arrangement — an `sr-only` "Account:" beside an identity
         * that is `sr-only` only below `sm` — produces the name
         * "Account:qa@example.test", with no space. The accessible-name
         * algorithm TRIMS each element's contribution before joining them, so
         * whitespace written at a tag boundary cannot survive; it is not a JSX
         * problem and `{' '}` does not fix it either.
         *
         * So the whole name lives in one `sr-only` node, and the visible copy
         * is `aria-hidden` — present for the eye above `sm`, contributing
         * nothing to the name. WCAG 2.5.3 still holds: the visible label
         * (the identity) is contained in the accessible name.
         *
         * "Account" prefixes it so the control says what it OPENS rather than
         * merely whose it is, and the name is identical at every width. */}
        <span className="sr-only">Account: {identity ?? 'signed in'}</span>
        <span
          aria-hidden="true"
          className="hidden max-w-[14ch] truncate sm:inline"
        >
          {identity ?? 'signed in'}
        </span>
        <ChevronRightIcon
          aria-hidden="true"
          className={`h-3.5 w-3.5 shrink-0 text-muted transition-transform ${open ? '-rotate-90' : 'rotate-90'}`}
        />
      </button>

      {open && (
        <div
          ref={panel}
          id={panelId}
          className="absolute right-0 z-50 mt-2 w-64 rounded-lg border border-default bg-surface p-3 shadow-panel"
        >
          {/* ═══ IDENTITY IN FULL, WHICH THE HEADER COULD NOT DO ═══
           *
           * `break-all` and no truncation: this is the one place the whole
           * address is legible, and an email clipped at 22 characters in the
           * header was the original complaint.
           *
           * IDENTITY ONLY — no organisation. `Session` (api/session.ts)
           * carries a user and nothing else, and the review is explicit that
           * multi-tenant UI must not be invented. */}
          <p className="text-[11px] tracking-wide text-faint uppercase">Signed in as</p>
          <p data-testid="signed-in-as" className="mt-0.5 text-[13px] break-all text-primary">
            {identity ?? 'an account this page could not read'}
          </p>

          <div className="my-3 border-t border-default" />

          <div className="flex items-center justify-between gap-3">
            {/* A visible label beside the group, whose own `aria-label`
                ("Colour theme") already names it for assistive technology —
                so this is orientation for the eye, not a second name. */}
            <span className="text-[13px] text-muted">Theme</span>
            <ThemeToggle />
          </div>

          <div className="my-3 border-t border-default" />

          <SignOutButton />
        </div>
      )}
    </div>
  );
}
